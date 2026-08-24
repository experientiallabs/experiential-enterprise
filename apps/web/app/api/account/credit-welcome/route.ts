import { resolveActiveOrg } from "@/lib/active-org";
import { requireAuthorizedOrgIds } from "@/lib/auth/orgs";
import { createServerSupabaseClient, requireAuthenticatedUser } from "@/lib/auth/server";
import { readLaunchGrantUsd } from "@/lib/billing/launch-grant";
import { jsonError, jsonOk } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Atomically claim the once-ever signup-credit welcome greeting for the
 * signed-in user, and report the amount of the LAUNCH GRANT the greeting
 * should announce.
 *
 * The insert is the arbiter: exactly one caller ever inserts the
 * `user_credit_welcome` row and gets `firstView: true`; every other caller —
 * a later visit, or a second tab or device opened at the same instant — hits
 * the primary-key conflict and gets `firstView: false`. The sidebar bubble
 * (components/shell/CreditsWelcome.tsx) greets only on its own `firstView:
 * true`, so simultaneous opens can never each show the greeting. The row is
 * written RLS-scoped from the user's own session, so a caller can only ever
 * claim their own greeting; the bubble calls this only once it is actually
 * renderable, so a claim is not spent while the greeting is hidden.
 *
 * `welcomeGrantUsd` is the GRANT-EVENT amount, computed from the active org's
 * credit_ledger: the `signup_promo`/`yc_launch` grant rows net of the YC
 * promo-fold reversal — $20 on a standard signup, the full YC amount on a YC
 * claim. It deliberately EXCLUDES top-ups and expiry clawbacks: announcing the
 * cumulative `credit_granted_usd` counter here once greeted a seeded demo org
 * with "$776 in credits added" ($526 YC + $250 of Stripe top-ups). A zero or
 * unreadable grant refuses to spend the claim at all, so a later visit after a
 * real grant lands can still greet.
 */
export async function POST(): Promise<Response> {
  try {
    const user = await requireAuthenticatedUser();
    // Guard before resolveActiveOrg(): a memberless session must get JSON the
    // bubble can degrade on, not that helper's redirect to the /orgs page.
    const authorizedOrgIds = await requireAuthorizedOrgIds();
    if (authorizedOrgIds.size === 0) {
      return jsonOk({ firstView: false, welcomeGrantUsd: null }, { "cache-control": "no-store" });
    }
    const org = await resolveActiveOrg();
    const supabase = await createServerSupabaseClient();

    const welcomeGrantUsd = await readLaunchGrantUsd(supabase, org.id);
    if (welcomeGrantUsd === null || welcomeGrantUsd <= 0) {
      // Nothing announceable (no launch grant yet, or an unreadable ledger):
      // do not spend the once-ever claim on it.
      return jsonOk({ firstView: false, welcomeGrantUsd: null }, { "cache-control": "no-store" });
    }

    const { error } = await supabase.from("user_credit_welcome").insert({ user_id: user.id });
    if (error) {
      // 23505: the row already exists (an earlier visit, or a concurrent tab
      // that won the race), so this caller is not the first view.
      if (error.code === "23505") {
        return jsonOk(
          { firstView: false, welcomeGrantUsd },
          { "cache-control": "no-store" }
        );
      }
      return Response.json({ error: error.message }, { status: 500 });
    }
    return jsonOk({ firstView: true, welcomeGrantUsd }, { "cache-control": "no-store" });
  } catch (error) {
    return jsonError(error);
  }
}
