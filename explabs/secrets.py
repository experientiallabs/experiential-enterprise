# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Typed org-secret management backed by Supabase Vault."""

from __future__ import annotations

from collections.abc import Collection, Mapping, Sequence
from datetime import datetime
from enum import StrEnum
from typing import assert_never

from pydantic import BaseModel, ConfigDict, Field, SecretStr

from explabs.db.repositories import (
    SupabaseClient,
    first_row,
)


class OrgSecretName(StrEnum):
    """Stable names for per-organization LLM-provider secrets."""

    ANTHROPIC_API_KEY = "anthropic_api_key"
    OPENAI_API_KEY = "openai_api_key"
    AWS_ACCESS_KEY_ID = "aws_access_key_id"
    AWS_SECRET_ACCESS_KEY = "aws_secret_access_key"
    AWS_REGION = "aws_region"
    AZURE_OPENAI_API_KEY = "azure_openai_api_key"
    AZURE_OPENAI_ENDPOINT = "azure_openai_endpoint"


# Environment variable each whitelisted org secret is provisioned from.
# Provider credentials keep their standard names so the world-model harness can
# consume them as-is. Total over the enum.
ENV_VAR_BY_SECRET_NAME: Mapping[OrgSecretName, str] = {
    OrgSecretName.ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
    OrgSecretName.OPENAI_API_KEY: "OPENAI_API_KEY",
    OrgSecretName.AWS_ACCESS_KEY_ID: "AWS_ACCESS_KEY_ID",
    OrgSecretName.AWS_SECRET_ACCESS_KEY: "AWS_SECRET_ACCESS_KEY",
    OrgSecretName.AWS_REGION: "AWS_REGION",
    OrgSecretName.AZURE_OPENAI_API_KEY: "AZURE_OPENAI_API_KEY",
    OrgSecretName.AZURE_OPENAI_ENDPOINT: "AZURE_OPENAI_ENDPOINT",
}

# No secret is hard-required platform-wide: a tenant configures whichever LLM
# providers it uses, and the harness fails loudly at run time when the selected
# provider's credentials are absent.
REQUIRED_SECRET_NAMES: frozenset[OrgSecretName] = frozenset()


def missing_required_secrets(
    present: Collection[OrgSecretName],
) -> tuple[OrgSecretName, ...]:
    """Return the hard-required secret names absent from a present set.

    Args:
        present: Secret names that currently resolve (from env or the store).

    Returns:
        Required names missing from ``present``, in enum definition order.
    """
    present_set = frozenset(present)
    return tuple(
        name for name in OrgSecretName if name in REQUIRED_SECRET_NAMES and name not in present_set
    )


