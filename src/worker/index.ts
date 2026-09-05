import { Hono, type Context, type Next } from "hono";

import { ingestAttempt } from "../db/ingestion";
import { getProgressSnapshot } from "../db/progress";
import { getPracticeSessionSummary, getRecentPracticeSessions } from "../db/practice-sessions";
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
import {
  authorizeStudyRequest,
  type AccessAuthDecision,
  type AccessJwtVerifier,
  verifyAccessJwt,
} from "./auth";
import { resolveCurrentLearner } from "./current-learner";

type AppContext = Context<{ Bindings: CloudflareBindings }>;
export interface WorkerAppOptions {
  verifyAccessJwt?: AccessJwtVerifier;
}

export function createWorkerApp(options: WorkerAppOptions = {}): Hono<{
  Bindings: CloudflareBindings;
}> {
  const app = new Hono<{ Bindings: CloudflareBindings }>();
  const authVerifier = options.verifyAccessJwt ?? verifyAccessJwt;

  const requirePrivateAuth = async (context: AppContext, next: Next) => {
    const authorization = await authorizeStudyRequest(
      context.req.raw,
      {
        environment: context.env.ENVIRONMENT,
        localStudyBypass: context.env.LOCAL_STUDY_BYPASS,
        issuer: context.env.ACCESS_ISSUER,
        audience: context.env.ACCESS_AUDIENCE,
        ownerSubject: context.env.ACCESS_OWNER_SUB,
      },
      authVerifier,
    );
    const authError = authenticationError(context, authorization);
    if (authError) return authError;
    return next();
  };

  app.use("/api/*", requirePrivateAuth);
  app.use("/mcp", requirePrivateAuth);
  app.use("/mcp/*", requirePrivateAuth);

  app.get("/api/health", (context) =>
    context.json({
      ok: true,
      service: "chinese-learning",
    }),
  );

  app.post("/api/progress", async (context) => {
    context.header("Cache-Control", "no-store");
    return context.json(await getProgressSnapshot(context.env.DB, resolveCurrentLearner()));
  });

  app.post("/api/practice-sessions/recent", async (context) => {
    try {
      const body = await readJsonBody(context);
      const limit = historyLimit(body);
      context.header("Cache-Control", "no-store");
      return context.json(
        await getRecentPracticeSessions(context.env.DB, resolveCurrentLearner(), { limit }),
      );
    } catch (error) {
      const response = domainError(context, error);
      if (response) return response;
      throw error;
    }
  });

  app.post("/api/practice-sessions/:sessionId/summary", async (context) => {
    try {
      context.header("Cache-Control", "no-store");
      return context.json(
        await getPracticeSessionSummary(
          context.env.DB,
          resolveCurrentLearner(),
          context.req.param("sessionId"),
        ),
      );
    } catch (error) {
      const response = domainError(context, error);
      if (response) return response;
      throw error;
    }
  });

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
      const result = await ingestAttempt(context.env.DB, resolveCurrentLearner(), input);
      return context.json(result, result.disposition === "inserted" ? 201 : 200);
    } catch (error) {
      const response = domainError(context, error);
      if (response) return response;
      throw error;
    }
  });

  app.post("/api/study/sessions", async (context) => {
    try {
      const input = parseCreateStudySessionInput(await readJsonBody(context));
      const result = await createStudySession(context.env.DB, resolveCurrentLearner(), input);
      return context.json(result, result.disposition === "created" ? 201 : 200);
    } catch (error) {
      const response = domainError(context, error);
      if (response) return response;
      throw error;
    }
  });

  app.post("/api/study/sessions/:sessionId/next", async (context) => {
    try {
      const input = parseNextStudyCardInput(await readJsonBody(context));
      const result = await getNextStudyCard(
        context.env.DB,
        resolveCurrentLearner(),
        context.req.param("sessionId"),
        input.deviceId,
        {},
        input.practiceContractVersion,
      );
      return context.json(result);
    } catch (error) {
      const response = domainError(context, error);
      if (response) return response;
      throw error;
    }
  });

  app.post("/api/reflex/sessions", async (context) => {
    try {
      const input = parseCreateReflexSessionInput(await readJsonBody(context));
      const result = await createReflexSession(context.env.DB, resolveCurrentLearner(), input);
      return context.json(result, result.disposition === "created" ? 201 : 200);
    } catch (error) {
      const response = domainError(context, error);
      if (response) return response;
      throw error;
    }
  });

  app.post("/api/pronunciation/sessions", async (context) => {
    try {
      const input = parseCreatePronunciationSessionInput(await readJsonBody(context));
      const result = await createPronunciationSession(
        context.env.DB,
        resolveCurrentLearner(),
        input,
      );
      return context.json(result, result.disposition === "created" ? 201 : 200);
    } catch (error) {
      const response = domainError(context, error);
      if (response) return response;
      throw error;
    }
  });

  app.post("/api/pronunciation/sessions/:sessionId/next", async (context) => {
    try {
      const input = parseNextPronunciationCardInput(await readJsonBody(context));
      const result = await getNextPronunciationCard(
        context.env.DB,
        resolveCurrentLearner(),
        context.req.param("sessionId"),
        input.deviceId,
        {},
        input.practiceContractVersion,
      );
      return context.json(result);
    } catch (error) {
      const response = domainError(context, error);
      if (response) return response;
      throw error;
    }
  });

  app.post("/api/reading/sessions", async (context) => {
    try {
      const input = parseCreateReadingSessionInput(await readJsonBody(context));
      const result = await createReadingSession(context.env.DB, resolveCurrentLearner(), input);
      return context.json(result, result.disposition === "created" ? 201 : 200);
    } catch (error) {
      const response = domainError(context, error);
      if (response) return response;
      throw error;
    }
  });

  app.post("/api/reading/sessions/:sessionId/next", async (context) => {
    try {
      const input = parseNextGuidedCardInput(await readJsonBody(context), "reading");
      return context.json(
        await getNextReadingCard(
          context.env.DB,
          resolveCurrentLearner(),
          context.req.param("sessionId"),
          input.deviceId,
          {},
          input.practiceContractVersion,
        ),
      );
    } catch (error) {
      const response = domainError(context, error);
      if (response) return response;
      throw error;
    }
  });

  app.post("/api/grammar/sessions", async (context) => {
    try {
      const input = parseCreateGrammarSessionInput(await readJsonBody(context));
      const result = await createGrammarSession(context.env.DB, resolveCurrentLearner(), input);
      return context.json(result, result.disposition === "created" ? 201 : 200);
    } catch (error) {
      const response = domainError(context, error);
      if (response) return response;
      throw error;
    }
  });

  app.post("/api/grammar/sessions/:sessionId/next", async (context) => {
    try {
      const input = parseNextGuidedCardInput(await readJsonBody(context), "grammar");
      return context.json(
        await getNextGrammarCard(
          context.env.DB,
          resolveCurrentLearner(),
          context.req.param("sessionId"),
          input.deviceId,
          {},
          input.practiceContractVersion,
        ),
      );
    } catch (error) {
      const response = domainError(context, error);
      if (response) return response;
      throw error;
    }
  });

  app.post("/api/sync/pull", async (context) => {
    try {
      const input = parseSyncPullInput(await readJsonBody(context));
      return context.json(await pullSyncChanges(context.env.DB, resolveCurrentLearner(), input));
    } catch (error) {
      const response = domainError(context, error);
      if (response) return response;
      throw error;
    }
  });

  const reservedMcp = (context: AppContext) =>
    context.json(
      {
        error: "Remote MCP is reserved for a later read-only slice.",
      },
      501,
    );
  app.all("/mcp", reservedMcp);
  app.all("/mcp/*", reservedMcp);

  app.onError((error, context) => {
    console.error(
      JSON.stringify({
        message: "request failed",
        error: error.name,
        path: context.req.path,
      }),
    );
    return context.json({ error: "Internal server error" }, 500);
  });

  return app;
}

export default createWorkerApp();

function authenticationError(
  context: AppContext,
  authorization: AccessAuthDecision,
): Response | null {
  if (authorization.status === "authorized") return null;
  context.header("Cache-Control", "no-store");
  if (authorization.status === "unconfigured") {
    return context.json(
      { error: "Private study access is not configured", code: "auth_unconfigured" },
      503,
    );
  }
  if (authorization.status === "forbidden") {
    return context.json({ error: "Forbidden", code: "forbidden" }, 403);
  }
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

function historyLimit(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidInputError("history body must be an object");
  }
  const limit = (value as Record<string, unknown>).limit;
  if (limit === undefined) return undefined;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 50) {
    throw new InvalidInputError("history limit must be an integer from 1 to 50");
  }
  return limit as number;
}
