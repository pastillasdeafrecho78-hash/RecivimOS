import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../../../config/env.js";
import { canonicalError } from "../../../shared/errors/canonicalErrors.js";
import { IntegrationAuthGuard } from "../../auth/integrationAuth.js";
import {
  createExternalOrderBodySchema
} from "../contracts/createExternalOrder.contract.js";
import type { OrdersRepository } from "../repositories/orders.repository.js";
import { OrderIngestionService } from "../services/orderIngestion.service.js";
import {
  sendWebAsset,
  sendWebIndex
} from "../../ui/webArtifact.server.js";

export const registerPublicOrdersRoutes = (app: FastifyInstance, repository: OrdersRepository): void => {
  const authGuard = new IntegrationAuthGuard(repository);
  const ingestionService = new OrderIngestionService(repository);
  const servimosBaseUrl = env.SERVIMOS_PUBLIC_BASE_URL?.replace(/\/$/, "");
  const randomIdempotency = (): string =>
    `session-${Date.now()}-${Math.floor(Math.random() * 9999)}`;

  const normalize = (value: string): string => value.trim().toLowerCase();

  const getServimosImageMap = async (slug: string): Promise<Map<string, string>> => {
    if (!servimosBaseUrl) return new Map();
    try {
      const response = await fetch(`${servimosBaseUrl}/api/public/menu/${encodeURIComponent(slug)}`);
      if (!response.ok) return new Map();
      const payload = (await response.json()) as {
        success?: boolean;
        data?: {
          categorias?: Array<{
            productos?: Array<{ nombre?: string; imagenUrl?: string | null }>;
          }>;
        };
      };
      if (!payload.success || !payload.data?.categorias) return new Map();
      const byName = new Map<string, string>();
      for (const categoria of payload.data.categorias) {
        for (const producto of categoria.productos ?? []) {
          if (producto.nombre && producto.imagenUrl) {
            byName.set(normalize(producto.nombre), producto.imagenUrl);
          }
        }
      }
      return byName;
    } catch (error) {
      app.log.warn({ error, slug }, "No fue posible cargar imagenes de ServimOS");
      return new Map();
    }
  };

  app.get("/", async (_request, reply) => sendWebIndex(reply));
  app.get("/login", async (_request, reply) => sendWebIndex(reply));
  app.get("/register", async (_request, reply) => sendWebIndex(reply));
  app.get("/integration-status", async (_request, reply) => sendWebIndex(reply));
  app.get("/orders/new", async (_request, reply) => sendWebIndex(reply));
  app.get("/assets/*", async (request, reply) => {
    const path = (request.params as { "*": string })["*"];
    return sendWebAsset(reply, `assets/${path}`);
  });

  app.get("/health", async (_request, reply) => {
    return reply.status(200).send({
      success: true,
      data: { status: "ok" }
    });
  });

  app.post("/api/public/integraciones/pedidos/session", async (request, reply) => {
    const body = z
      .object({
        slug: z.string().min(1),
      })
      .parse(request.body ?? {});
    const restaurante = await repository.findRestauranteBySlug(body.slug);
    if (!restaurante || !restaurante.isActive || restaurante.isSuspended) {
      throw canonicalError("branch_not_found", "Sucursal no encontrada o inactiva");
    }
    const apiKey = await repository.findAnyActiveApiKeyForRestaurante(restaurante.id);
    if (!apiKey) {
      throw canonicalError("invalid_api_key", "No hay credenciales activas para esta sucursal");
    }
    reply.header(
      "set-cookie",
      authGuard.createPublicSessionCookie({
        restauranteId: restaurante.id,
        restauranteSlug: restaurante.slug,
        apiKeyId: apiKey.id
      })
    );
    return reply.status(200).send({
      success: true,
      data: {
        slug: restaurante.slug,
        nombre: restaurante.nombre,
        sessionMode: "public_session"
      }
    });
  });

  app.get("/api/public/integraciones/pedidos/restaurantes", async (_request, reply) => {
    let restaurantes: Awaited<ReturnType<typeof repository.listActiveRestaurantes>> = [];
    try {
      restaurantes = await repository.listActiveRestaurantes();
    } catch (error) {
      app.log.error({ error }, "No fue posible listar restaurantes para discovery publico");
    }
    return reply.status(200).send({
      success: true,
      data: restaurantes
    });
  });

  app.get("/api/public/integraciones/pedidos/menu/:slug", async (request, reply) => {
    const { slug } = z.object({ slug: z.string().min(1) }).parse(request.params);
    try {
      const catalog = await repository.getPublicCatalogByRestauranteSlug(slug);
      if (!catalog) {
        throw canonicalError("branch_not_found", "Sucursal no encontrada o inactiva");
      }
      const imageMap = await getServimosImageMap(slug);
      return reply.status(200).send({
        success: true,
        data: {
          ...catalog,
          productos: catalog.productos.map((product) => ({
            ...product,
            imageUrl: imageMap.get(normalize(product.nombre)) ?? product.imageUrl ?? null
          }))
        }
      });
    } catch (error) {
      app.log.error({ error, slug }, "No fue posible cargar catalogo publico");
      return reply.status(200).send({
        success: true,
        data: {
          restaurante: { id: "unknown", slug, nombre: slug },
          productos: [],
          tamanos: [],
          modificadores: []
        },
        degraded: true
      });
    }
  });

  app.get("/api/public/integraciones/pedidos/contract", async (_request, reply) => {
    return reply.status(200).send({
      success: true,
      data: {
        createOrder: {
          endpoint: "/api/public/integraciones/pedidos/orders",
          method: "POST",
          headers: {
            "x-restaurante-slug": "string (optional con sesión pública)",
            "x-idempotency-key": "string",
            "x-api-version": "v1 (optional)",
            "x-correlation-id": "string (optional)"
          }
        },
        getOrderStatus: {
          endpoint: "/api/public/integraciones/pedidos/orders/:orderId",
          method: "GET",
          headers: {
            "x-restaurante-slug": "string (optional con sesión pública)"
          }
        }
      }
    });
  });

  app.post("/api/public/integraciones/pedidos/orders", { preHandler: authGuard.preHandler }, async (request, reply) => {
    const body = createExternalOrderBodySchema.parse(request.body);

    const context = request.integrationContext;
    if (!context) {
      throw new Error("Missing integration context");
    }
    const rawHeaders = request.headers as Record<string, unknown>;
    const headerSlug =
      typeof rawHeaders["x-restaurante-slug"] === "string"
        ? rawHeaders["x-restaurante-slug"].trim()
        : "";
    const idempotencyKey =
      typeof rawHeaders["x-idempotency-key"] === "string" && rawHeaders["x-idempotency-key"].trim()
        ? rawHeaders["x-idempotency-key"].trim()
        : randomIdempotency();

    const result = await ingestionService.createExternalOrder({
      restauranteSlug: headerSlug || context.restauranteSlug,
      restauranteId: context.restauranteId,
      apiKeyId: context.apiKeyId,
      idempotencyKey,
      payload: body,
      ttlHours: env.IDEMPOTENCY_TTL_HOURS
    });

    return reply.status(result.httpStatus).send(result.body);
  });

  app.get(
    "/api/public/integraciones/pedidos/orders/:orderId",
    { preHandler: authGuard.preHandler },
    async (request, reply) => {
      const context = request.integrationContext;
      if (!context) {
        throw new Error("Missing integration context");
      }
      const params = z.object({ orderId: z.string().min(1) }).parse(request.params);
      const result = await ingestionService.getExternalOrderStatus(context.restauranteId, params.orderId);
      return reply.status(200).send(result);
    }
  );
};
