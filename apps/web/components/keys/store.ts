"use client";

// KeyHub's ONE client data layer. Every mount of the key sections — settings,
// the model detail page, the Overview — reads org API keys and provider
// connections through the module-level caches below and mutates through the
// helpers that follow, so a key added on one mount appears on every other
// without a reload. Plain fetch over the keys-P5 GETs and the existing
// mutation routes; the repo has no client data library and this store does
// not introduce one (useSyncExternalStore is the whole machinery).

import { useMemo, useSyncExternalStore } from "react";

import type { ApiKeysPage } from "@/lib/api-keys/queries";
import type {
  ApiKeyRow,
  GatewayKeyLimits,
  GatewayKeyLimitsInput
} from "@/lib/api-keys/types";
import type {
  ModelDeploymentCheck,
  ModelProvider,
  ProviderConnectionCheck,
  ProviderSpendRefresh
} from "@/lib/model-providers";
import type { ModelCreateInput, ModelDetail, Waterfall } from "@/lib/models-catalog/types";
import type { ProviderConnectionSummary } from "@/lib/provider-connections";

export type StoreSnapshot<T> = {
  /** The latest good read; stays rendered while a refresh is in flight. */
  data: T | null;
  error: string | null;
  loading: boolean;
};

type Entry<T> = {
  snapshot: StoreSnapshot<T>;
  listeners: Set<() => void>;
  load: () => Promise<T>;
};

const entries = new Map<string, Entry<unknown>>();

// Stable references for the signed-out (null key) and server-render paths:
// useSyncExternalStore requires getSnapshot to return an identical value until
// the store notifies, so these never change identity.
const IDLE_SNAPSHOT: StoreSnapshot<never> = { data: null, error: null, loading: false };
const subscribeNever = () => () => {};
const getIdleSnapshot = () => IDLE_SNAPSHOT;

function entryFor<T>(key: string, load: () => Promise<T>, initialData?: T): Entry<T> {
  let entry = entries.get(key) as Entry<T> | undefined;
  if (entry === undefined) {
    // `initialData` seeds a read the server already fetched (the model detail
    // page hands its server payload to the client store), so the first mount
    // renders from it and skips the redundant client round-trip. Later reads
    // still refresh normally when something invalidates the entry.
    entry = {
      snapshot: { data: initialData ?? null, error: null, loading: false },
      listeners: new Set(),
      load
    };
    entries.set(key, entry as Entry<unknown>);
  } else if (
    initialData !== undefined &&
    entry.snapshot.data === null &&
    entry.snapshot.error === null &&
    !entry.snapshot.loading
  ) {
    // A fresh entry that no one has loaded yet: seed it rather than leave it to
    // fetch. Never clobber data or an in-flight/failed read.
    entry.snapshot = { data: initialData, error: null, loading: false };
  }
  return entry;
}

async function refreshEntry(entry: Entry<unknown>): Promise<void> {
  if (entry.snapshot.loading) {
    return;
  }
  entry.snapshot = { ...entry.snapshot, loading: true };
  emit(entry);
  try {
    const data = await entry.load();
    entry.snapshot = { data, error: null, loading: false };
  } catch (error) {
    // Keep any previous good data on screen; the error renders beside it.
    entry.snapshot = {
      data: entry.snapshot.data,
      error: error instanceof Error ? error.message : "The request failed.",
      loading: false
    };
  }
  emit(entry);
}

function emit(entry: Entry<unknown>): void {
  for (const listener of entry.listeners) {
    listener();
  }
}

/** Re-fetch every cached read whose key starts with the prefix (all pages of an org's keys, an org's connections). */
function refreshMatching(prefix: string): void {
  for (const [key, entry] of entries) {
    if (key.startsWith(prefix)) {
      void refreshEntry(entry);
    }
  }
}

/**
 * Subscribe to one cached read. A null key is the signed-out mount: it renders
 * the idle snapshot and — by contract with the gating pattern — fires no
 * account-scoped fetch at all. The first subscriber triggers the initial load.
 */
