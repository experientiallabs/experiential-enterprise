import type {
  AliasModelOption,
  AliasRevisionList,
  NamedAlias,
  NamedAliasList
} from "./aliases/types";
import type { GatewayKeyLimits, GatewayKeyLimitsInput } from "./api-keys/types";
import { auditLogQueryString, type AuditLogList, type AuditLogQuery } from "./audit-log";
import type {
  Team,
  TeamDeletion,
  TeamKeyAssignment,
  TeamList,
  TeamMember,
  TeamMemberList
} from "./teams";
import type {
  ProviderDataControlsList,
  ProviderPolicyInput,
  ProviderPolicyState
} from "./data-controls";
import { type OrgEntitlement, type OrgEntitlementsList } from "./entitlements";
import { DataSourceNotFoundError, DataSourceRequestError } from "./errors";
import type {
  GatewayDailyUsage,
  GatewayUsageGroupBy,
  GatewayUsageScope,
  PlatformDailyUsage,
  PlatformUsageGroupBy
} from "./gateway-usage";
import type {
  BudgetView,
  CreateIdentityInput,
  GrantMatrix,
  IdentityView,
  SetBudgetInput,
  UpdateIdentityInput
} from "./identities/types";
import type { CreateSpendAlertInput, SpendAlertView } from "./billing/spend-alerts";
import type {
  ModelDeploymentCheck,
  ProviderConnectionCheck,
  ProviderSpendRefresh
} from "./model-providers";
import {
  parseServingRoutingAudit,
  type ServingRoutingAuditPayload
} from "./serving-audit";
import type { ScimKeyPolicy, ScimTokenMint, ScimTokenStatus } from "./scim";
import type { OrgDomain, OrgDomainList, SsoProvider, SsoProviderUpsertInput } from "./sso";
import {
  isTrackedToolVendor,
  type BalanceFetchRunSummary,
  type ToolAccountState,
  type ToolBalanceFetchResult,
  type TrackedToolVendor
} from "./tool-accounts";
import {
  usageRequestsQueryString,
  usageTimeseriesQueryString,
  type UsageRequestsQuery,
  type UsageTimeseriesQuery
} from "./gateway-telemetry";
import { servingRequestQueryString, type ServingRequestQuery } from "./serving-telemetry";
import type {
  CatalogDeployment,
  DeploymentCreateInput,
  ModelCreateInput,
  ModelDetail,
  Waterfall
} from "./models-catalog/types";
import type {
  CreateProjectInput,
  Project,
  ProjectJob,
  ProjectList,
  ProjectListQuery,
  ProjectPreparation,
  ProjectResult,
  ProjectServingSettings,
  ProjectServingSettingsInput,
  ProjectServingUsage,
  ProjectSetup,
  ProjectSetupInput,
  ProjectRemoteTraceAcquisitionInput,
  ProjectTraceAcquisition,
  ProjectTraceConnectionList,
  ProjectTraceSource,
  ProjectTraceUploadResult
} from "./projects/types";
import type {
  CapturedPrompt,
  CreditLedgerEntry,
  Org,
  OrgBudget,
  OrgUsageReport,
  PlatformOrgUsageReport,
  ProjectDatasetSource,
  ProjectFidelity,
  ScenarioMap,
  ScenarioSet,
  ServingEndpoint,
  ServingRequestDetail,
  ServingRequestPage,
  ImportedUsage,
  InsightAnswer,
  ServingSummary,
  ServingWindow,
  CreditGatingSettings,
  SpendUnlockRequirement,
  Suggestions,
  TelemetrySettings,
  TraceEpisodesPage,
  UsageByKey,
  UsageByProvider,
  UsageByPrompt,
  UsageRequestsPage,
  UsageTimeseries,
  YcClaimResult
} from "./types";
import type { EndpointSavings, EndpointTimeseries, EndpointUsage } from "./endpoints/types";
import type {
  ExperientialCloudCreateInput,
  ExperientialCloudDeployment,
  ExperientialCloudList,
  ExperientialCloudStatus,
  ExperientialCloudUpdateInput
} from "./experiential-cloud/types";
import type { ModelPromotion, ModelPromotionCreateInput } from "./promotions/types";
import type { OrgAdminNote, OrgLabel } from "./admin/org-labels-types";
import type { RecommendedModel } from "./recommended-models/types";
import type {
  JoinDecision,
  JoinOffer,
  JoinRequestCreated,
  PendingJoinRequest
} from "./org-join/types";

type RequestBody = Record<string, unknown>;

/** One org's persisted welcome-celebration trigger (admin read/write view). */
export type WelcomeTriggerView = {
  org_id: string;
  active: boolean;
  display_credit_usd: number | null;
  show_api_key: boolean;
  triggered_at: string;
};

// Resolves the id of the signed-in user a request acts for. The backend
// enforces tenancy per actor, so every tenant-scoped request must carry one;
// null is the signed-out visitor, admitted only to the backend's public
// catalog reads (the actor header is omitted entirely).
type ActorIdProvider = () => Promise<string | null>;

export class BackendDataSource {
  private readonly baseUrl: string;
  private readonly servingBaseUrl: string;
  private readonly apiKey: string;
  private readonly actorIdProvider: ActorIdProvider;

  constructor(
    baseUrl: string,
    apiKey: string,
    actorIdProvider: ActorIdProvider,
    servingBaseUrl?: string
  ) {
    if (!baseUrl) {
      throw new Error("EXPLABS_BACKEND_URL must be set for the Experiential web app.");
    }
    if (!apiKey) {
      throw new Error("EXPLABS_API_KEY must be set for the Experiential web app.");
    }
    this.baseUrl = baseUrl.replace(/\/$/, "");
    // Deployments with a dedicated serving app point /v1 at its pods so the
    // playground exercises the pods customers hit; without one (previews,
    // local), /v1 rides the control-plane backend like everything else.
    this.servingBaseUrl = (servingBaseUrl ?? baseUrl).replace(/\/$/, "");
    this.apiKey = apiKey;
    this.actorIdProvider = actorIdProvider;
  }

  async listOrgs(): Promise<Org[]> {
    return this.fetchJson<Org[]>("/api/orgs");
  }

  // Org audit trail (enterprise build-out). The backend admin-gates the read
  // per the acting user, exactly like the alias surface.

  async getOrgAuditLog(orgId: string, query: AuditLogQuery): Promise<AuditLogList> {
    return this.fetchJson<AuditLogList>(
      `/api/orgs/${encodeURIComponent(orgId)}/audit-log${auditLogQueryString(query)}`
    );
  }

  /**
   * The enterprise capability registry: every /ee capability key mapped to
   * "available" | "unlicensed" for this org (explabs/api/routes/capabilities.py,
   * member-strength). Unlicensed surfaces render ABSENT, so this read decides
   * whether enterprise UI exists at all.
   */
  async getOrgCapabilities(orgId: string): Promise<{ capabilities: Record<string, string> }> {
    return this.fetchJson<{ capabilities: Record<string, string> }>(
      `/api/orgs/${encodeURIComponent(orgId)}/capabilities`
    );
  }

  /** The same listing as CSV, passed through verbatim for the download link. */
  async getOrgAuditLogCsv(orgId: string, query: AuditLogQuery): Promise<string> {
    const qs = auditLogQueryString(query);
    const separator = qs.length > 0 ? "&" : "?";
    return this.fetchText(
      `/api/orgs/${encodeURIComponent(orgId)}/audit-log${qs}${separator}format=csv`
    );
  }

  // Domains & SSO (E2, /ee). Every route is admin-gated AND capability-gated
  // by the backend; an unlicensed org reads all of these as 404 (absent).

  async listOrgDomains(orgId: string): Promise<OrgDomainList> {
    return this.fetchJson<OrgDomainList>(`/api/orgs/${encodeURIComponent(orgId)}/domains`);
  }

  async createOrgDomain(orgId: string, domain: string): Promise<OrgDomain> {
    return this.fetchJson<OrgDomain>(`/api/orgs/${encodeURIComponent(orgId)}/domains`, {
      body: { domain },
      method: "POST"
    });
  }

  async verifyOrgDomain(orgId: string, domain: string): Promise<OrgDomain> {
    return this.fetchJson<OrgDomain>(
      `/api/orgs/${encodeURIComponent(orgId)}/domains/${encodeURIComponent(domain)}/verify`,
      { body: {}, method: "POST" }
    );
  }

  async setOrgDomainSsoRequired(
    orgId: string,
    domain: string,
    ssoRequired: boolean
  ): Promise<OrgDomain> {
    return this.fetchJson<OrgDomain>(
      `/api/orgs/${encodeURIComponent(orgId)}/domains/${encodeURIComponent(domain)}`,
      { body: { sso_required: ssoRequired }, method: "PATCH" }
    );
  }

