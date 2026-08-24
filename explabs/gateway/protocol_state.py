# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Durable cross-worker idempotency replay and Responses continuation stores.

Experiential's bundled stores are process-local: after a worker restart or on a
sibling worker, keyed replay and ``previous_response_id`` fail closed. These
Postgres implementations plug into ``GatewayService``'s optional
``replay_store`` and ``continuation_store`` parameters so both survive
restarts and work across the fixed worker pool.

Retention decision: both contracts are content-bearing by definition — replay
must return the exact completed response bytes and a continuation must return
the caller's prior canonical messages. That content lives only in
``gateway_replay_operations`` and ``gateway_continuations`` (4 MiB per entry,
finite TTL, pruned on every write), never in the content-free ledger tables.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import TYPE_CHECKING

from exp.runtime.openai_protocol.errors import OpenAIProtocolError
from exp.runtime.openai_protocol.state import (
    CachedResponse,
    ContinuationState,
    ProtocolNamespace,
    ReplayClaimKind,
    ReplayKey,
)
from psycopg.types.json import Jsonb

from explabs.gateway.db import GatewayDatabase

if TYPE_CHECKING:
    from exp.runtime.openai_protocol.state import ReplayLease

# One entry may hold at most this many bytes (matches the table checks).
_MAX_ENTRY_BYTES = 4_194_304
# Published results and continuations live this long (Experiential's bounded default).
_RETENTION_SECONDS = 24 * 60 * 60
# Unpublished ownership expires within this lease so joiners never wait
# forever after worker loss; must exceed the worker's total request timeout.
_LEASE_SECONDS = 300
_JOIN_POLL_SECONDS = 0.5


def _replay_unavailable() -> OpenAIProtocolError:
    """Return the protocol error for owner work that vanished unpublished."""
    return OpenAIProtocolError(
        status_code=409,
        code="idempotency_replay_unavailable",
        message="The original keyed request ended before publishing a replayable result.",
        error_type="api_error",
        param="Idempotency-Key",
    )


def _headers_document(response: CachedResponse) -> Jsonb:
    """Serialize response headers as an ordered jsonb array of pairs."""
    return Jsonb([[name, value] for name, value in response.headers])


def _cached_response(
    status_code: int,
    media_type: str,
    headers_document: object,
    body: bytes,
) -> CachedResponse:
    """Validate one stored row back into the exact bounded response."""
    malformed = OpenAIProtocolError(
        status_code=500,
        code="idempotency_replay_unavailable",
        message="stored replay headers are malformed",
        error_type="api_error",
    )
    if not isinstance(headers_document, list):
        raise malformed
    headers: list[tuple[str, str]] = []
    for pair in headers_document:
        if not isinstance(pair, list) or len(pair) != 2:
            raise malformed
        name, value = pair
        headers.append((str(name), str(value)))
    return CachedResponse(
        status_code=status_code,
        media_type=media_type,
        headers=tuple(headers),
        body=body,
    )


class PostgresReplayLease:
    """One caller's durable ownership, join, or replay handle for a keyed response."""

    def __init__(
        self,
        *,
        store: PostgresReplayStore,
        key: ReplayKey,
        owner_token: uuid.UUID,
        kind: ReplayClaimKind,
        cached: CachedResponse | None,
    ) -> None:
        """Bind one claim outcome to its store row."""
        self._store = store
        self._key = key
        self._owner_token = owner_token
        self.kind = kind
        self._cached = cached

    async def result(self) -> CachedResponse:
        """Join in-flight work or return the already completed exact response."""
        if self._cached is not None:
            return self._cached
        return await self._store._await_published(self._key)  # noqa: SLF001 - lease/store pair

    async def complete(self, response: CachedResponse) -> None:
        """Publish one exact successful response from the unique owner.

        Args:
            response: Completed non-streaming or fully captured SSE result.

        Raises:
            OpenAIProtocolError: This lease does not own the operation, the
                ownership lapsed, or the response exceeds the bounded cache.
        """
        if self.kind != ReplayClaimKind.OWNER:
            raise OpenAIProtocolError(
                status_code=409,
                code="idempotency_conflict",
                message="Only the original keyed request may publish its result.",
                param="Idempotency-Key",
            )
        if response.size_bytes > self._store.max_entry_bytes:
            await self.abandon()
            raise OpenAIProtocolError(
                status_code=500,
                code="idempotency_replay_unavailable",
                message="The completed response exceeds the bounded replay cache.",
                error_type="api_error",
            )
        published = await asyncio.to_thread(
            self._store._publish,  # noqa: SLF001 - lease/store pair
            self._key,
            self._owner_token,
            response,
        )
        if not published:
            raise OpenAIProtocolError(
                status_code=409,
                code="idempotency_conflict",
                message="The keyed operation no longer belongs to this request.",
                param="Idempotency-Key",
            )
        self._cached = response

    async def abandon(self) -> None:
        """Release this claim only when it still owns unpublished work."""
        if self.kind == ReplayClaimKind.OWNER:
            await asyncio.to_thread(
                self._store._abandon,  # noqa: SLF001 - lease/store pair
                self._key,
                self._owner_token,
            )


