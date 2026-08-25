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

/**
 * Whether `key` is within its sliding-window budget, recording this hit when it
 * is. Shared by the per-IP counters; a per-address EMAIL cooldown is a separate
 * one-slot mechanism below.
 */
function withinSlidingBudget(
  map: Map<string, number[]>,
  key: string,
  max: number,
  windowMs: number
): boolean {
  const now = Date.now();
  const cutoff = now - windowMs;
  const recent = (map.get(key) ?? []).filter((at) => at > cutoff);
  if (recent.length >= max) {
    map.set(key, recent);
    return false;
  }
  recent.push(now);
  map.set(key, recent);
  return true;
}

// A per-address cooldown: at most one verification/sign-in email per address per
// window, INDEPENDENT of source IP. This is the load-bearing anti-blast control
// — an attacker rotating IPs (or behind a shared proxy IP) still cannot spray a
// single victim's inbox — and it never false-positives across distinct users the
// way a coarse proxy-IP bucket can.
const EMAIL_COOLDOWN_MS = 60_000;
const lastEmailAt = new Map<string, number>();

/** Whether a new signup from `ip` is within the per-IP window budget. */
export function allowSignupStart(ip: string): boolean {
  return withinSlidingBudget(startsByIp, ip, START_PER_IP_MAX, START_PER_IP_WINDOW_MS);
}

// Password sign-in attempt limits. `/auth/password/signin` now distinguishes
// "no account" from "wrong password" on its 401 (owner-approved, matching the
// bounded oracle on /signup), so that 401 leaks account existence and MUST be
// bounded, exactly the posture signup carries. These are DEDICATED buckets,
// deliberately separate from the signup counters above: a failed login must not
// consume the per-address EMAIL cooldown (that would block the very "email me a
// sign-in code" fallback the form offers on rejection) nor the signup per-IP
// budget. Per-IP is the load-bearing enumeration bound (it caps how many
// addresses one source can probe); per-address additionally blunts password
// brute-forcing of a single known account. Like every counter here it is
// per-replica and in-process, a blunt instrument; the durable ceiling against
// credit abuse is still the spend gate, not these.
const SIGNIN_PER_IP_MAX = 10;
const SIGNIN_PER_IP_WINDOW_MS = 600_000;
const signinsByIp = new Map<string, number[]>();
const SIGNIN_PER_EMAIL_MAX = 10;
const SIGNIN_PER_EMAIL_WINDOW_MS = 600_000;
const signinsByEmail = new Map<string, number[]>();

/**
 * Whether a password sign-in attempt from `ip` for `email` is within budget.
 *
 * Both dimensions are evaluated and recorded (each attempt counts against the
 * source IP and the target address); the caller returns the shared 429 shape
 * when this is false. Client IP MUST be `clientIp(request)`, the trusted proxy
 * hop, never the client-forgeable leftmost X-Forwarded-For token.
 */
export function allowSigninAttempt(ip: string, email: string): boolean {
  const ipOk = withinSlidingBudget(signinsByIp, ip, SIGNIN_PER_IP_MAX, SIGNIN_PER_IP_WINDOW_MS);
  const emailOk = withinSlidingBudget(
    signinsByEmail,
    email.trim().toLowerCase(),
    SIGNIN_PER_EMAIL_MAX,
    SIGNIN_PER_EMAIL_WINDOW_MS
  );
  return ipOk && emailOk;
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
