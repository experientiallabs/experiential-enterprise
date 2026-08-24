// Server-only: sends invitation emails through the Resend HTTP API. Both
// invite shapes go through here — tenant-provisioning invites from the
// platform admin panel and org-join invites from org admins — so every invite
// email leaves from the platform's own verified sender with the same layout,
// never from a Supabase-branded address. Configured entirely by env:
// RESEND_API_KEY (secret) and EXPLABS_EMAIL_FROM (defaults to the
// verified experientiallabs.ai members sender). Email is a best-effort side
// effect of invite creation — the panels keep a copy-link fallback — so
// failures are reported in the result, never thrown.

const RESEND_API_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = "Experiential Labs <members@experientiallabs.ai>";

type TenantInviteEmailInput = {
  to: string;
  orgName: string;
  inviteUrl: string;
};

type OrgInviteEmailInput = {
  to: string;
  orgName: string;
  role: string;
  inviteUrl: string;
};

export type InviteEmailResult =
  | { sent: true }
  | { sent: false; reason: string };

// Tenant-provisioning invite: accepting creates the invitee's own
// organization.
export async function sendInvitationEmail(input: TenantInviteEmailInput): Promise<InviteEmailResult> {
  const org = escapeHtml(input.orgName);
  return sendInviteEmail({
    to: input.to,
    subject: `You're invited to Experiential Labs — ${input.orgName}`,
    heading: "You're invited to Experiential Labs",
    intro:
      `You've been invited to build simulations on the Experiential Labs platform. ` +
      `Accepting sets up your own <strong>${org}</strong> organization, ready for your traces.`,
    inviteUrl: input.inviteUrl
  });
}

// Org-join invite: accepting creates the invitee's account inside an existing
// organization at the invited role.
export async function sendOrgInviteEmail(input: OrgInviteEmailInput): Promise<InviteEmailResult> {
  const org = escapeHtml(input.orgName);
  const role = escapeHtml(input.role);
  return sendInviteEmail({
    to: input.to,
    // The platform brand already rides the sender name and body; repeating it
    // after the org name read as "Join Experiential Labs on Experiential
    // Labs" for the platform's own org.
    subject: `You've been invited to join ${input.orgName}`,
    heading: `Join ${org}`,
    intro:
      `<strong>${org}</strong> has invited you to join their organization as <strong>${role}</strong>. ` +
      `Accepting creates your account and gives you access to the organization's simulations.`,
    inviteUrl: input.inviteUrl
  });
}

type InviteEmailTemplate = {
  to: string;
  subject: string;
  heading: string;
  intro: string;
  inviteUrl: string;
};

async function sendInviteEmail(template: InviteEmailTemplate): Promise<InviteEmailResult> {
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
      body: JSON.stringify({
        from,
        to: [template.to],
        subject: template.subject,
        html: inviteEmailHtml(template)
      })
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { message?: unknown } | null;
      const message = typeof payload?.message === "string" ? payload.message : `HTTP ${response.status}`;
      return { sent: false, reason: `Resend rejected the email: ${message}` };
    }
    return { sent: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return { sent: false, reason: `Resend request failed: ${message}` };
  }
}

function inviteEmailHtml({ heading, intro, inviteUrl }: InviteEmailTemplate): string {
  const url = escapeHtml(inviteUrl);
  return [
    `<div style="font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #171717;">`,
    `<h2 style="font-size: 18px; font-weight: 600;">${heading}</h2>`,
    `<p style="font-size: 14px; line-height: 1.6;">${intro}</p>`,
    `<p style="margin: 24px 0;"><a href="${url}" style="background: #171717; color: #ffffff; text-decoration: none; padding: 10px 20px; border-radius: 9999px; font-size: 14px; font-weight: 600;">Accept invitation</a></p>`,
    `<p style="font-size: 12px; color: #737373; line-height: 1.6;">Or paste this link into your browser:<br /><a href="${url}" style="color: #737373;">${url}</a></p>`,
    `<p style="font-size: 12px; color: #737373;">This invitation expires in 14 days. If you weren't expecting it, you can ignore this email.</p>`,
    `</div>`
  ].join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