  async deleteOrgDomain(orgId: string, domain: string): Promise<{ deleted: boolean }> {
    return this.fetchJson<{ deleted: boolean }>(
      `/api/orgs/${encodeURIComponent(orgId)}/domains/${encodeURIComponent(domain)}`,
      { method: "DELETE" }
    );
  }

  async getOrgSsoProvider(orgId: string): Promise<SsoProvider> {
    return this.fetchJson<SsoProvider>(`/api/orgs/${encodeURIComponent(orgId)}/sso-provider`);
  }

  async putOrgSsoProvider(orgId: string, input: SsoProviderUpsertInput): Promise<SsoProvider> {
    return this.fetchJson<SsoProvider>(`/api/orgs/${encodeURIComponent(orgId)}/sso-provider`, {
      body: input,
      method: "PUT"
    });
  }

  async deleteOrgSsoProvider(orgId: string): Promise<{ deleted: boolean }> {
    return this.fetchJson<{ deleted: boolean }>(
      `/api/orgs/${encodeURIComponent(orgId)}/sso-provider`,
      { method: "DELETE" }
    );
  }

  // SCIM token management (enterprise E3). Admin + SCIM capability gated on
  // the backend; the mint response is the only carrier of the plaintext.

  async getScimTokenStatus(orgId: string): Promise<ScimTokenStatus> {
    return this.fetchJson<ScimTokenStatus>(`/api/orgs/${encodeURIComponent(orgId)}/scim-token`);
  }

  async mintScimToken(orgId: string, keyPolicy: ScimKeyPolicy): Promise<ScimTokenMint> {
    return this.fetchJson<ScimTokenMint>(`/api/orgs/${encodeURIComponent(orgId)}/scim-token`, {
      body: { key_policy: keyPolicy },
      method: "POST"
    });
  }

  async revokeScimToken(orgId: string): Promise<ScimTokenStatus> {
    return this.fetchJson<ScimTokenStatus>(`/api/orgs/${encodeURIComponent(orgId)}/scim-token`, {
      method: "DELETE"
    });
  }

  // Teams (enterprise E4). The backend gates every call on the TEAMS
  // capability plus org role (reads member-strength, mutations admin), so
  // these methods only shape the request.

  async listOrgTeams(orgId: string): Promise<TeamList> {
    return this.fetchJson<TeamList>(`/api/orgs/${encodeURIComponent(orgId)}/teams`);
  }

  async createOrgTeam(orgId: string, name: string): Promise<Team> {
    return this.fetchJson<Team>(`/api/orgs/${encodeURIComponent(orgId)}/teams`, {
      body: { name },
      method: "POST"
    });
  }

  async renameOrgTeam(orgId: string, teamId: string, name: string): Promise<Team> {
    return this.fetchJson<Team>(
      `/api/orgs/${encodeURIComponent(orgId)}/teams/${encodeURIComponent(teamId)}`,
      { body: { name }, method: "PATCH" }
    );
  }

  /** With force, the backend unassigns the team's keys and reports how many. */
  async deleteOrgTeam(orgId: string, teamId: string, options: { force: boolean }): Promise<TeamDeletion> {
    const suffix = options.force ? "?force=true" : "";
    return this.fetchJson<TeamDeletion>(
      `/api/orgs/${encodeURIComponent(orgId)}/teams/${encodeURIComponent(teamId)}${suffix}`,
      { method: "DELETE" }
    );
  }

  async listOrgTeamMembers(orgId: string, teamId: string): Promise<TeamMemberList> {
    return this.fetchJson<TeamMemberList>(
      `/api/orgs/${encodeURIComponent(orgId)}/teams/${encodeURIComponent(teamId)}/members`
    );
  }

  async addOrgTeamMember(orgId: string, teamId: string, userId: string): Promise<TeamMember> {
    return this.fetchJson<TeamMember>(
      `/api/orgs/${encodeURIComponent(orgId)}/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`,
      { method: "PUT" }
    );
  }

  async removeOrgTeamMember(
    orgId: string,
    teamId: string,
    userId: string
  ): Promise<{ removed: boolean }> {
    return this.fetchJson<{ removed: boolean }>(
      `/api/orgs/${encodeURIComponent(orgId)}/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`,
      { method: "DELETE" }
    );
  }

  async assignOrgTeamKey(orgId: string, teamId: string, keyId: string): Promise<TeamKeyAssignment> {
    return this.fetchJson<TeamKeyAssignment>(
      `/api/orgs/${encodeURIComponent(orgId)}/teams/${encodeURIComponent(teamId)}/keys/${encodeURIComponent(keyId)}`,
      { method: "PUT" }
    );
  }

  async unassignOrgTeamKey(
    orgId: string,
    teamId: string,
    keyId: string
  ): Promise<TeamKeyAssignment> {
    return this.fetchJson<TeamKeyAssignment>(
      `/api/orgs/${encodeURIComponent(orgId)}/teams/${encodeURIComponent(teamId)}/keys/${encodeURIComponent(keyId)}`,
      { method: "DELETE" }
    );
  }

  // Provider data controls (enterprise E5.3). The backend gates policy calls
  // on the DATA_CONTROLS capability plus org role (reads member-strength,
  // mutations admin); the posture matrix is curated metadata, member-strength
  // and NOT capability-gated. Enforcement of a written policy is always-on in
  // the gateway worker regardless of licensing.

  async getProviderDataControls(orgId: string): Promise<ProviderDataControlsList> {
    return this.fetchJson<ProviderDataControlsList>(
      `/api/orgs/${encodeURIComponent(orgId)}/provider-data-controls`
    );
  }

  async getProviderPolicy(orgId: string): Promise<ProviderPolicyState> {
    return this.fetchJson<ProviderPolicyState>(
      `/api/orgs/${encodeURIComponent(orgId)}/provider-policy`
    );
  }

  async putProviderPolicy(orgId: string, input: ProviderPolicyInput): Promise<ProviderPolicyState> {
    return this.fetchJson<ProviderPolicyState>(
      `/api/orgs/${encodeURIComponent(orgId)}/provider-policy`,
      { body: input, method: "PUT" }
    );
  }

  async deleteProviderPolicy(orgId: string): Promise<{ deleted: boolean }> {
    return this.fetchJson<{ deleted: boolean }>(
      `/api/orgs/${encodeURIComponent(orgId)}/provider-policy`,
      { method: "DELETE" }
    );
  }

  // Named / abstract aliases. Every mutation is admin-gated by the backend
  // per the acting user; the org is named explicitly on each call.

  async listNamedAliases(orgId: string): Promise<NamedAliasList> {
    return this.fetchJson<NamedAliasList>(
      `/api/aliases?org_id=${encodeURIComponent(orgId)}`
    );
  }

  async createNamedAlias(orgId: string, name: string, model: string): Promise<NamedAlias> {
    return this.fetchJson<NamedAlias>("/api/aliases", {
      body: { org_id: orgId, name, model },
      method: "POST"
    });
  }

  async repointNamedAlias(orgId: string, name: string, model: string): Promise<NamedAlias> {
    return this.fetchJson<NamedAlias>(`/api/aliases/${encodeURIComponent(name)}`, {
      body: { org_id: orgId, model },
      method: "PUT"
    });
  }

  async listNamedAliasRevisions(orgId: string, name: string): Promise<AliasRevisionList> {
    return this.fetchJson<AliasRevisionList>(
      `/api/aliases/${encodeURIComponent(name)}/revisions?org_id=${encodeURIComponent(orgId)}`
    );
  }

  async rollbackNamedAlias(orgId: string, name: string, revisionId: string): Promise<NamedAlias> {
    return this.fetchJson<NamedAlias>(`/api/aliases/${encodeURIComponent(name)}/rollback`, {
      body: { org_id: orgId, revision_id: revisionId },
      method: "POST"
    });
  }

  async deactivateNamedAlias(orgId: string, name: string): Promise<void> {
    await this.fetchVoid(
      `/api/aliases/${encodeURIComponent(name)}?org_id=${encodeURIComponent(orgId)}`,
      "DELETE"
    );
  }

  // Models an alias can point at, projected from the catalog listing so the
  // repoint picker shows names without pulling the full deployment payload.
  async listAliasModelOptions(): Promise<AliasModelOption[]> {
    const payload = await this.fetchJson<{
      models: { model: { slug: string; display_name: string } }[];
    }>("/api/models?limit=1000");
    return payload.models.map((entry) => ({
      slug: entry.model.slug,
      display_name: entry.model.display_name
    }));
  }

