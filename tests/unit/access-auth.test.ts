import { generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { expect, test } from "bun:test";

import {
  authorizeStudyRequest,
  verifyAccessJwt,
  type AccessAuthConfig,
} from "../../src/worker/auth";

const issuer = "https://private-study.cloudflareaccess.com";
const audience = "private-study-audience";
const ownerSubject = "owner-subject";
const currentDate = new Date("2026-09-03T00:00:00.000Z");
const currentSeconds = Math.floor(currentDate.getTime() / 1000);
const config: AccessAuthConfig = {
  environment: "production",
  localStudyBypass: "false",
  issuer,
  audience,
  ownerSubject,
};

const { privateKey, publicKey } = await generateKeyPair("RS256");
const keyResolver: JWTVerifyGetKey = async () => publicKey;

test("verifies a signed Access JWT and returns only its validated subject", async () => {
  const token = await signedToken();
  await expect(
    verifyAccessJwt(token, { issuer, audience }, { keyResolver, currentDate }),
  ).resolves.toBe(ownerSubject);
});

test("rejects wrong issuer, audience, expiry, not-before, malformed, and missing claims", async () => {
  await expect(
    verifyAccessJwt(
      await signedToken({ issuer: "https://another.cloudflareaccess.com" }),
      { issuer, audience },
      { keyResolver, currentDate },
    ),
  ).resolves.toBeNull();
  await expect(
    verifyAccessJwt(
      await signedToken({ audience: "another-audience" }),
      { issuer, audience },
      { keyResolver, currentDate },
    ),
  ).resolves.toBeNull();
  await expect(
    verifyAccessJwt(
      await signedToken({ expiration: currentSeconds - 1 }),
      { issuer, audience },
      { keyResolver, currentDate },
    ),
  ).resolves.toBeNull();
  await expect(
    verifyAccessJwt(
      await signedToken({ notBefore: currentSeconds + 1 }),
      { issuer, audience },
      { keyResolver, currentDate },
    ),
  ).resolves.toBeNull();
  await expect(
    verifyAccessJwt("not-a-jwt", { issuer, audience }, { keyResolver, currentDate }),
  ).resolves.toBeNull();
  await expect(
    verifyAccessJwt(
      await signedToken({ omitNotBefore: true }),
      { issuer, audience },
      { keyResolver, currentDate },
    ),
  ).resolves.toBe(ownerSubject);
  await expect(
    verifyAccessJwt(
      await signedToken({ omitSubject: true }),
      { issuer, audience },
      { keyResolver, currentDate },
    ),
  ).resolves.toBeNull();
});

test("requires the exact configured owner subject and never trusts identity headers", async () => {
  const foreignToken = await signedToken({ subject: "foreign-subject" });
  await expect(
    authorizeStudyRequest(
      new Request("https://private.example/api/health", {
        headers: {
          origin: "https://private.example",
          "Cf-Access-Jwt-Assertion": foreignToken,
        },
      }),
      config,
      (token, jwtConfig) => verifyAccessJwt(token, jwtConfig, { keyResolver, currentDate }),
    ),
  ).resolves.toMatchObject({ status: "forbidden" });

  await expect(
    authorizeStudyRequest(
      new Request("https://private.example/api/health", {
        headers: {
          origin: "https://private.example",
          "Cf-Access-Authenticated-User-Email": "owner@example.com",
        },
      }),
      config,
      (token, jwtConfig) => verifyAccessJwt(token, jwtConfig, { keyResolver, currentDate }),
    ),
  ).resolves.toMatchObject({ status: "unauthorized" });
});

test("isolates the loopback development bypass from production and cross-origin requests", async () => {
  const localConfig: AccessAuthConfig = {
    ...config,
    environment: "local",
    localStudyBypass: "true",
  };
  await expect(
    authorizeStudyRequest(
      new Request("http://127.0.0.1/api/attempts", {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1",
          "content-type": "application/json",
        },
      }),
      localConfig,
    ),
  ).resolves.toMatchObject({ status: "authorized" });
  await expect(
    authorizeStudyRequest(
      new Request("http://127.0.0.1/api/attempts", {
        method: "POST",
        headers: {
          origin: "https://attacker.example",
          "content-type": "application/json",
          authorization: "Bearer ignored-browser-bearer",
        },
      }),
      localConfig,
    ),
  ).resolves.toMatchObject({ status: "unauthorized" });
  await expect(
    authorizeStudyRequest(
      new Request("https://private.example/api/attempts", {
        method: "POST",
        headers: {
          origin: "https://private.example",
          "content-type": "application/json",
          authorization: "Bearer ignored-browser-bearer",
        },
      }),
      localConfig,
    ),
  ).resolves.toMatchObject({ status: "unauthorized" });
  await expect(
    authorizeStudyRequest(
      new Request("http://127.0.0.1/api/health", {
        headers: { origin: "http://127.0.0.1" },
      }),
      { ...localConfig, environment: "production" },
    ),
  ).resolves.toMatchObject({ status: "unconfigured" });
});

test("rejects obvious Access configuration placeholders", async () => {
  await expect(
    authorizeStudyRequest(
      new Request("https://private.example/api/health", {
        headers: { origin: "https://private.example", "Cf-Access-Jwt-Assertion": "ignored" },
      }),
      { ...config, audience: "replace-with-access-audience" },
    ),
  ).resolves.toMatchObject({ status: "unconfigured" });
});

interface TokenOptions {
  issuer?: string;
  audience?: string;
  subject?: string;
  expiration?: number;
  notBefore?: number;
  omitNotBefore?: boolean;
  omitSubject?: boolean;
}

async function signedToken(options: TokenOptions = {}): Promise<string> {
  let token = new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(options.issuer ?? issuer)
    .setAudience(options.audience ?? audience)
    .setIssuedAt(currentSeconds)
    .setExpirationTime(options.expiration ?? currentSeconds + 3600);
  if (!options.omitNotBefore) token = token.setNotBefore(options.notBefore ?? currentSeconds - 1);
  if (!options.omitSubject) token = token.setSubject(options.subject ?? ownerSubject);
  return token.sign(privateKey);
}
