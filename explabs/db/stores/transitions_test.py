# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for shared status-transition helpers."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.stores.transitions import StateTransitionError, now_iso, transition_row


def test_now_iso_returns_utc_iso_timestamp() -> None:
    """Timestamps are timezone-aware UTC ISO-8601 strings."""
    stamp = now_iso()

    parsed = datetime.fromisoformat(stamp)
    assert parsed.tzinfo is not None
    assert parsed.utcoffset() == UTC.utcoffset(None)


def test_transition_row_updates_row_in_allowed_status() -> None:
    """A row in an allowed source status is updated and returned."""
    client = FakeSupabaseClient()
    client.tables["build_jobs"] = [{"id": "job-1", "status": "queued"}]

    row = transition_row(
        client,
        "build_jobs",
        "job-1",
        {"status": "claimed", "worker_id": "w-1"},
        allowed_from=("queued",),
        context="claim build job",
    )

    assert row["status"] == "claimed"
    assert client.tables["build_jobs"][0]["worker_id"] == "w-1"


def test_transition_row_rejects_disallowed_source_status() -> None:
    """Transitions fail loudly with the row's actual status in the message."""
    client = FakeSupabaseClient()
    client.tables["build_jobs"] = [{"id": "job-1", "status": "completed"}]

    with pytest.raises(StateTransitionError, match="'completed'"):
        transition_row(
            client,
            "build_jobs",
            "job-1",
            {"status": "claimed"},
            allowed_from=("queued",),
            context="claim build job",
        )
    assert client.tables["build_jobs"][0]["status"] == "completed"


def test_transition_row_rejects_missing_row() -> None:
    """Transitions on unknown rows fail loudly."""
    client = FakeSupabaseClient()

    with pytest.raises(StateTransitionError, match="not found"):
        transition_row(
            client,
            "build_jobs",
            "missing",
            {"status": "claimed"},
            allowed_from=("queued",),
            context="claim build job",
        )