class OrgSecretRecord(BaseModel):
    """One plaintext secret row returned by the service-role RPC boundary."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    name: OrgSecretName
    value: SecretStr = Field(exclude=True, repr=False)


class OrgSecretMetadata(BaseModel):
    """Non-secret org-secret metadata."""

    model_config = ConfigDict(extra="ignore", frozen=True)

    id: str
    org_id: str
    name: OrgSecretName
    last4: str | None = None
    created_by: str | None = None
    updated_by: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    rotated_at: datetime | None = None
    last_used_at: datetime | None = None
    revoked_at: datetime | None = None
    revoked_reason: str | None = None
    metadata: dict[str, object] = Field(default_factory=dict)


class OrgSecrets(BaseModel):
    """Typed secret bundle for one tenant organization.

    Attributes:
        org_id: Supabase organization row ID that owns the secret bundle.
        anthropic_api_key: Anthropic API key for this tenant's model calls.
        openai_api_key: OpenAI API key for this tenant's model calls.
        aws_access_key_id: AWS access key ID for Bedrock-backed model calls.
        aws_secret_access_key: AWS secret access key for Bedrock-backed model calls.
        aws_region: AWS region for Bedrock-backed model calls.
        azure_openai_api_key: Azure OpenAI API key for this tenant's model calls.
        azure_openai_endpoint: Azure OpenAI endpoint for this tenant's model calls.
    """

    model_config = ConfigDict(frozen=True)

    org_id: str
    anthropic_api_key: SecretStr | None = Field(default=None, exclude=True, repr=False)
    openai_api_key: SecretStr | None = Field(default=None, exclude=True, repr=False)
    aws_access_key_id: SecretStr | None = Field(default=None, exclude=True, repr=False)
    aws_secret_access_key: SecretStr | None = Field(default=None, exclude=True, repr=False)
    aws_region: SecretStr | None = Field(default=None, exclude=True, repr=False)
    azure_openai_api_key: SecretStr | None = Field(default=None, exclude=True, repr=False)
    azure_openai_endpoint: SecretStr | None = Field(default=None, exclude=True, repr=False)

    @classmethod
    def from_records(
        cls,
        *,
        org_id: str,
        records: Sequence[Mapping[str, object]],
    ) -> OrgSecrets:
        """Build a typed secret bundle from decrypted Supabase rows.

        Args:
            org_id: Organization identifier owning the rows.
            records: Rows returned by ``list_org_secrets``.

        Returns:
            Typed org secret bundle.
        """
        values: dict[OrgSecretName, str] = {}
        for record in records:
            parsed = OrgSecretRecord.model_validate(record)
            values[parsed.name] = parsed.value.get_secret_value()

        return cls(
            org_id=org_id,
            anthropic_api_key=_secret(values.get(OrgSecretName.ANTHROPIC_API_KEY)),
            openai_api_key=_secret(values.get(OrgSecretName.OPENAI_API_KEY)),
            aws_access_key_id=_secret(values.get(OrgSecretName.AWS_ACCESS_KEY_ID)),
            aws_secret_access_key=_secret(values.get(OrgSecretName.AWS_SECRET_ACCESS_KEY)),
            aws_region=_secret(values.get(OrgSecretName.AWS_REGION)),
            azure_openai_api_key=_secret(values.get(OrgSecretName.AZURE_OPENAI_API_KEY)),
            azure_openai_endpoint=_secret(values.get(OrgSecretName.AZURE_OPENAI_ENDPOINT)),
        )

    def value(self, name: OrgSecretName) -> str | None:
        """Return one plaintext secret value by typed name.

        Args:
            name: Stable secret name.

        Returns:
            Plaintext value, if present.
        """
        match name:
            case OrgSecretName.ANTHROPIC_API_KEY:
                secret = self.anthropic_api_key
            case OrgSecretName.OPENAI_API_KEY:
                secret = self.openai_api_key
            case OrgSecretName.AWS_ACCESS_KEY_ID:
                secret = self.aws_access_key_id
            case OrgSecretName.AWS_SECRET_ACCESS_KEY:
                secret = self.aws_secret_access_key
            case OrgSecretName.AWS_REGION:
                secret = self.aws_region
            case OrgSecretName.AZURE_OPENAI_API_KEY:
                secret = self.azure_openai_api_key
            case OrgSecretName.AZURE_OPENAI_ENDPOINT:
                secret = self.azure_openai_endpoint
            case _:
                assert_never(name)
        return _plain(secret)


class OrgSecretManager:
    """Service-role Supabase manager for org secret bundles."""

    def __init__(self, client: SupabaseClient) -> None:
        """Initialize the manager.

        Args:
            client: Service-role Supabase client.
        """
        self._client = client

    def load_org_secrets(self, org_id: str) -> OrgSecrets:
        """Load decrypted secrets for one organization.

        Args:
            org_id: Supabase organization row ID.

        Returns:
            Typed org secret bundle. Missing secrets are represented as ``None``.
        """
        result = self._client.rpc(
            "list_org_secrets",
            {"in_org_id": org_id},
        ).execute()
        return OrgSecrets.from_records(org_id=org_id, records=result.data)

    def upsert_secret(
        self,
        *,
        org_id: str,
        name: OrgSecretName,
        value: str,
        updated_by: str = "python",
        metadata: Mapping[str, object] | None = None,
    ) -> OrgSecretMetadata:
        """Create or rotate one org secret.

        Args:
            org_id: Supabase organization row ID.
            name: Stable secret name.
            value: Plaintext value to encrypt in Supabase Vault.
            updated_by: Actor recorded in metadata.
            metadata: Optional non-secret metadata.

        Returns:
            Updated non-secret metadata row.
        """
        result = self._client.rpc(
            "upsert_org_secret",
            {
                "in_org_id": org_id,
                "in_name": name.value,
                "in_secret": value,
                "in_updated_by": updated_by,
                "in_metadata": dict(metadata or {}),
            },
        ).execute()
        return OrgSecretMetadata.model_validate(first_row(result, context="upsert secret"))


def _secret(value: str | None) -> SecretStr | None:
    """Wrap a plaintext value in ``SecretStr``."""
    if value is None:
        return None
    return SecretStr(value)


def _plain(value: SecretStr | None) -> str | None:
    """Return a plaintext value from ``SecretStr``."""
    if value is None:
        return None
    return value.get_secret_value()
