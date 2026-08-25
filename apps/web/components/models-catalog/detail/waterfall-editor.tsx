"use client";

// The model's fallback waterfall: the ordered provider chain the gateway
// walks when a route fails. Everyone sees the effective chain (the org's
// override when one exists, else the default); editing is an org action —
// signed-out visitors get the login modal, members reorder/substitute rungs
// and save the org override through PUT /api/models/{slug}/waterfall.

import { useState } from "react";
import { ArrowDown, ArrowUp, Pencil, X } from "lucide-react";

import { ProviderBadge, StatusDot } from "@/components/models-catalog/badges";
import { useLoginModal } from "@/components/auth/login-modal-context";
import { Button } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Dropdown";
import { providerLabel } from "@/lib/models-catalog/format";
import type { CatalogDeployment, Waterfall, WaterfallRung } from "@/lib/models-catalog/types";

type WaterfallEditorProps = {
  slug: string;
  /** Null renders the signed-out state: chain visible, editing gated. */
  orgId: string | null;
  /** Every route the viewer could chain (the detail page's providers). */
  providers: CatalogDeployment[];
  defaultChain: WaterfallRung[];
  /** The org's saved override, when the server found one. */
  initialOverride: WaterfallRung[] | null;
};

export function WaterfallEditor({
  slug,
  orgId,
  providers,
  defaultChain,
  initialOverride
}: WaterfallEditorProps) {
  const { open, requireAuth } = useLoginModal();
  const [override, setOverride] = useState<WaterfallRung[] | null>(initialOverride);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effective = override ?? defaultChain;
  const byId = new Map(providers.map((row) => [row.id, row]));

  const startEditing = () =>
    requireAuth(() => {
      setError(null);
      setDraft(effective.map((rung) => rung.model_provider_id));
    });

  const save = async (ids: string[]) => {
    if (orgId === null) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/models/${encodeURIComponent(slug)}/waterfall`, {
        body: JSON.stringify({ model_provider_ids: ids, org_id: orgId }),
        headers: { "content-type": "application/json" },
        method: "PUT"
      });
      const payload = (await response.json()) as Waterfall & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? `Saving the waterfall failed (HTTP ${response.status})`);
      }
      setOverride(payload.override);
      setDraft(null);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Saving the waterfall failed.");
    } finally {
      setSaving(false);
    }
  };

  const move = (index: number, delta: -1 | 1) => {
    setDraft((current) => {
      if (current === null) {
        return current;
      }
      const target = index + delta;
      if (target < 0 || target >= current.length) {
        return current;
      }
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const addable = providers.filter((row) => draft !== null && !draft.includes(row.id));

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-[18px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <p className="mono-label m-0">Fallback waterfall</p>
          {override !== null ? (
            <span className="inline-flex items-center rounded-full bg-accent-soft px-2 py-px font-mono text-[10px] uppercase tracking-wide text-accent">
              org override
            </span>
          ) : null}
        </div>
        {draft === null ? (
          orgId === null ? (
            <Button onClick={open} size="sm" type="button">
              Sign in to customize
            </Button>
          ) : (
            <Button onClick={startEditing} size="sm" type="button">
              <Pencil aria-hidden size={12} strokeWidth={1.8} />
              Customize
            </Button>
          )
        ) : null}
      </div>
      <p className="m-0 max-w-[780px] text-[13px] leading-relaxed text-muted">
        When a route fails or is unavailable, the gateway falls through this chain in order.
        {orgId === null
          ? " Sign in to set your organization's own order."
          : override === null
            ? " Your organization currently follows the default chain."
            : " Your organization's override applies to your requests only."}
      </p>

      {draft === null ? (
        <ol className="m-0 flex list-none flex-col p-0" data-testid="waterfall-chain">
          {effective.length === 0 ? (
            <li className="py-2 text-[13px] text-muted-2">
              No chain yet, the model&apos;s routes are tried in catalog order.
            </li>
          ) : (
            effective.map((rung, index) => (
              <li
                className="flex items-center gap-3 border-b border-line py-2 last:border-b-0"
                key={rung.id}
              >
                <span className="w-5 shrink-0 text-right font-mono text-[11px] text-ink-faint">
                  {index + 1}
                </span>
                <ProviderBadge provider={rung.provider} />
                <span className="min-w-0 truncate font-mono text-[11.5px] text-ink-soft">
                  {rung.provider_model_id}
                </span>
                <span className="ml-auto">
                  <StatusDot status={rung.status} />
                </span>
              </li>
            ))
          )}
        </ol>
      ) : (
        <div className="flex flex-col gap-3" data-testid="waterfall-editor">
          <ol className="m-0 flex list-none flex-col p-0">
            {draft.map((id, index) => {
              const deployment = byId.get(id);
              return (
                <li
                  className="flex items-center gap-3 border-b border-line py-1.5 last:border-b-0"
                  key={id}
                >
                  <span className="w-5 shrink-0 text-right font-mono text-[11px] text-ink-faint">
                    {index + 1}
                  </span>
                  {deployment ? (
                    <>
                      <ProviderBadge provider={deployment.provider} />
                      <span className="min-w-0 truncate font-mono text-[11.5px] text-ink-soft">
                        {deployment.provider_model_id}
                      </span>
                    </>
                  ) : (
                    <span className="font-mono text-[11.5px] text-muted-2">{id}</span>
                  )}
                  <span className="ml-auto inline-flex items-center gap-1">
                    <button
                      aria-label={`Move rung ${index + 1} up`}
                      className="cursor-pointer rounded-sm p-1 text-muted transition-colors hover:bg-surface-subtle hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                      type="button"
                    >
                      <ArrowUp size={13} strokeWidth={1.8} />
                    </button>
                    <button
                      aria-label={`Move rung ${index + 1} down`}
                      className="cursor-pointer rounded-sm p-1 text-muted transition-colors hover:bg-surface-subtle hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                      disabled={index === draft.length - 1}
                      onClick={() => move(index, 1)}
                      type="button"
                    >
                      <ArrowDown size={13} strokeWidth={1.8} />
                    </button>
                    <button
                      aria-label={`Remove rung ${index + 1}`}
                      className="cursor-pointer rounded-sm p-1 text-muted transition-colors hover:bg-surface-subtle hover:text-danger"
                      onClick={() =>
                        setDraft((current) =>
                          current === null ? current : current.filter((entry) => entry !== id)
                        )
                      }
                      type="button"
                    >
                      <X size={13} strokeWidth={1.8} />
                    </button>
                  </span>
                </li>
              );
            })}
          </ol>
          {addable.length > 0 ? (
            <label className="flex items-center gap-2 text-[12.5px] text-muted">
              Add route
              <Dropdown
                aria-label="Add a route to the chain"
                onChange={(event) => {
                  const value = event.target.value;
                  if (value !== "") {
                    setDraft((current) => (current === null ? current : [...current, value]));
                    event.target.value = "";
                  }
                }}
                value=""
              >
                <option value="">Pick a provider route…</option>
                {addable.map((row) => (
                  <option key={row.id} value={row.id}>
                    {providerLabel(row.provider)} · {row.provider_model_id}
                  </option>
                ))}
              </Dropdown>
            </label>
          ) : null}
          {error !== null ? <p className="m-0 text-[12.5px] text-danger">{error}</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={draft.length === 0}
              loading={saving}
              onClick={() => save(draft)}
              size="sm"
              type="button"
              variant="primary"
            >
              Save override
            </Button>
            <Button
              disabled={saving}
              onClick={() => setDraft(null)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            {override !== null ? (
              <Button
                disabled={saving}
                onClick={() => save([])}
                size="sm"
                type="button"
                variant="ghost"
              >
                Reset to default
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