  /**
   * Wipe every retained world model the org owns through the backend's
   * cleanup path, so storage objects and sandbox ids drain durably with the
   * rows. Projects, telemetry, and ingest history have their own delete paths.
   */
  async deleteOrgData(orgId: string): Promise<{ deleted_world_models: number }> {
    return this.fetchJson<{ deleted_world_models: number }>(
      `/api/orgs/${encodeURIComponent(orgId)}/data`,
      { method: "DELETE" }
    );
  }

  async getOrgUsage(orgId: string): Promise<OrgUsageReport> {
    return this.fetchJson<OrgUsageReport>(`/api/orgs/${encodeURIComponent(orgId)}/usage`);
  }

  async getOrgBudget(orgId: string): Promise<OrgBudget> {
    return this.fetchJson<OrgBudget>(`/api/orgs/${encodeURIComponent(orgId)}/budget`);
  }

  async getOrgCreditLedger(orgId: string): Promise<{ entries: CreditLedgerEntry[] }> {
    return this.fetchJson<{ entries: CreditLedgerEntry[] }>(
      `/api/orgs/${encodeURIComponent(orgId)}/credit/ledger`
    );
  }

  async postAdminCreditGrant(
    orgId: string,
    grant: { amount_usd: number; reason?: string }
  ): Promise<{ entry: CreditLedgerEntry; credit: OrgBudget }> {
    return this.fetchJson<{ entry: CreditLedgerEntry; credit: OrgBudget }>(
      `/api/admin/orgs/${encodeURIComponent(orgId)}/credit-grants`,
      { body: grant, method: "POST" }
    );
  }

  // Enterprise entitlements (the hosted tier of the capability registry):
  // platform operators grant/revoke /ee capabilities per org. All three
  // proxy to platform-admin-gated backend routes.

  async listOrgEntitlements(orgId: string): Promise<OrgEntitlementsList> {
    return this.fetchJson<OrgEntitlementsList>(
      `/api/admin/orgs/${encodeURIComponent(orgId)}/entitlements`
    );
  }

  async grantOrgEntitlement(
    orgId: string,
    capability: string,
    input: { note: string | null; expiresAt: string | null }
  ): Promise<OrgEntitlement> {
    return this.fetchJson<OrgEntitlement>(
      `/api/admin/orgs/${encodeURIComponent(orgId)}/entitlements/${encodeURIComponent(capability)}`,
      { body: { note: input.note, expires_at: input.expiresAt }, method: "PUT" }
    );
  }

  async revokeOrgEntitlement(orgId: string, capability: string): Promise<{ revoked: boolean }> {
    return this.fetchJson<{ revoked: boolean }>(
      `/api/admin/orgs/${encodeURIComponent(orgId)}/entitlements/${encodeURIComponent(capability)}`,
      { method: "DELETE" }
    );
  }

  async postAdminYcGrant(
    orgId: string,
    grant: { amount_usd?: number; expires_at?: string }
  ): Promise<{
    granted_usd: number;
    expires_at: string;
    balance_usd: number;
    newly_applied: boolean;
    org_slug: string;
  }> {
    return this.fetchJson(`/api/admin/orgs/${encodeURIComponent(orgId)}/yc-grant`, {
      body: grant,
      method: "POST"
    });
  }

  async getAdminWelcomeTrigger(orgId: string): Promise<{ trigger: WelcomeTriggerView | null }> {
    return this.fetchJson<{ trigger: WelcomeTriggerView | null }>(
      `/api/admin/orgs/${encodeURIComponent(orgId)}/welcome-trigger`
    );
  }

  async putAdminWelcomeTrigger(
    orgId: string,
    trigger: { active: boolean; display_credit_usd?: number | null; show_api_key: boolean }
  ): Promise<WelcomeTriggerView> {
    return this.fetchJson(`/api/admin/orgs/${encodeURIComponent(orgId)}/welcome-trigger`, {
      body: trigger,
      method: "PUT"
    });
  }

  async postAdminWelcomeTriggerByLabel(input: {
    label: string;
    active: boolean;
    display_credit_usd?: number | null;
    show_api_key: boolean;
  }): Promise<{ label: string; active: boolean; affected_orgs: number }> {
    return this.fetchJson("/api/admin/welcome-triggers/by-label", {
      body: input,
      method: "POST"
    });
  }

  async putAdminFreeCreditCaps(
    orgId: string,
    lifted: boolean
  ): Promise<{ free_credit_caps_lifted_at: string | null }> {
    return this.fetchJson<{ free_credit_caps_lifted_at: string | null }>(
      `/api/admin/orgs/${encodeURIComponent(orgId)}/free-credit-caps`,
      { body: { lifted }, method: "PUT" }
    );
  }

  async getCreditGating(): Promise<CreditGatingSettings> {
    return this.fetchJson<CreditGatingSettings>("/api/admin/settings/credit-gating");
  }

  async putPreVerifyAllowance(enabled: boolean): Promise<CreditGatingSettings> {
    return this.fetchJson<CreditGatingSettings>("/api/admin/settings/pre-verify-allowance", {
      body: { enabled },
      method: "PUT"
    });
  }

  async putWelcomeGrant(microUsd: number): Promise<CreditGatingSettings> {
    return this.fetchJson<CreditGatingSettings>("/api/admin/settings/welcome-grant", {
      body: { micro_usd: microUsd },
      method: "PUT"
    });
  }

  async putYcGrant(microUsd: number): Promise<CreditGatingSettings> {
    return this.fetchJson<CreditGatingSettings>("/api/admin/settings/yc-grant", {
      body: { micro_usd: microUsd },
      method: "PUT"
    });
  }

  async putSpendUnlockRequirement(
    requirement: SpendUnlockRequirement
  ): Promise<CreditGatingSettings> {
    return this.fetchJson<CreditGatingSettings>("/api/admin/settings/spend-unlock-requirement", {
      body: { requirement },
      method: "PUT"
    });
  }

  async getPlatformOrgUsage(): Promise<PlatformOrgUsageReport> {
    return this.fetchJson<PlatformOrgUsageReport>("/api/orgs/usage");
  }

  // -- Promotions (platform-admin CRUD, id-keyed) ----------------------------

  async listAdminModelPromotions(): Promise<ModelPromotion[]> {
    const { promotions } = await this.fetchJson<{ promotions: ModelPromotion[] }>(
      "/api/admin/model-promotions"
    );
    return promotions;
  }

  async createAdminModelPromotion(input: ModelPromotionCreateInput): Promise<ModelPromotion> {
    return this.fetchJson<ModelPromotion>("/api/admin/model-promotions", {
      body: input,
      method: "POST",
    });
  }

  async updateAdminModelPromotion(
    id: string,
    input: ModelPromotionCreateInput
  ): Promise<ModelPromotion> {
    return this.fetchJson<ModelPromotion>(
      `/api/admin/model-promotions/${encodeURIComponent(id)}`,
      { body: input, method: "PUT" }
    );
  }

  async deleteAdminModelPromotion(id: string): Promise<void> {
    await this.fetchVoid(
      `/api/admin/model-promotions/${encodeURIComponent(id)}`,
      "DELETE"
    );
  }

  // -- Org labels + internal admin notes (platform-admin) -------------------

  /** Batch map of org_id -> label keys, for the admin org-list badges. */
  async getAdminOrgLabels(): Promise<Record<string, string[]>> {
    const { labels } = await this.fetchJson<{ labels: Record<string, string[]> }>(
      "/api/admin/orgs/labels"
    );
    return labels;
  }

  async listAdminOrgLabels(orgId: string): Promise<OrgLabel[]> {
    const { labels } = await this.fetchJson<{ labels: OrgLabel[] }>(
      `/api/admin/orgs/${encodeURIComponent(orgId)}/labels`
    );
    return labels;
  }

  async addAdminOrgLabel(orgId: string, key: string): Promise<OrgLabel> {
    return this.fetchJson<OrgLabel>(`/api/admin/orgs/${encodeURIComponent(orgId)}/labels`, {
      body: { key },
      method: "POST",
    });
  }

  async removeAdminOrgLabel(orgId: string, key: string): Promise<void> {
    await this.fetchVoid(
      `/api/admin/orgs/${encodeURIComponent(orgId)}/labels/${encodeURIComponent(key)}`,
      "DELETE"
    );
  }

  async listAdminOrgNotes(orgId: string): Promise<OrgAdminNote[]> {
    const { notes } = await this.fetchJson<{ notes: OrgAdminNote[] }>(
      `/api/admin/orgs/${encodeURIComponent(orgId)}/notes`
    );
    return notes;
  }

