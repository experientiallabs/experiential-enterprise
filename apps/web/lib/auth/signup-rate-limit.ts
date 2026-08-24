import type { NextRequest } from "next/server";

// Per-instance abuse limits shared by the public signup entry points:
// POST /api/signup/instant and GET /signup. In-process only, like the old
// Python device-signup limiter. A multi-replica deployment enforces this PER
// REPLICA, so it is a blunt instrument, not a hard ceiling. The DURABLE ceiling
// against credit abuse is the email-verification spend gate. No credit is
// spendable until the inbox is verified, and pre-verification credentials are
// revoked at verification.
// these limits exist to blunt bulk account creation and, above all, to keep the
// public endpoints from being turned into an email blaster that would wreck the
// Supabase/Resend sender reputation.
const START_PER_IP_MAX = 5;
const START_PER_IP_WINDOW_MS = 600_000;
const startsByIp = new Map<string, number[]>();

// A per-address cooldown: at most one verification/sign-in email per address per
// window, INDEPENDENT of source IP. This is the load-bearing anti-blast control
// — an attacker rotating IPs (or behind a shared proxy IP) still cannot spray a
// single victim's inbox — and it never false-positives across distinct users the
// way a coarse proxy-IP bucket can.
const EMAIL_COOLDOWN_MS = 60_000;
const lastEmailAt = new Map<string, number>();

/** Whether a new signup from `ip` is within the per-IP window budget. */
export function allowSignupStart(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - START_PER_IP_WINDOW_MS;
  const recent = (startsByIp.get(ip) ?? []).filter((at) => at > cutoff);
  if (recent.length >= START_PER_IP_MAX) {
    startsByIp.set(ip, recent);
    return false;
  }
  recent.push(now);
  startsByIp.set(ip, recent);
  return true;
}

/**
 * Whether an account email may be sent to `email` now (per-address cooldown).
 * Call immediately before dispatching a verification / magic sign-in email so a
 * repeated hit on the same address cannot blast the inbox.
 */
export function allowEmailSend(email: string): boolean {
  const now = Date.now();
  const key = email.trim().toLowerCase();
  const last = lastEmailAt.get(key);
  if (last !== undefined && now - last < EMAIL_COOLDOWN_MS) {
    return false;
  }
  lastEmailAt.set(key, now);
  return true;
}

/**
 * Release a cooldown reservation when the downstream mailer rejected the
 * send. A failed dispatch did not reach the inbox, so it must not strand the
 * user until the normal cooldown expires.
 */
export function releaseEmailSend(email: string): void {
  lastEmailAt.delete(email.trim().toLowerCase());
}

/**
 * The caller's source IP for rate limiting, from the TRUSTED proxy hop.
 *
 * NEVER the leftmost `X-Forwarded-For` token: that is the value the client sent
 * and can forge per request, which would let an attacker rotate a fake IP on
 * every call and bypass the per-IP limit entirely. The ingress (ingress-nginx)
 * sets `X-Real-IP` to the connecting peer, so prefer that; otherwise fall back
 * to the RIGHTMOST `X-Forwarded-For` entry (the hop appended by the trusted
 * proxy), and only then to the leftmost for a local/dev request with no proxy.
 */
export function clientIp(request: NextRequest): string {
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) {
    return realIp;
  }
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded
      .split(",")
      .map((hop) => hop.trim())
      .filter((hop) => hop.length > 0);
    if (hops.length > 0) {
      return hops[hops.length - 1];
    }
  }
  return "unknown";
}
