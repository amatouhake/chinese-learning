export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export async function postJson<T = unknown>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
    redirect: "manual",
    cache: "no-store",
  });

  const isAccessRedirect =
    response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const isAccessResponse =
    isAccessRedirect || response.redirected || contentType.includes("text/html");
  const payload: unknown = isAccessResponse ? null : await response.json().catch(() => null);
  if (!response.ok) {
    throw apiErrorFromResponse(response.status, payload, isAccessResponse);
  }
  if (isAccessResponse) {
    throw new ApiError(authRequiredMessage(), 401, "auth_required");
  }
  return payload as T;
}

function apiErrorFromResponse(
  status: number,
  payload: unknown,
  isAccessResponse: boolean,
): ApiError {
  const serverCode = recordString(payload, "code");
  if (isAccessResponse || status === 401) {
    return new ApiError(
      authRequiredMessage(),
      status === 0 ? 401 : status,
      serverCode ?? "auth_required",
    );
  }
  if (status === 403 || serverCode === "forbidden") {
    return new ApiError("You are not authorized to use this private study.", status, "forbidden");
  }
  if (serverCode === "auth_unconfigured") {
    return new ApiError(
      "Private study access is not configured for this deployment.",
      status,
      serverCode,
    );
  }
  const serverMessage = recordString(payload, "error") ?? `Request failed (${status})`;
  return new ApiError(serverMessage, status, serverCode ?? undefined);
}

function authRequiredMessage(): string {
  if (typeof location !== "undefined" && isLoopbackHostname(location.hostname)) {
    return "Local study access is unavailable. Set LOCAL_STUDY_BYPASS=true in .dev.vars for local development.";
  }
  return "Sign-in is required to continue. Reopen the app to refresh your private study session.";
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function recordString(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : null;
}