  async addAdminOrgNote(orgId: string, body: string): Promise<OrgAdminNote> {
    return this.fetchJson<OrgAdminNote>(`/api/admin/orgs/${encodeURIComponent(orgId)}/notes`, {
      body: { body },
      method: "POST",
    });
  }

  async deleteAdminOrgNote(orgId: string, noteId: string): Promise<void> {
    await this.fetchVoid(
      `/api/admin/orgs/${encodeURIComponent(orgId)}/notes/${encodeURIComponent(noteId)}`,
      "DELETE"
    );
  }

  // -- Recommended models (platform-admin, whole-set replace) ---------------

  async listAdminRecommendedModels(): Promise<RecommendedModel[]> {
    const { models } = await this.fetchJson<{ models: RecommendedModel[] }>(
      "/api/admin/recommended-models"
    );
    return models;
  }

  /** Replace the whole recommended set; list order becomes rank 0..N-1. */
  async replaceAdminRecommendedModels(slugs: string[]): Promise<RecommendedModel[]> {
    const { models } = await this.fetchJson<{ models: RecommendedModel[] }>(
      "/api/admin/recommended-models",
      { body: { slugs }, method: "PUT" }
    );
    return models;
  }

  // -- Experiential Cloud lanes (platform-admin; endpoint + prices + on/off) --
  // The upstream bearer is a worker secret and is never sent or returned here.

  async listAdminExperientialCloud(): Promise<ExperientialCloudList> {
    return this.fetchJson<ExperientialCloudList>("/api/admin/experiential-cloud");
  }

  /** Attach an Experiential Cloud lane to a public model; staged OFF by default. */
  async createAdminExperientialCloud(
    input: ExperientialCloudCreateInput
  ): Promise<ExperientialCloudDeployment> {
    return this.fetchJson<ExperientialCloudDeployment>("/api/admin/experiential-cloud", {
      body: input,
      method: "POST"
    });
  }

  /** Replace one lane's endpoint, wire id, and prices (hookup info only). */
  async updateAdminExperientialCloud(
    id: string,
    input: ExperientialCloudUpdateInput
  ): Promise<ExperientialCloudDeployment> {
    return this.fetchJson<ExperientialCloudDeployment>(
      `/api/admin/experiential-cloud/${encodeURIComponent(id)}`,
      { body: input, method: "PATCH" }
    );
  }

  /** Turn a lane ON (active) or OFF (disabled). */
  async setAdminExperientialCloudStatus(
    id: string,
    status: ExperientialCloudStatus
  ): Promise<ExperientialCloudDeployment> {
    return this.fetchJson<ExperientialCloudDeployment>(
      `/api/admin/experiential-cloud/${encodeURIComponent(id)}/status`,
      { body: { status }, method: "POST" }
    );
  }

  // -- Identity tier: identities, grants, budgets ---------------------------

  async listIdentities(orgId: string): Promise<{ identities: IdentityView[] }> {
    return this.fetchJson<{ identities: IdentityView[] }>(
      `/api/orgs/${encodeURIComponent(orgId)}/identities`
    );
  }

  async createIdentity(orgId: string, input: CreateIdentityInput): Promise<IdentityView> {
    return this.fetchJson<IdentityView>(`/api/orgs/${encodeURIComponent(orgId)}/identities`, {
      body: input,
      method: "POST"
    });
  }

  async updateIdentity(
    orgId: string,
    identityId: string,
    input: UpdateIdentityInput
  ): Promise<IdentityView> {
    return this.fetchJson<IdentityView>(
      `/api/orgs/${encodeURIComponent(orgId)}/identities/${encodeURIComponent(identityId)}`,
      { body: input, method: "PATCH" }
    );
  }

  async disableIdentity(orgId: string, identityId: string): Promise<IdentityView> {
    return this.fetchJson<IdentityView>(
      `/api/orgs/${encodeURIComponent(orgId)}/identities/${encodeURIComponent(identityId)}`,
      { method: "DELETE" }
    );
  }

  async getGrantMatrix(orgId: string): Promise<GrantMatrix> {
    return this.fetchJson<GrantMatrix>(`/api/orgs/${encodeURIComponent(orgId)}/grants`);
  }

  async addGrant(
    orgId: string,
    identityId: string,
    aliasId: string
  ): Promise<{ granted: boolean; changed: boolean }> {
    return this.fetchJson<{ granted: boolean; changed: boolean }>(
      `/api/orgs/${encodeURIComponent(orgId)}/identities/${encodeURIComponent(identityId)}` +
        `/grants/${encodeURIComponent(aliasId)}`,
      { method: "PUT" }
    );
  }

  async removeGrant(
    orgId: string,
    identityId: string,
    aliasId: string
  ): Promise<{ granted: boolean; changed: boolean }> {
    return this.fetchJson<{ granted: boolean; changed: boolean }>(
      `/api/orgs/${encodeURIComponent(orgId)}/identities/${encodeURIComponent(identityId)}` +
        `/grants/${encodeURIComponent(aliasId)}`,
      { method: "DELETE" }
    );
  }

  async listBudgets(orgId: string, period: string): Promise<{ budgets: BudgetView[] }> {
    return this.fetchJson<{ budgets: BudgetView[] }>(
      `/api/orgs/${encodeURIComponent(orgId)}/budgets?period=${encodeURIComponent(period)}`
    );
  }

  async setBudget(orgId: string, input: SetBudgetInput): Promise<BudgetView> {
    return this.fetchJson<BudgetView>(`/api/orgs/${encodeURIComponent(orgId)}/budgets`, {
      body: input,
      method: "PUT"
    });
  }

  async deleteBudget(orgId: string, budgetId: string): Promise<{ deleted: boolean }> {
    return this.fetchJson<{ deleted: boolean }>(
      `/api/orgs/${encodeURIComponent(orgId)}/budgets/${encodeURIComponent(budgetId)}`,
      { method: "DELETE" }
    );
  }

  // -- Spend alerts: soft email notifications beside the hard budgets -------

  async listSpendAlerts(orgId: string): Promise<{ alerts: SpendAlertView[] }> {
    return this.fetchJson<{ alerts: SpendAlertView[] }>(
      `/api/orgs/${encodeURIComponent(orgId)}/spend-alerts`
    );
  }

  async createSpendAlert(orgId: string, input: CreateSpendAlertInput): Promise<SpendAlertView> {
    return this.fetchJson<SpendAlertView>(`/api/orgs/${encodeURIComponent(orgId)}/spend-alerts`, {
      body: input,
      method: "POST"
    });
  }

  async deleteSpendAlert(orgId: string, alertId: string): Promise<{ deleted: boolean }> {
    return this.fetchJson<{ deleted: boolean }>(
      `/api/orgs/${encodeURIComponent(orgId)}/spend-alerts/${encodeURIComponent(alertId)}`,
      { method: "DELETE" }
    );
  }

  /**
   * The Overview page's read: the gateway daily-usage rollup, grouped as a
   * per-day series, per-(day, model) cells (the stacked hero chart), a
   * top-models list, or a per-member breakdown. scope=self is the acting
   * user's own keys summed server-side; scope=org reads org-wide (the backend
   * gates both on membership).
   */
  async getGatewayUsageDaily(
    orgId: string,
    query: {
      scope: GatewayUsageScope;
      groupBy: GatewayUsageGroupBy;
      from?: string;
      to?: string;
      limit?: number;
    }
  ): Promise<GatewayDailyUsage> {
    const params = new URLSearchParams({
      org_id: orgId,
      scope: query.scope,
      group_by: query.groupBy
    });
    if (query.from !== undefined) {
      params.set("from", query.from);
    }
    if (query.to !== undefined) {
      params.set("to", query.to);
    }
    if (query.limit !== undefined) {
      params.set("limit", String(query.limit));
    }
    return this.fetchJson<GatewayDailyUsage>(`/api/gateway/usage/daily?${params.toString()}`);
  }

  /**
   * The admin Telemetry section's read: the same rollup summed across every
   * organization, grouped as a per-day series, a top-models list, or a
   * per-org breakdown. Platform-admin gated in the backend (404 otherwise).
   */
  async getGatewayUsagePlatformDaily(query: {
    groupBy: PlatformUsageGroupBy;
    from?: string;
    to?: string;
    limit?: number;
  }): Promise<PlatformDailyUsage> {
    const params = new URLSearchParams({ group_by: query.groupBy });
    if (query.from !== undefined) {
      params.set("from", query.from);
    }
    if (query.to !== undefined) {
      params.set("to", query.to);
    }
    if (query.limit !== undefined) {
      params.set("limit", String(query.limit));
    }
    return this.fetchJson<PlatformDailyUsage>(
      `/api/gateway/usage/platform-daily?${params.toString()}`
    );
  }

