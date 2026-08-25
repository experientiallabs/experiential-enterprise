"use client";

// The model-page KeyHub mount: which of the org's provider keys can serve
// THIS model, each with its live state — including the model-scoped Azure
// deployment check and its canonical "You have a key, but this model isn't
// deployed." verdict — plus the inline add-a-key flow (the same
// ProviderConnectForm and store as settings, so a key added here appears
// there without a reload) and the per-model provider priority list, persisted
// as the org's waterfall override. Self-contained: one line mounts it.

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { clsx } from "clsx";

import { useLoginModal } from "@/components/auth/login-modal-context";
import { KEY_INPUT_CLASS, ProviderConnectForm } from "@/components/keys/provider-connect-form";
import { storedStatusMessage } from "@/components/keys/provider-meta";
import { disconnectedSummary } from "@/components/keys/provider-keys-section";
import {
  checkModelDeployment,
  saveModelPriority,
  useModelDetail,
  useModelWaterfall,
  useProviderConnections
} from "@/components/keys/store";
import { ProviderLogo } from "@/components/models-catalog/model-icon";
import { AdminOnlyNote } from "@/components/settings/IntegrationsPanel";
import { ProviderConnectModal } from "@/components/settings/ProviderConnectModal";
import { PLATFORM_SERVING_BASE_URL } from "@/components/world-models/endpoint-snippets";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { Shimmer } from "@/components/ui/Shimmer";
import { providerConnectionStatusLabel, providerConnectionStatusTone } from "@/lib/format";
import { PLATFORM_WEB_URL } from "@/lib/llms-txt";
import {
  connectableProvidersForModel,
  modelDeploymentFact,
  modelProviderLabel,
  type ModelDeploymentFact
} from "@/lib/model-providers";
import type { CatalogDeployment, WaterfallRung } from "@/lib/models-catalog/types";
import type { ProviderConnectionSummary } from "@/lib/provider-connections";

export type UseViaKeyCardProps = {
  /** The catalog model slug this card serves (the /api/models identifier). */
  modelSlug: string;
  /** Org UUID; null renders the signed-out state (structure visible, actions prompt login). */
  orgId: string | null;
  /** Whether the viewer may manage provider keys (org admin or platform operator). */
  canManage: boolean;
  /**
   * Whether to render the per-model provider priority list. The model detail
   * page's "Ways to use" block owns route ordering itself (one drag-reorder
   * surface), so it embeds this card with `showPriority={false}` to keep only
   * the connect-a-key rows. Defaults to true for standalone mounts.
   */
  showPriority?: boolean;
  /** Whether to render the card's own header/intro; off when embedded. */
  chrome?: boolean;
  /**
   * Public web/API origins the per-provider connect modal embeds in its
   * copy-paste transfer prompt (the same modal /credits and Settings use).
   * Resolved server-side; the platform defaults keep the presentational tests
   * rendering without wiring them.
   */
  webBaseUrl?: string;
  apiBaseUrl?: string;
};

