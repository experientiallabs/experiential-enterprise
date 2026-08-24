// Client-safe shapes for the spend-alert surface. These mirror the backend
// response models in explabs/api/routes/spend_alerts.py one-to-one: a rule is
// an org monthly-spend dollar threshold or a fraction-of-budget threshold,
// evaluated every 15 minutes and emailed at most once per rule per UTC month.
// Alerts are soft — the hard budget caps enforce independently.

export type SpendAlertKind = "org_monthly_spend" | "budget_fraction";

/** One fired (alert, month) claim with its delivery state. */
export type SpendAlertEventView = {
  period: string;
  fired_at: string;
  measured_micro_usd: number;
  threshold_micro_usd: number;
  delivered_at: string | null;
  delivery_error: string | null;
};

/** One alert rule plus its most recent fired event, if any. */
export type SpendAlertView = {
  alert_id: string;
  kind: SpendAlertKind;
  threshold_micro_usd: number | null;
  budget_id: string | null;
  threshold_fraction: number | null;
  notify_email: string;
  created_at: string;
  last_event: SpendAlertEventView | null;
};

/** POST body: the field set is fixed by `kind` (the backend enforces it). */
export type CreateSpendAlertInput = {
  kind: SpendAlertKind;
  threshold_micro_usd?: number;
  budget_id?: string;
  threshold_fraction?: number;
  notify_email: string;
};
