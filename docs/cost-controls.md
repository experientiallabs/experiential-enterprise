<!-- Copyright (c) 2026 Experiential Labs. All rights reserved. -->

# Gateway cost controls

Every money decision for platform-funded (host lane) traffic happens inside
one Postgres function, `gateway_start_attempt`, under the organization's row
lock, before any provider is contacted. BYOK / pass-through traffic is
**never** counted, rate limited, or blocked by anything on this page; it is
attributed for reporting only.

Absence of a limit always means "unlimited"; every gate below fails closed on
an unknown worst-case price (`P1013`), so nothing can slip a gate by being
unpriceable.

## The gate chain (order matters)

For each host-lane dispatch, in this order, all of which must pass:

| # | Gate | SQLSTATE / reason | Configured by |
|---|---|---|---|
| 1 | Requests/minute (RPM), 60s sliding window of dispatches | `P1012 key_rate_limit` | `gateway_key_limits.requests_per_minute` (no row = 60) |
| 2 | Tokens/minute (TPM), 60s trailing window of settled tokens | `P1022 key_token_rate_limit` | `gateway_key_limits.tokens_per_minute` (no row = uncapped; no default) |
| 3 | Price known | `P1013 deployment_price_unknown` (route ineligible; waterfall advances) | — |
| 4 | Per-key daily spend cap (UTC day) | `P1011 key_daily_cap` | `gateway_key_limits.daily_spend_cap_micro_usd` (no row = $50/day only while free-credit funded) |
| 5 | Credit balance + free-credit org/model daily caps | `P1010 insufficient_credits`, `P1014 org_daily_cap`, `P1015 model_daily_cap` | billing policy |
| 6 | Monthly budgets, tightest scope first | `P1016`–`P1019`, `P1023 budget_key`, `P1024 budget_model` | `gateway_budgets` |

A refused dispatch surfaces to the customer as `429 insufficient_quota`
(deployment-scoped refusals advance the routing waterfall instead). The
refusal message with exact figures and the reset time is recorded at the SQL
layer.

Two more host-lane gates compose here, both team-scoped (they stop routing and
429): the **promotional-model cap** (below) sits right after gate 3 and, when a
request is promo-funded, SKIPS gates 4–6 entirely (it is free and draws no
credits); and the **pre-verify allowance** (below) is the first check on the
credit path (`P1025`).

## Promotions (`model_promotions`, v2: scoped)

A promotion is a labeled object with a SCOPE and terms:

- **Model scope** — explicit membership rows in `model_promotion_models`
  (one per covered public catalog model). Empty membership = every model.
  The admin UI can fill membership by picking a model **family** (Claude,
  GPT, …); the picked family keys are kept in `family_keys` as display
  metadata, but the membership rows are always the enforcement authority
  (a model released after the promo was saved joins only when an admin
  re-saves the scope).
- **Lane scope** — `providers` (catalog provider vocabulary), matched against
  the serving ATTEMPT's provider at reserve time. Empty = any lane.
  `['experiential_cloud']` means the terms apply only when the request is
  actually served through Experiential Cloud.
- **Terms** — `per_org_cap_micro_usd` (free allowance),
  `discount_cap_micro_usd` (per-org ceiling on CHARGED post-discount spend the
  `% off` applies to; 0 = never expires), `percent_off`, `cap_scope`
  (`lifetime` or `recurring`, windowing BOTH caps), `active`, `display_order`.

The gateway owns enforcement; the catalog surface reads the display projection
(label, resolved slugs, `free`, `percent_off`, providers, family keys) to
render the Promotional section, the FREE chips, and the family-header
"% off" chips.

**Admin-managed** (platform-admin only): the admin panel (Admin → Promotions,
`/admin/promotions`) is CRUD over promotions — pick models (individually or by
family), pick lanes, and set the free cap, discount cap, `% off`, scope,
`active`, and `display_order`. Routes under `/api/admin/model-promotions`
(keyed by promotion id, `isPlatformAdmin` gated) go through
`getDataSource().*AdminModelPromotion*` → the FastAPI
`/api/admin/model-promotions` router (`explabs/api/routes/model_promotions.py`,
service-role writes). Seeds are just defaults; admins are the source of truth
thereafter.

When scopes overlap on one request, ONE promotion applies: a usable free tier
beats a usable discount; with neither usable, the free-tier-bearing candidate
is reported so the P1030/P1031 transitions keep firing (deterministic order:
`display_order`, then id — `gateway_promo_state`).

