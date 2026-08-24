// Server-only: one send path over the Resend HTTP API, from the platform's own
// verified sender. Every transactional email (invites, spend alerts, and the
// signup verification / magic sign-in link) goes out this way rather than
// through GoTrue's SMTP, so delivery does not depend on the auth project's
// mailer configuration. Configured by env: RESEND_API_KEY (secret) and
// EXPLABS_EMAIL_FROM (the verified experientiallabs.ai sender). Sends are
// best-effort — the reason is returned, never thrown.

const RESEND_API_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = "Experiential Labs <members@experientiallabs.ai>";

export type EmailSendResult = { sent: true } | { sent: false; reason: string };

export async function sendResendEmail(input: {
  to: string;
  subject: string;
  html: string;
}): Promise<EmailSendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { sent: false, reason: "RESEND_API_KEY is not configured" };
  }
  const from = process.env.EXPLABS_EMAIL_FROM ?? DEFAULT_FROM;
  try {
    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ from, to: [input.to], subject: input.subject, html: input.html })
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

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
