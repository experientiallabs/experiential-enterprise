"use client";

// "Ways to use this model": the single consolidated block that replaced the
// separate providers table, fallback-waterfall editor, add-local-variant form,
// and use-via-key card (the product owner approved the consolidation, round-2 Q1). One row
// per way the model is reachable — "Through Experiential (uses credits)" first,
// then each provider/local route — each with that route's own pricing, stats,
// and status. The rows DRAG-TO-REORDER and that order IS the fallback waterfall,
// persisted through the same PUT the old editor used (store.saveModelPriority).
// Each row also carries a "Use" toggle on the right: on = this route serves the
// model (it is in the org's chain), off = it does not. Toggling off keeps the
// row in place, greyed, rather than exiling it to a separate "hidden" list
// (the product owner: a clean on/off, never "hide"). The toggle is optimistic and settles
// only once the server re-read agrees, so it never flickers on, off, and back.
// "+ Add a way" opens a chooser first (the product owner, round-3 E1): the two ways to serve
// a model are genuinely different, so instead of auto-jumping to the key form it
// offers "Add an API key" (keys-P7's connect-a-key card, mounted chrome-less with
// its priority list suppressed since this block owns ordering) or "Add a local
// variant" (the local base_url form, opened straight to its fields). All reads
// flow through keys-P7's shared store, so a key connected here shows up in
// Settings and everywhere else without a reload.

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, GripVertical, Info, KeyRound, Plus, Server } from "lucide-react";
import { clsx } from "clsx";

import { useLoginModal } from "@/components/auth/login-modal-context";
import { LocalVariantForm } from "@/components/models-catalog/detail/local-variant-form";
import { ProviderLogo } from "@/components/models-catalog/model-icon";
import { UseViaKeyCard } from "@/components/keys/use-via-key-card";
import { saveModelPriority, useModelDetail, useModelWaterfall } from "@/components/keys/store";
import { useProviderConnections } from "@/components/keys/store";
import { Button } from "@/components/ui/Button";
import { Shimmer } from "@/components/ui/Shimmer";
import { PLATFORM_SERVING_BASE_URL } from "@/components/world-models/endpoint-snippets";
import { isSelfHostable } from "@/lib/models-catalog/families";
import { isHostServed } from "@/lib/models-catalog/serving";
import { isEstimatedPricing, statsSourceLabel } from "@/lib/models-catalog/provenance";
import { PLATFORM_WEB_URL } from "@/lib/llms-txt";
import {
  EXPERIENTIAL_CLOUD_DESCRIPTION,
  formatThroughput,
  formatUptime,
  providerLabel
} from "@/lib/models-catalog/format";
import { modelDeploymentFact } from "@/lib/model-providers";
import { formatPerMillionUsd } from "@/lib/money";
import type { CatalogDeployment, ModelDetail, WaterfallRung } from "@/lib/models-catalog/types";
import type { ProviderConnectionSummary } from "@/lib/provider-connections";

type WaysToUseProps = {
  modelSlug: string;
  /** Null renders the signed-out state: rows visible, actions prompt login. */
  orgId: string | null;
  /** Whether the viewer may manage provider keys (org admin / platform operator). */
  canManage: boolean;
  /**
   * The detail payload the server already fetched, seeded into the client store
   * so this block renders its rows immediately instead of firing a second
   * GET /api/models/{slug} after hydration.
   */
  initialDetail?: ModelDetail;
  /**
   * Public web/API origins threaded to the per-provider connect modal's transfer
   * prompt (the same modal /credits and Settings use). Resolved server-side;
   * platform defaults keep the presentational tests rendering without wiring them.
   */
  webBaseUrl?: string;
  apiBaseUrl?: string;
};

/**
 * The ordered deployment ids: chain order first, then any unchained routes —
 * then stably partitioned so the Experiential-hosted (host-managed) lanes ALWAYS
 * lead, above BYOK keys, above local variants (the product owner's cloud-first priority
 * rule). Relative chain order is preserved within each band, so dragging still
 * reorders meaningfully inside a band while the platform lane stays on top.
 */
