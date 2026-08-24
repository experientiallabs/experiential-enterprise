"use client";

import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ErrorTile } from "@/components/ui/ErrorTile";
import { readApiError } from "@/components/world-models/wm-client";
import { formatCostUsd } from "@/lib/money";
import type { CreditGatingSettings, SpendUnlockRequirement } from "@/lib/types";

const BASE = "/api/admin/settings";

type State =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; settings: CreditGatingSettings };

/** PUT one setting and return the refreshed consolidated view, or throw. */
async function putSetting(path: string, body: unknown): Promise<CreditGatingSettings> {
  const response = await fetch(`${BASE}/${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "PUT"
  });
  if (!response.ok) {
    throw new Error(await readApiError(response, "Unable to save."));
  }
  return (await response.json()) as CreditGatingSettings;
}

/**
 * The one place platform operators see and control the credit/verification
 * gating: the welcome and YC grant amounts, how much a new user can spend before
 * proving their inbox (pre-verify allowance), and what unlocks spend (email vs.
 * credit card). All four live on app_settings and are read by the grant
 * functions, the gateway spend gate, and the web spend-unlock layer respectively.
 */
export function CreditGatingPanel() {
  const [state, setState] = useState<State>({ phase: "loading" });

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      const response = await fetch(`${BASE}/credit-gating`, { cache: "no-store" });
      if (!response.ok) {
        setState({ phase: "error", message: await readApiError(response, "Unable to load.") });
        return;
      }
      setState({ phase: "ready", settings: (await response.json()) as CreditGatingSettings });
    } catch {
      setState({ phase: "error", message: "Unable to load the credit settings." });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onSaved = useCallback((settings: CreditGatingSettings) => {
    setState({ phase: "ready", settings });
  }, []);

  if (state.phase === "error") {
    return (
      <ErrorTile
        title="Credit settings unavailable"
        message={state.message}
        onRetry={() => void load()}
      />
    );
  }
  if (state.phase === "loading") {
    return (
      <Card>
        <p className="m-0 text-[13px] text-muted">Loading the current settings…</p>
      </Card>
    );
  }

  const { settings } = state;
  return (
    <div className="flex flex-col gap-4">
      <SummaryLine settings={settings} />
      <div className="grid gap-4 lg:grid-cols-2">
        <GrantRow
          detail="Applied to every new organization at signup, then locked until spend unlocks."
          label="Welcome grant"
          microUsd={settings.welcome_grant_micro_usd}
          onSaved={onSaved}
          path="welcome-grant"
        />
        <GrantRow
          detail="One-click /yc launch grant (the $20 welcome promo folds into this total)."
          label="YC launch grant"
          microUsd={settings.yc_grant_micro_usd}
          onSaved={onSaved}
          path="yc-grant"
        />
      </div>
      <PreVerifyRow enabled={settings.pre_verify_enabled} onSaved={onSaved} />
      <SpendUnlockRow mode={settings.spend_unlock_requirement} onSaved={onSaved} />
    </div>
  );
}

function SummaryLine({ settings }: { settings: CreditGatingSettings }) {
  const welcome = formatCostUsd(settings.welcome_grant_micro_usd / 1_000_000);
  const yc = formatCostUsd(settings.yc_grant_micro_usd / 1_000_000);
  const allowance = formatCostUsd(settings.pre_verify_allowance_micro_usd / 1_000_000);
  const unlockVia =
    settings.spend_unlock_requirement === "email"
      ? "verifying their email (clicking the link or entering the code)"
      : "adding a credit card";
  return (
    <Card subtle>
      <p className="m-0 text-[13px] leading-relaxed text-ink">
        New users get <span className="font-semibold">{welcome}</span> in credits (
        <span className="font-semibold">{yc}</span> for YC companies).{" "}
        {settings.pre_verify_enabled ? (
          <>
            They can spend up to <span className="font-semibold">{allowance}</span> before proving
            their inbox;
          </>
        ) : (
          <>They must verify before spending any credit;</>
        )}{" "}
        spend unlocks by <span className="font-semibold">{unlockVia}</span>.
      </p>
    </Card>
  );
}

function GrantRow({
  label,
  detail,
  microUsd,
  path,
  onSaved
}: {
  label: string;
  detail: string;
  microUsd: number;
  path: "welcome-grant" | "yc-grant";
  onSaved: (settings: CreditGatingSettings) => void;
}) {
  const [draft, setDraft] = useState(String(microUsd / 1_000_000));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the field when the persisted value changes under it (another save).
  useEffect(() => {
    setDraft(String(microUsd / 1_000_000));
  }, [microUsd]);

  const dollars = Number(draft);
  const valid = Number.isFinite(dollars) && dollars >= 0;
  const changed = valid && Math.round(dollars * 1_000_000) !== microUsd;

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      onSaved(await putSetting(path, { micro_usd: Math.round(dollars * 1_000_000) }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save.");
    } finally {
      setSaving(false);
    }
  }, [dollars, onSaved, path]);

  return (
    <Card className="flex flex-col gap-2">
      <div>
        <h3 className="m-0 text-[13px] font-semibold text-ink">{label}</h3>
        <p className="m-0 mt-0.5 text-[12px] leading-snug text-muted">{detail}</p>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[13px] text-muted-2">$</span>
        <input
          aria-label={`${label} amount in dollars`}
          className="w-28 rounded-[var(--radius-md)] border border-line-strong bg-surface px-2 py-1 text-[13px] text-ink"
          inputMode="decimal"
          min={0}
          onChange={(event) => setDraft(event.target.value)}
          type="number"
          value={draft}
        />
        <Button
          disabled={!changed}
          loading={saving}
          onClick={() => void save()}
          size="sm"
          variant="default"
        >
          Save
        </Button>
      </div>
      {error !== null && <p className="m-0 text-[12px] text-danger">{error}</p>}
    </Card>
  );
}

function PreVerifyRow({
  enabled,
  onSaved
}: {
  enabled: boolean;
  onSaved: (settings: CreditGatingSettings) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      onSaved(await putSetting("pre-verify-allowance", { enabled: !enabled }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save.");
    } finally {
      setSaving(false);
    }
  }, [enabled, onSaved]);

  return (
    <Card className="flex flex-col gap-2">
      <div>
        <h3 className="m-0 text-[13px] font-semibold text-ink">Pre-verify spend allowance</h3>
        <p className="m-0 mt-0.5 text-[12px] leading-snug text-muted">
          {enabled ? (
            <>
              <span className="font-medium text-ink">New users can use $1 before verifying.</span>{" "}
              An unverified founder may spend up to $1 of granted credit before the gate requires
              email verification.
            </>
          ) : (
            <>
              <span className="font-medium text-ink">Full email verification required.</span> No
              credit spends until the founder proves inbox ownership.
            </>
          )}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          loading={saving}
          onClick={() => void toggle()}
          size="sm"
          variant={enabled ? "default" : "accent"}
        >
          {enabled ? "Require verification for all credits" : "Allow $1 before verifying"}
        </Button>
        <span className="text-[11px] text-muted-2" data-testid="pre-verify-state">
          Currently {enabled ? "$1 pre-verify" : "verification required"}
        </span>
      </div>
      {error !== null && <p className="m-0 text-[12px] text-danger">{error}</p>}
    </Card>
  );
}

function SpendUnlockRow({
  mode,
  onSaved
}: {
  mode: SpendUnlockRequirement;
  onSaved: (settings: CreditGatingSettings) => void;
}) {
  const [saving, setSaving] = useState<SpendUnlockRequirement | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = useCallback(
    async (next: SpendUnlockRequirement) => {
      if (next === mode) {
        return;
      }
      setSaving(next);
      setError(null);
      try {
        onSaved(await putSetting("spend-unlock-requirement", { requirement: next }));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Unable to save.");
      } finally {
        setSaving(null);
      }
    },
    [mode, onSaved]
  );

  const options: { key: SpendUnlockRequirement; label: string; detail: string }[] = [
    { key: "email", label: "Email verification", detail: "Prove inbox ownership" },
    { key: "card", label: "Credit card", detail: "Attach a saved payment method" }
  ];

  return (
    <Card className="flex flex-col gap-2">
      <div>
        <h3 className="m-0 text-[13px] font-semibold text-ink">Spend unlocks via</h3>
        <p className="m-0 mt-0.5 text-[12px] leading-snug text-muted">
          What opens the spend gate for a locked org. Only this condition changes; the gate itself
          is unchanged.
        </p>
      </div>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Spend unlock requirement">
        {options.map((option) => {
          const active = option.key === mode;
          return (
            <Button
              aria-checked={active}
              key={option.key}
              loading={saving === option.key}
              onClick={() => void choose(option.key)}
              role="radio"
              size="sm"
              variant={active ? "accent" : "default"}
            >
              {option.label}
            </Button>
          );
        })}
      </div>
      {error !== null && <p className="m-0 text-[12px] text-danger">{error}</p>}
    </Card>
  );
}
