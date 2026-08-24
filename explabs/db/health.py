# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Supabase health checks for the Experiential Labs platform."""

from __future__ import annotations

from explabs.db.repositories import SupabaseClient


class SupabaseHealthError(RuntimeError):
    """Raised when the Supabase control plane is not ready."""


def assert_supabase_ready(client: SupabaseClient) -> None:
    """Assert that the platform Supabase schema is reachable.

    Args:
        client: Supabase client.

    Raises:
        SupabaseHealthError: If core tables are not queryable.
    """
    # organization_members has a composite (org_id, user_id) primary key and no
    # id column, so each probe names a column that exists on that table.
    required_tables = (
        ("organizations", "id"),
        ("organization_members", "org_id"),
    )
    for table_name, probe_column in required_tables:
        result = client.table(table_name).select(probe_column).limit(1).execute()
        if result.data is None:
            msg = f"{table_name} query returned an invalid response"
            raise SupabaseHealthError(msg)
