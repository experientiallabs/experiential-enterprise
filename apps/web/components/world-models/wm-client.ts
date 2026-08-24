/**
 * Extracts the `{ error }` message that the Next API proxy routes (`jsonError`)
 * attach to non-2xx responses, falling back to caller-supplied copy when the
 * body is missing or unparseable.
 */
export async function readApiError(response: Response, fallback: string): Promise<string> {
  const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof payload?.error === "string" ? payload.error : fallback;
}
