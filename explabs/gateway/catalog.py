# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Build Experiential gateway catalogs from platform model rows, refreshed live.

The builder turns ``models`` / ``model_providers`` / ``model_waterfalls``
rows plus BYOK ``provider_connections`` into Experiential's authored ``ModelCatalog``,
its normalized content-addressed snapshot, one direct alias per model slug,
and (for waterfall chains) an ordered operator-certified exact-model pool.
Snapshots and alias revisions persist ONLY through int-P1's sanctioned write
paths (``gateway_register_catalog_snapshot`` / ``gateway_activate_alias_revision``).

Money lanes: a deployment reached through a customer's BYOK connection is
``customer_managed`` (pass-through); a deployment using platform-owned
credentials is ``host_managed`` (platform-funded). Platform credentials
canonically live as the house org's (:data:`HOUSE_ORG_SLUG`) Vault-backed
``provider_connections`` rows, released through the same RPC as BYOK keys;
worker env vars remain the documented fallback for local/preview runs where
Vault is empty. Per-org BYOK routing is org-aware ROUTE resolution: the
shared catalog carries one canonical deployment per provider row plus
per-connection variants, and :class:`OrgAwareRouteResolver` substitutes an
org's variant at resolve time without mutating any shared state.

Refresh: :class:`GatewayCatalogRefresher` polls a cheap watermark every 15s
and, on change, rebuilds the catalog and swaps one immutable
:class:`GatewayCatalogState` in-process (a single attribute assignment, so
in-flight requests keep the exact state they started with). The one
composition consequence for the worker (P4): Experiential's ``GatewayExecutor`` copies
its catalogs mapping at construction (``execution.py``), so the worker must
recompose the executor from ``state.runtime_catalogs`` after a swap; routes
and credentials themselves need no restart.

Public BYOK-by-default: a PUBLIC ``customer_managed`` row (no owning org, e.g.
every serverless Fireworks model the sync ingests) has no house funding, so it
becomes a fail-closed canonical carrying no shared credential. ``_add_variants``
attaches one per-org variant for each org holding a connection for the
provider, and :class:`OrgAwareRouteResolver` substitutes the caller's own key at
resolve time; a caller with no connection is rejected (``_require_byok_connection``)
rather than dispatched on any shared key.

Known launch limits (deliberate, surfaced in the PR):
- BYOK Bedrock is not routed by the gateway: Experiential installs a single Bedrock
  runtime factory per catalog keyed only by region, and bedrock's
  ``ConnectionConfig`` forbids ``api_key_env``, so one shared catalog cannot
  carry per-tenant boto sessions. Bedrock deployments ride the ambient AWS
  chain (``host_managed``) only; public BYOK-by-default covers Fireworks (an
  openai-compatible per-connection key) but not Bedrock. Lifting this needs a
  Experiential factory-signature change or per-org runtime catalogs (follow-up).
- An org waterfall override for a model the org does not own is skipped: the
  gateway alias table has one globally unique name per alias, so org-shadowed
  public aliases are not yet representable.
- An org-private deployment on a PUBLIC model is skipped: a shared alias must
  never resolve through one org's endpoint or credential; org-scoped rungs on
  public models need org-scoped route resolution (v2). The same guard covers
  org-owned ``modal`` endpoints on public models.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Annotated, LiteralString, Protocol

import psycopg
from exp.common.core.artifacts import JsonObject as ExpJsonObject
from exp.common.core.artifacts import canonical_json_bytes, sha256_json
from exp.common.models import (
    BillingSource,
    ConnectionConfig,
    ExactModelDeployment,
    GatewayDeploymentCapabilities,
    GatewayDeploymentMetadata,
    GatewayEquivalenceCertification,
    GatewayPoolRecord,
    GatewayTokenPrices,
    ModelCapabilities,
    ModelCatalog,
    ModelRecord,
    ModelRoles,
    NormalizedGatewayCatalog,
    normalize_gateway_catalog,
)
from exp.runtime.gateway.contracts import (
    DirectTarget,
    ExecutionSnapshot,
    GatewayFailure,
    GatewayFailureClass,
)
from exp.runtime.gateway.discovery import PublishedAliasMetadata
from exp.runtime.gateway.execution import GatewayExecutionError
from exp.runtime.gateway.routing import CatalogRouteResolver, GatewayRoute
from exp.runtime.models import RuntimeModelCatalog
from psycopg.types.json import Jsonb
from pydantic import (
    AwareDatetime,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    ValidationError,
)

from explabs.db.repositories import JsonObject
from explabs.db.stores.provider_connection_store import AzureConnectionConfig
from explabs.gateway.credentials import (
    PLATFORM_PROVIDER_CREDENTIAL_ENVS,
    ConnectionCredentialRef,
    CredentialReleaser,
    CredentialSourceKind,
    byok_credential_environment_name,
    release_connection_credential,
    resolve_gateway_credentials,
)
from explabs.gateway.experiential_cloud import (
    API_KEY_ENV as EXPERIENTIAL_CLOUD_API_KEY_ENV,
)
from explabs.gateway.experiential_cloud import (
    PROVIDER as EXPERIENTIAL_CLOUD_PROVIDER,
)
from explabs.gateway.experiential_cloud import (
    experiential_cloud_api_key,
    experiential_cloud_base_url,
)

if TYPE_CHECKING:
    from exp.runtime.gateway.contracts import AuthorizationSnapshot, GatewayRequest

_LOGGER = logging.getLogger(__name__)

_CATALOG_CATCH_UP_MIN_INTERVAL_SECONDS = 1.0

# Exact mapping from platform provider names to Experiential provider identifiers.
# Experiential has no named fireworks/modal families: both execute through the
# openai-compatible family with an explicit base_url (core-P1 documents the
# same contract on `model_providers.provider`).
_EXPERIENTIAL_PROVIDER_BY_PLATFORM: Mapping[str, str] = {
    "openai": "openai",
    "anthropic": "anthropic",
    "gemini": "gemini",
    "azure_openai": "azure",
    "openrouter": "openrouter",
    "bedrock": "bedrock",
    "local": "openai-compatible",
    "fireworks": "openai-compatible",
    "modal": "openai-compatible",
    "experiential_cloud": "openai-compatible",
}

# Hosted providers that execute through the openai-compatible family. The
# schema requires base_url on modal rows (each modal endpoint is its own
# origin) and forbids it on fireworks rows, whose endpoint is the one public
# inference origin below.
_OPENAI_COMPATIBLE_HOST_PROVIDERS = frozenset({"fireworks", "modal", EXPERIENTIAL_CLOUD_PROVIDER})
_DEFAULT_HOST_BASE_URLS: Mapping[str, str] = {
    "fireworks": "https://api.fireworks.ai/inference/v1",
}

# Azure's ConnectionConfig requires an explicit resource endpoint in base_url,
# even for a public BYOK placeholder connection. That placeholder is never
# dispatched -- a connectionless caller is rejected by the resolver, and
# OrgAwareRouteResolver substitutes the customer's real Azure endpoint per org
# at resolve time -- so this sentinel exists only to satisfy validation so the
# public alias can build. Every azure Foundry BYOK row would otherwise abort the
# whole catalog build.
_BYOK_PLACEHOLDER_AZURE_BASE_URL = "https://byok-placeholder.openai.azure.com/"

# Providers whose BYOK connections the gateway can route. Fireworks joins the
# HTTP providers because it executes through the openai-compatible family (a
# per-connection api_key_env in the shared runtime catalog, substituted per org
# at resolve time). Bedrock is still excluded: Experiential installs a single Bedrock
# runtime factory per catalog and its ConnectionConfig forbids api_key_env, so
# a shared catalog cannot carry per-tenant boto sessions (module docstring).
_BYOK_ROUTABLE_PROVIDERS = frozenset(
    {"openai", "anthropic", "gemini", "openrouter", "azure_openai", "fireworks"}
)

# House/platform-funded provider preference. When a platform-funded model is
# served by several providers that an operator has certified as one exact model
# (its ``model_waterfalls`` chain), its serving waterfall prefers those lanes in
# this order: Experiential Cloud first, then Azure Foundry, then AWS Bedrock,
# then a first-party direct API (OpenAI / Anthropic / Gemini), then Fireworks,
# then everything else (OpenRouter and customer-infra lanes) last. Lower rank
# serves first.
#
# "When possible" is literal: this only REORDERS deployments the model already
# serves and the operator already certified as equivalent -- it never adds a
# provider a model is not on, never widens the certified set, and never touches
# the equivalence certification's content digest (still addressed to the chain
# rows).
#
# It is also a preference over money the PLATFORM spends, so it applies only to
# the operator's default chain over ``host_managed`` rungs
# (:meth:`_CatalogAssembler._house_ordering_applies`). A tenant's own waterfall
# override and any ``customer_managed`` (BYOK) rung keep the persisted chain
# order exactly: the tenant chose that order for a credential it pays for.
_HOUSE_PROVIDER_PRIORITY: Mapping[str, int] = {
    EXPERIENTIAL_CLOUD_PROVIDER: 0,
    "azure_openai": 1,
    "bedrock": 2,
    "openai": 3,
    "anthropic": 3,
    "gemini": 3,
    "fireworks": 4,
}
# Any provider absent from the map (openrouter, local, modal) sorts last.
_HOUSE_PROVIDER_PRIORITY_DEFAULT = 5

_WATERFALL_CERTIFICATION_PROVENANCE = "platform:model_waterfalls"


def _house_provider_rank(provider: str) -> int:
    """Return one platform provider's house-lane serving-preference rank."""
    return _HOUSE_PROVIDER_PRIORITY.get(provider, _HOUSE_PROVIDER_PRIORITY_DEFAULT)


# The platform-funded lane's canonical credentials are this org's
# provider_connections rows (seeded by core-P2); worker env vars are the
# documented fallback for local/preview runs where Vault is empty.
HOUSE_ORG_SLUG = "experiential-labs-house"


class GatewayCatalogBuildError(ValueError):
    """Platform rows could not be assembled into a valid Experiential catalog."""


def _uuid_text(value: object) -> object:
    """Normalize DB uuid values to lowercase strings before validation."""
    if value is None or isinstance(value, str):
        return value
    return str(value).lower()


_UuidText = Annotated[str, BeforeValidator(_uuid_text)]
_UuidTextOrNone = Annotated[str | None, BeforeValidator(_uuid_text)]


class CatalogModelRow(BaseModel):
    """One ``models`` row (Contract 1) as read by the builder."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    id: _UuidText
    slug: str
    owning_org_id: _UuidTextOrNone = None
    status: str
    context_window: int | None = None
    max_output_tokens: int | None = None
    supported_params: JsonObject
    updated_at: AwareDatetime


class CatalogProviderRow(BaseModel):
    """One ``model_providers`` row (Contract 1) as read by the builder."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    id: _UuidText
    model_id: _UuidText
    provider: str
    provider_model_id: str
    base_url: str | None = None
    region: str | None = None
    api_version: str | None = None
    owning_org_id: _UuidTextOrNone = None
    provider_connection_id: _UuidTextOrNone = None
    billing_source: str
    input_micro_usd_per_million: int | None = None
    cached_input_micro_usd_per_million: int | None = None
    output_micro_usd_per_million: int | None = None
    reasoning_micro_usd_per_million: int | None = None
    pricing_source: str | None = None
    pricing_effective_at: AwareDatetime | None = None
    capabilities: JsonObject
    status: str
    created_at: AwareDatetime
    updated_at: AwareDatetime


