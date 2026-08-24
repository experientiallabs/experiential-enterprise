import { NextResponse, type NextRequest } from "next/server";

import { createServiceRoleSupabaseClient } from "@/lib/auth/admin";
import { bearerMatchesCronSecret } from "@/lib/auth/cron";
import {
  sendSpendAlertEmail,
  straightLineMonthProjection
} from "@/lib/billing/spend-alert-email";
import { creditsPath } from "@/lib/routes";

export const dynamic = "force-dynamic";

// One row of gateway_spend_alerts_due(): an undelivered (alert, month) claim
// with the context its email needs. budget fields are null for the
// org_monthly_spend kind (and for a rule whose budget row was deleted).
type SpendAlertDueRow = {
  alert_id: string;
  period: string;
  kind: "org_monthly_spend" | "budget_fraction";
  org_id: string;
  org_name: string;
  notify_email: string;
  budget_id: string | null;
  budget_scope_kind: string | null;
  measured_micro_usd: number;
  threshold_micro_usd: number;
  limit_micro_usd: number | null;
  fired_at: string;
};

/**
 * The spend-alert delivery tick. pg_cron POSTs here every 15 minutes (Vault
 * secrets `spend_alerts_url` + `cron_secret` via pg_net); the DB has already
 * claimed each crossed rule's once-per-month event, so this route only turns
 * undelivered claims into emails and reports each outcome back through
 * `gateway_spend_alert_mark` (null = delivered, a reason string leaves the
 * claim for the next tick to retry). A marking failure never aborts the loop.
 * Gated by Bearer CRON_SECRET; failures answer the admin convention's
 * not-found so the route's existence is not probeable. `?dryRun=1` returns
 * the undelivered claims as JSON without sending any email; the read itself
 * takes each claim's delivery lease, so the dry run releases them again
 * (marked with a "dry run" failure) rather than stalling the real tick.
 */
export async function POST(request: NextRequest): Promise<Response> {
  if (!bearerMatchesCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const admin = createServiceRoleSupabaseClient();
  const due = await admin.rpc("gateway_spend_alerts_due");
  if (due.error) {
    console.error(`spend-alerts: claim read failed: ${due.error.message}`);
    return NextResponse.json({ error: "Reading due alerts failed." }, { status: 500 });
  }
  const rows = (due.data ?? []) as SpendAlertDueRow[];

  if (new URL(request.url).searchParams.get("dryRun") === "1") {
    // The due() read leased these rows for delivery; give the leases back so
    // a dry run never delays the next real tick.
    for (const row of rows) {
      const release = await admin.rpc("gateway_spend_alert_mark", {
        p_alert_id: row.alert_id,
        p_period: row.period,
        p_error: "dry run"
      });
      if (release.error) {
        console.error(
          `spend-alerts: dry-run lease release for ${row.alert_id}/${row.period} failed: ${release.error.message}`
        );
      }
    }
    return NextResponse.json({ processed: rows.length, rows });
  }

  const origin = process.env.EXPLABS_WEBAPP_URL ?? "https://platform.experientiallabs.ai";
  let delivered = 0;
  let failed = 0;
  for (const row of rows) {
    const result = await sendSpendAlertEmail({
      to: row.notify_email,
      orgName: row.org_name,
      kind: row.kind,
      period: row.period,
      measuredMicroUsd: row.measured_micro_usd,
      thresholdMicroUsd: row.threshold_micro_usd,
      limitMicroUsd: row.limit_micro_usd,
      budgetScopeKind: row.budget_scope_kind,
      projectedMicroUsd: straightLineMonthProjection(row.measured_micro_usd, new Date()),
      creditsUrl: `${origin}${creditsPath()}`
    });
    if (result.sent) {
      delivered += 1;
    } else {
      failed += 1;
      console.error(`spend-alerts: email for ${row.alert_id}/${row.period} not sent: ${result.reason}`);
    }
    const mark = await admin.rpc("gateway_spend_alert_mark", {
      p_alert_id: row.alert_id,
      p_period: row.period,
      p_error: result.sent ? null : result.reason
    });
    if (mark.error) {
      // The claim stays undelivered under its lease; the next tick after the
      // lease expires retries it (worst case one duplicate email for this
      // month). The rest of the batch still runs.
      console.error(
        `spend-alerts: marking ${row.alert_id}/${row.period} failed: ${mark.error.message}`
      );
    }
  }
  return NextResponse.json({ processed: rows.length, delivered, failed });
}
