import { PrismaClient, Prisma } from "@prisma/client";
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

const mapRestaurante = (row: {
  id: string;
  slug: string;
  nombre: string;
  isActive: boolean;
  isSuspended: boolean;
}): RestauranteRecord => row;

const mapApiKey = (row: {
  id: string;
  restauranteId: string;
  keyHash: string;
  isActive: boolean;
  scopes: ("orders_create" | "orders_read")[];
}): ApiKeyRecord => ({
  ...row,
  scopes: row.scopes.map((scope) => (scope === "orders_create" ? "orders:create" : "orders:read"))
});

const mapScopeEntity = (row: { id: string; restauranteId: string; isActive: boolean }): ProductScopeRecord => row;

const mapOrder = (row: {
  id: string;
  restauranteId: string;
  numeroComanda: number;
  estado: CreatedOrderRecord["estado"];
  createdAt: Date;
  restaurante: { slug: string };
}): CreatedOrderRecord => ({
  id: row.id,
  restauranteId: row.restauranteId,
  restauranteSlug: row.restaurante.slug,
  numeroComanda: row.numeroComanda,
  estado: row.estado,
  createdAt: row.createdAt
});

const mapIdempotency = (row: {
  id: string;
  idempotencyKey: string;
  restauranteId: string;
  apiKeyId: string;
  payloadHash: string;
  status: string;
  responseSnapshot: unknown;
  expiresAt: Date;
  createdAt: Date;
}): IdempotencyRecord => ({
  ...row,
  status: row.status === "completed" ? "completed" : "processing",
  responseSnapshot: row.responseSnapshot ?? null
});

