# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Catalog builder, org-aware resolution, refresh, and secret-safety tests."""

from __future__ import annotations

import asyncio
import json
import os
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import psycopg
import pytest
from exp.common.core.artifacts import canonical_json_bytes, sha256_json
from exp.common.models import BillingSource
from exp.runtime.gateway.contracts import (
    AuthorizationSnapshot,
    GatewayApiSurface,
    GatewayFailureClass,
    GatewayMessage,
    GatewayRequest,
)
from exp.runtime.gateway.execution import GatewayExecutionError
from exp.runtime.gateway.routing import GatewayRoute, GatewayRoutingError

from explabs.gateway.catalog import (
    HOUSE_ORG_SLUG,
    AliasActivationPlan,
    CatalogConnectionRow,
    CatalogModelRow,
    CatalogProviderRow,
    CatalogWaterfallRow,
    GatewayCatalogBuild,
    GatewayCatalogRefresher,
    GatewayCatalogState,
    OrgAwareRouteResolver,
    OrgProviderPolicy,
    PlatformCatalogRows,
    PricedAliasMetadata,
    ProviderDataControls,
    _RefreshReleaser,
    build_catalog_state,
    build_gateway_catalog,
    listing_pricing_by_alias,
)
from explabs.gateway.credentials import (
    LOCAL_PLACEHOLDER_CREDENTIAL,
    CredentialSourceKind,
    GatewayCredentialError,
    byok_credential_environment_name,
)

_NOW = datetime(2026, 8, 1, 12, 0, 0, tzinfo=UTC)
_ORG_A = "aa000000-0000-4000-8000-000000000001"
_ORG_B = "bb000000-0000-4000-8000-000000000002"
_PUBLIC_MODEL_ID = "11000000-0000-4000-8000-000000000001"
_ORG_MODEL_ID = "22000000-0000-4000-8000-000000000002"
_OPENAI_ROW_ID = "31000000-0000-4000-8000-000000000001"
_ANTHROPIC_ROW_ID = "32000000-0000-4000-8000-000000000002"
_ORG_OPENAI_ROW_ID = "33000000-0000-4000-8000-000000000003"
_CONN_A = "41000000-0000-4000-8000-000000000001"
_CONN_B = "42000000-0000-4000-8000-000000000002"

_PUBLIC_OPENAI_ALIAS = f"mp-{_OPENAI_ROW_ID}"
_PUBLIC_ANTHROPIC_ALIAS = f"mp-{_ANTHROPIC_ROW_ID}"
_ORG_OPENAI_ALIAS = f"mp-{_ORG_OPENAI_ROW_ID}"


def _environment() -> dict[str, str]:
    """Platform credential canaries used to prove documents stay secret-free."""
    return {
        "OPENAI_API_KEY": "platform-openai-canary-0001",
        "ANTHROPIC_API_KEY": "platform-anthropic-canary-0002",
        "GEMINI_API_KEY": "platform-gemini-canary-0003",
    }


def _release(connection_id: str) -> str:
    """Deterministic BYOK canary releaser for unit tests."""
    return f"byok-canary-{connection_id}"


def _model_row(**overrides: object) -> CatalogModelRow:
    values: dict[str, object] = {
        "id": _PUBLIC_MODEL_ID,
        "slug": "gw-public-model",
        "owning_org_id": None,
        "status": "active",
        "context_window": 200_000,
        "max_output_tokens": 8_192,
        "supported_params": {"tools": True, "temperature": True},
        "updated_at": _NOW,
    }
    values.update(overrides)
    return CatalogModelRow.model_validate(values)


def _provider_row(**overrides: object) -> CatalogProviderRow:
    values: dict[str, object] = {
        "id": _OPENAI_ROW_ID,
        "model_id": _PUBLIC_MODEL_ID,
        "provider": "openai",
        "provider_model_id": "gpt-5",
        "billing_source": "host_managed",
        "input_micro_usd_per_million": 2_500_000,
        "output_micro_usd_per_million": 10_000_000,
        "pricing_source": "launch-catalog",
        "capabilities": {"supports_streaming": True, "reports_cached_input_tokens": True},
        "status": "active",
        "created_at": _NOW,
        "updated_at": _NOW,
    }
    values.update(overrides)
    return CatalogProviderRow.model_validate(values)


def _connection_row(**overrides: object) -> CatalogConnectionRow:
    values: dict[str, object] = {
        "id": _CONN_A,
        "org_id": _ORG_A,
        "provider": "openai",
        "config": {},
        "serving_revision": 101,
        "updated_at": _NOW,
    }
    values.update(overrides)
    return CatalogConnectionRow.model_validate(values)


