import { resolveActiveOrg } from "@/lib/active-org";
import { requireAuthorizedOrgIds } from "@/lib/auth/orgs";
import { createServerSupabaseClient, requireAuthenticatedUser } from "@/lib/auth/server";
import { readLaunchGrantUsd } from "@/lib/billing/launch-grant";
import { jsonError, jsonOk } from "@/lib/http";

export const dynamic = "force-dynamic";

const SILENT = { show: false, displayCreditUsd: null, showApiKey: false } as const;

/**
 * Decide whether to show the re-triggerable welcome celebration for the signed-
 * in user in their active org, and CLAIM this showing so it does not repeat.
 *
 * An admin arms the celebration per org (org_welcome_trigger.active) and each
 * activation bumps `triggered_at`. A user has "seen" a given activation once
 * their user_welcome_trigger_seen row records that `triggered_at`. This POST is
 * the arbiter: it returns `show: true` only when the trigger is active AND the
 * user has not yet seen THIS activation, advancing their seen marker to the
 * current `triggered_at` in the SAME atomic statement (claim_welcome_trigger_
 * showing), so a second visit — or a concurrent second tab racing the first —
 * returns `show: false`. Exactly one caller wins. Re-arming (a fresh
 * `triggered_at`) makes it show again, exactly once, even to a prior viewer.
 *
 * `displayCreditUsd` is the figure to announce: the admin-chosen amount, or —
 * when the admin left it null — the org's launch-grant event amount, the same
 * value the signup greeting uses. All reads run RLS-scoped from the user's own
 * session, so a caller can only ever see and claim their own org's trigger. A
 * memberless session or any transient failure resolves silent rather than
 * throwing: a missed celebration is acceptable; a crashed shell is not.
 */
export async function POST(): Promise<Response> {
  try {
    await requireAuthenticatedUser();
    const authorizedOrgIds = await requireAuthorizedOrgIds();
    if (authorizedOrgIds.size === 0) {
      return jsonOk(SILENT, { "cache-control": "no-store" });
    }
    const org = await resolveActiveOrg();
    const supabase = await createServerSupabaseClient();

    const { data: trigger } = await supabase
      .from("org_welcome_trigger")
      .select("active, display_credit_usd, show_api_key, triggered_at")
      .eq("org_id", org.id)
      .maybeSingle();
    if (trigger === null || trigger.active !== true) {
      return jsonOk(SILENT, { "cache-control": "no-store" });
    }

    // Claim this showing atomically: the DB advances the caller's seen marker to
    // the activation and reports whether THIS call won — a single conditional
    // upsert, so two concurrent tabs cannot both show a once-only celebration.
    // A lost race or any failure resolves silent; a later visit can still greet.
    const { data: won, error: claimError } = await supabase.rpc("claim_welcome_trigger_showing", {
      in_org: org.id,
      in_triggered_at: trigger.triggered_at
    });
    if (claimError || won !== true) {
      return jsonOk(SILENT, { "cache-control": "no-store" });
    }

    // PostgREST may serialize a numeric column as a string to preserve
    // precision; coerce before comparing, and fall back to the launch grant.
    const chosen = Number(trigger.display_credit_usd);
    const displayCreditUsd =
      Number.isFinite(chosen) && chosen > 0
        ? chosen
        : await readLaunchGrantUsd(supabase, org.id);

    return jsonOk(
      {
        show: true,
        displayCreditUsd: displayCreditUsd !== null && displayCreditUsd > 0 ? displayCreditUsd : null,
        showApiKey: trigger.show_api_key === true
      },
      { "cache-control": "no-store" }
    );
  } catch (error) {
    return jsonError(error);
  }
}
