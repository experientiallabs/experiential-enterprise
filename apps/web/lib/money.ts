// The web app's ONE money module. Every dollar the UI renders goes through a
// formatter defined here, and the frontier price anchor is defined here once.
//
// There are deliberately several formatters — a $12,400 lifetime spend and a
// $0.000164 serving call cannot share a precision — but each names the surface
// it is for, and no component defines its own dollar math. The house rules all
// of them share: null/undefined is "no figure", NEVER $0.00 (priced spend must
// not read as free, and an unpriced row must not read as spend), and amounts
// below display precision say so ("<$0.01") instead of rounding to zero.

/**
 * Whole-cent display for gauges, rollups, and per-run figures (the default).
 */
export function formatCostUsd(value: number | null | undefined): string {
  if (value === undefined || value === null) {
    return "—";
  }
  // Whole cents only — fractional-cent precision is noise at display time.
  // Round in integer cents: toFixed alone rounds the binary double, so an
  // exact half-cent price like 0.015 (stored just below it) would show a
  // cent low. toPrecision(12) snaps the scaled value back to its decimal.
  const cents = Math.round(Number((value * 100).toPrecision(12)));
  // Priced spend must never read as free — flag sub-half-cent amounts
  // instead of rounding them to $0.00.
  if (cents === 0 && value > 0) {
    return "<$0.01";
  }
  // Thousands separators: "$1,385.13 per 1,000 runs" must not read as $1385.
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

/**
 * Signed whole-cent display for balances that can legitimately go negative
 * (an overdrawn credit balance is shown honestly, never clamped to zero).
 */
export function formatSignedCostUsd(value: number | null | undefined): string {
  if (value === undefined || value === null) {
    return "—";
  }
  const magnitude = formatCostUsd(Math.abs(value));
  return value < 0 ? `-${magnitude}` : magnitude;
}

/**
 * Credit-grant display (the welcome bubble): grants are set in round dollars,
 * so a whole amount drops the ".00" ($20, not $20.00) while a fractional one
 * keeps its cents. The figure always comes from the ledger read, never copy.
 */
export function formatGrantUsd(value: number): string {
  return Number.isInteger(value) ? `$${value.toLocaleString("en-US")}` : formatCostUsd(value);
}

/**
 * Per-request cost display (Telemetry). Serving calls routinely cost fractions
 * of a cent, so this keeps up to six decimals below one cent where the
 * whole-cent formatter would collapse everything to "<$0.01".
 */
export function formatRequestCostUsd(value: number | null | undefined): string {
  if (value === undefined || value === null || !Number.isFinite(value) || value < 0) {
    return "—";
  }
  if (value === 0) {
    return "$0.00";
  }
  if (value < 0.01) {
    const text = value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
    // Priced spend must never read as free: below display precision, say so.
    return text === "0" ? "<$0.000001" : `$${text}`;
  }
  return `$${value.toFixed(value < 1 ? 3 : 2)}`;
}

/** The runs panel's word for a spend leg the emitter never reported. */
export const SPEND_NOT_REPORTED = "not reported";

/**
 * Run-spend display (admin runs panel): cents while they matter, whole
 * dollars above $100, and null is the emitter's "not reported", not $0.
 */
export function formatRunSpendUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return SPEND_NOT_REPORTED;
  }
  if (value === 0) {
    return "$0.00";
  }
  // Priced spend must never read as free below display precision.
  if (Math.abs(value) < 0.01) {
    return value < 0 ? "-<$0.01" : "<$0.01";
  }
  return `$${value.toFixed(Math.abs(value) < 100 ? 2 : 0)}`;
}

/** Signed run-spend delta (the cells-vs-ledger reconciliation line). */
export function formatRunSpendDelta(value: number): string {
  const magnitude = formatRunSpendUsd(Math.abs(value));
  return `${value < 0 ? "-" : "+"}${magnitude}`;
}

/**
 * Single-call display for the playground inspector. Sub-cent amounts keep four
 * decimals (the whole-cent floor would erase the actual-vs-frontier
 * comparison); null is "no verified price", which must never read as free.
 */
export function formatPerCallUsd(value: number | null): string {
  if (value === null) {
    return "unpriced";
  }
  if (value >= 0.01) {
    return formatCostUsd(value);
  }
  // Below four-decimal precision, say so — a priced call must not read free.
  if (value > 0 && value < 0.00005) {
    return "<$0.0001";
  }
  return `$${value.toFixed(4)}`;
}

/**
 * Catalog token-price display: integer micro-USD per million tokens (the
 * model_providers price columns) rendered as dollars per million. Null is an
 * unknown price and reads "—", never $0 — an unpriced route must not read as
 * free. Cheap open-weight routes price in fractions of a dollar per million,
 * so precision widens as the figure shrinks instead of collapsing to $0.00.
 */
export function formatPerMillionUsd(
  microUsdPerMillion: number | null | undefined
): string {
  if (
    microUsdPerMillion === undefined ||
    microUsdPerMillion === null ||
    !Number.isFinite(microUsdPerMillion) ||
    microUsdPerMillion < 0
  ) {
    return "—";
  }
  const usd = microUsdPerMillion / 1_000_000;
  if (usd === 0) {
    return "$0";
  }
  // A real but sub-display price says so instead of rounding to zero.
  if (usd < 0.0005) {
    return "<$0.001";
  }
  // Whole dollars render bare ($30, not $30.00); fractional prices keep a
  // fixed column-stable precision ($1.40, never $1.4) that widens below ten
  // cents where the third decimal is the price ($0.074).
  if (Number.isInteger(usd)) {
    return `$${usd.toLocaleString("en-US")}`;
  }
  return `$${usd.toFixed(usd >= 0.1 ? 2 : 3)}`;
}

/**
 * One dollar format for a SET of figures shown together, chosen by the
 * smallest of them: cents everywhere once any figure is small enough for cents
 * to matter, whole dollars everywhere when none of them are. Mixing the two
 * lets a saving and the two spend figures it sits between visibly fail to
 * subtract.
 */
export function dollarFormatter(values: number[]): (value: number) => string {
  const smallest = Math.min(...values.map((value) => Math.abs(value)));
  const cents = smallest < 100;
  return (value) =>
    `$${value.toLocaleString("en-US", {
      maximumFractionDigits: cents ? 2 : 0,
      minimumFractionDigits: cents ? 2 : 0
    })}`;
}

// --- The frontier price anchor -----------------------------------------------
//
// The single client-side copy of the comparison anchor the backend prices
// counterfactuals with. MUST mirror explabs/frontier_pricing.py — the
// server-side source of truth; the pin test in tests/unit/money.test.ts reads
// that file, so drift fails THIS suite. `cachedInput` has no UI consumer yet
// and exists to keep the mirror complete. The
// UI uses the label and, in the one env-gated live-sample path, the rates;
// every persisted counterfactual dollar is computed server-side.

export const FRONTIER_MODEL_LABEL = "Claude Fable 5";

export const FRONTIER_USD_PER_MTOK = {
  input: 10.0,
  cachedInput: 1.0,
  output: 50.0
} as const;