  /**
   * One key's effective gateway guardrails, defaults included. Member-strength
   * read by backend contract (the key's owning org is resolved server-side).
   */
  async getGatewayKeyLimits(apiKeyId: string): Promise<GatewayKeyLimits> {
    return this.fetchJson<GatewayKeyLimits>(
      `/api/gateway/keys/${encodeURIComponent(apiKeyId)}/limits`
    );
  }

  /**
   * Replace one key's guardrails (org admin). Full-resource semantics: the
   * backend row becomes exactly the body, so all three fields ship on every
   * write and null means explicitly uncapped, never "keep the old value".
   */
  async putGatewayKeyLimits(
    apiKeyId: string,
    input: GatewayKeyLimitsInput
  ): Promise<GatewayKeyLimits> {
    return this.fetchJson<GatewayKeyLimits>(
      `/api/gateway/keys/${encodeURIComponent(apiKeyId)}/limits`,
      { body: input, method: "PUT" }
    );
  }

  // Gateway usage (the Telemetry page). Reads the gateway's per-request usage
  // ledger through the tenant routes in explabs/api/routes/gateway_usage.py;
  // money arrives already split into charged credits and the never-charged
  // pass-through estimate, and as plain floats (the backend converts from
  // integer micro-USD at its boundary).

  async getUsageTimeseries(orgId: string, query: UsageTimeseriesQuery): Promise<UsageTimeseries> {
    const qs = usageTimeseriesQueryString(query);
    return this.fetchJson<UsageTimeseries>(
      `/api/orgs/${encodeURIComponent(orgId)}/usage/timeseries${qs ? `?${qs}` : ""}`
    );
  }

  async getUsageByKey(orgId: string, window?: ServingWindow): Promise<UsageByKey> {
    const qs = window ? `?window=${window}` : "";
    return this.fetchJson<UsageByKey>(`/api/orgs/${encodeURIComponent(orgId)}/usage/by-key${qs}`);
  }

  /** Per-provider ("platform") gateway usage rollups for the Telemetry Usage card. */
  async getUsageByProvider(orgId: string, window?: ServingWindow): Promise<UsageByProvider> {
    const qs = window ? `?window=${encodeURIComponent(window)}` : "";
    return this.fetchJson<UsageByProvider>(
      `/api/orgs/${encodeURIComponent(orgId)}/usage/by-provider${qs}`
    );
  }

  /**
   * One request's captured prompt; DataSourceNotFoundError when the org never
   * opted into capture, the request predates it, or retention expired it.
   */
  async getCapturedPrompt(orgId: string, requestId: string): Promise<CapturedPrompt> {
    return this.fetchJson<CapturedPrompt>(
      `/api/orgs/${encodeURIComponent(orgId)}/usage/requests/${encodeURIComponent(requestId)}/prompt`
    );
  }

  /** Drain the captured-prompt broadcast queue to enabled destinations (cron). */
  async runBroadcast(): Promise<{ broadcast: number; skipped_no_destination: number; failed: number }> {
    return this.fetchJson<{ broadcast: number; skipped_no_destination: number; failed: number }>(
      "/api/internal/broadcast",
      { method: "POST" }
    );
  }

  async getUsageByPrompt(orgId: string, window?: ServingWindow): Promise<UsageByPrompt> {
    const qs = window ? `?window=${window}` : "";
    return this.fetchJson<UsageByPrompt>(
      `/api/orgs/${encodeURIComponent(orgId)}/usage/by-prompt${qs}`
    );
  }

  async listUsageRequests(orgId: string, query: UsageRequestsQuery): Promise<UsageRequestsPage> {
    const qs = usageRequestsQueryString(query);
    return this.fetchJson<UsageRequestsPage>(
      `/api/orgs/${encodeURIComponent(orgId)}/usage/requests${qs ? `?${qs}` : ""}`
    );
  }

  // Telemetry privacy settings: the org opt-in to also capture request/response
  // content. Reading is member-gated; writing is admin-gated at the backend.

  async getTelemetrySettings(orgId: string): Promise<TelemetrySettings> {
    return this.fetchJson<TelemetrySettings>(
      `/api/orgs/${encodeURIComponent(orgId)}/telemetry-settings`
    );
  }

  async setTelemetrySettings(
    orgId: string,
    settings: TelemetrySettings
  ): Promise<TelemetrySettings> {
    return this.fetchJson<TelemetrySettings>(
      `/api/orgs/${encodeURIComponent(orgId)}/telemetry-settings`,
      { body: settings, method: "PUT" }
    );
  }

  // Imported historical spend for the Telemetry "Imported" section: already-paid
  // provider spend (Codex / Claude Code logs) aggregated per (source, model),
  // window-free and attribution-only — never charged here. See
  // explabs/api/routes/usage_import.py.
  async getImportedUsage(orgId: string): Promise<ImportedUsage> {
    return this.fetchJson<ImportedUsage>(
      `/api/orgs/${encodeURIComponent(orgId)}/usage/imported`
    );
  }

  async getSuggestions(orgId: string, window?: ServingWindow): Promise<Suggestions> {
    const qs = window ? `?window=${window}` : "";
    return this.fetchJson<Suggestions>(`/api/orgs/${encodeURIComponent(orgId)}/suggestions${qs}`);
  }

  /**
   * Answer a plain-language question over the org's own usage. The window is
   * parsed from the question itself, so the request carries only the question.
   */
  async queryInsights(orgId: string, question: string): Promise<InsightAnswer> {
    return this.fetchJson<InsightAnswer>(
      `/api/orgs/${encodeURIComponent(orgId)}/insights/query`,
      { body: { question }, method: "POST" }
    );
  }

  /**
   * Run the on-demand advice agent over the org's usage aggregates. Answers
   * 503 (`DataSourceRequestError`) when the deployment carries no platform
   * LLM credential; the rule-based suggestions remain available regardless.
   */
  async runAgentAdvice(orgId: string, window?: ServingWindow): Promise<Suggestions> {
    const qs = window ? `?window=${window}` : "";
    return this.fetchJson<Suggestions>(
      `/api/orgs/${encodeURIComponent(orgId)}/insights/agent-advice${qs}`,
      { method: "POST" }
    );
  }

  /**
   * One-click /yc launch grant claim for the acting member's org. The backend
   * enforces one claim per user account AND per org; a duplicate surfaces as
   * a 409 `DataSourceRequestError` the /yc page shows verbatim.
   */
  async postYcClaim(orgId: string): Promise<YcClaimResult> {
    return this.fetchJson<YcClaimResult>(
      `/api/orgs/${encodeURIComponent(orgId)}/yc-claim`,
      { body: {}, method: "POST" }
    );
  }

  // -- Domain-based org join requests ---------------------------------------

  /**
   * The signed-in user's domain-match offer: the org their verified email
   * domain maps to, plus verification/membership state so the UI renders the
   * right control. `{ offer: null }` when no domain matches.
   */
  async getJoinOffer(): Promise<{ offer: JoinOffer | null }> {
    return this.fetchJson<{ offer: JoinOffer | null }>("/api/join-requests/offer");
  }

  /**
   * Open a pending request to join the user's domain-matched org. The backend
   * gates on the domain match, a verified email, and non-membership; the
   * requester's own personal org is untouched.
   */
  async requestOrgAccess(): Promise<JoinRequestCreated> {
    return this.fetchJson<JoinRequestCreated>("/api/join-requests", {
      body: {},
      method: "POST"
    });
  }

  /** The org's pending join requests (org admins; backend-gated). */
  async listJoinRequests(orgId: string): Promise<{ requests: PendingJoinRequest[] }> {
    return this.fetchJson<{ requests: PendingJoinRequest[] }>(
      `/api/orgs/${encodeURIComponent(orgId)}/join-requests`
    );
  }

  /** Approve one request, granting the requester membership (org admins). */
  async approveJoinRequest(orgId: string, requestId: string): Promise<JoinDecision> {
    return this.fetchJson<JoinDecision>(
      `/api/orgs/${encodeURIComponent(orgId)}/join-requests/${encodeURIComponent(requestId)}/approve`,
      { body: {}, method: "POST" }
    );
  }

  /** Deny one request; nothing else changes (org admins). */
  async denyJoinRequest(orgId: string, requestId: string): Promise<JoinDecision> {
    return this.fetchJson<JoinDecision>(
      `/api/orgs/${encodeURIComponent(orgId)}/join-requests/${encodeURIComponent(requestId)}/deny`,
      { body: {}, method: "POST" }
    );
  }

