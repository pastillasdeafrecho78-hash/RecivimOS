import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { createSeedRepository } from "../helpers/testData.js";

describe("PedimOS UI pages", () => {
  const apps: ReturnType<typeof buildApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.map((app) => app.close()));
    apps.length = 0;
  });

  it("serves root/login/register/integration-status/orders-new pages", async () => {
    const app = buildApp(createSeedRepository());
    apps.push(app);

    const urls = ["/", "/login", "/register", "/integration-status", "/orders/new"];
    for (const url of urls) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.body).toContain("<!doctype html>");
    }
  });
});
