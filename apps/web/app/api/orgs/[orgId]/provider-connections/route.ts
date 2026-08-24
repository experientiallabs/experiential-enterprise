import { type NextRequest } from "next/server";

import { requireOrgId } from "@/lib/auth/orgs";
import { createServerSupabaseClient } from "@/lib/auth/server";
import { jsonError, jsonOk } from "@/lib/http";
import {
  listProviderConnections,
  listProviderConnectionsWithHistory
} from "@/lib/provider-connections";

export const dynamic = "force-dynamic";

// Cap the per-provider snapshot series a sparkline needs, so a large `history`
// cannot fan out into an unbounded read.
const MAX_HISTORY_POINTS = 90;

type Context = {
  params: Promise<{ orgId: string }>;
};

/**
 * List every model provider this org can connect, with the live state of each
 * connection: non-secret config, masked last4 (main + optional admin key), the
 * provider-verified status with its verbose detail, the self-reported balance
 * gauge, and the latest account snapshot. The same read the settings
 * integrations page renders — never a secret, never a Vault id.
 *
 * `?history=N` additionally returns up to N recent snapshot points per
 * connected provider (oldest→newest) for the overview credit-accounts
 * sparklines, capped at MAX_HISTORY_POINTS; a non-integer or non-positive N is
 * a 400.
 *
 * Reading is member-level, matching the settings page; requireOrgId admits
 * members and platform admins and answers everyone else with the same 404 an
 * absent org gets (never a 403). Org API keys with management scope reach this
 * list via gateway-api's _CUSTOMER_KEY_ROUTES allowlist. Mutations stay on the
 * per-provider sibling route, which demands an org admin (or a same-org key).
 */
export async function GET(request: NextRequest, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier } = await context.params;
    const orgId = await requireOrgId(orgIdentifier);

    const rawHistory = new URL(request.url).searchParams.get("history");
    let historyLimit: number | null = null;
    if (rawHistory !== null) {
      // Plain decimal digits only: Number() would otherwise accept "1e2" or
      // "0x10" as integers and let malformed requests through.
      if (!/^\d+$/.test(rawHistory) || Number(rawHistory) < 1) {
        return Response.json(
          { error: "history must be a positive integer." },
          { status: 400 }
        );
      }
      historyLimit = Math.min(Number(rawHistory), MAX_HISTORY_POINTS);
    }

    const supabase = await createServerSupabaseClient();
    const connections =
      historyLimit === null
        ? await listProviderConnections(supabase, orgId)
        : await listProviderConnectionsWithHistory(supabase, orgId, historyLimit);
    return jsonOk({ connections });
  } catch (error) {
    return jsonError(error);
  }
}
