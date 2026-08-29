import { Hono } from "hono";

import { ingestAttempt } from "../db/ingestion";
import { ConflictError, InvalidInputError, ReferenceNotFoundError } from "../domain/errors";
import { parseAttemptInput } from "../domain/validation";

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.get("/api/health", (context) =>
  context.json({
    ok: true,
    service: "chinese-learning",
  }),
);

app.post("/api/attempts", async (context) => {
  let input;
  try {
    input = parseAttemptInput(await context.req.json<unknown>());
  } catch (error) {
    return context.json(
      {
        error: error instanceof Error ? error.message : "invalid attempt body",
        code: "invalid_input",
      },
      400,
    );
  }

  try {
    const result = await ingestAttempt(context.env.DB, input);
    return context.json(result, result.disposition === "inserted" ? 201 : 200);
  } catch (error) {
    if (error instanceof InvalidInputError) {
      return context.json({ error: error.message, code: error.code }, 400);
    }
    if (error instanceof ReferenceNotFoundError) {
      return context.json({ error: error.message, code: error.code }, 404);
    }
    if (error instanceof ConflictError) {
      return context.json({ error: error.message, code: error.code }, 409);
    }
    throw error;
  }
});

app.all("/mcp", (context) =>
  context.json(
    {
      error: "Remote MCP is reserved for a later read-only slice.",
    },
    501,
  ),
);

app.onError((error, context) => {
  console.error(
    JSON.stringify({
      message: "request failed",
      error: error.message,
      path: context.req.path,
    }),
  );
  return context.json({ error: "Internal server error" }, 500);
});

export default app;
