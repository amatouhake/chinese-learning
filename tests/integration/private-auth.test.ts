import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";

import { createWorkerApp } from "../../src/worker";

const ACCESS_ISSUER = "https://private-study.cloudflareaccess.com";
const ACCESS_AUDIENCE = "private-study-audience";
const OWNER_SUBJECT = "owner-subject";

const app = createWorkerApp({
  verifyAccessJwt: async (token) => {
    if (token === "valid-owner") return OWNER_SUBJECT;
    if (token === "valid-foreign") return "another-subject";
    return null;
  },
});

const productionBindings = {
  ...env,
  ENVIRONMENT: "production",
  LOCAL_STUDY_BYPASS: "false",
  ACCESS_ISSUER,
  ACCESS_AUDIENCE,
  ACCESS_OWNER_SUB: OWNER_SUBJECT,
};

describe("private production auth boundary", () => {
  test("protects health and rejects missing, malformed, bearer, and unsigned identity auth", async () => {
    const missing = await request("/api/health");
    expect(missing.status).toBe(401);

    const malformed = await request("/api/health", { "Cf-Access-Jwt-Assertion": "malformed" });
    expect(malformed.status).toBe(401);

    const bearer = await request("/api/health", { authorization: "Bearer valid-owner" });
    expect(bearer.status).toBe(401);

    const unsignedIdentity = await request("/api/health", {
      "Cf-Access-Authenticated-User-Email": "owner@example.com",
    });
    expect(unsignedIdentity.status).toBe(401);
  });

  test("accepts a verified owner JWT and keeps the learner server-selected", async () => {
    const health = await request("/api/health", { "Cf-Access-Jwt-Assertion": "valid-owner" });
    expect(health.status).toBe(200);

    const write = await request(
      "/api/attempts",
      { "Cf-Access-Jwt-Assertion": "valid-owner" },
      "not-json",
    );
    expect(write.status).toBe(400);
  });

  test("distinguishes a valid foreign identity and rejects a foreign Origin", async () => {
    const foreignIdentity = await request("/api/health", {
      "Cf-Access-Jwt-Assertion": "valid-foreign",
    });
    expect(foreignIdentity.status).toBe(403);

    const foreignOrigin = await request("/api/health", {
      "Cf-Access-Jwt-Assertion": "valid-owner",
      origin: "https://attacker.example",
    });
    expect(foreignOrigin.status).toBe(401);
  });

  test("protects MCP and preserves its authenticated 501 reservation", async () => {
    const unauthenticated = await request("/mcp");
    expect(unauthenticated.status).toBe(401);

    const authenticated = await request("/mcp", { "Cf-Access-Jwt-Assertion": "valid-owner" });
    expect(authenticated.status).toBe(501);

    const authenticatedSubpath = await request("/mcp/future", {
      "Cf-Access-Jwt-Assertion": "valid-owner",
    });
    expect(authenticatedSubpath.status).toBe(501);
  });

  test("never permits local bypass in production", async () => {
    const response = await app.fetch(
      new Request("https://private.example/api/health", {
        headers: { origin: "https://private.example" },
      }),
      { ...productionBindings, LOCAL_STUDY_BYPASS: "true" },
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "auth_unconfigured" });
  });
});

function request(
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request(`https://private.example${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          origin: "https://private.example",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        body,
      }),
      productionBindings,
    ),
  );
}