  /**
   * The hookup check: probe one stored BYOK credential at its provider and
   * persist the verdict. Ran inline by the connect/rotate PUT (health comes
   * up the moment a key is hooked up; there is no manual recheck surface).
   */
  async checkProviderConnection(
    orgId: string,
    provider: string
  ): Promise<ProviderConnectionCheck> {
    return this.fetchJson<ProviderConnectionCheck>(
      `/api/orgs/${encodeURIComponent(orgId)}/provider-connections/${encodeURIComponent(
        provider
      )}/check`,
      { body: {}, method: "POST" }
    );
  }

  /**
   * The model page's Azure question: does THIS model's mapped deployment
   * exist on the org's resource? Passing `deployment` maps the name onto the
   * connection first (the least-clicks inline add), then probes it. The
   * verdict is model-scoped and never touches the key-level status.
   */
  async checkModelDeployment(
    orgId: string,
    provider: string,
    input: { model: string; deployment?: string }
  ): Promise<ModelDeploymentCheck> {
    return this.fetchJson<ModelDeploymentCheck>(
      `/api/orgs/${encodeURIComponent(orgId)}/provider-connections/${encodeURIComponent(
        provider
      )}/deployment-check`,
      { body: input, method: "POST" }
    );
  }

  /**
   * One model's catalog detail: the row, its deployments, and the default
   * waterfall chain. A public read — signed-out visitors see the public
   * catalog; an org id additionally admits that org's own rows.
   */
  async getModelDetail(slug: string, orgId?: string): Promise<ModelDetail> {
    const query = orgId === undefined ? "" : `?org_id=${encodeURIComponent(orgId)}`;
    return this.fetchJson<ModelDetail>(
      `/api/models/${encodeURIComponent(slug)}${query}`
    );
  }

  /**
   * Read what one BYOK provider account reports (spend, credits, limits) and
   * store it as a snapshot. The backend enforces per-provider staleness
   * floors, so calling this "quite often" is cheap-safe. Management-plane
   * only — never the gateway/serving path.
   */
  async refreshProviderSpend(orgId: string, provider: string): Promise<ProviderSpendRefresh> {
    return this.fetchJson<ProviderSpendRefresh>(
      `/api/orgs/${encodeURIComponent(orgId)}/provider-connections/${encodeURIComponent(
        provider
      )}/spend-refresh`,
      { body: {}, method: "POST" }
    );
  }

  // Developer-tool vendor accounts on /credits (E2B for everyone; Greptile,
  // Cursor, Devin for YC orgs). The backend serves snake_case ToolAccountView /
  // ToolBalanceFetchResult JSON; it is mapped to the camelCase UI types here so
  // the seam is one typed boundary, not stringly-typed plumbing in the panel.

  async listToolAccounts(orgId: string): Promise<ToolAccountState[]> {
    const payload = await this.fetchJson<ToolAccountJson[]>(
      `/api/orgs/${encodeURIComponent(orgId)}/tool-accounts`
    );
    return payload.map(toToolAccountState);
  }

  async upsertToolAccount(
    orgId: string,
    vendor: string,
    body: {
      declared_balance_usd?: number | null;
      low_balance_threshold_usd?: number;
      dashboard_secret?: string;
    }
  ): Promise<ToolAccountState> {
    const payload = await this.fetchJson<ToolAccountJson>(
      `/api/orgs/${encodeURIComponent(orgId)}/tool-accounts/${encodeURIComponent(vendor)}`,
      { body, method: "PUT" }
    );
    return toToolAccountState(payload);
  }

  async fetchToolAccountBalance(
    orgId: string,
    vendor: string
  ): Promise<ToolBalanceFetchResult> {
    const payload = await this.fetchJson<ToolBalanceFetchJson>(
      `/api/orgs/${encodeURIComponent(orgId)}/tool-accounts/${encodeURIComponent(
        vendor
      )}/fetch-balance`,
      { body: {}, method: "POST" }
    );
    return toToolBalanceFetchResult(payload);
  }

  async deleteToolAccount(orgId: string, vendor: string): Promise<void> {
    await this.fetchVoid(
      `/api/orgs/${encodeURIComponent(orgId)}/tool-accounts/${encodeURIComponent(vendor)}`,
      "DELETE"
    );
  }

  /**
   * The pg_cron-triggered balance sweep: refresh stale provider spend readings
   * and re-fetch tool-account balances across every org, returning a run
   * summary. Carries the deployment bearer and no actor (a machine call), so it
   * runs through the internal data source. Authenticated at the backend by the
   * same internal bearer every other backend call carries.
   */
  async runScheduledBalanceFetch(): Promise<BalanceFetchRunSummary> {
    const payload = await this.fetchJson<BalanceFetchRunSummaryJson>(
      "/api/internal/balance-fetch",
      { body: {}, method: "POST" }
    );
    return {
      providersChecked: payload.providers_checked,
      providerSnapshotsWritten: payload.provider_snapshots_written,
      providersSkippedFloor: payload.providers_skipped_floor,
      toolAccountsChecked: payload.tool_accounts_checked,
      toolBalancesUpdated: payload.tool_balances_updated,
      errors: payload.errors
    };
  }

  // Run observability. These read locked telemetry tables written by external
  // wmo emitters, so every payload is validated into its typed shape here
  // rather than cast: the ledger columns are `numeric`, which arrives as a
  // decimal string, and the emitter is not this codebase.

  async listServingRequests(orgId: string, query: ServingRequestQuery): Promise<ServingRequestPage> {
    const qs = servingRequestQueryString(query);
    return this.fetchJson<ServingRequestPage>(
      `/api/orgs/${encodeURIComponent(orgId)}/serving/requests${qs ? `?${qs}` : ""}`
    );
  }

  async getServingRequest(orgId: string, requestId: string): Promise<ServingRequestDetail> {
    const payload = await this.fetchJson<{ request: ServingRequestDetail }>(
      `/api/orgs/${encodeURIComponent(orgId)}/serving/requests/${encodeURIComponent(requestId)}`
    );
    return payload.request;
  }

  /**
   * One call's routing decision, for operators. Parsed rather than cast for the
   * same reason the run reads are: `cost_usd` and `router_cost_usd` are
   * Postgres `numeric` and arrive as decimal strings.
   */
  async getServingRequestAudit(requestId: string): Promise<ServingRoutingAuditPayload> {
    const payload = await this.fetchJson<unknown>(
      `/api/admin/serving-requests/${encodeURIComponent(requestId)}`
    );
    return parsed(parseServingRoutingAudit(payload), "serving routing audit");
  }

  async getServingSummary(
    orgId: string,
    options?: { endpoint?: string; window?: ServingWindow }
  ): Promise<ServingSummary> {
    const params = new URLSearchParams();
    if (options?.endpoint) {
      params.set("endpoint", options.endpoint);
    }
    if (options?.window) {
      params.set("window", options.window);
    }
    const qs = params.toString();
    return this.fetchJson<ServingSummary>(
      `/api/orgs/${encodeURIComponent(orgId)}/serving/summary${qs ? `?${qs}` : ""}`
    );
  }

  async listServingEndpoints(orgId: string): Promise<ServingEndpoint[]> {
    const payload = await this.fetchJson<{ endpoints: ServingEndpoint[] }>(
      `/api/orgs/${encodeURIComponent(orgId)}/serving/endpoints`
    );
    return payload.endpoints;
  }

  async listProjects(orgId: string, input: ProjectListQuery = {}): Promise<ProjectList> {
    const params = new URLSearchParams();
    if (input.includeArchived === true) {
      params.set("include_archived", "true");
    }
    if (input.limit !== undefined) {
      params.set("limit", String(input.limit));
    }
    if (input.offset !== undefined) {
      params.set("offset", String(input.offset));
    }
    const query = params.size === 0 ? "" : `?${params.toString()}`;
    return this.fetchJson<ProjectList>(
      `/api/orgs/${encodeURIComponent(orgId)}/projects${query}`
    );
  }

  async getProjectBySlug(orgId: string, slug: string): Promise<Project> {
    return this.fetchJson<Project>(
      `/api/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(slug)}`
    );
  }

  async createProject(orgId: string, input: CreateProjectInput): Promise<Project> {
    return this.fetchJson<Project>(`/api/orgs/${encodeURIComponent(orgId)}/projects`, {
      body: input,
      method: "POST"
    });
  }

  async getProject(projectId: string): Promise<Project> {
    return this.fetchJson<Project>(`/api/projects/${encodeURIComponent(projectId)}`);
  }

  async updateProject(
    projectId: string,
    input: {
      display_name?: string;
      description?: string | null;
      /** Renames the serving API handle; admin-only, breaks old clients. */
      slug?: string;
      /** Replaces (or, with null, removes) the simulation link. */
      world_model_id?: string | null;
    }
  ): Promise<Project> {
    return this.fetchJson<Project>(`/api/projects/${encodeURIComponent(projectId)}`, {
      body: input,
      method: "PATCH"
    });
  }

