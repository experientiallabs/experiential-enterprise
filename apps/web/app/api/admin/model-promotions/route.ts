import { NextResponse, type NextRequest } from "next/server";

import { isPlatformAdmin } from "@/lib/auth/admin";
import { getDataSource } from "@/lib/data-source";
import { jsonError } from "@/lib/http";
import { revalidateModelsCatalog } from "@/lib/models-catalog/server";
import type {
  ModelPromotionCreateInput,
  PromotionCapScope,
  PromotionFundingScope,
} from "@/lib/promotions/types";

export const dynamic = "force-dynamic";

const CAP_SCOPES: readonly PromotionCapScope[] = ["lifetime", "recurring"];
const FUNDING_SCOPES: readonly PromotionFundingScope[] = ["all", "platform_funded", "byok"];

// Audience org-label keys share the org_labels.key slug shape.
const LABEL_KEY_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * List the promotional set for the admin panel. Platform-admin surface;
 * anyone else gets the standard not-found.
 */
export async function GET(): Promise<Response> {
  try {
    if (!(await isPlatformAdmin())) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const promotions = await getDataSource().listAdminModelPromotions();
    return NextResponse.json({ promotions });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Create a promotion: a labeled scope (concrete model slugs and/or provider
 * lanes) with its free cap, discount cap, and percent discount. Platform-admin
 * surface; the backend re-validates (unknown slugs are its 400).
 */
export async function POST(request: NextRequest): Promise<Response> {
  try {
    if (!(await isPlatformAdmin())) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const parsed = parsePromotionInput(body);
    if ("error" in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const promotion = await getDataSource().createAdminModelPromotion(parsed.value);
    // Promotions render on the shared cached public catalog; bust it so the
    // change shows on the next read instead of waiting out the window.
    revalidateModelsCatalog();
    return NextResponse.json(promotion, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}

/** True when the value is an array of non-empty strings (possibly empty). */
function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.trim() !== "")
  );
}

/**
 * Validate an admin promotion body into the typed full-resource input. Shared
 * by create and update — both carry the whole resource (the id rides the path).
 */
export function parsePromotionInput(
  body: Record<string, unknown> | null
): { value: ModelPromotionCreateInput } | { error: string } {
  if (body === null || typeof body !== "object") {
    return { error: "A JSON body is required." };
  }
  const label = body.label;
  if (typeof label !== "string" || label.trim() === "") {
    return { error: "label must be a non-empty string." };
  }
  if (!isStringArray(body.model_slugs)) {
    return { error: "model_slugs must be an array of catalog model slugs." };
  }
  if (!isStringArray(body.family_keys)) {
    return { error: "family_keys must be an array of family keys." };
  }
  if (!isStringArray(body.providers)) {
    return { error: "providers must be an array of provider keys." };
  }
  // A promotion must scope to something: concrete models and/or provider lanes
  // (an empty slug list means "all models via the selected providers").
  if (body.model_slugs.length === 0 && body.providers.length === 0) {
    return { error: "At least one of model_slugs or providers must be non-empty." };
  }
  const cap = body.per_org_cap_micro_usd;
  if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 0) {
    return { error: "per_org_cap_micro_usd must be a non-negative integer (0 = no free tier)." };
  }
  const discountCap = body.discount_cap_micro_usd;
  if (typeof discountCap !== "number" || !Number.isInteger(discountCap) || discountCap < 0) {
    return { error: "discount_cap_micro_usd must be a non-negative integer (0 = uncapped)." };
  }
  const capScope = body.cap_scope;
  if (typeof capScope !== "string" || !CAP_SCOPES.includes(capScope as PromotionCapScope)) {
    return { error: "cap_scope must be 'lifetime' or 'recurring'." };
  }
  const percentOff = body.percent_off;
  if (typeof percentOff !== "number" || !Number.isFinite(percentOff) || percentOff < 0 || percentOff > 100) {
    return { error: "percent_off must be a number between 0 and 100." };
  }
  const active = body.active;
  if (typeof active !== "boolean") {
    return { error: "active must be a boolean." };
  }
  const displayOrder = body.display_order;
  if (typeof displayOrder !== "number" || !Number.isInteger(displayOrder)) {
    return { error: "display_order must be an integer." };
  }
  // Audience is optional (absent = every account); when present it must be a
  // list of org-label key slugs the org must ALL carry.
  const audienceRaw = body.audience_labels ?? [];
  if (!isStringArray(audienceRaw) || !audienceRaw.every((key) => LABEL_KEY_PATTERN.test(key))) {
    return { error: "audience_labels must be an array of org-label key slugs." };
  }
  // Funding scope is optional (absent = platform-funded, the prior behavior).
  const fundingRaw = body.funding_scope ?? "platform_funded";
  if (typeof fundingRaw !== "string" || !FUNDING_SCOPES.includes(fundingRaw as PromotionFundingScope)) {
    return { error: "funding_scope must be one of all, platform_funded, byok." };
  }
  return {
    value: {
      label: label.trim(),
      model_slugs: body.model_slugs,
      family_keys: body.family_keys,
      providers: body.providers,
      audience_labels: audienceRaw,
      funding_scope: fundingRaw as PromotionFundingScope,
      per_org_cap_micro_usd: cap,
      discount_cap_micro_usd: discountCap,
      cap_scope: capScope as PromotionCapScope,
      percent_off: percentOff,
      active,
      display_order: displayOrder,
    },
  };
}
