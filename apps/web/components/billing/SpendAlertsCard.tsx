"use client";

import { useEffect, useState } from "react";

import { Shimmer } from "@/components/ui/Shimmer";
import type { CreateSpendAlertInput, SpendAlertView } from "@/lib/billing/spend-alerts";
import { RECURRING_PERIOD, currentBudgetPeriod, type BudgetView } from "@/lib/identities/types";
import { formatCostUsd } from "@/lib/money";

type SpendAlertsCardProps = {
  /** Signed-in org whose alert rules this manages. */
  orgId: string;
  /** Members read the rules; only org admins add or remove them. */
  canManage: boolean;
};

const FIELD_LABEL =
  "flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-2";
const FIELD_INPUT =
  "min-h-[34px] rounded-[var(--radius-md)] border border-line-strong bg-surface px-2.5 text-[13px] font-normal normal-case tracking-normal text-ink focus:outline-none focus:border-line-strong";

/**
 * Spend alerts on the credits page: soft email notifications beside the hard
 * budget caps. A rule emails its address at most once per UTC month, when the
 * org's monthly spend crosses a dollar threshold or a budget is consumed past
 * a percentage; rules are evaluated every 15 minutes, and the hard budgets
 * keep enforcing on their own. The current month's budgets are fetched for
 * the fraction-rule dropdown and for labeling existing fraction rules.
 */