function useStoreEntry<T>(
  key: string | null,
  load: () => Promise<T>,
  initialData?: T
): StoreSnapshot<T> {
  const external = useMemo(() => {
    if (key === null) {
      return null;
    }
    const entry = entryFor(key, load, initialData);
    return {
      subscribe: (listener: () => void) => {
        entry.listeners.add(listener);
        if (entry.snapshot.data === null && entry.snapshot.error === null && !entry.snapshot.loading) {
          void refreshEntry(entry as Entry<unknown>);
        }
        return () => {
          entry.listeners.delete(listener);
        };
      },
      getSnapshot: () => entry.snapshot
    };
    // `load` is derived from the same arguments as `key`; the key is the identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return useSyncExternalStore(
    external?.subscribe ?? subscribeNever,
    external?.getSnapshot ?? getIdleSnapshot,
    getIdleSnapshot
  );
}

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
    throw new Error(
      typeof payload?.error === "string" ? payload.error : `The request failed (${response.status}).`
    );
  }
  // Mutations may answer 204 with no body (key revocation does).
  const text = await response.text();
  return (text.length === 0 ? null : JSON.parse(text)) as T;
}

// ---- Org API keys ----------------------------------------------------------

const orgKeysPrefix = (orgId: string) => `keys|${orgId}|`;

export function useOrgApiKeys(
  orgId: string | null,
  page: number,
  showRevoked: boolean,
  // Scope the listing to one identity's keys; null lists every org key. Both
  // views share the org prefix so a mint on either refreshes the other.
  identityId: string | null = null
): StoreSnapshot<ApiKeysPage> {
  const key =
    orgId === null
      ? null
      : `${orgKeysPrefix(orgId)}${identityId ?? "*"}|${page}|${showRevoked ? 1 : 0}`;
  return useStoreEntry(key, () => {
    const params = new URLSearchParams({ orgId: orgId ?? "", page: String(page) });
    if (showRevoked) {
      params.set("revoked", "1");
    }
    if (identityId !== null) {
      params.set("identityId", identityId);
    }
    return fetchJson<ApiKeysPage>(`/api/keys?${params.toString()}`);
  });
}

export type MintedKey = { apiKey: ApiKeyRow; secret: string };

