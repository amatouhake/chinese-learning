const BEARER_TOKEN = /^Bearer ([^\s]+)$/i;

type WorkersSubtleCrypto = SubtleCrypto & {
  timingSafeEqual(left: ArrayBuffer, right: ArrayBuffer): boolean;
};

export async function authorizeAttemptWrite(
  authorization: string | undefined,
  expectedToken: string | undefined,
): Promise<"authorized" | "unauthorized" | "unconfigured"> {
  if (!expectedToken) return "unconfigured";

  const providedToken = authorization?.match(BEARER_TOKEN)?.[1];
  if (!providedToken) return "unauthorized";

  const encoder = new TextEncoder();
  const subtle = crypto.subtle as WorkersSubtleCrypto;
  const [providedHash, expectedHash] = await Promise.all([
    subtle.digest("SHA-256", encoder.encode(providedToken)),
    subtle.digest("SHA-256", encoder.encode(expectedToken)),
  ]);
  return subtle.timingSafeEqual(providedHash, expectedHash) ? "authorized" : "unauthorized";
}