export function SpendAlertsCard({ orgId, canManage }: SpendAlertsCardProps) {
  const [alerts, setAlerts] = useState<SpendAlertView[] | null>(null);
  const [budgets, setBudgets] = useState<BudgetView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state; the field set narrows by kind, exactly like the API body.
  const [kind, setKind] = useState<"org_monthly_spend" | "budget_fraction">("org_monthly_spend");
  const [dollars, setDollars] = useState("");
  const [budgetId, setBudgetId] = useState("");
  const [percent, setPercent] = useState("80");
  const [email, setEmail] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const period = currentBudgetPeriod();
        const [alertsResponse, budgetsResponse] = await Promise.all([
          fetch(`/api/orgs/${encodeURIComponent(orgId)}/spend-alerts`, { cache: "no-store" }),
          fetch(`/api/orgs/${encodeURIComponent(orgId)}/budgets?period=${period}`, {
            cache: "no-store"
          })
        ]);
        if (cancelled) {
          return;
        }
        if (alertsResponse.ok) {
          const payload = (await alertsResponse.json()) as { alerts?: SpendAlertView[] };
          if (!cancelled) {
            setAlerts(Array.isArray(payload.alerts) ? payload.alerts : []);
          }
        }
        if (budgetsResponse.ok) {
          const payload = (await budgetsResponse.json()) as { budgets?: BudgetView[] };
          if (!cancelled) {
            setBudgets(Array.isArray(payload.budgets) ? payload.budgets : []);
          }
        }
      } catch {
        // Transient; the card simply stays in its loading state.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  async function addRule() {
    const body: CreateSpendAlertInput =
      kind === "org_monthly_spend"
        ? {
            kind,
            threshold_micro_usd: Math.round(Number(dollars) * 1_000_000),
            notify_email: email.trim()
          }
        : {
            kind,
            budget_id: budgetId,
            threshold_fraction: Number(percent) / 100,
            notify_email: email.trim()
          };
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/spend-alerts`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST"
      });
      const payload = (await response.json().catch(() => null)) as
        | (SpendAlertView & { error?: string })
        | null;
      if (!response.ok || payload === null) {
        setError(payload?.error ?? "Unable to add the alert.");
        return;
      }
      setAlerts((current) => [...(current ?? []), payload]);
      setDollars("");
      setEmail("");
    } catch {
      setError("Unable to add the alert. Check your connection and retry.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteRule(alertId: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/spend-alerts/${encodeURIComponent(alertId)}`,
        { method: "DELETE" }
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(payload?.error ?? "Unable to remove the alert.");
        return;
      }
      setAlerts((current) => (current ?? []).filter((alert) => alert.alert_id !== alertId));
    } catch {
      setError("Unable to remove the alert. Check your connection and retry.");
    } finally {
      setBusy(false);
    }
  }

  const dollarsNumber = Number(dollars);
  const percentNumber = Number(percent);
  const emailValid = email.indexOf("@") > 0;
  const fieldsValid =
    emailValid &&
    (kind === "org_monthly_spend"
      ? Number.isFinite(dollarsNumber) && dollarsNumber > 0
      : budgetId.length > 0 && Number.isFinite(percentNumber) && percentNumber > 0 && percentNumber <= 100);

  return (
    <section className="border border-line rounded-lg bg-surface p-[18px]" data-testid="spend-alerts">
      <h2 className="m-0 mb-2 text-sm font-semibold text-ink">Spend alerts</h2>
      <p className="m-0 mb-3 text-[13px] text-muted">
        Get an email, at most once per calendar month (UTC), when your organization&rsquo;s
        monthly spend crosses a dollar amount, or when a budget is consumed past a percentage.
        Rules are checked every 15 minutes. These are notifications only; hard budget caps keep
        enforcing on their own.
      </p>

      {alerts === null ? (
        <div aria-hidden className="flex flex-col gap-2" data-testid="spend-alerts-loading">
          {Array.from({ length: 2 }, (_, index) => (
            <div
              className="flex items-center justify-between gap-2 rounded-[var(--radius-md)] border border-line px-3 py-2"
              key={index}
            >
              <div className="flex min-w-0 flex-col gap-1.5">
                <Shimmer className="h-3.5 w-64 max-w-full" />
                <Shimmer className="h-2.5 w-24" />
              </div>
            </div>
          ))}
        </div>
      ) : alerts.length === 0 ? (
        <p className="m-0 text-[13px] text-muted" data-testid="spend-alerts-empty">
          No alert rules yet.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {alerts.map((alert) => (
            <li
              className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-line px-3 py-2"
              key={alert.alert_id}
            >
              <div className="min-w-0">
                <p className="m-0 text-[13px] text-ink">{ruleLine(alert, budgets)}</p>
                <p className="m-0 text-[11px] text-muted-2">{lastEventLine(alert)}</p>
              </div>
              {canManage && (
                <button
                  className="shrink-0 cursor-pointer rounded-[var(--radius-md)] border border-line bg-surface px-2.5 py-1 text-[12px] font-medium text-foreground transition-colors hover:bg-foreground/[0.04] disabled:cursor-default disabled:opacity-50"
                  disabled={busy}
                  onClick={() => void deleteRule(alert.alert_id)}
                  type="button"
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className={FIELD_LABEL}>
            Alert on
            <select
              aria-label="Alert kind"
              className={FIELD_INPUT}
              onChange={(event) =>
                setKind(
                  event.target.value === "budget_fraction" ? "budget_fraction" : "org_monthly_spend"
                )
              }
              value={kind}
            >
              <option value="org_monthly_spend">Monthly spend crosses…</option>
              <option value="budget_fraction">Budget consumed past…</option>
            </select>
          </label>
          {kind === "org_monthly_spend" ? (
            <label className={FIELD_LABEL}>
              Threshold (USD)
              <input
                aria-label="Spend threshold in USD"
                className={`${FIELD_INPUT} w-[110px]`}
                min={0}
                onChange={(event) => setDollars(event.target.value)}
                placeholder="100"
                step="0.01"
                type="number"
                value={dollars}
              />
            </label>
          ) : (
            <>
              <label className={FIELD_LABEL}>
                Budget
                <select
                  aria-label="Budget to watch"
                  className={`${FIELD_INPUT} max-w-[240px]`}
                  onChange={(event) => setBudgetId(event.target.value)}
                  value={budgetId}
                >
                  <option disabled value="">
                    {budgets.length === 0 ? "No budgets yet" : "Pick a budget…"}
                  </option>
                  {budgets.map((budget) => (
                    <option key={budget.budget_id} value={budget.budget_id}>
                      {budgetLabel(budget)}
                    </option>
                  ))}
                </select>
              </label>
              <label className={FIELD_LABEL}>
                Consumed (%)
                <input
                  aria-label="Budget consumption percentage"
                  className={`${FIELD_INPUT} w-[80px]`}
                  max={100}
                  min={1}
                  onChange={(event) => setPercent(event.target.value)}
                  step="1"
                  type="number"
                  value={percent}
                />
              </label>
            </>
          )}
          <label className={FIELD_LABEL}>
            Email
            <input
              aria-label="Notification email"
              className={`${FIELD_INPUT} w-[220px]`}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="finance@example.com"
              type="email"
              value={email}
            />
          </label>
          <button
            className="cursor-pointer rounded-[var(--radius-md)] border border-line bg-surface px-3.5 py-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-foreground/[0.04] disabled:cursor-default disabled:opacity-50"
            disabled={busy || !fieldsValid}
            onClick={() => void addRule()}
            type="button"
          >
            {busy ? "Saving…" : "Add alert"}
          </button>
        </div>
      )}

      {error && <p className="m-0 mt-2 text-[13px] text-danger">{error}</p>}
    </section>
  );
}

function ruleLine(alert: SpendAlertView, budgets: BudgetView[]): string {
  if (alert.kind === "org_monthly_spend") {
    return `Email ${alert.notify_email} when monthly spend crosses ${formatCostUsd(
      (alert.threshold_micro_usd ?? 0) / 1_000_000
    )}`;
  }
  const budget = budgets.find((candidate) => candidate.budget_id === alert.budget_id);
  const label = budget === undefined ? `budget ${alert.budget_id ?? ""}` : budgetLabel(budget);
  const percent = Math.round((alert.threshold_fraction ?? 0) * 100);
  return `Email ${alert.notify_email} when ${label} is ${percent}% consumed`;
}

function lastEventLine(alert: SpendAlertView): string {
  const event = alert.last_event;
  if (event === null) {
    return "Never fired.";
  }
  const measured = formatCostUsd(event.measured_micro_usd / 1_000_000);
  const state =
    event.delivered_at !== null
      ? "email delivered"
      : event.delivery_error !== null
        ? `delivery failed: ${event.delivery_error}`
        : "email pending";
  return `Fired for ${event.period} at ${measured}, ${state}.`;
}

/** Compact one-line name for a budget row in the dropdown and rule lines. */
function budgetLabel(budget: BudgetView): string {
  const lifetime = budget.period === RECURRING_PERIOD ? "recurring" : budget.period;
  const scope =
    budget.scope_kind === "team"
      ? "Organization"
      : budget.scope_kind === "identity"
        ? `Identity ${budget.identity_id ?? ""}`
        : budget.scope_kind === "key"
          ? `API key ${budget.api_key_id ?? ""}`
          : budget.scope_kind === "model"
            ? `Model ${budget.alias_id ?? ""}`
            : budget.scope_kind;
  return `${scope} · ${formatCostUsd(budget.limit_micro_usd / 1_000_000)} · ${lifetime}`;
}
