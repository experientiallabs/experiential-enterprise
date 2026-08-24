// Client-safe shapes for the identity-tier management surface. These mirror the
// backend response models in explabs/api/routes/identities.py one-to-one.

export type IdentityView = {
  identity_id: string;
  display_name: string;
  description: string | null;
  active: boolean;
  is_default: boolean;
  active_key_count: number;
  created_at: string;
  updated_at: string;
};

export type AliasSummary = {
  alias_id: string;
  alias_name: string;
  origin: string;
  // True for the org's own custom alias, false for a public-catalog alias.
  org_scoped: boolean;
};

export type GrantEdge = {
  identity_id: string;
  alias_id: string;
};

export type GrantMatrix = {
  identities: IdentityView[];
  aliases: AliasSummary[];
  grants: GrantEdge[];
};

export type BudgetView = {
  budget_id: string;
  // The row's own key: a pinned "YYYY-MM" month or "*" for recurring (a
  // recurring row folds into every month's read; the balances always meter
  // the queried month).
  period: string;
  scope_kind: BudgetScopeKind;
  api_key_id: string | null;
  identity_id: string | null;
  alias_id: string | null;
  pool_id: string | null;
  deployment_id: string | null;
  limit_micro_usd: number;
  reserved_micro_usd: number;
  settled_micro_usd: number;
  remaining_micro_usd: number;
};

export type BudgetScopeKind = "team" | "identity" | "key" | "model" | "pool" | "deployment";

// A budget with this period recurs every month: enforced from the 1st of each
// UTC month, never expires. Mirrors RECURRING_PERIOD in the backend store.
export const RECURRING_PERIOD = "*";

export type CreateIdentityInput = {
  display_name: string;
  description?: string | null;
  identity_id?: string | null;
};

export type UpdateIdentityInput = {
  display_name?: string;
  description?: string | null;
  active?: boolean;
};

export type SetBudgetInput = {
  // "YYYY-MM" for a pinned month, or RECURRING_PERIOD for every month.
  period: string;
  scope_kind: BudgetScopeKind;
  limit_micro_usd: number;
  api_key_id?: string | null;
  identity_id?: string | null;
  alias_id?: string | null;
  pool_id?: string | null;
  deployment_id?: string | null;
};

// The month key the budgets surface reads/writes, e.g. "2026-08" (UTC).
export function currentBudgetPeriod(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}
