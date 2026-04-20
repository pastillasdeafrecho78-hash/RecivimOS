import { canonicalError } from "../../../shared/errors/canonicalErrors.js";
import type { CreateExternalOrderBody, CreateExternalOrderSuccess } from "../contracts/createExternalOrder.contract.js";
import type { OrdersRepository } from "../repositories/orders.repository.js";
import { IdempotencyService } from "./idempotency.service.js";
import { OrderScopeValidator } from "./orderScopeValidator.js";

type IngestionInput = {
  restauranteSlug: string;
  restauranteId: string;
  apiKeyId: string | undefined;
  authMode: "api_key" | "public_session";
  createdByUserId: string | undefined;
  idempotencyKey: string;
  payload: CreateExternalOrderBody;
  ttlHours: number;
};

export class OrderIngestionService {
  private readonly scopeValidator: OrderScopeValidator;
  private readonly idempotencyService: IdempotencyService;

  constructor(private readonly repository: OrdersRepository) {
    this.scopeValidator = new OrderScopeValidator(repository);
    this.idempotencyService = new IdempotencyService(repository);
  }

  async createExternalOrder(input: IngestionInput): Promise<{ httpStatus: number; body: CreateExternalOrderSuccess }> {
    const restaurante = await this.repository.findRestauranteBySlug(input.restauranteSlug);
    if (!restaurante || restaurante.id !== input.restauranteId) {
      throw canonicalError("branch_scope_mismatch", "Contexto de tenant invalido");
    }

    const canUsePersistentIdempotency = input.authMode === "api_key" && !!input.apiKeyId;
    const idempotencyState = canUsePersistentIdempotency
      ? await this.idempotencyService.start({
          restauranteId: input.restauranteId,
          apiKeyId: input.apiKeyId as string,
          idempotencyKey: input.idempotencyKey,
          payload: input.payload,
          ttlHours: input.ttlHours
        })
      : null;
    if (idempotencyState?.mode === "replay") {
      const replay = idempotencyState.response;
      replay.data.idempotent = true;
      return { httpStatus: 200, body: replay };
    }

    await this.scopeValidator.validate(restaurante, input.payload);

    const duplicated = await this.repository.findOrderByExternalId(restaurante.id, input.payload.externalOrderId);
    if (duplicated) {
      throw canonicalError("duplicate_external_order", "externalOrderId ya existe para la sucursal");
    }

    let created;
    try {
      created = await this.repository.createOrder({
        restaurante,
        payload: input.payload,
        createdByUserId: input.createdByUserId
      });
    } catch {
      throw canonicalError("duplicate_external_order", "externalOrderId ya existe para la sucursal");
    }

    const response: CreateExternalOrderSuccess = {
      success: true,
      data: {
        orderId: created.id,
        numeroComanda: created.numeroComanda,
        restauranteId: created.restauranteId,
        restauranteSlug: created.restauranteSlug,
        estado: created.estado,
        origen: "EXTERNAL_API",
        idempotent: false,
        createdAt: created.createdAt.toISOString()
      }
    };
    if (!idempotencyState || idempotencyState.mode !== "continue") {
      return { httpStatus: 201, body: response };
    }
    await this.idempotencyService.complete(idempotencyState.recordId, response);
    return { httpStatus: 201, body: response };
  }

  async getExternalOrderStatus(restauranteId: string, orderId: string): Promise<{
    success: true;
    data: {
      orderId: string;
      restauranteId: string;
        estado:
          | "SOLICITUD"
          | "EN_COLA"
          | "RECHAZADO"
          | "PENDIENTE"
          | "EN_PREPARACION"
          | "LISTO"
          | "SERVIDO"
          | "PAGADO"
          | "CANCELADO";
    };
  }> {
    const order = await this.repository.findOrderById(orderId);
    if (!order || order.restauranteId !== restauranteId) {
      throw canonicalError("branch_scope_mismatch", "La orden no pertenece a la sucursal autenticada");
    }
    return {
      success: true,
      data: {
        orderId: order.id,
        restauranteId: order.restauranteId,
        estado: order.estado
      }
    };
  }
}
