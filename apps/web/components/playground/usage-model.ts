/**
 * Token formatting shared by retained Models and serving-request surfaces.
 * `undefined` renders as an em dash when totals have not been observed yet.
 */

export function formatTokens(value: number | undefined): string {
  if (value === undefined) {
    return "—";
  }
  return value.toLocaleString("en-US");
}

/**
 * Abbreviate a token count for dense displays: 950 → "950", 50_000 → "50k",
 * 12_345 → "12.3k", 1_234_567 → "1.2M". One decimal below three digits, none
 * above — the strip pairs two counts per stat ("50k/250k"), so width matters.
 */
export function formatTokensCompact(value: number | undefined): string {
  if (value === undefined) {
    return "—";
  }
  if (value < 1_000) {
    return value.toString();
  }
  // Pick the unit after rounding so 999,950 reads "1M", never "1000k".
  const inUnit = (divisor: number) => {
    const scaled = value / divisor;
    return scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
  };
  if (value < 1_000_000 && inUnit(1_000) < 1_000) {
    return `${inUnit(1_000)}k`;
  }
  return `${inUnit(1_000_000)}M`;
}

/** Render an input/output token pair, e.g. "50k/250k". */
export function formatTokensInOut(
  inputTokens: number | undefined,
  outputTokens: number | undefined
): string {
  return `${formatTokensCompact(inputTokens)}/${formatTokensCompact(outputTokens)}`;
}
