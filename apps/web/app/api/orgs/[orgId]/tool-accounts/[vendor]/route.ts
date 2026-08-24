import { NextResponse, type NextRequest } from "next/server";

import { isPlatformAdmin } from "@/lib/auth/admin";
import { isOrgAdmin } from "@/lib/auth/admin-orgs";
import { requireOrgId } from "@/lib/auth/orgs";
import { requireAuthenticatedUser } from "@/lib/auth/server";
import { orgIsYcCompany } from "@/lib/billing/tool-accounts-server";
import { getDataSource } from "@/lib/data-source";
import { jsonError } from "@/lib/http";
import {
  TRACKED_TOOL_VENDORS,
  isTrackedToolVendor,
  isYcGatedToolVendor,
  type TrackedToolVendor
} from "@/lib/tool-accounts";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string; vendor: string }>;
};

/**
 * Declare (or clear) the self-reported balance on the org's tool account, set
 * the low-balance threshold, or store the dashboard login the balance fetcher
 * uses. Full-resource upsert against the backend; the credential never comes
 * back. Tool accounts have no gateway metering, so the declared balance IS the
 * remaining balance, and there is no drawdown counter to reset.
 */
export async function PUT(request: NextRequest, context: Context): Promise<Response> {
  try {
    const gate = await requireToolAccountManager(context);
    if (gate instanceof NextResponse) {
      return gate;
    }
    const body = (await request.json().catch(() => null)) as {
      declared_balance_usd?: unknown;
      low_balance_threshold_usd?: unknown;
      dashboard_secret?: unknown;
    } | null;
    if (body === null) {
      return NextResponse.json({ error: "A JSON body is required." }, { status: 400 });
    }
    const changes: {
      declared_balance_usd?: number | null;
      low_balance_threshold_usd?: number;
      dashboard_secret?: string;
    } = {};
    if (body.declared_balance_usd !== undefined) {
      const declared = body.declared_balance_usd;
      if (
        declared !== null &&
        (typeof declared !== "number" || !Number.isFinite(declared) || declared < 0)
      ) {
        return NextResponse.json(
          { error: "declared_balance_usd must be a non-negative number, or null to stop tracking." },
          { status: 400 }
        );
      }
      changes.declared_balance_usd = declared;
    }
    if (body.low_balance_threshold_usd !== undefined) {
      const threshold = body.low_balance_threshold_usd;
      if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0) {
        return NextResponse.json(
          { error: "low_balance_threshold_usd must be a non-negative number." },
          { status: 400 }
        );
      }
      changes.low_balance_threshold_usd = threshold;
    }
    if (typeof body.dashboard_secret === "string") {
      changes.dashboard_secret = body.dashboard_secret;
    }
    const account = await getDataSource().upsertToolAccount(gate.orgId, gate.vendor, changes);
    return NextResponse.json(account);
  } catch (error) {
    return jsonError(error);
  }
}

/** Disconnect: the backend removes the row and any stored credential. */
export async function DELETE(_request: NextRequest, context: Context): Promise<Response> {
  try {
    const gate = await requireToolAccountManager(context);
    if (gate instanceof NextResponse) {
      return gate;
    }
    await getDataSource().deleteToolAccount(gate.orgId, gate.vendor);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Resolve org + vendor and require management rights. Vendor validation comes
 * first (400 for anything outside the tracked set), then the org-admin gate
 * (404 for members), then the YC gate: the YC-gated vendors 404 for an org that
 * is not a YC company, so they never leak. E2B is never gated.
 */
export async function requireToolAccountManager(
  context: Context
): Promise<NextResponse | { orgId: string; vendor: TrackedToolVendor; userId: string }> {
  const { orgId: orgIdentifier, vendor } = await context.params;
  if (!isTrackedToolVendor(vendor)) {
    return NextResponse.json(
      { error: `vendor must be one of: ${TRACKED_TOOL_VENDORS.join(", ")}.` },
      { status: 400 }
    );
  }
  const user = await requireAuthenticatedUser();
  const orgId = await requireOrgId(orgIdentifier);
  const canManage = (await isPlatformAdmin()) || (await isOrgAdmin(user.id, orgId));
  if (!canManage) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (isYcGatedToolVendor(vendor) && !(await orgIsYcCompany(orgId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return { orgId, vendor, userId: user.id };
}