export async function mintOrgApiKey(
  orgId: string,
  name: string,
  expiresInDays: number | null,
  // The identity the key hangs off; null mints under the org's default identity.
  // The wire body only carries identityId when a specific identity is chosen:
  // the mint route treats an absent identityId as the org default, so an
  // org-level quick-mint sends the same body it always did.
  identityId: string | null = null
): Promise<{ minted: MintedKey } | { error: string }> {
  try {
    const body =
      identityId === null ? { orgId, name, expiresInDays } : { orgId, name, expiresInDays, identityId };
    const minted = await fetchJson<MintedKey>("/api/keys", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    refreshMatching(orgKeysPrefix(orgId));
    return { minted };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Unable to create the key." };
  }
}

export async function revokeOrgApiKey(orgId: string, keyId: string): Promise<{ error: string } | null> {
  try {
    await fetchJson(`/api/keys/${encodeURIComponent(keyId)}`, { method: "DELETE" });
    refreshMatching(orgKeysPrefix(orgId));
    return null;
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Unable to revoke the key." };
  }
}

// ---- Per-key gateway limits --------------------------------------------------

const keyLimitsKey = (apiKeyId: string) => `key-limits|${apiKeyId}`;

/**
 * One key's effective guardrails, defaults included (member-strength read).
 * Always key-scoped: the limits row only mounts for a concrete key, so there
 * is no signed-out null arm here.
 */
export function useKeyLimits(apiKeyId: string): StoreSnapshot<GatewayKeyLimits> {
  return useStoreEntry(keyLimitsKey(apiKeyId), () =>
    fetchJson<GatewayKeyLimits>(`/api/gateway/keys/${encodeURIComponent(apiKeyId)}/limits`)
  );
}

/**
 * Replace one key's guardrails (org admin; the backend 403s everyone else).
 * Full-resource semantics by backend contract: all three fields ship on every
 * save and null means explicitly uncapped, never "keep the previous value".
 */
export async function saveKeyLimits(
  apiKeyId: string,
  limits: GatewayKeyLimitsInput
): Promise<{ error: string } | null> {
  try {
    await fetchJson<GatewayKeyLimits>(
      `/api/gateway/keys/${encodeURIComponent(apiKeyId)}/limits`,
      {
        body: JSON.stringify(limits),
        headers: { "content-type": "application/json" },
        method: "PUT"
      }
    );
    refreshMatching(keyLimitsKey(apiKeyId));
    return null;
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Unable to save the limits." };
  }
}

export type RotatedKey = MintedKey & {
  /** When the outgoing key stops authenticating (the rotation overlap window). */
  oldKeyExpiresAt: string;
};

/**
 * Rotate a key: mint a same-named replacement and schedule the old key's
 * expiry after the overlap window (server default 24h) instead of cutting it
 * off. The replacement's plaintext appears exactly once, in this result.
 */
export async function rotateOrgApiKey(
  orgId: string,
  keyId: string
): Promise<{ rotated: RotatedKey } | { error: string }> {
  try {
    const rotated = await fetchJson<RotatedKey>(
      `/api/keys/${encodeURIComponent(keyId)}/rotate`,
      { body: JSON.stringify({}), headers: { "content-type": "application/json" }, method: "POST" }
    );
    refreshMatching(orgKeysPrefix(orgId));
    return { rotated };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Unable to rotate the key." };
  }
}

// ---- Provider connections ---------------------------------------------------

const connectionsKey = (orgId: string) => `connections|${orgId}`;

export function useProviderConnections(
  orgId: string | null
): StoreSnapshot<ProviderConnectionSummary[]> {
  const key = orgId === null ? null : connectionsKey(orgId);
  return useStoreEntry(key, async () => {
    const payload = await fetchJson<{ connections: ProviderConnectionSummary[] }>(
      `/api/orgs/${encodeURIComponent(orgId ?? "")}/provider-connections`
    );
    return payload.connections;
  });
}

function providerRoute(orgId: string, provider: ModelProvider): string {
  return `/api/orgs/${encodeURIComponent(orgId)}/provider-connections/${provider}`;
}

/**
 * Connect or rotate a provider key. The PUT runs the hookup check inside the
 * save round-trip, so the returned verdict is the row's already-verified
 * state. `spendSecret` is the optional Anthropic/OpenAI ADMIN key: it rides
 * the same save and the check verifies both credentials in one pass,
 * reporting the admin key's verdict under status_detail.spend_key.
 */
export async function connectProvider(
  orgId: string,
  provider: ModelProvider,
  body: {
    secret: string | Record<string, string>;
    spendSecret?: string;
    config: Record<string, unknown>;
  }
): Promise<{ check: ProviderConnectionCheck | null } | { error: string }> {
  try {
    const payload = await fetchJson<{ check?: ProviderConnectionCheck | null }>(
      providerRoute(orgId, provider),
      {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "PUT"
      }
    );
    refreshMatching(connectionsKey(orgId));
    return { check: payload.check ?? null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Unable to save the provider key." };
  }
}

export async function declareProviderBalance(
  orgId: string,
  provider: ModelProvider,
  amountUsd: number
): Promise<{ error: string } | null> {
  try {
    await fetchJson(providerRoute(orgId, provider), {
      body: JSON.stringify({ declared_balance_usd: amountUsd }),
      headers: { "content-type": "application/json" },
      method: "PATCH"
    });
    refreshMatching(connectionsKey(orgId));
    return null;
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Unable to save the balance." };
  }
}

/**
 * Ask the provider account for its current reading (spend, credits, limits).
 * Allowed "quite often": the backend enforces per-provider staleness floors
 * and answers from the stored snapshot inside them, so the verdict is always
 * honest — reported numbers, "doesn't report this", or a failed read.
 */
export async function refreshProviderSpend(
  orgId: string,
  provider: ModelProvider
): Promise<{ refresh: ProviderSpendRefresh } | { error: string }> {
  try {
    const refresh = await fetchJson<ProviderSpendRefresh>(
      `${providerRoute(orgId, provider)}/spend-refresh`,
      { method: "POST" }
    );
    refreshMatching(connectionsKey(orgId));
    return { refresh };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Unable to read spend from the provider."
    };
  }
}

/**
 * The model page's Azure deployment question, optionally mapping the
 * deployment name inline first (the least-clicks add). The persisted fact
 * rides the connection's status_detail.models, so the connections read is
 * refreshed and every mount — settings included — sees it.
 */
export async function checkModelDeployment(
  orgId: string,
  provider: ModelProvider,
  input: { model: string; deployment?: string }
): Promise<{ check: ModelDeploymentCheck } | { error: string }> {
  try {
    const check = await fetchJson<ModelDeploymentCheck>(
      `${providerRoute(orgId, provider)}/deployment-check`,
      {
        body: JSON.stringify(input),
        headers: { "content-type": "application/json" },
        method: "POST"
      }
    );
    refreshMatching(connectionsKey(orgId));
    return { check };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Unable to check the deployment."
    };
  }
}

export async function disconnectProvider(
  orgId: string,
  provider: ModelProvider
): Promise<{ error: string } | null> {
  try {
    await fetchJson(providerRoute(orgId, provider), { method: "DELETE" });
    refreshMatching(connectionsKey(orgId));
    return null;
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Unable to disconnect." };
  }
}

