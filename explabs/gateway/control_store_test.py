# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for native ``xpl_`` key authority and stored deny-by-default grants."""

from __future__ import annotations

import hashlib
import threading
import time
import uuid as uuid_module
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

import psycopg
import pytest
from exp.common.core.artifacts import sha256_json
from exp.runtime.gateway.contracts import (
    DirectTarget,
    GatewayApiSurface,
    GatewayMessage,
    GatewayRequest,
)
from exp.runtime.gateway.sqlite.store import (
    AliasNotGrantedError,
    GatewayStoreError,
    InvalidVirtualKeyError,
)
from psycopg import Cursor
from psycopg.rows import TupleRow

from explabs.gateway.conftest import GatewayHarness
from explabs.gateway.control_store import (
    LastUsedThrottle,
    PostgresGatewayControlStore,
    api_key_artifact_id,
    api_key_uuid,
    caller_operation_sha256,
    organization_artifact_id,
    organization_uuid,
)
from explabs.gateway.db import GatewayDatabase

_ORG_UUID = "3f2e4567-e89b-4d3a-8f2e-123456789abc"
_KEY_UUID = "1e2e4567-e89b-4d3a-8f2e-123456789abc"


def _request(
    content: str,
    *,
    idempotency_key: str | None = None,
    client_request_id: str | None = None,
) -> GatewayRequest:
    """Build one bounded request whose content is never persisted."""
    return GatewayRequest(
        surface=GatewayApiSurface.CHAT_COMPLETIONS,
        messages=(GatewayMessage(role="user", content=content),),
        maximum_output_tokens=16,
        idempotency_key=idempotency_key,
        client_request_id=client_request_id,
    )


def test_identity_mapping_round_trips_and_rejects_foreign_shapes() -> None:
    """Prefixed uuid identifiers survive the Experiential ArtifactId pattern both ways."""
    organization_id = organization_artifact_id(_ORG_UUID)
    virtual_key_id = api_key_artifact_id(_KEY_UUID)
    assert organization_id == f"org-{_ORG_UUID}"
    assert virtual_key_id == f"key-{_KEY_UUID}"
    assert str(organization_uuid(organization_id)) == _ORG_UUID
    assert str(api_key_uuid(virtual_key_id)) == _KEY_UUID
    with pytest.raises(GatewayStoreError, match="foreign shape"):
        organization_uuid(virtual_key_id)
    with pytest.raises(GatewayStoreError, match="foreign shape"):
        api_key_uuid("key-not-a-uuid")
    with pytest.raises(GatewayStoreError, match="not a uuid"):
        organization_artifact_id("wmo-org")


def test_caller_operation_digest_matches_wmo_namespace_and_rejects_conflicts() -> None:
    """The opted-in operation digest is namespaced and header-coherent."""
    assert caller_operation_sha256(_request("plain")) is None
    keyed = caller_operation_sha256(_request("keyed", idempotency_key="op-1"))
    expected = hashlib.sha256(b"gateway-caller-operation-v1\0op-1").hexdigest()
    assert keyed == expected
    both = caller_operation_sha256(
        _request("keyed", idempotency_key="op-1", client_request_id="op-1")
    )
    assert both == expected
    with pytest.raises(GatewayStoreError, match="must match"):
        caller_operation_sha256(_request("keyed", idempotency_key="op-1", client_request_id="op-2"))


def test_last_used_throttle_admits_one_write_per_interval_per_key() -> None:
    """The hot-row write gate opens at most once per interval per key."""
    throttle = LastUsedThrottle(interval_seconds=60)
    assert throttle.due("key-a", monotonic=0.0)
    assert not throttle.due("key-a", monotonic=59.0)
    assert throttle.due("key-b", monotonic=59.0)
    assert throttle.due("key-a", monotonic=60.0)


