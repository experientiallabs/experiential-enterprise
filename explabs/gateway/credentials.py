# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Gateway provider credential resolution into an in-memory mapping.

Plaintext credentials exist only in worker process memory. Platform-funded
(``host_managed``) providers read their keys from the worker environment; BYOK
(``customer_managed``) keys leave Supabase Vault through the existing
``release_provider_connection_credential`` RPC and land in a plain ``dict``
handed to Experiential's ``RuntimeModelCatalog``. Nothing in this module writes a
table, a log line, or a catalog document; catalog documents carry only the
synthesized environment NAMES produced here, never values.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable, Mapping
from enum import StrEnum
from typing import Protocol

import psycopg
from pydantic import BaseModel, ConfigDict


class GatewayCredentialError(ValueError):
    """A gateway credential source is missing or failed to release a value."""


# Worker-environment FALLBACK for the platform-funded lane, used in local and
# preview runs where Vault is empty. In production the canonical source is the
# house org's `provider_connections` rows (see `catalog.HOUSE_ORG_SLUG`),
# released through the same Vault RPC as BYOK keys — one secret mechanism.
PLATFORM_PROVIDER_CREDENTIAL_ENVS: Mapping[str, str] = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "gemini": "GEMINI_API_KEY",
    "fireworks": "FIREWORKS_API_KEY",
    "modal": "MODAL_API_KEY",
    "experiential_cloud": "EXPLABS_EXPERIENTIAL_CLOUD_API_KEY",
}

# Experiential's openai-compatible client requires a key value even for keyless local
# servers; mirrors the Project serving pool's convention.
LOCAL_PLACEHOLDER_CREDENTIAL = "not-needed"

# Bedrock resolves its region (never key material) through the same mapping;
# credentials ride the ambient AWS chain via boto.
_AWS_PASSTHROUGH_ENVIRONMENT_NAMES = ("AWS_REGION", "AWS_DEFAULT_REGION")


def byok_credential_environment_name(selector: str) -> str:
    """Return the deterministic environment name a BYOK credential binds to.

    The name is a pure function of the connection identity (not its rotation
    revision) so credential rotation changes only the mapping VALUE, keeping
    the secret-free catalog documents and their content digest stable.

    Args:
        selector: Stable credential identity, normally a
            ``provider_connections.id``.

    Returns:
        A catalog-safe environment variable name that reveals nothing.
    """
    digest = hashlib.sha256(
        f"gateway-byok\x1f{selector}".encode(), usedforsecurity=False
    ).hexdigest()
    return f"EXPLABS_GATEWAY_KEY_{digest[:24].upper()}"


class CredentialSourceKind(StrEnum):
    """Where one catalog environment name gets its value from."""

    PLATFORM_ENV = "platform_env"
    BYOK_VAULT = "byok_vault"
    PLACEHOLDER = "placeholder"


class ConnectionCredentialRef(BaseModel):
    """Secret-free pointer from a catalog environment name to its source.

    ``selector`` is the worker environment variable for ``platform_env``, the
    ``provider_connections.id`` for ``byok_vault``, and empty for
    ``placeholder`` (keyless customer-run OpenAI-compatible servers).
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    environment_name: str
    kind: CredentialSourceKind
    selector: str = ""


class CredentialReleaser(Protocol):
    """Release one BYOK credential value by provider connection id."""

    def __call__(self, connection_id: str, /) -> str:
        """Return the plaintext credential for one connection id."""
        ...


def release_connection_credential(
    connection: psycopg.Connection[tuple[object, ...]],
    connection_id: str,
) -> str:
    """Release one BYOK credential through the sanctioned Vault RPC.

    Args:
        connection: Direct Postgres connection (service authority).
        connection_id: ``provider_connections.id`` to decrypt.

    Returns:
        The plaintext credential value.

    Raises:
        GatewayCredentialError: The RPC returned no usable value.
    """
    row = connection.execute(
        "select credential from public.release_provider_connection_credential(%s::uuid)",
        (connection_id,),
    ).fetchone()
    value = row[0] if row is not None else None
    if not isinstance(value, str) or not value:
        raise GatewayCredentialError(
            f"provider connection {connection_id} released no credential value"
        )
    return value


def resolve_gateway_credentials(
    refs: Iterable[ConnectionCredentialRef],
    *,
    environment: Mapping[str, str],
    release: CredentialReleaser,
) -> dict[str, str]:
    """Materialize every catalog credential reference into an in-memory mapping.

    Args:
        refs: Secret-free references collected by the catalog builder.
        environment: Worker environment (platform-funded provider keys and the
            optional AWS region passthrough for Bedrock).
        release: BYOK Vault releaser, normally
            :func:`release_connection_credential` bound to a connection.

    Returns:
        Environment-name-to-credential mapping for ``RuntimeModelCatalog``.

    Raises:
        GatewayCredentialError: A platform environment variable is unset or a
            BYOK release failed; the message names the source, never a value.
    """
    resolved: dict[str, str] = {}
    for name in _AWS_PASSTHROUGH_ENVIRONMENT_NAMES:
        value = environment.get(name)
        if value:
            resolved[name] = value
    for ref in refs:
        match ref.kind:
            case CredentialSourceKind.PLATFORM_ENV:
                resolved[ref.environment_name] = _platform_credential(ref, environment)
            case CredentialSourceKind.BYOK_VAULT:
                resolved[ref.environment_name] = _byok_credential(ref, release)
            case CredentialSourceKind.PLACEHOLDER:
                resolved[ref.environment_name] = LOCAL_PLACEHOLDER_CREDENTIAL
    return resolved


def _platform_credential(ref: ConnectionCredentialRef, environment: Mapping[str, str]) -> str:
    """Read one platform provider key or fail naming its environment variable."""
    value = environment.get(ref.selector, "")
    if not value:
        message = f"platform provider credential environment variable {ref.selector} is not set"
        raise GatewayCredentialError(message)
    return value


def _byok_credential(ref: ConnectionCredentialRef, release: CredentialReleaser) -> str:
    """Release one BYOK key or fail naming only the connection id."""
    try:
        released = release(ref.selector)
    except GatewayCredentialError:
        raise
    except Exception as exc:
        message = f"provider connection {ref.selector} credential release failed"
        raise GatewayCredentialError(message) from exc
    if not released:
        message = f"provider connection {ref.selector} released an empty credential"
        raise GatewayCredentialError(message)
    return released
