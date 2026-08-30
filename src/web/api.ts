export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function postJson<T = unknown>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const serverMessage =
      typeof payload === "object" &&
      payload !== null &&
      typeof (payload as Record<string, unknown>).error === "string"
        ? ((payload as Record<string, unknown>).error as string)
        : `Request failed (${response.status})`;
    const serverCode =
      typeof payload === "object" &&
      payload !== null &&
      typeof (payload as Record<string, unknown>).code === "string"
        ? (payload as Record<string, unknown>).code
        : null;
    if (response.status === 401 || serverCode === "auth_unconfigured") {
      throw new ApiError(
        "Local study access is not enabled. Use bun run dev:worker with LOCAL_STUDY_BYPASS=true in .dev.vars.",
        response.status,
      );
    }
    throw new ApiError(serverMessage, response.status);
  }
  return payload as T;
}