export class PrismaOrdersRepository implements OrdersRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listActiveRestaurantes(): Promise<PublicRestauranteRecord[]> {
    const rows = await this.prisma.restaurante.findMany({
      where: { isActive: true, isSuspended: false },
      orderBy: { nombre: "asc" },
      select: { id: true, slug: true, nombre: true }
    });
    return rows;
  }

  async getPublicCatalogByRestauranteSlug(slug: string): Promise<PublicCatalogRecord | null> {
    const restaurante = await this.prisma.restaurante.findUnique({
      where: { slug },
      select: { id: true, slug: true, nombre: true, isActive: true, isSuspended: true }
    });
    if (!restaurante || !restaurante.isActive || restaurante.isSuspended) {
      return null;
    }

    const [productos, tamanos, modificadores] = await Promise.all([
      this.prisma.producto.findMany({
        where: { restauranteId: restaurante.id, isActive: true },
        orderBy: { nombre: "asc" },
        select: { id: true, nombre: true }
      }),
      this.prisma.tamano.findMany({
        where: { restauranteId: restaurante.id, isActive: true },
        orderBy: { nombre: "asc" },
        select: { id: true, nombre: true }
      }),
      this.prisma.modificador.findMany({
        where: { restauranteId: restaurante.id, isActive: true },
        orderBy: { nombre: "asc" },
        select: { id: true, nombre: true }
      })
    ]);

    return {
      restaurante: { id: restaurante.id, slug: restaurante.slug, nombre: restaurante.nombre },
      productos,
      tamanos,
      modificadores
    };
  }

  async findRestauranteBySlug(slug: string): Promise<RestauranteRecord | null> {
    const row = await this.prisma.restaurante.findUnique({
      where: { slug },
      select: { id: true, slug: true, nombre: true, isActive: true, isSuspended: true }
    });
    return row ? mapRestaurante(row) : null;
  }

  async findApiKeyByHash(hash: string): Promise<ApiKeyRecord | null> {
    const row = await this.prisma.integracionApiKey.findUnique({
      where: { keyHash: hash },
      select: { id: true, restauranteId: true, keyHash: true, isActive: true, scopes: true }
    });
    return row ? mapApiKey(row) : null;
  }

  async findAnyActiveApiKeyForRestaurante(restauranteId: string): Promise<ApiKeyRecord | null> {
    const row = await this.prisma.integracionApiKey.findFirst({
      where: {
        restauranteId,
        isActive: true,
        scopes: { has: "orders_create" }
      },
      select: { id: true, restauranteId: true, keyHash: true, isActive: true, scopes: true },
      orderBy: { createdAt: "asc" }
    });
    return row ? mapApiKey(row) : null;
  }

  async findProductsByIds(productIds: string[]): Promise<ProductScopeRecord[]> {
    if (!productIds.length) return [];
    const rows = await this.prisma.producto.findMany({
      where: { id: { in: productIds } },
      select: { id: true, restauranteId: true, isActive: true }
    });
    return rows.map(mapScopeEntity);
  }

  async findTamanosByIds(tamanoIds: string[]): Promise<ProductScopeRecord[]> {
    if (!tamanoIds.length) return [];
    const rows = await this.prisma.tamano.findMany({
      where: { id: { in: tamanoIds } },
      select: { id: true, restauranteId: true, isActive: true }
    });
    return rows.map(mapScopeEntity);
  }

  async findModificadoresByIds(modificadorIds: string[]): Promise<ProductScopeRecord[]> {
    if (!modificadorIds.length) return [];
    const rows = await this.prisma.modificador.findMany({
      where: { id: { in: modificadorIds } },
      select: { id: true, restauranteId: true, isActive: true }
    });
    return rows.map(mapScopeEntity);
  }

  async findOrderByExternalId(restauranteId: string, externalOrderId: string): Promise<CreatedOrderRecord | null> {
    const row = await this.prisma.order.findUnique({
      where: { restauranteId_externalOrderId: { restauranteId, externalOrderId } },
      include: { restaurante: { select: { slug: true } } }
    });
    return row ? mapOrder(row) : null;
  }

  async getNextNumeroComanda(restauranteId: string): Promise<number> {
    const current = await this.prisma.order.aggregate({
      _max: { numeroComanda: true },
      where: { restauranteId }
    });
    return (current._max.numeroComanda ?? 0) + 1;
  }

  async createOrder(params: CreateOrderParams): Promise<CreatedOrderRecord> {
    const nextNumero = await this.getNextNumeroComanda(params.restaurante.id);
    const row = await this.prisma.order.create({
      data: {
        restauranteId: params.restaurante.id,
        externalOrderId: params.payload.externalOrderId,
        tipoPedido: params.payload.tipoPedido,
        canal: params.payload.canal,
        origen: "EXTERNAL_API",
        numeroComanda: nextNumero,
        notas: params.payload.notas ?? null,
        deliveryMode: params.payload.deliveryMetadata?.mode ?? null,
        driverRef: params.payload.deliveryMetadata?.driverRef ?? null,
        vehicleNote: params.payload.deliveryMetadata?.vehicleNote ?? null,
        items: {
          createMany: {
            data: params.payload.items.map((item) => ({
              productoId: item.productoId,
              tamanoId: item.tamanoId ?? null,
              cantidad: item.cantidad,
              notas: item.notas ?? null
            }))
          }
        }
      },
      select: {
        id: true,
        restauranteId: true,
        numeroComanda: true,
        estado: true,
        createdAt: true
      }
    });
    return {
      id: row.id,
      restauranteId: row.restauranteId,
      restauranteSlug: params.restaurante.slug,
      numeroComanda: row.numeroComanda,
      estado: row.estado,
      createdAt: row.createdAt
    };
  }

  async findIdempotencyKey(restauranteId: string, key: string): Promise<IdempotencyRecord | null> {
    const row = await this.prisma.externalIdempotencyKey.findUnique({
      where: { idempotencyKey_restauranteId: { idempotencyKey: key, restauranteId } }
    });
    return row ? mapIdempotency(row) : null;
  }

  async createIdempotencyKey(input: {
    idempotencyKey: string;
    restauranteId: string;
    apiKeyId: string;
    payloadHash: string;
    status: "processing" | "completed";
    expiresAt: Date;
  }): Promise<IdempotencyRecord> {
    const row = await this.prisma.externalIdempotencyKey.create({
      data: {
        idempotencyKey: input.idempotencyKey,
        restauranteId: input.restauranteId,
        apiKeyId: input.apiKeyId,
        payloadHash: input.payloadHash,
        status: input.status,
        expiresAt: input.expiresAt
      }
    });
    return mapIdempotency(row);
  }

  async updateIdempotencyKey(input: { id: string; status: "processing" | "completed"; responseSnapshot: unknown }): Promise<void> {
    await this.prisma.externalIdempotencyKey.update({
      where: { id: input.id },
      data: {
        status: input.status,
        responseSnapshot: input.responseSnapshot as Prisma.InputJsonValue
      }
    });
  }

  async findOrderById(orderId: string): Promise<CreatedOrderRecord | null> {
    const row = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { restaurante: { select: { slug: true } } }
    });
    return row ? mapOrder(row) : null;
  }
}
