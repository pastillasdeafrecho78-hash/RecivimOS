import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    integrationContext?: {
      restauranteId: string;
      restauranteSlug: string;
      apiKeyId: string;
      authMode: "api_key" | "public_session";
    };
  }
}
