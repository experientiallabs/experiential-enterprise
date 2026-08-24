import { NextResponse, type NextRequest } from "next/server";

import { isPlatformAdmin } from "@/lib/auth/admin";
import { getDataSource } from "@/lib/data-source";
import type {
  ExperientialCloudCreateInput,
  ExperientialCloudUpdateInput
} from "@/lib/experiential-cloud/types";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Every Experiential Cloud serving lane (model_providers rows with
 * provider = "experiential_cloud"): model, endpoint, provider_model_id, prices,
 * and ON/OFF state. Platform-admin surface; anyone else gets the standard
 * not-found. The upstream bearer is a worker secret and never appears here.
 */
export async function GET(): Promise<Response> {
  try {
    if (!(await isPlatformAdmin())) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(await getDataSource().listAdminExperientialCloud());
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Attach an Experiential Cloud lane to a public model. Creating it defaults to
 * OFF (disabled) so it is staged and never serves until an operator flips it ON.
 * Platform-admin surface; the backend re-validates and resolves the slug.
 */
export async function POST(request: NextRequest): Promise<Response> {
  try {
    if (!(await isPlatformAdmin())) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const parsed = parseCreateInput(body);
    if ("error" in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const deployment = await getDataSource().createAdminExperientialCloud(parsed.value);
    return NextResponse.json(deployment, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}

/** A required non-blank string field, or an error message naming it. */
function requireString(
  body: Record<string, unknown>,
  field: string
): { value: string } | { error: string } {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") {
    return { error: `${field} is required.` };
  }
  return { value: value.trim() };
}

/** An optional non-blank string field (absent/empty -> undefined). */
function optionalString(
  body: Record<string, unknown>,
  field: string
): { value: string | undefined } | { error: string } {
  const value = body[field];
  if (value === undefined || value === null || value === "") {
    return { value: undefined };
  }
  if (typeof value !== "string") {
    return { error: `${field} must be a string.` };
  }
  return { value: value.trim() };
}

/** An optional non-negative integer price (absent/empty -> undefined). */
function optionalPrice(
  body: Record<string, unknown>,
  field: string
): { value: number | undefined } | { error: string } {
  const value = body[field];
  if (value === undefined || value === null || value === "") {
    return { value: undefined };
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return { error: `${field} must be a non-negative integer (micro-USD per million tokens).` };
  }
  return { value };
}

const PRICE_FIELDS = [
  "input_micro_usd_per_million",
  "cached_input_micro_usd_per_million",
  "output_micro_usd_per_million",
  "reasoning_micro_usd_per_million"
] as const;

/** Collect the shared hookup fields (endpoint, prices, source) or an error. */
function parseHookup(
  body: Record<string, unknown>
): { value: Omit<ExperientialCloudUpdateInput, "provider_model_id"> } | { error: string } {
  const baseUrl = optionalString(body, "base_url");
  if ("error" in baseUrl) {
    return baseUrl;
  }
  const pricingSource = optionalString(body, "pricing_source");
  if ("error" in pricingSource) {
    return pricingSource;
  }
  const value: Omit<ExperientialCloudUpdateInput, "provider_model_id"> = {
    base_url: baseUrl.value,
    pricing_source: pricingSource.value
  };
  for (const field of PRICE_FIELDS) {
    const price = optionalPrice(body, field);
    if ("error" in price) {
      return price;
    }
    if (price.value !== undefined) {
      value[field] = price.value;
    }
  }
  return { value };
}

/** Validate the create body: a public model slug, a wire id, optional hookup. */
export function parseCreateInput(
  body: Record<string, unknown> | null
): { value: ExperientialCloudCreateInput } | { error: string } {
  if (body === null || typeof body !== "object") {
    return { error: "A JSON body is required." };
  }
  const slug = requireString(body, "slug");
  if ("error" in slug) {
    return slug;
  }
  const providerModelId = requireString(body, "provider_model_id");
  if ("error" in providerModelId) {
    return providerModelId;
  }
  const hookup = parseHookup(body);
  if ("error" in hookup) {
    return hookup;
  }
  const status = body.status;
  if (status !== undefined && status !== "active" && status !== "disabled") {
    return { error: "status must be 'active' or 'disabled'." };
  }
  return {
    value: {
      slug: slug.value,
      provider_model_id: providerModelId.value,
      ...hookup.value,
      ...(status === "active" ? { status } : {})
    }
  };
}

/** Validate the update body: a wire id plus the optional hookup fields. */
export function parseUpdateInput(
  body: Record<string, unknown> | null
): { value: ExperientialCloudUpdateInput } | { error: string } {
  if (body === null || typeof body !== "object") {
    return { error: "A JSON body is required." };
  }
  const providerModelId = requireString(body, "provider_model_id");
  if ("error" in providerModelId) {
    return providerModelId;
  }
  const hookup = parseHookup(body);
  if ("error" in hookup) {
    return hookup;
  }
  return { value: { provider_model_id: providerModelId.value, ...hookup.value } };
}
