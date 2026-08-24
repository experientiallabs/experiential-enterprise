# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Org model-provider credentials (BYOK): typed access to ``provider_connections``.

An org connects its own OpenAI / Anthropic / Azure OpenAI account; that org's
endpoints then serve those providers' models through the org's key. The
credential enters through the ``upsert_provider_connection`` RPC and leaves
only through ``release_provider_connection_credential`` at call time, so this
store never sees or returns key material outside those two seams. Azure's
non-secret half (resource endpoint + deployment names) rides the row's
``config``; OpenAI and Anthropic need nothing beside the key.
"""

from __future__ import annotations

import ipaddress
from datetime import UTC, datetime
from enum import StrEnum
from typing import cast
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator

from explabs.db.repositories import JsonObject, SupabaseClient, first_row, result_rows


class ConnectableProvider(StrEnum):
    """The providers an org can bring its own key for."""

    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    AZURE_OPENAI = "azure_openai"
    OPENROUTER = "openrouter"
    GEMINI = "gemini"
    BEDROCK = "bedrock"
    FIREWORKS = "fireworks"
    MODAL = "modal"


class ConnectionStatus(StrEnum):
    """Provider-verified key state, written by the hookup check and by traffic.

    A KEY-level verdict only. "Model not deployed" (the canonical Azure case)
    is deliberately not a member: the key stays ``VALID`` and the per-model
    fact rides ``status_detail.models``.
    """

    UNCHECKED = "unchecked"
    VALID = "valid"
    # The provider rejected the credential itself.
    INVALID = "invalid"
    RATE_LIMITED = "rate_limited"
    QUOTA_EXHAUSTED = "quota_exhausted"
    # The provider was unreachable or 5xx when we checked — our check failed,
    # not their key.
    PROVIDER_ERROR = "provider_error"


class ConnectionStatusSource(StrEnum):
    """Which path wrote the status; there is no manual recheck by design."""

    HOOKUP_CHECK = "hookup_check"
    TRAFFIC = "traffic"


def _stripped(value: object) -> object:
    """Trim surrounding whitespace on string inputs.

    These non-secret ids and names (account id, access-key id, deployment
    names, endpoint) ride provider URLs and AWS authentication, so a
    whitespace-padded value from any caller must normalize the same way the
    web form's ``.trim()`` does before it is validated and persisted.
    """
    return value.strip() if isinstance(value, str) else value


class AzureConnectionConfig(BaseModel):
    """Azure OpenAI's non-secret half: a key alone cannot address a resource.

    ``deployments`` maps the catalog's canonical model type to the deployment
    name the customer created for it (deployment names are operator-chosen and
    cannot be derived); a model type absent from the map is not serveable
    through this connection.
    """

    model_config = ConfigDict(extra="forbid")

    endpoint: str = Field(min_length=1)
    # WMO's exact contract for the Azure api_version; enforcing it here fails
    # a bad value at Settings save instead of inside a funded run.
    api_version: str | None = Field(
        default=None, pattern=r"^(?:v1|\d{4}-\d{2}-\d{2}(?:-preview)?)$"
    )
    deployments: dict[str, str] = Field(default_factory=dict)

    @field_validator("endpoint", "api_version", mode="before")
    @classmethod
    def _strip_scalars(cls, value: object) -> object:
        return _stripped(value)

    @field_validator("deployments", mode="before")
    @classmethod
    def _strip_deployments(cls, value: object) -> object:
        """Deployment names are operator-chosen and ride the provider URL."""
        if isinstance(value, dict):
            return {_stripped(key): _stripped(deployment) for key, deployment in value.items()}
        return value

    @field_validator("endpoint")
    @classmethod
    def _public_https_endpoint(cls, value: str) -> str:
        """Azure resources are public https origins; anything else is refused.

        Only the ORG'S OWN key ever rides to this endpoint (never a platform
        secret), but the api container must still not be steerable at internal
        or plaintext targets through a stored connection.
        """
        parts = urlsplit(value)
        host = parts.hostname
        if parts.scheme != "https" or not host:
            msg = "the Azure endpoint must be a public https URL"
            raise ValueError(msg)
        # rstrip(".") canonicalizes FQDN spellings: "localhost." is localhost.
        lowered = host.lower().rstrip(".")
        private = lowered in {"localhost", "host.docker.internal"} or lowered.endswith(".local")
        if not private:
            try:
                private = not ipaddress.ip_address(lowered).is_global
            except ValueError:
                private = False
        if private:
            msg = "the Azure endpoint must be a public https URL, not an internal host"
            raise ValueError(msg)
        return value


class BedrockConnectionConfig(BaseModel):
    """Bedrock's non-secret half: the region and access-key identifier.

    The AWS secret access key is the Vault credential; the access key id is an
    identifier (it appears in AWS consoles and signatures) and rides the row's
    non-secret config beside the region the runtime must call.
    """

    model_config = ConfigDict(extra="forbid")

    region: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$")
    access_key_id: str = Field(min_length=16, max_length=128)

    @field_validator("region", "access_key_id", mode="before")
    @classmethod
    def _strip_scalars(cls, value: object) -> object:
        return _stripped(value)


class FireworksConnectionConfig(BaseModel):
    """Fireworks' non-secret half: the account id billing reads address.

    The account id cannot be discovered from the key, so it is collected at
    hookup and rides the row's config for the spend adapters.
    """

    model_config = ConfigDict(extra="forbid")

    account_id: str = Field(min_length=1, max_length=128)

    @field_validator("account_id", mode="before")
    @classmethod
    def _strip_scalars(cls, value: object) -> object:
        return _stripped(value)


# Columns every connection read returns; status columns included so callers
# render the verified state without a second query.
_CONNECTION_COLUMNS = (
    "id, org_id, provider, config, credential_last4, spend_credential_last4, "
    "status, status_detail, status_checked_at, status_source"
)


class ProviderConnectionRecord(BaseModel):
    """Typed snapshot of a ``provider_connections`` row (no credential material)."""

    model_config = ConfigDict(frozen=True)

    id: str
    org_id: str
    provider: ConnectableProvider
    config: JsonObject
    credential_last4: str | None = None
    # The optional second credential (the provider ADMIN key, spend-reporting
    # only); non-null last4 means one is stored in Vault.
    spend_credential_last4: str | None = None
    status: ConnectionStatus = ConnectionStatus.UNCHECKED
    status_detail: JsonObject | None = None
    status_checked_at: str | None = None
    status_source: ConnectionStatusSource | None = None

    def azure_config(self) -> AzureConnectionConfig:
        """The row's config as Azure's typed shape (raises for a malformed row)."""
        return AzureConnectionConfig.model_validate(self.config)

    def bedrock_config(self) -> BedrockConnectionConfig:
        """The row's config as Bedrock's typed shape (raises for a malformed row)."""
        return BedrockConnectionConfig.model_validate(self.config)

    def fireworks_config(self) -> FireworksConnectionConfig:
        """The row's config as Fireworks' typed shape (raises for a malformed row)."""
        return FireworksConnectionConfig.model_validate(self.config)


class ProviderConnectionStore:
    """Persist and release org provider credentials (Vault-backed)."""

    def __init__(self, client: SupabaseClient) -> None:
        """Initialize the store.

        Args:
            client: Supabase client.
        """
        self._client = client

    def upsert(
        self,
        *,
        org_id: str,
        provider: ConnectableProvider,
        config: JsonObject,
        credential: str,
        actor: str | None = None,
    ) -> ProviderConnectionRecord:
        """Create or rotate the org's credential for one provider.

        Args:
            org_id: Owning organization identifier.
            provider: Which provider account the key belongs to.
            config: Non-secret provider config (Azure endpoint + deployments).
            credential: The API key; goes straight to Vault.
            actor: Acting user id for audit columns.

        Returns:
            The connection record (credential excluded by construction).
        """
        result = self._client.rpc(
            "upsert_provider_connection",
            {
                "in_org_id": org_id,
                "in_provider": provider.value,
                "in_config": config,
                "in_secret": credential,
                "in_actor": actor,
            },
        ).execute()
        row = first_row(result, context=f"upsert_provider_connection for org {org_id}")
        return ProviderConnectionRecord.model_validate(row)

    def list_for_org(self, org_id: str) -> list[ProviderConnectionRecord]:
        """Every provider the org has connected, for the checklist and settings."""
        result = (
            self._client.table("provider_connections")
            .select(_CONNECTION_COLUMNS)
            .eq("org_id", org_id)
            .execute()
        )
        return [ProviderConnectionRecord.model_validate(row) for row in result_rows(result)]

    def list_all(self) -> list[ProviderConnectionRecord]:
        """Every provider connection across all orgs, for the scheduled fetch."""
        result = self._client.table("provider_connections").select(_CONNECTION_COLUMNS).execute()
        return [ProviderConnectionRecord.model_validate(row) for row in result_rows(result)]

    def find(self, org_id: str, provider: ConnectableProvider) -> ProviderConnectionRecord | None:
        """The org's connection for one provider, when one exists."""
        result = (
            self._client.table("provider_connections")
            .select(_CONNECTION_COLUMNS)
            .eq("org_id", org_id)
            .eq("provider", provider.value)
            .execute()
        )
        rows = result_rows(result)
        if not rows:
            return None
        return ProviderConnectionRecord.model_validate(rows[0])

    def record_status(
        self,
        connection_id: str,
        *,
        status: ConnectionStatus,
        detail: JsonObject | None,
        source: ConnectionStatusSource,
        for_credential_last4: str | None = None,
    ) -> ProviderConnectionRecord:
        """Persist one verified status verdict onto the connection row.

        Args:
            connection_id: The connection the verdict is about.
            status: The key-level verdict.
            detail: Verbose provider error capture (raw code, raw message,
                remediation text); ``None`` clears a stale one.
            source: Whether the hookup check or real traffic produced it.
            for_credential_last4: The ``credential_last4`` of the credential
                this verdict was produced against. When given, the write is
                fenced to that credential: if the key was rotated while the
                probe was in flight (a new ``credential_last4``, status reset
                to ``unchecked``), the stale verdict is dropped and the current
                row returned unchanged, so a replaced key never wears the old
                key's health.

        Returns:
            The updated connection record, or the current row when a fenced
            write was skipped because the credential had been rotated.

        Raises:
            ValueError: If the connection row does not exist.
        """
        update = (
            self._client.table("provider_connections")
            .update(
                {
                    "status": status.value,
                    "status_detail": detail,
                    "status_checked_at": datetime.now(tz=UTC).isoformat(),
                    "status_source": source.value,
                }
            )
            .eq("id", connection_id)
        )
        if for_credential_last4 is not None:
            update = update.eq("credential_last4", for_credential_last4)
        result = update.execute()
        rows = result_rows(result)
        if not rows:
            if for_credential_last4 is not None:
                # The fence rejected the write: the credential was rotated out
                # from under this probe. The fresh key's own hookup check owns
                # the verdict now, so leave the row and report its live state.
                current = self._find_by_id(connection_id)
                if current is not None:
                    return current
            msg = f"provider connection not found: {connection_id}"
            raise ValueError(msg)
        return ProviderConnectionRecord.model_validate(rows[0])

    def update_config(self, connection_id: str, config: JsonObject) -> ProviderConnectionRecord:
        """Replace one connection's non-secret config, credential untouched.

        The model page's least-clicks Azure path maps a new deployment name
        onto an existing connection; rotating the whole credential through
        ``upsert`` just to grow the deployment map would demand re-pasting a
        key the customer already stored. Callers validate the config against
        the provider's typed shape before writing.

        Args:
            connection_id: The connection whose config is replaced.
            config: The full replacement config (not a partial patch).

        Returns:
            The updated connection record.

        Raises:
            ValueError: If the connection row does not exist.
        """
        result = (
            self._client.table("provider_connections")
            .update({"config": config})
            .eq("id", connection_id)
            .execute()
        )
        rows = result_rows(result)
        if not rows:
            msg = f"provider connection not found: {connection_id}"
            raise ValueError(msg)
        return ProviderConnectionRecord.model_validate(rows[0])

    def record_model_fact(
        self,
        record: ProviderConnectionRecord,
        *,
        model: str,
        fact: JsonObject,
    ) -> ProviderConnectionRecord:
        """Persist one (connection x model) fact under ``status_detail.models``.

        "Model not deployed" is deliberately not a key status (the key stays
        ``VALID``), so this write merges into ``status_detail.models`` and
        leaves the key-level status, source, and checked-at columns untouched.

        Args:
            record: The connection the fact is about (carries the current
                ``status_detail`` the fact merges into).
            model: The catalog model slug the fact is scoped to.
            fact: The model-scoped verdict (deployment name, deployed flag,
                checked-at, remediation text).

        Returns:
            The updated connection record.

        Raises:
            ValueError: If the connection row does not exist.
        """
        detail: JsonObject = dict(record.status_detail or {})
        stored = detail.get("models")
        # The narrow JSON-boundary cast: a dict under a JsonObject value is
        # itself string-keyed JSON (Postgres jsonb round-trip invariant).
        models: JsonObject = dict(cast("JsonObject", stored)) if isinstance(stored, dict) else {}
        models[model] = fact
        detail["models"] = models
        result = (
            self._client.table("provider_connections")
            .update({"status_detail": detail})
            .eq("id", record.id)
            .execute()
        )
        rows = result_rows(result)
        if not rows:
            msg = f"provider connection not found: {record.id}"
            raise ValueError(msg)
        return ProviderConnectionRecord.model_validate(rows[0])

    def _find_by_id(self, connection_id: str) -> ProviderConnectionRecord | None:
        """The connection row by id, when it still exists."""
        result = (
            self._client.table("provider_connections")
            .select(_CONNECTION_COLUMNS)
            .eq("id", connection_id)
            .execute()
        )
        rows = result_rows(result)
        if not rows:
            return None
        return ProviderConnectionRecord.model_validate(rows[0])

    def release_credential(self, connection_id: str) -> str:
        """Decrypt one connection's key for a serving call (stamps last_used_at)."""
        result = self._client.rpc(
            "release_provider_connection_credential",
            {"in_connection_id": connection_id},
        ).execute()
        row = first_row(
            result, context=f"release credential for provider connection {connection_id}"
        )
        credential = row.get("credential")
        if isinstance(credential, str) and credential:
            return credential
        msg = f"provider connection credential release returned no value: {connection_id}"
        raise ValueError(msg)

    def set_spend_credential(
        self,
        *,
        org_id: str,
        provider: ConnectableProvider,
        credential: str,
        actor: str | None = None,
    ) -> str:
        """Store or rotate the connection's optional admin key (spend reads only).

        Args:
            org_id: Owning organization identifier.
            provider: The connection the admin key rides (must already exist).
            credential: The provider ADMIN key; goes straight to Vault.
            actor: Acting identity for audit columns.

        Returns:
            The stored key's last four characters (the only readable trace).
        """
        result = self._client.rpc(
            "set_provider_connection_spend_credential",
            {
                "in_org_id": org_id,
                "in_provider": provider.value,
                "in_secret": credential,
                "in_actor": actor,
            },
        ).execute()
        row = first_row(
            result, context=f"set spend credential for org {org_id} provider {provider.value}"
        )
        last4 = row.get("spend_credential_last4")
        if isinstance(last4, str) and last4:
            return last4
        msg = f"spend credential write returned no last4 for org {org_id} {provider.value}"
        raise ValueError(msg)

    def release_spend_credential(self, connection_id: str) -> str:
        """Decrypt one connection's admin key for a spend read.

        Deliberately does not stamp ``last_used_at``: that column means
        serving traffic, and a spend refresh is a management-plane read.
        """
        result = self._client.rpc(
            "release_provider_connection_spend_credential",
            {"in_connection_id": connection_id},
        ).execute()
        row = first_row(
            result, context=f"release spend credential for provider connection {connection_id}"
        )
        credential = row.get("credential")
        if isinstance(credential, str) and credential:
            return credential
        msg = f"provider connection spend credential release returned no value: {connection_id}"
        raise ValueError(msg)

    def delete(self, org_id: str, provider: ConnectableProvider) -> bool:
        """Disconnect one provider (drops the row and its Vault secret)."""
        result = self._client.rpc(
            "delete_provider_connection",
            {"in_org_id": org_id, "in_provider": provider.value},
        ).execute()
        rows = result_rows(result)
        if not rows:
            return False
        value = rows[0]
        if isinstance(value, dict):
            return bool(next(iter(value.values()), False))
        return bool(value)