class CatalogWaterfallRow(BaseModel):
    """One ``model_waterfalls`` rung (Contract 1) as read by the builder."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    id: _UuidText
    model_id: _UuidText
    org_id: _UuidTextOrNone = None
    position: int
    model_provider_id: _UuidText
    updated_at: AwareDatetime


class CatalogConnectionRow(BaseModel):
    """One BYOK ``provider_connections`` row (no credential material)."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    id: _UuidText
    org_id: _UuidText
    provider: str
    config: JsonObject
    serving_revision: int
    updated_at: AwareDatetime


@dataclass(frozen=True)
class PlatformCatalogRows:
    """Immutable snapshot of every catalog input row.

    ``house_org_id`` is the org whose connections fund the ``host_managed``
    lane (:data:`HOUSE_ORG_SLUG`); ``None`` until core-P2's seed exists, in
    which case the worker-env fallback applies.
    """

    models: tuple[CatalogModelRow, ...]
    providers: tuple[CatalogProviderRow, ...]
    waterfalls: tuple[CatalogWaterfallRow, ...]
    connections: tuple[CatalogConnectionRow, ...]
    house_org_id: str | None = None


def _select_rows(
    connection: psycopg.Connection[tuple[object, ...]],
    sql: LiteralString,
) -> list[dict[str, object]]:
    """Run one SELECT and return name-keyed rows."""
    cursor = connection.execute(sql)
    description = cursor.description
    if description is None:
        message = "catalog row query returned no result shape"
        raise GatewayCatalogBuildError(message)
    names = [column.name for column in description]
    return [dict(zip(names, row, strict=True)) for row in cursor.fetchall()]


def load_catalog_rows(
    connection: psycopg.Connection[tuple[object, ...]],
) -> PlatformCatalogRows:
    """Read every catalog input table in one deterministic pass.

    Args:
        connection: Direct Postgres connection (service authority).

    Returns:
        Typed row snapshot for :func:`build_gateway_catalog`.
    """
    models = _select_rows(
        connection,
        """
        select id, slug, owning_org_id, status, context_window, max_output_tokens,
               supported_params, updated_at
          from public.models
         order by slug, id
        """,
    )
    providers = _select_rows(
        connection,
        """
        select id, model_id, provider, provider_model_id, base_url, region,
               api_version, owning_org_id, provider_connection_id, billing_source,
               input_micro_usd_per_million, cached_input_micro_usd_per_million,
               output_micro_usd_per_million, reasoning_micro_usd_per_million,
               pricing_source, pricing_effective_at, capabilities, status,
               created_at, updated_at
          from public.model_providers
         order by created_at, id
        """,
    )
    waterfalls = _select_rows(
        connection,
        """
        select id, model_id, org_id, position, model_provider_id, updated_at
          from public.model_waterfalls
         order by model_id, org_id nulls first, position
        """,
    )
    connections = _select_rows(
        connection,
        """
        select id, org_id, provider, config, serving_revision, updated_at
          from public.provider_connections
         order by id
        """,
    )
    house_row = connection.execute(
        "select id from public.organizations where slug = %s", (HOUSE_ORG_SLUG,)
    ).fetchone()
    return PlatformCatalogRows(
        models=tuple(CatalogModelRow.model_validate(row) for row in models),
        providers=tuple(CatalogProviderRow.model_validate(row) for row in providers),
        waterfalls=tuple(CatalogWaterfallRow.model_validate(row) for row in waterfalls),
        connections=tuple(CatalogConnectionRow.model_validate(row) for row in connections),
        house_org_id=None if house_row is None else str(house_row[0]).lower(),
    )


class ProviderDataControls(BaseModel):
    """One provider's platform-curated data-handling posture.

    Flags describe the provider's DEFAULT documented API posture (retention
    and training), never a customer-specific agreement; the curated rows live
    in ``public.provider_data_controls`` with a source note each.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    provider: str
    zero_data_retention: bool
    no_training: bool


class OrgProviderPolicy(BaseModel):
    """One org's provider routing policy (allowlist + data-control requirements).

    Enforcement is always-on when a row exists: the policy is a governance
    control, so a lapsed enterprise license gates *editing*, never whether an
    existing policy keeps filtering routes.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    org_id: str
    allowed_providers: frozenset[str] | None
    require_zdr: bool
    require_no_training: bool

    def permits(self, provider: str, controls: Mapping[str, ProviderDataControls]) -> bool:
        """Whether a deployment on ``provider`` satisfies this policy.

        A provider absent from the curated controls table fails any required
        data-control flag: unknown posture is treated as non-compliant
        (fail closed), matching the table's own contract.
        """
        if self.allowed_providers is not None and provider not in self.allowed_providers:
            return False
        if self.require_zdr or self.require_no_training:
            posture = controls.get(provider)
            if posture is None:
                return False
            if self.require_zdr and not posture.zero_data_retention:
                return False
            if self.require_no_training and not posture.no_training:
                return False
        return True


def load_provider_policy_rows(
    connection: psycopg.Connection[tuple[object, ...]],
) -> tuple[Mapping[str, ProviderDataControls], Mapping[str, OrgProviderPolicy]]:
    """Read the curated data-controls matrix and every org provider policy.

    Args:
        connection: Direct Postgres connection (service authority).

    Returns:
        ``(controls_by_provider, policies_by_org_uuid)`` — org keys are
        lowercase uuids, matching the resolver's organization spelling.
    """
    controls: dict[str, ProviderDataControls] = {}
    for row in connection.execute(
        "select provider, zero_data_retention, no_training from public.provider_data_controls"
    ).fetchall():
        record = ProviderDataControls(
            provider=str(row[0]),
            zero_data_retention=bool(row[1]),
            no_training=bool(row[2]),
        )
        controls[record.provider] = record
    policies: dict[str, OrgProviderPolicy] = {}
    for row in connection.execute(
        """
        select org_id, allowed_providers, require_zdr, require_no_training
          from public.org_provider_policies
        """
    ).fetchall():
        allowed = row[1]
        policy = OrgProviderPolicy(
            org_id=str(row[0]).lower(),
            # psycopg returns text[] as a Python list; anything else (null) means
            # every provider is allowed.
            allowed_providers=(
                frozenset(str(p) for p in allowed) if isinstance(allowed, list) else None
            ),
            require_zdr=bool(row[2]),
            require_no_training=bool(row[3]),
        )
        policies[policy.org_id] = policy
    return controls, policies


