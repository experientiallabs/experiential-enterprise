# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""The hookup-check route: tenancy, verdict persistence, and no key material."""

from __future__ import annotations

from typing import cast

import pytest
from fastapi.testclient import TestClient

from explabs.api.app import create_app
from explabs.api.conftest import ORG_ID, OTHER_ORG_KEY_SECRET, OUTSIDER_ID, USER_ID
from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.stores.provider_connection_store import (
    ConnectableProvider,
    ConnectionStatus,
    ProviderConnectionRecord,
    ProviderConnectionStore,
)
from explabs.db.stores.provider_snapshot_store import SnapshotSource
from explabs.providers.accounts import ProbeDetail, ProbeResult
from explabs.providers.azure_openai import DEPLOYMENT_NOT_FOUND_CODE, AzureDeploymentCheck
from explabs.providers.spend import SpendReport, SpendReportKind

SECRET = "sk-ant-api03-route-test-key"


def _connect(supabase: FakeSupabaseClient) -> str:
    """Seed one Anthropic connection for the fixture org; returns its id."""
    record = ProviderConnectionStore(supabase).upsert(
        org_id=ORG_ID,
        provider=ConnectableProvider.ANTHROPIC,
        config={},
        credential=SECRET,
    )
    return record.id


@pytest.fixture
def probe_stub(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    """Replace the live probe; records (provider, credential) per call."""
    calls: list[tuple[str, str]] = []

    def fake_probe(record: ProviderConnectionRecord, credential: str, **_: object) -> ProbeResult:
        calls.append((record.provider.value, credential))
        return ProbeResult(
            status=ConnectionStatus.INVALID,
            detail=ProbeDetail(
                provider_status=401,
                provider_code="authentication_error",
                provider_message="invalid x-api-key",
                remediation="Paste a current inference API key.",
            ),
        )

    monkeypatch.setattr("explabs.api.routes.provider_connections.probe_connection", fake_probe)
    return calls


def test_check_probes_the_released_secret_and_persists_the_verdict(
    api: TestClient, supabase: FakeSupabaseClient, probe_stub: list[tuple[str, str]]
) -> None:
    """The verdict lands on the row and comes back in the response."""
    _connect(supabase)
    response = api.post(f"/api/orgs/{ORG_ID}/provider-connections/anthropic/check")
    assert response.status_code == 200
    body = response.json()
    assert body["provider"] == "anthropic"
    assert body["status"] == "invalid"
    assert body["status_source"] == "hookup_check"
    assert body["status_detail"]["provider_code"] == "authentication_error"
    assert body["status_detail"]["remediation"] == "Paste a current inference API key."
    assert body["status_checked_at"] is not None
    # The probe received the real Vault secret, and it never left the server.
    assert probe_stub == [("anthropic", SECRET)]
    assert SECRET not in response.text

    row = supabase.tables["provider_connections"][0]
    assert row["status"] == "invalid"
    assert row["status_source"] == "hookup_check"
    assert row["status_detail"] == {
        "provider_status": 401,
        "provider_code": "authentication_error",
        "provider_message": "invalid x-api-key",
        "remediation": "Paste a current inference API key.",
        "provider_payload": None,
    }


def test_check_404s_without_a_connection(api: TestClient, probe_stub: list[object]) -> None:
    """No stored connection: nothing to check."""
    response = api.post(f"/api/orgs/{ORG_ID}/provider-connections/anthropic/check")
    assert response.status_code == 404
    assert probe_stub == []


def test_check_refuses_an_unknown_provider(api: TestClient) -> None:
    """The provider path segment is validated against the widened enum."""
    response = api.post(f"/api/orgs/{ORG_ID}/provider-connections/cohere/check")
    assert response.status_code == 400
    assert "fireworks" in response.json()["error"]
    assert "modal" in response.json()["error"]


def test_check_is_admin_only_and_hides_the_org_from_outsiders(
    api: TestClient, supabase: FakeSupabaseClient, probe_stub: list[object]
) -> None:
    """Members below admin get 403; non-members get the resource's 404."""
    _connect(supabase)
    member = api.post(
        f"/api/orgs/{ORG_ID}/provider-connections/anthropic/check",
        headers={"X-Explabs-Actor-Id": USER_ID},
    )
    assert member.status_code == 403
    outsider = api.post(
        f"/api/orgs/{ORG_ID}/provider-connections/anthropic/check",
        headers={"X-Explabs-Actor-Id": OUTSIDER_ID},
    )
    assert outsider.status_code == 404
    assert probe_stub == []


ADMIN_SECRET = "sk-ant-admin01-route-test-key"


def _seed_admin_key(supabase: FakeSupabaseClient) -> None:
    """Store the fixture org's Anthropic admin key beside the main secret."""
    supabase.rpc(
        "set_provider_connection_spend_credential",
        {"in_org_id": ORG_ID, "in_provider": "anthropic", "in_secret": ADMIN_SECRET},
    ).execute()


def test_check_probes_a_stored_admin_key_into_status_detail(
    api: TestClient,
    supabase: FakeSupabaseClient,
    probe_stub: list[tuple[str, str]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The hookup check verifies both credentials in one pass.

    The admin key's verdict rides status_detail.spend_key and never touches
    the key-level status.
    """
    _connect(supabase)
    _seed_admin_key(supabase)
    seen: list[str] = []

    def fake_spend_probe(credential: str, **_: object) -> ProbeResult:
        seen.append(credential)
        return ProbeResult(
            status=ConnectionStatus.VALID,
            detail=ProbeDetail(provider_status=200, remediation="The admin key works."),
        )

    monkeypatch.setattr(
        "explabs.providers.anthropic.probe_spend_key",
        fake_spend_probe,
    )
    response = api.post(f"/api/orgs/{ORG_ID}/provider-connections/anthropic/check")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "invalid"  # the main-key stub verdict, untouched
    spend_key = body["status_detail"]["spend_key"]
    assert spend_key["status"] == "valid"
    assert spend_key["remediation"] == "The admin key works."
    assert spend_key["checked_at"]
    # The probe received the real admin secret, and it never left the server.
    assert seen == [ADMIN_SECRET]
    assert ADMIN_SECRET not in response.text
    assert probe_stub  # the main probe still ran


def test_spend_refresh_writes_a_snapshot_and_returns_it(
    api: TestClient, supabase: FakeSupabaseClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A reported read lands in provider_account_snapshots and comes back."""
    _connect(supabase)
    _seed_admin_key(supabase)
    seen: list[str | None] = []

    def fake_spend(admin_credential: str | None, **_: object) -> SpendReport:
        seen.append(admin_credential)
        return SpendReport(
            kind=SpendReportKind.REPORTED,
            source=SnapshotSource.PROVIDER_API,
            spend_usd=335.43,
            detail={"daily_buckets": 18},
            message="Anthropic reports month-to-date cost through the admin key.",
        )

    monkeypatch.setattr("explabs.providers.anthropic.spend", fake_spend)
    response = api.post(f"/api/orgs/{ORG_ID}/provider-connections/anthropic/spend-refresh")
    assert response.status_code == 200
    body = response.json()
    assert body["kind"] == "reported"
    assert body["refreshed"] is True
    assert body["staleness_floor_seconds"] == 300
    assert body["snapshot"]["spend_usd"] == 335.43
    assert body["snapshot"]["source"] == "provider_api"
    # The adapter received the ADMIN secret (never the main key), and neither
    # secret left the server.
    assert seen == [ADMIN_SECRET]
    assert ADMIN_SECRET not in response.text
    assert SECRET not in response.text

    rows = supabase.tables["provider_account_snapshots"]
    assert len(rows) == 1
    assert rows[0]["connection_id"] == supabase.tables["provider_connections"][0]["id"]
    assert rows[0]["org_id"] == ORG_ID
    assert rows[0]["spend_usd"] == 335.43


def test_spend_refresh_honors_the_staleness_floor(
    api: TestClient, supabase: FakeSupabaseClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Inside the floor the stored reading answers; the provider is not queried."""
    _connect(supabase)
    _seed_admin_key(supabase)
    calls: list[str | None] = []

    def fake_spend(admin_credential: str | None, **_: object) -> SpendReport:
        calls.append(admin_credential)
        return SpendReport(
            kind=SpendReportKind.REPORTED,
            source=SnapshotSource.PROVIDER_API,
            spend_usd=1.0,
            message="reported",
        )

    monkeypatch.setattr("explabs.providers.anthropic.spend", fake_spend)
    first = api.post(f"/api/orgs/{ORG_ID}/provider-connections/anthropic/spend-refresh")
    assert first.json()["refreshed"] is True
    second = api.post(f"/api/orgs/{ORG_ID}/provider-connections/anthropic/spend-refresh")
    body = second.json()
    assert body["refreshed"] is False
    assert body["kind"] == "reported"
    assert body["next_refresh_at"] is not None
    assert body["snapshot"]["spend_usd"] == 1.0
    # One provider query total: the floor absorbed the second refresh.
    assert len(calls) == 1
    assert len(supabase.tables["provider_account_snapshots"]) == 1


def test_spend_refresh_without_an_admin_key_is_the_honest_empty_state(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """No admin key stored: no secret is released and the message names the fix."""
    _connect(supabase)
    response = api.post(f"/api/orgs/{ORG_ID}/provider-connections/anthropic/spend-refresh")
    assert response.status_code == 200
    body = response.json()
    assert body["kind"] == "not_reportable"
    assert body["refreshed"] is False
    assert body["snapshot"] is None
    assert "admin key" in body["message"]
    assert "release_provider_connection_spend_credential" not in supabase.executed_rpcs
    assert supabase.tables.get("provider_account_snapshots", []) == []


def test_spend_refresh_for_a_never_reportable_provider_releases_nothing(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """Gemini has nothing to query: honest state, no secret release, no row."""
    ProviderConnectionStore(supabase).upsert(
        org_id=ORG_ID,
        provider=ConnectableProvider.GEMINI,
        config={},
        credential="AIza-gemini-key-1234",
    )
    response = api.post(f"/api/orgs/{ORG_ID}/provider-connections/gemini/spend-refresh")
    assert response.status_code == 200
    body = response.json()
    assert body["kind"] == "not_reportable"
    assert "Google doesn't expose billing" in body["message"]
    assert "release_provider_connection_credential" not in supabase.executed_rpcs
    assert supabase.tables.get("provider_account_snapshots", []) == []


def test_spend_refresh_404s_without_a_connection(api: TestClient) -> None:
    """No stored connection: nothing to read."""
    response = api.post(f"/api/orgs/{ORG_ID}/provider-connections/anthropic/spend-refresh")
    assert response.status_code == 404


def test_spend_refresh_is_admin_only_and_hides_the_org_from_outsiders(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """Members below admin get 403; non-members get the resource's 404."""
    _connect(supabase)
    member = api.post(
        f"/api/orgs/{ORG_ID}/provider-connections/anthropic/spend-refresh",
        headers={"X-Explabs-Actor-Id": USER_ID},
    )
    assert member.status_code == 403
    outsider = api.post(
        f"/api/orgs/{ORG_ID}/provider-connections/anthropic/spend-refresh",
        headers={"X-Explabs-Actor-Id": OUTSIDER_ID},
    )
    assert outsider.status_code == 404


AZURE_SECRET = "azure-route-test-key"
AZURE_ENDPOINT = "https://res.openai.azure.com"


def _connect_azure(supabase: FakeSupabaseClient, deployments: dict[str, str]) -> str:
    """Seed one Azure connection for the fixture org; returns its id."""
    record = ProviderConnectionStore(supabase).upsert(
        org_id=ORG_ID,
        provider=ConnectableProvider.AZURE_OPENAI,
        config={"endpoint": AZURE_ENDPOINT, "deployments": deployments},
        credential=AZURE_SECRET,
    )
    return record.id


@pytest.fixture
def deployment_probe_stub(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    """Replace the live deployment probe; records (credential, deployment)."""
    calls: list[tuple[str, str]] = []

    def fake_probe(
        credential: str, config: object, deployment: str, **_: object
    ) -> AzureDeploymentCheck:
        calls.append((credential, deployment))
        deployed = deployment != "missing-deployment"
        return AzureDeploymentCheck(
            deployed=deployed,
            provider_status=200 if deployed else 404,
            provider_code=None if deployed else DEPLOYMENT_NOT_FOUND_CODE,
            remediation=(
                f"The deployment {deployment!r} exists on {AZURE_ENDPOINT}."
                if deployed
                else "You have a key, but this model isn't deployed: the resource has no "
                f"deployment named {deployment!r}."
            ),
        )

    monkeypatch.setattr(
        "explabs.providers.azure_openai.probe_deployment",
        fake_probe,
    )
    return calls


def _stored_model_fact(row: dict[str, object], model: str) -> dict[str, object]:
    """The persisted status_detail.models[model] fact, narrowed step by step.

    The isinstance checks are the real assertions; the casts only re-key the
    dicts as string-keyed JSON (the jsonb round-trip invariant).
    """
    detail = row["status_detail"]
    assert isinstance(detail, dict)
    models = cast("dict[str, object]", detail)["models"]
    assert isinstance(models, dict)
    fact = cast("dict[str, object]", models)[model]
    assert isinstance(fact, dict)
    return cast("dict[str, object]", fact)


def test_deployment_check_probes_and_persists_the_model_fact(
    api: TestClient, supabase: FakeSupabaseClient, deployment_probe_stub: list[tuple[str, str]]
) -> None:
    """A mapped deployment is probed and the fact lands under status_detail.models."""
    _connect_azure(supabase, {"gpt-5.5": "my-gpt-55"})
    response = api.post(
        f"/api/orgs/{ORG_ID}/provider-connections/azure_openai/deployment-check",
        json={"model": "gpt-5.5"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["provider"] == "azure_openai"
    assert body["model"] == "gpt-5.5"
    assert body["deployment"] == "my-gpt-55"
    assert body["deployed"] is True
    assert body["checked_at"]
    # The probe received the real Vault secret, and it never left the server.
    assert deployment_probe_stub == [(AZURE_SECRET, "my-gpt-55")]
    assert AZURE_SECRET not in response.text

    row = supabase.tables["provider_connections"][0]
    fact = _stored_model_fact(row, "gpt-5.5")
    assert fact["deployed"] is True
    assert fact["deployment"] == "my-gpt-55"
    assert fact["checked_at"]
    # The key-level verdict is untouched: this is a model-scoped fact.
    assert row["status"] == "unchecked"
    assert row["status_checked_at"] is None


def test_deployment_check_not_deployed_is_a_model_fact_not_a_key_status(
    api: TestClient, supabase: FakeSupabaseClient, deployment_probe_stub: list[tuple[str, str]]
) -> None:
    """DeploymentNotFound reads back as deployed=false with the canonical words."""
    _connect_azure(supabase, {"gpt-5.5": "missing-deployment"})
    response = api.post(
        f"/api/orgs/{ORG_ID}/provider-connections/azure_openai/deployment-check",
        json={"model": "gpt-5.5"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["deployed"] is False
    assert "You have a key, but this model isn't deployed" in body["detail"]["remediation"]
    row = supabase.tables["provider_connections"][0]
    assert _stored_model_fact(row, "gpt-5.5")["deployed"] is False
    assert row["status"] == "unchecked"


def test_deployment_check_maps_the_deployment_inline_then_probes(
    api: TestClient, supabase: FakeSupabaseClient, deployment_probe_stub: list[tuple[str, str]]
) -> None:
    """Passing `deployment` saves the mapping first — the least-clicks add."""
    _connect_azure(supabase, {"other-model": "other-deployment"})
    response = api.post(
        f"/api/orgs/{ORG_ID}/provider-connections/azure_openai/deployment-check",
        json={"model": "gpt-5.5", "deployment": "my-gpt-55"},
    )
    assert response.status_code == 200
    assert response.json()["deployed"] is True
    assert deployment_probe_stub == [(AZURE_SECRET, "my-gpt-55")]
    row = supabase.tables["provider_connections"][0]
    config = row["config"]
    assert isinstance(config, dict)
    # The new mapping joined the stored map without clobbering it.
    assert cast("dict[str, object]", config)["deployments"] == {
        "other-model": "other-deployment",
        "gpt-5.5": "my-gpt-55",
    }


def test_deployment_check_404s_for_an_unmapped_model(
    api: TestClient, supabase: FakeSupabaseClient, deployment_probe_stub: list[tuple[str, str]]
) -> None:
    """No mapping and no inline name: the caller is told to pass one."""
    _connect_azure(supabase, {"other-model": "other-deployment"})
    response = api.post(
        f"/api/orgs/{ORG_ID}/provider-connections/azure_openai/deployment-check",
        json={"model": "gpt-5.5"},
    )
    assert response.status_code == 404
    assert "pass `deployment`" in response.json()["error"]
    assert deployment_probe_stub == []


def test_deployment_check_refuses_non_azure_providers(
    api: TestClient, supabase: FakeSupabaseClient, deployment_probe_stub: list[tuple[str, str]]
) -> None:
    """Only Azure addresses deployments; other providers get the plain 400."""
    _connect(supabase)
    response = api.post(
        f"/api/orgs/{ORG_ID}/provider-connections/anthropic/deployment-check",
        json={"model": "claude-4.6"},
    )
    assert response.status_code == 400
    assert "azure_openai" in response.json()["error"]
    assert deployment_probe_stub == []


def test_deployment_check_is_admin_only_and_hides_the_org_from_outsiders(
    api: TestClient, supabase: FakeSupabaseClient, deployment_probe_stub: list[tuple[str, str]]
) -> None:
    """Members below admin get 403; non-members get the resource's 404."""
    _connect_azure(supabase, {"gpt-5.5": "my-gpt-55"})
    member = api.post(
        f"/api/orgs/{ORG_ID}/provider-connections/azure_openai/deployment-check",
        json={"model": "gpt-5.5"},
        headers={"X-Explabs-Actor-Id": USER_ID},
    )
    assert member.status_code == 403
    outsider = api.post(
        f"/api/orgs/{ORG_ID}/provider-connections/azure_openai/deployment-check",
        json={"model": "gpt-5.5"},
        headers={"X-Explabs-Actor-Id": OUTSIDER_ID},
    )
    assert outsider.status_code == 404
    assert deployment_probe_stub == []


# ---------------------------------------------------------------------------
# The management PUT and the org-API-key path (Contract 3).

AGENT_SECRET = "sk-ant-api03-agent-key-9999"


@pytest.fixture
def other_org_key_api(supabase: FakeSupabaseClient) -> TestClient:
    """A client authenticated with org-2's customer key (no actor header)."""
    from explabs.api.app import create_app

    return TestClient(
        create_app(client=supabase), headers={"Authorization": f"Bearer {OTHER_ORG_KEY_SECRET}"}
    )


def test_key_authed_put_and_check_round_trip(
    customer_api: TestClient,
    supabase: FakeSupabaseClient,
    probe_stub: list[tuple[str, str]],
) -> None:
    """An agent with only the org's xpl_ key connects a provider end to end."""
    response = customer_api.put(
        f"/api/orgs/{ORG_ID}/provider-connections/anthropic",
        json={"secret": AGENT_SECRET},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["connection"]["provider"] == "anthropic"
    assert body["connection"]["credential_last4"] == AGENT_SECRET[-4:]
    # No internal ids and never any key material in the public shape.
    assert "id" not in body["connection"]
    assert AGENT_SECRET not in response.text
    # The hookup check ran inside the same round-trip on the real secret.
    assert probe_stub == [("anthropic", AGENT_SECRET)]
    assert body["check"]["status"] == "invalid"
    assert body["check"]["status_source"] == "hookup_check"

    row = supabase.tables["provider_connections"][0]
    assert row["org_id"] == ORG_ID
    assert row["status"] == "invalid"

    check = customer_api.post(f"/api/orgs/{ORG_ID}/provider-connections/anthropic/check")
    assert check.status_code == 200
    assert len(probe_stub) == 2


def test_key_authed_put_stores_the_admin_key_beside_the_main_secret(
    customer_api: TestClient,
    supabase: FakeSupabaseClient,
    probe_stub: list[tuple[str, str]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """spend_secret rides the same PUT and gets its own verdict in the check."""
    from explabs.providers import anthropic
    from explabs.providers.accounts import ProbeDetail as Detail

    def fake_spend_probe(credential: str, **_: object) -> ProbeResult:
        assert credential == "sk-ant-admin01-agent-admin-key"
        return ProbeResult(
            status=ConnectionStatus.VALID, detail=Detail(remediation="The admin key works.")
        )

    monkeypatch.setattr(anthropic, "probe_spend_key", fake_spend_probe)
    response = customer_api.put(
        f"/api/orgs/{ORG_ID}/provider-connections/anthropic",
        json={"secret": AGENT_SECRET, "spend_secret": "sk-ant-admin01-agent-admin-key"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["connection"]["spend_credential_last4"] == "-key"
    assert body["check"]["status_detail"]["spend_key"]["status"] == "valid"
    assert "sk-ant-admin01" not in response.text


def test_key_authed_put_refuses_malformed_input_before_storing(
    customer_api: TestClient,
    supabase: FakeSupabaseClient,
    probe_stub: list[tuple[str, str]],
) -> None:
    """Every refusal names the problem and nothing lands in the store."""
    cases: list[tuple[str, dict[str, object], str]] = [
        # Modal takes the pair, not a string.
        ("modal", {"secret": "ak-single-string"}, "token PAIR"),
        # Non-modal providers take a string, not a pair.
        (
            "openai",
            {"secret": {"token_id": "ak-x-1234", "token_secret": "as-y-5678"}},
            "single API key",
        ),
        # An admin key in the main slot cannot do inference.
        ("anthropic", {"secret": "sk-ant-admin01-in-wrong-slot"}, "ADMIN key"),
        ("openai", {"secret": "sk-admin-in-wrong-slot"}, "ADMIN key"),
        # The admin slot exists for anthropic/openai only.
        (
            "gemini",
            {"secret": "AIzaSyRealEnough", "spend_secret": "sk-ant-admin01-x"},
            "Only Anthropic and OpenAI",
        ),
        # An inference key in the admin slot is named as the swap it is.
        (
            "anthropic",
            {"secret": AGENT_SECRET, "spend_secret": "sk-ant-api03-not-admin"},
            "disjoint",
        ),
        # Azure config must address at least one deployment.
        (
            "azure_openai",
            {
                "secret": "azure-key-0123456789",
                "config": {"endpoint": "https://my.openai.azure.com", "deployments": {}},
            },
            "somewhere to go",
        ),
        # Bedrock config is typed; a missing region is named.
        (
            "bedrock",
            {"secret": "aws-secret-0123456789", "config": {"access_key_id": "AKIAEXAMPLEEXAMPLE"}},
            "region",
        ),
        # Too-short secrets are refused with a typed 400, not the RPC's 500.
        ("openai", {"secret": "short"}, "too short"),
    ]
    for provider, payload, expected in cases:
        response = customer_api.put(
            f"/api/orgs/{ORG_ID}/provider-connections/{provider}", json=payload
        )
        assert response.status_code == 400, (provider, payload, response.text)
        assert expected in response.json()["error"], (provider, expected, response.text)
    assert supabase.tables.get("provider_connections", []) == []
    assert probe_stub == []


def test_a_foreign_orgs_key_gets_the_resource_404_on_every_route(
    other_org_key_api: TestClient,
    supabase: FakeSupabaseClient,
    probe_stub: list[tuple[str, str]],
) -> None:
    """Cross-org key calls answer the resource 404, indistinguishable from absent."""
    _connect(supabase)
    put = other_org_key_api.put(
        f"/api/orgs/{ORG_ID}/provider-connections/anthropic", json={"secret": AGENT_SECRET}
    )
    check = other_org_key_api.post(f"/api/orgs/{ORG_ID}/provider-connections/anthropic/check")
    refresh = other_org_key_api.post(
        f"/api/orgs/{ORG_ID}/provider-connections/anthropic/spend-refresh"
    )
    assert (put.status_code, check.status_code, refresh.status_code) == (404, 404, 404)
    assert probe_stub == []
    # The write never happened: org-1's row still carries its seeded secret.
    assert len(supabase.tables["provider_connections"]) == 1
    assert supabase.tables["provider_connections"][0]["credential_last4"] == SECRET[-4:]


def test_session_put_round_trip_and_role_gates_unchanged(
    api: TestClient, supabase: FakeSupabaseClient, probe_stub: list[tuple[str, str]]
) -> None:
    """The session path is untouched: admins connect, members 403, outsiders 404."""
    response = api.put(
        f"/api/orgs/{ORG_ID}/provider-connections/anthropic", json={"secret": AGENT_SECRET}
    )
    assert response.status_code == 200
    assert response.json()["check"]["status_source"] == "hookup_check"
    assert probe_stub == [("anthropic", AGENT_SECRET)]

    member = api.put(
        f"/api/orgs/{ORG_ID}/provider-connections/anthropic",
        json={"secret": AGENT_SECRET},
        headers={"X-Explabs-Actor-Id": USER_ID},
    )
    assert member.status_code == 403
    outsider = api.put(
        f"/api/orgs/{ORG_ID}/provider-connections/anthropic",
        json={"secret": AGENT_SECRET},
        headers={"X-Explabs-Actor-Id": OUTSIDER_ID},
    )
    assert outsider.status_code == 404


def test_list_returns_org_connections_without_secrets(
    customer_api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """An org key lists its connections as config + last4, never the secret."""
    _connect(supabase)
    response = customer_api.get(f"/api/orgs/{ORG_ID}/provider-connections")
    assert response.status_code == 200
    body = response.json()
    assert [row["provider"] for row in body] == ["anthropic"]
    assert set(body[0]) == {"provider", "config", "credential_last4", "spend_credential_last4"}
    assert SECRET not in response.text


def test_list_is_empty_without_connections(customer_api: TestClient) -> None:
    """No connections yields an empty list, not a 404."""
    response = customer_api.get(f"/api/orgs/{ORG_ID}/provider-connections")
    assert response.status_code == 200
    assert response.json() == []


def test_list_scopes_to_the_key_org(supabase: FakeSupabaseClient) -> None:
    """An org key reading a foreign org's connections gets the resource 404."""
    _connect(supabase)
    app = create_app(client=supabase)
    other = TestClient(app, headers={"Authorization": f"Bearer {OTHER_ORG_KEY_SECRET}"})
    assert other.get(f"/api/orgs/{ORG_ID}/provider-connections").status_code == 404


def test_list_session_member_reads_outsider_404s(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """A session member (USER strength) reads connections; an outsider 404s."""
    _connect(supabase)
    member = api.get(
        f"/api/orgs/{ORG_ID}/provider-connections", headers={"X-Explabs-Actor-Id": USER_ID}
    )
    assert member.status_code == 200
    assert [row["provider"] for row in member.json()] == ["anthropic"]
    outsider = api.get(
        f"/api/orgs/{ORG_ID}/provider-connections", headers={"X-Explabs-Actor-Id": OUTSIDER_ID}
    )
    assert outsider.status_code == 404


def test_hookup_check_emits_an_audit_event(
    api: TestClient, supabase: FakeSupabaseClient, probe_stub: list[tuple[str, str]]
) -> None:
    """A persisted hookup verdict is followed by one audit emit."""
    _connect(supabase)
    response = api.post(f"/api/orgs/{ORG_ID}/provider-connections/anthropic/check")
    assert response.status_code == 200
    assert len(probe_stub) == 1
    assert supabase.executed_rpcs.count("record_audit_event") == 1