class PostgresReplayStore:
    """Experiential ``ResponseReplayStore`` shared across workers through Postgres.

    Exactly one owner token exists per unpublished operation; joiners poll the
    row and fail closed once the owner's lease expires, so worker loss can
    never strand a waiting duplicate.
    """

    def __init__(
        self,
        db: GatewayDatabase,
        *,
        lease_seconds: int = _LEASE_SECONDS,
        retention_seconds: int = _RETENTION_SECONDS,
        max_entry_bytes: int = _MAX_ENTRY_BYTES,
        poll_interval_seconds: float = _JOIN_POLL_SECONDS,
    ) -> None:
        """Bind one pooled database and finite retention bounds.

        Args:
            db: Shared worker connection pool.
            lease_seconds: Unpublished ownership lifetime; must exceed the
                worker's total request timeout.
            retention_seconds: Published result lifetime.
            max_entry_bytes: Per-entry response size ceiling.
            poll_interval_seconds: Joiner poll spacing.
        """
        if lease_seconds <= 0 or retention_seconds <= 0 or max_entry_bytes <= 0:
            message = "replay bounds must be positive"
            raise ValueError(message)
        self._db = db
        self._lease_seconds = lease_seconds
        self._retention_seconds = retention_seconds
        self.max_entry_bytes = max_entry_bytes
        self._poll_interval_seconds = poll_interval_seconds

    async def claim(self, key: ReplayKey) -> ReplayLease:
        """Claim original work, join an in-flight duplicate, or replay completion.

        Args:
            key: Fully namespaced, hashed caller operation and canonical request.

        Returns:
            Lease identifying the caller's safe action.

        Raises:
            OpenAIProtocolError: The caller operation was reused with a
                different canonical body.
        """
        owner_token = uuid.uuid4()
        kind_text, cached = await asyncio.to_thread(self._claim, key, owner_token)
        match kind_text:
            case "conflict":
                raise OpenAIProtocolError(
                    status_code=409,
                    code="idempotency_conflict",
                    message="The caller operation was reused with a different request body.",
                    param="Idempotency-Key",
                )
            case "owner":
                kind = ReplayClaimKind.OWNER
            case "join":
                kind = ReplayClaimKind.JOIN
            case "replay":
                kind = ReplayClaimKind.REPLAY
            case _:
                message = "gateway replay claim returned an unknown kind"
                raise OpenAIProtocolError(
                    status_code=500,
                    code="idempotency_replay_unavailable",
                    message=message,
                    error_type="api_error",
                )
        return PostgresReplayLease(
            store=self,
            key=key,
            owner_token=owner_token,
            kind=kind,
            cached=cached,
        )

    def _claim(self, key: ReplayKey, owner_token: uuid.UUID) -> tuple[str, CachedResponse | None]:
        """Run one atomic claim and decode its outcome."""
        with self._db.transaction() as cursor:
            cursor.execute(
                "select kind, response_status, response_media_type, response_headers,"
                " response_body from public.gateway_replay_claim(%s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    key.namespace.organization_id,
                    key.namespace.identity_id,
                    key.namespace.alias_revision_id,
                    key.surface.value,
                    key.caller_operation_sha256,
                    key.canonical_request_sha256,
                    owner_token,
                    self._lease_seconds,
                ),
            )
            row = cursor.fetchone()
        if row is None:
            message = "gateway replay claim returned no outcome"
            raise OpenAIProtocolError(
                status_code=500,
                code="idempotency_replay_unavailable",
                message=message,
                error_type="api_error",
            )
        kind_text, status, media_type, headers_document, body = row
        if str(kind_text) != "replay":
            return str(kind_text), None
        return "replay", _cached_response(
            int(str(status)), str(media_type), headers_document, bytes(body)
        )

    async def _await_published(self, key: ReplayKey) -> CachedResponse:
        """Poll one claimed row until its owner publishes or provably vanishes."""
        while True:
            outcome, cached = await asyncio.to_thread(self._read, key)
            match outcome:
                case "published":
                    if cached is None:  # pragma: no cover - published rows carry content
                        raise _replay_unavailable()
                    return cached
                case "gone" | "lease_expired":
                    raise _replay_unavailable()
                case _:
                    await asyncio.sleep(self._poll_interval_seconds)

    def _read(self, key: ReplayKey) -> tuple[str, CachedResponse | None]:
        """Read one row's publication state without taking locks."""
        with self._db.transaction() as cursor:
            cursor.execute(
                """
                select operations.state,
                       operations.lease_expires_at <= clock_timestamp() as lease_expired,
                       operations.response_status, operations.response_media_type,
                       operations.response_headers, operations.response_body
                from public.gateway_replay_operations operations
                where operations.organization_id = %s and operations.identity_id = %s
                  and operations.alias_revision_id = %s and operations.api_surface = %s
                  and operations.caller_operation_sha256 = %s
                """,
                (
                    key.namespace.organization_id,
                    key.namespace.identity_id,
                    key.namespace.alias_revision_id,
                    key.surface.value,
                    key.caller_operation_sha256,
                ),
            )
            row = cursor.fetchone()
        if row is None:
            return "gone", None
        state, lease_expired, status, media_type, headers_document, body = row
        if str(state) == "published":
            return "published", _cached_response(
                int(str(status)), str(media_type), headers_document, bytes(body)
            )
        if bool(lease_expired):
            return "lease_expired", None
        return "claimed", None

    def _publish(self, key: ReplayKey, owner_token: uuid.UUID, response: CachedResponse) -> bool:
        """Publish the owner's exact response; False when ownership lapsed."""
        with self._db.transaction() as cursor:
            cursor.execute(
                "select published from public.gateway_replay_publish"
                "(%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    key.namespace.organization_id,
                    key.namespace.identity_id,
                    key.namespace.alias_revision_id,
                    key.surface.value,
                    key.caller_operation_sha256,
                    owner_token,
                    response.status_code,
                    response.media_type,
                    _headers_document(response),
                    response.body,
                    self._retention_seconds,
                ),
            )
            row = cursor.fetchone()
        return row is not None and bool(row[0])

    def _abandon(self, key: ReplayKey, owner_token: uuid.UUID) -> None:
        """Remove matching in-flight work without erasing a published result."""
        with self._db.transaction() as cursor:
            cursor.execute(
                "select public.gateway_replay_abandon(%s, %s, %s, %s, %s, %s)",
                (
                    key.namespace.organization_id,
                    key.namespace.identity_id,
                    key.namespace.alias_revision_id,
                    key.surface.value,
                    key.caller_operation_sha256,
                    owner_token,
                ),
            )


