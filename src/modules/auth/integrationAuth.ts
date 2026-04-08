import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../../config/env.js";
import { canonicalError } from "../../shared/errors/canonicalErrors.js";
import { sha256 } from "../../shared/utils/hash.js";
import type { OrdersRepository } from "../orders/repositories/orders.repository.js";

type PublicSessionPayload = {
  restauranteId: string;
  restauranteSlug: string;
  apiKeyId: string;
  exp: number;
};

export class IntegrationAuthGuard {
  constructor(private readonly repository: OrdersRepository) {}

  private readonly cookieName = "pedimos_public_session";

  private sign(data: string): string {
    return createHmac("sha256", env.PUBLIC_SESSION_SECRET).update(data).digest("base64url");
  }

  private encode(payload: PublicSessionPayload): string {
    const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = this.sign(body);
    return `${body}.${signature}`;
  }

  private decode(token: string): PublicSessionPayload | null {
    const [body, signature] = token.split(".");
    if (!body || !signature) return null;
    const expected = this.sign(body);
    const expectedBuffer = Buffer.from(expected, "utf8");
    const signatureBuffer = Buffer.from(signature, "utf8");
    if (
      expectedBuffer.length !== signatureBuffer.length ||
      !timingSafeEqual(expectedBuffer, signatureBuffer)
    ) {
      return null;
    }
    try {
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as PublicSessionPayload;
      if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
      return payload;
    } catch {
      return null;
    }
  }

  private parseCookie(cookieHeader: string | undefined, name: string): string | null {
    if (!cookieHeader) return null;
    for (const chunk of cookieHeader.split(";")) {
      const [rawKey, ...rest] = chunk.trim().split("=");
      if (rawKey === name) return decodeURIComponent(rest.join("="));
    }
    return null;
  }

  createPublicSessionCookie(input: {
    restauranteId: string;
    restauranteSlug: string;
    apiKeyId: string;
  }): string {
    const expiresInSeconds = env.PUBLIC_SESSION_TTL_MINUTES * 60;
    const token = this.encode({
      restauranteId: input.restauranteId,
      restauranteSlug: input.restauranteSlug,
      apiKeyId: input.apiKeyId,
      exp: Math.floor(Date.now() / 1000) + expiresInSeconds
    });
    return `${this.cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${expiresInSeconds}`;
  }

  clearPublicSessionCookie(): string {
    return `${this.cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  private readSessionFromRequest(request: FastifyRequest): PublicSessionPayload | null {
    const cookieHeader = request.headers.cookie;
    const token = this.parseCookie(cookieHeader, this.cookieName);
    if (!token) return null;
    return this.decode(token);
  }

  validateHeaders(headers: Record<string, unknown>): {
    apiKey: string;
    restauranteSlug: string;
    idempotencyKey: string;
  } {
    const apiKey = headers["x-api-key"];
    const restauranteSlug = headers["x-restaurante-slug"];
    const idempotencyKey = headers["x-idempotency-key"];

    if (typeof apiKey !== "string" || !apiKey.trim()) {
      throw canonicalError("invalid_api_key", "x-api-key ausente o invalida");
    }
    if (typeof restauranteSlug !== "string" || !restauranteSlug.trim()) {
      throw canonicalError("invalid_payload", "x-restaurante-slug es obligatorio");
    }
    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
      throw canonicalError("invalid_payload", "x-idempotency-key es obligatorio");
    }

    return { apiKey, restauranteSlug, idempotencyKey };
  }

  preHandler = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const session = this.readSessionFromRequest(request);
    if (session) {
      const restaurante = await this.repository.findRestauranteBySlug(session.restauranteSlug);
      if (!restaurante || !restaurante.isActive || restaurante.isSuspended || restaurante.id !== session.restauranteId) {
        throw canonicalError("branch_scope_mismatch", "Sesion publica invalida para la sucursal");
      }
      request.integrationContext = {
        restauranteId: session.restauranteId,
        restauranteSlug: session.restauranteSlug,
        apiKeyId: session.apiKeyId,
        authMode: "public_session"
      };
      return;
    }

    const { apiKey, restauranteSlug } = this.validateHeaders(request.headers as Record<string, unknown>);

    const restaurante = await this.repository.findRestauranteBySlug(restauranteSlug);
    if (!restaurante) {
      throw canonicalError("branch_not_found", "Sucursal no encontrada");
    }
    if (!restaurante.isActive) {
      throw canonicalError("branch_inactive", "Sucursal inactiva");
    }
    if (restaurante.isSuspended) {
      throw canonicalError("branch_suspended", "Sucursal suspendida");
    }

    const apiKeyRecord = await this.repository.findApiKeyByHash(sha256(apiKey));
    if (!apiKeyRecord || !apiKeyRecord.isActive) {
      throw canonicalError("invalid_api_key", "x-api-key ausente o invalida");
    }
    if (apiKeyRecord.restauranteId !== restaurante.id) {
      throw canonicalError("branch_scope_mismatch", "API key no pertenece a la sucursal objetivo");
    }
    if (!apiKeyRecord.scopes.includes("orders:create") && !apiKeyRecord.scopes.includes("orders:read")) {
      throw canonicalError("invalid_api_key", "API key sin scopes requeridos");
    }

    request.integrationContext = {
      restauranteId: restaurante.id,
      restauranteSlug: restaurante.slug,
      apiKeyId: apiKeyRecord.id,
      authMode: "api_key"
    };
  };
}
