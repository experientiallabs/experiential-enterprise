import { NextResponse, type NextRequest } from "next/server";

import { recordAuditEvent } from "@/lib/audit";
import { createServiceRoleSupabaseClient, isPlatformAdmin } from "@/lib/auth/admin";
import { isOrgAdmin } from "@/lib/auth/admin-orgs";
import { requireAuthenticatedUser } from "@/lib/auth/server";
import {
  DEFAULT_AUTORECHARGE_AMOUNT_USD,
  DEFAULT_AUTORECHARGE_THRESHOLD_USD,
  type AutoRechargeSettings
} from "@/lib/billing/constants";
import { parseAutoRechargeThresholdUsd, parseTopupAmountUsd } from "@/lib/billing/stripe";
import { requireOrg } from "@/lib/data-cache";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

type SettingsRow = {
  enabled: boolean;
  threshold_usd: number;
  amount_usd: number;
  stripe_payment_method_id: string | null;
  last_recharge_at: string | null;
  consecutive_failures: number;
  last_failure_message: string | null;
};

/**
 * Read an org's auto-recharge state. Admin-gated (a top-up is an admin power)
 * and sanitized: the Stripe handles stay server-side, the client learns only
 * whether a card is saved. An org that never opted in reads as the defaults
 * with no card, which is exactly what the credits-page control renders.
 */
export async function GET(request: NextRequest, context: Context): Promise<Response> {
  try {
    const org = await authorize(context);
    if (org === null) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const admin = createServiceRoleSupabaseClient();
    const result = await admin
      .from("org_auto_recharge_settings")
      .select(
        "enabled, threshold_usd, amount_usd, stripe_payment_method_id, last_recharge_at, consecutive_failures, last_failure_message"
      )
      .eq("org_id", org.id)
      .maybeSingle();
    if (result.error) {
      console.error(`auto-recharge settings read failed: ${result.error.message}`);
      return NextResponse.json({ error: "Unable to read auto-recharge settings." }, { status: 500 });
    }
    return NextResponse.json(toDto(result.data as SettingsRow | null));
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Update an org's auto-recharge settings: toggle it, or change the amount and
 * threshold. A card cannot be added here (that only happens through a consented
 * Checkout); this row is created lazily so an org can pre-configure before its
 * first save, but auto-recharge only actually fires once a card exists. Saving
 * clears any decline back-off so a fixed card resumes.
 */
export async function PATCH(request: NextRequest, context: Context): Promise<Response> {
  try {
    const org = await authorize(context);
    if (org === null) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const body = (await request.json().catch(() => null)) as {
      enabled?: unknown;
      threshold_usd?: unknown;
      amount_usd?: unknown;
    } | null;

    const update: Record<string, unknown> = { org_id: org.id, updated_at: new Date().toISOString() };
    if (body?.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") {
        return NextResponse.json({ error: "enabled must be a boolean." }, { status: 400 });
      }
      update.enabled = body.enabled;
    }
    if (body?.amount_usd !== undefined) {
      const amount = parseTopupAmountUsd(body.amount_usd);
      if (typeof amount !== "number") {
        return NextResponse.json({ error: amount.error }, { status: 400 });
      }
      update.amount_usd = amount;
    }
    if (body?.threshold_usd !== undefined) {
      const threshold = parseAutoRechargeThresholdUsd(body.threshold_usd);
      if (typeof threshold !== "number") {
        return NextResponse.json({ error: threshold.error }, { status: 400 });
      }
      update.threshold_usd = threshold;
    }
    // A save is an explicit re-arm: clear the decline back-off so the next low
    // balance retries the (presumably fixed) card.
    update.consecutive_failures = 0;
    update.last_failure_at = null;
    update.last_failure_message = null;

    const admin = createServiceRoleSupabaseClient();
    const result = await admin
      .from("org_auto_recharge_settings")
      .upsert(update, { onConflict: "org_id" })
      .select(
        "enabled, threshold_usd, amount_usd, stripe_payment_method_id, last_recharge_at, consecutive_failures, last_failure_message"
      )
      .maybeSingle();
    if (result.error) {
      console.error(`auto-recharge settings write failed: ${result.error.message}`);
      return NextResponse.json({ error: "Unable to save auto-recharge settings." }, { status: 500 });
    }
    const dto = toDto(result.data as SettingsRow | null);
    await recordAuditEvent(admin, {
      orgId: org.id,
      actorKind: org.platformAdmin ? "platform_admin" : "user",
      actorId: org.actorId,
      action: "billing.auto_recharge_set",
      objectType: "organization",
      objectId: org.id,
      after: { enabled: dto.enabled, thresholdUsd: dto.thresholdUsd, amountUsd: dto.amountUsd }
    });
    return NextResponse.json(dto);
  } catch (error) {
    return jsonError(error);
  }
}

/** Resolve the org and confirm the caller may manage its billing; null = 404. */
async function authorize(
  context: Context
): Promise<{ id: string; actorId: string; platformAdmin: boolean } | null> {
  const { orgId } = await context.params;
  const user = await requireAuthenticatedUser();
  const org = await requireOrg(orgId);
  const platformAdmin = await isPlatformAdmin();
  const canManage = platformAdmin || (await isOrgAdmin(user.id, org.id));
  return canManage ? { id: org.id, actorId: user.id, platformAdmin } : null;
}

function toDto(row: SettingsRow | null): AutoRechargeSettings {
  if (row === null) {
    return {
      enabled: true,
      thresholdUsd: DEFAULT_AUTORECHARGE_THRESHOLD_USD,
      amountUsd: DEFAULT_AUTORECHARGE_AMOUNT_USD,
      hasPaymentMethod: false,
      lastRechargeAt: null,
      consecutiveFailures: 0,
      lastFailureMessage: null
    };
  }
  return {
    enabled: row.enabled,
    thresholdUsd: Number(row.threshold_usd),
    amountUsd: Number(row.amount_usd),
    hasPaymentMethod: row.stripe_payment_method_id !== null,
    lastRechargeAt: row.last_recharge_at,
    consecutiveFailures: row.consecutive_failures,
    lastFailureMessage: row.last_failure_message
  };
}
