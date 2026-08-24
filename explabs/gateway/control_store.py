# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Postgres gateway control store authenticating platform ``xpl_`` keys natively."""

from __future__ import annotations

import hashlib
import re
import threading
import time
import uuid
from dataclasses import dataclass
from typing import cast

from exp.common.core.artifacts import Sha256, sha256_json
from exp.runtime.gateway.contracts import (
    AuthorizationSnapshot,
    DirectTarget,
    GatewayRequest,
    GatewayTarget,
    ProjectTarget,
)
from exp.runtime.gateway.interfaces import GatewayClock
from exp.runtime.gateway.sqlite.store import (
    AliasNotGrantedError,
    GatewayStoreError,
    InvalidVirtualKeyError,
    SystemGatewayClock,
)
from psycopg import Cursor
from psycopg.rows import TupleRow
from pydantic import ValidationError

from explabs.gateway.capture import (
    PromptCaptureBuffer,
    PromptCapturePayload,
    serialize_capture_messages,
)
from explabs.gateway.db import GatewayDatabase
from explabs.gateway.lineage import RequestLineageTracker, compute_request_lineage

_ORGANIZATION_PREFIX = "org-"
_API_KEY_PREFIX = "key-"
# Experiential's ArtifactId shape. Platform uuids may start with a digit, which the
# pattern rejects, so uuid-backed identifiers always carry a lowercase prefix.
_ARTIFACT_ID_PATTERN = re.compile(r"^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$")
_LAST_USED_WRITE_INTERVAL_SECONDS = 60.0
_MALFORMED_TARGET_MESSAGE = "active alias revision target is malformed"
# Uniform copy: authentication failures never reveal which check rejected the
# key, and grant failures never reveal whether the alias exists.
_INVALID_KEY_MESSAGE = "virtual key is invalid"
_ALIAS_NOT_GRANTED_MESSAGE = "requested model alias is not granted"


def _alias_target(document: object) -> GatewayTarget:
    """Build the frozen route target from its stored revision fields.

    int-P1 stores direct targets as ``{"kind", "pool_id", "deployment_ids"}``;
    Experiential's ``DirectTarget`` at the pin is ``extra="forbid"`` with only ``kind``
    and ``pool_id``, so the target is built from named fields rather than
    validating the whole document.

    Args:
        document: ``gateway_alias_revisions.target`` jsonb value.

    Returns:
        The typed direct or frozen project target.

    Raises:
        GatewayStoreError: The stored document does not carry a valid target.
    """
    if not isinstance(document, dict):
        raise GatewayStoreError(_MALFORMED_TARGET_MESSAGE)
    # Raw jsonb boundary: psycopg decodes jsonb objects as plain dicts.
    fields = cast("dict[str, object]", document)
    try:
        match fields.get("kind"):
            case "direct":
                pool_id = fields.get("pool_id")
                if isinstance(pool_id, str):
                    return DirectTarget(pool_id=pool_id)
            case "project":
                project_ref = fields.get("project_ref")
                activation_ref = fields.get("activation_ref")
                catalog_sha256 = fields.get("catalog_sha256")
                if (
                    isinstance(project_ref, str)
                    and isinstance(activation_ref, str)
                    and isinstance(catalog_sha256, str)
                ):
                    return ProjectTarget(
                        project_ref=project_ref,
                        activation_ref=activation_ref,
                        catalog_sha256=catalog_sha256,
                    )
            case _:
                raise GatewayStoreError(_MALFORMED_TARGET_MESSAGE)
    except ValidationError as exc:
        raise GatewayStoreError(_MALFORMED_TARGET_MESSAGE) from exc
    raise GatewayStoreError(_MALFORMED_TARGET_MESSAGE)


def organization_artifact_id(org_id: str) -> str:
    """Return the Experiential organization identifier for one platform org uuid."""
    return f"{_ORGANIZATION_PREFIX}{_uuid_text(org_id)}"


def api_key_artifact_id(api_key_id: str) -> str:
    """Return the Experiential virtual-key identifier for one platform api_keys uuid."""
    return f"{_API_KEY_PREFIX}{_uuid_text(api_key_id)}"


