// Server-only: the "your spend crossed a threshold you set" email, sent
// through the same Resend HTTP API and verified sender as the invite and
// recharge emails. It is the delivery side of a claimed spend-alert event —
// the claim row already exists whether or not the mail leaves — so a missing
// key or a Resend error is reported, never thrown (the DB retries undelivered
// claims on the next tick). Copy stays factual: an alert is a notification
// the customer asked for; the hard budget caps enforce independently.

const RESEND_API_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = "Experiential Labs <members@experientiallabs.ai>";

type SpendAlertEmailInput = {
  to: string;
  orgName: string;
  kind: "org_monthly_spend" | "budget_fraction";
  /** The UTC month the alert fired for, e.g. "2026-08". */
  period: string;
  measuredMicroUsd: number;
  thresholdMicroUsd: number;
  /** The watched budget's limit; null for an org monthly-spend rule. */
  limitMicroUsd: number | null;
  /** The watched budget's scope kind; null for an org monthly-spend rule. */
  budgetScopeKind: string | null;
  /** Straight-line month-end projection of the measured figure. */
  projectedMicroUsd: number;
  /** Absolute URL to the credits page, so the reader can act on the alert. */
  creditsUrl: string;
};

export type SpendAlertEmailResult = { sent: true } | { sent: false; reason: string };

/**
 * Straight-line month-end projection: the measured month-to-date figure run
 * forward at its average daily pace (measured / dayOfMonth * daysInMonth),
 * both in UTC. It is deliberately naive and labeled as such in the email.
 */
export function straightLineMonthProjection(measuredMicroUsd: number, now: Date): number {
  const dayOfMonth = now.getUTCDate();
  // Day 0 of the NEXT month is the last day of this one.
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return Math.round((measuredMicroUsd / dayOfMonth) * daysInMonth);
}

export async function sendSpendAlertEmail(
  input: SpendAlertEmailInput
): Promise<SpendAlertEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { sent: false, reason: "RESEND_API_KEY is not configured" };
  }
  const from = process.env.EXPLABS_EMAIL_FROM ?? DEFAULT_FROM;
  const crossing = crossingLine(input);
  try {
    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: `Spend alert for ${input.orgName}: ${crossing.subject}`,
        html: spendAlertEmailHtml({
          orgName: escapeHtml(input.orgName),
          crossing: escapeHtml(crossing.body),
          period: escapeHtml(input.period),
          projection: formatUsd(input.projectedMicroUsd),
          creditsUrl: escapeHtml(input.creditsUrl)
        })
      })
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { message?: unknown } | null;
      const message =
        typeof payload?.message === "string" ? payload.message : `HTTP ${response.status}`;
      return { sent: false, reason: `Resend rejected the email: ${message}` };
    }
    return { sent: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return { sent: false, reason: `Resend request failed: ${message}` };
  }
}

/** The subject fragment and body sentence describing what crossed. */
function crossingLine(input: SpendAlertEmailInput): { subject: string; body: string } {
  const measured = formatUsd(input.measuredMicroUsd);
  const threshold = formatUsd(input.thresholdMicroUsd);
  if (input.kind === "org_monthly_spend") {
    return {
      subject: `monthly spend crossed ${threshold}`,
      body: `Monthly spend reached ${measured}, crossing the ${threshold} threshold you set.`
    };
  }
  const limit = input.limitMicroUsd ?? 0;
  const percent = limit > 0 ? Math.round((input.measuredMicroUsd / limit) * 100) : 100;
  const scope = input.budgetScopeKind === null ? "budget" : `${input.budgetScopeKind} budget`;
  return {
    subject: `a budget is ${percent}% consumed`,
    body: `A ${scope} is ${percent}% consumed: ${measured} of its ${formatUsd(limit)} limit.`
  };
}

function spendAlertEmailHtml({
  orgName,
  crossing,
  period,
  projection,
  creditsUrl
}: {
  orgName: string;
  crossing: string;
  period: string;
  projection: string;
  creditsUrl: string;
}): string {
  return [
    `<div style="font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #171717;">`,
    `<h2 style="font-size: 18px; font-weight: 600;">Spend alert for ${orgName}</h2>`,
    `<p style="font-size: 14px; line-height: 1.6;">${crossing}</p>`,
    `<p style="font-size: 14px; line-height: 1.6;">Month: <strong>${period}</strong> (UTC). At the current pace, a straight-line projection puts this figure near <strong>${projection}</strong> by month end.</p>`,
    `<p style="margin: 24px 0;"><a href="${creditsUrl}" style="background: #171717; color: #ffffff; text-decoration: none; padding: 10px 20px; border-radius: 9999px; font-size: 14px; font-weight: 600;">View spend &amp; alerts</a></p>`,
    `<p style="font-size: 12px; color: #737373; line-height: 1.6;">This is a notification you set up on the credits page, hard budget caps keep enforcing on their own. You'll get at most one email per rule per calendar month.</p>`,
    `</div>`
  ].join("\n");
}

function formatUsd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
