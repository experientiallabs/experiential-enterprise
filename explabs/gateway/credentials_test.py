# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Unit tests for gateway credential reference resolution."""

from __future__ import annotations

import os
import re
import uuid
from collections.abc import Callable

import psycopg
import pytest

from explabs.gateway.credentials import (
    LOCAL_PLACEHOLDER_CREDENTIAL,
    ConnectionCredentialRef,
    CredentialSourceKind,
    GatewayCredentialError,
    byok_credential_environment_name,
    resolve_gateway_credentials,
)


def _static_release(value: str) -> Callable[[str], str]:
    """Return a releaser that ignores its connection id."""

    def release(connection_id: str) -> str:
        del connection_id
        return value

    return release


def test_byok_environment_name_is_deterministic_and_value_free() -> None:
    """The synthesized env name is stable, well-formed, and reveals nothing."""
    connection_id = "3f0f7d2a-1111-4222-8333-944444444444"
    first = byok_credential_environment_name(connection_id)
    assert first == byok_credential_environment_name(connection_id)
    assert re.fullmatch(r"EXPLABS_GATEWAY_KEY_[0-9A-F]{24}", first)
    assert first != byok_credential_environment_name("other")


def test_resolves_every_source_kind() -> None:
    """Platform env, BYOK vault, and placeholder refs all materialize."""
    byok_name = byok_credential_environment_name("conn-1")
    refs = (
        ConnectionCredentialRef(
            environment_name="OPENAI_API_KEY",
            kind=CredentialSourceKind.PLATFORM_ENV,
            selector="OPENAI_API_KEY",
        ),
        ConnectionCredentialRef(
            environment_name=byok_name,
            kind=CredentialSourceKind.BYOK_VAULT,
            selector="conn-1",
        ),
        ConnectionCredentialRef(
            environment_name="EXPLABS_GATEWAY_KEY_LOCAL",
            kind=CredentialSourceKind.PLACEHOLDER,
        ),
    )
    released: list[str] = []

    def release(connection_id: str) -> str:
        released.append(connection_id)
        return f"byok-secret-{connection_id}"

    resolved = resolve_gateway_credentials(
        refs,
        environment={"OPENAI_API_KEY": "platform-secret", "AWS_REGION": "us-east-1"},
        release=release,
    )
    assert resolved["OPENAI_API_KEY"] == "platform-secret"
    assert resolved[byok_name] == "byok-secret-conn-1"
    assert resolved["EXPLABS_GATEWAY_KEY_LOCAL"] == LOCAL_PLACEHOLDER_CREDENTIAL
    assert resolved["AWS_REGION"] == "us-east-1"
    assert released == ["conn-1"]


def test_missing_platform_environment_variable_fails_by_name() -> None:
    """The error names the environment variable, never any value."""
    refs = (
        ConnectionCredentialRef(
            environment_name="ANTHROPIC_API_KEY",
            kind=CredentialSourceKind.PLATFORM_ENV,
            selector="ANTHROPIC_API_KEY",
        ),
    )
    with pytest.raises(GatewayCredentialError, match="ANTHROPIC_API_KEY"):
        resolve_gateway_credentials(refs, environment={}, release=_static_release("unused"))


def test_byok_release_failure_wraps_without_value() -> None:
    """A releaser crash surfaces as a typed error naming the connection id."""
    refs = (
        ConnectionCredentialRef(
            environment_name=byok_credential_environment_name("conn-9"),
            kind=CredentialSourceKind.BYOK_VAULT,
            selector="conn-9",
        ),
    )

    def release(connection_id: str) -> str:
        message = "vault down"
        raise RuntimeError(message)

    with pytest.raises(GatewayCredentialError, match="conn-9"):
        resolve_gateway_credentials(refs, environment={}, release=release)


def test_empty_byok_release_is_rejected() -> None:
    """An empty released credential is a typed error, not a silent blank key."""
    refs = (
        ConnectionCredentialRef(
            environment_name=byok_credential_environment_name("conn-2"),
            kind=CredentialSourceKind.BYOK_VAULT,
            selector="conn-2",
        ),
    )
    with pytest.raises(GatewayCredentialError, match="conn-2"):
        resolve_gateway_credentials(refs, environment={}, release=_static_release(""))


@pytest.mark.integration
def test_release_rpc_never_blocks_on_a_sibling_row_lock() -> None:
    """A sibling's row lock must not stall (or deadlock) a credential release.

    Regression for the concurrent cold-boot crash (40P01): two workers'
    catalog refreshes each stamp ``last_used_at`` through
    ``release_provider_connection_credential``, and the plain UPDATE queued
    every caller on the sibling's row lock — Postgres intermittently resolved
    that queue as a deadlock and the losing worker exited during startup. The
    stamp is best-effort now (``FOR UPDATE SKIP LOCKED``): under a held row
    lock the RPC must return the credential within the statement timeout
    instead of waiting the sibling out.
    """
    url = os.environ.get("SUPABASE_DB_URL", "").strip()
    if not url:
        pytest.skip("SUPABASE_DB_URL is required for integration tests")
    secret = f"vf-release-canary-{uuid.uuid4().hex}"
    org_id = str(uuid.uuid4())
    setup = psycopg.connect(url, autocommit=True)
    try:
        setup.execute(
            "insert into public.organizations (id, slug, name)"
            " values (%s, %s, 'credential release lock test')",
            (org_id, f"vf-rel-{org_id[:8]}"),
        )
        setup.execute(
            "select * from public.upsert_provider_connection(%s, 'openai', '{}'::jsonb, %s)",
            (org_id, secret),
        )
        row = setup.execute(
            "select id from public.provider_connections where org_id = %s", (org_id,)
        ).fetchone()
        assert row is not None
        connection_id = str(row[0])
        with psycopg.connect(url) as holder, psycopg.connect(url) as releaser:
            holder.execute(
                "select id from public.provider_connections where id = %s for update",
                (connection_id,),
            )
            with releaser.transaction():
                # The old UPDATE queued here until `holder` finished; 2s is
                # orders of magnitude above an uncontended release round trip.
                releaser.execute("set local statement_timeout = '2000ms'")
                released = releaser.execute(
                    "select credential from"
                    " public.release_provider_connection_credential(%s::uuid)",
                    (connection_id,),
                ).fetchone()
            holder.rollback()
        assert released is not None
        assert released[0] == secret
    finally:
        # Vault secret first (the org cascade drops the connection row but
        # not its secret), then a plain org delete so the FK cascades also
        # remove the trigger-created children (credit ledger, identity rows).
        setup.execute("select public.delete_provider_connection(%s, 'openai')", (org_id,))
        setup.execute("delete from public.organizations where id = %s", (org_id,))
        setup.close()
