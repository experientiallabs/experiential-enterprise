import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ apiKeyId: string }>;
};

// Range rails mirroring the backend's KeyLimitsRequest so a bad write is a 400
// at this boundary. The upper bounds are sanity rails far above any real
// configuration: they exist so a unit mistake (dollars vs micro-USD) fails
// loudly instead of arming an absurd cap.
const CAP_MIN = 0;
const CAP_MAX = 1e15;
const RPM_MIN = 1;
const RPM_MAX = 100_000;
const TPM_MIN = 1;
const TPM_MAX = 1e9;

// Full-resource write: absent and null both mean "explicitly uncapped" and
// normalize to null; anything else must be an integer inside the rails.
function boundedInt(value: unknown, min: number, max: number): number | null | "invalid" {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return "invalid";
  }
  return value;
}

/**
 * One key's effective gateway guardrails, defaults included. A straight proxy:
 * the backend resolves the key's owning org and gates the read at org-member
 * strength (a foreign key id 404s exactly like an absent one).
 */
export async function GET(_request: Request, context: Context): Promise<Response> {
  try {
    const { apiKeyId } = await context.params;
    const limits = await getDataSource().getGatewayKeyLimits(apiKeyId);
    return jsonOk(limits, { "cache-control": "no-store" });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Replace one key's guardrails (the backend gates on org ADMIN). Full-resource
 * semantics by backend contract: the row becomes exactly the body, so all
 * three fields are forwarded on every write and null means explicitly
 * uncapped, never "keep the previous value".
 */
export async function PUT(request: Request, context: Context): Promise<Response> {
  try {
    const { apiKeyId } = await context.params;
    const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return Response.json({ error: "A JSON object body is required." }, { status: 400 });
    }
    const cap = boundedInt(payload.daily_spend_cap_micro_usd, CAP_MIN, CAP_MAX);
    const requestsPerMinute = boundedInt(payload.requests_per_minute, RPM_MIN, RPM_MAX);
    const tokensPerMinute = boundedInt(payload.tokens_per_minute, TPM_MIN, TPM_MAX);
    if (cap === "invalid" || requestsPerMinute === "invalid" || tokensPerMinute === "invalid") {
      return Response.json(
        {
          error:
            "Limits must be integers: daily_spend_cap_micro_usd 0 to 1e15, " +
            "requests_per_minute 1 to 100000, tokens_per_minute 1 to 1e9; null means uncapped."
        },
        { status: 400 }
      );
    }
    const limits = await getDataSource().putGatewayKeyLimits(apiKeyId, {
      daily_spend_cap_micro_usd: cap,
      requests_per_minute: requestsPerMinute,
      tokens_per_minute: tokensPerMinute
    });
    return jsonOk(limits, { "cache-control": "no-store" });
  } catch (error) {
    return jsonError(error);
  }
}
