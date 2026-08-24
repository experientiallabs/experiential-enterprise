# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for typed org-secret management."""

from __future__ import annotations

from dataclasses import dataclass
from typing import cast

import pytest
from pydantic import ValidationError

from explabs.db.repositories import JsonObject, JsonPayload, SupabaseClient
from explabs.secrets import (
    ENV_VAR_BY_SECRET_NAME,
    REQUIRED_SECRET_NAMES,
    OrgSecretManager,
    OrgSecretName,
    OrgSecretRecord,
    OrgSecrets,
    missing_required_secrets,
)


@dataclass(frozen=True)
class _FakeResult:
    """Fake Supabase RPC result."""

    data: list[JsonObject]


class _FakeQuery:
    """Fake Supabase RPC query."""

    def __init__(self, data: list[JsonObject]) -> None:
        """Initialize the fake query."""
        self._data = data

    def execute(self) -> _FakeResult:
        """Return configured data."""
        return _FakeResult(self._data)


class _FakeClient:
    """Fake Supabase client that records RPC calls."""

    def __init__(self) -> None:
        """Initialize fake RPC rows."""
        self.calls: list[tuple[str, JsonPayload | None]] = []

    def rpc(self, fn: str, params: JsonPayload | None = None) -> _FakeQuery:
        """Return fake RPC responses."""
        self.calls.append((fn, params))
        if fn == "list_org_secrets":
            return _FakeQuery(
                [
                    {"name": "anthropic_api_key", "value": "sk-ant-org"},
                    {"name": "aws_region", "value": "us-west-2"},
                ]
            )
        if fn == "upsert_org_secret":
            secret_name = str(params["in_name"]) if params is not None else "anthropic_api_key"
            return _FakeQuery(
                [
                    {
                        "id": "secret-1",
                        "org_id": "org-1",
                        "name": secret_name,
                        "last4": "cret",
                        "metadata": {"source_env": "TEST"},
                    }
                ]
            )
        return _FakeQuery([])


def test_org_secrets_parses_decrypted_rows() -> None:
    """Decrypted rows are validated into a typed secret bundle."""
    secrets = OrgSecrets.from_records(
        org_id="org-1",
        records=[
            {"name": "anthropic_api_key", "value": "sk-ant-key"},
            {"name": "azure_openai_endpoint", "value": "https://azure.example"},
            {"name": "openai_api_key", "value": "sk-openai-key"},
        ],
    )

    assert secrets.org_id == "org-1"
    assert secrets.value(OrgSecretName.ANTHROPIC_API_KEY) == "sk-ant-key"
    assert secrets.value(OrgSecretName.AZURE_OPENAI_ENDPOINT) == "https://azure.example"
    assert secrets.value(OrgSecretName.OPENAI_API_KEY) == "sk-openai-key"
    assert secrets.value(OrgSecretName.AWS_REGION) is None
    assert secrets.model_dump(mode="json") == {"org_id": "org-1"}
    assert "sk-ant-key" not in repr(secrets)
    assert "https://azure.example" not in repr(secrets)
    assert "sk-openai-key" not in repr(secrets)


def test_org_secret_record_excludes_decrypted_value_from_dumps() -> None:
    """Plaintext RPC row values do not leak through Pydantic dumps."""
    record = OrgSecretRecord.model_validate({"name": "openai_api_key", "value": "sk-record-secret"})

    assert record.value.get_secret_value() == "sk-record-secret"
    assert record.model_dump(mode="json") == {"name": OrgSecretName.OPENAI_API_KEY}
    assert "sk-record-secret" not in repr(record)


def test_org_secrets_rejects_unknown_secret_name() -> None:
    """Unknown secret names fail at the typed boundary."""
    with pytest.raises(ValidationError):
        OrgSecrets.from_records(
            org_id="org-1",
            records=[{"name": "gemini_api_key", "value": "value"}],
        )


def test_org_secret_manager_loads_and_upserts() -> None:
    """The manager calls the typed Supabase RPCs."""
    client = _FakeClient()
    # The manager exercises only the RPC boundary; the fake intentionally omits table/storage.
    manager = OrgSecretManager(cast("SupabaseClient", client))

    secrets = manager.load_org_secrets("org-1")
    metadata = manager.upsert_secret(
        org_id="org-1",
        name=OrgSecretName.ANTHROPIC_API_KEY,
        value="new-secret",
        updated_by="test",
        metadata={"source_env": "TEST"},
    )

    assert secrets.value(OrgSecretName.ANTHROPIC_API_KEY) == "sk-ant-org"
    assert secrets.value(OrgSecretName.AWS_REGION) == "us-west-2"
    assert metadata.name == OrgSecretName.ANTHROPIC_API_KEY
    assert metadata.last4 == "cret"
    assert client.calls == [
        ("list_org_secrets", {"in_org_id": "org-1"}),
        (
            "upsert_org_secret",
            {
                "in_org_id": "org-1",
                "in_name": "anthropic_api_key",
                "in_secret": "new-secret",
                "in_updated_by": "test",
                "in_metadata": {"source_env": "TEST"},
            },
        ),
    ]


def test_env_var_mapping_is_total_over_secret_names() -> None:
    """Every whitelisted secret name maps to its standard provider env var."""
    assert set(ENV_VAR_BY_SECRET_NAME) == set(OrgSecretName)
    assert ENV_VAR_BY_SECRET_NAME == {
        OrgSecretName.ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
        OrgSecretName.OPENAI_API_KEY: "OPENAI_API_KEY",
        OrgSecretName.AWS_ACCESS_KEY_ID: "AWS_ACCESS_KEY_ID",
        OrgSecretName.AWS_SECRET_ACCESS_KEY: "AWS_SECRET_ACCESS_KEY",
        OrgSecretName.AWS_REGION: "AWS_REGION",
        OrgSecretName.AZURE_OPENAI_API_KEY: "AZURE_OPENAI_API_KEY",
        OrgSecretName.AZURE_OPENAI_ENDPOINT: "AZURE_OPENAI_ENDPOINT",
    }


def test_no_secret_is_hard_required_platform_wide() -> None:
    """Tenants pick their providers, so the platform hard-requires no secret."""
    assert len(REQUIRED_SECRET_NAMES) == 0
    assert missing_required_secrets(()) == ()
    assert missing_required_secrets({OrgSecretName.ANTHROPIC_API_KEY}) == ()
