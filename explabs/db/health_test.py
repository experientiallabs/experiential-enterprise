# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for Supabase health checks."""

from __future__ import annotations

from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.health import assert_supabase_ready


def test_assert_supabase_ready_queries_core_tables() -> None:
    """Health checks touch every core table."""
    client = FakeSupabaseClient()

    assert_supabase_ready(client)

    assert set(client.tables) == {
        "organizations",
        "organization_members",
    }