class AliasActivationPlan(BaseModel):
    """One alias revision exactly as ``gateway_activate_alias_revision`` stores it."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    alias_id: str
    alias_name: str
    org_id: str | None
    revision_id: str
    target: DirectTarget
    target_deployment_ids: tuple[str, ...]
    catalog_sha256: str
    provider_connection_revisions: dict[str, int]
    certification: GatewayEquivalenceCertification | None
    certification_order: tuple[str, ...] = ()
    refusal_failover: bool = False

    def target_document(self) -> JsonObject:
        """Return the stored target: Experiential DirectTarget plus frozen order."""
        return {
            "kind": self.target.kind,
            "pool_id": self.target.pool_id,
            "deployment_ids": list(self.target_deployment_ids),
        }

    def certification_document(self) -> JsonObject | None:
        """Return the stored certification (int-P1 shape: engine fields + order)."""
        if self.certification is None:
            return None
        document: JsonObject = dict(self.certification.model_dump(mode="json"))
        document["order"] = list(self.certification_order)
        return document


@dataclass(frozen=True)
class GatewayCatalogBuild:
    """One deterministic catalog build and everything needed to serve it."""

    authored: ModelCatalog | None
    normalized: NormalizedGatewayCatalog | None
    catalog_sha256: str | None
    alias_plans: tuple[AliasActivationPlan, ...]
    byok_deployment_variants: Mapping[str, Mapping[str, str]]
    credential_refs: tuple[ConnectionCredentialRef, ...]
    warnings: tuple[str, ...]
    # Canonical deployment aliases that carry no shared credential: a route
    # still resolving to one means the caller brought no connection, and the
    # resolver must reject it rather than dispatch (fail-closed BYOK).
    byok_required_deployments: frozenset[str] = frozenset()

    @property
    def is_empty(self) -> bool:
        """Whether no routable deployment exists (nothing to register)."""
        return self.authored is None


def build_gateway_catalog(
    rows: PlatformCatalogRows,
    *,
    environment: Mapping[str, str],
    release_probe: CredentialReleaser | None = None,
) -> GatewayCatalogBuild:
    """Assemble platform rows into one deterministic Experiential catalog.

    Args:
        rows: Snapshot of the catalog input tables.
        environment: Worker environment, consulted only for platform provider
            credential PRESENCE (values never enter the build).
        release_probe: Optional BYOK Vault releaser, consulted only for
            credential RELEASABILITY (the released values are discarded and
            never enter the build). With a probe, a connection whose secret
            cannot be released — for example an undecryptable Vault row — is
            skipped with a warning, mirroring the missing-platform-credential
            rows, so one bad row degrades its own deployments instead of
            failing the whole build. Without one (offline/unit builds), rows
            are assumed releasable and state materialization enforces it.

    Returns:
        The immutable build, including per-alias activation plans.

    Raises:
        GatewayCatalogBuildError: Rows cannot form a valid Experiential catalog.
    """
    return _CatalogAssembler(rows, environment, release_probe=release_probe).build()


class _CatalogAssembler:
    """Single-use builder holding the intermediate catalog indexes."""

    def __init__(
        self,
        rows: PlatformCatalogRows,
        environment: Mapping[str, str],
        *,
        release_probe: CredentialReleaser | None = None,
    ) -> None:
        """Index the input rows for deterministic assembly."""
        self._environment = environment
        self._release_probe = release_probe
        # One probe per connection id per build; shared connections and
        # rebuild retries never multiply Vault round trips within one pass.
        self._probed_releasable: dict[str, bool] = {}
        self._house_org_id = rows.house_org_id
        self._models = sorted(rows.models, key=lambda row: (row.slug, row.id))
        self._providers_by_model: dict[str, list[CatalogProviderRow]] = {}
        for provider_row in sorted(rows.providers, key=lambda row: (row.created_at, row.id)):
            self._providers_by_model.setdefault(provider_row.model_id, []).append(provider_row)
        self._chains: dict[tuple[str, str | None], list[CatalogWaterfallRow]] = {}
        for rung in rows.waterfalls:
            self._chains.setdefault((rung.model_id, rung.org_id), []).append(rung)
        for chain in self._chains.values():
            chain.sort(key=lambda rung: rung.position)
        self._connection_by_id = {row.id: row for row in rows.connections}
        self._connections_by_org_provider = {
            (row.org_id, row.provider): row for row in rows.connections
        }
        self._connections_by_provider: dict[str, list[CatalogConnectionRow]] = {}
        for row in sorted(rows.connections, key=lambda item: item.id):
            self._connections_by_provider.setdefault(row.provider, []).append(row)
        # Assembled Experiential catalog pieces.
        self._catalog_connections: dict[str, ConnectionConfig] = {}
        self._catalog_models: dict[str, ModelRecord] = {}
        self._catalog_pools: dict[str, GatewayPoolRecord] = {}
        self._credential_refs: dict[str, ConnectionCredentialRef] = {}
        self._connection_row_by_deployment: dict[str, CatalogConnectionRow] = {}
        # The platform provider each canonical deployment alias serves through,
        # so a model's waterfall order can follow the house-lane preference.
        self._provider_by_alias: dict[str, str] = {}
        self._variants: dict[str, dict[str, str]] = {}
        # Canonical aliases for public customer_managed (BYOK-by-default) rows.
        # They carry no shared key; per-org variants route each caller's own
        # connection, and the resolver rejects a caller who has none (fail-closed).
        self._byok_required_canonicals: set[str] = set()
        self._warnings: list[str] = []

    def build(self) -> GatewayCatalogBuild:
        """Assemble the catalog, pools, variants, and alias plans."""
        plan_drafts: list[_AliasPlanDraft] = []
        for model in self._models:
            draft = self._assemble_model(model)
            if draft is not None:
                plan_drafts.append(draft)
        if not self._catalog_models:
            return GatewayCatalogBuild(
                authored=None,
                normalized=None,
                catalog_sha256=None,
                alias_plans=(),
                byok_deployment_variants={},
                credential_refs=(),
                warnings=tuple(self._warnings),
            )
        authored = ModelCatalog(
            connections=self._catalog_connections,
            models=self._catalog_models,
            gateway_pools=self._catalog_pools,
            roles=ModelRoles(),
        )
        normalized = normalize_gateway_catalog(authored)
        catalog_sha256 = normalized.identity_sha256()
        plans = tuple(
            sorted(
                (self._finalize_plan(draft, catalog_sha256) for draft in plan_drafts),
                key=lambda plan: plan.alias_id,
            )
        )
        return GatewayCatalogBuild(
            authored=authored,
            normalized=normalized,
            catalog_sha256=catalog_sha256,
            alias_plans=plans,
            byok_deployment_variants={
                org: dict(variants) for org, variants in sorted(self._variants.items())
            },
            credential_refs=tuple(
                self._credential_refs[name] for name in sorted(self._credential_refs)
            ),
            warnings=tuple(self._warnings),
            byok_required_deployments=frozenset(self._byok_required_canonicals),
        )

    # -- per-model assembly ---------------------------------------------------

    def _assemble_model(self, model: CatalogModelRow) -> _AliasPlanDraft | None:
        """Add one model's deployments, variants, pool, and alias plan draft."""
        canonical_by_provider_row: dict[str, str] = {}
        ordered_canonicals: list[str] = []
        for provider_row in self._providers_by_model.get(model.id, []):
            if provider_row.status == "disabled":
                continue
            alias = self._canonical_deployment(model, provider_row)
            if alias is None:
                continue
            canonical_by_provider_row[provider_row.id] = alias
            ordered_canonicals.append(alias)
            self._provider_by_alias[alias] = provider_row.provider
            self._add_variants(model, provider_row, alias)
        if not ordered_canonicals:
            self._warn(f"model {model.id} ({model.slug}) has no routable deployment; alias skipped")
            return None
        return self._draft_alias_plan(model, canonical_by_provider_row, ordered_canonicals)

    def _canonical_deployment(
        self, model: CatalogModelRow, provider_row: CatalogProviderRow
    ) -> str | None:
        """Register the row's canonical deployment and return its alias."""
        if not self._row_is_admissible(model, provider_row):
            return None
        if provider_row.provider_connection_id is not None:
            return self._pinned_deployment(model, provider_row)
        if provider_row.provider == "local":
            return self._local_deployment(model, provider_row)
        if provider_row.billing_source == "host_managed":
            return self._host_deployment(model, provider_row)
        return self._unpinned_customer_managed_deployment(model, provider_row)

    def _row_is_admissible(self, model: CatalogModelRow, provider_row: CatalogProviderRow) -> bool:
        """Reject rows no lane can carry, recording the reason."""
        provider = provider_row.provider
        if provider not in _EXPERIENTIAL_PROVIDER_BY_PLATFORM:
            self._warn(
                f"model_providers {provider_row.id}: provider {provider} has no launch "
                "credential lane; row skipped"
            )
            return False
        if _EXPERIENTIAL_PROVIDER_BY_PLATFORM[provider] != "openai-compatible" and (
            provider_row.base_url is not None
        ):
            self._warn(
                f"model_providers {provider_row.id}: base_url is only supported for "
                "the openai-compatible provider family; row skipped"
            )
            return False
        if model.owning_org_id is None and provider_row.owning_org_id is not None:
            # A shared alias resolving through one org's private endpoint or
            # credential would leak it to every tenant; org-scoped rungs on
            # public models need org-scoped route resolution (v2).
            self._warn(
                f"model_providers {provider_row.id}: org-private deployment on a public "
                "model is not routable through the shared alias; row skipped"
            )
            return False
        return True

    def _pinned_deployment(
        self, model: CatalogModelRow, provider_row: CatalogProviderRow
    ) -> str | None:
        """Register a deployment pinned to one explicit BYOK connection."""
        connection = self._connection_by_id.get(provider_row.provider_connection_id or "")
        if connection is None:
            self._warn(
                f"model_providers {provider_row.id}: pinned provider connection is gone; "
                "row skipped"
            )
            return None
        owner = provider_row.owning_org_id or model.owning_org_id
        if owner is None or connection.org_id != owner:
            self._warn(
                f"model_providers {provider_row.id}: pinned connection org does not own "
                "the deployment; row skipped so a private key never serves a shared alias"
            )
            return None
        if connection.provider != provider_row.provider:
            self._warn(
                f"model_providers {provider_row.id}: pinned connection provider "
                f"{connection.provider} does not match the row; row skipped"
            )
            return None
        return self._byok_deployment(model, provider_row, connection, alias_suffix=None)

    def _host_deployment(
        self, model: CatalogModelRow, provider_row: CatalogProviderRow
    ) -> str | None:
        """Register a platform-funded deployment.

        Credentials resolve from the house org's Vault-backed connection when
        one exists (the canonical production source), else from the worker
        environment (local/preview fallback), else the row is skipped.
        Bedrock always rides the ambient AWS chain.
        """
        provider = provider_row.provider
        provider_model = provider_row.provider_model_id
        house: CatalogConnectionRow | None = None
        if provider == "bedrock":
            connection_name = self._register_bedrock_connection(provider_row.region)
        elif provider in _OPENAI_COMPATIBLE_HOST_PROVIDERS:
            compatible = self._register_compatible_host_connection(provider_row)
            if compatible is None:
                return None
            connection_name, house = compatible
        elif provider == "azure_openai":
            azure = self._register_azure_host_connection(provider_row)
            if azure is None:
                return None
            connection_name, provider_model, house = azure
        else:
            fixed = self._register_fixed_origin_host_connection(provider_row)
            if fixed is None:
                return None
            connection_name, house = fixed
        alias = f"mp-{provider_row.id}"
        self._add_deployment_record(
            alias=alias,
            connection_name=connection_name,
            model=model,
            provider_row=provider_row,
            billing_source=BillingSource.HOST_MANAGED,
            provider_model=provider_model,
        )
        if house is not None:
            self._connection_row_by_deployment[alias] = house
        return alias

    def _house_connection(self, provider: str) -> CatalogConnectionRow | None:
        """Return the house org's connection for one provider, when seeded."""
        if self._house_org_id is None:
            return None
        return self._connections_by_org_provider.get((self._house_org_id, provider))

    def _register_fixed_origin_host_connection(
        self, provider_row: CatalogProviderRow
    ) -> tuple[str, CatalogConnectionRow | None] | None:
        """Resolve a fixed-origin host row: house connection, then env fallback."""
        provider = provider_row.provider
        house = self._house_connection(provider)
        if house is not None:
            name = self._register_byok_connection(house)
            if name is not None:
                return name, house
        name = self._register_platform_connection(provider)
        if name is None:
            self._warn(
                f"model_providers {provider_row.id}: host_managed {provider} has neither "
                "a house-org connection nor a configured platform credential; row skipped"
            )
            return None
        return name, None

    def _register_azure_host_connection(
        self, provider_row: CatalogProviderRow
    ) -> tuple[str, str, CatalogConnectionRow] | None:
        """Resolve a host Azure row through the house org's connection only."""
        house = self._house_connection("azure_openai")
        if house is None:
            self._warn(
                f"model_providers {provider_row.id}: host_managed azure_openai needs a "
                "house-org connection (no env fallback carries an endpoint); row skipped"
            )
            return None
        provider_model = self._byok_provider_model(provider_row, house)
        if provider_model is None:
            self._warn(
                f"model_providers {provider_row.id}: the house Azure connection has no "
                "deployment mapping for this wire id; row skipped"
            )
            return None
        name = self._register_byok_connection(house)
        if name is None:
            return None
        return name, provider_model, house

    def _register_compatible_host_connection(
        self, provider_row: CatalogProviderRow
    ) -> tuple[str, CatalogConnectionRow | None] | None:
        """Resolve a fireworks/modal/Experiential Cloud host row."""
        provider = provider_row.provider
        if provider == EXPERIENTIAL_CLOUD_PROVIDER:
            return self._register_experiential_cloud_connection(provider_row)
        base_url = provider_row.base_url or _DEFAULT_HOST_BASE_URLS.get(provider)
        if base_url is None:
            self._warn(
                f"model_providers {provider_row.id}: {provider} row has no endpoint and "
                "no default origin exists; row skipped"
            )
            return None
        house = self._house_connection(provider)
        # An unreleasable house secret falls through to the env fallback (the
        # probe records the warning): this path builds its BYOK_VAULT ref
        # inline, so it must probe like _register_byok_connection does or one
        # bad house row would abort the whole state materialization.
        if house is not None and not self._connection_releasable(house):
            house = None
        if house is not None:
            environment_name = byok_credential_environment_name(house.id)
            credential_ref = ConnectionCredentialRef(
                environment_name=environment_name,
                kind=CredentialSourceKind.BYOK_VAULT,
                selector=house.id,
            )
        else:
            fallback = PLATFORM_PROVIDER_CREDENTIAL_ENVS.get(provider)
            if fallback is None or not self._environment.get(fallback):
                self._warn(
                    f"model_providers {provider_row.id}: host_managed {provider} has "
                    "neither a house-org connection nor a configured platform "
                    "credential; row skipped"
                )
                return None
            environment_name = fallback
            credential_ref = ConnectionCredentialRef(
                environment_name=fallback,
                kind=CredentialSourceKind.PLATFORM_ENV,
                selector=fallback,
            )
        name = f"host-{provider_row.id}"
        self._catalog_connections[name] = ConnectionConfig(
            provider="openai-compatible",
            base_url=base_url,
            api_key_env=environment_name,
        )
        self._credential_refs[environment_name] = credential_ref
        return name, house

    def _register_experiential_cloud_connection(
        self, provider_row: CatalogProviderRow
    ) -> tuple[str, CatalogConnectionRow | None] | None:
        """Resolve a native vLLM row from the row URL or the worker environment.

        The origin and optional bearer stay on the worker. A missing origin
        leaves the row unroutable so production waterfalls stay unchanged
        until an operator configures the cutover environment. A configured
        origin with no bearer uses the keyless placeholder: cluster-internal
        vLLM deployments do not require a customer-visible secret.
        """
        base_url = experiential_cloud_base_url(self._environment, provider_row.base_url)
        if base_url is None:
            self._warn(
                f"model_providers {provider_row.id}: host_managed "
                f"{EXPERIENTIAL_CLOUD_PROVIDER} has no row endpoint and "
                "EXPLABS_EXPERIENTIAL_CLOUD_BASE_URL is unset; row skipped"
            )
            return None
        api_key = experiential_cloud_api_key(self._environment)
        if api_key is None:
            environment_name = byok_credential_environment_name(
                f"{EXPERIENTIAL_CLOUD_PROVIDER}:{provider_row.id}"
            )
            credential_ref = ConnectionCredentialRef(
                environment_name=environment_name,
                kind=CredentialSourceKind.PLACEHOLDER,
            )
        else:
            environment_name = EXPERIENTIAL_CLOUD_API_KEY_ENV
            credential_ref = ConnectionCredentialRef(
                environment_name=environment_name,
                kind=CredentialSourceKind.PLATFORM_ENV,
                selector=environment_name,
            )
        name = f"host-{provider_row.id}"
        try:
            self._catalog_connections[name] = ConnectionConfig(
                provider="openai-compatible",
                base_url=base_url,
                api_key_env=environment_name,
            )
        except ValidationError:
            self._warn(
                f"model_providers {provider_row.id}: Experiential Cloud base_url "
                "is not an acceptable endpoint; row skipped"
            )
            return None
        self._credential_refs[environment_name] = credential_ref
        return name, None

    def _local_deployment(
        self, model: CatalogModelRow, provider_row: CatalogProviderRow
    ) -> str | None:
        """Register a customer-run OpenAI-compatible deployment."""
        if (provider_row.owning_org_id or model.owning_org_id) is None:
            self._warn(
                f"model_providers {provider_row.id}: local deployments are customer "
                "infrastructure and need an owning org; row skipped"
            )
            return None
        if provider_row.base_url is None:
            self._warn(f"model_providers {provider_row.id}: local row lacks base_url; skipped")
            return None
        connection_name = f"local-{provider_row.id}"
        environment_name = byok_credential_environment_name(f"local:{provider_row.id}")
        try:
            connection_config = ConnectionConfig(
                provider="openai-compatible",
                base_url=provider_row.base_url,
                api_key_env=environment_name,
            )
        except ValidationError:
            self._warn(
                f"model_providers {provider_row.id}: local base_url is not an acceptable "
                "endpoint; row skipped"
            )
            return None
        self._catalog_connections[connection_name] = connection_config
        self._credential_refs[environment_name] = ConnectionCredentialRef(
            environment_name=environment_name,
            kind=CredentialSourceKind.PLACEHOLDER,
        )
        alias = f"mp-{provider_row.id}"
        self._add_deployment_record(
            alias=alias,
            connection_name=connection_name,
            model=model,
            provider_row=provider_row,
            billing_source=BillingSource.CUSTOMER_MANAGED,
            provider_model=provider_row.provider_model_id,
        )
        return alias

    def _unpinned_customer_managed_deployment(
        self, model: CatalogModelRow, provider_row: CatalogProviderRow
    ) -> str | None:
        """Register an unpinned customer_managed row.

        An owned row (private model or org-scoped deployment) rides its owning
        org's connection. A PUBLIC row is BYOK-by-default: it has no owning org
        to fund it, so it becomes a fail-closed canonical that every caller's
        own connection is substituted for at resolve time (:meth:`_add_variants`
        + :class:`OrgAwareRouteResolver`), and a caller without a connection is
        rejected rather than dispatched on any shared key.
        """
        owner = provider_row.owning_org_id or model.owning_org_id
        if owner is None:
            return self._public_byok_canonical(model, provider_row)
        connection = self._connections_by_org_provider.get((owner, provider_row.provider))
        if connection is None or provider_row.provider not in _BYOK_ROUTABLE_PROVIDERS:
            self._warn(
                f"model_providers {provider_row.id}: owning org has no routable "
                f"{provider_row.provider} connection; row skipped"
            )
            return None
        return self._byok_deployment(model, provider_row, connection, alias_suffix=None)

    def _public_byok_canonical(
        self, model: CatalogModelRow, provider_row: CatalogProviderRow
    ) -> str | None:
        """Register a fail-closed canonical for a public customer_managed row.

        The canonical carries a placeholder credential and never dispatches a
        shared key: it exists so the alias and its per-org BYOK variants can be
        built, and :class:`OrgAwareRouteResolver` rejects any caller whose route
        still resolves to it (no variant substituted → no connection).
        """
        if provider_row.provider not in _BYOK_ROUTABLE_PROVIDERS:
            self._warn(
                f"model_providers {provider_row.id}: public customer_managed "
                f"{provider_row.provider} is not BYOK-routable; row skipped"
            )
            return None
        connection_name = self._register_byok_required_connection(provider_row)
        if connection_name is None:
            return None
        alias = f"mp-{provider_row.id}"
        self._add_deployment_record(
            alias=alias,
            connection_name=connection_name,
            model=model,
            provider_row=provider_row,
            billing_source=BillingSource.CUSTOMER_MANAGED,
            provider_model=provider_row.provider_model_id,
        )
        self._byok_required_canonicals.add(alias)
        return alias

    def _byok_deployment(
        self,
        model: CatalogModelRow,
        provider_row: CatalogProviderRow,
        connection: CatalogConnectionRow,
        *,
        alias_suffix: str | None,
    ) -> str | None:
        """Register one customer_managed deployment bound to a BYOK connection."""
        if connection.provider not in _BYOK_ROUTABLE_PROVIDERS:
            self._warn(
                f"model_providers {provider_row.id}: BYOK {connection.provider} is not "
                "routable by the shared gateway catalog; row skipped"
            )
            return None
        provider_model = self._byok_provider_model(provider_row, connection)
        if provider_model is None:
            return None
        connection_name = self._register_byok_connection(connection)
        if connection_name is None:
            return None
        alias = (
            f"mp-{provider_row.id}"
            if alias_suffix is None
            else (f"mp-{provider_row.id}-c-{alias_suffix}")
        )
        self._add_deployment_record(
            alias=alias,
            connection_name=connection_name,
            model=model,
            provider_row=provider_row,
            billing_source=BillingSource.CUSTOMER_MANAGED,
            provider_model=provider_model,
        )
        self._connection_row_by_deployment[alias] = connection
        return alias

    def _add_variants(
        self, model: CatalogModelRow, provider_row: CatalogProviderRow, canonical: str
    ) -> None:
        """Register per-org BYOK variants substitutable for a canonical.

        Variants attach to two canonical kinds: a ``host_managed`` deployment
        (an org with a key overrides the platform lane) and a public
        BYOK-by-default canonical (an org with a key is the ONLY way it routes).
        An owning-org BYOK canonical already rides the org's key, and a pinned
        deployment is the pin's whole point, so neither gets variants. Azure
        variants require the connection's deployment-name map to cover this wire
        id; rows it does not cover simply have no variant for that org.
        """
        record = self._catalog_models[canonical]
        is_public_byok = canonical in self._byok_required_canonicals
        if record.billing_source is not BillingSource.HOST_MANAGED and not is_public_byok:
            return
        if provider_row.provider not in _BYOK_ROUTABLE_PROVIDERS:
            return
        if model.owning_org_id is not None:
            candidates = [
                connection
                for connection in self._connections_by_provider.get(provider_row.provider, [])
                if connection.org_id == model.owning_org_id
            ]
        else:
            # The house org's connection IS the host lane; a house "variant"
            # would be a self-substitution.
            candidates = [
                connection
                for connection in self._connections_by_provider.get(provider_row.provider, [])
                if connection.org_id != self._house_org_id
            ]
        for connection in candidates:
            alias = self._byok_deployment(
                model, provider_row, connection, alias_suffix=connection.id
            )
            if alias is not None:
                self._variants.setdefault(connection.org_id, {})[canonical] = alias

    def _byok_provider_model(
        self, provider_row: CatalogProviderRow, connection: CatalogConnectionRow
    ) -> str | None:
        """Return the provider-side model spelling for one BYOK connection."""
        if connection.provider != "azure_openai":
            return provider_row.provider_model_id
        try:
            config = AzureConnectionConfig.model_validate(connection.config)
        except ValidationError:
            self._warn(
                f"provider connection {connection.id}: malformed Azure config; "
                "its deployments are skipped"
            )
            return None
        deployment_name = config.deployments.get(provider_row.provider_model_id)
        if deployment_name is None:
            return None
        return deployment_name

    # -- connections and credential refs --------------------------------------

    def _register_platform_connection(self, provider: str) -> str | None:
        """Register the platform-funded connection for one provider, if configured."""
        environment_name = PLATFORM_PROVIDER_CREDENTIAL_ENVS.get(provider)
        if environment_name is None or not self._environment.get(environment_name):
            return None
        name = f"platform-{provider}"
        if name not in self._catalog_connections:
            self._catalog_connections[name] = ConnectionConfig(
                provider=_EXPERIENTIAL_PROVIDER_BY_PLATFORM[provider],
                api_key_env=environment_name,
            )
            self._credential_refs[environment_name] = ConnectionCredentialRef(
                environment_name=environment_name,
                kind=CredentialSourceKind.PLATFORM_ENV,
                selector=environment_name,
            )
        return name

    def _register_bedrock_connection(self, region: str | None) -> str:
        """Register the ambient-chain Bedrock connection for one region."""
        name = "platform-bedrock" if region is None else f"platform-bedrock-{region}"
        if name not in self._catalog_connections:
            self._catalog_connections[name] = ConnectionConfig(provider="bedrock", region=region)
        return name

    def _register_byok_connection(self, connection: CatalogConnectionRow) -> str | None:
        """Register one org connection and its Vault credential reference."""
        name = f"conn-{connection.id}"
        if name in self._catalog_connections:
            return name
        if not self._connection_releasable(connection):
            return None
        environment_name = byok_credential_environment_name(connection.id)
        if connection.provider == "azure_openai":
            try:
                config = AzureConnectionConfig.model_validate(connection.config)
            except ValidationError:
                self._warn(
                    f"provider connection {connection.id}: malformed Azure config; "
                    "its deployments are skipped"
                )
                return None
            connection_config = ConnectionConfig(
                provider="azure",
                base_url=config.endpoint,
                api_version=config.api_version or "v1",
                api_key_env=environment_name,
            )
        elif connection.provider in _OPENAI_COMPATIBLE_HOST_PROVIDERS:
            # Fireworks executes through the openai-compatible family, which
            # needs an explicit base_url (its one public inference origin) plus
            # the per-connection Vault key.
            base_url = _DEFAULT_HOST_BASE_URLS.get(connection.provider)
            if base_url is None:
                self._warn(
                    f"provider connection {connection.id}: {connection.provider} has no "
                    "default origin; connection skipped"
                )
                return None
            connection_config = ConnectionConfig(
                provider="openai-compatible",
                base_url=base_url,
                api_key_env=environment_name,
            )
        else:
            connection_config = ConnectionConfig(
                provider=_EXPERIENTIAL_PROVIDER_BY_PLATFORM[connection.provider],
                api_key_env=environment_name,
            )
        self._catalog_connections[name] = connection_config
        self._credential_refs[environment_name] = ConnectionCredentialRef(
            environment_name=environment_name,
            kind=CredentialSourceKind.BYOK_VAULT,
            selector=connection.id,
        )
        return name

    def _register_byok_required_connection(self, provider_row: CatalogProviderRow) -> str | None:
        """Register a placeholder-credential connection for a public BYOK row.

        The connection is structurally valid so the alias can build, but its
        credential is a placeholder, never a shared key. The canonical it backs
        is only ever reached by a caller with no connection, whom the resolver
        rejects before any dispatch, so the placeholder is never sent.
        """
        provider = provider_row.provider
        name = f"byok-required-{provider_row.id}"
        if name in self._catalog_connections:
            return name
        environment_name = byok_credential_environment_name(f"byok-required:{provider_row.id}")
        if provider in _OPENAI_COMPATIBLE_HOST_PROVIDERS:
            base_url = provider_row.base_url or _DEFAULT_HOST_BASE_URLS.get(provider)
            if base_url is None:
                self._warn(
                    f"model_providers {provider_row.id}: {provider} has no default origin; "
                    "row skipped"
                )
                return None
            connection_config = ConnectionConfig(
                provider="openai-compatible", base_url=base_url, api_key_env=environment_name
            )
        elif provider == "azure_openai":
            # Azure requires a resource endpoint even on this fail-closed
            # placeholder; the real per-org endpoint is substituted at resolve
            # time, so the sentinel only lets the public alias build.
            connection_config = ConnectionConfig(
                provider=_EXPERIENTIAL_PROVIDER_BY_PLATFORM[provider],
                base_url=provider_row.base_url or _BYOK_PLACEHOLDER_AZURE_BASE_URL,
                api_version="v1",
                api_key_env=environment_name,
            )
        else:
            connection_config = ConnectionConfig(
                provider=_EXPERIENTIAL_PROVIDER_BY_PLATFORM[provider], api_key_env=environment_name
            )
        self._catalog_connections[name] = connection_config
        self._credential_refs[environment_name] = ConnectionCredentialRef(
            environment_name=environment_name,
            kind=CredentialSourceKind.PLACEHOLDER,
        )
        return name

    # -- records, pools, and alias plans --------------------------------------

    def _add_deployment_record(
        self,
        *,
        alias: str,
        connection_name: str,
        model: CatalogModelRow,
        provider_row: CatalogProviderRow,
        billing_source: BillingSource,
        provider_model: str,
    ) -> None:
        """Author one deployment record with frozen prices and capabilities."""
        self._catalog_models[alias] = ModelRecord(
            connection=connection_name,
            model=provider_model,
            billing_source=billing_source,
            capabilities=_model_capabilities(model),
            gateway=GatewayDeploymentMetadata(
                exact_model_id=f"exact-{model.id}",
                capabilities=_gateway_capabilities(provider_row.capabilities),
                prices=GatewayTokenPrices(
                    input_micro_usd_per_million_tokens=provider_row.input_micro_usd_per_million,
                    cached_input_micro_usd_per_million_tokens=(
                        provider_row.cached_input_micro_usd_per_million
                    ),
                    output_micro_usd_per_million_tokens=provider_row.output_micro_usd_per_million,
                    reasoning_micro_usd_per_million_tokens=(
                        provider_row.reasoning_micro_usd_per_million
                    ),
                ),
                pricing_source=provider_row.pricing_source,
                pricing_effective_at=provider_row.pricing_effective_at,
            ),
        )

    def _house_ordered(self, aliases: Sequence[str]) -> list[str]:
        """Order canonical deployment aliases by the house-lane preference.

        Stable so deployments that share a provider rank keep their incoming
        order (the operator's chain positions, then row ``created_at``), which
        keeps the build deterministic and leaves operator intent intact within a
        provider tier.
        """
        return sorted(
            aliases,
            key=lambda alias: _house_provider_rank(self._provider_by_alias.get(alias, "")),
        )

    def _house_ordering_applies(self, routable: Sequence[str], chain_org: str | None) -> bool:
        """Whether the house-lane preference may order this certified pool.

        The preference ranks lanes the platform funds, so it governs only the
        operator's default chain (``chain_org is None``) across rungs the
        platform pays for. An org-scoped override is a tenant's explicit
        serving order, and a ``customer_managed`` rung spends the tenant's own
        credential (whether pinned, owner-funded, or BYOK-by-default), so
        either case keeps the persisted chain order untouched. A chain mixing
        funding lanes keeps it too: no rung ordering there is the platform's
        alone to choose.

        ``routable`` is the pool the alias actually serves, so a rung dropped as
        unroutable (its owning org holds no usable connection, say) does not
        make the surviving pool a customer's to order: what is left is spent
        entirely by the platform.
        """
        if chain_org is not None:
            return False
        return all(
            self._catalog_models[alias].billing_source is BillingSource.HOST_MANAGED
            for alias in routable
        )

    def _draft_alias_plan(
        self,
        model: CatalogModelRow,
        canonical_by_provider_row: Mapping[str, str],
        ordered_canonicals: Sequence[str],
    ) -> _AliasPlanDraft:
        """Choose the alias target: waterfall pool, or the first deployment."""
        chain, chain_org = self._model_chain(model)
        certification: GatewayEquivalenceCertification | None = None
        certification_order: tuple[str, ...] = ()
        if chain:
            routable = [
                canonical_by_provider_row[rung.model_provider_id]
                for rung in chain
                if rung.model_provider_id in canonical_by_provider_row
            ]
            if len(routable) < len(chain):
                self._warn(
                    f"model {model.id} ({model.slug}): waterfall names unroutable "
                    "deployments; the chain serves its routable rungs only"
                )
            # The chain certifies WHICH deployments pool together (one exact
            # model); the house-lane preference orders that certified set for
            # platform-funded serving. The certification digest stays addressed
            # to the operator's chain rows -- only the serving order changes.
            if self._house_ordering_applies(routable, chain_org):
                routable = self._house_ordered(routable)
        else:
            routable = []
        # The no-chain fallback below serves a SINGLE deployment from
        # ``ordered_canonicals``: those deployments are not operator-certified as
        # one exact model, so the house preference must not pick a different
        # primary among them. It orders only the certified ``routable`` pool.
        if len(routable) >= 2:
            pool_id = f"wf-{model.id}" if chain_org is None else f"wf-{model.id}-org-{chain_org}"
            certification = self._waterfall_certification(model, chain)
            certification_order = tuple(routable)
            self._catalog_pools[pool_id] = GatewayPoolRecord(
                exact_model_id=f"exact-{model.id}",
                deployment_aliases=certification_order,
                equivalence=certification,
            )
            target_pool = pool_id
            deployment_ids = certification_order
        elif routable:
            target_pool = routable[0]
            deployment_ids = (routable[0],)
        else:
            target_pool = ordered_canonicals[0]
            deployment_ids = (ordered_canonicals[0],)
        return _AliasPlanDraft(
            model=model,
            target_pool_id=target_pool,
            deployment_ids=deployment_ids,
            certification=certification,
            certification_order=certification_order,
        )

    def _model_chain(self, model: CatalogModelRow) -> tuple[list[CatalogWaterfallRow], str | None]:
        """Return the model's applicable waterfall chain and its org scope."""
        for (model_id, org_id), _chain in sorted(
            self._chains.items(), key=lambda item: (item[0][0], item[0][1] or "")
        ):
            if model_id != model.id or org_id is None:
                continue
            if org_id != model.owning_org_id:
                self._warn(
                    f"model {model.id} ({model.slug}): org {org_id} waterfall override is "
                    "not representable by the shared alias table; override skipped"
                )
        override = (
            self._chains.get((model.id, model.owning_org_id))
            if model.owning_org_id is not None
            else None
        )
        if override:
            return override, model.owning_org_id
        return self._chains.get((model.id, None), []), None

    def _waterfall_certification(
        self, model: CatalogModelRow, chain: Sequence[CatalogWaterfallRow]
    ) -> GatewayEquivalenceCertification:
        """Synthesize the operator certification from the chain's row content.

        The id is content-addressed to the exact chain rows. Experiential's
        ``ArtifactId`` pattern requires a leading letter, so the digest wears
        the constant ``wfcert-`` prefix ("wfcert-" + 64 hex = 71 chars, within
        the 128-char cap); ``evidence_sha256`` keeps the raw digest.
        """
        content = [
            {
                "id": rung.id,
                "model_id": rung.model_id,
                "org_id": rung.org_id,
                "position": rung.position,
                "model_provider_id": rung.model_provider_id,
                "updated_at": rung.updated_at.isoformat(),
            }
            for rung in chain
        ]
        digest = sha256_json(content)
        try:
            return GatewayEquivalenceCertification(
                certification_id=f"wfcert-{digest}",
                provenance=_WATERFALL_CERTIFICATION_PROVENANCE,
                evidence_sha256=digest,
                certified_at=max(rung.updated_at for rung in chain),
            )
        except ValidationError as exc:
            raise GatewayCatalogBuildError(
                f"synthesized waterfall certification for model {model.id} ({model.slug}) "
                "failed the pinned Experiential contract validator"
            ) from exc

    def _finalize_plan(self, draft: _AliasPlanDraft, catalog_sha256: str) -> AliasActivationPlan:
        """Bind one alias plan to the catalog digest and derive its revision id."""
        model = draft.model
        alias_id = f"model-{model.id}"
        revisions: dict[str, int] = {}
        for deployment_id in draft.deployment_ids:
            connection = self._connection_row_by_deployment.get(deployment_id)
            if connection is not None:
                revisions[connection.id] = connection.serving_revision
            for variants in self._variants.values():
                variant_alias = variants.get(deployment_id)
                if variant_alias is None:
                    continue
                variant_connection = self._connection_row_by_deployment.get(variant_alias)
                if variant_connection is not None:
                    revisions[variant_connection.id] = variant_connection.serving_revision
        certification_document = (
            None
            if draft.certification is None
            else {
                **draft.certification.model_dump(mode="json"),
                "order": list(draft.certification_order),
            }
        )
        revision_payload: JsonObject = {
            "alias_id": alias_id,
            "alias_name": model.slug,
            "org_id": model.owning_org_id,
            "target": {
                "kind": "direct",
                "pool_id": draft.target_pool_id,
                "deployment_ids": list(draft.deployment_ids),
            },
            "catalog_sha256": catalog_sha256,
            "provider_connection_revisions": dict(sorted(revisions.items())),
            "certification": certification_document,
            "refusal_failover": False,
        }
        return AliasActivationPlan(
            alias_id=alias_id,
            alias_name=model.slug,
            org_id=model.owning_org_id,
            revision_id=f"rev-{sha256_json(revision_payload)}",
            target=DirectTarget(pool_id=draft.target_pool_id),
            target_deployment_ids=draft.deployment_ids,
            catalog_sha256=catalog_sha256,
            provider_connection_revisions=dict(sorted(revisions.items())),
            certification=draft.certification,
            certification_order=draft.certification_order,
        )

    def _connection_releasable(self, connection: CatalogConnectionRow) -> bool:
        """Probe one connection's Vault release, recording a skip on failure.

        The released value is discarded immediately; only releasability enters
        the build. A connection whose secret cannot be released (for example an
        undecryptable Vault row) would otherwise fail the WHOLE state
        materialization and crashloop every worker, so it is skipped here with
        a warning exactly like a missing platform credential.
        """
        if self._release_probe is None:
            return True
        cached = self._probed_releasable.get(connection.id)
        if cached is not None:
            return cached
        releasable = True
        try:
            released = self._release_probe(connection.id)
        except Exception:  # noqa: BLE001 - any release failure is this row's problem only
            releasable = False
        else:
            releasable = bool(released)
        if not releasable:
            self._warn(
                f"provider connection {connection.id}: credential release failed; "
                "its deployments are skipped"
            )
        self._probed_releasable[connection.id] = releasable
        return releasable

    def _warn(self, message: str) -> None:
        """Record one secret-free skip reason."""
        self._warnings.append(message)


