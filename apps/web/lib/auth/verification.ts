import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { escapeHtml, sendResendEmail, type EmailSendResult } from "@/lib/email/resend";
import { overviewPath, resetPasswordPath } from "@/lib/routes";

import { loadSupabaseAuthSettings } from "./config";

// Email sending for the signup flow. Two distinct sends:
//
// 1. sendVerificationEmail — the "verify to unlock credits" / magic sign-in link
//    for a freshly created account. It is generated with the ADMIN generateLink
//    API and delivered through the platform's own Resend sender, NOT GoTrue's
//    signInWithOtp: on prod, GoTrue's SMTP OTP returns an error for a
//    just-admin-created UNCONFIRMED user (verification_email_sent came back
//    false and nothing arrived, stranding the user at the credit gate).
//    generateLink is an admin operation that always mints a token regardless of
//    mailer/magic-link config, and Resend is the same verified path invites and
//    spend alerts already use. Clicking the link hits /auth/callback
//    (verifyOtp type=magiclink); proving inbox ownership there sets
//    organizations.spend_unlocked_at and opens the P1025 spend gate (login is
//    already permitted from signup — the two are decoupled).
//
// 2. sendSigninCode — the emailed 6-digit code for an EXISTING account signing
//    in by inbox proof (GoTrue signInWithOtp, the same code the /signin form
//    uses). Existing accounts are normally confirmed, for which GoTrue OTP works.

/**
 * Generate a magic verification link for a just-created account and email it via
 * Resend. `origin` is the public web origin (from the request), so the link
 * points at the real host, never a dev bind address.
 */
export async function sendVerificationEmail(
  admin: SupabaseClient,
  email: string,
  origin: string
): Promise<EmailSendResult> {
  let hashedToken: string;
  try {
    const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
    const token = data?.properties?.hashed_token;
    if (error !== null || typeof token !== "string" || token.length === 0) {
      return { sent: false, reason: error?.message ?? "generateLink returned no token" };
    }
    hashedToken = token;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return { sent: false, reason: `generateLink failed: ${message}` };
  }

  const verifyUrl = new URL("/auth/callback", origin);
  verifyUrl.searchParams.set("token_hash", hashedToken);
  verifyUrl.searchParams.set("type", "magiclink");
  verifyUrl.searchParams.set("next", overviewPath());
  const link = verifyUrl.toString();
  const safeLink = escapeHtml(link);

  return sendResendEmail({
    to: email,
    subject: "Verify your email to unlock your Experiential Labs credits",
    html: [
      `<div style="font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #171717;">`,
      `<h2 style="font-size: 18px; font-weight: 600;">Verify your email</h2>`,
      `<p style="font-size: 14px; line-height: 1.6;">Confirm your email to unlock your free platform credits. Everything else — your dashboard, trace uploads, and your own provider keys (BYOK) — already works.</p>`,
      `<p style="margin: 24px 0;"><a href="${safeLink}" style="background: #171717; color: #ffffff; text-decoration: none; padding: 10px 20px; border-radius: 9999px; font-size: 14px; font-weight: 600;">Verify email</a></p>`,
      `<p style="font-size: 12px; color: #737373; line-height: 1.6;">Or paste this link into your browser:<br /><a href="${safeLink}" style="color: #737373;">${safeLink}</a></p>`,
      `<p style="font-size: 12px; color: #737373;">If you didn't create an Experiential Labs account, you can ignore this email.</p>`,
      `</div>`
    ].join("\n")
  });
}

/**
 * Generate a password-RECOVERY link for an existing account and email it via
 * Resend, mirroring sendVerificationEmail: an ADMIN generateLink (type=recovery)
 * token delivered through the platform's own verified sender rather than GoTrue's
 * SMTP. Clicking it hits /auth/callback (verifyOtp type=recovery), which seats a
 * short recovery session and lands the user on the set-password page. Setting a
 * password from that inbox-proven session is what enables optional password
 * sign-in for an account that is otherwise passwordless.
 *
 * `origin` is the public web origin (from the request), so the link points at the
 * real host, never a dev bind address.
 */
export async function sendPasswordResetEmail(
  admin: SupabaseClient,
  email: string,
  origin: string
): Promise<EmailSendResult> {
  let hashedToken: string;
  try {
    const { data, error } = await admin.auth.admin.generateLink({ type: "recovery", email });
    const token = data?.properties?.hashed_token;
    if (error !== null || typeof token !== "string" || token.length === 0) {
      return { sent: false, reason: error?.message ?? "generateLink returned no token" };
    }
    hashedToken = token;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return { sent: false, reason: `generateLink failed: ${message}` };
  }

  const resetUrl = new URL("/auth/callback", origin);
  resetUrl.searchParams.set("token_hash", hashedToken);
  resetUrl.searchParams.set("type", "recovery");
  resetUrl.searchParams.set("next", resetPasswordPath());
  const link = resetUrl.toString();
  const safeLink = escapeHtml(link);

  return sendResendEmail({
    to: email,
    subject: "Reset your Experiential Labs password",
    html: [
      `<div style="font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #171717;">`,
      `<h2 style="font-size: 18px; font-weight: 600;">Reset your password</h2>`,
      `<p style="font-size: 14px; line-height: 1.6;">Click below to set a new password for your Experiential Labs account. You can always sign in with an emailed code instead — a password is optional.</p>`,
      `<p style="margin: 24px 0;"><a href="${safeLink}" style="background: #171717; color: #ffffff; text-decoration: none; padding: 10px 20px; border-radius: 9999px; font-size: 14px; font-weight: 600;">Set a new password</a></p>`,
      `<p style="font-size: 12px; color: #737373; line-height: 1.6;">Or paste this link into your browser:<br /><a href="${safeLink}" style="color: #737373;">${safeLink}</a></p>`,
      `<p style="font-size: 12px; color: #737373;">If you didn't request this, you can ignore this email — your password won't change.</p>`,
      `</div>`
    ].join("\n")
  });
}

/**
 * Send an existing account an emailed 6-digit sign-in code (GoTrue OTP), so the
 * owner signs in by proving inbox ownership. shouldCreateUser:false so this
 * never provisions on its own. `origin` keeps any link fallback on the public
 * web host even when the Supabase project's Site URL is stale. Returns whether
 * the mailer accepted the send.
 */
export async function sendSigninCode(email: string, origin: string): Promise<boolean> {
  return sendEmailCode(email, origin, false);
}

/**
 * Send a six-digit code that may create a new account on verification. This is
 * used by the rate-limited marketing signup handoff; the shared /auth/otp route
 * remains the account-creation path for ordinary sign-in UI submissions.
 */
export async function sendSignupCode(email: string, origin: string): Promise<boolean> {
  return sendEmailCode(email, origin, true);
}

async function sendEmailCode(
  email: string,
  origin: string,
  shouldCreateUser: boolean
): Promise<boolean> {
  try {
    const { anonKey, url } = loadSupabaseAuthSettings();
    const anon = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
    const { error } = await anon.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser,
        emailRedirectTo: new URL("/auth/callback", origin).toString()
      }
    });
    return error === null;
  } catch {
    return false;
  }
}