def organization_uuid(artifact_id: str) -> uuid.UUID:
    """Decode one prefixed Experiential organization identifier back to its org uuid.

    Args:
        artifact_id: ``org-<uuid>`` identifier from an authorization snapshot.

    Returns:
        The platform organization uuid.

    Raises:
        GatewayStoreError: The identifier was not produced by this store.
    """
    return _strip_uuid(artifact_id, prefix=_ORGANIZATION_PREFIX, kind="organization")


def api_key_uuid(artifact_id: str) -> uuid.UUID:
    """Decode one prefixed Experiential virtual-key identifier back to its api_keys uuid.

    Args:
        artifact_id: ``key-<uuid>`` identifier from an authorization snapshot.

    Returns:
        The platform API-key uuid.

    Raises:
        GatewayStoreError: The identifier was not produced by this store.
    """
    return _strip_uuid(artifact_id, prefix=_API_KEY_PREFIX, kind="api key")


def _uuid_text(value: str) -> str:
    """Normalize one uuid string, rejecting anything that is not a uuid."""
    try:
        return str(uuid.UUID(value))
    except ValueError as exc:
        message = "gateway identifier is not a uuid"
        raise GatewayStoreError(message) from exc


def _strip_uuid(artifact_id: str, *, prefix: str, kind: str) -> uuid.UUID:
    """Strip one identity prefix and parse the remaining uuid."""
    message = f"gateway {kind} identifier has a foreign shape"
    if not artifact_id.startswith(prefix):
        raise GatewayStoreError(message)
    try:
        return uuid.UUID(artifact_id[len(prefix) :])
    except ValueError as exc:
        raise GatewayStoreError(message) from exc


def caller_operation_sha256(request: GatewayRequest) -> Sha256 | None:
    """Hash an opted-in caller operation without retaining the raw identifier.

    Matches Experiential's SQLite store byte for byte so same-worker replay digests
    never depend on which store implementation accepted the request.

    Args:
        request: Canonical gateway request.

    Returns:
        Namespaced caller-operation digest, or ``None`` for ordinary requests.

    Raises:
        GatewayStoreError: Both supported headers name different operations.
    """
    if (
        request.idempotency_key is not None
        and request.client_request_id is not None
        and request.idempotency_key != request.client_request_id
    ):
        message = "idempotency and client request IDs must match when both are set"
        raise GatewayStoreError(message)
    value = request.idempotency_key or request.client_request_id
    if value is None:
        return None
    return hashlib.sha256(f"gateway-caller-operation-v1\0{value}".encode()).hexdigest()


# The authenticate->authorize pair lands within milliseconds; the TTL only
# needs to bridge that. Reserve-time SQL re-checks bound the staleness blast
# radius (see AuthorityReuseCache).
_AUTHORITY_REUSE_SECONDS = 2.0
_AUTHORITY_CACHE_MAX = 4096

# The grant/alias resolution cache TTL. Kept short and equal to the authority
# window: it bounds how long a REVOKED grant keeps serving (see
# GrantResolutionCache) and is far tighter than the 15s in-memory catalog
# refresh that already fronts alias plans.
_GRANT_RESOLUTION_SECONDS = 2.0
_GRANT_CACHE_MAX = 8192


class LastUsedThrottle:
    """Per-key throttle keeping ``last_used_at`` writes off the request hot path."""

    def __init__(self, *, interval_seconds: float = _LAST_USED_WRITE_INTERVAL_SECONDS) -> None:
        """Create one process-local throttle.

        Args:
            interval_seconds: Minimum spacing between writes for one key.
        """
        self._interval_seconds = interval_seconds
        self._last_write_monotonic: dict[str, float] = {}
        self._lock = threading.Lock()

    def due(self, api_key_id: str, *, monotonic: float | None = None) -> bool:
        """Report and record whether one key's usage timestamp is due a write.

        Args:
            api_key_id: Platform API-key uuid text.
            monotonic: Injectable monotonic instant for tests.

        Returns:
            True at most once per interval per key.
        """
        now = time.monotonic() if monotonic is None else monotonic
        with self._lock:
            last = self._last_write_monotonic.get(api_key_id)
            if last is not None and now - last < self._interval_seconds:
                return False
            self._last_write_monotonic[api_key_id] = now
            return True


def _key_hash(raw_key: str) -> str:
    """Storage digest of a presented key; the raw key never leaves memory."""
    return hashlib.sha256(raw_key.encode()).hexdigest()