  async archiveProject(projectId: string): Promise<Project> {
    return this.fetchJson<Project>(`/api/projects/${encodeURIComponent(projectId)}/archive`, {
      method: "POST"
    });
  }

  /** Lifetime totals plus the routed-model mix (the restored Usage tab read). */
  async getProjectUsage(projectId: string): Promise<EndpointUsage> {
    return this.fetchJson<EndpointUsage>(`/api/projects/${encodeURIComponent(projectId)}/usage`);
  }

  /** Windowed per-model usage series and the live traffic mix. */
  async getProjectUsageTimeseries(
    projectId: string,
    window?: string
  ): Promise<EndpointTimeseries> {
    const query = window ? `?window=${encodeURIComponent(window)}` : "";
    return this.fetchJson<EndpointTimeseries>(
      `/api/projects/${encodeURIComponent(projectId)}/usage/timeseries${query}`
    );
  }

  /** All-time savings vs the frontier reference, hedges included. */
  async getProjectSavings(projectId: string): Promise<EndpointSavings> {
    return this.fetchJson<EndpointSavings>(
      `/api/projects/${encodeURIComponent(projectId)}/savings`
    );
  }

  /** The linked simulation's mined scenario set, or an honest null. */
  async getProjectScenarioSet(projectId: string): Promise<{ scenario_set: ScenarioSet | null }> {
    return this.fetchJson<{ scenario_set: ScenarioSet | null }>(
      `/api/projects/${encodeURIComponent(projectId)}/scenario-set`
    );
  }

  /** The scenario set projected to 2D for the cluster map. */
  async getProjectScenarioMap(projectId: string): Promise<ScenarioMap> {
    return this.fetchJson<ScenarioMap>(
      `/api/projects/${encodeURIComponent(projectId)}/scenario-map`
    );
  }

  /** The linked simulation's build metrics and ingested corpus sums. */
  async getProjectFidelity(projectId: string): Promise<ProjectFidelity> {
    return this.fetchJson<ProjectFidelity>(
      `/api/projects/${encodeURIComponent(projectId)}/fidelity`
    );
  }

