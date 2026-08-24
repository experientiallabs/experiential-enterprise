// TypeScript mirrors of the admin Experiential Cloud lane views
// (explabs/api/routes/experiential_cloud_admin.py — ExperientialCloudDeploymentView
// / ExperientialCloudListView and the create/update/status bodies). An
// Experiential Cloud lane is one model_providers row with
// provider = "experiential_cloud" on a public model. Prices are integer
// micro-USD per million tokens; null means unknown and must never render as $0.
// The upstream bearer is a worker secret and never appears in any of these
// shapes.

import type { CatalogDeployment } from "@/lib/models-catalog/types";

/** One Experiential Cloud serving lane joined to its public model. */
export type ExperientialCloudDeployment = {
  slug: string;
  display_name: string;
  deployment: CatalogDeployment;
};

/**
 * The admin listing envelope. `worker_base_url_configured` reflects only the
 * control process's environment (an advisory hint for the ON-without-endpoint
 * warning), not the gateway worker's authoritative origin.
 */
export type ExperientialCloudList = {
  deployments: ExperientialCloudDeployment[];
  worker_base_url_configured: boolean;
};

/** ON serves real traffic; OFF (the create default) stages the lane. */
export type ExperientialCloudStatus = "active" | "disabled";

/** Create payload for POST /api/admin/experiential-cloud (defaults OFF). */
export type ExperientialCloudCreateInput = {
  slug: string;
  provider_model_id: string;
  base_url?: string;
  input_micro_usd_per_million?: number;
  cached_input_micro_usd_per_million?: number;
  output_micro_usd_per_million?: number;
  reasoning_micro_usd_per_million?: number;
  pricing_source?: string;
  status?: ExperientialCloudStatus;
};

/** Update payload for PATCH /api/admin/experiential-cloud/{id} (hookup info). */
export type ExperientialCloudUpdateInput = {
  provider_model_id: string;
  base_url?: string;
  input_micro_usd_per_million?: number;
  cached_input_micro_usd_per_million?: number;
  output_micro_usd_per_million?: number;
  reasoning_micro_usd_per_million?: number;
  pricing_source?: string;
};