### Free cap vs. % off vs. discount cap (all composable on one promo)

- `per_org_cap_micro_usd > 0` defines a **free tier**: within the cap, usage is
  100% free (draws no credits), tracked in the `promo_*` columns on
  `gateway_attempts` (`promo_funded`, `promo_reserved_micro_usd`,
  `promo_settled_micro_usd`) while `budget_*` stay 0 — so every credit/budget/cap
  gate (which sums `budget_*`) treats free usage as $0 and settlement never
  debits credits.
- `percent_off` (0–100) is a straight discount on the org's **credit** charge
  **after** the free cap is reached, or from the **first request when the cap is
  0** (a pure-discount promo, no free tier). The charged amount =
  `full_cost × (1 − percent_off/100)`, applied to BOTH the reserve-time worst
  case (so every credit/budget/cap gate sees the discounted figure, frozen on
  the attempt as `promo_discount_percent`) and the settled cost;
  `estimated_cost_micro_usd` keeps the full cost. `percent_off` does **not**
  bypass the credit balance gate — a 100%-off post-cap charge is still refused on
  a zero balance.
- `discount_cap_micro_usd > 0` bounds the discount per org: `% off` applies
  while the org's cumulative CHARGED (post-discount) spend under this
  promotion — reservation-aware, summed over `gateway_attempts` by the new
  `promo_id` attribution column — still fits the ceiling with this request's
  discounted worst case included (conservative: the boundary request pays list
  price rather than overshooting). Past the ceiling the same models charge
  list price; nothing refuses, the discount just ends. Example: "50% off GPT
  models via Experiential Cloud until the org has spent $50k" is
  `percent_off=50, providers=['experiential_cloud'],
  discount_cap_micro_usd=50_000_000_000`.

State machine per `(org, promotion, period)` (the free cap and notices span
the promotion's whole model scope, not one model):

| State | Outcome | SQLSTATE / code |
|---|---|---|
| Under cap (`cap>0`) | promo-funded (free); credit gates skipped | — (reserves) |
| Cap reached (`cap>0`), not yet notified | one-time visible switch: refuse once, then credits at `% off` | `P1030 promo_exhausted_notice` → `429`, rewritten to `code: promo_credits_now` |
| Cap reached, notified, credits cover | draws org credits at `% off` | — (reserves) |
| Pure discount (`cap=0`) | credits at `% off` from the first request; no free→credits switch, **no P1030** | — (reserves) |
| Credits can't cover the discounted charge | BYOK-only for that org | `P1031 promo_byok_only` → `429` |

The one-time notice is made non-repeating by a `model_promotion_notices` row
(keyed by org + PROMOTION + period) the gateway ledger commits out of band
after a `P1030` — the refusal's SQL `DETAIL` carries the promotion id, since a
scoped promotion is no longer named by the request's alias alone. The customer
sees the switch as a single `429` naming the promotion (rewritten from the
generic quota body by `explabs/gateway/promo_notice.py`, mirroring the
verify-email notice), then their retry proceeds on credits. Seeded defaults
(admins edit thereafter; label-keyed and never clobbering operator edits):
`qwen3.8-27b` $10, `deepseek-v4-flash` $10, `gpt-5.6-luna` $20 (lifetime, 0%
off), and `GPT on Experiential Cloud — 50% off` (GPT family via
`experiential_cloud`, $50k/org lifetime discount ceiling), in
`supabase/seed-gateway-catalog.sql`. Production is never seeded — create the
production promotion once through Admin → Promotions.

## Pre-verify spend allowance

An org whose founding admin has not proven inbox ownership
(`organizations.spend_unlocked_at is null`) may accrue platform-credit spend up
to `app_settings.pre_verify_allowance_micro_usd` (default $1) before `P1025
org_owner_unverified` blocks the rest until they verify. `0` blocks **all**
unverified credit spend (the prior behavior). Promo-free spend never counts
toward the allowance (promo attempts hold 0 in `budget_*`). BYOK is unaffected.
The gateway reads the setting through `gateway_pre_verify_allowance_micro_usd()`
(guarded: falls back to $1 if the column is absent).

### TPM semantics

Token counts only exist after an attempt settles, so TPM is **trailing
observation**: the gate sums input + cached input + output + reasoning tokens
of the key's host-lane attempts whose `terminal_at` falls in the last 60
seconds and refuses the *next* dispatch at or past the limit. One large
stream can overshoot; the key then waits out the window. This matches
provider-side TPM behavior and requires no token estimate at reserve time.

## Monthly budgets (`gateway_budgets`)

A budget row is `(org, period, scope, limit_micro_usd)`. Spend is measured as
charged-or-reserved: in-flight dispatches count at their reserved worst case,
terminal attempts at their settled amount, so two concurrent requests can
never jointly exceed a budget, and a failed request's reservation is released
at settlement.

Scopes (tightest first when several govern one dispatch):

| scope_kind | identifiers | Meaning | Refusal |
|---|---|---|---|
| `deployment` | alias + pool + deployment | one route; waterfall advances | `P1019` |
| `pool` | alias + pool | one exact-model pool | `P1018` |
| `model` | alias | the model across every route under it | `P1024` |
| `key` | api_key_id | one API key's spend (an agent's wallet) | `P1023` |
| `identity` | identity_id | every key under one identity | `P1017` |
| `team` | — | the whole organization | `P1016` |