@dataclass(frozen=True)
class _AliasPlanDraft:
    """Alias plan pieces known before the catalog digest exists."""

    model: CatalogModelRow
    target_pool_id: str
    deployment_ids: tuple[str, ...]
    certification: GatewayEquivalenceCertification | None
    certification_order: tuple[str, ...]


def _model_capabilities(model: CatalogModelRow) -> ModelCapabilities:
    """Project the model row's declared parameters onto Experiential capabilities."""
    supported = model.supported_params

    def _declared(name: str) -> bool | None:
        value = supported.get(name)
        return value if isinstance(value, bool) else None

    return ModelCapabilities(
        supports_tools=_declared("tools"),
        supports_temperature=_declared("temperature") is not False,
        supports_structured_output=_declared("structured_outputs") is True,
        context_window_tokens=model.context_window,
        maximum_output_tokens=model.max_output_tokens,
    )


def _gateway_capabilities(capabilities: JsonObject) -> GatewayDeploymentCapabilities:
    """Project the row's capability booleans onto Experiential's declaration.

    Unknown keys and non-boolean values are ignored: the jsonb column mixes
    gateway protocol booleans with display metadata by design (core-P1).
    """
    declared = {
        name: value
        for name, value in capabilities.items()
        if name in GatewayDeploymentCapabilities.model_fields and isinstance(value, bool)
    }
    return GatewayDeploymentCapabilities.model_validate(declared)


