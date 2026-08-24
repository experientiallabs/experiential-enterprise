import { NextResponse, type NextRequest } from "next/server";

import { isPlatformAdmin } from "@/lib/auth/admin";
import { getDataSource } from "@/lib/data-source";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * The current recommended set (the catalog's starred band) in rank order.
 * Platform-admin surface; anyone else gets the standard not-found.
 */
export async function GET(): Promise<Response> {
  try {
    if (!(await isPlatformAdmin())) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const models = await getDataSource().listAdminRecommendedModels();
    return NextResponse.json({ models });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Replace the whole recommended set: list order becomes rank 0..N-1 on the
 * named public models and every other public model is unpinned. Platform-admin
 * surface; the backend re-validates (unknown slugs are its 400).
 */
export async function PUT(request: NextRequest): Promise<Response> {
  try {
    if (!(await isPlatformAdmin())) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const parsed = parseRecommendedInput(body);
    if ("error" in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const models = await getDataSource().replaceAdminRecommendedModels(parsed.slugs);
    return NextResponse.json({ models });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Validate the replace body: a non-empty, duplicate-free list of non-blank
 * slugs. Non-empty is a real contract, not pedantry: an all-unpinned catalog
 * reads as a fresh database to the seed guard, which would silently restore
 * the default set on the next re-seed.
 */
function parseRecommendedInput(
  body: Record<string, unknown> | null
): { slugs: string[] } | { error: string } {
  if (body === null || typeof body !== "object") {
    return { error: "A JSON body is required." };
  }
  const slugs = body.slugs;
  if (
    !Array.isArray(slugs) ||
    !slugs.every((item) => typeof item === "string" && item.trim() !== "")
  ) {
    return { error: "slugs must be an array of catalog model slugs." };
  }
  if (slugs.length === 0) {
    return { error: "The recommended set must name at least one model." };
  }
  if (new Set(slugs).size !== slugs.length) {
    return { error: "Each slug may appear once: list order defines the rank." };
  }
  return { slugs };
}
