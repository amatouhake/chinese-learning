import { expect, test } from "bun:test";

import { postJson } from "../../src/web/api";

test("postJson uses same-origin credentials without a browser bearer token", async () => {
  const originalFetch = globalThis.fetch;
  let requestInit: RequestInit | undefined;
  globalThis.fetch = Object.assign(
    async (...args: Parameters<typeof fetch>) => {
      requestInit = args[1] as RequestInit | undefined;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    await expect(postJson("/api/health", { check: true })).resolves.toEqual({ ok: true });
    expect(requestInit).toMatchObject({
      credentials: "same-origin",
      redirect: "manual",
      cache: "no-store",
    });
    expect(new Headers(requestInit?.headers).has("authorization")).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("postJson treats an opaque Access redirect as authentication required", async () => {
  const originalFetch = globalThis.fetch;
  let requestInit: RequestInit | undefined;
  globalThis.fetch = Object.assign(
    async (...args: Parameters<typeof fetch>) => {
      requestInit = args[1] as RequestInit | undefined;
      return {
        type: "opaqueredirect",
        status: 0,
        ok: false,
        redirected: false,
        headers: new Headers(),
        json: async () => null,
      } as Response;
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    await expect(postJson("/api/health", {})).rejects.toMatchObject({
      status: 401,
      code: "auth_required",
      message: expect.stringContaining("Sign-in is required"),
    });
    expect(requestInit).toMatchObject({
      credentials: "same-origin",
      redirect: "manual",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("postJson preserves actual fetch failures as network failures", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async () => {
      throw new TypeError("Failed to fetch");
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    await expect(postJson("/api/health", {})).rejects.toThrow("Failed to fetch");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("postJson gives actionable Access/session errors for 401, 403, and HTML redirects", async () => {
  const originalFetch = globalThis.fetch;
  const responses = [
    new Response(JSON.stringify({ error: "Unauthorized", code: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
    new Response(JSON.stringify({ error: "Forbidden", code: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    }),
    new Response("<html>Access login</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    }),
  ];
  globalThis.fetch = Object.assign(
    async () => responses.shift() ?? new Response(null, { status: 500 }),
    { preconnect: originalFetch.preconnect },
  );
  try {
    await expect(postJson("/api/attempts", {})).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
      message: expect.stringContaining("Sign-in is required"),
    });
    await expect(postJson("/api/attempts", {})).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
      message: "You are not authorized to use this private study.",
    });
    await expect(postJson("/api/attempts", {})).rejects.toMatchObject({
      status: 401,
      code: "auth_required",
      message: expect.stringContaining("Sign-in is required"),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("postJson reports an unconfigured deployment without clearing local state", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async () =>
      new Response(
        JSON.stringify({
          error: "Private study access is not configured",
          code: "auth_unconfigured",
        }),
        {
          status: 503,
          headers: { "content-type": "application/json" },
        },
      ),
    { preconnect: originalFetch.preconnect },
  );
  try {
    await expect(postJson("/api/sync/pull", {})).rejects.toEqual(
      expect.objectContaining({
        status: 503,
        code: "auth_unconfigured",
        message: "Private study access is not configured for this deployment.",
      }),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
