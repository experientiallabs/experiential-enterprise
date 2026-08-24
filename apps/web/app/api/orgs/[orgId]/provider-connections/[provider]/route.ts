import { NextResponse, type NextRequest } from "next/server";

import { createServiceRoleSupabaseClient, isPlatformAdmin } from "@/lib/auth/admin";
import { isOrgAdmin } from "@/lib/auth/admin-orgs";
import { requireOrgId } from "@/lib/auth/orgs";
import { requireAuthenticatedUser } from "@/lib/auth/server";
import { getDataSource } from "@/lib/data-source";
import { jsonError } from "@/lib/http";
import {
  MODEL_PROVIDERS,
  isModelProvider,
  isSpendKeyProvider,
  mainSlotAdminKeyError,
  parseAzureConfig,
  parseBedrockConfig,
  parseFireworksConfig,
  parseModalSecret,
  parseSpendSecret,
  type ModelProvider,
  type ProviderConnectionCheck
} from "@/lib/model-providers";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string; provider: string }>;
};

/**
 * Connect or rotate this org's own account with one model provider. The same
 * shape as the trace-connection route: the key goes straight into the
 * Vault-backed upsert RPC and is never echoed back, and only the non-secret
 * config lands on the row.
 *
 * A successful save runs the hookup check inline and returns its verdict, so
 * the UI renders the verified state in the same round-trip — health comes up
 * the moment a key is hooked up, and there is no manual recheck surface.
 */
