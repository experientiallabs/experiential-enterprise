// Provider data controls (enterprise E5.3): wire types for the backend's
// /api/orgs/{org}/provider-data-controls (the curated posture matrix,
// member-strength and not capability-gated) and /provider-policy (the org's
// data-control policy, DATA_CONTROLS-gated) surfaces, shared by the proxy
// routes and the settings panel. The flags describe each provider's
// DOCUMENTED DEFAULT API posture, never customer-specific agreements;
// enforcement of a written policy is always-on in the gateway worker.

/** One provider's curated default data-handling posture. */
export type ProviderDataControls = {
  provider: string;
  zero_data_retention: boolean;
  no_training: boolean;
  /** The provider policy the flags are based on; rendered verbatim. */
  source_note: string;
  updated_at: string;
};

export type ProviderDataControlsList = {
  providers: ProviderDataControls[];
};

/** The org's data-control policy row. */
export type ProviderPolicy = {
  org_id: string;
  /** null = all providers allowed. */
  allowed_providers: string[] | null;
  require_zdr: boolean;
  require_no_training: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

/** The policy read/write envelope; `policy: null` means no policy is set. */
export type ProviderPolicyState = {
  org_id: string;
  policy: ProviderPolicy | null;
};

/** The full policy document a PUT replaces the org's policy with. */
export type ProviderPolicyInput = {
  allowed_providers: string[] | null;
  require_zdr: boolean;
  require_no_training: boolean;
};