class AuthorityReuseCache:
    """Short-lived reuse of one key's authenticated authority row.

    WMO authenticates every request twice on purpose (a fail-fast
    ``authenticate`` before JSON decode, then ``authorize_request``), which
    made the identical ``api_keys FOR SHARE`` SELECT two of the seven
    pre-first-token database round trips. This cache lets the second call
    reuse the first call's row for a very short window.

    Safety: the window only staleness-exposes AUTHORIZATION METADATA (a
    just-revoked or just-expired key may pass authenticate/authorize for up
    to the TTL). Money cannot move on stale authority: gateway_accept_request
    and gateway_start_attempt both re-check revocation/expiry inside Postgres
    at reserve time and fail with 42501. Grant changes are unaffected — the
    grant query itself is never cached.
    """

    def __init__(
        self,
        *,
        ttl_seconds: float = _AUTHORITY_REUSE_SECONDS,
        max_entries: int = _AUTHORITY_CACHE_MAX,
    ) -> None:
        """Create one process-local cache bounded in time and size."""
        self._ttl_seconds = ttl_seconds
        self._max_entries = max_entries
        self._entries: dict[str, tuple[_KeyAuthority, float]] = {}
        self._lock = threading.Lock()

    def get(self, key_hash: str, *, monotonic: float) -> _KeyAuthority | None:
        """Return the fresh authority for a key hash, or None."""
        with self._lock:
            entry = self._entries.get(key_hash)
            if entry is None:
                return None
            authority, expires = entry
            if monotonic >= expires:
                del self._entries[key_hash]
                return None
            return authority

    def put(self, key_hash: str, authority: _KeyAuthority, *, monotonic: float) -> None:
        """Store one freshly authenticated authority row."""
        with self._lock:
            if len(self._entries) >= self._max_entries:
                # Bounded and simple: purge expired; if a flood of distinct
                # keys still fills it, drop everything (a miss only costs the
                # SELECT this cache saves).
                live = {
                    stored_hash: entry
                    for stored_hash, entry in self._entries.items()
                    if entry[1] > monotonic
                }
                self._entries = live if len(live) < self._max_entries else {}
            self._entries[key_hash] = (authority, monotonic + self._ttl_seconds)


@dataclass(frozen=True)
class _KeyAuthority:
    """Active platform authority resolved from one presented key.

    ``identity_id`` is nullable at the DB level: a key whose identity row was
    hard-deleted must not wedge authentication. Authorization then fails closed
    because no grant can match a null identity.
    """

    api_key_id: str
    org_id: str
    identity_id: str | None
    # The org-wide prompt-capture opt-in, snapshotted with the authority (and
    # therefore stale by at most the reuse-cache TTL). Worker-side this is only
    # a performance gate — gateway_capture_prompt re-checks the flag in SQL.
    captures_prompt_content: bool = False


@dataclass(frozen=True)
class _GrantResolution:
    """The authorized alias resolution: the row authorize_request builds from.

    Exactly the four values the effective-alias + grant-join query returns,
    frozen so a cached hit reconstructs an identical AuthorizationSnapshot.
    """

    revision_id: str
    target_document: object
    catalog_sha256: str
    refusal_failover: bool


