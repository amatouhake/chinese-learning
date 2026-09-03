import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from "jose";

export interface AccessAuthConfig {
  environment?: string;
  localStudyBypass?: string;
  issuer?: string;
  audience?: string;
  ownerSubject?: string;
}

export type AccessAuthDecision =
  | { status: "authorized"; subject: string }
  | { status: "unauthorized"; reason: string }
  | { status: "forbidden"; reason: string }
  | { status: "unconfigured"; reason: string };

export interface AccessJwtVerifyOptions {
  keyResolver?: JWTVerifyGetKey;
  currentDate?: Date;
}

export type AccessJwtVerifier = (
  token: string,
  config: Pick<AccessAuthConfig, "issuer" | "audience">,
  options?: AccessJwtVerifyOptions,
) => Promise<string | null>;

const accessJwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export const LOCAL_DEVELOPMENT_SUBJECT = "local-development";

export async function verifyAccessJwt(
  token: string,
  config: Pick<AccessAuthConfig, "issuer" | "audience">,
  options: AccessJwtVerifyOptions = {},
): Promise<string | null> {
  const issuer = validIssuer(config.issuer);
  const audience = configuredValue(config.audience);
  if (!issuer || !audience || !token) return null;

  try {
    const keyResolver = options.keyResolver ?? getAccessJwks(issuer);
    const { payload } = await jwtVerify<AccessJwtClaims>(token, keyResolver, {
      algorithms: ["RS256"],
      issuer,
      audience,
      currentDate: options.currentDate,
      // Access tokens always carry these claims. jose also validates nbf when Access includes it.
      requiredClaims: ["iss", "aud", "exp", "sub"],
    });
    return typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : null;
  } catch {
    // The token and remote JWKS error are deliberately not logged.
    return null;
  }
}

export async function authorizeStudyRequest(
  request: Request,
  config: AccessAuthConfig,
  verifier: AccessJwtVerifier = verifyAccessJwt,
): Promise<AccessAuthDecision> {
  const url = new URL(request.url);

  if (config.environment === "production" && config.localStudyBypass === "true") {
    return { status: "unconfigured", reason: "local bypass cannot be enabled in production" };
  }

  if (
    config.localStudyBypass === "true" &&
    isLoopbackHostname(url.hostname) &&
    isSameOriginBrowserRequest(request, url) &&
    hasSafeRequestBody(request)
  ) {
    return { status: "authorized", subject: LOCAL_DEVELOPMENT_SUBJECT };
  }

  if (config.localStudyBypass === "true") {
    return { status: "unauthorized", reason: "local bypass is loopback-only and same-origin" };
  }

  if (!isSameOriginBrowserRequest(request, url)) {
    return { status: "unauthorized", reason: "request origin is not same-origin" };
  }

  const issuer = configuredValue(config.issuer);
  const audience = configuredValue(config.audience);
  const ownerSubject = configuredValue(config.ownerSubject);
  if (!issuer || !audience) {
    return { status: "unconfigured", reason: "Access issuer or audience is missing" };
  }
  if (!ownerSubject) {
    return { status: "unconfigured", reason: "Access owner subject is missing" };
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) {
    return { status: "unauthorized", reason: "Access JWT is missing" };
  }

  const subject = await verifier(token, {
    issuer,
    audience,
  });
  if (!subject) {
    return { status: "unauthorized", reason: "Access JWT is invalid" };
  }
  if (subject !== ownerSubject) {
    return { status: "forbidden", reason: "Access identity is not the configured owner" };
  }

  return { status: "authorized", subject };
}

export function configuredValue(value: string | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  if (
    /^(?:__[^\n]+__|<[^\n]+>)$/iu.test(normalized) ||
    /(?:replace[-_ ]?with|placeholder|set[-_ ]?after|todo)/iu.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function getAccessJwks(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  const existing = accessJwks.get(issuer);
  if (existing) return existing;

  const resolver = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
    cacheMaxAge: 10 * 60 * 1000,
    cooldownDuration: 30 * 1000,
    timeoutDuration: 5000,
  });
  accessJwks.set(issuer, resolver);
  return resolver;
}

function validIssuer(value: string | undefined): string | null {
  const issuer = configuredValue(value);
  if (!issuer) return null;

  try {
    const url = new URL(issuer);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function isSameOriginBrowserRequest(request: Request, url: URL): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null) {
    try {
      return new URL(origin).origin === url.origin;
    } catch {
      return false;
    }
  }

  return request.headers.get("sec-fetch-site") === "same-origin";
}

function hasSafeRequestBody(request: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) return true;
  return hasJsonContentType(request);
}

function hasJsonContentType(request: Request): boolean {
  return (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
    "application/json"
  );
}

interface AccessJwtClaims extends JWTPayload {
  iss: string;
  aud: string | string[];
  exp: number;
  sub: string;
}