# -- persistence ---------------------------------------------------------------


@dataclass(frozen=True)
class CatalogStoreResult:
    """What one store pass changed (idempotent re-runs report no changes).

    ``skipped_aliases`` carries the (alias name, sanitized reason) pairs whose
    activation hit a foreign-key violation (orphaned per-row data) and was
    skipped so the rest of the catalog still landed; the refresher logs each
    one loudly. Identity-guard violations (alias identity drift, namespace
    collisions, revision content drift) are never skipped — they abort the
    store pass because a catalog that disagrees with its stored identities
    must not serve.
    """

    snapshot_changed: bool
    alias_changes: tuple[tuple[str, bool], ...]
    skipped_aliases: tuple[tuple[str, str], ...] = ()
    # Catalog aliases NOT synthesized because an admin-managed named alias
    # (origin='named', P-E) already owns that (name, org) namespace. Skipping
    # them is what "the catalog builder respects origin" means in practice: a
    # named alias and a same-named org model would otherwise collide on the
    # (alias_name, org_id) unique constraint and abort the whole build.
    named_alias_shadowed: tuple[str, ...] = ()


def store_gateway_catalog(
    connection: psycopg.Connection[tuple[object, ...]],
    build: GatewayCatalogBuild,
) -> CatalogStoreResult:
    """Persist one build through int-P1's sanctioned write paths and commit.

    Args:
        connection: Direct Postgres connection (service authority).
        build: A non-empty or empty catalog build.

    Returns:
        Change flags from the idempotent register/activate functions.
    """
    if build.authored is None or build.normalized is None or build.catalog_sha256 is None:
        connection.commit()
        return CatalogStoreResult(snapshot_changed=False, alias_changes=())
    document = json.loads(canonical_json_bytes(build.normalized))
    models_document = json.loads(canonical_json_bytes(build.authored))
    row = connection.execute(
        "select changed from public.gateway_register_catalog_snapshot(%s, %s, %s)",
        (build.catalog_sha256, Jsonb(document), Jsonb(models_document)),
    ).fetchone()
    snapshot_changed = bool(row[0]) if row is not None else False
    # Named aliases (P-E) are admin-managed rows the builder must not touch. A
    # named alias and an org model can share a (name, org) namespace, so a
    # catalog alias for such a model would collide on the alias_name/org_id
    # unique constraint and abort the entire build. Skip those plans instead:
    # the named alias is the operator's deliberate override for that slug.
    #
    # Shadow by ROW EXISTENCE, not by `active`. The namespace is held by the row:
    # `gateway_aliases` has `unique nulls not distinct (alias_name, org_id)` and
    # gateway_activate_alias_revision's collision check raises 23505 for any other
    # alias_id in that namespace with NO `active` predicate. A retired alias
    # (active=false) keeps its row for rollback history, so it still holds the
    # name. Filtering on `and active` here would let the builder try to synthesize
    # the shadowed model's catalog alias against that still-present row -> 23505
    # propagates out of store_gateway_catalog -> the refresher aborts every tick
    # -> gateway-wide routing freezes on a stale generation. Retiring a named
    # alias is reversible via rollback and deliberately keeps the name reserved;
    # releasing it would need a hard delete, not a soft deactivate.
    named_rows = connection.execute(
        "select alias_name, org_id::text from public.gateway_aliases where origin = 'named'"
    ).fetchall()
    named_namespace = {(str(name), str(org)) for name, org in named_rows}
    alias_changes: list[tuple[str, bool]] = []
    skipped: list[tuple[str, str]] = []
    shadowed: list[str] = []
    for plan in build.alias_plans:
        if plan.org_id is not None and (plan.alias_name, plan.org_id) in named_namespace:
            shadowed.append(plan.alias_name)
            continue
        certification_document = plan.certification_document()
        # Per-alias savepoint: a plan referencing a row that ordinary data
        # operations can orphan (an alias org deleted past its FK by a
        # replication-role write raises 23503) must degrade only its own
        # alias, never abort the whole store — an aborted store keeps every
        # worker's catalog from loading and crashloops the fleet. ONLY the
        # foreign-key shape is absorbed: gateway_activate_alias_revision's
        # identity guard raises 23505 for alias identity drift, namespace
        # collisions, and revision content drift, and those are catalog
        # INTEGRITY violations that must stay fatal and loud — swallowing
        # them per-row would serve a catalog whose identities silently
        # disagree with the database (the exact failure a slug-renaming
        # migration without its alias reconcile produces).
        try:
            with connection.transaction():
                alias_row = connection.execute(
                    """
                    select changed from public.gateway_activate_alias_revision(
                      %s, %s, %s::uuid, %s, %s, %s, %s, %s, %s
                    )
                    """,
                    (
                        plan.alias_id,
                        plan.alias_name,
                        plan.org_id,
                        plan.revision_id,
                        Jsonb(plan.target_document()),
                        plan.catalog_sha256,
                        Jsonb(plan.provider_connection_revisions),
                        None if certification_document is None else Jsonb(certification_document),
                        plan.refusal_failover,
                    ),
                ).fetchone()
        except psycopg.errors.ForeignKeyViolation as error:
            diagnostic = error.diag.message_primary
            skipped.append((plan.alias_name, str(error) if diagnostic is None else diagnostic))
            continue
        alias_changes.append(
            (plan.alias_name, bool(alias_row[0]) if alias_row is not None else False)
        )
    connection.commit()
    return CatalogStoreResult(
        snapshot_changed=snapshot_changed,
        alias_changes=tuple(alias_changes),
        skipped_aliases=tuple(skipped),
        named_alias_shadowed=tuple(shadowed),
    )


