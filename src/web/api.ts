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
    if (response.status === 401 || response.status === 503) {
      throw new Error(
        "Local study access is not enabled. Use bun run dev:worker with LOCAL_STUDY_BYPASS=true in .dev.vars.",
      );
    }
    throw new Error(serverMessage);
  }
  return payload as T;
}
