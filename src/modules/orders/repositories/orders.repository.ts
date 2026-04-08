import type { CreateExternalOrderBody } from "../contracts/createExternalOrder.contract.js";

export type IntegrationScope = "orders:create" | "orders:read";
export type IdempotencyStatus = "processing" | "completed";
export type OrderStatus =
  | "PENDIENTE"
  | "EN_PREPARACION"
  | "LISTO"
  | "SERVIDO"
  | "PAGADO"
  | "CANCELADO";

export type RestauranteRecord = {
  id: string;
  slug: string;
  nombre: string;
  isActive: boolean;
  isSuspended: boolean;
};

export type ApiKeyRecord = {
  id: string;
  restauranteId: string;
  keyHash: string;
  isActive: boolean;
  scopes: IntegrationScope[];
};

export type ProductScopeRecord = {
  id: string;
  restauranteId: string;
  isActive: boolean;
};

export type PublicRestauranteRecord = {
  id: string;
  slug: string;
  nombre: string;
};

export type PublicCatalogRecord = {
  restaurante: PublicRestauranteRecord;
  productos: Array<{ id: string; nombre: string; imageUrl?: string | null }>;
  tamanos: Array<{ id: string; nombre: string }>;
  modificadores: Array<{ id: string; nombre: string }>;
};

export type IdempotencyRecord = {
  id: string;
  idempotencyKey: string;
  restauranteId: string;
  apiKeyId: string;
  payloadHash: string;
  status: IdempotencyStatus;
  responseSnapshot: unknown | null;
  expiresAt: Date;
  createdAt: Date;
};

export type CreatedOrderRecord = {
  id: string;
  restauranteId: string;
  restauranteSlug: string;
  numeroComanda: number;
  estado: OrderStatus;
  createdAt: Date;
};

export type CreateOrderParams = {
  restaurante: RestauranteRecord;
  payload: CreateExternalOrderBody;
};

export interface OrdersRepository {
  listActiveRestaurantes(): Promise<PublicRestauranteRecord[]>;
  getPublicCatalogByRestauranteSlug(slug: string): Promise<PublicCatalogRecord | null>;
  findRestauranteBySlug(slug: string): Promise<RestauranteRecord | null>;
  findApiKeyByHash(hash: string): Promise<ApiKeyRecord | null>;
  findAnyActiveApiKeyForRestaurante(restauranteId: string): Promise<ApiKeyRecord | null>;
  findProductsByIds(productIds: string[]): Promise<ProductScopeRecord[]>;
  findTamanosByIds(tamanoIds: string[]): Promise<ProductScopeRecord[]>;
  findModificadoresByIds(modificadorIds: string[]): Promise<ProductScopeRecord[]>;
  findOrderByExternalId(restauranteId: string, externalOrderId: string): Promise<CreatedOrderRecord | null>;
  getNextNumeroComanda(restauranteId: string): Promise<number>;
  createOrder(params: CreateOrderParams): Promise<CreatedOrderRecord>;
  findIdempotencyKey(restauranteId: string, key: string): Promise<IdempotencyRecord | null>;
  createIdempotencyKey(input: {
    idempotencyKey: string;
    restauranteId: string;
    apiKeyId: string;
    payloadHash: string;
    status: IdempotencyStatus;
    expiresAt: Date;
  }): Promise<IdempotencyRecord>;
  updateIdempotencyKey(input: {
    id: string;
    status: IdempotencyStatus;
    responseSnapshot: unknown;
  }): Promise<void>;
  findOrderById(orderId: string): Promise<CreatedOrderRecord | null>;
}