function orderedIds(
  deployments: CatalogDeployment[],
  chain: WaterfallRung[]
): string[] {
  const chainIds = chain
    .map((rung) => rung.model_provider_id)
    .filter((id) => deployments.some((d) => d.id === id));
  const ordered = [...chainIds];
  for (const deployment of deployments) {
    if (!ordered.includes(deployment.id)) {
      ordered.push(deployment.id);
    }
  }
  const byId = new Map(deployments.map((deployment) => [deployment.id, deployment]));
  const band = (id: string): number => {
    const deployment = byId.get(id);
    if (deployment === undefined) {
      return 3;
    }
    if (isHostServed(deployment)) {
      return 0;
    }
    return deployment.provider === "local" ? 2 : 1;
  };
  // Stable partition: Array.prototype.sort is stable, so ids keep their chain
  // order within each band.
  return ordered.sort((a, b) => band(a) - band(b));
}

/** Same ids in the same order — used to settle the optimistic draft. */
function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

export function WaysToUse({
  modelSlug,
  orgId,
  canManage,
  initialDetail,
  webBaseUrl = PLATFORM_WEB_URL,
  apiBaseUrl = PLATFORM_SERVING_BASE_URL
}: WaysToUseProps) {
  const { open, requireAuth } = useLoginModal();
  const detailRead = useModelDetail(modelSlug, orgId, initialDetail);
  const waterfallRead = useModelWaterfall(modelSlug, orgId);
  const connectionsRead = useProviderConnections(orgId);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // null = collapsed to the button; "choose" = the two-option chooser; "key" and
  // "local" = the chosen add form. Never auto-jumps past "choose".
  const [addMode, setAddMode] = useState<null | "choose" | "key" | "local">(null);
  // Monotonic tag per reorder save: only the latest one is allowed to settle
  // the optimistic draft, so an earlier save resolving late cannot clear it.
  const saveSeq = useRef(0);

  const gate = (fn: () => void) => {
    if (orgId === null) {
      open();
      return;
    }
    requireAuth(fn);
  };

  const detail = detailRead.data;
  // Only open-weights models can be pointed at a self-hosted endpoint, so the
  // "Add a local model" path is offered for those alone; proprietary,
  // API-only models (Claude, GPT, Gemini, Grok …) get the key path only. False
  // while the detail is still loading, so the local option never flashes in
  // before we know the family.
  const selfHostable = detail !== null && isSelfHostable(detail.model);
  const deployments = useMemo(() => detail?.providers ?? [], [detail]);
  const override = waterfallRead.data?.override ?? null;
  const defaultChain = detail?.default_waterfall ?? [];
  // A public/shared model: the gateway deliberately skips per-org waterfall
  // overrides for models the org does not own (the shared alias table can't
  // express per-org routing), so turning a route off here is an honest per-org
  // DISPLAY preference, not a routing change. For an org-OWNED model the same
  // override IS the routing chain, so turning a route off genuinely drops it.
  const isOrgOwned = detail !== null && detail.model.owning_org_id !== null;

  const connByProvider = useMemo(() => {
    const map = new Map<string, ProviderConnectionSummary>();
    for (const conn of connectionsRead.data ?? []) {
      map.set(conn.provider, conn);
    }
    return map;
  }, [connectionsRead.data]);

  // The waterfall lists USABLE lanes only (the product owner r4): an Experiential-hosted
  // lane always, an org-added lane (local variant / custom deployment) always,
  // but a public your-key lane ONLY when the org's key for that provider can
  // actually serve it: connected AND not verified-broken (an invalid or
  // quota-exhausted credential cannot serve), AND for Azure the resource must
  // actually deploy this model (keys-P7's persisted verdict). Availability
  // discovery lives in the providers table below, not here. Signed out there
  // are no connections, so only hosted lanes show.
  const isUsableLane = useMemo(() => {
    return (deployment: CatalogDeployment): boolean => {
      if (isHostServed(deployment) || deployment.owning_org_id !== null) {
        return true;
      }
      const connection = connByProvider.get(deployment.provider);
      if (connection?.connected !== true) {
        return false;
      }
      if (connection.status === "invalid" || connection.status === "quota_exhausted") {
        return false;
      }
      if (deployment.provider === "azure_openai") {
        // Fail closed: no persisted verdict means UNVERIFIED, and the
        // waterfall only lists routes known to serve this model.
        const fact = modelDeploymentFact(connection.status_detail, modelSlug);
        if (fact === null || !fact.deployed) {
          return false;
        }
      }
      return true;
    };
  }, [connByProvider, modelSlug]);
  const usable = useMemo(() => deployments.filter(isUsableLane), [deployments, isUsableLane]);

  // The org's full chain over ALL deployments, ignoring the usable gate: the
  // source of truth a save must never lose lanes (or their positions) from.
  const ungatedChain = useMemo(
    () =>
      override !== null
        ? override
            .map((rung) => rung.model_provider_id)
            .filter((id) => deployments.some((d) => d.id === id))
        : orderedIds(deployments, defaultChain),
    [deployments, override, defaultChain]
  );
  // Lanes the org ENABLED (in its chain) that are hidden right now because the
  // key is disconnected or broken. Every save merges these back in AT THEIR
  // CHAIN POSITIONS, so a reorder or toggle while a key is down never silently
  // rewrites the org's chain or demotes the lane — reconnecting the key
  // restores it exactly where the user left it.
  const hiddenEnabled = useMemo(
    () =>
      ungatedChain.filter((id) => {
        const deployment = deployments.find((d) => d.id === id);
        return deployment !== undefined && !isUsableLane(deployment);
      }),
    [ungatedChain, deployments, isUsableLane]
  );

  // Rebuild the complete chain for a save: hidden enabled lanes keep their
  // original slots; the visible lanes fill the remaining slots in the user's
  // new order (net-new visible lanes append).
  const withHiddenLanes = (visible: string[]): string[] => {
    if (hiddenEnabled.length === 0) {
      return visible;
    }
    const hiddenSet = new Set(hiddenEnabled);
    const merged: string[] = [];
    let cursor = 0;
    for (const id of ungatedChain) {
      if (hiddenSet.has(id)) {
        merged.push(id);
      } else if (cursor < visible.length) {
        merged.push(visible[cursor]);
        cursor += 1;
      }
    }
    while (cursor < visible.length) {
      merged.push(visible[cursor]);
      cursor += 1;
    }
    return merged;
  };

  // The enabled routes: the org's override chain when it set one (which the
  // gateway routes exactly, for org-owned models), otherwise every route in
  // default-chain order. Anything not enabled is a route the org turned off:
  // absent from the override chain, which is exactly how the toggle persists it
  // (no parallel store — the waterfall override is the one org-scoped mechanism).
  const serverEnabled = useMemo(() => {
    if (override !== null) {
      const inChain = override
        .map((rung) => rung.model_provider_id)
        .filter((id) => usable.some((d) => d.id === id));
      return inChain;
    }
    return orderedIds(usable, defaultChain);
  }, [usable, override, defaultChain]);
  const order = draft ?? serverEnabled;
  const enabledSet = useMemo(() => new Set(order), [order]);
  // The routes the org turned off, kept in their catalog order so a toggled-off
  // row stays put in the list instead of jumping around.
  const disabled = useMemo(
    () => usable.filter((d) => !enabledSet.has(d.id)),
    [usable, enabledSet]
  );
  const byId = useMemo(
    () => new Map(usable.map((d) => [d.id, d])),
    [usable]
  );

  // Settle the optimistic draft only once the server re-read reports the same
  // order. Clearing it any earlier (e.g. right after the PUT resolves, before
  // the waterfall re-read lands) briefly falls back to the stale server order
  // and the row snaps back on, then off again — the flicker the product owner saw. Holding
  // the draft until serverEnabled agrees makes the toggle land once and stay.
  useEffect(() => {
    if (draft !== null && sameOrder(draft, serverEnabled)) {
      setDraft(null);
    }
  }, [draft, serverEnabled]);

  const persist = (next: string[]) => {
    setDraft(next);
    setError(null);
    gate(() => {
      // Tag this save; a rapid second reorder starts a newer one. If an earlier
      // save resolves after a later one, the guard below drops the stale
      // completion instead of reverting the draft to a now-wrong order.
      const seq = (saveSeq.current += 1);
      void (async () => {
        if (orgId === null) {
          return;
        }
        // Persist the COMPLETE chain: hidden enabled lanes stay at their
        // original positions among the reordered visible lanes. Saving only
        // the visible slice would drop them from the override; appending them
        // would silently demote their fallback position for when the key
        // comes back.
        const failure = await saveModelPriority(modelSlug, orgId, withHiddenLanes(next));
        if (seq !== saveSeq.current) {
          return;
        }
        if (failure !== null) {
          setError(failure.error);
          setDraft(null);
        }
        // On success the draft is left in place; the effect above drops it once
        // the refreshed waterfall read reflects this exact order.
      })();
    });
    if (orgId === null) {
      setDraft(null);
    }
  };

  const onDrop = (targetId: string) => {
    if (dragId === null || dragId === targetId) {
      setDragId(null);
      return;
    }
    const next = [...order];
    const from = next.indexOf(dragId);
    const to = next.indexOf(targetId);
    if (from === -1 || to === -1) {
      setDragId(null);
      return;
    }
    next.splice(from, 1);
    next.splice(to, 0, dragId);
    setDragId(null);
    persist(next);
  };

  // Turn a route on (append it to the enabled chain) or off (drop it). Never
  // turn off the last enabled route — a model with no route can't be served.
  const toggle = (id: string) => {
    if (enabledSet.has(id)) {
      if (order.length <= 1) {
        setError("Keep at least one route on. Turn another on first.");
        return;
      }
      persist(order.filter((current) => current !== id));
      return;
    }
    persist([...order, id]);
  };

  return (
    <section className="flex min-h-0 flex-col gap-3" data-testid="ways-to-use">
      <div className="flex items-center gap-1.5">
        <p className="mono-label m-0">Waterfall</p>
        <span
          aria-label="About the waterfall"
          className="inline-flex cursor-help text-muted-2"
          title={
            "Usable routes in the order the gateway tries them. Drag to reorder your " +
            "organization's fallback chain; turn a route off to drop it. Routes that need a " +
            "provider key appear once the key is connected." +
            (override !== null ? " Your organization has a custom order." : "")
          }
        >
          <Info aria-hidden size={13} strokeWidth={1.8} />
        </span>
      </div>

      {detail === null && detailRead.error !== null ? (
        <p className="m-0 text-[13px] text-danger">{detailRead.error}</p>
      ) : detail === null ? (
        <div className="flex flex-col gap-2" data-testid="ways-to-use-loading">
          <Shimmer className="h-11 w-full" />
          <Shimmer className="h-11 w-2/3" />
        </div>
      ) : usable.length === 0 ? (
        <p className="m-0 rounded-lg border border-line bg-surface px-4 py-6 text-[13px] text-muted-2">
          No usable route yet. Experiential hosted routes appear automatically; connect a
          provider key below to use this model.
        </p>
      ) : (
        <ol
          className="m-0 flex list-none flex-col gap-2 p-0"
          data-testid="ways-to-use-rows"
        >
          {order.map((id, index) => {
            const deployment = byId.get(id);
            if (deployment === undefined) {
              return null;
            }
            return (
              <WayRow
                canDisable={order.length > 1}
                connection={connByProvider.get(deployment.provider) ?? null}
                deployment={deployment}
                dragging={dragId === deployment.id}
                enabled
                key={deployment.id}
                modelSlug={modelSlug}
                onDragEnd={() => setDragId(null)}
                onDragStart={() => setDragId(deployment.id)}
                onDrop={() => onDrop(deployment.id)}
                onToggle={() => toggle(deployment.id)}
                position={index + 1}
                reorderable={order.length > 1}
              />
            );
          })}
          {disabled.map((deployment) => (
            <WayRow
              canDisable
              connection={connByProvider.get(deployment.provider) ?? null}
              deployment={deployment}
              dragging={false}
              enabled={false}
              key={deployment.id}
              modelSlug={modelSlug}
              onDragEnd={() => {}}
              onDragStart={() => {}}
              onDrop={() => {}}
              onToggle={() => toggle(deployment.id)}
              position={null}
              reorderable={false}
            />
          ))}
        </ol>
      )}

      {disabled.length > 0 ? (
        <p className="m-0 max-w-[780px] text-[12px] leading-relaxed text-muted">
          {isOrgOwned
            ? "Routes turned off are not used to serve this model for your organization."
            : "Turning a route off hides it from your organization's view here. Routing for this shared model isn't changed by it yet."}
        </p>
      ) : null}

      {error !== null ? <p className="m-0 text-[13px] text-danger">{error}</p> : null}
      {waterfallRead.error !== null && waterfallRead.data === null && orgId !== null ? (
        <p className="m-0 text-[13px] text-danger">{waterfallRead.error}</p>
      ) : null}

      <div className="flex flex-col gap-3">
        {addMode === null ? (
          <div>
            <Button onClick={() => setAddMode("choose")} size="sm" type="button">
              <Plus aria-hidden size={13} strokeWidth={1.8} />
              Add a way
            </Button>
          </div>
        ) : (
          <div
            className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-[18px]"
            data-testid="add-a-way-panel"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="mono-label m-0">
                {addMode === "choose"
                  ? "Add a way"
                  : addMode === "key"
                    ? "Add an API key"
                    : "Add a local model"}
              </p>
              {addMode === "choose" ? (
                <Button onClick={() => setAddMode(null)} size="sm" type="button" variant="ghost">
                  Done
                </Button>
              ) : (
                <Button onClick={() => setAddMode("choose")} size="sm" type="button" variant="ghost">
                  <ArrowLeft aria-hidden size={13} strokeWidth={1.8} />
                  Back
                </Button>
              )}
            </div>

            {addMode === "choose" ? (
              <div
                className={clsx("grid gap-3", selfHostable && "sm:grid-cols-2")}
                data-testid="add-a-way-chooser"
              >
                <AddChoice
                  description="Serve this model on your own provider account. Pick a provider and paste the credentials it needs."
                  icon={KeyRound}
                  onClick={() => setAddMode("key")}
                  title="Add an API key"
                />
                {selfHostable ? (
                  <AddChoice
                    description="Point at an OpenAI-compatible endpoint your organization runs, like a self-hosted vLLM box."
                    icon={Server}
                    onClick={() => setAddMode("local")}
                    title="Add a local model"
                  />
                ) : null}
              </div>
            ) : addMode === "key" ? (
              <>
                <p className="m-0 max-w-[780px] text-[13px] leading-relaxed text-muted">
                  Serve this model on your own provider account. Pick a provider below and paste the
                  credentials it needs; it becomes a new row above.
                </p>
                <UseViaKeyCard
                  apiBaseUrl={apiBaseUrl}
                  canManage={canManage}
                  chrome={false}
                  modelSlug={modelSlug}
                  orgId={orgId}
                  showPriority={false}
                  webBaseUrl={webBaseUrl}
                />
              </>
            ) : (
              <>
                <p className="m-0 max-w-[780px] text-[13px] leading-relaxed text-muted">
                  Register an OpenAI-compatible endpoint your organization runs. It becomes a model
                  private to your org (its own catalog entry, callable through the gateway), not a
                  route on this public model.
                </p>
                <LocalVariantForm
                  defaultOpen
                  displayName={detail?.model.display_name ?? modelSlug}
                  orgId={orgId}
                  slug={modelSlug}
                />
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

type AddChoiceProps = {
  title: string;
  description: string;
  icon: typeof Server;
  onClick: () => void;
};

/** One card in the "Add a way" chooser: a titled, described route to an add form. */
function AddChoice({ title, description, icon: Icon, onClick }: AddChoiceProps) {
  return (
    <button
      className="flex flex-col gap-2 rounded-lg border border-line bg-surface-subtle/60 p-4 text-left transition-colors hover:border-line-strong"
      onClick={onClick}
      type="button"
    >
      <span className="flex items-center gap-2 text-[13px] font-semibold text-ink">
        <span
          aria-hidden
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-line bg-foreground/[0.03] text-foreground/60"
        >
          <Icon aria-hidden size={15} strokeWidth={1.8} />
        </span>
        {title}
      </span>
      <span className="text-[12.5px] leading-relaxed text-muted">{description}</span>
    </button>
  );
}

type WayRowProps = {
  deployment: CatalogDeployment;
  connection: ProviderConnectionSummary | null;
  modelSlug: string;
  /** Chain position (1-based) for an enabled route; null for an off route. */
  position: number | null;
  /** Whether this route is on (in the chain) or off. */
  enabled: boolean;
  reorderable: boolean;
  dragging: boolean;
  /** Whether the toggle may turn this route off (never the last enabled one). */
  canDisable: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
  onToggle: () => void;
};

/**
 * One route row: drag handle, the serving provider's own logo, the way it is
 * reached (Experiential credits / your key / your local endpoint), this route's
 * pricing and measured stats, and a "Use" toggle. An off route stays in place,
 * greyed, with its toggle off — it is never exiled to a separate list.
 */
function WayRow({
  deployment,
  connection,
  modelSlug,
  position,
  enabled,
  reorderable,
  dragging,
  canDisable,
  onDragStart,
  onDragEnd,
  onDrop,
  onToggle
}: WayRowProps) {
  const way = describeWay(deployment, connection, modelSlug);
  return (
    <li
      className={clsx(
        "flex items-center gap-3 rounded-lg border bg-surface px-3 py-2.5 transition-colors",
        dragging ? "border-accent/50 opacity-60" : "border-line",
        !enabled && "opacity-60"
      )}
      draggable={reorderable}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        if (reorderable) {
          event.preventDefault();
        }
      }}
      onDragStart={onDragStart}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
    >
      {reorderable ? (
        <span
          aria-label="Drag to reorder"
          className="shrink-0 cursor-grab text-muted-2 active:cursor-grabbing"
        >
          <GripVertical aria-hidden size={15} strokeWidth={1.8} />
        </span>
      ) : null}
      <span className="w-4 shrink-0 text-right font-mono text-[11px] text-ink-faint">
        {position ?? ""}
      </span>
      <span
        aria-hidden
        className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-line bg-foreground/[0.03] text-foreground/60"
      >
        <ProviderLogo provider={deployment.provider} size={15} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-ink">
          <span className="truncate">{way.title}</span>
          {way.tag !== null ? (
            <span
              className={clsx(
                "inline-flex shrink-0 items-center rounded-full px-2 py-px font-mono text-[9.5px] uppercase tracking-wide",
                way.tagTone
              )}
            >
              {way.tag}
            </span>
          ) : null}
        </span>
        <span className="truncate font-mono text-[11px] text-muted-2">
          {way.subtitle}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-4">
        <span className="hidden sm:inline">
        <Price
          estimated={isEstimatedPricing(deployment)}
          input={deployment.input_micro_usd_per_million}
          output={deployment.output_micro_usd_per_million}
        />
        </span>
        <span
          className="hidden w-16 text-right font-mono text-[11px] text-ink-soft md:inline"
          title={statsSourceLabel(deployment) ?? "30-day uptime"}
        >
          {formatUptime(deployment.uptime_30d)}
        </span>
        <span
          className="hidden w-20 text-right font-mono text-[11px] text-ink-soft lg:inline"
          title={statsSourceLabel(deployment) ?? "Throughput (tokens per second)"}
        >
          {formatThroughput(deployment.throughput_tps)}
        </span>
        <UseToggle
          canDisable={canDisable}
          enabled={enabled}
          onToggle={onToggle}
          provider={deployment.provider}
        />
      </span>
    </li>
  );
}

type UseToggleProps = {
  enabled: boolean;
  /** When off and enabled, the toggle is disabled: it is the last route on. */
  canDisable: boolean;
  provider: string;
  onToggle: () => void;
};

/**
 * The per-route on/off switch, framed as "Use": on means this route serves the
 * model (it is in the org's chain), off means it does not. The last enabled
 * route can't be turned off, so its switch is disabled rather than removed.
 */
function UseToggle({ enabled, canDisable, provider, onToggle }: UseToggleProps) {
  const label = providerLabel(provider);
  const locked = enabled && !canDisable;
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span
        aria-hidden
        className={clsx(
          "font-mono text-[10px] uppercase tracking-wide transition-colors",
          enabled ? "text-accent" : "text-muted-2"
        )}
      >
        Use
      </span>
      <button
        aria-checked={enabled}
        aria-label={
          enabled
            ? locked
              ? `${label} is the only route on and can't be turned off`
              : `Turn ${label} off`
            : `Turn ${label} on`
        }
        className={clsx(
          "relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border transition-colors",
          enabled
            ? "border-accent/40 bg-accent"
            : "border-line-strong bg-surface-subtle",
          locked ? "cursor-not-allowed opacity-60" : "cursor-pointer"
        )}
        disabled={locked}
        onClick={onToggle}
        role="switch"
        title={
          locked
            ? "The last route on can't be turned off"
            : enabled
              ? "Serving through this route. Turn off to drop it."
              : "Not serving through this route. Turn on to use it."
        }
        type="button"
      >
        <span
          aria-hidden
          className={clsx(
            "inline-block h-[13px] w-[13px] rounded-full bg-white shadow-sm transition-transform",
            enabled ? "translate-x-[15px]" : "translate-x-[2px]"
          )}
        />
      </button>
    </span>
  );
}

type WayDescription = {
  title: string;
  subtitle: string;
  tag: string | null;
  tagTone: string;
};

/** The plain-words "how you reach it" for one route. */
function describeWay(
  deployment: CatalogDeployment,
  connection: ProviderConnectionSummary | null,
  modelSlug: string
): WayDescription {
  const provider = providerLabel(deployment.provider);
  if (deployment.provider === "experiential_cloud") {
    return {
      title: provider,
      subtitle: EXPERIENTIAL_CLOUD_DESCRIPTION,
      tag: "uses credits",
      tagTone: "bg-accent-soft text-accent"
    };
  }
  // Serving truth: "Through Experiential — uses credits" ONLY for an active,
  // public, host-managed route. A PUBLIC customer_managed row (owning_org_id
  // null but billed BYOK) falls through to the "your key" branch below — it is
  // listed for everyone but the platform does not fund it.
  if (isHostServed(deployment)) {
    return {
      title: "Through Experiential",
      subtitle: `${provider} · ${deployment.provider_model_id}`,
      tag: "uses credits",
      tagTone: "bg-accent-soft text-accent"
    };
  }
  if (deployment.provider === "local") {
    return {
      title: "Your local endpoint",
      subtitle: deployment.base_url ?? deployment.provider_model_id,
      tag: "self-hosted",
      tagTone: "bg-purple-soft text-purple"
    };
  }
  const last4 = connection?.connected ? connection.credential_last4 : null;
  // Azure keys can be valid yet have no deployment for this model. Read the
  // verdict keys-P7's card already persisted (no extra probe) so the row shows
  // the canonical "not deployed" state up front, not only inside "+ Add a way".
  if (deployment.provider === "azure_openai" && connection?.connected) {
    const fact = modelDeploymentFact(connection.status_detail, modelSlug);
    if (fact !== null && !fact.deployed) {
      return {
        title: `${provider} · your key`,
        subtitle: "This model isn't deployed on your Azure resource.",
        tag: "not deployed",
        tagTone: "bg-warning-soft text-warning"
      };
    }
  }
  return {
    title: `${provider} · your key`,
    subtitle:
      last4 !== null
        ? `····${last4} · ${deployment.provider_model_id}`
        : deployment.provider_model_id,
    tag: connection?.connected ? "connected" : "your key",
    tagTone: "bg-surface-subtle text-ink-soft"
  };
}

/**
 * This route's token prices. Both numbers are USD per million tokens; the "/M
 * in" and "/M out" units and the tooltip make it explicit which is which (the
 * bare numbers alone read ambiguously).
 */
function Price({
  input,
  output,
  estimated
}: {
  input: number | null;
  output: number | null;
  estimated: boolean;
}) {
  return (
    <span
      className="text-right font-mono text-[11px] text-ink-soft"
      title={
        estimated
          ? "Estimated price in USD per million tokens (input / output), not yet measured"
          : "Price in USD per million tokens: input / output"
      }
    >
      <span className="text-ink">{formatPerMillionUsd(input)}</span>
      <span className="text-muted-2"> /M in</span>
      <span className="mx-1 text-line-strong">·</span>
      <span className="text-ink">{formatPerMillionUsd(output)}</span>
      <span className="text-muted-2"> /M out</span>
      {estimated ? <span className="ml-1 text-muted-2" title="estimated">≈</span> : null}
    </span>
  );
}