# -- watermark -------------------------------------------------------------------


@dataclass(frozen=True)
class CatalogWatermark:
    """Cheap change detector over every catalog input surface."""

    models_count: int
    models_updated_at: str | None
    providers_count: int
    providers_updated_at: str | None
    waterfalls_count: int
    waterfalls_updated_at: str | None
    connections_count: int
    connections_updated_at: str | None
    connections_serving_revision: int
    alias_revisions_count: int
    # Provider data-control inputs (defaults keep pre-existing constructions
    # comparable: a build without these tables reads as "no policy inputs").
    provider_policies_count: int = 0
    provider_policies_updated_at: str | None = None
    data_controls_updated_at: str | None = None


def read_catalog_watermark(
    connection: psycopg.Connection[tuple[object, ...]],
) -> CatalogWatermark:
    """Read the current watermark in one round trip.

    Args:
        connection: Direct Postgres connection.

    Returns:
        The comparable watermark snapshot.
    """
    row = connection.execute(
        """
        select
          (select count(*) from public.models),
          (select max(updated_at)::text from public.models),
          (select count(*) from public.model_providers),
          (select max(updated_at)::text from public.model_providers),
          (select count(*) from public.model_waterfalls),
          (select max(updated_at)::text from public.model_waterfalls),
          (select count(*) from public.provider_connections),
          (select max(updated_at)::text from public.provider_connections),
          (select coalesce(max(serving_revision), 0) from public.provider_connections),
          (select count(*) from public.gateway_alias_revisions),
          (select count(*) from public.org_provider_policies),
          (select max(updated_at)::text from public.org_provider_policies),
          (select max(updated_at)::text from public.provider_data_controls)
        """
    ).fetchone()
    if row is None:
        message = "catalog watermark query returned no row"
        raise GatewayCatalogBuildError(message)
    return CatalogWatermark(
        models_count=int(str(row[0])),
        models_updated_at=None if row[1] is None else str(row[1]),
        providers_count=int(str(row[2])),
        providers_updated_at=None if row[3] is None else str(row[3]),
        waterfalls_count=int(str(row[4])),
        waterfalls_updated_at=None if row[5] is None else str(row[5]),
        connections_count=int(str(row[6])),
        connections_updated_at=None if row[7] is None else str(row[7]),
        connections_serving_revision=int(str(row[8])),
        alias_revisions_count=int(str(row[9])),
        provider_policies_count=int(str(row[10])),
        provider_policies_updated_at=None if row[11] is None else str(row[11]),
        data_controls_updated_at=None if row[12] is None else str(row[12]),
    )


# -- in-process state and org-aware resolution -----------------------------------


@dataclass(frozen=True)
class GatewayCatalogState:
    """One immutable generation of everything a worker serves from.

    ``route_catalogs`` / ``runtime_catalogs`` include the PREVIOUS generation's
    keys as a grace window so requests authorized moments before a swap still
    resolve; ``generation_keys`` names only the current build's keys.
    """

    build: GatewayCatalogBuild
    credentials: Mapping[str, str]
    generation_keys: frozenset[tuple[str, str]]
    route_catalogs: Mapping[tuple[str, str], NormalizedGatewayCatalog]
    runtime_catalogs: Mapping[tuple[str, str], RuntimeModelCatalog]
    deployments_by_key: Mapping[tuple[str, str], Mapping[str, ExactModelDeployment]]
    variants_by_key: Mapping[tuple[str, str], Mapping[str, Mapping[str, str]]]
    resolver: CatalogRouteResolver
    # Per key, the canonical deployment ids that require a caller BYOK connection;
    # a resolved route still naming one means the caller has none (fail-closed).
    byok_required_by_key: Mapping[tuple[str, str], frozenset[str]] = field(default_factory=dict)
    # Provider routing governance: the curated per-provider data-control matrix
    # and each org's policy (lowercase-uuid keyed). Enforced by the resolver on
    # every route; the rebuilt execution snapshot makes the SQL dispatch gate
    # back the filter without touching gateway_start_attempt.
    provider_controls: Mapping[str, ProviderDataControls] = field(default_factory=dict)
    provider_policies: Mapping[str, OrgProviderPolicy] = field(default_factory=dict)


