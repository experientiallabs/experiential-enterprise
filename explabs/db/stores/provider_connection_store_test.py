# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the org provider-key store (Vault-backed, no key material on rows)."""

from __future__ import annotations

import pytest

from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.stores.provider_connection_store import (
    AzureConnectionConfig,
    BedrockConnectionConfig,
    ConnectableProvider,
    ConnectionStatus,
    ConnectionStatusSource,
    FireworksConnectionConfig,
    ProviderConnectionStore,
)

ORG = "00000000-0000-0000-0000-000000000001"


def test_upsert_returns_no_key_material_and_rotates_in_place() -> None:
    """Upsert returns last4 only; a second upsert rotates the same row."""
    store = ProviderConnectionStore(FakeSupabaseClient())
    record = store.upsert(
        org_id=ORG,
        provider=ConnectableProvider.ANTHROPIC,
        config={},
        credential="sk-ant-secret-1234",
    )
    assert record.provider is ConnectableProvider.ANTHROPIC
    assert record.credential_last4 == "1234"
    assert "sk-ant" not in record.model_dump_json()

    rotated = store.upsert(
        org_id=ORG,
        provider=ConnectableProvider.ANTHROPIC,
        config={},
        credential="sk-ant-secret-5678",
    )
    assert rotated.id == record.id
    assert rotated.credential_last4 == "5678"


def test_release_credential_decrypts_what_upsert_stored() -> None:
    """The release RPC is the only read path for key material."""
    client = FakeSupabaseClient()
    store = ProviderConnectionStore(client)
    record = store.upsert(
        org_id=ORG,
        provider=ConnectableProvider.OPENAI,
        config={},
        credential="sk-openai-abcd",
    )
    assert store.release_credential(record.id) == "sk-openai-abcd"


def test_list_and_find_are_org_scoped() -> None:
    """Connections never leak across orgs."""
    client = FakeSupabaseClient()
    store = ProviderConnectionStore(client)
    store.upsert(
        org_id=ORG, provider=ConnectableProvider.OPENAI, config={}, credential="sk-test-aaaaaaaa"
    )
    other_org = "00000000-0000-0000-0000-000000000002"
    store.upsert(
        org_id=other_org,
        provider=ConnectableProvider.ANTHROPIC,
        config={},
        credential="sk-test-bbbbbbbb",
    )
    assert [record.provider for record in store.list_for_org(ORG)] == [ConnectableProvider.OPENAI]
    assert store.find(ORG, ConnectableProvider.ANTHROPIC) is None
    assert store.find(other_org, ConnectableProvider.ANTHROPIC) is not None


def test_delete_drops_the_row_and_reports_missing_honestly() -> None:
    """Disconnect removes the row; a second delete reports False, not success."""
    client = FakeSupabaseClient()
    store = ProviderConnectionStore(client)
    store.upsert(
        org_id=ORG, provider=ConnectableProvider.OPENAI, config={}, credential="sk-test-aaaaaaaa"
    )
    assert store.delete(ORG, ConnectableProvider.OPENAI) is True
    assert store.find(ORG, ConnectableProvider.OPENAI) is None
    assert store.delete(ORG, ConnectableProvider.OPENAI) is False


def test_azure_config_is_typed_and_forbids_extras() -> None:
    """Azure's non-secret half validates at the boundary, not deep in serving."""
    config = AzureConnectionConfig.model_validate(
        {"endpoint": "https://my.openai.azure.com", "deployments": {"gpt-5.5": "my-gpt55"}}
    )
    assert config.deployments["gpt-5.5"] == "my-gpt55"
    with pytest.raises(ValueError, match="api_key"):
        AzureConnectionConfig.model_validate(
            {"endpoint": "https://x", "api_key": "sk-should-not-be-here"}
        )


def test_azure_endpoint_must_be_a_public_https_url() -> None:
    """The api container must not be steerable at internal or plaintext targets."""
    for endpoint in (
        "http://internal.example.com",
        "https://localhost:8443",
        "https://10.0.0.5",
        "https://169.254.169.254/latest",
        "https://host.docker.internal:11434",
        "https://localhost./",
        "https://LOCALHOST.:8443/x",
    ):
        with pytest.raises(ValueError, match="public https"):
            AzureConnectionConfig.model_validate({"endpoint": endpoint})
    valid = AzureConnectionConfig.model_validate({"endpoint": "https://org.openai.azure.com"})
    assert valid.endpoint == "https://org.openai.azure.com"