class PostgresContinuationStore:
    """Experiential ``ResponseContinuationStore`` shared across workers through Postgres."""

    def __init__(
        self,
        db: GatewayDatabase,
        *,
        retention_seconds: int = _RETENTION_SECONDS,
        max_entry_bytes: int = _MAX_ENTRY_BYTES,
    ) -> None:
        """Bind one pooled database and finite retention bounds.

        Args:
            db: Shared worker connection pool.
            retention_seconds: Continuation lifetime from its last remember.
            max_entry_bytes: Per-entry serialized size ceiling.
        """
        if retention_seconds <= 0 or max_entry_bytes <= 0:
            message = "continuation bounds must be positive"
            raise ValueError(message)
        self._db = db
        self._retention_seconds = retention_seconds
        self._max_entry_bytes = max_entry_bytes

    async def remember(
        self,
        *,
        namespace: ProtocolNamespace,
        response_id: str,
        state: ContinuationState,
    ) -> None:
        """Retain one completed Responses continuation within finite bounds.

        Args:
            namespace: Tenant, identity, and alias-revision boundary.
            response_id: Public completed response identity.
            state: Canonical history and hashed episode identity.

        Raises:
            OpenAIProtocolError: One continuation exceeds the entry byte ceiling.
        """
        await asyncio.to_thread(
            self.remember_now,
            namespace=namespace,
            response_id=response_id,
            state=state,
        )

    def remember_now(
        self,
        *,
        namespace: ProtocolNamespace,
        response_id: str,
        state: ContinuationState,
    ) -> None:
        """Synchronously retain state for native control-plane callback threads.

        Args:
            namespace: Tenant, identity, and alias-revision boundary.
            response_id: Public completed response identity.
            state: Canonical history and hashed episode identity.

        Raises:
            OpenAIProtocolError: One continuation exceeds the entry byte ceiling.
        """
        if state.size_bytes > self._max_entry_bytes:
            raise OpenAIProtocolError(
                status_code=400,
                code="continuation_unavailable",
                message="The response is too large for bounded durable continuation.",
                param="previous_response_id",
            )
        self._remember(namespace, response_id, state)

    async def resolve(
        self, *, namespace: ProtocolNamespace, previous_response_id: str
    ) -> ContinuationState:
        """Resolve an exact namespaced continuation or fail closed.

        Args:
            namespace: Current caller and immutable alias-revision boundary.
            previous_response_id: Public response identity to continue.

        Returns:
            Retained canonical history.

        Raises:
            OpenAIProtocolError: State is missing, expired, or cross-namespace.
        """
        return await asyncio.to_thread(
            self.resolve_now,
            namespace=namespace,
            previous_response_id=previous_response_id,
        )

    def resolve_now(
        self,
        *,
        namespace: ProtocolNamespace,
        previous_response_id: str,
    ) -> ContinuationState:
        """Synchronously resolve state for native control-plane callback threads.

        Args:
            namespace: Current caller and immutable alias-revision boundary.
            previous_response_id: Public response identity to continue.

        Returns:
            Retained canonical history.

        Raises:
            OpenAIProtocolError: State is missing, expired, or cross-namespace.
        """
        state = self._resolve(namespace, previous_response_id)
        if state is None:
            raise OpenAIProtocolError(
                status_code=400,
                code="continuation_unavailable",
                message="previous_response_id is unavailable or expired in this namespace.",
                param="previous_response_id",
            )
        return state

    def _remember(
        self, namespace: ProtocolNamespace, response_id: str, state: ContinuationState
    ) -> None:
        """Upsert one namespaced continuation with a fresh retention deadline."""
        messages = state.model_dump(mode="json")["messages"]
        with self._db.transaction() as cursor:
            cursor.execute(
                "select public.gateway_continuation_remember(%s, %s, %s, %s, %s, %s, %s)",
                (
                    namespace.organization_id,
                    namespace.identity_id,
                    namespace.alias_revision_id,
                    response_id,
                    state.episode_key,
                    Jsonb(messages),
                    self._retention_seconds,
                ),
            )

    def _resolve(
        self, namespace: ProtocolNamespace, previous_response_id: str
    ) -> ContinuationState | None:
        """Read one unexpired namespaced continuation."""
        with self._db.transaction() as cursor:
            cursor.execute(
                """
                select continuations.episode_key, continuations.messages
                from public.gateway_continuations continuations
                where continuations.organization_id = %s and continuations.identity_id = %s
                  and continuations.alias_revision_id = %s and continuations.response_id = %s
                  and continuations.expires_at > clock_timestamp()
                """,
                (
                    namespace.organization_id,
                    namespace.identity_id,
                    namespace.alias_revision_id,
                    previous_response_id,
                ),
            )
            row = cursor.fetchone()
        if row is None:
            return None
        episode_key, messages = row
        return ContinuationState.model_validate(
            {"episode_key": str(episode_key), "messages": messages}
        )
