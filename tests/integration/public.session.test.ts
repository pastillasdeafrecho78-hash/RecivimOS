import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { basePayload, createSeedRepository } from "../helpers/testData.js";

describe("Public session guest flow", () => {
  const apps: ReturnType<typeof buildApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.map((app) => app.close()));
    apps.length = 0;
  });

  it("creates order without x-api-key when session cookie exists", async () => {
    const app = buildApp(createSeedRepository());
    apps.push(app);

    const session = await app.inject({
      method: "POST",
      url: "/api/public/integraciones/pedidos/session",
      payload: { slug: "sucursal-centro" }
    });
    expect(session.statusCode).toBe(200);
    const setCookie = session.headers["set-cookie"];
    expect(typeof setCookie).toBe("string");
    const cookie = String(setCookie).split(";")[0];

    const order = await app.inject({
      method: "POST",
      url: "/api/public/integraciones/pedidos/orders",
      headers: {
        cookie,
        "x-restaurante-slug": "sucursal-centro",
        "x-idempotency-key": "session-idem-1",
        "content-type": "application/json"
      },
      payload: { ...basePayload, externalOrderId: "session-ext-1" }
    });
    expect(order.statusCode).toBe(201);
    expect(order.json().success).toBe(true);
  });
});