def build_catalog_state(
    build: GatewayCatalogBuild,
    *,
    environment: Mapping[str, str],
    release: CredentialReleaser,
    previous: GatewayCatalogState | None = None,
    provider_controls: Mapping[str, ProviderDataControls] | None = None,
    provider_policies: Mapping[str, OrgProviderPolicy] | None = None,
) -> GatewayCatalogState:
    """Materialize credentials and Experiential runtime objects for one build.

    Args:
        build: The deterministic catalog build to serve.
        environment: Worker environment for platform credentials.
        release: BYOK Vault releaser.
        previous: The state being replaced; its own generation is kept as a
            one-generation grace window for requests already authorized.
        provider_controls: Curated per-provider data-control matrix
            (``load_provider_policy_rows``); empty means no curated rows.
        provider_policies: Org provider policies keyed by lowercase org uuid;
            empty means no org has a policy installed.

    Returns:
        The immutable state a refresher swaps in with one assignment.
    """
    credentials = resolve_gateway_credentials(
        build.credential_refs, environment=environment, release=release
    )
    route_catalogs: dict[tuple[str, str], NormalizedGatewayCatalog] = {}
    runtime_catalogs: dict[tuple[str, str], RuntimeModelCatalog] = {}
    deployments_by_key: dict[tuple[str, str], Mapping[str, ExactModelDeployment]] = {}
    variants_by_key: dict[tuple[str, str], Mapping[str, Mapping[str, str]]] = {}
    byok_required_by_key: dict[tuple[str, str], frozenset[str]] = {}
    if previous is not None:
        for key in previous.generation_keys:
            route_catalogs[key] = previous.route_catalogs[key]
            runtime_catalogs[key] = previous.runtime_catalogs[key]
            deployments_by_key[key] = previous.deployments_by_key[key]
            variants_by_key[key] = previous.variants_by_key[key]
            byok_required_by_key[key] = previous.byok_required_by_key.get(key, frozenset())
    generation_keys: set[tuple[str, str]] = set()
    authored = build.authored
    normalized = build.normalized
    catalog_sha256 = build.catalog_sha256
    if authored is not None and normalized is not None and catalog_sha256 is not None:
        runtime = RuntimeModelCatalog(authored, environment=credentials)
        deployments = {
            deployment.deployment_id: deployment for deployment in normalized.deployments
        }
        for plan in build.alias_plans:
            key = (plan.revision_id, catalog_sha256)
            generation_keys.add(key)
            route_catalogs[key] = normalized
            runtime_catalogs[key] = runtime
            deployments_by_key[key] = deployments
            variants_by_key[key] = build.byok_deployment_variants
            byok_required_by_key[key] = build.byok_required_deployments
    return GatewayCatalogState(
        build=build,
        credentials=credentials,
        generation_keys=frozenset(generation_keys),
        route_catalogs=route_catalogs,
        runtime_catalogs=runtime_catalogs,
        deployments_by_key=deployments_by_key,
        variants_by_key=variants_by_key,
        resolver=CatalogRouteResolver(route_catalogs),
        byok_required_by_key=byok_required_by_key,
        provider_controls={} if provider_controls is None else provider_controls,
        provider_policies={} if provider_policies is None else provider_policies,
    )


def _organization_uuid(organization_id: str) -> str:
    """Strip the ArtifactId-safe ``org-`` spelling back to the org uuid."""
    return organization_id.removeprefix("org-")


def _require_byok_connection(route: GatewayRoute, byok_required: frozenset[str]) -> None:
    """Fail closed when a route resolves only to unfunded BYOK canonicals.

    A public customer_managed (BYOK-by-default) canonical carries no shared
    credential. If every deployment still in the route is such a canonical, the
    caller supplied no connection for the model's provider, so reject the request
    with a clear message rather than dispatch a placeholder or any shared key.
    """
    if not byok_required:
        return
    if all(deployment.deployment_id in byok_required for deployment in route.deployments):
        raise GatewayExecutionError(
            GatewayFailure(
                failure_class=GatewayFailureClass.INVALID_REQUEST,
                safe_message=(
                    "This model requires your own provider API key. Connect the model's "
                    "provider under your workspace's provider keys (Bring Your Own Key) "
                    "and retry."
                ),
            )
        )


def _apply_provider_policy(
    route: GatewayRoute,
    state: GatewayCatalogState,
    organization: str,
) -> GatewayRoute:
    """Filter the route's deployments through the org's provider policy.

    Governance semantics (enterprise E5.3): the org's allowlist and
    data-control requirements (zero-data-retention / no-training) remove
    non-compliant deployments from the route. The execution snapshot is
    rebuilt to the surviving deployment ids, so ``gateway_start_attempt``'s
    dispatch gate — which refuses any deployment absent from the snapshot —
    backs this filter without a SQL change. Applies to every lane, BYOK
    included: this is a governance control, not a spend control.

    Raises:
        GatewayExecutionError: No deployment satisfies the policy.
    """
    policy = state.provider_policies.get(organization)
    if policy is None:
        return route
    kept = tuple(
        deployment
        for deployment in route.deployments
        if policy.permits(deployment.provider, state.provider_controls)
    )
    if len(kept) == len(route.deployments):
        return route
    if not kept:
        requirements: list[str] = []
        if policy.allowed_providers is not None:
            requirements.append("the provider allowlist")
        if policy.require_zdr:
            requirements.append("zero-data-retention providers only")
        if policy.require_no_training:
            requirements.append("no-training providers only")
        raise GatewayExecutionError(
            GatewayFailure(
                failure_class=GatewayFailureClass.AUTHORIZATION,
                safe_message=(
                    "No route for this model satisfies your organization's provider "
                    f"policy ({'; '.join(requirements)}). An organization admin can "
                    "adjust the policy under Settings → Provider policy."
                ),
            )
        )
    # Same rebuild rule as BYOK variant substitution: the snapshot pins what
    # the ledger lets an attempt dispatch, so it must name exactly the
    # surviving deployments.
    return GatewayRoute(
        snapshot=ExecutionSnapshot(
            authorization=route.snapshot.authorization,
            exact_model_id=route.snapshot.exact_model_id,
            pool_id=route.snapshot.pool_id,
            deployment_ids=tuple(item.deployment_id for item in kept),
        ),
        deployment=kept[0],
        fallback_deployments=kept[1:],
        route_reason=route.route_reason,
        fallback_reason=route.fallback_reason,
    )


class GatewayCatalogStateProvider(Protocol):
    """Provide the current catalog state for an authorized catalog key."""

    def state_for_key_if_loaded(self, key: tuple[str, str]) -> GatewayCatalogState | None:
        """Return the current state when it already contains ``key``."""
        ...

    def state_for_key(self, key: tuple[str, str]) -> GatewayCatalogState:
        """Return a state containing ``key``, refreshing synchronously if needed."""
        ...


@dataclass(frozen=True)
class PricedAliasMetadata(PublishedAliasMetadata):
    """exp's published listing fields extended with the reasoning rate.

    ``PublishedAliasMetadata`` renders ``pricing`` with input/output/cached
    micro-USD-per-million-tokens keys; the catalog also declares a reasoning
    rate, published here in the same spelling so the extension object carries
    every rate settlement can charge.
    """

    reasoning_micro_usd_per_million_tokens: int | None = None

    def extension_fields(self) -> ExpJsonObject:
        """Extend exp's rendering with the declared reasoning rate."""
        fields = super().extension_fields()
        if self.reasoning_micro_usd_per_million_tokens is not None:
            raw = fields.get("pricing")
            pricing = raw if isinstance(raw, dict) else {}
            pricing["reasoning_micro_usd_per_million_tokens"] = (
                self.reasoning_micro_usd_per_million_tokens
            )
            fields["pricing"] = pricing
        return fields


def listing_pricing_by_alias(
    state: GatewayCatalogState,
) -> dict[tuple[str, str], PricedAliasMetadata]:
    """Map every served alias REVISION to its primary rung's catalog rates.

    Keyed by ``(alias_name, revision_id)`` — the exact identity exp's listing
    lookup presents — so an organization whose granted authority names an
    org-scoped plan (its own custom model or org-specific revision) publishes
    THAT plan's rates, never a same-named public plan's. The published rates
    are the plan's primary rung — the deployment settlement freezes onto the
    attempt for platform-funded traffic (exp's own ``published_metadata``
    stays silent for multi-deployment pools; the platform deliberately
    publishes the primary rung instead so waterfall models still carry the
    list price of the route they normally dispatch). The plan's frozen
    ``target_deployment_ids`` carry AUTHORED deployment aliases while
    ``deployments_by_key`` is keyed by NORMALIZED deployment ids, so
    resolution goes through the normalized pool exactly like the worker's
    readiness probe, with the direct id lookup as the fallback for states
    built without a normalized catalog. Only price fields are published —
    capabilities and limits stay unclaimed. A rate the catalog does not
    declare stays absent ("unknown"), never 0.
    """
    build = state.build
    catalog_sha256 = build.catalog_sha256
    if catalog_sha256 is None:
        return {}
    pools_by_id = (
        {} if build.normalized is None else {pool.pool_id: pool for pool in build.normalized.pools}
    )
    pricing_by_alias: dict[tuple[str, str], PricedAliasMetadata] = {}
    for plan in build.alias_plans:
        deployments = state.deployments_by_key.get((plan.revision_id, catalog_sha256), {})
        pool = pools_by_id.get(plan.target.pool_id)
        candidate_ids = plan.target_deployment_ids if pool is None else tuple(pool.deployment_ids)
        primary: ExactModelDeployment | None = None
        for deployment_id in candidate_ids:
            primary = deployments.get(deployment_id)
            if primary is not None:
                break
        if primary is None:
            continue
        prices = primary.gateway.prices
        if (
            prices.input_micro_usd_per_million_tokens is None
            and prices.output_micro_usd_per_million_tokens is None
            and prices.cached_input_micro_usd_per_million_tokens is None
            and prices.reasoning_micro_usd_per_million_tokens is None
        ):
            continue
        pricing_by_alias[(plan.alias_name, plan.revision_id)] = PricedAliasMetadata(
            input_micro_usd_per_million_tokens=prices.input_micro_usd_per_million_tokens,
            output_micro_usd_per_million_tokens=prices.output_micro_usd_per_million_tokens,
            cached_input_micro_usd_per_million_tokens=(
                prices.cached_input_micro_usd_per_million_tokens
            ),
            reasoning_micro_usd_per_million_tokens=(prices.reasoning_micro_usd_per_million_tokens),
        )
    return pricing_by_alias


