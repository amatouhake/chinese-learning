import { Hono, type Context } from "hono";

import { ingestAttempt } from "../db/ingestion";
import { createStudySession, getNextStudyCard } from "../db/study";
import { ConflictError, InvalidInputError, ReferenceNotFoundError } from "../domain/errors";
import { parseCreateStudySessionInput, parseNextStudyCardInput } from "../domain/study-validation";
import { parseAttemptInput } from "../domain/validation";
import { authorizeStudyWrite } from "./auth";

const app = new Hono<{ Bindings: CloudflareBindings }>();
type AppContext = Context<{ Bindings: CloudflareBindings }>;

app.get("/api/health", (context) =>
  context.json({
    ok: true,
    service: "chinese-learning",
  }),
);

app.post("/api/attempts", async (context) => {
  const authorization = await authorizeStudyWrite(
    context.req.raw,
    context.env.ATTEMPT_WRITE_TOKEN,
    context.env.LOCAL_STUDY_BYPASS,
  );
  const authError = authenticationError(context, authorization);
  if (authError) return authError;

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
    const response = domainError(context, error);
    if (response) return response;
    throw error;
  }
});

app.post("/api/study/sessions", async (context) => {
  const authorization = await authorizeStudyWrite(
    context.req.raw,
    context.env.ATTEMPT_WRITE_TOKEN,
    context.env.LOCAL_STUDY_BYPASS,
  );
  const authError = authenticationError(context, authorization);
  if (authError) return authError;

  try {
    const input = parseCreateStudySessionInput(await context.req.json<unknown>());
    const result = await createStudySession(context.env.DB, input);
    return context.json(result, result.disposition === "created" ? 201 : 200);
  } catch (error) {
    const response = domainError(context, error);
    if (response) return response;
    throw error;
  }
});

app.post("/api/study/sessions/:sessionId/next", async (context) => {
  const authorization = await authorizeStudyWrite(
    context.req.raw,
    context.env.ATTEMPT_WRITE_TOKEN,
    context.env.LOCAL_STUDY_BYPASS,
  );
  const authError = authenticationError(context, authorization);
  if (authError) return authError;

  try {
    const input = parseNextStudyCardInput(await context.req.json<unknown>());
    const result = await getNextStudyCard(
      context.env.DB,
      context.req.param("sessionId"),
      input.deviceId,
    );
    return context.json(result);
  } catch (error) {
    const response = domainError(context, error);
    if (response) return response;
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

function authenticationError(
  context: AppContext,
  authorization: "authorized" | "unauthorized" | "unconfigured",
): Response | null {
  if (authorization === "authorized") return null;
  context.header("Cache-Control", "no-store");
  if (authorization === "unconfigured") {
    return context.json(
      { error: "Study write authentication is not configured", code: "auth_unconfigured" },
      503,
    );
  }
  context.header("WWW-Authenticate", "Bearer");
  return context.json({ error: "Unauthorized", code: "unauthorized" }, 401);
}

function domainError(context: AppContext, error: unknown): Response | null {
  if (error instanceof InvalidInputError) {
    return context.json({ error: error.message, code: error.code }, 400);
  }
  if (error instanceof ReferenceNotFoundError) {
    return context.json({ error: error.message, code: error.code }, 404);
  }
  if (error instanceof ConflictError) {
    return context.json({ error: error.message, code: error.code }, 409);
  }
  return null;
}
