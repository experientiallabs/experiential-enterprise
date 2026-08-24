"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

/**
 * The automatic-training spend ceiling (the product owner, 2026-07-31: a setting, not a
 * constant). Every model creation queues a training run; this is the most one
 * such run may be projected to spend before it refuses. It lives on the Usage
 * page because it is a spend control, beside the other places dollars are
 * read and governed. Null means the platform default applies.
 */
export function TrainingCapCard({
  orgId,
  canManage
}: {
  orgId: string;
  canManage: boolean;
}) {
  const [capUsd, setCapUsd] = useState<number | null>(null);
  const [defaultUsd, setDefaultUsd] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    void fetch(`/api/orgs/${encodeURIComponent(orgId)}/budget`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok || !live) {
          return;
        }
        const body = (await response.json()) as {
          training_cap_usd?: number | null;
          training_cap_default_usd?: number;
        };
        if (live) {
          setCapUsd(body.training_cap_usd ?? null);
          setDefaultUsd(body.training_cap_default_usd ?? null);
          setDraft(body.training_cap_usd != null ? String(body.training_cap_usd) : "");
          setLoaded(true);
        }
      })
      // The card degrades to its explanation; the next visit retries.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [orgId]);

  async function save(value: number | null): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/training-cap`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ training_cap_usd: value })
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "The ceiling could not be saved.");
      }
      setCapUsd(value);
      setDraft(value != null ? String(value) : "");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The ceiling could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  const effective = capUsd ?? defaultUsd;

  return (
    <Card>
      <div className="flex flex-col gap-2">
        <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-2">
          Automatic training
        </p>
        <p className="m-0 max-w-[640px] text-[12.5px] leading-relaxed text-muted">
          Creating a model queues a training run against your simulation. This is the most one
          run may be projected to spend before it refuses to start; a run whose projection fits
          is still billed only for what it measures.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[13px] text-ink" data-testid="training-cap-value">
            {effective != null ? `$${effective}` : "…"}
            {loaded && capUsd == null ? (
              <span className="text-muted"> per run (platform default)</span>
            ) : (
              <span className="text-muted"> per run</span>
            )}
          </span>
          {canManage && loaded ? (
            <span className="flex items-center gap-2">
              <input
                aria-label="Training run ceiling in dollars"
                className="w-24 rounded-md border border-line bg-surface px-2 py-1 text-[13px] text-ink"
                inputMode="decimal"
                onChange={(event) => setDraft(event.target.value)}
                placeholder={defaultUsd != null ? String(defaultUsd) : ""}
                value={draft}
              />
              <Button
                disabled={saving || draft.trim() === "" || Number.isNaN(Number(draft))}
                onClick={() => void save(Number(draft))}
                size="sm"
                type="button"
                variant="default"
              >
                Save
              </Button>
              {capUsd != null ? (
                <Button
                  disabled={saving}
                  onClick={() => void save(null)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Use default
                </Button>
              ) : null}
            </span>
          ) : null}
        </div>
        {error !== null ? <p className="m-0 text-[12px] text-danger">{error}</p> : null}
      </div>
    </Card>
  );
}