class OrgAwareRouteResolver:
    """Resolve routes against the current state, substituting org BYOK variants.

    When the caller's org holds a BYOK connection for a deployment's provider,
    the resolved route swaps that deployment for the org's ``customer_managed``
    variant (pass-through lane). Substitution builds a new ``GatewayRoute``;
    shared catalog state is never mutated.
    """

    def __init__(self, state_provider: GatewayCatalogStateProvider) -> None:
        """Bind the key-aware live state accessor."""
        self._state_provider = state_provider
        # Per-generation listing pricing cache (published_metadata); rebuilt
        # whenever the immutable state object swaps. Benign to race: a
        # concurrent rebuild produces the identical map for the same state.
        self._listing_pricing_state: GatewayCatalogState | None = None
        self._listing_pricing: dict[tuple[str, str], PricedAliasMetadata] = {}

    def resolve_direct(self, authorization: AuthorizationSnapshot) -> GatewayRoute:
        """Resolve one direct route synchronously for the native data plane.

        Args:
            authorization: Frozen authenticated direct-target authority.

        Returns:
            The route with the caller organization's BYOK variants substituted.
        """
        key = (authorization.alias_revision_id, authorization.catalog_sha256)
        state = self._state_provider.state_for_key(key)
        route = state.resolver.resolve_direct(authorization)
        organization = _organization_uuid(authorization.organization_id)
        final = self._substitute_org_variants(route, state, key, organization)
        # The native data plane resolves through here, so the org provider
        # policy must gate this path too — governance covers every lane.
        final = _apply_provider_policy(final, state, organization)
        _require_byok_connection(final, state.byok_required_by_key.get(key, frozenset()))
        return final

    async def resolve(
        self,
        *,
        authorization: AuthorizationSnapshot,
        request: GatewayRequest,
        episode_namespace: tuple[str, str, str, str],
    ) -> GatewayRoute:
        """Resolve one authorized target with org-aware lane selection.

        Args:
            authorization: Frozen authenticated alias revision and target.
            request: Canonical request (passed through to Experiential's resolver).
            episode_namespace: Tenant-isolated sticky selection identity.

        Returns:
            The route, with the caller's BYOK variants substituted in place and
            the execution snapshot rebound to the substituted deployment ids so
            the ledger's per-dispatch gate matches the route it will dispatch.
        """
        key = (authorization.alias_revision_id, authorization.catalog_sha256)
        state = self._state_provider.state_for_key_if_loaded(key)
        if state is None:
            state = await asyncio.to_thread(self._state_provider.state_for_key, key)
        route = await state.resolver.resolve(
            authorization=authorization,
            request=request,
            episode_namespace=episode_namespace,
        )
        organization = _organization_uuid(authorization.organization_id)
        final = self._substitute_org_variants(route, state, key, organization)
        # Governance filter AFTER variant substitution (a BYOK variant shares
        # its canonical's provider, so the policy sees the lane it will
        # actually dispatch) and BEFORE the BYOK fail-closed check.
        final = _apply_provider_policy(final, state, organization)
        _require_byok_connection(final, state.byok_required_by_key.get(key, frozenset()))
        return final

    def published_metadata(
        self,
        *,
        alias: str,
        revision_id: str,
        catalog_sha256: str,
    ) -> PublishedAliasMetadata | None:
        """Return catalog-backed listing fields for one granted public alias.

        exp renders these as additive extension fields beside OpenAI's model
        object on BOTH serving lanes: the Rust plane's ``/v1/models`` callback
        (``NativeControlPlane.models``) and the Python fallback route each call
        through this seam, so publishing here is the single place the listing
        gains pricing. The generation resolver is consulted first (the
        platform builds without ``listing_pools``, so it answers ``None``
        today); otherwise the GRANTED REVISION's primary routed deployment
        publishes its catalog rates — an org authority naming an org-scoped
        plan gets that plan's rates, never a same-named public plan's —
        pricing only, never invented capability or limit claims.
        """
        key = (revision_id, catalog_sha256)
        state = self._state_provider.state_for_key_if_loaded(key)
        if state is None:
            return None
        published = state.resolver.published_metadata(
            alias=alias, revision_id=revision_id, catalog_sha256=catalog_sha256
        )
        if published is not None:
            return published
        if state is not self._listing_pricing_state:
            self._listing_pricing = listing_pricing_by_alias(state)
            self._listing_pricing_state = state
        return self._listing_pricing.get((alias, revision_id))

    @staticmethod
    def _substitute_org_variants(
        route: GatewayRoute,
        state: GatewayCatalogState,
        key: tuple[str, str],
        organization: str,
    ) -> GatewayRoute:
        """Swap the caller org's BYOK variants into the route, if any apply."""
        variants = state.variants_by_key.get(key, {}).get(organization)
        if not variants:
            return route
        deployments = state.deployments_by_key.get(key, {})
        substituted: list[ExactModelDeployment] = []
        changed = False
        for deployment in route.deployments:
            variant_id = variants.get(deployment.deployment_id)
            variant = deployments.get(variant_id) if variant_id is not None else None
            if variant is None:
                substituted.append(deployment)
            else:
                substituted.append(variant)
                changed = True
        if not changed:
            return route
        # The execution snapshot pins exactly what the attempt may dispatch to,
        # and the ledger gates each dispatch against it (start_attempt refuses a
        # deployment absent from snapshot.deployment_ids). Substituting a
        # variant into the route without rebuilding the snapshot would leave the
        # snapshot naming the canonical ids while the route dispatches the
        # variant, so the meter never matches the gate. The variant shares the
        # canonical's exact model, pool, and authority, so only deployment_ids
        # changes; order tracks the substituted deployments.
        return GatewayRoute(
            snapshot=ExecutionSnapshot(
                authorization=route.snapshot.authorization,
                exact_model_id=route.snapshot.exact_model_id,
                pool_id=route.snapshot.pool_id,
                deployment_ids=tuple(item.deployment_id for item in substituted),
            ),
            deployment=substituted[0],
            fallback_deployments=tuple(substituted[1:]),
            route_reason=route.route_reason,
            fallback_reason=route.fallback_reason,
        )


# -- refresh loop -----------------------------------------------------------------


class _RefreshReleaser:
    """One-release-per-connection Vault releaser for a single catalog refresh.

    ``probe`` releases each BYOK connection once, isolated in its own
    savepoint so a failed release cannot poison the shared refresh
    transaction, and caches the value. ``resolve`` answers the state build
    from that cache, so a connection whose probe succeeded can never fail the
    refresh again at the state-build stage; a ref the probe never saw falls
    back to one isolated release. Instances live for exactly one refresh —
    the cached plaintext must not outlive the state swap it feeds.
    """

    def __init__(
        self,
        release: CredentialReleaser,
        isolate: Callable[[], AbstractContextManager[object]],
    ) -> None:
        self._release = release
        self._isolate = isolate
        self._released: dict[str, str] = {}

    def probe(self, connection_id: str) -> str:
        """Release one connection inside a savepoint and cache the value."""
        with self._isolate():
            value = self._release(connection_id)
        if value:
            self._released[connection_id] = value
        return value

    def resolve(self, connection_id: str) -> str:
        """Answer from the probe cache; release (isolated) only if unprobed."""
        cached = self._released.get(connection_id)
        if cached is not None:
            return cached
        with self._isolate():
            return self._release(connection_id)


class GatewayCatalogRefresher:
    """Poll for catalog input changes and atomically swap the served state.

    The swap is one attribute assignment of an immutable
    :class:`GatewayCatalogState`; readers either see the old generation or the
    new one, never a mix. A failed refresh keeps the last good state.
    """

    def __init__(
        self,
        connect: Callable[[], psycopg.Connection[tuple[object, ...]]],
        *,
        environment: Mapping[str, str] | None = None,
        release: CredentialReleaser | None = None,
        poll_interval_seconds: float = 15.0,
    ) -> None:
        """Bind the connection factory and credential sources.

        Args:
            connect: Factory for short-lived Postgres connections.
            environment: Worker environment; defaults to ``os.environ``.
            release: BYOK releaser; defaults to the sanctioned Vault RPC over
                the refresh connection.
            poll_interval_seconds: Watermark poll cadence.
        """
        self._connect = connect
        self._environment: Mapping[str, str] = os.environ if environment is None else environment
        self._release = release
        self._poll_interval_seconds = poll_interval_seconds
        self._refresh_lock = threading.Lock()
        self._catch_up_lock = threading.Lock()
        self._last_catch_up_at = float("-inf")
        self._state: GatewayCatalogState | None = None
        self._watermark: CatalogWatermark | None = None
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    @property
    def loaded(self) -> bool:
        """Whether a catalog state has been built at least once."""
        return self._state is not None

    @property
    def state(self) -> GatewayCatalogState:
        """The current immutable state.

        Raises:
            GatewayCatalogBuildError: No refresh has completed yet.
        """
        state = self._state
        if state is None:
            message = "gateway catalog has not been loaded yet"
            raise GatewayCatalogBuildError(message)
        return state

    def route_resolver(self) -> OrgAwareRouteResolver:
        """Return the live org-aware resolver bound to this refresher."""
        return OrgAwareRouteResolver(self)

    def state_for_key_if_loaded(self, key: tuple[str, str]) -> GatewayCatalogState | None:
        """Return the current state when it already contains the requested key."""
        state = self._state
        if state is None or key not in state.route_catalogs:
            return None
        return state

    def state_for_key(self, key: tuple[str, str]) -> GatewayCatalogState:
        """Return a state containing the requested authorized catalog key.

        A worker that is behind the cluster's published alias revision performs
        one throttled synchronous refresh before resolving the request. Unknown
        keys return the current state so route resolution remains fail-closed.
        """
        state = self._state
        if state is not None and key in state.route_catalogs:
            return state
        with self._catch_up_lock:
            state = self._state
            if state is not None and key in state.route_catalogs:
                return state
            now = time.monotonic()
            if now - self._last_catch_up_at < _CATALOG_CATCH_UP_MIN_INTERVAL_SECONDS:
                return self.state
            self._last_catch_up_at = now
            _LOGGER.info(
                "gateway catalog catch-up requested for revision_id=%s catalog_sha256=%s",
                key[0],
                key[1],
            )
            try:
                self.refresh_now()
            except Exception:
                # Keep the last known-good state, matching the background
                # refresh loop. Nothing in the refresh path carries a secret
                # into this exception chain.
                _LOGGER.exception(
                    "gateway catalog catch-up failed for revision_id=%s catalog_sha256=%s",
                    key[0],
                    key[1],
                )
            return self.state

    def refresh_now(self) -> bool:
        """Poll the watermark and rebuild/swap when anything changed.

        Returns:
            Whether a new state generation was swapped in.

        Raises:
            GatewayCatalogBuildError: The build failed; the previous state
                stays in place when one exists.
        """
        with self._refresh_lock:
            connection = self._connect()
            try:
                watermark = read_catalog_watermark(connection)
                connection.rollback()
                if self._state is not None and watermark == self._watermark:
                    return False
                rows = load_catalog_rows(connection)
                provider_controls, provider_policies = load_provider_policy_rows(connection)
                release = self._release or (
                    lambda connection_id: release_connection_credential(connection, connection_id)
                )

                # The build probes each BYOK connection's releasability so an
                # undecryptable Vault row degrades its own deployments with a
                # warning instead of failing the whole state materialization.
                # The releaser caches each probe's value, so the state build
                # below resolves from the cache instead of releasing a second
                # time — the redundant second RPC was an extra failure point
                # that could kill a worker at startup after its probe had
                # already succeeded, plus extra lock traffic on the release's
                # bookkeeping write.
                releaser = _RefreshReleaser(release, connection.transaction)
                build = build_gateway_catalog(
                    rows, environment=self._environment, release_probe=releaser.probe
                )
                result = store_gateway_catalog(connection, build)
                for alias_name, reason in result.skipped_aliases:
                    _LOGGER.warning(
                        "gateway catalog alias %s skipped: activation failed (%s); "
                        "the rest of the catalog is serving",
                        alias_name,
                        reason,
                    )
                state = build_catalog_state(
                    build,
                    environment=self._environment,
                    release=releaser.resolve,
                    previous=self._state,
                    provider_controls=provider_controls,
                    provider_policies=provider_policies,
                )
                connection.commit()
                # Re-read after storing so this generation's own alias
                # revisions do not read as a change on the next tick.
                self._watermark = read_catalog_watermark(connection)
                connection.rollback()
                self._state = state
                return True
            finally:
                connection.close()

    def start(self) -> None:
        """Start the background poll thread (idempotent)."""
        if self._thread is not None:
            return
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._run, name="gateway-catalog-refresher", daemon=True
        )
        self._thread.start()

    def stop(self, timeout_seconds: float = 5.0) -> None:
        """Stop the poll thread and wait for it to exit."""
        self._stop_event.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=timeout_seconds)
        self._thread = None

    def _run(self) -> None:
        """Poll until stopped, keeping the last good state on failures."""
        while not self._stop_event.is_set():
            try:
                self.refresh_now()
            except Exception:
                # Message only; nothing in the refresh path carries a secret
                # into the exception chain (credential errors name sources).
                _LOGGER.exception("gateway catalog refresh failed; keeping previous state")
            self._stop_event.wait(self._poll_interval_seconds)