class GrantResolutionCache:
    """Short-lived reuse of one (org, identity, alias) authorization result.

    The effective-alias resolution + grant-existence join is the one remaining
    per-request DB round trip on the authorize path. Under load nearly every
    request repeats a small set of (identity, alias) pairs, so a short cache
    collapses that round trip to ~0.

    Safety -- only PUBLIC (grantless, per #543) resolutions are cached, and
    only POSITIVE ones:
      * a public alias has NO grant, so there is no grant-revocation staleness
        to worry about; the only mutation is a revision repoint or a
        deactivation, both already 15s-eventual via the catalog refresher, so
        a 2s cache is strictly tighter than the consistency the system already
        provides;
      * PRIVATE / org-scoped aliases (the deny-by-default path) are NEVER
        cached by the caller, so a grant revocation and an org-shadow change
        stay IMMEDIATELY consistent -- there is no reserve-time SQL backstop
        for grants, so that path must not be cached;
      * newly resolving an alias is always a miss -> DB, so enabling access is
        never delayed; caching is positives-only;
      * the key is (org_id, identity_id, alias): org-scoped so nothing leaks
        across orgs, identity-scoped so nothing leaks across identities.
    """

    def __init__(
        self,
        *,
        ttl_seconds: float = _GRANT_RESOLUTION_SECONDS,
        max_entries: int = _GRANT_CACHE_MAX,
    ) -> None:
        """Create one process-local cache bounded in time and size."""
        self._ttl_seconds = ttl_seconds
        self._max_entries = max_entries
        self._entries: dict[tuple[str, str, str], tuple[_GrantResolution, float]] = {}
        self._lock = threading.Lock()

    def get(
        self, org_id: str, identity_id: str, alias: str, *, monotonic: float
    ) -> _GrantResolution | None:
        """Return the fresh resolution for a scope key, or None."""
        cache_key = (org_id, identity_id, alias)
        with self._lock:
            entry = self._entries.get(cache_key)
            if entry is None:
                return None
            resolution, expires = entry
            if monotonic >= expires:
                del self._entries[cache_key]
                return None
            return resolution

    def put(
        self,
        org_id: str,
        identity_id: str,
        alias: str,
        resolution: _GrantResolution,
        *,
        monotonic: float,
    ) -> None:
        """Store one successful authorization resolution."""
        cache_key = (org_id, identity_id, alias)
        with self._lock:
            if len(self._entries) >= self._max_entries:
                live = {
                    stored: entry for stored, entry in self._entries.items() if entry[1] > monotonic
                }
                self._entries = live if len(live) < self._max_entries else {}
            self._entries[cache_key] = (resolution, monotonic + self._ttl_seconds)


