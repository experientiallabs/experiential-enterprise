"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorTile } from "@/components/ui/ErrorTile";
import { LocalDateTime } from "@/components/ui/LocalDateTime";
import { Shimmer } from "@/components/ui/Shimmer";
import { readApiError } from "@/components/world-models/wm-client";
import type {
  ProviderDataControls,
  ProviderDataControlsList,
  ProviderPolicy,
  ProviderPolicyState
} from "@/lib/data-controls";

type ProviderPolicyPanelProps = {
  orgId: string;
  /** Admins manage; members read the same panel without the controls. */
  canManage: boolean;
};

/** The edit-state mirror of the policy document (null policy = defaults). */
type Draft = {
  /** null = all providers allowed; otherwise the checked provider set. */
  allowed: string[] | null;
  requireZdr: boolean;
  requireNoTraining: boolean;
};

const DEFAULT_DRAFT: Draft = { allowed: null, requireZdr: false, requireNoTraining: false };

function draftFrom(policy: ProviderPolicy | null): Draft {
  if (policy === null) {
    return DEFAULT_DRAFT;
  }
  return {
    allowed: policy.allowed_providers === null ? null : [...policy.allowed_providers].sort(),
    requireZdr: policy.require_zdr,
    requireNoTraining: policy.require_no_training
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  const sameAllowed =
    a.allowed === null || b.allowed === null
      ? a.allowed === b.allowed
      : a.allowed.length === b.allowed.length &&
        a.allowed.every((provider, index) => provider === b.allowed?.[index]);
  return (
    sameAllowed && a.requireZdr === b.requireZdr && a.requireNoTraining === b.requireNoTraining
  );
}

/** A quiet yes/no posture badge: green only when the guarantee holds. */
function PostureBadge({ held, label, missingLabel }: { held: boolean; label: string; missingLabel: string }) {
  return (
    <span
      className={
        held
          ? "inline-flex items-center rounded-full bg-success-soft px-[9px] py-[3px] font-mono text-[11px] font-semibold uppercase text-success"
          : "inline-flex items-center rounded-full bg-surface-subtle px-[9px] py-[3px] font-mono text-[11px] font-semibold uppercase text-muted-2"
      }
    >
      {held ? label : missingLabel}
    </span>
  );
}

/**
 * Provider data controls (docs/enterprise.md E5.3): the curated posture
 * matrix plus the org's allowlist / require-ZDR / require-no-training policy.
 * Management is DATA_CONTROLS-gated server-side; enforcement of a saved
 * policy is always-on in the gateway worker.
 */
export function ProviderPolicyPanel({ orgId, canManage }: ProviderPolicyPanelProps) {
  const [matrix, setMatrix] = useState<ProviderDataControls[] | null>(null);
  const [policy, setPolicy] = useState<ProviderPolicy | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  const [draft, setDraft] = useState<Draft>(DEFAULT_DRAFT);
  const [saved, setSaved] = useState<Draft>(DEFAULT_DRAFT);
  const [hasPolicy, setHasPolicy] = useState(false);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const applyPolicy = useCallback((state: ProviderPolicyState) => {
    const next = draftFrom(state.policy);
    setPolicy(state.policy);
    setHasPolicy(state.policy !== null);
    setSaved(next);
    setDraft(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const [matrixResponse, policyResponse] = await Promise.all([
          fetch(`/api/orgs/${encodeURIComponent(orgId)}/provider-data-controls`),
          fetch(`/api/orgs/${encodeURIComponent(orgId)}/provider-policy`)
        ]);
        if (!matrixResponse.ok) {
          throw new Error(
            await readApiError(matrixResponse, "Could not load the provider posture matrix.")
          );
        }
        if (!policyResponse.ok) {
          throw new Error(
            await readApiError(policyResponse, "Could not load the provider policy.")
          );
        }
        const matrixPayload = (await matrixResponse.json()) as ProviderDataControlsList;
        const policyPayload = (await policyResponse.json()) as ProviderPolicyState;
        if (!cancelled) {
          setMatrix(matrixPayload.providers);
          applyPolicy(policyPayload);
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(
            error instanceof Error ? error.message : "Could not load provider data controls."
          );
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, retryToken, applyPolicy]);

  const dirty = useMemo(() => !sameDraft(draft, saved), [draft, saved]);
  // A policy that names no provider would refuse every request; the backend
  // refuses it too, but the save bar should never offer it.
  const emptyAllowlist = draft.allowed !== null && draft.allowed.length === 0;

  function toggleAllProviders(allowAll: boolean): void {
    setDraft((current) => ({
      ...current,
      // Switching to a custom list starts from everything checked, so
      // unchecking is the gesture (an empty start would read as "none").
      allowed: allowAll ? null : (matrix ?? []).map((row) => row.provider)
    }));
  }

  function toggleProvider(provider: string, checked: boolean): void {
    setDraft((current) => {
      const base = current.allowed ?? (matrix ?? []).map((row) => row.provider);
      const next = checked
        ? [...new Set([...base, provider])].sort()
        : base.filter((entry) => entry !== provider);
      return { ...current, allowed: next };
    });
  }

  async function save(): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/provider-policy`, {
        body: JSON.stringify({
          allowed_providers: draft.allowed,
          require_zdr: draft.requireZdr,
          require_no_training: draft.requireNoTraining
        }),
        headers: { "content-type": "application/json" },
        method: "PUT"
      });
      if (!response.ok) {
        throw new Error(await readApiError(response, "Could not save the provider policy."));
      }
      applyPolicy((await response.json()) as ProviderPolicyState);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not save the provider policy.");
    } finally {
      setBusy(false);
    }
  }

  async function removePolicy(): Promise<void> {
    setBusy(true);
    setRemoveError(null);
    try {
      const response = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/provider-policy`, {
        method: "DELETE"
      });
      if (!response.ok) {
        throw new Error(await readApiError(response, "Could not remove the provider policy."));
      }
      setRemoveOpen(false);
      applyPolicy({ org_id: orgId, policy: null });
    } catch (error) {
      setRemoveError(
        error instanceof Error ? error.message : "Could not remove the provider policy."
      );
    } finally {
      setBusy(false);
    }
  }

  if (matrix === null && loadError !== null && !isLoading) {
    return (
      <ErrorTile
        title="Couldn't load provider data controls"
        message={loadError}
        onRetry={() => setRetryToken((token) => token + 1)}
      />
    );
  }

  if (isLoading && matrix === null) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-[18px]">
        <Shimmer className="h-4 w-full" />
        <Shimmer className="h-4 w-full" />
        <Shimmer className="h-4 w-2/3" />
      </div>
    );
  }

  const providers = matrix ?? [];
  const allowAll = draft.allowed === null;
  const checkedSet = new Set(draft.allowed ?? providers.map((row) => row.provider));

  return (
    <div className="flex flex-col gap-4">
      {actionError !== null ? (
        <p className="m-0 rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-danger text-[13px]">
          {actionError}
        </p>
      ) : null}

      <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-[18px]">
        <span className="mono-label">Requirements</span>
        <label className="flex items-start gap-2 text-[13px] text-ink">
          <input
            aria-label="Require zero-data-retention providers"
            checked={draft.requireZdr}
            className="mt-[2px]"
            disabled={!canManage || busy}
            onChange={(event) =>
              setDraft((current) => ({ ...current, requireZdr: event.target.checked }))
            }
            type="checkbox"
          />
          <span>
            Require zero data retention
            <span className="block text-[12px] text-muted">
              Routing will only use providers marked zero-data-retention; routes without an
              eligible provider will refuse requests.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-[13px] text-ink">
          <input
            aria-label="Require no-training providers"
            checked={draft.requireNoTraining}
            className="mt-[2px]"
            disabled={!canManage || busy}
            onChange={(event) =>
              setDraft((current) => ({ ...current, requireNoTraining: event.target.checked }))
            }
            type="checkbox"
          />
          <span>
            Require a no-training posture
            <span className="block text-[12px] text-muted">
              Routing will only use providers that do not train on API data by default; routes
              without an eligible provider will refuse requests.
            </span>
          </span>
        </label>
        {!canManage ? (
          <p className="m-0 text-[12px] text-muted-2">
            Only an organization admin can change this policy.
          </p>
        ) : null}
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-[18px]">
        <span className="mono-label">Allowed providers</span>
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input
            aria-label="Allow all providers"
            checked={allowAll}
            disabled={!canManage || busy}
            onChange={(event) => toggleAllProviders(event.target.checked)}
            type="checkbox"
          />
          All providers
          <span className="text-[12px] text-muted">
            (uncheck to pick an explicit allowlist)
          </span>
        </label>
        <ul className="m-0 flex list-none flex-col p-0">
          {providers.map((row) => (
            <li
              className="flex flex-wrap items-start gap-x-3 gap-y-1 border-t border-line/60 py-3 first:border-t-0"
              key={row.provider}
            >
              <label className="flex min-w-[180px] items-center gap-2 text-[13px] text-ink">
                <input
                  aria-label={`Allow ${row.provider}`}
                  checked={allowAll || checkedSet.has(row.provider)}
                  disabled={!canManage || busy || allowAll}
                  onChange={(event) => toggleProvider(row.provider, event.target.checked)}
                  type="checkbox"
                />
                <span className="font-mono text-[12px]">{row.provider}</span>
              </label>
              <span className="flex items-center gap-2">
                <PostureBadge
                  held={row.zero_data_retention}
                  label="Zero retention"
                  missingLabel="May retain"
                />
                <PostureBadge held={row.no_training} label="No training" missingLabel="May train" />
              </span>
              <span className="w-full text-[12px] leading-relaxed text-muted-2">
                {row.source_note}
              </span>
            </li>
          ))}
        </ul>
        <p className="m-0 text-[12px] text-muted-2">
          Posture flags are platform-curated from each provider&apos;s documented API defaults,
          never customer-specific agreements. A provider without a posture row fails every
          requirement.
        </p>
      </section>

      {canManage ? (
        <div className="flex flex-col gap-3">
          <p className="m-0 rounded-md border border-warning/20 bg-warning-soft px-3 py-2 text-[13px] text-warning">
            Tightening this policy applies to live traffic within moments of saving: models whose
            providers no longer qualify stop serving requests immediately.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={busy || !dirty || emptyAllowlist} onClick={() => void save()} size="sm">
              {busy ? "Saving…" : "Save policy"}
            </Button>
            {dirty ? (
              <Button disabled={busy} onClick={() => setDraft(saved)} size="sm" variant="ghost">
                Discard changes
              </Button>
            ) : null}
            {hasPolicy ? (
              <Button
                disabled={busy}
                onClick={() => {
                  setRemoveError(null);
                  setRemoveOpen(true);
                }}
                size="sm"
                variant="destructive"
              >
                Remove policy
              </Button>
            ) : null}
            {emptyAllowlist ? (
              <span className="text-[12px] text-danger">
                An empty allowlist would refuse every request; allow at least one provider.
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        body={
          <>
            Removing the policy lifts every data-control restriction: all providers become
            eligible again and no retention or training posture is required.
          </>
        }
        busy={busy}
        busyLabel="Removing…"
        confirmLabel="Remove policy"
        confirmVariant="destructive"
        error={removeError}
        onCancel={() => {
          if (!busy) {
            setRemoveOpen(false);
          }
        }}
        onConfirm={() => void removePolicy()}
        open={removeOpen}
        title="Remove provider policy"
        tone="danger"
      />
      {policy !== null ? (
        <p className="m-0 text-[12px] text-muted-2">
          Policy last updated <LocalDateTime value={policy.updated_at} withYear />.
        </p>
      ) : null}
    </div>
  );
}