def test_config_ids_and_names_are_whitespace_trimmed_at_the_boundary() -> None:
    """Padded ids/names that ride provider URLs and AWS auth normalize on save.

    The web form trims client-side; an org-API-key caller does not, so the
    typed boundary must trim for every caller before persisting.
    """
    fireworks = FireworksConnectionConfig.model_validate({"account_id": "  my-account  "})
    assert fireworks.account_id == "my-account"
    bedrock = BedrockConnectionConfig.model_validate(
        {"region": " us-east-1 ", "access_key_id": "  AKIAEXAMPLEEXAMPLE  "}
    )
    assert bedrock.region == "us-east-1"
    assert bedrock.access_key_id == "AKIAEXAMPLEEXAMPLE"
    azure = AzureConnectionConfig.model_validate(
        {"endpoint": " https://org.openai.azure.com ", "deployments": {" gpt-5.5 ": " my-gpt55 "}}
    )
    assert azure.endpoint == "https://org.openai.azure.com"
    assert azure.deployments == {"gpt-5.5": "my-gpt55"}


def test_key_changes_bump_every_org_endpoint_revision() -> None:
    """Rotation and disconnect must reach cached serving runtimes now, not at restart."""
    client = FakeSupabaseClient()
    client.tables["endpoints"] = [
        {"id": "ep-1", "org_id": ORG, "updated_at": "original"},
        {"id": "ep-2", "org_id": "other-org", "updated_at": "original"},
    ]
    store = ProviderConnectionStore(client)
    store.upsert(
        org_id=ORG, provider=ConnectableProvider.ANTHROPIC, config={}, credential="sk-test-11111111"
    )
    assert client.tables["endpoints"][0]["updated_at"] != "original"
    assert client.tables["endpoints"][1]["updated_at"] == "original"

    stamp = client.tables["endpoints"][0]["updated_at"]
    store.delete(ORG, ConnectableProvider.ANTHROPIC)
    assert client.tables["endpoints"][0]["updated_at"] != stamp


def test_a_short_secret_is_refused_before_it_reaches_last4() -> None:
    """credential_last4 is member-readable; a short secret would land in it whole."""
    store = ProviderConnectionStore(FakeSupabaseClient())
    with pytest.raises(Exception, match="too short"):
        store.upsert(org_id=ORG, provider=ConnectableProvider.OPENAI, config={}, credential="tiny")


def test_a_fresh_connection_is_unchecked_until_its_hookup_check() -> None:
    """The status columns start honest: never probed, no stale verdict."""
    store = ProviderConnectionStore(FakeSupabaseClient())
    record = store.upsert(
        org_id=ORG, provider=ConnectableProvider.OPENAI, config={}, credential="sk-test-aaaaaaaa"
    )
    found = store.find(ORG, ConnectableProvider.OPENAI)
    assert found is not None
    assert found.status is ConnectionStatus.UNCHECKED
    assert found.status_detail is None
    assert found.status_checked_at is None
    assert found.status_source is None
    assert record.status is ConnectionStatus.UNCHECKED


def test_record_status_persists_the_verdict_and_rotation_resets_it() -> None:
    """A verdict lands on the row; the next rotation must not inherit it."""
    client = FakeSupabaseClient()
    store = ProviderConnectionStore(client)
    record = store.upsert(
        org_id=ORG, provider=ConnectableProvider.OPENAI, config={}, credential="sk-test-aaaaaaaa"
    )
    updated = store.record_status(
        record.id,
        status=ConnectionStatus.INVALID,
        detail={"provider_code": "invalid_api_key", "remediation": "paste a current key"},
        source=ConnectionStatusSource.HOOKUP_CHECK,
    )
    assert updated.status is ConnectionStatus.INVALID
    assert updated.status_source is ConnectionStatusSource.HOOKUP_CHECK
    assert updated.status_checked_at is not None
    assert updated.status_detail == {
        "provider_code": "invalid_api_key",
        "remediation": "paste a current key",
    }

    rotated = store.upsert(
        org_id=ORG, provider=ConnectableProvider.OPENAI, config={}, credential="sk-test-bbbbbbbb"
    )
    assert rotated.id == record.id
    found = store.find(ORG, ConnectableProvider.OPENAI)
    assert found is not None
    assert found.status is ConnectionStatus.UNCHECKED
    assert found.status_detail is None


def test_record_status_fence_drops_a_verdict_for_a_rotated_out_credential() -> None:
    """A stale probe must not stamp its verdict over a freshly rotated key."""
    client = FakeSupabaseClient()
    store = ProviderConnectionStore(client)
    original = store.upsert(
        org_id=ORG, provider=ConnectableProvider.OPENAI, config={}, credential="sk-test-aaaaaaaa"
    )
    assert original.credential_last4 == "aaaa"
    # The key is rotated (new last4, status reset to unchecked) while the
    # previous credential's probe is still in flight.
    rotated = store.upsert(
        org_id=ORG, provider=ConnectableProvider.OPENAI, config={}, credential="sk-test-bbbbbbbb"
    )
    assert rotated.credential_last4 == "bbbb"

    # The in-flight probe of the old credential now tries to persist its verdict.
    fenced = store.record_status(
        original.id,
        status=ConnectionStatus.INVALID,
        detail={"provider_code": "invalid_api_key"},
        source=ConnectionStatusSource.HOOKUP_CHECK,
        for_credential_last4=original.credential_last4,
    )
    # The fence drops the stale write; the rotated key keeps its unchecked state.
    assert fenced.status is ConnectionStatus.UNCHECKED
    assert fenced.credential_last4 == "bbbb"
    found = store.find(ORG, ConnectableProvider.OPENAI)
    assert found is not None
    assert found.status is ConnectionStatus.UNCHECKED


