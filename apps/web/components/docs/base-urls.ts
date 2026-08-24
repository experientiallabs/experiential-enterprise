import { publicServingBaseUrl } from "@/components/world-models/endpoint-snippets";

// The ONE place docs snippets get their API base URL. It resolves through the
// same env-driven helper every other product surface uses (hosted
// api.experientiallabs.ai by default, EXPLABS_PUBLIC_BACKEND_URL for a
// self-hosted or local stack), so flipping the customer-facing domain family
// is a deploy/env change, never a docs edit.

/** The serving/management API base URL every docs code block interpolates. */
export function docsApiBaseUrl(): string {
  return publicServingBaseUrl();
}
