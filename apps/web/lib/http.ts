import { DataSourceNotFoundError, DataSourceRequestError } from "./errors";
import { SsoStepUpRequiredError } from "./auth/org-access";
import { AuthRequiredError } from "./auth/server";

export function jsonOk(payload: unknown, headers?: HeadersInit): Response {
  return Response.json(payload, headers === undefined ? undefined : { headers });
}

/**
 * Forward a backend server-sent-event body to the browser verbatim. The
 * upstream stream already carries the rollout events; this only re-labels it
 * so proxies and the fetch client treat it as a live event stream. The body
 * is passed through as-is — never read, decoded, or re-serialized — so each
 * upstream flush reaches the browser immediately; `x-accel-buffering: no`
 * keeps nginx-style proxies in front of the app from batching events.
 */
export function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      "cache-control": "no-cache, no-transform",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no"
    }
  });
}

export function jsonError(error: unknown): Response {
  if (error instanceof AuthRequiredError) {
    return Response.json({ error: error.message }, { status: 401 });
  }
  if (error instanceof SsoStepUpRequiredError) {
    // The org-access gate's API-shaped surface (E2): a member session whose
    // method does not satisfy the org's SSO requirement gets the stable
    // signal, never data. The browser-side UX handles the redirect.
    return Response.json({ error: "sso_required", org: error.orgSlug }, { status: 403 });
  }
  if (error instanceof DataSourceNotFoundError) {
    return Response.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof DataSourceRequestError) {
    // Forward meaningful upstream statuses (409 conflict, 422 foreign trace,
    // 502 provider error) so client components can branch on them.
    return Response.json(
      {
        error: error.message,
        ...(error.code === null ? {} : { code: error.code }),
        ...(error.action === null ? {} : { action: error.action })
      },
      { status: error.status }
    );
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return Response.json({ error: message }, { status: 500 });
}

/**
 * Validate an enum-ish query param at the route boundary: an absent value
 * takes the fallback, an unknown value returns null so the route can 400
 * instead of coercing.
 */
export function pickParam<T extends string>(
  value: string | null,
  allowed: readonly T[],
  fallback: T
): T | null {
  if (value === null) {
    return fallback;
  }
  return (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/**
 * Parse a row-limit query param bounded to [1, cap]; absent defaults to the
 * cap (the widest read), malformed or out-of-range returns null for a 400.
 */
export function parseLimitParam(value: string | null, cap: number): number | null {
  const limit = value === null ? cap : Number.parseInt(value, 10);
  return Number.isFinite(limit) && limit >= 1 && limit <= cap ? limit : null;
}

export async function routeParams<T extends Record<string, string>>(
  params: Promise<T>
): Promise<T> {
  return params;
}

/**
 * Assert a required request field is present, failing loudly at the proxy
 * boundary with a 400 instead of coercing an absent field into an empty-string
 * sentinel the typed data source cannot distinguish from a real value.
 */
export function requireField(value: string | null | undefined, field: string): string {
  if (value === null || value === undefined || value === "") {
    throw new DataSourceRequestError(`${field} is required.`, 400);
  }
  return value;
}