  /** The unified dataset corpus: acquired sources plus retained uploads. */
  async listProjectDatasetSources(
    projectId: string
  ): Promise<{ trace_uploads: ProjectDatasetSource[] }> {
    return this.fetchJson<{ trace_uploads: ProjectDatasetSource[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/dataset/sources`
    );
  }

  /** One page of recorded episodes from one stored corpus. */
  async listProjectDatasetEpisodes(
    projectId: string,
    sourceId: string,
    options: { limit?: number; offset?: number } = {}
  ): Promise<TraceEpisodesPage> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) {
      params.set("limit", String(options.limit));
    }
    if (options.offset !== undefined) {
      params.set("offset", String(options.offset));
    }
    const query = params.size > 0 ? `?${params.toString()}` : "";
    return this.fetchJson<TraceEpisodesPage>(
      `/api/projects/${encodeURIComponent(projectId)}/dataset/sources/${encodeURIComponent(
        sourceId
      )}/episodes${query}`
    );
  }


  async uploadProjectTraceSource(
    projectId: string,
    input: FormData
  ): Promise<ProjectTraceUploadResult> {
    const response = await fetch(
      `${this.baseUrl}/api/projects/${encodeURIComponent(projectId)}/trace-sources/upload`,
      {
        body: input,
        cache: "no-store",
        headers: await this.headers(false),
        method: "POST"
      }
    );
    return parseResponse<ProjectTraceUploadResult>(response);
  }

  async listProjectTraceConnections(projectId: string): Promise<ProjectTraceConnectionList> {
    return this.fetchJson<ProjectTraceConnectionList>(
      `/api/projects/${encodeURIComponent(projectId)}/trace-connections`
    );
  }

  async getLatestProjectTraceAcquisition(
    projectId: string
  ): Promise<ProjectTraceAcquisition | null> {
    return this.fetchJson<ProjectTraceAcquisition | null>(
      `/api/projects/${encodeURIComponent(projectId)}/trace-acquisitions/latest`
    );
  }

  async getProjectTraceAcquisition(
    projectId: string,
    acquisitionId: string
  ): Promise<ProjectTraceAcquisition> {
    return this.fetchJson<ProjectTraceAcquisition>(
      `/api/projects/${encodeURIComponent(projectId)}/trace-acquisitions/${encodeURIComponent(acquisitionId)}`
    );
  }

  async acquireRemoteProjectTraces(
    projectId: string,
    input: ProjectRemoteTraceAcquisitionInput
  ): Promise<ProjectTraceUploadResult> {
    return this.fetchJson<ProjectTraceUploadResult>(
      `/api/projects/${encodeURIComponent(projectId)}/trace-acquisitions`,
      { body: input, method: "POST" }
    );
  }

  async retryProjectTraceAcquisition(
    projectId: string,
    acquisitionId: string
  ): Promise<ProjectTraceUploadResult> {
    return this.fetchJson<ProjectTraceUploadResult>(
      `/api/projects/${encodeURIComponent(projectId)}/trace-acquisitions/${encodeURIComponent(acquisitionId)}/retry`,
      { body: {}, method: "POST" }
    );
  }

  async getCurrentProjectTraceSource(projectId: string): Promise<ProjectTraceSource> {
    return this.fetchJson<ProjectTraceSource>(
      `/api/projects/${encodeURIComponent(projectId)}/trace-sources/current`
    );
  }

  async getProjectPreparation(projectId: string): Promise<ProjectPreparation> {
    return this.fetchJson<ProjectPreparation>(
      `/api/projects/${encodeURIComponent(projectId)}/preparation`
    );
  }

  async enqueueProjectPreparation(projectId: string): Promise<ProjectJob> {
    return this.fetchJson<ProjectJob>(
      `/api/projects/${encodeURIComponent(projectId)}/preparations`,
      { body: {}, method: "POST" }
    );
  }

  async getProjectSetup(projectId: string): Promise<ProjectSetup> {
    return this.fetchJson<ProjectSetup>(`/api/projects/${encodeURIComponent(projectId)}/setup`);
  }

  async updateProjectSetup(projectId: string, input: ProjectSetupInput): Promise<ProjectSetup> {
    return this.fetchJson<ProjectSetup>(`/api/projects/${encodeURIComponent(projectId)}/setup`, {
      body: input,
      method: "PUT"
    });
  }

  async getCurrentProjectJob(projectId: string): Promise<ProjectJob | null> {
    return this.fetchJson<ProjectJob | null>(
      `/api/projects/${encodeURIComponent(projectId)}/jobs/current`
    );
  }

  async enqueueProjectJob(projectId: string): Promise<ProjectJob> {
    return this.fetchJson<ProjectJob>(`/api/projects/${encodeURIComponent(projectId)}/jobs`, {
      body: {},
      method: "POST"
    });
  }

  async getProjectJob(jobId: string): Promise<ProjectJob> {
    return this.fetchJson<ProjectJob>(`/api/project-jobs/${encodeURIComponent(jobId)}`);
  }

  async cancelProjectJob(jobId: string): Promise<ProjectJob> {
    return this.fetchJson<ProjectJob>(
      `/api/project-jobs/${encodeURIComponent(jobId)}/cancel`,
      { body: {}, method: "POST" }
    );
  }

  async streamProjectJobEvents(
    jobId: string,
    after: number
  ): Promise<ReadableStream<Uint8Array>> {
    return this.fetchEventStream(
      `/api/project-jobs/${encodeURIComponent(jobId)}/stream?after=${after}`
    );
  }

  async getProjectResult(projectId: string): Promise<ProjectResult> {
    return this.fetchJson<ProjectResult>(`/api/projects/${encodeURIComponent(projectId)}/result`);
  }

  async getProjectServingSettings(projectId: string): Promise<ProjectServingSettings> {
    return this.fetchJson<ProjectServingSettings>(
      `/api/projects/${encodeURIComponent(projectId)}/serving-settings`
    );
  }

  async updateProjectServingSettings(
    projectId: string,
    input: ProjectServingSettingsInput
  ): Promise<ProjectServingSettings> {
    return this.fetchJson<ProjectServingSettings>(
      `/api/projects/${encodeURIComponent(projectId)}/serving-settings`,
      { body: input, method: "PUT" }
    );
  }

  async getProjectServingUsage(projectId: string): Promise<ProjectServingUsage> {
    return this.fetchJson<ProjectServingUsage>(
      `/api/projects/${encodeURIComponent(projectId)}/serving-usage`
    );
  }

  /**
   * One /v1 chat completion against the hosted OpenAI-compatible surface.
   * Returns the raw Response: callers read the SSE body (or the OpenAI error
   * body on a non-2xx) themselves. The gateway edge authenticates the Bearer
   * as a customer `xpl_` serving key and derives the org from its row — the
   * deployment credential has no identity there, so callers pass a real org
   * serving key (see lib/playground/serving-key.ts), never the deploy bearer.
   */
  async streamChatCompletion(
    servingKey: string,
    body: unknown,
    signal?: AbortSignal
  ): Promise<Response> {
    return fetch(`${this.servingBaseUrl}/v1/chat/completions`, {
      body: JSON.stringify(body),
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${servingKey}`,
        accept: "text/event-stream",
        "content-type": "application/json"
      },
      method: "POST",
      signal
    });
  }

  // --- Gateway models catalog (authed writes; public reads live in
  // lib/models-catalog/server.ts because they must render without a session).

  /** Create a custom model (org-owned row + deployments + default chain). */
  async createCatalogModel(input: ModelCreateInput): Promise<ModelDetail> {
    return this.fetchJson<ModelDetail>("/api/models", { body: input, method: "POST" });
  }

  /** Add a deployment (e.g. a local variant) to an existing model. */
  async addCatalogDeployment(
    slug: string,
    input: DeploymentCreateInput
  ): Promise<CatalogDeployment> {
    return this.fetchJson<CatalogDeployment>(
      `/api/models/${encodeURIComponent(slug)}/providers`,
      { body: input, method: "POST" }
    );
  }

  /** Read a model's default chain plus the acting org's override. */
  async getCatalogWaterfall(slug: string, orgId: string): Promise<Waterfall> {
    return this.fetchJson<Waterfall>(
      `/api/models/${encodeURIComponent(slug)}/waterfall?org_id=${encodeURIComponent(orgId)}`
    );
  }

  /** Replace the acting org's waterfall override (empty list clears it). */
  async putCatalogWaterfall(
    slug: string,
    orgId: string,
    modelProviderIds: string[]
  ): Promise<Waterfall> {
    return this.fetchJson<Waterfall>(`/api/models/${encodeURIComponent(slug)}/waterfall`, {
      body: { model_provider_ids: modelProviderIds, org_id: orgId },
      method: "PUT"
    });
  }

  private async fetchJson<T>(
    path: string,
    options: { body?: RequestBody; method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE" } = {}
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: "no-store",
      headers: await this.headers(options.body !== undefined),
      method: options.method ?? "GET"
    });
    return parseResponse<T>(response);
  }

  /**
   * POST to a backend SSE endpoint and hand back the raw event-stream body.
   * Non-2xx responses raise the same typed errors as JSON endpoints; a 2xx
   * with no body is a backend contract violation and fails loudly.
   * `extraHeaders` carries the resume header of a resumable stream
   * (Last-Event-ID on the run event tail); it cannot override auth.
   */
  private async fetchEventStream(
    path: string,
    body?: RequestBody,
    extraHeaders?: Record<string, string>
  ): Promise<ReadableStream<Uint8Array>> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      headers: {
        ...extraHeaders,
        ...(await this.headers(body !== undefined)),
        accept: "text/event-stream"
      },
      method: body === undefined ? "GET" : "POST"
    });
    if (!response.ok) {
      throw await responseError(response);
    }
    if (response.body === null) {
      throw new Error(`Experiential backend returned an empty event stream for ${path}`);
    }
    return response.body;
  }

  /** GET a non-JSON body (the audit CSV export); errors parse like JSON routes. */
  private async fetchText(path: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      cache: "no-store",
      headers: await this.headers(false),
      method: "GET"
    });
    if (!response.ok) {
      throw await responseError(response);
    }
    return response.text();
  }

  private async fetchVoid(path: string, method: "DELETE"): Promise<void> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      cache: "no-store",
      headers: await this.headers(false),
      method
    });
    if (!response.ok) {
      throw await responseError(response);
    }
  }

  private async headers(hasBody: boolean): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`
    };
    // A signed-out visitor carries no actor header at all: the backend's
    // optional-actor catalog reads treat that as the public view, and every
    // tenant-scoped endpoint rejects the actorless request itself.
    const actorId = await this.actorIdProvider();
    if (actorId !== null) {
      headers["X-Explabs-Actor-Id"] = actorId;
    }
    if (hasBody) {
      headers["content-type"] = "application/json";
    }
    return headers;
  }
}

// The backend's snake_case tool-account JSON, mapped to the camelCase UI type
// at this boundary. The exact keys are the ToolAccountView / ToolBalanceFetch
// contract in the FastAPI layer.
type ToolAccountJson = {
  vendor: string;
  connected: boolean;
  yc_gated: boolean;
  config: Record<string, unknown> | null;
  credential_last4: string | null;
  declared_balance_usd: number | null;
  declared_balance_set_at: string | null;
  balance_source: ToolAccountState["balanceSource"];
  low_balance_threshold_usd: number;
  last_fetch_at: string | null;
  last_fetch_status: ToolAccountState["lastFetchStatus"];
  last_fetch_message: string | null;
};

type ToolBalanceFetchJson = {
  vendor: string;
  kind: ToolBalanceFetchResult["kind"];
  strategy: ToolBalanceFetchResult["strategy"];
  refreshed: boolean;
  balance_usd: number | null;
  source: ToolBalanceFetchResult["source"];
  message: string;
};

type BalanceFetchRunSummaryJson = {
  providers_checked: number;
  provider_snapshots_written: number;
  providers_skipped_floor: number;
  tool_accounts_checked: number;
  tool_balances_updated: number;
  errors: number;
};

// An unrecognized vendor means the backend and this enum drifted; fail loudly
// at the boundary rather than rendering a card for a vendor the UI cannot label.
function toolVendorAtBoundary(vendor: string): TrackedToolVendor {
  if (!isTrackedToolVendor(vendor)) {
    throw new DataSourceRequestError(
      `Experiential backend returned an unknown tool vendor "${vendor}".`,
      502
    );
  }
  return vendor;
}

function toToolAccountState(row: ToolAccountJson): ToolAccountState {
  return {
    vendor: toolVendorAtBoundary(row.vendor),
    connected: row.connected,
    ycGated: row.yc_gated,
    config: row.config,
    credentialLast4: row.credential_last4,
    declaredBalanceUsd: row.declared_balance_usd,
    declaredBalanceSetAt: row.declared_balance_set_at,
    balanceSource: row.balance_source,
    lowBalanceThresholdUsd: row.low_balance_threshold_usd,
    lastFetchAt: row.last_fetch_at,
    lastFetchStatus: row.last_fetch_status,
    lastFetchMessage: row.last_fetch_message
  };
}

function toToolBalanceFetchResult(row: ToolBalanceFetchJson): ToolBalanceFetchResult {
  return {
    vendor: toolVendorAtBoundary(row.vendor),
    kind: row.kind,
    strategy: row.strategy,
    refreshed: row.refreshed,
    balanceUsd: row.balance_usd,
    source: row.source,
    message: row.message
  };
}

/**
 * Assert a validated payload at the boundary. A run payload that fails its
 * parser means the emitter or the backend changed shape, which fails loudly
 * here instead of rendering an observability panel that quietly lies.
 */
function parsed<T>(value: T | null, what: string): T {
  if (value === null) {
    throw new DataSourceRequestError(
      `Experiential backend returned an unreadable ${what} payload.`,
      502
    );
  }
  return value;
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw await responseError(response);
  }
  return (await response.json()) as T;
}

async function responseError(response: Response): Promise<Error> {
  const payload = (await response.json().catch(() => null)) as
    | { action?: unknown; code?: unknown; detail?: unknown; error?: unknown }
    | null;
  const message = responseMessage(payload, response.status);
  if (response.status === 404) {
    return new DataSourceNotFoundError(message);
  }
  return new DataSourceRequestError(message, response.status, {
    action: typeof payload?.action === "string" ? payload.action : null,
    code: typeof payload?.code === "string" ? payload.code : null
  });
}

function responseMessage(
  payload: { detail?: unknown; error?: unknown } | null,
  status: number
): string {
  if (typeof payload?.error === "string") {
    return payload.error;
  }
  if (typeof payload?.detail === "string") {
    return payload.detail;
  }
  // FastAPI 502s wrap {error, message} inside detail.
  if (payload?.detail && typeof payload.detail === "object") {
    const detail = payload.detail as { message?: unknown };
    if (typeof detail.message === "string") {
      return detail.message;
    }
  }
  return `Experiential backend request failed with HTTP ${status}`;
}