def _chain_digest(chain: tuple[CatalogWaterfallRow, ...]) -> str:
    """Recompute the builder's waterfall content digest for assertions."""
    return sha256_json(
        [
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
    )


def _make_chain(
    model_id: str,
    provider_row_ids: tuple[str, ...],
    *,
    digit_leading: bool,
    updated_at: datetime = _NOW,
    org_id: str | None = None,
) -> tuple[CatalogWaterfallRow, ...]:
    """Find chain rows whose synthesized digest starts with a digit or letter."""
    for salt in range(4096):
        chain = tuple(
            CatalogWaterfallRow(
                id=f"cc{salt:06x}-0000-4000-8000-{index:012x}",
                model_id=model_id,
                org_id=org_id,
                position=index,
                model_provider_id=provider_row_id,
                updated_at=updated_at,
            )
            for index, provider_row_id in enumerate(provider_row_ids)
        )
        if _chain_digest(chain)[0].isdigit() == digit_leading:
            return chain
    message = "no chain candidate produced the requested digest shape"
    raise AssertionError(message)


def _fixture_rows() -> PlatformCatalogRows:
    """The Done-when fixture: waterfall, org-custom model, lanes, unknown price."""
    public_model = _model_row()
    org_model = _model_row(
        id=_ORG_MODEL_ID,
        slug="gw-org-model",
        owning_org_id=_ORG_A,
        supported_params={"tools": False, "temperature": False},
    )
    openai_row = _provider_row()
    anthropic_row = _provider_row(
        id=_ANTHROPIC_ROW_ID,
        provider="anthropic",
        provider_model_id="claude-opus-5",
        input_micro_usd_per_million=None,
        output_micro_usd_per_million=None,
        pricing_source=None,
        created_at=_NOW + timedelta(minutes=1),
    )
    org_openai_row = _provider_row(
        id=_ORG_OPENAI_ROW_ID,
        model_id=_ORG_MODEL_ID,
        provider_model_id="ft:gpt-5:org-a",
        billing_source="customer_managed",
        # core-P1's tenancy trigger: a private model admits only deployments
        # owned by the same org.
        owning_org_id=_ORG_A,
        created_at=_NOW + timedelta(minutes=2),
    )
    chain = _make_chain(_PUBLIC_MODEL_ID, (_OPENAI_ROW_ID, _ANTHROPIC_ROW_ID), digit_leading=False)
    return PlatformCatalogRows(
        models=(public_model, org_model),
        providers=(openai_row, anthropic_row, org_openai_row),
        waterfalls=chain,
        connections=(
            _connection_row(),
            _connection_row(id=_CONN_B, org_id=_ORG_B, serving_revision=202),
        ),
    )


def _plan_by_name(build: GatewayCatalogBuild, alias_name: str) -> AliasActivationPlan:
    plans = [plan for plan in build.alias_plans if plan.alias_name == alias_name]
    assert len(plans) == 1, f"expected one plan for {alias_name}"
    return plans[0]


def test_build_covers_lanes_pools_and_unknown_prices() -> None:
    """Waterfall pool, org-custom model, lane split, and null prices all hold."""
    rows = _fixture_rows()
    build = build_gateway_catalog(rows, environment=_environment())
    assert build.authored is not None
    assert build.normalized is not None
    deployments = {item.deployment_id: item for item in build.normalized.deployments}

    public_openai = deployments[_PUBLIC_OPENAI_ALIAS]
    assert public_openai.billing_source is BillingSource.HOST_MANAGED
    assert public_openai.provider == "openai"
    assert public_openai.gateway.prices.input_micro_usd_per_million_tokens == 2_500_000
    anthropic = deployments[_PUBLIC_ANTHROPIC_ALIAS]
    assert anthropic.gateway.prices.input_micro_usd_per_million_tokens is None
    assert anthropic.gateway.prices.output_micro_usd_per_million_tokens is None

    org_deployment = deployments[_ORG_OPENAI_ALIAS]
    assert org_deployment.billing_source is BillingSource.CUSTOMER_MANAGED
    assert org_deployment.provider_model == "ft:gpt-5:org-a"

    pool_id = f"wf-{_PUBLIC_MODEL_ID}"
    pools = {pool.pool_id: pool for pool in build.normalized.pools}
    pool = pools[pool_id]
    assert pool.deployment_ids == (_PUBLIC_OPENAI_ALIAS, _PUBLIC_ANTHROPIC_ALIAS)
    assert pool.equivalence is not None
    expected_digest = _chain_digest(rows.waterfalls)
    assert pool.equivalence.certification_id == f"wfcert-{expected_digest}"
    assert pool.equivalence.evidence_sha256 == expected_digest
    assert pool.equivalence.provenance == "platform:model_waterfalls"
    assert pool.equivalence.certified_at == _NOW

    public_plan = _plan_by_name(build, "gw-public-model")
    assert public_plan.org_id is None
    assert public_plan.target.pool_id == pool_id
    assert public_plan.provider_connection_revisions == {_CONN_A: 101, _CONN_B: 202}
    assert public_plan.certification_document() == {
        **pool.equivalence.model_dump(mode="json"),
        "order": [_PUBLIC_OPENAI_ALIAS, _PUBLIC_ANTHROPIC_ALIAS],
    }

    org_plan = _plan_by_name(build, "gw-org-model")
    assert org_plan.org_id == _ORG_A
    assert org_plan.target.pool_id == _ORG_OPENAI_ALIAS
    assert org_plan.certification is None
    assert org_plan.provider_connection_revisions == {_CONN_A: 101}

    variants = build.byok_deployment_variants
    assert variants[_ORG_B][_PUBLIC_OPENAI_ALIAS] == f"{_PUBLIC_OPENAI_ALIAS}-c-{_CONN_B}"
    assert variants[_ORG_A][_PUBLIC_OPENAI_ALIAS] == f"{_PUBLIC_OPENAI_ALIAS}-c-{_CONN_A}"
    variant = deployments[f"{_PUBLIC_OPENAI_ALIAS}-c-{_CONN_B}"]
    assert variant.billing_source is BillingSource.CUSTOMER_MANAGED
    assert variant.exact_model_id == public_openai.exact_model_id


def test_snapshot_digest_is_stable_across_rebuilds() -> None:
    """Two builds from independently constructed equal rows are identical."""
    first = build_gateway_catalog(_fixture_rows(), environment=_environment())
    second = build_gateway_catalog(_fixture_rows(), environment=_environment())
    assert first.catalog_sha256 == second.catalog_sha256
    assert first.normalized is not None
    assert second.normalized is not None
    assert canonical_json_bytes(first.normalized) == canonical_json_bytes(second.normalized)
    assert [plan.revision_id for plan in first.alias_plans] == [
        plan.revision_id for plan in second.alias_plans
    ]


def test_digit_leading_certification_digest_builds_via_wfcert_prefix() -> None:
    """Every digest shape passes the pinned ArtifactId validator.

    ``GatewayEquivalenceCertification.certification_id`` is an ``ArtifactId``
    (``^[a-z]...``, max 128 chars) at the pinned Experiential revision, which rejects
    a RAW hex digest that starts with a digit. The constant ``wfcert-``
    prefix keeps the id letter-first, content-addressed, and within length
    for the worst case (this test pins a digit-leading digest on purpose).
    """
    rows = _fixture_rows()
    digit_chain = _make_chain(
        _PUBLIC_MODEL_ID, (_OPENAI_ROW_ID, _ANTHROPIC_ROW_ID), digit_leading=True
    )
    build = build_gateway_catalog(
        PlatformCatalogRows(
            models=rows.models,
            providers=rows.providers,
            waterfalls=digit_chain,
            connections=rows.connections,
        ),
        environment=_environment(),
    )
    assert build.normalized is not None
    pool = {pool.pool_id: pool for pool in build.normalized.pools}[f"wf-{_PUBLIC_MODEL_ID}"]
    digest = _chain_digest(digit_chain)
    assert digest[0].isdigit()
    assert pool.equivalence is not None
    assert pool.equivalence.certification_id == f"wfcert-{digest}"
    assert pool.equivalence.evidence_sha256 == digest


def _authorization(
    plan: AliasActivationPlan,
    organization_id: str,
    *,
    revision_id: str | None = None,
    catalog_sha256: str | None = None,
) -> AuthorizationSnapshot:
    """Build an authorization snapshot for one alias plan or test key."""
    return AuthorizationSnapshot(
        request_id="req-1",
        organization_id=organization_id,
        identity_id=organization_id,
        virtual_key_id="key-1",
        alias=plan.alias_name,
        alias_revision_id=plan.revision_id if revision_id is None else revision_id,
        target=plan.target,
        surface=GatewayApiSurface.CHAT_COMPLETIONS,
        catalog_sha256=plan.catalog_sha256 if catalog_sha256 is None else catalog_sha256,
        canonical_request_sha256="a" * 64,
        deadline_monotonic=100.0,
    )


def _request() -> GatewayRequest:
    return GatewayRequest(
        surface=GatewayApiSurface.CHAT_COMPLETIONS,
        messages=(GatewayMessage(role="user", content="hello"),),
    )


class _StaticStateProvider:
    """Provide one pre-built catalog state through the resolver seam."""

    def __init__(self, state: GatewayCatalogState) -> None:
        self._state = state

    def state_for_key_if_loaded(self, key: tuple[str, str]) -> GatewayCatalogState | None:
        """Return the state when it contains the requested key."""
        if key not in self._state.route_catalogs:
            return None
        return self._state

    def state_for_key(self, key: tuple[str, str]) -> GatewayCatalogState:
        """Return the static state, including for unknown keys."""
        del key
        return self._state


def _assert_ledger_dispatch_gate_holds(route: object) -> None:
    """Assert every route deployment satisfies the ledger's start_attempt gate.

    Mirrors ``PostgresAttemptLedger.start_attempt`` (explabs/gateway/ledger.py):
    each dispatched deployment must be named by ``snapshot.deployment_ids`` and
    must not change the snapshot's exact model. Both fallbacks and the head are
    checked because the waterfall can dispatch any of them.
    """
    from exp.runtime.gateway.routing import GatewayRoute

    assert isinstance(route, GatewayRoute)
    for deployment in route.deployments:
        assert deployment.deployment_id in route.snapshot.deployment_ids
        assert deployment.exact_model_id == route.snapshot.exact_model_id


def test_org_byok_route_substitution_never_mutates_shared_state() -> None:
    """Org B rides its own key; orgs without connections keep the host lane."""
    build = build_gateway_catalog(_fixture_rows(), environment=_environment())
    state = build_catalog_state(build, environment=_environment(), release=_release)
    resolver = OrgAwareRouteResolver(_StaticStateProvider(state))
    plan = _plan_by_name(build, "gw-public-model")

    org_b_route = asyncio.run(
        resolver.resolve(
            authorization=_authorization(plan, f"org-{_ORG_B}"),
            request=_request(),
            episode_namespace=(f"org-{_ORG_B}", "identity", plan.revision_id, "episode"),
        )
    )
    native_org_b_route = resolver.resolve_direct(_authorization(plan, f"org-{_ORG_B}"))
    assert native_org_b_route == org_b_route
    assert org_b_route.deployment.deployment_id == f"{_PUBLIC_OPENAI_ALIAS}-c-{_CONN_B}"
    assert org_b_route.deployment.billing_source is BillingSource.CUSTOMER_MANAGED
    # Anthropic rung has no org B connection, so it stays platform-funded.
    assert org_b_route.fallback_deployments[0].deployment_id == _PUBLIC_ANTHROPIC_ALIAS
    # The execution snapshot must name exactly the substituted deployments, in
    # route order: the ledger gates each dispatch against snapshot.deployment_ids
    # (start_attempt), so a snapshot still naming the canonical id would fail the
    # BYOK variant pre-dispatch. This is the P0 the resolver's snapshot rebuild
    # fixes.
    assert org_b_route.snapshot.deployment_ids == (
        f"{_PUBLIC_OPENAI_ALIAS}-c-{_CONN_B}",
        _PUBLIC_ANTHROPIC_ALIAS,
    )
    _assert_ledger_dispatch_gate_holds(org_b_route)

    other_org = "dd000000-0000-4000-8000-000000000009"
    other_route = asyncio.run(
        resolver.resolve(
            authorization=_authorization(plan, f"org-{other_org}"),
            request=_request(),
            episode_namespace=(f"org-{other_org}", "identity", plan.revision_id, "episode"),
        )
    )
    assert other_route.deployment.deployment_id == _PUBLIC_OPENAI_ALIAS
    assert other_route.deployment.billing_source is BillingSource.HOST_MANAGED
    # The non-BYOK path is untouched: canonical route, canonical snapshot.
    assert other_route.snapshot.deployment_ids == (
        _PUBLIC_OPENAI_ALIAS,
        _PUBLIC_ANTHROPIC_ALIAS,
    )
    _assert_ledger_dispatch_gate_holds(other_route)

    # The shared frozen pool still names the canonical deployments only.
    assert state.build.normalized is not None
    pool = {pool.pool_id: pool for pool in state.build.normalized.pools}[plan.target.pool_id]
    assert pool.deployment_ids == (_PUBLIC_OPENAI_ALIAS, _PUBLIC_ANTHROPIC_ALIAS)


def test_no_credential_value_reaches_documents_plans_or_warnings() -> None:
    """Canary credential values appear only in the in-memory mapping."""
    build = build_gateway_catalog(_fixture_rows(), environment=_environment())
    state = build_catalog_state(build, environment=_environment(), release=_release)
    canaries = [*_environment().values(), _release(_CONN_A), _release(_CONN_B)]
    assert build.authored is not None
    assert build.normalized is not None
    surfaces = [
        canonical_json_bytes(build.authored).decode(),
        canonical_json_bytes(build.normalized).decode(),
        json.dumps([plan.model_dump(mode="json") for plan in build.alias_plans]),
        json.dumps([plan.target_document() for plan in build.alias_plans]),
        json.dumps(list(build.warnings)),
    ]
    for canary in canaries:
        for surface in surfaces:
            assert canary not in surface
    # Only referenced credentials materialize: the fixture has no gemini
    # deployment, so the gemini platform key never leaves the environment.
    expected_in_memory = {
        _environment()["OPENAI_API_KEY"],
        _environment()["ANTHROPIC_API_KEY"],
        _release(_CONN_A),
        _release(_CONN_B),
    }
    assert expected_in_memory <= set(state.credentials.values())
    assert _environment()["GEMINI_API_KEY"] not in state.credentials.values()
    # The documents reference synthesized environment NAMES for BYOK keys.
    assert byok_credential_environment_name(_CONN_B) in surfaces[0]


def test_pinned_connection_must_be_owned_by_the_deployment_org() -> None:
    """A public deployment pinned to some org's key never enters the catalog."""
    rows = _fixture_rows()
    pinned_public = _provider_row(provider_connection_id=_CONN_B)
    broken = PlatformCatalogRows(
        models=rows.models,
        providers=(pinned_public, *rows.providers[1:]),
        waterfalls=(),
        connections=rows.connections,
    )
    build = build_gateway_catalog(broken, environment=_environment())
    assert build.normalized is not None
    deployment_ids = {item.deployment_id for item in build.normalized.deployments}
    assert _PUBLIC_OPENAI_ALIAS not in deployment_ids
    assert any("does not own" in warning for warning in build.warnings)


def test_disabled_rows_and_unfunded_hosts_are_excluded_with_warnings() -> None:
    """Disabled rows and host_managed rows without platform credentials drop out."""
    rows = _fixture_rows()
    disabled = _provider_row(status="disabled")
    unfunded = _provider_row(
        id="34000000-0000-4000-8000-000000000004",
        provider="openrouter",
        provider_model_id="openai/gpt-5",
        created_at=_NOW + timedelta(minutes=3),
    )
    build = build_gateway_catalog(
        PlatformCatalogRows(
            models=(rows.models[0],),
            providers=(disabled, unfunded),
            waterfalls=(),
            connections=(),
        ),
        environment=_environment(),
    )
    assert build.is_empty
    assert any(
        "neither a house-org connection nor a configured platform credential" in warning
        for warning in build.warnings
    )
    assert any("no routable deployment" in warning for warning in build.warnings)


def test_unreleasable_byok_connection_is_skipped_with_a_warning() -> None:
    """A connection whose Vault release fails degrades only its own deployments.

    One undecryptable secret previously failed the whole state materialization
    and crashlooped every worker; with the build-time probe the offending
    connection's rows drop out with a warning while the rest of the catalog
    keeps serving.
    """
    probe_canary = "probe-canary-value"

    def failing_probe(connection_id: str) -> str:
        if connection_id == _CONN_A:
            message = f"provider connection credential is not decryptable: {connection_id}"
            raise GatewayCredentialError(message)
        return probe_canary

    build = build_gateway_catalog(
        _fixture_rows(), environment=_environment(), release_probe=failing_probe
    )
    assert any(
        f"provider connection {_CONN_A}: credential release failed" in warning
        for warning in build.warnings
    )
    # Org A's private model rode only its own (now unreleasable) connection.
    assert not any(plan.alias_name == "gw-org-model" for plan in build.alias_plans)
    # The public model and org B's variant lane are untouched.
    public_plan = _plan_by_name(build, "gw-public-model")
    assert public_plan.catalog_sha256 == build.catalog_sha256
    assert _ORG_A not in build.byok_deployment_variants
    assert _ORG_B in build.byok_deployment_variants
    # No credential reference survives for the skipped connection, and the
    # probed value itself never enters any build surface.
    assert all(ref.selector != _CONN_A for ref in build.credential_refs)
    assert build.authored is not None
    assert build.normalized is not None
    for surface in (
        canonical_json_bytes(build.authored).decode(),
        canonical_json_bytes(build.normalized).decode(),
        json.dumps(list(build.warnings)),
    ):
        assert probe_canary not in surface


def test_probe_failures_are_cached_per_connection_within_one_build() -> None:
    """A shared connection is probed once per build, not once per row."""
    calls: list[str] = []

    def counting_probe(connection_id: str) -> str:
        calls.append(connection_id)
        return _release(connection_id)

    build_gateway_catalog(_fixture_rows(), environment=_environment(), release_probe=counting_probe)
    assert sorted(calls) == sorted(set(calls))


def test_unreleasable_house_connection_on_the_compatible_host_lane_degrades() -> None:
    """A fireworks house row whose Vault release fails falls back to the env.

    The compatible-host lane builds its BYOK_VAULT credential ref inline
    (it does not go through _register_byok_connection), so it must run the
    same releasability probe: an undecryptable house secret would otherwise
    abort the whole state materialization at credential release.
    """
    house_org = "ee000000-0000-4000-8000-00000000000e"
    house_conn = "4e000000-0000-4000-8000-00000000000e"
    fireworks_model = _model_row(slug="gw-fireworks-model")
    fireworks_row = _provider_row(
        id="37000000-0000-4000-8000-000000000007",
        provider="fireworks",
        provider_model_id="accounts/fireworks/models/glm-5",
    )

    def failing_probe(connection_id: str) -> str:
        message = f"provider connection credential is not decryptable: {connection_id}"
        raise GatewayCredentialError(message)

    build = build_gateway_catalog(
        PlatformCatalogRows(
            models=(fireworks_model,),
            providers=(fireworks_row,),
            waterfalls=(),
            connections=(_connection_row(id=house_conn, org_id=house_org, provider="fireworks"),),
            house_org_id=house_org,
        ),
        environment={"FIREWORKS_API_KEY": "platform-fireworks-canary"},
        release_probe=failing_probe,
    )
    assert any(
        f"provider connection {house_conn}: credential release failed" in warning
        for warning in build.warnings
    )
    # The row still routes, through the platform env fallback instead of the
    # dead house connection; no Vault ref for it survives into the build.
    assert build.authored is not None
    record = build.authored.models[f"mp-{fireworks_row.id}"]
    connection = build.authored.connections[record.connection]
    assert connection.api_key_env == "FIREWORKS_API_KEY"
    refs = {ref.environment_name: ref for ref in build.credential_refs}
    assert refs["FIREWORKS_API_KEY"].kind is CredentialSourceKind.PLATFORM_ENV
    assert all(ref.selector != house_conn for ref in build.credential_refs)


def test_bedrock_rides_the_ambient_chain_and_never_byok() -> None:
    """Host bedrock builds an ambient-chain connection; BYOK bedrock is skipped."""
    model = _model_row(slug="gw-bedrock-model")
    host_row = _provider_row(
        id="35000000-0000-4000-8000-000000000005",
        provider="bedrock",
        provider_model_id="anthropic.claude-opus-5-v1:0",
        region="us-east-1",
    )
    org_model = _model_row(id=_ORG_MODEL_ID, slug="gw-bedrock-org-model", owning_org_id=_ORG_A)
    pinned_row = _provider_row(
        id="36000000-0000-4000-8000-000000000006",
        model_id=_ORG_MODEL_ID,
        provider="bedrock",
        provider_model_id="anthropic.claude-opus-5-v1:0",
        provider_connection_id=_CONN_A,
        created_at=_NOW + timedelta(minutes=1),
    )
    bedrock_connection = _connection_row(provider="bedrock")
    build = build_gateway_catalog(
        PlatformCatalogRows(
            models=(model, org_model),
            providers=(host_row, pinned_row),
            waterfalls=(),
            connections=(bedrock_connection,),
        ),
        environment=_environment(),
    )
    assert build.authored is not None
    connection = build.authored.connections["platform-bedrock-us-east-1"]
    assert connection.provider == "bedrock"
    assert connection.api_key_env is None
    assert connection.region == "us-east-1"
    assert any("not routable by the shared gateway catalog" in w for w in build.warnings)
    assert build.normalized is not None
    deployment_ids = {item.deployment_id for item in build.normalized.deployments}
    assert "mp-36000000-0000-4000-8000-000000000006" not in deployment_ids


def test_host_lane_prefers_house_org_connection_over_env() -> None:
    """Platform-funded credentials resolve from the house org's Vault connection."""
    house_org = "ee000000-0000-4000-8000-00000000000e"
    house_conn = "4e000000-0000-4000-8000-00000000000e"
    rows = _fixture_rows()
    with_house = PlatformCatalogRows(
        models=rows.models,
        providers=rows.providers,
        waterfalls=rows.waterfalls,
        connections=(
            *rows.connections,
            _connection_row(id=house_conn, org_id=house_org, serving_revision=999),
        ),
        house_org_id=house_org,
    )
    # No OPENAI_API_KEY: the openai rung must still build, via the house org.
    build = build_gateway_catalog(
        with_house, environment={"ANTHROPIC_API_KEY": "platform-anthropic-canary"}
    )
    assert build.authored is not None
    openai_record = build.authored.models[_PUBLIC_OPENAI_ALIAS]
    assert openai_record.connection == f"conn-{house_conn}"
    assert openai_record.billing_source is BillingSource.HOST_MANAGED
    connection = build.authored.connections[f"conn-{house_conn}"]
    assert connection.api_key_env == byok_credential_environment_name(house_conn)
    refs = {ref.environment_name: ref for ref in build.credential_refs}
    house_ref = refs[byok_credential_environment_name(house_conn)]
    assert house_ref.kind is CredentialSourceKind.BYOK_VAULT
    assert house_ref.selector == house_conn
    # House-key rotation must rotate alias revisions: the revision map
    # freezes the house connection alongside the BYOK ones.
    public_plan = _plan_by_name(build, "gw-public-model")
    assert public_plan.provider_connection_revisions[house_conn] == 999
    # The house org never appears as a BYOK "variant" of its own lane.
    assert house_org not in build.byok_deployment_variants


def test_fireworks_and_modal_map_to_openai_compatible_family() -> None:
    """Fireworks (default origin) and modal (row endpoint) both route.

    core-P1 requires ``base_url`` on modal rows (each modal endpoint is its
    own origin, endpoint-grammar-checked) and forbids it on fireworks rows.
    """
    fireworks_model = _model_row(slug="gw-fireworks-model")
    modal_model = _model_row(id=_ORG_MODEL_ID, slug="gw-modal-model")
    fireworks_row = _provider_row(
        id="37000000-0000-4000-8000-000000000007",
        provider="fireworks",
        provider_model_id="accounts/fireworks/models/glm-5",
    )
    modal_row = _provider_row(
        id="38000000-0000-4000-8000-000000000008",
        model_id=_ORG_MODEL_ID,
        provider="modal",
        provider_model_id="glm-5",
        base_url="https://acme--llm-serve.modal.run/v1",
        created_at=_NOW + timedelta(minutes=1),
    )
    build = build_gateway_catalog(
        PlatformCatalogRows(
            models=(fireworks_model, modal_model),
            providers=(fireworks_row, modal_row),
            waterfalls=(),
            connections=(),
        ),
        environment={
            "FIREWORKS_API_KEY": "platform-fireworks-canary",
            "MODAL_API_KEY": "platform-modal-canary",
        },
    )
    assert build.authored is not None
    fireworks_alias = f"mp-{fireworks_row.id}"
    record = build.authored.models[fireworks_alias]
    assert record.billing_source is BillingSource.HOST_MANAGED
    connection = build.authored.connections[record.connection]
    assert connection.provider == "openai-compatible"
    assert connection.base_url == "https://api.fireworks.ai/inference/v1"
    assert connection.api_key_env == "FIREWORKS_API_KEY"
    modal_alias = f"mp-{modal_row.id}"
    modal_record = build.authored.models[modal_alias]
    assert modal_record.billing_source is BillingSource.HOST_MANAGED
    modal_connection = build.authored.connections[modal_record.connection]
    assert modal_connection.provider == "openai-compatible"
    assert modal_connection.base_url == "https://acme--llm-serve.modal.run/v1"
    assert modal_connection.api_key_env == "MODAL_API_KEY"
    assert build.normalized is not None
    deployments = {item.deployment_id: item for item in build.normalized.deployments}
    assert deployments[fireworks_alias].provider == "openai-compatible"
    assert deployments[modal_alias].provider == "openai-compatible"


def test_org_owned_local_model_routes_end_to_end() -> None:
    """The launch-correct "add a local model" shape serves end to end.

    Shape: an ORG-OWNED models row plus a same-org provider=local row (the
    form core-P1's tenancy triggers admit). The builder emits an org-scoped
    alias over an openai-compatible deployment on the row's own endpoint with
    the keyless placeholder credential, and the org-aware resolver returns a
    route whose execution snapshot passes the ledger's dispatch gate. The
    contrast case — the same local row attached to a PUBLIC model — must stay
    behind the tenant guard. NOTE: the org model's slug must not collide with
    any existing gateway alias name (gateway_aliases.alias_name is globally
    unique, while core-P1 namespaces slugs per org — known int-P1 seam);
    uniqueness is enforced at activation, not here.
    """
    local_model_id = "44000000-0000-4000-8000-000000000004"
    local_row_id = "39000000-0000-4000-8000-000000000009"
    org_local_model = _model_row(id=local_model_id, slug="gw-org-local-model", owning_org_id=_ORG_A)
    local_row = _provider_row(
        id=local_row_id,
        model_id=local_model_id,
        provider="local",
        provider_model_id="glm-5-local",
        base_url="http://10.0.0.7:8000/v1",
        owning_org_id=_ORG_A,
        billing_source="customer_managed",
    )
    build = build_gateway_catalog(
        PlatformCatalogRows(
            models=(org_local_model,),
            providers=(local_row,),
            waterfalls=(),
            connections=(),
        ),
        environment={},
    )
    assert build.authored is not None
    alias = f"mp-{local_row_id}"
    record = build.authored.models[alias]
    assert record.billing_source is BillingSource.CUSTOMER_MANAGED
    connection = build.authored.connections[record.connection]
    assert connection.provider == "openai-compatible"
    assert connection.base_url == "http://10.0.0.7:8000/v1"
    placeholder_env = byok_credential_environment_name(f"local:{local_row_id}")
    assert connection.api_key_env == placeholder_env

    plan = _plan_by_name(build, "gw-org-local-model")
    assert plan.org_id == _ORG_A
    assert plan.target.pool_id == alias
    assert plan.target_deployment_ids == (alias,)
    assert plan.provider_connection_revisions == {}

    # The keyless placeholder resolves without any env or Vault source.
    state = build_catalog_state(build, environment={}, release=_release)
    assert state.credentials[placeholder_env] == LOCAL_PLACEHOLDER_CREDENTIAL

    # Route resolution end to end for the owning org: the snapshot names the
    # local deployment, so the ledger's dispatch gate holds.
    resolver = OrgAwareRouteResolver(_StaticStateProvider(state))
    route = asyncio.run(
        resolver.resolve(
            authorization=_authorization(plan, f"org-{_ORG_A}"),
            request=_request(),
            episode_namespace=(f"org-{_ORG_A}", "identity", plan.revision_id, "episode"),
        )
    )
    assert route.deployment.deployment_id == alias
    assert route.deployment.provider == "openai-compatible"
    assert route.snapshot.deployment_ids == (alias,)
    _assert_ledger_dispatch_gate_holds(route)

    # Tenant-guard boundary: the identical local row on a PUBLIC model never
    # enters the shared alias.
    public_variant = build_gateway_catalog(
        PlatformCatalogRows(
            models=(_model_row(id=local_model_id, slug="gw-org-local-model"),),
            providers=(local_row,),
            waterfalls=(),
            connections=(),
        ),
        environment={},
    )
    assert public_variant.is_empty
    assert any(
        "org-private deployment on a public model" in warning for warning in public_variant.warnings
    )


def test_org_private_deployment_on_public_model_is_skipped() -> None:
    """A shared alias never resolves through one org's private route."""
    rows = _fixture_rows()
    org_scoped_public = _provider_row(owning_org_id=_ORG_A)
    build = build_gateway_catalog(
        PlatformCatalogRows(
            models=(rows.models[0],),
            providers=(org_scoped_public,),
            waterfalls=(),
            connections=rows.connections,
        ),
        environment=_environment(),
    )
    assert build.is_empty
    assert any("org-private deployment on a public model" in w for w in build.warnings)


def test_supported_params_project_temperature_onto_wmo_capabilities() -> None:
    """A row that marks temperature unsupported drives Experiential to omit it on dispatch.

    ``supported_params`` is the catalog's "how to call it" record. An explicit
    ``temperature: false`` (a reasoning model that rejects the parameter) must
    project to ``supports_temperature=False`` so the gateway omits temperature
    before dispatch rather than sending it and collecting a provider rejection.
    An omitted key stays permissive so an undeclared model remains callable.
    """
    from explabs.gateway.catalog import _model_capabilities

    rejects = _model_capabilities(
        _model_row(supported_params={"tools": True, "temperature": False})
    )
    assert rejects.supports_temperature is False

    permissive = _model_capabilities(_model_row(supported_params={"tools": True}))
    assert permissive.supports_temperature is True


def test_empty_rows_build_is_empty() -> None:
    """No rows means nothing to register and nothing to serve."""
    build = build_gateway_catalog(
        PlatformCatalogRows(models=(), providers=(), waterfalls=(), connections=()),
        environment=_environment(),
    )
    assert build.is_empty
    assert build.alias_plans == ()
    assert build.credential_refs == ()


# -- integration ------------------------------------------------------------------


def _database_url() -> str:
    """Return the disposable integration database URL or skip."""
    value = os.environ.get("SUPABASE_DB_URL", "").strip()
    if not value:
        pytest.skip("SUPABASE_DB_URL is required for integration tests")
    return value


@dataclass(frozen=True)
class _IntegrationFixture:
    """Run-unique identities for one integration pass."""

    suffix: str
    org_a: str
    org_b: str
    public_model: str
    org_model: str
    canary: str
    house_canary: str

    @property
    def public_slug(self) -> str:
        return f"gw-int-pub-{self.suffix}"

    @property
    def org_slug(self) -> str:
        return f"gw-int-org-{self.suffix}"

    def environment(self) -> dict[str, str]:
        return {
            "OPENAI_API_KEY": f"platform-openai-canary-{self.suffix}",
            "ANTHROPIC_API_KEY": f"platform-anthropic-canary-{self.suffix}",
            "GEMINI_API_KEY": f"platform-gemini-canary-{self.suffix}",
        }


def _seed_integration_fixture(
    setup: psycopg.Connection[tuple[object, ...]], fixture: _IntegrationFixture
) -> bool:
    """Seed orgs, models, providers, a waterfall, and Vault-backed connections.

    Returns:
        Whether this run created the house org (and so owns its cleanup).
    """
    openai_row, anthropic_row, org_row = str(uuid4()), str(uuid4()), str(uuid4())
    chain_updated_at = datetime(2026, 8, 1, 12, 0, 0, tzinfo=UTC)
    rung_ids = (str(uuid4()), str(uuid4()))
    setup.execute(
        """
        insert into public.organizations (id, slug, name) values
          (%s, %s, 'GW Int P3 A'), (%s, %s, 'GW Int P3 B')
        """,
        (
            fixture.org_a,
            f"gw-int-p3-a-{fixture.suffix}",
            fixture.org_b,
            f"gw-int-p3-b-{fixture.suffix}",
        ),
    )
    setup.execute(
        """
        insert into public.models (id, slug, display_name, owning_org_id) values
          (%s, %s, 'GW Public', null), (%s, %s, 'GW Org', %s)
        """,
        (
            fixture.public_model,
            fixture.public_slug,
            fixture.org_model,
            fixture.org_slug,
            fixture.org_a,
        ),
    )
    setup.execute(
        """
        insert into public.model_providers (
          id, model_id, provider, provider_model_id, billing_source,
          owning_org_id, input_micro_usd_per_million, output_micro_usd_per_million,
          created_at
        ) values
          (%s, %s, 'openai', 'gpt-5', 'host_managed', null, 2500000, 10000000, now()),
          (%s, %s, 'anthropic', 'claude-opus-5', 'host_managed', null, null, null,
           now() + interval '1 second'),
          (%s, %s, 'openai', 'ft:gpt-5:org', 'customer_managed', %s, 2500000, 10000000,
           now() + interval '2 seconds')
        """,
        (
            openai_row,
            fixture.public_model,
            anthropic_row,
            fixture.public_model,
            org_row,
            fixture.org_model,
            fixture.org_a,
        ),
    )
    setup.execute(
        """
        insert into public.model_waterfalls (
          id, model_id, org_id, position, model_provider_id, updated_at
        ) values
          (%s, %s, null, 0, %s, %s), (%s, %s, null, 1, %s, %s)
        """,
        (
            rung_ids[0],
            fixture.public_model,
            openai_row,
            chain_updated_at,
            rung_ids[1],
            fixture.public_model,
            anthropic_row,
            chain_updated_at,
        ),
    )
    # Org A's BYOK OpenAI key via the sanctioned Vault path; the org-custom
    # model resolves through it. Org B gets one too, for the variant lane.
    setup.execute(
        "select * from public.upsert_provider_connection(%s, 'openai', '{}'::jsonb, %s)",
        (fixture.org_a, fixture.canary),
    )
    setup.execute(
        "select * from public.upsert_provider_connection(%s, 'openai', '{}'::jsonb, %s)",
        (fixture.org_b, f"{fixture.canary}-b"),
    )
    # The house org funds the host_managed lane through the same Vault path.
    house_row = setup.execute(
        "select id from public.organizations where slug = %s", (HOUSE_ORG_SLUG,)
    ).fetchone()
    house_created = house_row is None
    if house_created:
        house_org = str(uuid4())
        setup.execute(
            "insert into public.organizations (id, slug, name) values (%s, %s, %s)",
            (house_org, HOUSE_ORG_SLUG, "Experiential Labs House"),
        )
    else:
        assert house_row is not None
        house_org = str(house_row[0])
    setup.execute(
        "select * from public.upsert_provider_connection(%s, 'openai', '{}'::jsonb, %s)",
        (house_org, fixture.house_canary),
    )
    return house_created


def _assert_no_credential_rows(
    setup: psycopg.Connection[tuple[object, ...]], values: tuple[str, ...]
) -> None:
    """The no-leak grep: no credential value in any catalog or gateway row."""
    scans = (
        """
        select count(*) from public.gateway_catalog_snapshots
         where document::text like %s or models_document::text like %s
        """,
        """
        select count(*) from public.gateway_alias_revisions
         where target::text like %s
            or provider_connection_revisions::text like %s
        """,
    )
    for scan_sql in scans:
        for value in values:
            pattern = f"%{value}%"
            leak_row = setup.execute(scan_sql, (pattern, pattern)).fetchone()
            assert leak_row is not None
            assert leak_row[0] == 0


def _wait_for_new_revision(
    refresher: GatewayCatalogRefresher, alias_name: str, previous_revision_id: str
) -> None:
    """Wait until the poll loop swaps in a new revision for one alias."""
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        current = next(
            plan for plan in refresher.state.build.alias_plans if plan.alias_name == alias_name
        )
        if current.revision_id != previous_revision_id:
            return
        time.sleep(0.05)
    message = "serving_revision bump was not picked up by the poll loop"
    raise AssertionError(message)


@pytest.mark.integration
def test_catalog_store_refresh_pickup_and_secret_safety() -> None:
    """Store, idempotency, one-poll-tick pickup, and the no-leak grep, on real Postgres."""
    url = _database_url()
    fixture = _IntegrationFixture(
        suffix=uuid4().hex[:8],
        org_a=str(uuid4()),
        org_b=str(uuid4()),
        public_model=str(uuid4()),
        org_model=str(uuid4()),
        canary=f"vault-canary-{uuid4().hex}",
        house_canary=f"house-canary-{uuid4().hex}",
    )
    environment = fixture.environment()
    setup = psycopg.connect(url, autocommit=True)
    house_created = False
    try:
        house_created = _seed_integration_fixture(setup, fixture)
        refresher = GatewayCatalogRefresher(
            lambda: psycopg.connect(url),
            environment=environment,
            poll_interval_seconds=0.2,
        )
        assert refresher.refresh_now() is True
        build = refresher.state.build
        assert build.catalog_sha256 is not None
        public_plan = _plan_by_name(build, fixture.public_slug)
        org_plan = _plan_by_name(build, fixture.org_slug)
        assert public_plan.target.pool_id == f"wf-{fixture.public_model}"
        assert org_plan.org_id == fixture.org_a

        snapshot_row = setup.execute(
            "select count(*) from public.gateway_catalog_snapshots where catalog_sha256 = %s",
            (build.catalog_sha256,),
        ).fetchone()
        assert snapshot_row is not None
        assert snapshot_row[0] == 1
        alias_row = setup.execute(
            """
            select aliases.current_revision_id, aliases.active, revisions.target
              from public.gateway_aliases aliases
              join public.gateway_alias_revisions revisions
                on revisions.revision_id = aliases.current_revision_id
             where aliases.alias_name = %s
            """,
            (fixture.public_slug,),
        ).fetchone()
        assert alias_row is not None
        assert alias_row[0] == public_plan.revision_id
        assert alias_row[1] is True
        assert alias_row[2] == public_plan.target_document()

        # Idempotent: nothing changed, so the watermark converges to a no-op.
        assert refresher.refresh_now() is False

        # A serving_revision bump (credential rotation) lands within one tick.
        refresher.start()
        try:
            setup.execute(
                """
                update public.provider_connections
                   set serving_revision = serving_revision + 100000
                 where org_id = %s and provider = 'openai'
                """,
                (fixture.org_a,),
            )
            _wait_for_new_revision(refresher, fixture.org_slug, org_plan.revision_id)
        finally:
            refresher.stop()

        _assert_no_credential_rows(
            setup,
            (fixture.canary, fixture.house_canary, environment["OPENAI_API_KEY"]),
        )
        # The credentials DID reach worker memory (and only worker memory);
        # the host lane resolved from the house org's Vault connection, so the
        # env fallback for openai stayed untouched.
        credentials = set(refresher.state.credentials.values())
        assert fixture.canary in credentials
        assert fixture.house_canary in credentials
        assert environment["OPENAI_API_KEY"] not in credentials
    finally:
        setup.execute(
            "delete from public.models where id in (%s, %s)",
            (fixture.public_model, fixture.org_model),
        )
        setup.execute(
            "delete from public.organizations where id in (%s, %s)",
            (fixture.org_a, fixture.org_b),
        )
        if house_created:
            setup.execute("delete from public.organizations where slug = %s", (HOUSE_ORG_SLUG,))
        setup.close()


@pytest.mark.integration
def test_orphaned_org_alias_is_skipped_and_the_rest_of_the_catalog_serves() -> None:
    """One alias whose org row is gone degrades alone; the fleet keeps serving.

    Replication-role writes bypass FK cascade triggers, so a deleted
    organization can leave its models row behind. Activating that model's
    alias then violates the gateway_aliases org FK; before the per-alias
    savepoint this aborted the whole store and kept every worker's catalog
    from loading.
    """
    url = _database_url()
    fixture = _IntegrationFixture(
        suffix=uuid4().hex[:8],
        org_a=str(uuid4()),
        org_b=str(uuid4()),
        public_model=str(uuid4()),
        org_model=str(uuid4()),
        canary=f"vault-canary-{uuid4().hex}",
        house_canary=f"house-canary-{uuid4().hex}",
    )
    setup = psycopg.connect(url, autocommit=True)
    house_created = False
    try:
        house_created = _seed_integration_fixture(setup, fixture)
        # Orphan org A past its FK the way replication-role writes can:
        # cascade triggers are disabled, so its models and connections rows
        # survive the delete.
        setup.execute("set session_replication_role = replica")
        try:
            setup.execute("delete from public.organizations where id = %s", (fixture.org_a,))
        finally:
            setup.execute("set session_replication_role = origin")

        refresher = GatewayCatalogRefresher(
            lambda: psycopg.connect(url),
            environment=fixture.environment(),
            poll_interval_seconds=3600.0,
        )
        # The whole point: the refresh completes instead of raising.
        assert refresher.refresh_now() is True
        build = refresher.state.build
        public_plan = _plan_by_name(build, fixture.public_slug)

        active_row = setup.execute(
            "select active from public.gateway_aliases where alias_name = %s",
            (fixture.public_slug,),
        ).fetchone()
        assert active_row is not None
        assert active_row[0] is True
        orphan_row = setup.execute(
            "select 1 from public.gateway_aliases where alias_name = %s",
            (fixture.org_slug,),
        ).fetchone()
        assert orphan_row is None
        assert public_plan.catalog_sha256 == build.catalog_sha256
    finally:
        setup.execute("set session_replication_role = origin")
        setup.execute("delete from public.provider_connections where org_id = %s", (fixture.org_a,))
        setup.execute(
            "delete from public.models where id in (%s, %s)",
            (fixture.public_model, fixture.org_model),
        )
        setup.execute("delete from public.organizations where id = %s", (fixture.org_b,))
        if house_created:
            setup.execute("delete from public.organizations where slug = %s", (HOUSE_ORG_SLUG,))
        setup.close()


@pytest.mark.integration
def test_alias_identity_drift_stays_fatal_and_is_never_skipped() -> None:
    """The identity guard's 23505 aborts the store pass; skip-and-warn stays out.

    The per-alias skip absorbs ONLY the orphaned-row foreign-key shape
    (23503). gateway_activate_alias_revision's identity guard raises 23505
    when an alias_id presents a different name — the exact production shape
    the alias-identity reconcile migration exists for — and that violation
    must propagate out of the refresh loudly: a per-row skip here would serve
    a catalog whose identities silently disagree with the database and hide
    the drift a slug-renaming migration introduced.
    """
    url = _database_url()
    fixture = _IntegrationFixture(
        suffix=uuid4().hex[:8],
        org_a=str(uuid4()),
        org_b=str(uuid4()),
        public_model=str(uuid4()),
        org_model=str(uuid4()),
        canary=f"vault-canary-{uuid4().hex}",
        house_canary=f"house-canary-{uuid4().hex}",
    )
    drifted_name = f"gw-int-drifted-{fixture.suffix}"
    setup = psycopg.connect(url, autocommit=True)
    house_created = False
    try:
        house_created = _seed_integration_fixture(setup, fixture)
        first = GatewayCatalogRefresher(
            lambda: psycopg.connect(url),
            environment=fixture.environment(),
            poll_interval_seconds=3600.0,
        )
        assert first.refresh_now() is True

        # Drift the public alias's identity the way an unreconciled
        # slug-renaming migration would: the stored row keeps its alias_id
        # while its name no longer matches the model's slug.
        setup.execute(
            "update public.gateway_aliases set alias_name = %s where alias_name = %s",
            (drifted_name, fixture.public_slug),
        )

        second = GatewayCatalogRefresher(
            lambda: psycopg.connect(url),
            environment=fixture.environment(),
            poll_interval_seconds=3600.0,
        )
        # The whole point: identity drift raises out of the refresh instead
        # of landing on skipped_aliases.
        with pytest.raises(psycopg.errors.UniqueViolation, match="alias identity drifted"):
            second.refresh_now()
        # The aborted store landed nothing: the drifted row is untouched.
        drift_row = setup.execute(
            "select alias_name from public.gateway_aliases where alias_name = %s",
            (drifted_name,),
        ).fetchone()
        assert drift_row is not None
    finally:
        setup.execute(
            "delete from public.models where id in (%s, %s)",
            (fixture.public_model, fixture.org_model),
        )
        setup.execute(
            "delete from public.organizations where id in (%s, %s)",
            (fixture.org_a, fixture.org_b),
        )
        if house_created:
            setup.execute("delete from public.organizations where slug = %s", (HOUSE_ORG_SLUG,))
        setup.close()


@pytest.mark.integration
def test_undecryptable_connection_credential_degrades_only_its_deployments() -> None:
    """A Vault secret that cannot be released skips its rows; the rest serves.

    Before the build-time releasability probe, one undecryptable secret failed
    the whole state materialization at credential release and crashlooped
    every worker.
    """
    url = _database_url()
    fixture = _IntegrationFixture(
        suffix=uuid4().hex[:8],
        org_a=str(uuid4()),
        org_b=str(uuid4()),
        public_model=str(uuid4()),
        org_model=str(uuid4()),
        canary=f"vault-canary-{uuid4().hex}",
        house_canary=f"house-canary-{uuid4().hex}",
    )
    setup = psycopg.connect(url, autocommit=True)
    house_created = False
    try:
        house_created = _seed_integration_fixture(setup, fixture)
        connection_row = setup.execute(
            """
            select id from public.provider_connections
             where org_id = %s and provider = 'openai'
            """,
            (fixture.org_a,),
        ).fetchone()
        assert connection_row is not None
        # Make org A's secret unreleasable the way a lost Vault key would.
        setup.execute(
            """
            delete from vault.secrets where id = (
              select vault_secret_id from public.provider_connections where id = %s
            )
            """,
            (connection_row[0],),
        )

        refresher = GatewayCatalogRefresher(
            lambda: psycopg.connect(url),
            environment=fixture.environment(),
            poll_interval_seconds=3600.0,
        )
        # The whole point: the refresh completes instead of raising.
        assert refresher.refresh_now() is True
        build = refresher.state.build
        assert any(
            f"provider connection {connection_row[0]}: credential release failed" in warning
            for warning in build.warnings
        )
        assert not any(plan.alias_name == fixture.org_slug for plan in build.alias_plans)
        public_plan = _plan_by_name(build, fixture.public_slug)
        assert public_plan.catalog_sha256 == build.catalog_sha256
        credentials = set(refresher.state.credentials.values())
        assert fixture.canary not in credentials
        assert f"{fixture.canary}-b" in credentials
        assert fixture.house_canary in credentials
    finally:
        setup.execute(
            "delete from public.models where id in (%s, %s)",
            (fixture.public_model, fixture.org_model),
        )
        setup.execute(
            "delete from public.organizations where id in (%s, %s)",
            (fixture.org_a, fixture.org_b),
        )
        if house_created:
            setup.execute("delete from public.organizations where slug = %s", (HOUSE_ORG_SLUG,))
        setup.close()


@pytest.mark.integration
def test_route_resolution_catches_up_to_a_published_generation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A worker catches up when another worker publishes a new catalog generation."""
    url = _database_url()
    fixture = _IntegrationFixture(
        suffix=uuid4().hex[:8],
        org_a=str(uuid4()),
        org_b=str(uuid4()),
        public_model=str(uuid4()),
        org_model=str(uuid4()),
        canary=f"vault-canary-{uuid4().hex}",
        house_canary=f"house-canary-{uuid4().hex}",
    )
    environment = fixture.environment()
    setup = psycopg.connect(url, autocommit=True)
    house_created = False
    try:
        house_created = _seed_integration_fixture(setup, fixture)
        worker_a = GatewayCatalogRefresher(
            lambda: psycopg.connect(url),
            environment=environment,
            poll_interval_seconds=3600.0,
        )
        worker_b = GatewayCatalogRefresher(
            lambda: psycopg.connect(url),
            environment=environment,
            poll_interval_seconds=3600.0,
        )
        assert worker_a.refresh_now() is True
        assert worker_b.refresh_now() is True
        old_plan = _plan_by_name(worker_a.state.build, fixture.org_slug)

        setup.execute(
            """
            update public.provider_connections
               set serving_revision = serving_revision + 100000
             where org_id = %s and provider = 'openai'
            """,
            (fixture.org_a,),
        )
        assert worker_b.refresh_now() is True
        new_plan = _plan_by_name(worker_b.state.build, fixture.org_slug)
        assert new_plan.revision_id != old_plan.revision_id
        assert (
            worker_a.state_for_key((old_plan.revision_id, old_plan.catalog_sha256))
            is worker_a.state
        )

        resolver = worker_a.route_resolver()
        route = asyncio.run(
            resolver.resolve(
                authorization=_authorization(new_plan, f"org-{fixture.org_a}"),
                request=_request(),
                episode_namespace=(
                    f"org-{fixture.org_a}",
                    "identity",
                    new_plan.revision_id,
                    "episode",
                ),
            )
        )
        assert route.deployment.deployment_id == new_plan.target_deployment_ids[0]
        assert (new_plan.revision_id, new_plan.catalog_sha256) in worker_a.state.route_catalogs

        refresh_count = 0
        refresh_now = worker_a.refresh_now

        def counted_refresh() -> bool:
            nonlocal refresh_count
            refresh_count += 1
            return refresh_now()

        monkeypatch.setattr(worker_a, "refresh_now", counted_refresh)
        monkeypatch.setattr(worker_a, "_last_catch_up_at", float("-inf"))
        unknown = ("revision-never-published", "f" * 64)
        with pytest.raises(GatewayRoutingError):
            asyncio.run(
                resolver.resolve(
                    authorization=_authorization(
                        new_plan,
                        f"org-{fixture.org_a}",
                        revision_id=unknown[0],
                        catalog_sha256=unknown[1],
                    ),
                    request=_request(),
                    episode_namespace=(f"org-{fixture.org_a}", "identity", *unknown),
                )
            )
        with pytest.raises(GatewayRoutingError):
            asyncio.run(
                resolver.resolve(
                    authorization=_authorization(
                        new_plan,
                        f"org-{fixture.org_a}",
                        revision_id=unknown[0],
                        catalog_sha256=unknown[1],
                    ),
                    request=_request(),
                    episode_namespace=(f"org-{fixture.org_a}", "identity", *unknown),
                )
            )
        assert refresh_count == 1
    finally:
        setup.execute(
            "delete from public.models where id in (%s, %s)",
            (fixture.public_model, fixture.org_model),
        )
        setup.execute(
            "delete from public.organizations where id in (%s, %s)",
            (fixture.org_a, fixture.org_b),
        )
        if house_created:
            setup.execute("delete from public.organizations where slug = %s", (HOUSE_ORG_SLUG,))
        setup.close()


def test_route_resolution_keeps_previous_state_when_catch_up_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A failed catch-up keeps the last state and fails closed."""
    build = build_gateway_catalog(_fixture_rows(), environment=_environment())
    state = build_catalog_state(build, environment=_environment(), release=_release)
    refresher = GatewayCatalogRefresher(lambda: psycopg.connect("postgresql://unused"))
    monkeypatch.setattr(refresher, "_state", state)
    plan = _plan_by_name(build, "gw-public-model")
    unknown = ("revision-never-published", "f" * 64)

    def fail_refresh() -> bool:
        message = "missing provider credential"
        raise GatewayCredentialError(message)

    monkeypatch.setattr(refresher, "refresh_now", fail_refresh)
    monkeypatch.setattr(refresher, "_last_catch_up_at", float("-inf"))

    with pytest.raises(GatewayRoutingError):
        asyncio.run(
            refresher.route_resolver().resolve(
                authorization=_authorization(
                    plan,
                    f"org-{_ORG_A}",
                    revision_id=unknown[0],
                    catalog_sha256=unknown[1],
                ),
                request=_request(),
                episode_namespace=(f"org-{_ORG_A}", "identity", *unknown),
            )
        )
    assert refresher.state is state


_AZURE_ROW_ID = "51000000-0000-4000-8000-000000000051"
_BEDROCK_ROW_ID = "52000000-0000-4000-8000-000000000052"
_FIREWORKS_ROW_ID = "53000000-0000-4000-8000-000000000053"
_OPENROUTER_ROW_ID = "54000000-0000-4000-8000-000000000054"
_HOUSE_ORG = "ee000000-0000-4000-8000-0000000000ee"
_HOUSE_AZURE_CONN = "5a000000-0000-4000-8000-00000000005a"
_HOUSE_OPENROUTER_CONN = "5b000000-0000-4000-8000-00000000005b"


def test_house_lane_orders_azure_bedrock_then_fireworks() -> None:
    """A platform-funded model on Azure+Bedrock+Fireworks serves in house order.

    The operator's chain (deliberately scrambled here) certifies the three lanes
    as one exact model; the house-lane preference orders the certified pool
    Azure -> Bedrock -> Fireworks regardless of the persisted chain positions.
    """
    model = _model_row(slug="gw-multi-provider-model")
    azure_row = _provider_row(
        id=_AZURE_ROW_ID,
        provider="azure_openai",
        provider_model_id="gpt-5",
    )
    bedrock_row = _provider_row(
        id=_BEDROCK_ROW_ID,
        provider="bedrock",
        provider_model_id="anthropic.gpt-5-v1:0",
        region="us-east-1",
        created_at=_NOW + timedelta(minutes=1),
    )
    fireworks_row = _provider_row(
        id=_FIREWORKS_ROW_ID,
        provider="fireworks",
        provider_model_id="accounts/fireworks/models/gpt-5",
        created_at=_NOW + timedelta(minutes=2),
    )
    house_azure = _connection_row(
        id=_HOUSE_AZURE_CONN,
        org_id=_HOUSE_ORG,
        provider="azure_openai",
        config={
            "endpoint": "https://house.openai.azure.com/",
            "api_version": "v1",
            "deployments": {"gpt-5": "gpt5-house"},
        },
    )
    # Scrambled chain order proves the ordering comes from the house preference,
    # not from the persisted rung positions.
    chain = _make_chain(
        _PUBLIC_MODEL_ID,
        (_FIREWORKS_ROW_ID, _AZURE_ROW_ID, _BEDROCK_ROW_ID),
        digit_leading=False,
    )
    build = build_gateway_catalog(
        PlatformCatalogRows(
            models=(model,),
            providers=(azure_row, bedrock_row, fireworks_row),
            waterfalls=chain,
            connections=(house_azure,),
            house_org_id=_HOUSE_ORG,
        ),
        environment={"FIREWORKS_API_KEY": "platform-fireworks-canary"},
    )
    assert build.normalized is not None
    azure_alias = f"mp-{_AZURE_ROW_ID}"
    bedrock_alias = f"mp-{_BEDROCK_ROW_ID}"
    fireworks_alias = f"mp-{_FIREWORKS_ROW_ID}"
    pool = {pool.pool_id: pool for pool in build.normalized.pools}[f"wf-{_PUBLIC_MODEL_ID}"]
    assert pool.deployment_ids == (azure_alias, bedrock_alias, fireworks_alias)

    plan = _plan_by_name(build, "gw-multi-provider-model")
    assert plan.target_deployment_ids == (azure_alias, bedrock_alias, fireworks_alias)
    certification_document = plan.certification_document()
    assert certification_document is not None
    assert certification_document["order"] == [azure_alias, bedrock_alias, fireworks_alias]
    # The certification digest is still addressed to the operator's chain rows,
    # independent of the house-lane serving order.
    assert pool.equivalence is not None
    assert pool.equivalence.certification_id == f"wfcert-{_chain_digest(chain)}"


def test_house_lane_orders_bedrock_before_direct_and_openrouter_last() -> None:
    """Bedrock (rank 2) leads first-party direct (rank 3); OpenRouter sorts last."""
    model = _model_row(slug="gw-direct-bedrock-openrouter")
    anthropic_row = _provider_row(
        id=_ANTHROPIC_ROW_ID,
        provider="anthropic",
        provider_model_id="claude-opus-5",
    )
    openrouter_row = _provider_row(
        id=_OPENROUTER_ROW_ID,
        provider="openrouter",
        provider_model_id="anthropic/claude-opus-5",
        created_at=_NOW + timedelta(minutes=1),
    )
    bedrock_row = _provider_row(
        id=_BEDROCK_ROW_ID,
        provider="bedrock",
        provider_model_id="anthropic.claude-opus-5-v1:0",
        region="us-east-1",
        created_at=_NOW + timedelta(minutes=2),
    )
    # OpenRouter has no platform env credential lane, so it rides the house org.
    house_openrouter = _connection_row(
        id=_HOUSE_OPENROUTER_CONN,
        org_id=_HOUSE_ORG,
        provider="openrouter",
    )
    chain = _make_chain(
        _PUBLIC_MODEL_ID,
        (_ANTHROPIC_ROW_ID, _OPENROUTER_ROW_ID, _BEDROCK_ROW_ID),
        digit_leading=False,
    )
    build = build_gateway_catalog(
        PlatformCatalogRows(
            models=(model,),
            providers=(anthropic_row, openrouter_row, bedrock_row),
            waterfalls=chain,
            connections=(house_openrouter,),
            house_org_id=_HOUSE_ORG,
        ),
        environment={"ANTHROPIC_API_KEY": "platform-anthropic-canary"},
    )
    assert build.normalized is not None
    anthropic_alias = f"mp-{_ANTHROPIC_ROW_ID}"
    openrouter_alias = f"mp-{_OPENROUTER_ROW_ID}"
    bedrock_alias = f"mp-{_BEDROCK_ROW_ID}"
    pool = {pool.pool_id: pool for pool in build.normalized.pools}[f"wf-{_PUBLIC_MODEL_ID}"]
    assert pool.deployment_ids == (bedrock_alias, anthropic_alias, openrouter_alias)

    plan = _plan_by_name(build, "gw-direct-bedrock-openrouter")
    assert plan.target_deployment_ids == (bedrock_alias, anthropic_alias, openrouter_alias)


_ORG_FUNDED_OPENAI_ROW_ID = "55000000-0000-4000-8000-000000000055"
_ORG_FUNDED_BEDROCK_ROW_ID = "56000000-0000-4000-8000-000000000056"
_PUBLIC_BYOK_OPENAI_ROW_ID = "57000000-0000-4000-8000-000000000057"
_PUBLIC_BYOK_AZURE_ROW_ID = "58000000-0000-4000-8000-000000000058"
_UNROUTABLE_BYOK_BEDROCK_ROW_ID = "59000000-0000-4000-8000-000000000059"


def test_org_waterfall_override_keeps_the_tenant_order() -> None:
    """An org's own chain order survives the house-lane preference.

    The rungs here are platform-funded, so the house preference would lead with
    Bedrock; this order came from the tenant's ``PUT /api/models/{slug}/waterfall``
    though, so the build serves it exactly as persisted.
    """
    model = _model_row(id=_ORG_MODEL_ID, slug="gw-org-override-model", owning_org_id=_ORG_A)
    openai_row = _provider_row(
        id=_ORG_FUNDED_OPENAI_ROW_ID,
        model_id=_ORG_MODEL_ID,
        owning_org_id=_ORG_A,
        provider="openai",
        provider_model_id="gpt-5",
    )
    bedrock_row = _provider_row(
        id=_ORG_FUNDED_BEDROCK_ROW_ID,
        model_id=_ORG_MODEL_ID,
        owning_org_id=_ORG_A,
        provider="bedrock",
        provider_model_id="anthropic.gpt-5-v1:0",
        region="us-east-1",
        created_at=_NOW + timedelta(minutes=1),
    )
    override = _make_chain(
        _ORG_MODEL_ID,
        (_ORG_FUNDED_OPENAI_ROW_ID, _ORG_FUNDED_BEDROCK_ROW_ID),
        digit_leading=False,
        org_id=_ORG_A,
    )
    build = build_gateway_catalog(
        PlatformCatalogRows(
            models=(model,),
            providers=(openai_row, bedrock_row),
            waterfalls=override,
            connections=(),
        ),
        environment={"OPENAI_API_KEY": "platform-openai-canary-0001"},
    )
    assert build.normalized is not None
    openai_alias = f"mp-{_ORG_FUNDED_OPENAI_ROW_ID}"
    bedrock_alias = f"mp-{_ORG_FUNDED_BEDROCK_ROW_ID}"
    pool_id = f"wf-{_ORG_MODEL_ID}-org-{_ORG_A}"
    pool = {pool.pool_id: pool for pool in build.normalized.pools}[pool_id]
    assert pool.deployment_ids == (openai_alias, bedrock_alias)

    plan = _plan_by_name(build, "gw-org-override-model")
    assert plan.target_deployment_ids == (openai_alias, bedrock_alias)


def test_customer_managed_chain_keeps_the_persisted_order() -> None:
    """BYOK rungs keep their chain order, alone and mixed with a funded rung.

    Each caller pays for a ``customer_managed`` lane with its own credential, so
    the house-lane preference (which would lead with Azure) has no say over it.
    A chain that mixes funding lanes is not the platform's to reorder either.
    """
    model = _model_row(slug="gw-public-byok-model")
    byok_openai_row = _provider_row(
        id=_PUBLIC_BYOK_OPENAI_ROW_ID,
        provider="openai",
        provider_model_id="gpt-5",
        billing_source="customer_managed",
    )
    azure_row = _provider_row(
        id=_PUBLIC_BYOK_AZURE_ROW_ID,
        provider="azure_openai",
        provider_model_id="gpt-5",
        billing_source="customer_managed",
        created_at=_NOW + timedelta(minutes=1),
    )
    chain = _make_chain(
        _PUBLIC_MODEL_ID,
        (_PUBLIC_BYOK_OPENAI_ROW_ID, _PUBLIC_BYOK_AZURE_ROW_ID),
        digit_leading=False,
    )
    openai_alias = f"mp-{_PUBLIC_BYOK_OPENAI_ROW_ID}"
    azure_alias = f"mp-{_PUBLIC_BYOK_AZURE_ROW_ID}"

    byok_only = build_gateway_catalog(
        PlatformCatalogRows(
            models=(model,),
            providers=(byok_openai_row, azure_row),
            waterfalls=chain,
            connections=(),
        ),
        environment={},
    )
    assert byok_only.normalized is not None
    byok_pool = {pool.pool_id: pool for pool in byok_only.normalized.pools}[
        f"wf-{_PUBLIC_MODEL_ID}"
    ]
    assert byok_pool.deployment_ids == (openai_alias, azure_alias)

    funded_openai_row = _provider_row(id=_PUBLIC_BYOK_OPENAI_ROW_ID, provider_model_id="gpt-5")
    mixed = build_gateway_catalog(
        PlatformCatalogRows(
            models=(model,),
            providers=(funded_openai_row, azure_row),
            waterfalls=chain,
            connections=(),
        ),
        environment={"OPENAI_API_KEY": "platform-openai-canary-0001"},
    )
    assert mixed.normalized is not None
    mixed_pool = {pool.pool_id: pool for pool in mixed.normalized.pools}[f"wf-{_PUBLIC_MODEL_ID}"]
    assert mixed_pool.deployment_ids == (openai_alias, azure_alias)


def test_house_lane_orders_the_funded_rungs_a_mixed_chain_can_serve() -> None:
    """A dropped BYOK rung does not freeze the funded rungs that remain.

    The default chain mixes lanes, but its ``customer_managed`` Bedrock rung is
    unroutable (Bedrock BYOK carries no per-tenant boto session), so the pool the
    alias serves is platform-funded end to end -- and the house-lane preference
    orders exactly that pool.
    """
    model = _model_row(slug="gw-mixed-chain-dropped-byok")
    anthropic_row = _provider_row(
        id=_ANTHROPIC_ROW_ID,
        provider="anthropic",
        provider_model_id="claude-opus-5",
    )
    byok_bedrock_row = _provider_row(
        id=_UNROUTABLE_BYOK_BEDROCK_ROW_ID,
        owning_org_id=_ORG_A,
        provider="bedrock",
        provider_model_id="anthropic.claude-opus-5-v1:0",
        region="us-east-1",
        billing_source="customer_managed",
        created_at=_NOW + timedelta(minutes=1),
    )
    bedrock_row = _provider_row(
        id=_BEDROCK_ROW_ID,
        provider="bedrock",
        provider_model_id="anthropic.claude-opus-5-v1:0",
        region="us-east-1",
        created_at=_NOW + timedelta(minutes=2),
    )
    chain = _make_chain(
        _PUBLIC_MODEL_ID,
        (_ANTHROPIC_ROW_ID, _UNROUTABLE_BYOK_BEDROCK_ROW_ID, _BEDROCK_ROW_ID),
        digit_leading=False,
    )
    build = build_gateway_catalog(
        PlatformCatalogRows(
            models=(model,),
            providers=(anthropic_row, byok_bedrock_row, bedrock_row),
            waterfalls=chain,
            connections=(),
        ),
        environment={"ANTHROPIC_API_KEY": "platform-anthropic-canary"},
    )
    assert build.normalized is not None
    assert f"mp-{_UNROUTABLE_BYOK_BEDROCK_ROW_ID}" not in {
        deployment.deployment_id for deployment in build.normalized.deployments
    }
    pool = {pool.pool_id: pool for pool in build.normalized.pools}[f"wf-{_PUBLIC_MODEL_ID}"]
    assert pool.deployment_ids == (f"mp-{_BEDROCK_ROW_ID}", f"mp-{_ANTHROPIC_ROW_ID}")


def test_public_customer_managed_fireworks_routes_byok_and_fails_closed() -> None:
    """A public BYOK Fireworks model routes an org's own key; an org without one is rejected."""
    fw_row_id = "34000000-0000-4000-8000-000000000004"
    fw_conn_id = "43000000-0000-4000-8000-000000000003"
    model = _model_row(slug="fireworks-models-kimi-k2p6")
    provider = _provider_row(
        id=fw_row_id,
        provider="fireworks",
        provider_model_id="accounts/fireworks/models/kimi-k2p6",
        billing_source="customer_managed",
        input_micro_usd_per_million=None,
        output_micro_usd_per_million=None,
        pricing_source=None,
        capabilities={"supports_streaming": True},
    )
    fw_conn = _connection_row(id=fw_conn_id, org_id=_ORG_A, provider="fireworks")
    rows = PlatformCatalogRows(
        models=(model,),
        providers=(provider,),
        waterfalls=(),
        connections=(fw_conn,),
        house_org_id=None,
    )
    build = build_gateway_catalog(rows, environment=_environment())
    canonical = f"mp-{fw_row_id}"
    # The public customer_managed row is INCLUDED (not skipped): a fail-closed
    # canonical plus a per-org variant for the org that holds a connection.
    assert canonical in build.byok_required_deployments
    assert build.byok_deployment_variants.get(_ORG_A, {}).get(canonical) == (
        f"{canonical}-c-{fw_conn_id}"
    )

    state = build_catalog_state(build, environment=_environment(), release=_release)
    resolver = OrgAwareRouteResolver(_StaticStateProvider(state))
    plan = _plan_by_name(build, "fireworks-models-kimi-k2p6")

    # Org A holds a Fireworks connection: its own key is substituted in.
    route_a = asyncio.run(
        resolver.resolve(
            authorization=_authorization(plan, f"org-{_ORG_A}"),
            request=_request(),
            episode_namespace=(f"org-{_ORG_A}", "identity", plan.revision_id, "episode"),
        )
    )
    assert route_a.deployment.deployment_id == f"{canonical}-c-{fw_conn_id}"
    assert route_a.deployment.billing_source is BillingSource.CUSTOMER_MANAGED

    # Org B has no Fireworks connection: fail closed, never a shared dispatch.
    with pytest.raises(GatewayExecutionError) as excinfo:
        asyncio.run(
            resolver.resolve(
                authorization=_authorization(plan, f"org-{_ORG_B}"),
                request=_request(),
                episode_namespace=(f"org-{_ORG_B}", "identity", plan.revision_id, "episode"),
            )
        )
    assert excinfo.value.failure is not None
    assert excinfo.value.failure.failure_class is GatewayFailureClass.INVALID_REQUEST


def test_public_azure_byok_row_builds_with_placeholder_endpoint() -> None:
    """A public azure_openai BYOK row must not abort the catalog build.

    Azure's ConnectionConfig requires an explicit resource endpoint even on the
    fail-closed public-BYOK placeholder connection. Before the fix a single
    public Azure Foundry BYOK row raised a pydantic ValidationError from
    ``_register_byok_required_connection`` and took down the whole gateway
    catalog refresh on prod (2026-08-21), where the real catalog carries 303
    such rows. The empty staging catalog never exercised it.
    """
    public_model = _model_row(slug="gw-azure-byok-model")
    azure_byok = _provider_row(
        id=_ANTHROPIC_ROW_ID,
        provider="azure_openai",
        provider_model_id="grok-4",
        billing_source="customer_managed",
        input_micro_usd_per_million=None,
        output_micro_usd_per_million=None,
        pricing_source=None,
    )
    rows = PlatformCatalogRows(
        models=(public_model,),
        providers=(azure_byok,),
        waterfalls=_make_chain(_PUBLIC_MODEL_ID, (_ANTHROPIC_ROW_ID,), digit_leading=False),
        connections=(),
    )
    # Must not raise ConnectionConfig ValidationError.
    build = build_gateway_catalog(rows, environment=_environment())
    assert build.normalized is not None


# -- provider data-control policy (enterprise E5.3) --------------------------------


def _policy_state(
    policy: OrgProviderPolicy | None,
    controls: dict[str, ProviderDataControls] | None = None,
) -> GatewayCatalogState:
    """Build the fixture catalog state with one org policy installed."""
    build = build_gateway_catalog(_fixture_rows(), environment=_environment())
    return build_catalog_state(
        build,
        environment=_environment(),
        release=_release,
        provider_controls={} if controls is None else controls,
        provider_policies={} if policy is None else {policy.org_id: policy},
    )


def _resolve_public(state: GatewayCatalogState, organization: str) -> GatewayRoute:
    resolver = OrgAwareRouteResolver(_StaticStateProvider(state))
    plan = _plan_by_name(state.build, "gw-public-model")
    return asyncio.run(
        resolver.resolve(
            authorization=_authorization(plan, f"org-{organization}"),
            request=_request(),
            episode_namespace=(f"org-{organization}", "identity", plan.revision_id, "episode"),
        )
    )


def test_provider_policy_absent_leaves_route_untouched() -> None:
    """An org with no policy row resolves exactly the unfiltered route."""
    unfiltered = _resolve_public(_policy_state(None), _ORG_A)
    filtered_state = _policy_state(
        OrgProviderPolicy(
            org_id=_ORG_B,  # policy for a DIFFERENT org
            allowed_providers=frozenset({"anthropic"}),
            require_zdr=False,
            require_no_training=False,
        )
    )
    route = _resolve_public(filtered_state, _ORG_A)
    assert [d.deployment_id for d in route.deployments] == [
        d.deployment_id for d in unfiltered.deployments
    ]


def test_provider_policy_allowlist_filters_route_and_rebuilds_snapshot() -> None:
    """The allowlist removes disallowed providers and re-pins the snapshot."""
    state = _policy_state(
        OrgProviderPolicy(
            org_id=_ORG_A,
            allowed_providers=frozenset({"anthropic"}),
            require_zdr=False,
            require_no_training=False,
        )
    )
    route = _resolve_public(state, _ORG_A)
    assert all(d.provider == "anthropic" for d in route.deployments)
    assert route.snapshot.deployment_ids == tuple(d.deployment_id for d in route.deployments)
    _assert_ledger_dispatch_gate_holds(route)


def test_provider_policy_zdr_fails_closed_on_unknown_provider() -> None:
    """A provider absent from the curated matrix fails a required flag."""
    state = _policy_state(
        OrgProviderPolicy(
            org_id=_ORG_A,
            allowed_providers=None,
            require_zdr=True,
            require_no_training=False,
        ),
        controls={
            # anthropic is curated ZDR here; openai is deliberately ABSENT.
            "anthropic": ProviderDataControls(
                provider="anthropic", zero_data_retention=True, no_training=True
            )
        },
    )
    route = _resolve_public(state, _ORG_A)
    assert all(d.provider == "anthropic" for d in route.deployments)
    _assert_ledger_dispatch_gate_holds(route)


def test_provider_policy_with_no_surviving_route_refuses_with_requirements() -> None:
    """An unsatisfiable policy refuses the request naming its requirements."""
    state = _policy_state(
        OrgProviderPolicy(
            org_id=_ORG_A,
            allowed_providers=frozenset({"anthropic"}),
            require_zdr=True,
            require_no_training=True,
        ),
        controls={
            "anthropic": ProviderDataControls(
                provider="anthropic", zero_data_retention=False, no_training=True
            )
        },
    )
    with pytest.raises(GatewayExecutionError) as excinfo:
        _resolve_public(state, _ORG_A)
    assert excinfo.value.failure.failure_class is GatewayFailureClass.AUTHORIZATION
    message = excinfo.value.failure.safe_message
    assert "provider allowlist" in message
    assert "zero-data-retention" in message


def test_provider_policy_filters_byok_variants_by_their_provider() -> None:
    """Org B's BYOK openai variant is governed like its canonical provider."""
    state = _policy_state(
        OrgProviderPolicy(
            org_id=_ORG_B,
            allowed_providers=frozenset({"anthropic"}),
            require_zdr=False,
            require_no_training=False,
        )
    )
    route = _resolve_public(state, _ORG_B)
    assert all(d.provider == "anthropic" for d in route.deployments)
    _assert_ledger_dispatch_gate_holds(route)


def test_org_provider_policy_permits_semantics() -> None:
    """permits(): allowlist gates first; required flags fail closed."""
    controls = {
        "openai": ProviderDataControls(
            provider="openai", zero_data_retention=False, no_training=True
        )
    }
    unrestricted = OrgProviderPolicy(
        org_id=_ORG_A, allowed_providers=None, require_zdr=False, require_no_training=False
    )
    assert unrestricted.permits("openai", controls)
    assert unrestricted.permits("unknown-provider", controls)
    training_only = OrgProviderPolicy(
        org_id=_ORG_A, allowed_providers=None, require_zdr=False, require_no_training=True
    )
    assert training_only.permits("openai", controls)
    assert not training_only.permits("unknown-provider", controls)
    zdr = OrgProviderPolicy(
        org_id=_ORG_A, allowed_providers=None, require_zdr=True, require_no_training=False
    )
    assert not zdr.permits("openai", controls)


_CLOUD_ROW_ID = "59000000-0000-4000-8000-000000000059"
_CLOUD_AZURE_ROW_ID = "5c000000-0000-4000-8000-00000000005c"


def test_experiential_cloud_is_skipped_until_the_worker_origin_is_configured() -> None:
    """Unconfigured native vLLM rows must not change existing public aliases."""
    from explabs.gateway.experiential_cloud import DEEPSEEK_V4_FLASH_PRICE

    model = _model_row(slug="deepseek-v4-flash")
    cloud_row = _provider_row(
        id=_CLOUD_ROW_ID,
        provider="experiential_cloud",
        provider_model_id="deepseek-v4-flash",
        input_micro_usd_per_million=DEEPSEEK_V4_FLASH_PRICE.input_micro_usd_per_million,
        output_micro_usd_per_million=DEEPSEEK_V4_FLASH_PRICE.output_micro_usd_per_million,
        cached_input_micro_usd_per_million=(
            DEEPSEEK_V4_FLASH_PRICE.cached_input_micro_usd_per_million
        ),
    )
    azure_row = _provider_row(
        id=_CLOUD_AZURE_ROW_ID,
        provider="azure_openai",
        provider_model_id="DeepSeek-V4-Flash",
        created_at=_NOW + timedelta(minutes=1),
    )
    house_azure = _connection_row(
        id=_HOUSE_AZURE_CONN,
        org_id=_HOUSE_ORG,
        provider="azure_openai",
        config={
            "endpoint": "https://house.openai.azure.com/",
            "api_version": "v1",
            "deployments": {"DeepSeek-V4-Flash": "DeepSeek-V4-Flash"},
        },
    )
    chain = _make_chain(
        _PUBLIC_MODEL_ID,
        (_CLOUD_AZURE_ROW_ID, _CLOUD_ROW_ID),
        digit_leading=False,
    )
    build = build_gateway_catalog(
        PlatformCatalogRows(
            models=(model,),
            providers=(cloud_row, azure_row),
            waterfalls=chain,
            connections=(house_azure,),
            house_org_id=_HOUSE_ORG,
        ),
        environment=_environment(),
    )
    assert build.authored is not None
    assert f"mp-{_CLOUD_ROW_ID}" not in build.authored.models
    azure_alias = f"mp-{_CLOUD_AZURE_ROW_ID}"
    assert azure_alias in build.authored.models
    plan = _plan_by_name(build, "deepseek-v4-flash")
    assert plan.target_deployment_ids == (azure_alias,)


def test_experiential_cloud_routes_and_leads_the_house_funded_waterfall() -> None:
    """A configured native lane is first-party, priced, and secret-free."""
    from explabs.gateway.experiential_cloud import (
        API_KEY_ENV,
        BASE_URL_ENV,
        DEEPSEEK_V4_FLASH_PRICE,
    )

    model = _model_row(slug="deepseek-v4-flash")
    cloud_row = _provider_row(
        id=_CLOUD_ROW_ID,
        provider="experiential_cloud",
        provider_model_id="deepseek-v4-flash",
        input_micro_usd_per_million=DEEPSEEK_V4_FLASH_PRICE.input_micro_usd_per_million,
        cached_input_micro_usd_per_million=(
            DEEPSEEK_V4_FLASH_PRICE.cached_input_micro_usd_per_million
        ),
        output_micro_usd_per_million=DEEPSEEK_V4_FLASH_PRICE.output_micro_usd_per_million,
        pricing_source="openrouter:deepseek/deepseek-v4-flash@2026-08-22*0.8",
    )
    azure_row = _provider_row(
        id=_CLOUD_AZURE_ROW_ID,
        provider="azure_openai",
        provider_model_id="DeepSeek-V4-Flash",
        created_at=_NOW + timedelta(minutes=1),
    )
    house_azure = _connection_row(
        id=_HOUSE_AZURE_CONN,
        org_id=_HOUSE_ORG,
        provider="azure_openai",
        config={
            "endpoint": "https://house.openai.azure.com/",
            "api_version": "v1",
            "deployments": {"DeepSeek-V4-Flash": "DeepSeek-V4-Flash"},
        },
    )
    chain = _make_chain(
        _PUBLIC_MODEL_ID,
        (_CLOUD_AZURE_ROW_ID, _CLOUD_ROW_ID),
        digit_leading=False,
    )
    secret = "native-vllm-canary-do-not-leak"
    origin = "http://vllm.internal:8000/v1"
    build = build_gateway_catalog(
        PlatformCatalogRows(
            models=(model,),
            providers=(cloud_row, azure_row),
            waterfalls=chain,
            connections=(house_azure,),
            house_org_id=_HOUSE_ORG,
        ),
        environment={
            **_environment(),
            BASE_URL_ENV: origin,
            API_KEY_ENV: secret,
        },
    )
    assert build.authored is not None
    cloud_alias = f"mp-{_CLOUD_ROW_ID}"
    azure_alias = f"mp-{_CLOUD_AZURE_ROW_ID}"
    record = build.authored.models[cloud_alias]
    assert record.billing_source is BillingSource.HOST_MANAGED
    assert record.gateway is not None
    assert record.gateway.prices.input_micro_usd_per_million_tokens == 42_448
    assert record.gateway.prices.output_micro_usd_per_million_tokens == 84_896
    connection = build.authored.connections[record.connection]
    assert connection.provider == "openai-compatible"
    assert connection.base_url == origin
    assert connection.api_key_env == API_KEY_ENV
    plan = _plan_by_name(build, "deepseek-v4-flash")
    assert plan.target_deployment_ids == (cloud_alias, azure_alias)
    assert build.normalized is not None
    surfaces = (
        canonical_json_bytes(build.authored).decode(),
        canonical_json_bytes(build.normalized).decode(),
        json.dumps([plan.model_dump(mode="json") for plan in build.alias_plans]),
    )
    for surface in surfaces:
        assert secret not in surface


def test_experiential_cloud_keyless_origin_uses_the_placeholder_credential() -> None:
    """Cluster-internal vLLM may omit a bearer; the catalog still stores no secret."""
    from explabs.gateway.experiential_cloud import BASE_URL_ENV

    model = _model_row(slug="qwen3.8-27b")
    cloud_row = _provider_row(
        id=_CLOUD_ROW_ID,
        provider="experiential_cloud",
        provider_model_id="qwen3.8-27b",
        input_micro_usd_per_million=320_000,
        output_micro_usd_per_million=2_400_000,
    )
    build = build_gateway_catalog(
        PlatformCatalogRows(
            models=(model,),
            providers=(cloud_row,),
            waterfalls=(),
            connections=(),
        ),
        environment={BASE_URL_ENV: "http://qwen.internal:8000/v1"},
    )
    assert build.authored is not None
    alias = f"mp-{_CLOUD_ROW_ID}"
    connection = build.authored.connections[build.authored.models[alias].connection]
    assert connection.base_url == "http://qwen.internal:8000/v1"
    assert connection.api_key_env is not None
    refs = {ref.environment_name: ref for ref in build.credential_refs}
    assert refs[connection.api_key_env].kind is CredentialSourceKind.PLACEHOLDER
    credentials = {
        ref.environment_name: (
            "not-needed" if ref.kind is CredentialSourceKind.PLACEHOLDER else "unused"
        )
        for ref in build.credential_refs
    }
    assert LOCAL_PLACEHOLDER_CREDENTIAL == "not-needed"
    assert credentials[connection.api_key_env] == LOCAL_PLACEHOLDER_CREDENTIAL


class _RecordingIsolation:
    """Context-manager factory that counts scopes and survives exceptions."""

    def __init__(self) -> None:
        self.entered = 0
        self.exited = 0

    def __call__(self) -> _RecordingIsolation:
        return self

    def __enter__(self) -> None:
        self.entered += 1

    def __exit__(self, *exc_info: object) -> None:
        self.exited += 1


def test_refresh_releaser_releases_each_connection_once() -> None:
    """A probed connection resolves from the cache, never a second release."""
    calls: list[str] = []

    def release(connection_id: str) -> str:
        calls.append(connection_id)
        return f"secret-{connection_id}"

    isolation = _RecordingIsolation()
    releaser = _RefreshReleaser(release, isolation)

    assert releaser.probe("conn-a") == "secret-conn-a"
    assert releaser.resolve("conn-a") == "secret-conn-a"
    assert calls == ["conn-a"]
    # Only the probe opened a savepoint; the cache hit needed none.
    assert isolation.entered == isolation.exited == 1


def test_refresh_releaser_resolves_unprobed_connection_in_isolation() -> None:
    """A ref the probe never saw falls back to one isolated release."""
    isolation = _RecordingIsolation()
    releaser = _RefreshReleaser(lambda connection_id: f"secret-{connection_id}", isolation)

    assert releaser.resolve("conn-b") == "secret-conn-b"
    assert isolation.entered == isolation.exited == 1


def test_refresh_releaser_failed_probe_caches_nothing_and_exits_savepoint() -> None:
    """A probe failure propagates, leaves no cache entry, and closes its scope."""
    outcomes: list[object] = [RuntimeError("vault down"), "recovered"]

    def flaky(connection_id: str) -> str:
        outcome = outcomes.pop(0)
        if isinstance(outcome, RuntimeError):
            raise outcome
        return str(outcome)

    isolation = _RecordingIsolation()
    releaser = _RefreshReleaser(flaky, isolation)

    with pytest.raises(RuntimeError):
        releaser.probe("conn-a")
    assert isolation.exited == 1
    # No stale cache: the later resolve releases again instead of answering
    # empty or replaying the failure.
    assert releaser.resolve("conn-a") == "recovered"
    assert isolation.exited == 2


def test_refresh_releaser_does_not_cache_empty_probe_values() -> None:
    """An empty release is recorded as unreleasable, not cached as a secret."""
    values = iter(["", "late-secret"])
    releaser = _RefreshReleaser(lambda _connection_id: next(values), _RecordingIsolation())

    assert releaser.probe("conn-a") == ""
    assert releaser.resolve("conn-a") == "late-secret"


def test_priced_alias_metadata_renders_the_reasoning_rate() -> None:
    """The platform extension adds the reasoning rate in exp's pricing shape."""
    metadata = PricedAliasMetadata(
        input_micro_usd_per_million_tokens=2_500_000,
        output_micro_usd_per_million_tokens=10_000_000,
        reasoning_micro_usd_per_million_tokens=12_000_000,
    )
    assert metadata.extension_fields() == {
        "pricing": {
            "input_micro_usd_per_million_tokens": 2_500_000,
            "output_micro_usd_per_million_tokens": 10_000_000,
            "reasoning_micro_usd_per_million_tokens": 12_000_000,
        },
    }
    without_reasoning = PricedAliasMetadata(input_micro_usd_per_million_tokens=1)
    assert without_reasoning.extension_fields()["pricing"] == {
        "input_micro_usd_per_million_tokens": 1
    }


def test_listing_pricing_publishes_the_primary_rung_rates() -> None:
    """Every alias maps to its primary routed deployment's declared rates.

    The public fixture model is a WATERFALL (exp's own published_metadata
    stays silent for multi-deployment pools), so the platform publishes the
    primary rung — the priced openai deployment, not the unpriced anthropic
    fallback.
    """
    build = build_gateway_catalog(_fixture_rows(), environment=_environment())
    state = build_catalog_state(build, environment=_environment(), release=_release)

    pricing = listing_pricing_by_alias(state)
    public_plan = _plan_by_name(build, "gw-public-model")
    public = pricing[("gw-public-model", public_plan.revision_id)]
    assert public.extension_fields()["pricing"] == {
        "input_micro_usd_per_million_tokens": 2_500_000,
        "output_micro_usd_per_million_tokens": 10_000_000,
    }
    # The org-custom model publishes its own deployment's rates too.
    org_plan = _plan_by_name(build, "gw-org-model")
    assert ("gw-org-model", org_plan.revision_id) in pricing


def test_published_metadata_serves_pricing_through_the_resolver_seam() -> None:
    """Both /v1/models lanes read this seam and publish the same pricing.

    The native plane's listing callback and the fallback route both call
    ``routes.published_metadata``, so pricing published here reaches the
    listing regardless of which plane serves it.
    """
    build = build_gateway_catalog(_fixture_rows(), environment=_environment())
    state = build_catalog_state(build, environment=_environment(), release=_release)
    resolver = OrgAwareRouteResolver(_StaticStateProvider(state))
    plan = _plan_by_name(build, "gw-public-model")

    published = resolver.published_metadata(
        alias=plan.alias_name,
        revision_id=plan.revision_id,
        catalog_sha256=plan.catalog_sha256,
    )
    assert published is not None
    fields = published.extension_fields()
    assert fields["pricing"] == {
        "input_micro_usd_per_million_tokens": 2_500_000,
        "output_micro_usd_per_million_tokens": 10_000_000,
    }

    # The per-generation map is cached: the same state answers by identity.
    again = resolver.published_metadata(
        alias=plan.alias_name,
        revision_id=plan.revision_id,
        catalog_sha256=plan.catalog_sha256,
    )
    assert again is published

    # An alias the state does not know publishes nothing.
    assert (
        resolver.published_metadata(
            alias="never-served",
            revision_id=plan.revision_id,
            catalog_sha256=plan.catalog_sha256,
        )
        is None
    )

    # Revision-precise: another plan's revision can never read this plan's
    # price through the shared name (org authorities publish THEIR plan).
    org_plan = _plan_by_name(build, "gw-org-model")
    assert (
        resolver.published_metadata(
            alias=plan.alias_name,
            revision_id=org_plan.revision_id,
            catalog_sha256=org_plan.catalog_sha256,
        )
        is None
    )


def test_org_scoped_revision_publishes_its_own_rates() -> None:
    """An org's granted revision lists the rates its route actually bills.

    Greptile P1 on the first cut: pricing keyed by alias name alone let a
    same-named public plan shadow an org-scoped plan. Keying by
    ``(alias, revision_id)`` — the exact identity the listing lookup presents
    — makes an org authority publish its own plan's primary-rung rates.
    """
    org_row = _provider_row(
        id=_ORG_OPENAI_ROW_ID,
        model_id=_ORG_MODEL_ID,
        provider_model_id="ft:gpt-5:org-a",
        billing_source="customer_managed",
        owning_org_id=_ORG_A,
        input_micro_usd_per_million=7_000_000,
        output_micro_usd_per_million=21_000_000,
        created_at=_NOW + timedelta(minutes=2),
    )
    rows = PlatformCatalogRows(
        models=(
            _model_row(),
            _model_row(id=_ORG_MODEL_ID, slug="gw-org-model", owning_org_id=_ORG_A),
        ),
        providers=(_provider_row(), org_row),
        waterfalls=(),
        connections=(_connection_row(),),
    )
    build = build_gateway_catalog(rows, environment=_environment())
    state = build_catalog_state(build, environment=_environment(), release=_release)
    resolver = OrgAwareRouteResolver(_StaticStateProvider(state))

    org_plan = _plan_by_name(build, "gw-org-model")
    org_published = resolver.published_metadata(
        alias=org_plan.alias_name,
        revision_id=org_plan.revision_id,
        catalog_sha256=org_plan.catalog_sha256,
    )
    assert org_published is not None
    assert org_published.extension_fields()["pricing"] == {
        "input_micro_usd_per_million_tokens": 7_000_000,
        "output_micro_usd_per_million_tokens": 21_000_000,
    }

    public_plan = _plan_by_name(build, "gw-public-model")
    public_published = resolver.published_metadata(
        alias=public_plan.alias_name,
        revision_id=public_plan.revision_id,
        catalog_sha256=public_plan.catalog_sha256,
    )
    assert public_published is not None
    assert public_published.extension_fields()["pricing"] == {
        "input_micro_usd_per_million_tokens": 2_500_000,
        "output_micro_usd_per_million_tokens": 10_000_000,
    }