class PostgresGatewayControlStore:
    """Experiential ``GatewayControlStore`` over the platform's own keys and aliases.

    Authenticates the platform's existing ``xpl_`` keys natively via
    ``sha256(raw_key)`` lookup on ``api_keys.key_hash``; there are no old-engine
    ``wmo_vk_`` keys and no pepper file. Each key hangs off a real identity via
    ``api_keys.identity_id``; the per-org default identity carries today's
    synthetic ``org-{org_id}`` value, so existing keys are unchanged.

    Authorization contract (shadow-before-grant; public is grantless): for a
    requested name ``N`` the *effective alias* is the active org-scoped row for
    the key's org if one exists, otherwise the active public row (org-first
    ordering). A key may use ``N`` iff the effective alias is PUBLIC
    (``org_id is null``) OR a ``gateway_grants`` row exists for
    ``(key's identity_id, effective_alias_id)``. Public catalog models are thus
    usable by any authenticated key without a grant, so the catalog can grow
    without re-granting existing orgs; private/own-org aliases remain
    deny-by-default. Shadowing is resolved before the grant check, so a
    non-granted org row still shadows and denies rather than falling through to
    the public row of the same name; the same rule governs ``granted_aliases``.
    Grants are read as postgres inside the authority transaction (RLS bypassed);
    a concurrent grant mutation is simply seen committed or not.
    """

    def __init__(
        self,
        db: GatewayDatabase,
        *,
        clock: GatewayClock | None = None,
        authority_reuse: AuthorityReuseCache | None = None,
        grant_resolution: GrantResolutionCache | None = None,
        lineage: RequestLineageTracker | None = None,
        capture: PromptCaptureBuffer | None = None,
    ) -> None:
        """Bind one pooled database, injectable clock, and reuse caches.

        Args:
            db: Shared worker connection pool.
            clock: Injectable wall and monotonic clock.
            authority_reuse: Injectable authority reuse window (tests shrink
                its TTL; production uses the default).
            grant_resolution: Injectable grant/alias resolution cache (tests
                shrink its TTL; production uses the default).
            lineage: Shared content-free lineage handoff to the ledger's
                accept (see explabs/gateway/lineage.py); None disables lineage.
            capture: Shared opt-in prompt-capture handoff to the ledger's
                accept (see explabs/gateway/capture.py); None disables capture.
        """
        self._db = db
        self._clock = SystemGatewayClock() if clock is None else clock
        self._last_used = LastUsedThrottle()
        self._authority_reuse = (
            AuthorityReuseCache() if authority_reuse is None else authority_reuse
        )
        self._grant_resolution = (
            GrantResolutionCache() if grant_resolution is None else grant_resolution
        )
        self._lineage = lineage
        self._capture = capture

    def authenticate_key(self, *, raw_key: str) -> None:
        """Validate one platform key without loading grants or request content.

        Args:
            raw_key: Presented ``xpl_`` key.

        Raises:
            InvalidVirtualKeyError: The key is unknown, expired, or revoked.
        """
        key_hash = _key_hash(raw_key)
        authority = self._authority_reuse.get(key_hash, monotonic=self._clock.monotonic())
        if authority is None:
            with self._db.transaction() as cursor:
                authority = self._authenticate_in_transaction(cursor, raw_key)
            self._authority_reuse.put(key_hash, authority, monotonic=self._clock.monotonic())
        self._touch_last_used(authority.api_key_id)

    def authenticated_identity(self, *, raw_key: str) -> tuple[str, str]:
        """Return the organization and identity artifact IDs owning one valid key.

        Args:
            raw_key: Presented ``xpl_`` key.

        Returns:
            ``(organization_id, identity_id)`` in Experiential artifact form.

        Raises:
            InvalidVirtualKeyError: The key is unknown, expired, revoked, or has
                no identity (a key with no identity can hold no authority).
        """
        key_hash = _key_hash(raw_key)
        authority = self._authority_reuse.get(key_hash, monotonic=self._clock.monotonic())
        if authority is None:
            with self._db.transaction() as cursor:
                authority = self._authenticate_in_transaction(cursor, raw_key)
            self._authority_reuse.put(key_hash, authority, monotonic=self._clock.monotonic())
        self._touch_last_used(authority.api_key_id)
        if authority.identity_id is None:
            message = "gateway key has no identity"
            raise InvalidVirtualKeyError(message)
        return (organization_artifact_id(authority.org_id), authority.identity_id)

    def authorize_request(
        self,
        *,
        raw_key: str,
        alias: str,
        request: GatewayRequest,
        deadline_monotonic: float,
        app_referer: str | None = None,
        app_title: str | None = None,
    ) -> AuthorizationSnapshot:
        """Authenticate and authorize before any model or provider work.

        Args:
            raw_key: Caller ``xpl_`` key.
            alias: Requested public model alias (the ``model`` field).
            request: Canonical content-bearing request used only for its digest.
            deadline_monotonic: Absolute request-wide monotonic deadline.
            app_referer: Caller ``HTTP-Referer`` app identity, content-free.
            app_title: Caller ``X-Title`` app label, content-free.

        Returns:
            Immutable content-free authority snapshot.

        Raises:
            InvalidVirtualKeyError: Authentication fails.
            AliasNotGrantedError: No active alias is granted to this key's
                identity under the requested name.
            GatewayStoreError: The deadline already expired or headers conflict.
        """
        if deadline_monotonic <= self._clock.monotonic():
            message = "request deadline has already expired"
            raise GatewayStoreError(message)
        if _ARTIFACT_ID_PATTERN.fullmatch(alias) is None or len(alias) > 128:
            # A conforming catalog can never contain this name; keep the
            # response indistinguishable from an unknown alias.
            raise AliasNotGrantedError(_ALIAS_NOT_GRANTED_MESSAGE)
        key_hash = _key_hash(raw_key)
        cached_authority = self._authority_reuse.get(key_hash, monotonic=self._clock.monotonic())
        # Fast path: authority AND grant resolution both cached -> zero DB round
        # trips on the authorize seam. Only a positive (authorized) resolution
        # is ever cached, so a newly granted alias still takes effect on its
        # first (miss) request; a revoked grant lags at most the cache TTL
        # (GrantResolutionCache documents the contract).
        if cached_authority is not None and cached_authority.identity_id is not None:
            resolution = self._grant_resolution.get(
                cached_authority.org_id,
                cached_authority.identity_id,
                alias,
                monotonic=self._clock.monotonic(),
            )
            if resolution is not None:
                self._touch_last_used(cached_authority.api_key_id)
                return self._snapshot_from_resolution(
                    cached_authority,
                    alias,
                    request,
                    resolution,
                    deadline_monotonic,
                    app_referer=app_referer,
                    app_title=app_title,
                )

        with self._db.transaction() as cursor:
            # Reuse the authority row the fail-fast authenticate just loaded
            # (AuthorityReuseCache documents the staleness contract); a miss
            # authenticates here exactly as before and primes the cache.
            if cached_authority is None:
                authority = self._authenticate_in_transaction(cursor, raw_key)
                self._authority_reuse.put(key_hash, authority, monotonic=self._clock.monotonic())
            else:
                authority = cached_authority
            identity_id = authority.identity_id
            if identity_id is None:
                # A key with no identity can hold no grant; fail closed rather
                # than wedge, matching deny-by-default. Do NOT touch last-used
                # inside this transaction: _touch_last_used opens a second pooled
                # connection that UPDATEs this key row, which blocks on the
                # FOR SHARE lock this transaction already holds — an undetectable
                # cross-connection self-deadlock that hangs the request and burns
                # a pool slot. Fall through to the shared post-commit touch, then
                # deny, exactly like the granted-but-no-row path below.
                row = None
            else:
                # Public is grantless: the effective alias is authorized when it is
                # PUBLIC (org_id is null) OR granted to this key's identity.
                # Shadowing is resolved BEFORE that check: the effective alias is
                # the org-scoped row when one exists, else the public row of the
                # same name (globally-unique names make the ordering a no-op), so a
                # non-granted org row still shadows and denies rather than falling
                # through to the public row of the same name. Grants are read as
                # postgres in the authority transaction, which bypasses RLS; no
                # extra lock is needed because a
                # concurrent grant mutation is simply seen committed or not.
                cursor.execute(
                    """
                    with effective as (
                        select aliases.alias_id, aliases.current_revision_id, aliases.org_id
                        from public.gateway_aliases aliases
                        where aliases.alias_name = %s and aliases.active
                          and (aliases.org_id is null or aliases.org_id = %s)
                        order by (aliases.org_id is not null) desc
                        limit 1
                    )
                    select effective.current_revision_id, revisions.target,
                           revisions.catalog_sha256, revisions.refusal_failover,
                           (effective.org_id is null) as is_public
                    from effective
                    join public.gateway_alias_revisions revisions
                      on revisions.revision_id = effective.current_revision_id
                    where effective.org_id is null
                       or exists (
                         select 1 from public.gateway_grants grants
                         where grants.alias_id = effective.alias_id
                           and grants.identity_id = %s
                       )
                    """,
                    (alias, uuid.UUID(authority.org_id), identity_id),
                )
                row = cursor.fetchone()
        self._touch_last_used(authority.api_key_id)
        if identity_id is None or row is None:
            # Deny uniformly: a null identity can hold no grant, and a non-null
            # identity with no row means the effective alias is not granted. The
            # combined guard also narrows identity_id to non-null for the
            # snapshot. Denials are never cached, so a subsequent grant is seen
            # immediately.
            raise AliasNotGrantedError(_ALIAS_NOT_GRANTED_MESSAGE)
        revision_id, target_document, catalog_sha256, refusal_failover, is_public = row
        resolution = _GrantResolution(
            revision_id=str(revision_id),
            target_document=target_document,
            catalog_sha256=str(catalog_sha256),
            refusal_failover=bool(refusal_failover),
        )
        # Cache ONLY public (grantless, per #543) resolutions. A public alias
        # has no grant to revoke, so the sole staleness is revision repoint,
        # which is already 15s-eventual via the catalog refresher -- a 2s cache
        # is strictly tighter. Private/org-scoped aliases are NEVER cached, so
        # deny-by-default grant revocation and org-shadow changes stay
        # immediately consistent (no reserve-time backstop exists for those).
        if bool(is_public):
            self._grant_resolution.put(
                authority.org_id,
                identity_id,
                alias,
                resolution,
                monotonic=self._clock.monotonic(),
            )
        return self._snapshot_from_resolution(
            authority,
            alias,
            request,
            resolution,
            deadline_monotonic,
            app_referer=app_referer,
            app_title=app_title,
        )

    def _snapshot_from_resolution(
        self,
        authority: _KeyAuthority,
        alias: str,
        request: GatewayRequest,
        resolution: _GrantResolution,
        deadline_monotonic: float,
        *,
        app_referer: str | None = None,
        app_title: str | None = None,
    ) -> AuthorizationSnapshot:
        """Build one content-free snapshot from a resolved authorization.

        Shared by the DB path and the grant-cache fast path so both produce a
        byte-identical snapshot (only ``request_id`` and the request-derived
        digests differ per call). ``identity_id`` is non-null here: the caller
        only reaches this with an authorized (granted or public) resolution.
        """
        identity_id = authority.identity_id
        assert identity_id is not None  # noqa: S101 - narrowed by both callers
        request_id = f"request-{uuid.uuid4().hex}"
        lineage = None
        if self._lineage is not None:
            # The last platform-owned moment the content-bearing request is in
            # scope: derive the content-free lineage digests here and hand them
            # to the ledger's accept under the freshly minted request id.
            lineage = compute_request_lineage(request)
            self._lineage.remember(request_id, lineage)
        if self._capture is not None and authority.captures_prompt_content:
            # Opt-in orgs only: buffer the canonical messages for the ledger's
            # post-accept capture writer. Everyone else never serializes
            # content. The SQL function re-checks the flag before persisting.
            messages_json = serialize_capture_messages(request)
            if messages_json is not None:
                self._capture.remember(
                    PromptCapturePayload(
                        request_id=request_id,
                        org_id=authority.org_id,
                        prompt_sha256=None if lineage is None else lineage.prompt_sha256,
                        messages_json=messages_json,
                    )
                )
        return AuthorizationSnapshot(
            request_id=request_id,
            organization_id=organization_artifact_id(authority.org_id),
            identity_id=identity_id,
            virtual_key_id=api_key_artifact_id(authority.api_key_id),
            alias=alias,
            alias_revision_id=resolution.revision_id,
            target=_alias_target(resolution.target_document),
            surface=request.surface,
            catalog_sha256=resolution.catalog_sha256,
            canonical_request_sha256=sha256_json(request),
            caller_operation_sha256=caller_operation_sha256(request),
            refusal_failover=resolution.refusal_failover,
            deadline_monotonic=deadline_monotonic,
            # Caller app identity headers, content-free and never credentials;
            # oversized values fail the snapshot's own bounds like upstream.
            app_referer=app_referer,
            app_title=app_title,
        )

    def granted_aliases(self, *, raw_key: str) -> tuple[str, ...]:
        """List active aliases granted to the key's identity.

        Args:
            raw_key: Caller ``xpl_`` key.

        Returns:
            Granted, active alias names in stable order; empty when the key has
            no identity (no grant can match).
        """
        with self._db.transaction() as cursor:
            authority = self._authenticate_in_transaction(cursor, raw_key)
            identity_id = authority.identity_id
            if identity_id is None:
                # A key with no identity can hold no grant. Do NOT touch last-used
                # inside this transaction: it opens a second pooled connection that
                # blocks on the FOR SHARE lock this transaction holds on the key row
                # (a self-deadlock that hangs the request). Fall through to the
                # shared post-commit touch and return the empty set.
                rows: list[tuple[object, ...]] = []
            else:
                # Effective visible set with shadowing resolved BEFORE the grant
                # check: pick the org-first row per name, then keep public rows
                # (grantless) plus org-scoped rows this identity is granted. A
                # non-granted org row that shadows a public slug drops the name
                # instead of reporting the shadowed public row as visible.
                cursor.execute(
                    """
                    with effective as (
                        select distinct on (aliases.alias_name)
                               aliases.alias_name, aliases.alias_id, aliases.org_id
                        from public.gateway_aliases aliases
                        where aliases.active and aliases.current_revision_id is not null
                          and (aliases.org_id is null or aliases.org_id = %s)
                        order by aliases.alias_name, (aliases.org_id is not null) desc
                    )
                    select effective.alias_name
                    from effective
                    where effective.org_id is null
                       or exists (
                         select 1 from public.gateway_grants grants
                         where grants.alias_id = effective.alias_id
                           and grants.identity_id = %s
                       )
                    order by effective.alias_name
                    """,
                    (uuid.UUID(authority.org_id), identity_id),
                )
                rows = cursor.fetchall()
        self._touch_last_used(authority.api_key_id)
        return tuple(str(row[0]) for row in rows)

    def granted_alias_authorities(self, *, raw_key: str) -> tuple[tuple[str, str, str], ...]:
        """List granted alias, active revision, and catalog digest triples.

        The same effective visible set as :meth:`granted_aliases` (shadowing
        resolved before the grant check; public rows are grantless), extended
        with each alias's current revision and its frozen catalog digest so the
        listing surface can look up published metadata per authority.

        Args:
            raw_key: Caller ``xpl_`` key.

        Returns:
            ``(alias, revision_id, catalog_sha256)`` triples in stable alias
            order; empty when the key has no identity.
        """
        with self._db.transaction() as cursor:
            authority = self._authenticate_in_transaction(cursor, raw_key)
            identity_id = authority.identity_id
            if identity_id is None:
                # A key with no identity can hold no grant; see granted_aliases
                # for why last-used must not be touched inside this transaction.
                rows: list[tuple[object, ...]] = []
            else:
                cursor.execute(
                    """
                    with effective as (
                        select distinct on (aliases.alias_name)
                               aliases.alias_name, aliases.alias_id, aliases.org_id,
                               aliases.current_revision_id
                        from public.gateway_aliases aliases
                        where aliases.active and aliases.current_revision_id is not null
                          and (aliases.org_id is null or aliases.org_id = %s)
                        order by aliases.alias_name, (aliases.org_id is not null) desc
                    )
                    select effective.alias_name, effective.current_revision_id,
                           revisions.catalog_sha256
                    from effective
                    join public.gateway_alias_revisions revisions
                      on revisions.revision_id = effective.current_revision_id
                    where effective.org_id is null
                       or exists (
                         select 1 from public.gateway_grants grants
                         where grants.alias_id = effective.alias_id
                           and grants.identity_id = %s
                       )
                    order by effective.alias_name
                    """,
                    (uuid.UUID(authority.org_id), identity_id),
                )
                rows = cursor.fetchall()
        self._touch_last_used(authority.api_key_id)
        return tuple((str(row[0]), str(row[1]), str(row[2])) for row in rows)

    def _authenticate_in_transaction(self, cursor: Cursor[TupleRow], raw_key: str) -> _KeyAuthority:
        """Authenticate one key inside the caller's authority transaction.

        The key row is read ``FOR SHARE`` so a concurrent revocation commits
        strictly before or strictly after this authority snapshot — a completed
        revocation can never be followed by stale authority issuance.

        Args:
            cursor: Cursor bound to the caller's open transaction.
            raw_key: Caller key that must never enter Postgres or logs.

        Returns:
            Active organization and API-key authority.

        Raises:
            InvalidVirtualKeyError: The key is unknown, expired, or revoked.
        """
        key_hash = _key_hash(raw_key)
        cursor.execute(
            """
            select keys.id, keys.org_id, keys.revoked_at, keys.expires_at,
                   keys.identity_id, orgs.capture_prompt_content
            from public.api_keys keys
            join public.organizations orgs on orgs.id = keys.org_id
            where keys.key_hash = %s
            for share of keys
            """,
            (key_hash,),
        )
        row = cursor.fetchone()
        if row is None:
            raise InvalidVirtualKeyError(_INVALID_KEY_MESSAGE)
        api_key_id, org_id, revoked_at, expires_at, identity_id, captures = row
        now = self._clock.now()
        if revoked_at is not None or (expires_at is not None and expires_at <= now):
            raise InvalidVirtualKeyError(_INVALID_KEY_MESSAGE)
        return _KeyAuthority(
            api_key_id=str(api_key_id),
            org_id=str(org_id),
            identity_id=None if identity_id is None else str(identity_id),
            captures_prompt_content=bool(captures),
        )

    def _touch_last_used(self, api_key_id: str) -> None:
        """Persist ``last_used_at`` at most once per minute per key.

        Runs in its own transaction AFTER authority commits: an exclusive row
        lock taken while still holding the authority ``FOR SHARE`` would be a
        share-to-exclusive upgrade, which deadlocks against a concurrent
        sibling doing the same.

        Args:
            api_key_id: Authenticated platform API-key uuid text.
        """
        if not self._last_used.due(api_key_id):
            return
        now = self._clock.now()
        with self._db.transaction() as cursor:
            # The predicate keeps sibling workers from re-writing the same
            # hot row within the interval this process already covered.
            cursor.execute(
                """
                update public.api_keys
                   set last_used_at = %s
                 where id = %s
                   and (last_used_at is null or last_used_at < %s - interval '60 seconds')
                """,
                (now, uuid.UUID(api_key_id), now),
            )