// ---- Models catalog (the model page mount) ----------------------------------

const modelDetailKey = (modelSlug: string, orgId: string | null) =>
  `model|${modelSlug}|${orgId ?? "public"}`;

/**
 * One model's catalog detail (deployments + default chain). A PUBLIC read by
 * backend contract — the signed-out mount fetches it too (it is not
 * account-scoped), which is what lets the card render the provider list
 * before login.
 */
export function useModelDetail(
  modelSlug: string,
  orgId: string | null,
  // The model detail page fetches this server-side and seeds it here so the
  // first client mount renders from it instead of firing a second identical
  // GET /api/models/{slug} (same visibility, since the server read carries the
  // viewer's actor header exactly as the client's orgId query does).
  initialData?: ModelDetail
): StoreSnapshot<ModelDetail> {
  return useStoreEntry(
    modelDetailKey(modelSlug, orgId),
    () => {
      const query = orgId === null ? "" : `?orgId=${encodeURIComponent(orgId)}`;
      return fetchJson<ModelDetail>(`/api/models/${encodeURIComponent(modelSlug)}${query}`);
    },
    initialData
  );
}

const waterfallKey = (modelSlug: string, orgId: string) => `waterfall|${modelSlug}|${orgId}`;

/** The org's provider priority for one model (default chain + override). */
export function useModelWaterfall(
  modelSlug: string,
  orgId: string | null
): StoreSnapshot<Waterfall> {
  const key = orgId === null ? null : waterfallKey(modelSlug, orgId);
  return useStoreEntry(key, () =>
    fetchJson<Waterfall>(
      `/api/models/${encodeURIComponent(modelSlug)}/waterfall?orgId=${encodeURIComponent(
        orgId ?? ""
      )}`
    )
  );
}

/**
 * Replace the org's provider priority for this model with an ordered
 * deployment id list; [] clears the override back to the default chain. The
 * PUT persists server-side (survives refresh), then the cached read reloads.
 */
export async function saveModelPriority(
  modelSlug: string,
  orgId: string,
  modelProviderIds: string[]
): Promise<{ error: string } | null> {
  try {
    await fetchJson<Waterfall>(
      `/api/models/${encodeURIComponent(modelSlug)}/waterfall`,
      {
        body: JSON.stringify({ org_id: orgId, model_provider_ids: modelProviderIds }),
        headers: { "content-type": "application/json" },
        method: "PUT"
      }
    );
    refreshMatching(waterfallKey(modelSlug, orgId));
    return null;
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Unable to save the priority." };
  }
}

/**
 * Create an ORG-OWNED local model from a customer's OpenAI-compatible endpoint
 * and return it. int-p3's serving contract: a local route only serves as its
 * own org-owned model (owning_org_id = the org), never as a local variant on a
 * public/shared model — the tenant guard blocks an org-owned deployment on a
 * public alias, so that shape persists but never routes. createCatalogModel
 * writes the org model row + its `local` model_providers row + the default
 * chain in one call. The provider row MUST declare `supports_streaming` because
 * WMO forces stream=true on every dispatch and preflights the declaration
 * (int-p3); prices stay null (customer_managed is never charged). Routability
 * lags up to one 15s builder poll tick after this resolves.
 */
export async function createLocalModel(
  orgId: string,
  input: { slug: string; displayName: string; baseUrl: string; providerModelId: string }
): Promise<{ model: ModelDetail } | { error: string }> {
  const payload = {
    org_id: orgId,
    slug: input.slug,
    display_name: input.displayName,
    // A generic OpenAI-compatible endpoint: declare only the common, honestly
    // supported surface. These become enforced limits (int-p3), so under-declare
    // rather than inherit the public model's richer modalities/params.
    input_modalities: ["text"],
    output_modalities: ["text"],
    supported_params: { temperature: true, tools: true },
    providers: [
      {
        provider: "local",
        provider_model_id: input.providerModelId,
        base_url: input.baseUrl,
        capabilities: { supports_streaming: true }
      }
    ]
  } satisfies ModelCreateInput;
  try {
    const model = await fetchJson<ModelDetail>("/api/models", {
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    // Org-scoped model: refresh its detail so navigating to it renders live
    // (the catalog list is server-fetched and picks it up on the next render).
    refreshMatching(modelDetailKey(input.slug, orgId));
    return { model };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Creating the local model failed." };
  }
}