def test_record_status_fails_loudly_for_a_missing_connection() -> None:
    """A verdict for a row that no longer exists is a bug, not a no-op."""
    store = ProviderConnectionStore(FakeSupabaseClient())
    with pytest.raises(ValueError, match="not found"):
        store.record_status(
            "missing-connection",
            status=ConnectionStatus.VALID,
            detail=None,
            source=ConnectionStatusSource.TRAFFIC,
        )


def test_fireworks_and_modal_are_connectable_with_typed_fireworks_config() -> None:
    """The widened provider set round-trips; Fireworks' config is typed."""
    client = FakeSupabaseClient()
    store = ProviderConnectionStore(client)
    fireworks = store.upsert(
        org_id=ORG,
        provider=ConnectableProvider.FIREWORKS,
        config={"account_id": "my-account"},
        credential="fw_test_key_1234",
    )
    assert fireworks.fireworks_config() == FireworksConnectionConfig(account_id="my-account")
    modal = store.upsert(
        org_id=ORG,
        provider=ConnectableProvider.MODAL,
        config={},
        credential='{"token_id": "ak-x", "token_secret": "as-y"}',
    )
    assert store.release_credential(modal.id) == '{"token_id": "ak-x", "token_secret": "as-y"}'
    with pytest.raises(ValueError, match="account_id"):
        FireworksConnectionConfig.model_validate({"account_id": ""})


def test_update_config_replaces_config_without_touching_the_credential() -> None:
    """A config-only write (the Azure deployment map) keeps the stored key."""
    client = FakeSupabaseClient()
    store = ProviderConnectionStore(client)
    record = store.upsert(
        org_id=ORG,
        provider=ConnectableProvider.AZURE_OPENAI,
        config={"endpoint": "https://res.openai.azure.com", "deployments": {"a": "dep-a"}},
        credential="azure-key-9876",
    )
    updated = store.update_config(
        record.id,
        {"endpoint": "https://res.openai.azure.com", "deployments": {"a": "dep-a", "b": "dep-b"}},
    )
    assert updated.id == record.id
    assert updated.azure_config().deployments == {"a": "dep-a", "b": "dep-b"}
    assert updated.credential_last4 == "9876"
    assert store.release_credential(record.id) == "azure-key-9876"
    with pytest.raises(ValueError, match="not found"):
        store.update_config("missing-id", {"endpoint": "https://res.openai.azure.com"})


def test_record_model_fact_merges_and_leaves_key_status_alone() -> None:
    """Model facts accumulate under status_detail.models; status columns stay."""
    client = FakeSupabaseClient()
    store = ProviderConnectionStore(client)
    record = store.upsert(
        org_id=ORG,
        provider=ConnectableProvider.AZURE_OPENAI,
        config={"endpoint": "https://res.openai.azure.com", "deployments": {"m1": "d1"}},
        credential="azure-key-9876",
    )
    record = store.record_status(
        record.id,
        status=ConnectionStatus.VALID,
        detail={"remediation": "The Azure OpenAI key works against this resource endpoint."},
        source=ConnectionStatusSource.HOOKUP_CHECK,
    )
    first = store.record_model_fact(
        record, model="m1", fact={"deployment": "d1", "deployed": False}
    )
    both = store.record_model_fact(first, model="m2", fact={"deployment": "d2", "deployed": True})
    detail = both.status_detail
    assert detail is not None
    assert detail["models"] == {
        "m1": {"deployment": "d1", "deployed": False},
        "m2": {"deployment": "d2", "deployed": True},
    }
    # The key-level verdict the hookup check wrote is untouched.
    assert detail["remediation"] == "The Azure OpenAI key works against this resource endpoint."
    assert both.status is ConnectionStatus.VALID
    assert both.status_source is ConnectionStatusSource.HOOKUP_CHECK


def test_list_all_spans_orgs_for_the_scheduled_fetch() -> None:
    """list_all returns every org's connections, unlike the org-scoped list."""
    client = FakeSupabaseClient()
    store = ProviderConnectionStore(client)
    store.upsert(
        org_id=ORG, provider=ConnectableProvider.OPENROUTER, config={}, credential="or-key-abcdef"
    )
    store.upsert(
        org_id="00000000-0000-0000-0000-000000000002",
        provider=ConnectableProvider.OPENAI,
        config={},
        credential="sk-openai-abcd",
    )
    providers = {record.provider for record in store.list_all()}
    assert providers == {ConnectableProvider.OPENROUTER, ConnectableProvider.OPENAI}