export async function PUT(request: NextRequest, context: Context): Promise<Response> {
  try {
    const gate = await requireProviderManager(context);
    if (gate instanceof NextResponse) {
      return gate;
    }
    const body = (await request.json().catch(() => null)) as {
      secret?: unknown;
      config?: unknown;
      spendSecret?: unknown;
    } | null;
    let secret: string;
    if (gate.provider === "modal") {
      // Modal's credential is the token pair, stored as one JSON Vault secret.
      const parsed = parseModalSecret(body?.secret);
      if ("error" in parsed) {
        return NextResponse.json({ error: parsed.error }, { status: 400 });
      }
      secret = parsed.secret;
    } else {
      secret = typeof body?.secret === "string" ? body.secret.trim() : "";
      if (secret.length === 0) {
        const noun = gate.provider === "bedrock" ? "A secret access key" : "An API key";
        return NextResponse.json({ error: `${noun} is required.` }, { status: 400 });
      }
      // An ADMIN key in the main slot would save fine and then fail every
      // inference call; refuse it before anything is stored, naming both types.
      const misplaced = mainSlotAdminKeyError(gate.provider, secret);
      if (misplaced !== null) {
        return NextResponse.json({ error: misplaced }, { status: 400 });
      }
    }
    // The optional second credential: the provider ADMIN key, spend-reporting
    // only, offered for Anthropic and OpenAI. Validated by prefix in both
    // directions before either secret is stored.
    let spendSecret: string | null = null;
    if (body?.spendSecret !== undefined && body.spendSecret !== null) {
      if (!isSpendKeyProvider(gate.provider)) {
        return NextResponse.json(
          { error: "Only Anthropic and OpenAI connections take an admin key for spend." },
          { status: 400 }
        );
      }
      const parsed = parseSpendSecret(gate.provider, body.spendSecret);
      if ("error" in parsed) {
        return NextResponse.json({ error: parsed.error }, { status: 400 });
      }
      spendSecret = parsed.secret;
    }
    // Azure, Bedrock, and Fireworks carry required non-secret config; the
    // key-only providers bill off the key alone, so anything they send is
    // dropped rather than stored.
    let config: Record<string, unknown> = {};
    if (gate.provider === "azure_openai") {
      const parsed = parseAzureConfig(body?.config);
      if ("error" in parsed) {
        return NextResponse.json({ error: parsed.error }, { status: 400 });
      }
      config = { ...parsed };
    }
    if (gate.provider === "bedrock") {
      const parsed = parseBedrockConfig(body?.config);
      if ("error" in parsed) {
        return NextResponse.json({ error: parsed.error }, { status: 400 });
      }
      config = { ...parsed };
    }
    if (gate.provider === "fireworks") {
      const parsed = parseFireworksConfig(body?.config);
      if ("error" in parsed) {
        return NextResponse.json({ error: parsed.error }, { status: 400 });
      }
      config = { ...parsed };
    }
    const admin = createServiceRoleSupabaseClient();
    const { data, error } = await admin.rpc("upsert_provider_connection", {
      in_org_id: gate.orgId,
      in_provider: gate.provider,
      in_config: config,
      in_secret: secret,
      in_actor: gate.userId
    });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const row = Array.isArray(data) ? data[0] : data;
    let spendError: string | null = null;
    if (spendSecret !== null) {
      // Stored after the main key so a fresh connection exists to ride; the
      // hookup check below then verifies BOTH credentials in one pass and
      // reports the admin key's verdict under status_detail.spend_key.
      const spendWrite = await admin.rpc("set_provider_connection_spend_credential", {
        in_org_id: gate.orgId,
        in_provider: gate.provider,
        in_secret: spendSecret,
        in_actor: gate.userId
      });
      if (spendWrite.error) {
        // The main credential is already committed (and the serving key
        // rotated), so this is a partial success, not a failed save: report
        // the saved connection with an explicit spend-key error rather than a
        // 500 that would tell the admin nothing saved and hide the rotation.
        spendError = spendWrite.error.message;
      }
    }
    return NextResponse.json({ connection: row, check: await runHookupCheck(gate), spendError });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * The inline hookup check. The key is already saved when this runs, so a
 * check we cannot complete must not fail the PUT: the row honestly stays
 * `unchecked` and the verdict says the verification itself was unreachable.
 */
async function runHookupCheck(gate: {
  orgId: string;
  provider: ModelProvider;
}): Promise<ProviderConnectionCheck> {
  try {
    return await getDataSource().checkProviderConnection(gate.orgId, gate.provider);
  } catch {
    return {
      provider: gate.provider,
      status: "unchecked",
      status_detail: {
        remediation:
          "The key was saved, but the verification service could not be reached to " +
          "check it. Real traffic will verify it, or rotate the key to re-run the check."
      },
      status_checked_at: null,
      status_source: null
    };
  }
}

/**
 * Declare (or clear) the remaining credit on the org's own provider account.
 * We cannot read a customer's balance from their provider, so they tell us
 * what is left and we draw it down as metered usage flows through the key.
 * Re-declaring resets the drawdown counter in the same statement, so
 * "remaining" always means "declared minus what we metered since you told
 * us". A null balance turns tracking off.
 */
export async function PATCH(request: NextRequest, context: Context): Promise<Response> {
  try {
    const gate = await requireProviderManager(context);
    if (gate instanceof NextResponse) {
      return gate;
    }
    const body = (await request.json().catch(() => null)) as {
      declared_balance_usd?: unknown;
      low_balance_threshold_usd?: unknown;
    } | null;
    if (body === null) {
      return NextResponse.json({ error: "A JSON body is required." }, { status: 400 });
    }
    const declared = body.declared_balance_usd;
    if (declared !== null && (typeof declared !== "number" || !Number.isFinite(declared) || declared < 0)) {
      return NextResponse.json(
        { error: "declared_balance_usd must be a non-negative number, or null to stop tracking." },
        { status: 400 }
      );
    }
    const changes: Record<string, unknown> = {
      declared_balance_usd: declared,
      declared_balance_set_at: declared === null ? null : new Date().toISOString(),
      metered_spend_usd: 0
    };
    const threshold = body.low_balance_threshold_usd;
    if (threshold !== undefined) {
      if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0) {
        return NextResponse.json(
          { error: "low_balance_threshold_usd must be a non-negative number." },
          { status: 400 }
        );
      }
      changes.low_balance_threshold_usd = threshold;
    }
    const admin = createServiceRoleSupabaseClient();
    const { data, error } = await admin
      .from("provider_connections")
      .update(changes)
      .eq("org_id", gate.orgId)
      .eq("provider", gate.provider)
      .select(
        "id, provider, declared_balance_usd, declared_balance_set_at, metered_spend_usd, low_balance_threshold_usd"
      );
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      return NextResponse.json({ error: "Connection not found." }, { status: 404 });
    }
    if (declared !== null && declared !== undefined) {
      // Every declare is also a snapshot, labeled self_reported so it never
      // masquerades as a provider read — this is what lets the Overview show
      // the gauge changing over time beside the real provider readings.
      const snapshot = await admin.from("provider_account_snapshots").insert({
        org_id: gate.orgId,
        connection_id: (row as { id: string }).id,
        provider: gate.provider,
        credits_remaining_usd: declared,
        source: "self_reported"
      });
      if (snapshot.error) {
        return NextResponse.json({ error: snapshot.error.message }, { status: 500 });
      }
    }
    return NextResponse.json({ connection: row });
  } catch (error) {
    return jsonError(error);
  }
}

/** Disconnect: the definer RPC removes the row and both its Vault secrets. */
export async function DELETE(_request: NextRequest, context: Context): Promise<Response> {
  try {
    const gate = await requireProviderManager(context);
    if (gate instanceof NextResponse) {
      return gate;
    }
    const admin = createServiceRoleSupabaseClient();
    const { data, error } = await admin.rpc("delete_provider_connection", {
      in_org_id: gate.orgId,
      in_provider: gate.provider
    });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (data !== true) {
      return NextResponse.json({ error: "Connection not found." }, { status: 404 });
    }
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return jsonError(error);
  }
}

/** Resolve org + provider and require org-admin (or experiential-admin) rights. */
async function requireProviderManager(
  context: Context
): Promise<NextResponse | { orgId: string; provider: ModelProvider; userId: string }> {
  const { orgId: orgIdentifier, provider } = await context.params;
  if (!isModelProvider(provider)) {
    return NextResponse.json(
      { error: `provider must be one of: ${MODEL_PROVIDERS.join(", ")}.` },
      { status: 400 }
    );
  }
  const user = await requireAuthenticatedUser();
  const orgId = await requireOrgId(orgIdentifier);
  const canManage = (await isPlatformAdmin()) || (await isOrgAdmin(user.id, orgId));
  if (!canManage) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return { orgId, provider, userId: user.id };
}
