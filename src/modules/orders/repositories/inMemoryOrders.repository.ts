import { randomUUID } from "node:crypto";
import type { CreateExternalOrderBody } from "../contracts/createExternalOrder.contract.js";
import type {
  ApiKeyRecord,
  CreateOrderParams,
  CreatedOrderRecord,
  IdempotencyRecord,
  OrdersRepository,
  PublicCatalogRecord,
  PublicRestauranteRecord,
  ProductScopeRecord,
  RestauranteRecord
} from "./orders.repository.js";

type SeedState = {
  restaurantes: RestauranteRecord[];
  apiKeys: ApiKeyRecord[];
  productos: ProductScopeRecord[];
  tamanos: ProductScopeRecord[];
  modificadores: ProductScopeRecord[];
};

type StoredOrder = CreatedOrderRecord & {
  externalOrderId: string;
  payload: CreateExternalOrderBody;
};

export class InMemoryOrdersRepository implements OrdersRepository {
  private readonly restaurantes: RestauranteRecord[];
  private readonly apiKeys: ApiKeyRecord[];
  private readonly productos: ProductScopeRecord[];
  private readonly tamanos: ProductScopeRecord[];
  private readonly modificadores: ProductScopeRecord[];
  private readonly orders: StoredOrder[] = [];
  private readonly idempotencyKeys: IdempotencyRecord[] = [];

  constructor(seed?: Partial<SeedState>) {
    this.restaurantes = seed?.restaurantes ?? [];
    this.apiKeys = seed?.apiKeys ?? [];
    this.productos = seed?.productos ?? [];
    this.tamanos = seed?.tamanos ?? [];
    this.modificadores = seed?.modificadores ?? [];
  }

  async listActiveRestaurantes(): Promise<PublicRestauranteRecord[]> {
    return this.restaurantes
      .filter((restaurante) => restaurante.isActive && !restaurante.isSuspended)
      .map((restaurante) => ({
        id: restaurante.id,
        slug: restaurante.slug,
        nombre: restaurante.nombre
      }));
  }

  async getPublicCatalogByRestauranteSlug(slug: string): Promise<PublicCatalogRecord | null> {
    const restaurante = await this.findRestauranteBySlug(slug);
    if (!restaurante || !restaurante.isActive || restaurante.isSuspended) {
      return null;
    }
    return {
      restaurante: {
        id: restaurante.id,
        slug: restaurante.slug,
        nombre: restaurante.nombre
      },
      productos: this.productos
        .filter((item) => item.restauranteId === restaurante.id && item.isActive)
        .map((item) => ({ id: item.id, nombre: item.id })),
      tamanos: this.tamanos
        .filter((item) => item.restauranteId === restaurante.id && item.isActive)
        .map((item) => ({ id: item.id, nombre: item.id })),
      modificadores: this.modificadores
        .filter((item) => item.restauranteId === restaurante.id && item.isActive)
        .map((item) => ({ id: item.id, nombre: item.id }))
    };
  }

  async findRestauranteBySlug(slug: string): Promise<RestauranteRecord | null> {
    return this.restaurantes.find((r) => r.slug === slug) ?? null;
  }

  async findApiKeyByHash(hash: string): Promise<ApiKeyRecord | null> {
    return this.apiKeys.find((k) => k.keyHash === hash) ?? null;
  }

  async findAnyActiveApiKeyForRestaurante(restauranteId: string): Promise<ApiKeyRecord | null> {
    return (
      this.apiKeys.find(
        (k) => k.restauranteId === restauranteId && k.isActive && k.scopes.includes("orders:create")
      ) ?? null
    );
  }

  async findProductsByIds(productIds: string[]): Promise<ProductScopeRecord[]> {
    return this.productos.filter((p) => productIds.includes(p.id));
  }

  async findTamanosByIds(tamanoIds: string[]): Promise<ProductScopeRecord[]> {
    return this.tamanos.filter((t) => tamanoIds.includes(t.id));
  }

  async findModificadoresByIds(modificadorIds: string[]): Promise<ProductScopeRecord[]> {
    return this.modificadores.filter((m) => modificadorIds.includes(m.id));
  }

  async findOrderByExternalId(restauranteId: string, externalOrderId: string): Promise<CreatedOrderRecord | null> {
    const found = this.orders.find(
      (order) => order.restauranteId === restauranteId && order.externalOrderId === externalOrderId
    );
    return found ?? null;
  }

  async getNextNumeroComanda(restauranteId: string): Promise<number> {
    const max = this.orders
      .filter((order) => order.restauranteId === restauranteId)
      .reduce((acc, current) => Math.max(acc, current.numeroComanda), 0);
    return max + 1;
  }

  async createOrder(params: CreateOrderParams): Promise<CreatedOrderRecord> {
    const duplicate = await this.findOrderByExternalId(params.restaurante.id, params.payload.externalOrderId);
    if (duplicate) {
      throw new Error("duplicate_external_order");
    }

    const order: StoredOrder = {
      id: randomUUID(),
      restauranteId: params.restaurante.id,
      restauranteSlug: params.restaurante.slug,
      numeroComanda: await this.getNextNumeroComanda(params.restaurante.id),
      estado: "PENDIENTE",
      createdAt: new Date(),
      externalOrderId: params.payload.externalOrderId,
      payload: params.payload
    };
    this.orders.push(order);
    return order;
  }

  async findIdempotencyKey(restauranteId: string, key: string): Promise<IdempotencyRecord | null> {
    return (
      this.idempotencyKeys.find((record) => record.restauranteId === restauranteId && record.idempotencyKey === key) ??
      null
    );
  }

  async createIdempotencyKey(input: {
    idempotencyKey: string;
    restauranteId: string;
    apiKeyId: string;
    payloadHash: string;
    status: "processing" | "completed";
    expiresAt: Date;
  }): Promise<IdempotencyRecord> {
    const existing = await this.findIdempotencyKey(input.restauranteId, input.idempotencyKey);
    if (existing) {
      throw new Error("duplicate_idempotency_key");
    }

    const record: IdempotencyRecord = {
      id: randomUUID(),
      idempotencyKey: input.idempotencyKey,
      restauranteId: input.restauranteId,
      apiKeyId: input.apiKeyId,
      payloadHash: input.payloadHash,
      status: input.status,
      responseSnapshot: null,
      createdAt: new Date(),
      expiresAt: input.expiresAt
    };
    this.idempotencyKeys.push(record);
    return record;
  }

  async updateIdempotencyKey(input: { id: string; status: "processing" | "completed"; responseSnapshot: unknown }): Promise<void> {
    const found = this.idempotencyKeys.find((record) => record.id === input.id);
    if (!found) return;
    found.status = input.status;
    found.responseSnapshot = input.responseSnapshot;
  }

  async findOrderById(orderId: string): Promise<CreatedOrderRecord | null> {
    return this.orders.find((order) => order.id === orderId) ?? null;
  }
}
