# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Shared status-transition helpers for the platform store modules.

Domain rows (world models, trace uploads, build jobs, wm sessions) all carry a
``status`` column driving a small lifecycle state machine. Transitions are
implemented as conditional updates filtered on the allowed source statuses so
a stale writer cannot silently regress a row; a transition that matches no row
fails loudly with the row's actual status.
"""

from __future__ import annotations

from datetime import UTC, datetime

from explabs.db.repositories import (
    JsonObject,
    JsonPayload,
    SupabaseClient,
    find_one_by_columns,
    payload_copy,
)


class StateTransitionError(RuntimeError):
    """Raised when a row is not in an allowed source status for a transition."""


def now_iso() -> str:
    """Return the current UTC timestamp as an ISO-8601 string.

    Returns:
        Timezone-aware ISO-8601 timestamp string.
    """
    return datetime.now(tz=UTC).isoformat()


def transition_row(
    client: SupabaseClient,
    table_name: str,
    row_id: str,
    payload: JsonPayload,
    *,
    allowed_from: tuple[str, ...],
    context: str,
) -> JsonObject:
    """Update a row only when its status is in the allowed source set.

    The status filter rides on the UPDATE itself, so the check-and-set is a
    single atomic statement under PostgREST rather than a read-then-write race.

    Args:
        client: Supabase client.
        table_name: Table name.
        row_id: Row identifier.
        payload: Update payload (should include the new ``status``).
        allowed_from: Statuses the row may currently be in.
        context: Operation label used in error messages.

    Returns:
        Updated row.

    Raises:
        StateTransitionError: If the row is missing or in a disallowed status.
    """
    result = (
        client.table(table_name)
        .update(payload_copy(payload))
        .eq("id", row_id)
        .in_("status", list(allowed_from))
        .execute()
    )
    rows = result.data
    if rows:
        return dict(rows[0])
    current = find_one_by_columns(client, table_name, {"id": row_id})
    if current is None:
        msg = f"{context}: {table_name} row {row_id} not found"
        raise StateTransitionError(msg)
    msg = (
        f"{context}: {table_name} row {row_id} is in status {current.get('status')!r}, "
        f"expected one of {allowed_from}"
    )
    raise StateTransitionError(msg)
