// Server-side reads for the public models catalog. The catalog GETs are the
// one backend surface that renders signed out (explabs/api/routes/
// models_catalog.py resolves the actor optionally), so they cannot ride
// BackendDataSource — its actor provider REQUIRES a session. This module
// carries the same deployment credential and attaches the actor header only
// when a session exists, which is exactly the API's visibility contract:
// anonymous callers browse the public catalog, identified callers also see
// their orgs' own rows.
//
// The public catalog is the storefront's hot path, and it is identical for
// every viewer, so it is served from ONE shared cross-user cache instead of
// being refetched per visit: `fetchPublicCatalog` wraps the org-agnostic read
// in Next's Data Cache (`unstable_cache`), so the first visitor fills it and
// every later visit — any user, signed in or out — is served the last-good
// catalog with no backend round trip and no loading skeleton. After the
// revalidate window the next visit serves the stale copy while a background
// refresh replaces it for everyone (stale-while-revalidate); a catalog write
// busts the tag so a new model appears without waiting the window out. Each
// signed-in viewer's own models overlay this shared base with a thin per-user
// read (owner=org), so org-scoped rows never enter the shared cache.

import { revalidateTag, unstable_cache } from "next/cache";

import { getAuthenticatedUser } from "@/lib/auth/server";
import { DataSourceNotFoundError, DataSourceRequestError } from "@/lib/errors";

import type { ModelDetail, ModelList } from "./types";

/**
 * Cache tag for the shared, org-agnostic public catalog. Busting it (a model
 * created or edited through the API) refreshes the cached catalog for every
 * user on their next read.
 */
export const MODELS_CATALOG_TAG = "models-catalog";

/**
 * Background revalidation window for the shared public catalog, in seconds.
 * Within this bound a reseed, a new, or a removed public model propagates to
 * every visitor; a catalog write also busts the tag for immediate propagation.
 */
export const MODELS_CATALOG_REVALIDATE_SECONDS = 120;

const CATALOG_PAGE_LIMIT = 1000;

/**
 * The shared public catalog: org-agnostic (no actor header) and cached in
 * Next's cross-request Data Cache, so the cached value is identical for every
 * viewer and safe to share. Org-owned rows never enter here — they overlay
 * per-user in {@link fetchModelList}.
 */
/**
 * Failure cooldown for the shared catalog refresh. A failed revalidation does
 * not advance unstable_cache's clock, so during a backend outage EVERY page
 * view would otherwise fire another doomed refetch — the thundering herd that
 * kept the 2026-08-22 incident alive. Inside the cooldown the refresh fails
 * fast without touching the backend, so a dead backend sees at most one
 * catalog probe per window per web pod.
 */
const CATALOG_FAILURE_COOLDOWN_MS = 30_000;
let catalogCooldownUntilMs = 0;

export const fetchPublicCatalog = unstable_cache(
  async (): Promise<ModelList> => {
    if (Date.now() < catalogCooldownUntilMs) {
      throw new DataSourceRequestError(
        "The catalog backend is unavailable; retry shortly.",
        503
      );
    }
    try {
      const catalog = await pageCatalog(null);
      catalogCooldownUntilMs = 0;
      return catalog;
    } catch (error) {
      catalogCooldownUntilMs = Date.now() + CATALOG_FAILURE_COOLDOWN_MS;
      throw error;
    }
  },
  ["models-catalog-public"],
  { revalidate: MODELS_CATALOG_REVALIDATE_SECONDS, tags: [MODELS_CATALOG_TAG] }
);

/**
 * Invalidate the shared public catalog so every visitor's next read refreshes.
 * Called after a catalog write (POST /api/models) so a new model does not wait
 * out the revalidate window.
 */
export function revalidateModelsCatalog(): void {
  // Next 16's revalidateTag takes a cache profile; "max" is the recommended
  // value for an on-demand purge of a tag (it invalidates the unstable_cache
  // entry so the next read recomputes).
  revalidateTag(MODELS_CATALOG_TAG, "max");
}

/**
 * The catalog for a page render: the shared cached public base, plus — only for
 * a signed-in viewer — a thin overlay of that viewer's orgs' own custom models.
 * The overlay is a small per-user read (owner=org) that never touches the
 * shared cache, so org-scoped rows stay private while the public base is served
 * warm to everyone. The storefront re-ranks the merged set client-side, so the
 * concatenation order here is not load-bearing.
 */