@pytest.mark.integration
def test_authentication_is_uniform_across_unknown_revoked_and_expired_keys(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """Every invalid credential fails with one oracle-free message."""
    store = PostgresGatewayControlStore(gateway_db)
    org_id = gateway_harness.seed_org()
    active = gateway_harness.seed_key(org_id)
    revoked = gateway_harness.seed_key(org_id, revoked=True)
    expired = gateway_harness.seed_key(org_id, expires_at=datetime.now(UTC) - timedelta(minutes=1))

    store.authenticate_key(raw_key=active.raw_key)
    assert store.authenticated_identity(raw_key=active.raw_key) == (
        organization_artifact_id(org_id),
        f"org-{org_id}",
    )
    for raw_key in ("", "xpl_unknown", revoked.raw_key, expired.raw_key):
        with pytest.raises(InvalidVirtualKeyError, match="virtual key is invalid"):
            store.authenticate_key(raw_key=raw_key)


@pytest.mark.integration
def test_authorize_request_freezes_public_alias_authority(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """The snapshot binds mechanical identity, revision, digest, and target."""
    store = PostgresGatewayControlStore(gateway_db)
    org_id = gateway_harness.seed_org()
    key = gateway_harness.seed_key(org_id)
    alias = gateway_harness.activate_alias()
    request = _request("authorize me")

    snapshot = store.authorize_request(
        raw_key=key.raw_key,
        alias=alias.alias_name,
        request=request,
        deadline_monotonic=time.monotonic() + 30,
    )

    assert snapshot.organization_id == f"org-{org_id}"
    assert snapshot.identity_id == f"org-{org_id}"
    assert snapshot.virtual_key_id == f"key-{key.api_key_id}"
    assert snapshot.alias == alias.alias_name
    assert snapshot.alias_revision_id == alias.revision_id
    assert snapshot.catalog_sha256 == alias.catalog_sha256
    assert snapshot.canonical_request_sha256 == sha256_json(request)
    assert snapshot.target == DirectTarget(pool_id=alias.pool_id)
    assert snapshot.surface is GatewayApiSurface.CHAT_COMPLETIONS
    assert snapshot.refusal_failover is False
    assert snapshot.caller_operation_sha256 is None

    with pytest.raises(GatewayStoreError, match="deadline has already expired"):
        store.authorize_request(
            raw_key=key.raw_key,
            alias=alias.alias_name,
            request=request,
            deadline_monotonic=time.monotonic() - 1,
        )


@pytest.mark.integration
def test_granted_active_own_and_public_aliases_resolve_others_do_not(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """Granted, active, own/public aliases resolve; foreign and inactive do not.

    At cutover the harness grants each new alias to the default identity of the
    orgs the pre-cutover rule predicate made it usable for, so the resolved set
    equals the old rule set even though the read path now joins gateway_grants.
    """
    store = PostgresGatewayControlStore(gateway_db)
    org_id = gateway_harness.seed_org()
    other_org_id = gateway_harness.seed_org()
    key = gateway_harness.seed_key(org_id)
    public_alias = gateway_harness.activate_alias()
    own_alias = gateway_harness.activate_alias(org_id=org_id)
    foreign_alias = gateway_harness.activate_alias(org_id=other_org_id)
    inactive_alias = gateway_harness.activate_alias()
    gateway_harness.deactivate_alias(inactive_alias.alias_id)

    request = _request("grants")
    deadline = time.monotonic() + 30
    for alias_name in (public_alias.alias_name, own_alias.alias_name):
        snapshot = store.authorize_request(
            raw_key=key.raw_key, alias=alias_name, request=request, deadline_monotonic=deadline
        )
        assert snapshot.alias == alias_name
    for alias_name in (
        foreign_alias.alias_name,
        inactive_alias.alias_name,
        "gwm-never-activated",
        "NOT-an-artifact-id",
    ):
        with pytest.raises(AliasNotGrantedError, match="not granted"):
            store.authorize_request(
                raw_key=key.raw_key,
                alias=alias_name,
                request=request,
                deadline_monotonic=deadline,
            )

    granted = store.granted_aliases(raw_key=key.raw_key)
    assert public_alias.alias_name in granted
    assert own_alias.alias_name in granted
    assert foreign_alias.alias_name not in granted
    assert inactive_alias.alias_name not in granted
    assert granted == tuple(sorted(granted))


@pytest.mark.integration
def test_last_used_at_writes_are_throttled(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """Back-to-back authentications write the usage timestamp once."""
    store = PostgresGatewayControlStore(gateway_db)
    org_id = gateway_harness.seed_org()
    key = gateway_harness.seed_key(org_id)

    store.authenticate_key(raw_key=key.raw_key)
    first = gateway_harness.fetch_one(
        "select last_used_at from public.api_keys where id = %s", (key.api_key_id,)
    )
    assert first is not None
    assert first[0] is not None
    store.authenticate_key(raw_key=key.raw_key)
    second = gateway_harness.fetch_one(
        "select last_used_at from public.api_keys where id = %s", (key.api_key_id,)
    )
    assert second == first


@pytest.mark.integration
def test_authorization_serializes_with_concurrent_key_revocation(
    gateway_harness: GatewayHarness,
    gateway_db: GatewayDatabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A completed revocation cannot be followed by stale authority issuance.

    Ported from Experiential's SQLite store suite: the authority read holds the key row
    ``FOR SHARE``, so a concurrent revocation commits strictly after the
    in-flight snapshot and strictly before any later one.
    """
    store = PostgresGatewayControlStore(gateway_db)
    org_id = gateway_harness.seed_org()
    key = gateway_harness.seed_key(org_id)
    alias = gateway_harness.activate_alias()
    authenticated = threading.Event()
    release_authorization = threading.Event()
    original = store._authenticate_in_transaction  # noqa: SLF001 - pause seam injection

    def pause_after_authentication(cursor: Cursor[TupleRow], candidate_key: str) -> object:
        """Pause after the credential read while retaining the authority transaction."""
        authority = original(cursor, candidate_key)
        authenticated.set()
        assert release_authorization.wait(timeout=10)
        return authority

    monkeypatch.setattr(store, "_authenticate_in_transaction", pause_after_authentication)
    with ThreadPoolExecutor(max_workers=2) as executor:
        authorization = executor.submit(
            store.authorize_request,
            raw_key=key.raw_key,
            alias=alias.alias_name,
            request=_request("serialize"),
            deadline_monotonic=time.monotonic() + 30,
        )
        assert authenticated.wait(timeout=10)
        revocation = executor.submit(
            gateway_harness.connection.execute,
            "update public.api_keys set revoked_at = now() where id = %s",
            (key.api_key_id,),
        )
        time.sleep(0.3)
        assert not revocation.done()
        release_authorization.set()
        snapshot = authorization.result(timeout=10)
        assert snapshot.virtual_key_id == f"key-{key.api_key_id}"
        revocation.result(timeout=10)

    monkeypatch.setattr(store, "_authenticate_in_transaction", original)
    # Within the authority-reuse window this store may still issue authority
    # from its pre-revocation snapshot; what makes the revocation BINDING is
    # the reserve-time SQL backstop — the accepted request path re-checks the
    # key row and refuses with 42501, so the customer-visible contract (a
    # revoked key cannot start work) holds end to end.
    warm = store.authorize_request(
        raw_key=key.raw_key,
        alias=alias.alias_name,
        request=_request("serialize-warm"),
        deadline_monotonic=time.monotonic() + 30,
    )
    assert warm.virtual_key_id == f"key-{key.api_key_id}"
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        gateway_harness.connection.execute(
            "select public.gateway_accept_request(%s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (
                f"e2e-revoked-{uuid_module.uuid4().hex[:12]}",
                org_id,
                key.api_key_id,
                alias.alias_name,
                alias.revision_id,
                "chat_completions",
                "0" * 64,
                None,
                datetime.now(tz=UTC) + timedelta(hours=1),
            ),
        )
    # A store with a cold reuse window (any other worker, or this one after
    # the TTL) refuses outright.
    cold_store = PostgresGatewayControlStore(gateway_db)
    with pytest.raises(InvalidVirtualKeyError, match="invalid"):
        cold_store.authorize_request(
            raw_key=key.raw_key,
            alias=alias.alias_name,
            request=_request("serialize"),
            deadline_monotonic=time.monotonic() + 30,
        )


@pytest.mark.integration
def test_org_custom_alias_shadows_the_public_slug_for_that_org_only(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """An org's custom model reusing a public slug wins for its own keys only."""
    store = PostgresGatewayControlStore(gateway_db)
    org_a = gateway_harness.seed_org()
    org_b = gateway_harness.seed_org()
    key_a = gateway_harness.seed_key(org_a)
    key_b = gateway_harness.seed_key(org_b)
    shared_slug = f"gwm-shadow-{uuid_module.uuid4().hex[:10]}"
    public_alias = gateway_harness.activate_alias(alias_name=shared_slug)
    custom_alias = gateway_harness.activate_alias(org_id=org_a, alias_name=shared_slug)

    request = _request("shadowing")
    deadline = time.monotonic() + 30
    for raw_key, expected in (
        (key_a.raw_key, custom_alias),
        (key_b.raw_key, public_alias),
    ):
        snapshot = store.authorize_request(
            raw_key=raw_key, alias=shared_slug, request=request, deadline_monotonic=deadline
        )
        assert snapshot.alias_revision_id == expected.revision_id
        assert snapshot.catalog_sha256 == expected.catalog_sha256
        assert snapshot.target == DirectTarget(pool_id=expected.pool_id)

    # The effective set is deduped: one entry per slug, org row shadowing.
    for raw_key in (key_a.raw_key, key_b.raw_key):
        granted = store.granted_aliases(raw_key=raw_key)
        assert granted.count(shared_slug) == 1

    # Retiring the org row un-shadows the public one for org A's keys.
    gateway_harness.deactivate_alias(custom_alias.alias_id)
    snapshot = store.authorize_request(
        raw_key=key_a.raw_key, alias=shared_slug, request=request, deadline_monotonic=deadline
    )
    assert snapshot.alias_revision_id == public_alias.revision_id


@pytest.mark.integration
def test_ungranted_org_shadow_denies_even_when_public_slug_is_granted(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """A non-granted org alias still shadows a granted public slug: deny, never serve public.

    Regression for the grant-filter-before-shadow bug. When an identity holds a
    grant for the PUBLIC alias but its org has an active same-name alias with NO
    grant, the effective (org-first) row is the ungranted org alias, so the
    request must be denied and the name must not appear in ``granted_aliases``.
    The old ordering grant-filtered first, dropped the org row, and wrongly
    served the public target while reporting the shadowed name as granted.
    """
    store = PostgresGatewayControlStore(gateway_db)
    org_id = gateway_harness.seed_org()
    key = gateway_harness.seed_key(org_id)
    slug = f"gwm-shadow-deny-{uuid_module.uuid4().hex[:10]}"
    # Public slug granted to this org's default identity ...
    public_alias = gateway_harness.activate_alias(alias_name=slug, seed_grants=False)
    gateway_harness.grant_alias(f"org-{org_id}", public_alias.alias_id, org_id=org_id)
    # ... but the org's same-name custom alias shadows it and is NOT granted.
    gateway_harness.activate_alias(org_id=org_id, alias_name=slug, seed_grants=False)

    request = _request("shadow-deny")
    deadline = time.monotonic() + 30
    with pytest.raises(AliasNotGrantedError, match="not granted"):
        store.authorize_request(
            raw_key=key.raw_key, alias=slug, request=request, deadline_monotonic=deadline
        )
    assert slug not in store.granted_aliases(raw_key=key.raw_key)


@pytest.mark.integration
def test_null_identity_key_denies_without_touching_inside_the_transaction(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """A key whose identity is null denies fast, never touching last-used inside the txn.

    Regression for a self-deadlock: the null-identity branch used to call
    _touch_last_used inside the authority transaction, which holds FOR SHARE on
    the key row; the touch opens a second pooled connection and UPDATEs that same
    row, blocking on the lock the still-open transaction holds — the request hangs
    forever. authorize_request and granted_aliases must deny/empty and let the
    shared post-commit touch run instead. On the buggy code this call hangs; here
    it must return promptly. The touch still fires (last_used_at advances), proving
    it moved outside the transaction rather than being dropped.
    """
    store = PostgresGatewayControlStore(gateway_db)
    org_id = gateway_harness.seed_org()
    key = gateway_harness.seed_key(org_id)
    gateway_harness.connection.execute(
        "update public.api_keys set identity_id = null, last_used_at = null where id = %s",
        (key.api_key_id,),
    )
    request = _request("null-identity")
    deadline = time.monotonic() + 30
    with pytest.raises(AliasNotGrantedError, match="not granted"):
        store.authorize_request(
            raw_key=key.raw_key, alias="anymodel", request=request, deadline_monotonic=deadline
        )
    assert store.granted_aliases(raw_key=key.raw_key) == ()
    # The shared post-commit touch still ran for the null-identity path.
    touched = gateway_harness.connection.execute(
        "select last_used_at is not null from public.api_keys where id = %s",
        (key.api_key_id,),
    ).fetchone()
    assert touched == (True,)


@pytest.mark.integration
def test_public_aliases_are_grantless_and_private_still_require_a_grant(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """A public alias is usable without a grant; a private one still needs one.

    Public catalog models are grantless so the catalog can grow — a public model
    added AFTER an org exists works immediately without re-granting. Private
    (own-org) aliases stay deny-by-default. Shadowing still resolves the effective
    alias first, so this composes with the shadow tests above.
    """
    store = PostgresGatewayControlStore(gateway_db)
    org_id = gateway_harness.seed_org()
    key = gateway_harness.seed_key(org_id)
    request = _request("public-grantless")
    deadline = time.monotonic() + 30

    # A public alias (org_id null) with NO grant is authorized and listed.
    public_alias = gateway_harness.activate_alias(seed_grants=False)
    snapshot = store.authorize_request(
        raw_key=key.raw_key,
        alias=public_alias.alias_name,
        request=request,
        deadline_monotonic=deadline,
    )
    assert snapshot.alias == public_alias.alias_name
    assert public_alias.alias_name in store.granted_aliases(raw_key=key.raw_key)

    # A private/own-org alias with NO grant is still denied and not listed.
    private_alias = gateway_harness.activate_alias(org_id=org_id, seed_grants=False)
    with pytest.raises(AliasNotGrantedError, match="not granted"):
        store.authorize_request(
            raw_key=key.raw_key,
            alias=private_alias.alias_name,
            request=request,
            deadline_monotonic=deadline,
        )
    assert private_alias.alias_name not in store.granted_aliases(raw_key=key.raw_key)

    # A public model ADDED AFTER the org (still no grant) works — the exact gap
    # this fixes (catalog growth no longer 403s existing orgs).
    late_public = gateway_harness.activate_alias(seed_grants=False)
    late = store.authorize_request(
        raw_key=key.raw_key,
        alias=late_public.alias_name,
        request=request,
        deadline_monotonic=deadline,
    )
    assert late.alias == late_public.alias_name


@pytest.mark.integration
def test_grant_join_preserves_the_pre_cutover_rule_set_on_the_live_path(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """The live grant join returns exactly the pre-cutover rule-derived set.

    The migration seeds a grant for every ``(default identity, alias)`` usable
    under the old predicate (``active AND (public OR own-org)``); the harness
    reproduces that seed per alias. This asserts on the LIVE store, not raw SQL:
    the rule-derived subset among this test's aliases, recomputed independently,
    equals what ``granted_aliases`` returns and what ``authorize_request``
    accepts -- no usable alias is lost at cutover, and no unusable one gains
    access.
    """
    store = PostgresGatewayControlStore(gateway_db)
    org_id = gateway_harness.seed_org()
    other_org_id = gateway_harness.seed_org()
    key = gateway_harness.seed_key(org_id)
    public_a = gateway_harness.activate_alias()
    public_b = gateway_harness.activate_alias()
    own = gateway_harness.activate_alias(org_id=org_id)
    foreign = gateway_harness.activate_alias(org_id=other_org_id)
    retired = gateway_harness.activate_alias()
    gateway_harness.deactivate_alias(retired.alias_id)
    seeded = (public_a, public_b, own, foreign, retired)
    seeded_names = {alias.alias_name for alias in seeded}

    # Recompute the pre-cutover rule-derived subset over exactly these aliases.
    rule_rows = gateway_harness.fetch_all(
        """
        select alias_name
        from public.gateway_aliases
        where alias_id = any(%s) and active
          and (org_id is null or org_id = %s)
        """,
        (sorted(alias.alias_id for alias in seeded), org_id),
    )
    rule_subset = {str(row[0]) for row in rule_rows}
    assert rule_subset == {public_a.alias_name, public_b.alias_name, own.alias_name}

    granted = set(store.granted_aliases(raw_key=key.raw_key))
    assert granted & seeded_names == rule_subset

    request = _request("cutover")
    deadline = time.monotonic() + 30
    for alias_name in rule_subset:
        snapshot = store.authorize_request(
            raw_key=key.raw_key, alias=alias_name, request=request, deadline_monotonic=deadline
        )
        assert snapshot.alias == alias_name
        assert snapshot.identity_id == f"org-{org_id}"
    for alias_name in (foreign.alias_name, retired.alias_name):
        with pytest.raises(AliasNotGrantedError, match="not granted"):
            store.authorize_request(
                raw_key=key.raw_key,
                alias=alias_name,
                request=request,
                deadline_monotonic=deadline,
            )


@pytest.mark.integration
def test_deny_by_default_blocks_an_active_private_alias_with_no_grant(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """An active, PRIVATE alias is denied until a grant exists for the identity.

    Public aliases became grantless (see
    ``test_public_aliases_are_grantless_and_private_still_require_a_grant``), but
    PRIVATE (own-org) aliases stay deny-by-default: an active, own-org alias with
    no ``gateway_grants`` row is denied and unlisted, and adding the grant is what
    flips access on -- proving the join, not mere ownership, is the real gate.
    """
    store = PostgresGatewayControlStore(gateway_db)
    org_id = gateway_harness.seed_org()
    key = gateway_harness.seed_key(org_id)
    ungranted = gateway_harness.activate_alias(org_id=org_id, seed_grants=False)

    # It is active and owned by this org, yet deny-by-default still blocks it:
    # the grantless carve-out is for public (org_id null) aliases only.
    state = gateway_harness.fetch_one(
        "select active, org_id::text from public.gateway_aliases where alias_id = %s",
        (ungranted.alias_id,),
    )
    assert state == (True, org_id)

    request = _request("deny by default")
    deadline = time.monotonic() + 30
    with pytest.raises(AliasNotGrantedError, match="not granted"):
        store.authorize_request(
            raw_key=key.raw_key,
            alias=ungranted.alias_name,
            request=request,
            deadline_monotonic=deadline,
        )
    assert ungranted.alias_name not in store.granted_aliases(raw_key=key.raw_key)

    gateway_harness.grant_alias(f"org-{org_id}", ungranted.alias_id, org_id=org_id)
    snapshot = store.authorize_request(
        raw_key=key.raw_key,
        alias=ungranted.alias_name,
        request=request,
        deadline_monotonic=deadline,
    )
    assert snapshot.alias == ungranted.alias_name
    assert ungranted.alias_name in store.granted_aliases(raw_key=key.raw_key)


@pytest.mark.integration
def test_key_without_an_identity_authenticates_but_authorizes_nothing(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """A null-identity key still authenticates but fails authorization closed.

    The reparent column is nullable so a key whose identity row was removed at
    the issue API cannot wedge authentication; deny-by-default then rejects it
    because no grant can match a null identity.
    """
    store = PostgresGatewayControlStore(gateway_db)
    org_id = gateway_harness.seed_org()
    key = gateway_harness.seed_key(org_id)
    alias = gateway_harness.activate_alias()
    gateway_harness.connection.execute(
        "update public.api_keys set identity_id = null where id = %s",
        (key.api_key_id,),
    )

    store.authenticate_key(raw_key=key.raw_key)

    with pytest.raises(AliasNotGrantedError, match="not granted"):
        store.authorize_request(
            raw_key=key.raw_key,
            alias=alias.alias_name,
            request=_request("orphan"),
            deadline_monotonic=time.monotonic() + 30,
        )
    assert store.granted_aliases(raw_key=key.raw_key) == ()


def test_authority_reuse_cache_expires_and_stays_bounded() -> None:
    """Entries serve inside the TTL, expire after it, and the size is capped."""
    from explabs.gateway.control_store import AuthorityReuseCache, _KeyAuthority

    cache = AuthorityReuseCache(ttl_seconds=1.0, max_entries=2)
    authority = _KeyAuthority(api_key_id="k", org_id="o", identity_id="i")
    cache.put("h1", authority, monotonic=100.0)
    assert cache.get("h1", monotonic=100.5) is authority
    assert cache.get("h1", monotonic=101.0) is None  # expired exactly at TTL
    cache.put("h1", authority, monotonic=200.0)
    cache.put("h2", authority, monotonic=200.0)
    # At capacity with both entries live: the insert drops everything rather
    # than growing unbounded, then stores the newcomer.
    cache.put("h3", authority, monotonic=200.1)
    assert cache.get("h3", monotonic=200.2) is authority
    assert cache.get("h1", monotonic=200.2) is None


@pytest.mark.integration
def test_authorize_reuses_the_fail_fast_authentication_within_the_ttl(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """The authenticate->authorize pair reads the key row once, briefly.

    Reuse is proven behaviorally: after the fail-fast authenticate primes the
    window, a revocation is not seen by authorize until the TTL lapses (the
    reserve-time SQL backstop is what binds it meanwhile, pinned in the
    serialization test above).
    """
    from explabs.gateway.control_store import AuthorityReuseCache

    store = PostgresGatewayControlStore(
        gateway_db, authority_reuse=AuthorityReuseCache(ttl_seconds=0.4)
    )
    org_id = gateway_harness.seed_org()
    key = gateway_harness.seed_key(org_id)
    alias = gateway_harness.activate_alias()
    store.authenticate_key(raw_key=key.raw_key)
    gateway_harness.connection.execute(
        "update public.api_keys set revoked_at = now() where id = %s",
        (key.api_key_id,),
    )
    warm = store.authorize_request(
        raw_key=key.raw_key,
        alias=alias.alias_name,
        request=_request("reuse-warm"),
        deadline_monotonic=time.monotonic() + 30,
    )
    assert warm.virtual_key_id == f"key-{key.api_key_id}"
    time.sleep(0.5)
    with pytest.raises(InvalidVirtualKeyError, match="invalid"):
        store.authorize_request(
            raw_key=key.raw_key,
            alias=alias.alias_name,
            request=_request("reuse-cold"),
            deadline_monotonic=time.monotonic() + 30,
        )


def test_grant_resolution_cache_expires_and_stays_bounded() -> None:
    """Positive resolutions serve inside the TTL, expire after, size-capped."""
    from explabs.gateway.control_store import GrantResolutionCache, _GrantResolution

    cache = GrantResolutionCache(ttl_seconds=1.0, max_entries=2)
    resolution = _GrantResolution(
        revision_id="rev-1",
        target_document={"kind": "direct", "pool_id": "pool-1"},
        catalog_sha256="a" * 64,
        refusal_failover=False,
    )
    cache.put("org", "id", "alias", resolution, monotonic=100.0)
    assert cache.get("org", "id", "alias", monotonic=100.5) is resolution
    assert cache.get("org", "id", "alias", monotonic=101.0) is None  # expired at TTL
    # Scope isolation: a different org/identity/alias never reuses the entry.
    cache.put("org", "id", "alias", resolution, monotonic=200.0)
    assert cache.get("other-org", "id", "alias", monotonic=200.1) is None
    assert cache.get("org", "other-id", "alias", monotonic=200.1) is None
    # Capacity: at the cap with live entries, an insert drops all and stores.
    cache.put("org", "id", "a2", resolution, monotonic=200.0)
    cache.put("org", "id", "a3", resolution, monotonic=200.1)
    assert cache.get("org", "id", "a3", monotonic=200.2) is resolution
    assert cache.get("org", "id", "alias", monotonic=200.2) is None


@pytest.mark.integration
def test_authorize_caches_public_resolution_and_never_caches_private(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """Public resolutions cache (bounded staleness); private never cache.

    Public aliases are grantless, so caching them only exposes revision/active
    staleness (already 15s-eventual via the catalog); the warmed store serves a
    just-deactivated public alias within the TTL while a cold store denies, and
    the warmed store converges after the TTL. A PRIVATE alias, by contrast, is
    never cached: revoking its grant denies immediately on the SAME warm store
    (deny-by-default stays instantly consistent).
    """
    from explabs.gateway.control_store import GrantResolutionCache

    store = PostgresGatewayControlStore(
        gateway_db, grant_resolution=GrantResolutionCache(ttl_seconds=0.5)
    )
    org_id = gateway_harness.seed_org()
    key = gateway_harness.seed_key(org_id)
    deadline = time.monotonic() + 30

    # --- PUBLIC alias: cached, bounded staleness on deactivation. ---
    public_alias = gateway_harness.activate_alias()  # org_id null => grantless
    warmed = store.authorize_request(
        raw_key=key.raw_key,
        alias=public_alias.alias_name,
        request=_request("pub-warm"),
        deadline_monotonic=deadline,
    )
    assert warmed.alias == public_alias.alias_name
    gateway_harness.deactivate_alias(public_alias.alias_id)
    # Within the TTL the warmed store still serves the cached public resolution.
    still = store.authorize_request(
        raw_key=key.raw_key,
        alias=public_alias.alias_name,
        request=_request("pub-still"),
        deadline_monotonic=deadline,
    )
    assert still.alias == public_alias.alias_name
    # A cold store (another worker) sees the deactivation immediately.
    cold = PostgresGatewayControlStore(gateway_db)
    with pytest.raises(AliasNotGrantedError, match="not granted"):
        cold.authorize_request(
            raw_key=key.raw_key,
            alias=public_alias.alias_name,
            request=_request("pub-cold"),
            deadline_monotonic=deadline,
        )
    # After the TTL the warmed store converges too.
    time.sleep(0.6)
    with pytest.raises(AliasNotGrantedError, match="not granted"):
        store.authorize_request(
            raw_key=key.raw_key,
            alias=public_alias.alias_name,
            request=_request("pub-expired"),
            deadline_monotonic=deadline,
        )

    # --- PRIVATE alias: never cached, grant revocation is instant. ---
    private_alias = gateway_harness.activate_alias(org_id=org_id)
    gateway_harness.grant_alias(f"org-{org_id}", private_alias.alias_id, org_id=org_id)
    granted = store.authorize_request(
        raw_key=key.raw_key,
        alias=private_alias.alias_name,
        request=_request("priv-warm"),
        deadline_monotonic=deadline,
    )
    assert granted.alias == private_alias.alias_name
    gateway_harness.connection.execute(
        "delete from public.gateway_grants where alias_id = %s and identity_id = %s",
        (private_alias.alias_id, f"org-{org_id}"),
    )
    # No TTL wait: the SAME warm store denies immediately (private isn't cached).
    with pytest.raises(AliasNotGrantedError, match="not granted"):
        store.authorize_request(
            raw_key=key.raw_key,
            alias=private_alias.alias_name,
            request=_request("priv-revoked"),
            deadline_monotonic=deadline,
        )