export function UseViaKeyCard({
  modelSlug,
  orgId,
  canManage,
  showPriority = true,
  chrome = true,
  webBaseUrl = PLATFORM_WEB_URL,
  apiBaseUrl = PLATFORM_SERVING_BASE_URL
}: UseViaKeyCardProps) {
  const { open, requireAuth } = useLoginModal();
  const detailRead = useModelDetail(modelSlug, orgId);
  const connectionsRead = useProviderConnections(orgId);

  // Every mutation goes through this gate: signed out it prompts login in
  // place of acting; signed in it runs under requireAuth so an expired
  // session also lands in the modal once shell-P4 replaces the shim.
  const gate = (fn: () => void) => {
    if (orgId === null) {
      open();
      return;
    }
    requireAuth(fn);
  };

  // The one live model-scoped check: an Azure key that is valid at key level
  // still cannot serve a model whose deployment is missing. Probe once per
  // mapped deployment per mount — when there is no stored fact for that
  // mapping yet, or the stored fact says "not deployed" (so deploying it in
  // Azure flips the card on the next visit). A fact that says deployed is
  // trusted; traffic (keys-P9) demotes it if it breaks.
  const probed = useRef(new Set<string>());
  const azure = connectionsRead.data?.find((c) => c.provider === "azure_openai");
  useEffect(() => {
    if (orgId === null || !canManage || azure === undefined || !azure.connected) {
      return;
    }
    if (azure.status !== "valid" && azure.status !== "unchecked") {
      return;
    }
    const mapped = azureMappedDeployment(azure, modelSlug);
    if (mapped === null) {
      return;
    }
    const fact = modelDeploymentFact(azure.status_detail, modelSlug);
    if (fact !== null && fact.deployment === mapped && fact.deployed) {
      return;
    }
    const probeKey = `${orgId}|${modelSlug}|${mapped}`;
    if (probed.current.has(probeKey)) {
      return;
    }
    probed.current.add(probeKey);
    void checkModelDeployment(orgId, "azure_openai", { model: modelSlug });
  }, [azure, canManage, modelSlug, orgId]);

  const detail = detailRead.data;
  // One row per BYOK-connectable provider offered for this model: the
  // model-scoped set in catalog order, or the full provider list when the
  // catalog names none we can connect a key to — so "Add an API key" always
  // presents a platform choice (the product owner: it must never show nothing). `local`
  // deployments are self-hosted endpoints, not keys, so they never appear here.
  const providers = useMemo(
    () => connectableProvidersForModel(detail?.providers ?? []),
    [detail]
  );

  return (
    <section
      className={
        chrome
          ? "flex flex-col gap-3 rounded-lg border border-line bg-surface p-[18px]"
          : "flex flex-col gap-3"
      }
      data-model-slug={modelSlug}
      data-testid="use-via-key-card"
    >
      {chrome ? (
        <div className="flex flex-col gap-1.5">
          <p className="mono-label m-0">Use via key</p>
          <p className="m-0 max-w-[780px] text-[13px] leading-relaxed text-muted">
            Serve this model on your own provider account: pick one of your connected keys, add a
            new one inline, and set which providers you prioritize for it. Keys added here appear in
            Settings too, same store.
          </p>
        </div>
      ) : null}

      {detail === null && detailRead.error !== null ? (
        <p className="m-0 text-[13px] text-danger">{detailRead.error}</p>
      ) : detail === null ? (
        <div className="flex flex-col gap-3" data-testid="use-via-key-loading">
          <Shimmer className="h-4 w-full" />
          <Shimmer className="h-4 w-2/3" />
        </div>
      ) : (
        <>
          <div className="flex flex-col">
            {providers.map((provider) => (
              <ProviderKeyRow
                apiBaseUrl={apiBaseUrl}
                canManage={canManage}
                connection={
                  connectionsRead.data?.find((c) => c.provider === provider) ??
                  disconnectedSummary(provider)
                }
                gate={gate}
                key={provider}
                loading={orgId !== null && connectionsRead.data === null}
                modelSlug={modelSlug}
                orgId={orgId}
                webBaseUrl={webBaseUrl}
              />
            ))}
          </div>
          {connectionsRead.error !== null && connectionsRead.data === null && orgId !== null && (
            <p className="m-0 text-[13px] text-danger">{connectionsRead.error}</p>
          )}
          {showPriority ? (
            <PriorityList
              defaultChain={detail.default_waterfall}
              deployments={detail.providers}
              gate={gate}
              modelSlug={modelSlug}
              orgId={orgId}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

/** The stored Azure deployment name mapped for this model, when one exists. */
function azureMappedDeployment(
  connection: ProviderConnectionSummary,
  modelSlug: string
): string | null {
  const deployments = connection.config?.deployments;
  if (typeof deployments !== "object" || deployments === null || Array.isArray(deployments)) {
    return null;
  }
  const mapped = (deployments as Record<string, unknown>)[modelSlug];
  return typeof mapped === "string" && mapped.length > 0 ? mapped : null;
}

type ProviderKeyRowProps = {
  orgId: string | null;
  modelSlug: string;
  connection: ProviderConnectionSummary;
  canManage: boolean;
  /** True while the signed-in connections read is still in flight. */
  loading: boolean;
  gate: (fn: () => void) => void;
  /** Public origins the connect modal's transfer prompt embeds. */
  webBaseUrl: string;
  apiBaseUrl: string;
};

/** The short header line for the connect modal: the key identity, or "Not connected". */
function connectStatusLine(connection: ProviderConnectionSummary): string {
  if (!connection.connected) {
    return "Not connected";
  }
  const identity =
    connection.credential_last4 !== null ? `Key ····${connection.credential_last4}` : "Connected";
  return connection.status === "valid" || connection.status === "unchecked"
    ? identity
    : `${identity} · ${providerConnectionStatusLabel(connection.status).toLowerCase()}`;
}

/**
 * One provider's line for this model: the mark and name, the model-scoped
 * verdict in plain words, and the action that gets the org from here to
 * "serves via your key" in the fewest clicks — connect a key, fix a rejected
 * one, or (Azure) name the missing deployment.
 */
function ProviderKeyRow({
  orgId,
  modelSlug,
  connection,
  canManage,
  loading,
  gate,
  webBaseUrl,
  apiBaseUrl
}: ProviderKeyRowProps) {
  const label = modelProviderLabel(connection.provider);
  const [modalOpen, setModalOpen] = useState(false);
  const isAzure = connection.provider === "azure_openai";
  const mapped = isAzure ? azureMappedDeployment(connection, modelSlug) : null;
  const fact =
    isAzure && mapped !== null ? modelDeploymentFact(connection.status_detail, modelSlug) : null;
  const factCurrent = fact !== null && fact.deployment === mapped ? fact : null;

  return (
    <div className="flex flex-col gap-2 border-t border-line py-3 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex min-w-[180px] items-center gap-2.5 text-[13px] font-medium text-ink">
          <span
            aria-hidden
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-line bg-foreground/[0.03] text-foreground/60"
          >
            <ProviderLogo provider={connection.provider} size={14} />
          </span>
          {label}
        </span>
        <span className="flex-1 text-[13px] text-muted">
          {loading ? (
            <Shimmer className="h-4 w-40" />
          ) : (
            <RowVerdict
              connection={connection}
              factCurrent={factCurrent}
              mapped={mapped}
              probing={orgId !== null && canManage}
            />
          )}
        </span>
        <button
          className="cursor-pointer rounded-full border border-line bg-transparent px-3 py-1 text-[12px] text-foreground/60 hover:border-line-strong hover:text-foreground"
          onClick={() => setModalOpen(true)}
          type="button"
        >
          {connection.connected ? "Manage key" : "Add key"}
        </button>
      </div>

      {/* The model-scoped problem in full, never behind a tooltip. */}
      {!loading && connection.connected && factCurrent !== null && !factCurrent.deployed && (
        <p className="m-0 max-w-[780px] rounded-[var(--radius-md)] bg-warning-soft px-2.5 py-2 text-[12px] leading-relaxed text-warning">
          {factCurrent.remediation ??
            "You have a key, but this model isn't deployed: the resource has no deployment " +
              `named '${factCurrent.deployment}'.`}
        </p>
      )}
      {!loading &&
        connection.connected &&
        connection.status !== "valid" &&
        connection.status !== "unchecked" && (
          <p className="m-0 max-w-[780px] rounded-[var(--radius-md)] bg-danger/10 px-2.5 py-2 text-[12px] leading-relaxed text-danger">
            {storedStatusMessage(connection)}
          </p>
        )}

      {/* Azure least-clicks: connected and valid, but this model has no (or a
          missing) deployment, just the deployment name, saved and probed in
          one round-trip. */}
      {!loading &&
        isAzure &&
        connection.connected &&
        (connection.status === "valid" || connection.status === "unchecked") &&
        (mapped === null || (factCurrent !== null && !factCurrent.deployed)) &&
        (canManage || orgId === null ? (
          <DeploymentNameForm
            gate={gate}
            mapped={mapped}
            modelSlug={modelSlug}
            orgId={orgId}
          />
        ) : (
          <p className="m-0 text-[12px] text-muted">
            An organization admin can map the Azure deployment this model is served under.
          </p>
        ))}

      {modalOpen && (
        // The same connect popup /credits and Settings open — provider logo,
        // per-provider transfer prompt, and the schema-driven credential form —
        // so connecting a provider is one identical experience everywhere.
        <ProviderConnectModal
          apiBaseUrl={apiBaseUrl}
          canManage={canManage}
          connected={connection.connected}
          onClose={() => setModalOpen(false)}
          provider={connection.provider}
          status={connectStatusLine(connection)}
          webBaseUrl={webBaseUrl}
        >
          {canManage || orgId === null ? (
            <ProviderConnectForm connection={connection} gate={gate} orgId={orgId} />
          ) : (
            <AdminOnlyNote connected={connection.connected} noun="key" />
          )}
        </ProviderConnectModal>
      )}
    </div>
  );
}

/** The one-line verdict for this (provider x model) pair, in plain words. */
function RowVerdict({
  connection,
  mapped,
  factCurrent,
  probing
}: {
  connection: ProviderConnectionSummary;
  mapped: string | null;
  factCurrent: ModelDeploymentFact | null;
  /** Whether this mount runs the Azure probe itself (admin, signed in). */
  probing: boolean;
}) {
  if (!connection.connected) {
    return <span className="text-muted-2">Not connected</span>;
  }
  if (connection.status !== "valid" && connection.status !== "unchecked") {
    return (
      <Chip
        label={providerConnectionStatusLabel(connection.status)}
        tone={providerConnectionStatusTone(connection.status)}
      />
    );
  }
  if (connection.provider === "azure_openai") {
    if (mapped === null) {
      return <span>Key connected, name this model&apos;s deployment to serve it.</span>;
    }
    if (factCurrent === null) {
      return probing ? (
        <span>
          Checking the <span className="font-mono">{mapped}</span> deployment…
        </span>
      ) : (
        <span>
          Mapped to deployment <span className="font-mono">{mapped}</span>, not checked yet.
        </span>
      );
    }
    if (!factCurrent.deployed) {
      return (
        <span className="text-warning" data-testid="azure-not-deployed">
          You have a key, but this model isn&apos;t deployed.
        </span>
      );
    }
    return (
      <span data-testid="serves-via-key">
        Serves this model via your key ····{connection.credential_last4} (deployment{" "}
        <span className="font-mono">{mapped}</span>)
      </span>
    );
  }
  if (connection.status === "unchecked") {
    return <span>Key saved ····{connection.credential_last4}, not verified yet.</span>;
  }
  return (
    <span data-testid="serves-via-key">
      Serves this model via your key ····{connection.credential_last4}
    </span>
  );
}

/**
 * The least-clicks Azure path: the deployment name alone, saved onto the
 * connection's deployment map and probed in the same round-trip.
 */
function DeploymentNameForm({
  orgId,
  modelSlug,
  mapped,
  gate
}: {
  orgId: string | null;
  modelSlug: string;
  /** The currently mapped (missing) deployment, prefilled for correction. */
  mapped: string | null;
  gate: (fn: () => void) => void;
}) {
  const [name, setName] = useState(mapped ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const deployment = name.trim();
    if (deployment.length === 0 || busy) {
      return;
    }
    gate(() => {
      void (async () => {
        if (orgId === null) {
          return;
        }
        setError(null);
        setBusy(true);
        try {
          const result = await checkModelDeployment(orgId, "azure_openai", {
            model: modelSlug,
            deployment
          });
          if ("error" in result) {
            setError(result.error);
          }
          // The verdict itself renders through the refreshed connection row.
        } finally {
          setBusy(false);
        }
      })();
    });
  }

  return (
    <form className="flex max-w-[780px] flex-wrap items-center gap-2" onSubmit={save}>
      <input
        aria-label={`Azure deployment name for ${modelSlug}`}
        autoComplete="off"
        className={clsx(KEY_INPUT_CLASS, "max-w-[280px]")}
        onChange={(event) => setName(event.target.value)}
        placeholder="Deployment name in your resource"
        type="text"
        value={name}
      />
      <Button disabled={name.trim().length === 0} loading={busy} size="sm" type="submit">
        {mapped === null ? "Map & check" : "Re-check"}
      </Button>
      {error && <p className="m-0 w-full text-[13px] text-danger">{error}</p>}
    </form>
  );
}

type PriorityListProps = {
  orgId: string | null;
  modelSlug: string;
  deployments: CatalogDeployment[];
  defaultChain: WaterfallRung[];
  gate: (fn: () => void) => void;
};

/**
 * The per-model provider priority: every deployment of the model as one
 * ordered list — the org's waterfall override when one exists, the default
 * chain's order otherwise — reordered with up/down and persisted through the
 * catalog's waterfall PUT, so it survives refresh and steers routing.
 */
function PriorityList({ orgId, modelSlug, deployments, defaultChain, gate }: PriorityListProps) {
  const waterfallRead = useModelWaterfall(modelSlug, orgId);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const override = waterfallRead.data?.override ?? null;
  // Chain members first in chain order, then any unchained deployments in
  // catalog order, so the list always covers everything the model can route
  // to — including deployments added after the chain was written.
  const serverOrder = useMemo(() => {
    const chain = (override ?? defaultChain).map((rung) => rung.model_provider_id);
    const ordered = chain.filter((id) => deployments.some((d) => d.id === id));
    for (const deployment of deployments) {
      if (!ordered.includes(deployment.id)) {
        ordered.push(deployment.id);
      }
    }
    return ordered;
  }, [defaultChain, deployments, override]);
  const order = draft ?? serverOrder;

  // The draft is only the optimistic order while the PUT and re-read are in
  // flight; once the server order caught up it is redundant and the
  // override-derived affordances (the reset link) take over again.
  useEffect(() => {
    if (draft !== null && draft.length === serverOrder.length && draft.every((id, i) => id === serverOrder[i])) {
      setDraft(null);
    }
  }, [draft, serverOrder]);

  function persist(next: string[]) {
    setDraft(next);
    setError(null);
    gate(() => {
      void (async () => {
        if (orgId === null || busy) {
          return;
        }
        setBusy(true);
        try {
          const failure = await saveModelPriority(modelSlug, orgId, next);
          if (failure !== null) {
            setError(failure.error);
            setDraft(null);
          }
        } finally {
          setBusy(false);
        }
      })();
    });
    if (orgId === null) {
      // Signed out nothing was saved; the draft must not pretend otherwise.
      setDraft(null);
    }
  }

  function move(id: string, direction: -1 | 1) {
    const index = order.indexOf(id);
    const target = index + direction;
    if (index === -1 || target < 0 || target >= order.length) {
      return;
    }
    const next = [...order];
    next[index] = next[target];
    next[target] = id;
    persist(next);
  }

  function resetToDefault() {
    setError(null);
    gate(() => {
      void (async () => {
        if (orgId === null || busy) {
          return;
        }
        setBusy(true);
        try {
          const failure = await saveModelPriority(modelSlug, orgId, []);
          if (failure !== null) {
            setError(failure.error);
          }
          setDraft(null);
        } finally {
          setBusy(false);
        }
      })();
    });
  }

  if (deployments.length < 2) {
    // One deployment has no order to set; the row above already says it all.
    return null;
  }

  const byId = new Map(deployments.map((deployment) => [deployment.id, deployment]));

  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3" data-testid="provider-priority">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="mono-label m-0">Provider priority</p>
        {override !== null && draft === null && (
          <button
            className="cursor-pointer border-0 bg-transparent p-0 text-[12px] text-muted underline decoration-line-strong underline-offset-2 hover:text-foreground"
            onClick={resetToDefault}
            type="button"
          >
            Reset to default order
          </button>
        )}
      </div>
      <p className="m-0 max-w-[780px] text-[12px] leading-relaxed text-muted">
        Your organization&apos;s order for this model: requests try the first provider and fall
        through on failure.{" "}
        {override === null && draft === null ? "Currently the default order." : "Custom order."}
      </p>
      <ol className="m-0 flex list-none flex-col p-0">
        {order.map((id, index) => {
          const deployment = byId.get(id);
          if (deployment === undefined) {
            return null;
          }
          return (
            <li
              className="flex items-center gap-3 border-t border-line py-2 first:border-t-0"
              key={id}
            >
              <span className="w-5 shrink-0 text-right font-mono text-[11px] text-ink-faint">
                {index + 1}
              </span>
              <span className="flex-1 text-[13px] text-ink">
                {modelProviderLabel(deployment.provider)}{" "}
                <span className="font-mono text-[12px] text-muted">
                  {deployment.provider_model_id}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <button
                  aria-label={`Move ${modelProviderLabel(deployment.provider)} up`}
                  className="grid h-6 w-6 cursor-pointer place-items-center rounded-md border border-line bg-surface text-foreground/60 transition-colors hover:text-foreground disabled:cursor-default disabled:opacity-40"
                  disabled={index === 0 || busy}
                  onClick={() => move(id, -1)}
                  type="button"
                >
                  <ArrowUp aria-hidden size={12} strokeWidth={1.8} />
                </button>
                <button
                  aria-label={`Move ${modelProviderLabel(deployment.provider)} down`}
                  className="grid h-6 w-6 cursor-pointer place-items-center rounded-md border border-line bg-surface text-foreground/60 transition-colors hover:text-foreground disabled:cursor-default disabled:opacity-40"
                  disabled={index === order.length - 1 || busy}
                  onClick={() => move(id, 1)}
                  type="button"
                >
                  <ArrowDown aria-hidden size={12} strokeWidth={1.8} />
                </button>
              </span>
            </li>
          );
        })}
      </ol>
      {waterfallRead.error !== null && waterfallRead.data === null && orgId !== null && (
        <p className="m-0 text-[13px] text-danger">{waterfallRead.error}</p>
      )}
      {error && <p className="m-0 text-[13px] text-danger">{error}</p>}
    </div>
  );
}