Periods:

- `YYYY-MM` — pinned to one UTC month. **A pinned budget stops enforcing at
  the next month rollover** (00:00 UTC on the 1st) and becomes unlimited.
- `*` — **recurring**: enforced every month against that month's own spend,
  resetting on the 1st. This is what "this org spends at most $X/month"
  means; use pinned months only for one-off overrides.

A recurring and a pinned budget for the same scope may coexist; both must
pass. Every matching budget is checked independently — there is no hierarchy
or override.

Management: `GET/PUT /api/orgs/{org}/budgets`,
`DELETE /api/orgs/{org}/budgets/{id}` (dashboard only; admin to write), UI
under Settings → Identities & access → Budgets. The balances read
(`gateway_budget_balances`) uses the same scope resolution as the gate, so
the meter can never disagree with enforcement.

## Per-key limits (`gateway_key_limits`)

`GET/PUT /api/gateway/keys/{id}/limits` (member read, admin write; customer
`xpl_` keys may GET their own). The PUT is full-resource: the row becomes
exactly the body, and an omitted field means *explicitly uncapped*. Defaults
with no row: 60 rpm, no TPM, and a $50/day cap only while the org is
free-credit funded.

## Spend alerts (`gateway_spend_alerts`)

Soft notifications, the warning counterpart to the hard gates. Two kinds:

- `org_monthly_spend` — fires when the org's month-to-date host-lane spend
  crosses a dollar threshold.
- `budget_fraction` — fires when a budget governing the current month is at
  least the configured fraction consumed.

Each rule fires **at most once per rule per UTC month** and emails
`notify_email`. Evaluation runs every 15 minutes: pg_cron →
`invoke_spend_alerts()` (Vault secrets `spend_alerts_url` + `cron_secret`;
silently inert when unprovisioned) → the `CRON_SECRET`-guarded web route
`POST /api/internal/spend-alerts` → `gateway_spend_alerts_due()` claims
atomically in the database (once-per-month PK claim plus a 10-minute delivery
lease, so overlapping ticks never double-send) → Resend email →
`gateway_spend_alert_mark` records the delivery (a failure clears the lease
and retries next tick; a crashed sender's lease simply expires).
Measurement reuses the budget gates' own spend function, so an alert never
disagrees with the limit it warns about.

Management: `GET/POST /api/orgs/{org}/spend-alerts`,
`DELETE /api/orgs/{org}/spend-alerts/{id}` (dashboard only; admin to write);
UI on the Credits page.

## Attribution note

`gateway_attempts.api_key_id` is denormalized from the accepted request at
reserve time so every per-key gate (RPM, TPM, daily cap, key budgets) scans a
window-bounded partial index instead of the key's lifetime request history.
It nulls on key deletion exactly like `gateway_requests.api_key_id`; spend
history is never deleted, and a nulled key simply matches no per-key gate
(its org/team budgets still count the spend).

## Verifying

- pgTAP: `explabs_gateway_budget_enforcement`, `explabs_gateway_budget_balances`,
  `explabs_gateway_key_tpm`, `explabs_gateway_spend_alerts`,
  `explabs_gateway_promotional_models`, `explabs_gateway_pre_verify_allowance`
  (all drive the composed `gateway_start_attempt`, guarding the shared-body
  merge-train hazard).
- End to end: `explabs/gateway/e2e_test.py::test_s5_*` (caps, RPM, balance)
  and `::test_s11_*` (TPM, key/model/recurring budgets) against real workers.