export async function fetchModelList(): Promise<ModelList> {
  const base = await fetchPublicCatalog();
  const user = await getAuthenticatedUser();
  if (user === null) {
    return base;
  }
  const overlay = await pageCatalog(user.id, { owner: "org" });
  if (overlay.models.length === 0) {
    return base;
  }
  const baseIds = new Set(base.models.map((entry) => entry.model.id));
  const models = [
    ...base.models,
    ...overlay.models.filter((entry) => !baseIds.has(entry.model.id))
  ];
  // Promotions are population-level; keep the shared base's set (org-owned
  // overlay rows are never promotional).
  return { models, promotions: base.promotions, total: models.length, limit: base.limit, offset: 0 };
}

/**
 * Just one viewer's orgs' own custom models (owner=org), never the public base.
 * This is the thin per-user overlay the /models storefront hydrates CLIENT-side
 * after painting the shared cached base, so the signed-in page render depends
 * only on {@link fetchPublicCatalog} (a warm cache read, no per-visit backend
 * round trip) and never blanks while an uncached overlay fetch resolves — the
 * root cause of the /models load flash. Returns an empty list for a viewer with
 * no custom models. Not cached: org-scoped rows must never enter a shared cache.
 */
export async function fetchOrgOwnedModels(actorId: string): Promise<ModelList> {
  return pageCatalog(actorId, { owner: "org" });
}

/** One model's detail (row, visible deployments, default waterfall chain). */
export async function fetchModelDetail(slug: string): Promise<ModelDetail | null> {
  const user = await getAuthenticatedUser();
  try {
    return await catalogGet<ModelDetail>(
      `/api/models/${encodeURIComponent(slug)}`,
      user?.id ?? null
    );
  } catch (error) {
    if (error instanceof DataSourceNotFoundError) {
      return null;
    }
    throw error;
  }
}

/** The full catalog for one viewer scope, pages joined past the API's cap. */
async function pageCatalog(
  actorId: string | null,
  params: { owner?: "org" } = {}
): Promise<ModelList> {
  const first = await catalogGet<ModelList>(catalogPath(0, params), actorId);
  // Promotions are returned whole on every page (not paginated); the first page
  // is authoritative for them.
  const promotions = first.promotions ?? [];
  if (first.models.length >= first.total) {
    return {
      models: first.models,
      promotions,
      total: first.total,
      limit: CATALOG_PAGE_LIMIT,
      offset: 0
    };
  }
  // The first page reports the total, so the remaining pages' offsets are all
  // known up front — fetch them concurrently instead of walking one blocking
  // request at a time (a serial waterfall on the public storefront's hot path).
  const offsets: number[] = [];
  for (let offset = first.models.length; offset < first.total; offset += CATALOG_PAGE_LIMIT) {
    offsets.push(offset);
  }
  const rest = await Promise.all(
    offsets.map((offset) => catalogGet<ModelList>(catalogPath(offset, params), actorId))
  );
  const models = [...first.models, ...rest.flatMap((page) => page.models)];
  return { models, promotions, total: first.total, limit: CATALOG_PAGE_LIMIT, offset: 0 };
}

function catalogPath(offset: number, params: { owner?: "org" }): string {
  const search = new URLSearchParams({ limit: String(CATALOG_PAGE_LIMIT) });
  if (offset > 0) {
    search.set("offset", String(offset));
  }
  if (params.owner !== undefined) {
    search.set("owner", params.owner);
  }
  return `/api/models?${search.toString()}`;
}

async function catalogGet<T>(path: string, actorId: string | null): Promise<T> {
  const baseUrl = process.env.EXPLABS_BACKEND_URL;
  const apiKey = process.env.EXPLABS_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error(
      "EXPLABS_BACKEND_URL and EXPLABS_API_KEY must be set for the Experiential web app."
    );
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  if (actorId !== null) {
    headers["X-Explabs-Actor-Id"] = actorId;
  }
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    cache: "no-store",
    headers,
    // A hung backend must fail fast: without a bound, piled-up catalog
    // fetches hold sockets against a struggling api and feed the herd.
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
    const message =
      typeof payload?.error === "string"
        ? payload.error
        : `Experiential backend request failed with HTTP ${response.status}`;
    if (response.status === 404) {
      throw new DataSourceNotFoundError(message);
    }
    throw new DataSourceRequestError(message, response.status);
  }
  return (await response.json()) as T;
}
