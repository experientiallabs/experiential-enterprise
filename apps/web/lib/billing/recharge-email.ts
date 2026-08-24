// Server-only: the "we recharged your account" email, sent through the same
// Resend HTTP API and verified sender as the invite emails. It is a
// best-effort side effect of a successful off-session recharge — the credit is
// already in the ledger whether or not the mail leaves — so a missing key or a
// Resend error is reported, never thrown. Copy stays calm: a recharge is a
// convenience the customer opted into, not an alarm.

const RESEND_API_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = "Experiential Labs <members@experientiallabs.ai>";

type RechargeEmailInput = {
  to: string;
  orgName: string;
  amountUsd: number;
  newBalanceUsd: number;
  /** Absolute URL to the credits page, so the reader can adjust or turn it off. */
  creditsUrl: string;
};

export type RechargeEmailResult = { sent: true } | { sent: false; reason: string };

export async function sendRechargeEmail(input: RechargeEmailInput): Promise<RechargeEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { sent: false, reason: "RESEND_API_KEY is not configured" };
  }
  const from = process.env.EXPLABS_EMAIL_FROM ?? DEFAULT_FROM;
  const amount = formatUsd(input.amountUsd);
  const balance = formatUsd(input.newBalanceUsd);
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
        subject: `We added ${amount} to ${input.orgName}`,
        html: rechargeEmailHtml({
          orgName: escapeHtml(input.orgName),
          amount,
          balance,
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

function rechargeEmailHtml({
  orgName,
  amount,
  balance,
  creditsUrl
}: {
  orgName: string;
  amount: string;
  balance: string;
  creditsUrl: string;
}): string {
  return [
    `<div style="font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #171717;">`,
    `<h2 style="font-size: 18px; font-weight: 600;">We topped up your credits</h2>`,
    `<p style="font-size: 14px; line-height: 1.6;">Your <strong>${orgName}</strong> balance ran low, so we added <strong>${amount}</strong> to your saved card, the way you asked us to. Nothing to do — your serving kept running.</p>`,
    `<p style="font-size: 14px; line-height: 1.6;">New balance: <strong>${balance}</strong>.</p>`,
    `<p style="margin: 24px 0;"><a href="${creditsUrl}" style="background: #171717; color: #ffffff; text-decoration: none; padding: 10px 20px; border-radius: 9999px; font-size: 14px; font-weight: 600;">View credits</a></p>`,
    `<p style="font-size: 12px; color: #737373; line-height: 1.6;">You can change the recharge amount, the trigger, or turn auto-recharge off any time from the credits page.</p>`,
    `</div>`
  ].join("\n");
}

function formatUsd(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
