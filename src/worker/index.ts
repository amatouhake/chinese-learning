import { Hono, type Context } from "hono";

import { ingestAttempt } from "../db/ingestion";
import { getProgressSnapshot } from "../db/progress";
import { createPronunciationSession, getNextPronunciationCard } from "../db/pronunciation";
import {
  createGrammarSession,
  createReadingSession,
  getNextGrammarCard,
  getNextReadingCard,
} from "../db/reading-grammar";
import { createStudySession, getNextStudyCard } from "../db/study";
import { createReflexSession } from "../db/reflex";
import { pullSyncChanges } from "../db/sync";
import { ConflictError, InvalidInputError, ReferenceNotFoundError } from "../domain/errors";
import { parseCreateStudySessionInput, parseNextStudyCardInput } from "../domain/study-validation";
import { parseCreateReflexSessionInput } from "../domain/reflex";
import {
  parseCreatePronunciationSessionInput,
  parseNextPronunciationCardInput,
} from "../domain/pronunciation-validation";
import { parseAttemptInput } from "../domain/validation";
import {
  parseCreateGrammarSessionInput,
  parseCreateReadingSessionInput,
  parseNextGuidedCardInput,
} from "../domain/reading-grammar-validation";
import { parseSyncPullInput } from "../domain/sync-validation";
import { authorizeStudyWrite } from "./auth";

const app = new Hono<{ Bindings: CloudflareBindings }>();
type AppContext = Context<{ Bindings: CloudflareBindings }>;

app.get("/api/health", (context) =>
  context.json({
    ok: true,
    service: "chinese-learning",
  }),
);

app.post("/api/progress", async (context) => {
  const authorization = await authorizeStudyWrite(
    context.req.raw,
    context.env.ATTEMPT_WRITE_TOKEN,
    context.env.LOCAL_STUDY_BYPASS,
  );
  const authError = authenticationError(context, authorization);
  if (authError) return authError;

  context.header("Cache-Control", "no-store");
  return context.json(await getProgressSnapshot(context.env.DB));
});

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
    const input = parseCreateStudySessionInput(await readJsonBody(context));
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
    const input = parseNextStudyCardInput(await readJsonBody(context));
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

app.post("/api/reflex/sessions", async (context) => {
  const authorization = await authorizeStudyWrite(
    context.req.raw,
    context.env.ATTEMPT_WRITE_TOKEN,
    context.env.LOCAL_STUDY_BYPASS,
  );
  const authError = authenticationError(context, authorization);
  if (authError) return authError;

  try {
    const input = parseCreateReflexSessionInput(await readJsonBody(context));
    const result = await createReflexSession(context.env.DB, input);
    return context.json(result, result.disposition === "created" ? 201 : 200);
  } catch (error) {
    const response = domainError(context, error);
    if (response) return response;
    throw error;
  }
});

app.post("/api/pronunciation/sessions", async (context) => {
  const authorization = await authorizeStudyWrite(
    context.req.raw,
    context.env.ATTEMPT_WRITE_TOKEN,
    context.env.LOCAL_STUDY_BYPASS,
  );
  const authError = authenticationError(context, authorization);
  if (authError) return authError;

  try {
    const input = parseCreatePronunciationSessionInput(await readJsonBody(context));
    const result = await createPronunciationSession(context.env.DB, input);
    return context.json(result, result.disposition === "created" ? 201 : 200);
  } catch (error) {
    const response = domainError(context, error);
    if (response) return response;
    throw error;
  }
});

app.post("/api/pronunciation/sessions/:sessionId/next", async (context) => {
  const authorization = await authorizeStudyWrite(
    context.req.raw,
    context.env.ATTEMPT_WRITE_TOKEN,
    context.env.LOCAL_STUDY_BYPASS,
  );
  const authError = authenticationError(context, authorization);
  if (authError) return authError;

  try {
    const input = parseNextPronunciationCardInput(await readJsonBody(context));
    const result = await getNextPronunciationCard(
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

app.post("/api/reading/sessions", async (context) => {
  const authorization = await authorizeStudyWrite(
    context.req.raw,
    context.env.ATTEMPT_WRITE_TOKEN,
    context.env.LOCAL_STUDY_BYPASS,
  );
  const authError = authenticationError(context, authorization);
  if (authError) return authError;

  try {
    const input = parseCreateReadingSessionInput(await readJsonBody(context));
    const result = await createReadingSession(context.env.DB, input);
    return context.json(result, result.disposition === "created" ? 201 : 200);
  } catch (error) {
    const response = domainError(context, error);
    if (response) return response;
    throw error;
  }
});

app.post("/api/reading/sessions/:sessionId/next", async (context) => {
  const authorization = await authorizeStudyWrite(
    context.req.raw,
    context.env.ATTEMPT_WRITE_TOKEN,
    context.env.LOCAL_STUDY_BYPASS,
  );
  const authError = authenticationError(context, authorization);
  if (authError) return authError;

  try {
    const input = parseNextGuidedCardInput(await readJsonBody(context));
    return context.json(
      await getNextReadingCard(context.env.DB, context.req.param("sessionId"), input.deviceId),
    );
  } catch (error) {
    const response = domainError(context, error);
    if (response) return response;
    throw error;
  }
});

app.post("/api/grammar/sessions", async (context) => {
  const authorization = await authorizeStudyWrite(
    context.req.raw,
    context.env.ATTEMPT_WRITE_TOKEN,
    context.env.LOCAL_STUDY_BYPASS,
  );
  const authError = authenticationError(context, authorization);
  if (authError) return authError;

  try {
    const input = parseCreateGrammarSessionInput(await readJsonBody(context));
    const result = await createGrammarSession(context.env.DB, input);
    return context.json(result, result.disposition === "created" ? 201 : 200);
  } catch (error) {
    const response = domainError(context, error);
    if (response) return response;
    throw error;
  }
});

app.post("/api/grammar/sessions/:sessionId/next", async (context) => {
  const authorization = await authorizeStudyWrite(
    context.req.raw,
    context.env.ATTEMPT_WRITE_TOKEN,
    context.env.LOCAL_STUDY_BYPASS,
  );
  const authError = authenticationError(context, authorization);
  if (authError) return authError;

  try {
    const input = parseNextGuidedCardInput(await readJsonBody(context));
    return context.json(
      await getNextGrammarCard(context.env.DB, context.req.param("sessionId"), input.deviceId),
    );
  } catch (error) {
    const response = domainError(context, error);
    if (response) return response;
    throw error;
  }
});

app.post("/api/sync/pull", async (context) => {
  const authorization = await authorizeStudyWrite(
    context.req.raw,
    context.env.ATTEMPT_WRITE_TOKEN,
    context.env.LOCAL_STUDY_BYPASS,
  );
  const authError = authenticationError(context, authorization);
  if (authError) return authError;

  try {
    const input = parseSyncPullInput(await readJsonBody(context));
    return context.json(await pullSyncChanges(context.env.DB, input));
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

async function readJsonBody(context: AppContext): Promise<unknown> {
  try {
    return await context.req.json<unknown>();
  } catch {
    throw new InvalidInputError("request body must be valid JSON");
  }
}
