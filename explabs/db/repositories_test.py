# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for Supabase repository helpers."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest

from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.repositories import (
    RepositoryError,
    find_one_by_columns,
    first_row,
    insert_row,
    result_rows,
    result_scalar_int,
    update_by_id,
)


@dataclass(frozen=True)
class _SingleRowResult:
    """Supabase RPC result with a single mapping payload."""

    data: Any
    count: int | None = None


def test_repository_helpers_insert_find_and_update() -> None:
    """Repository helpers preserve row identities across operations."""
    client = FakeSupabaseClient()

    inserted = insert_row(client, "organizations", {"slug": "demo", "name": "Demo"})
    found = find_one_by_columns(client, "organizations", {"slug": "demo"})
    updated = update_by_id(client, "organizations", str(inserted["id"]), {"name": "Updated"})

    assert found is not None
    assert found["id"] == inserted["id"]
    assert updated["name"] == "Updated"


def test_update_by_id_raises_when_no_row_matches() -> None:
    """Missing updates fail loudly."""
    client = FakeSupabaseClient()

    with pytest.raises(RepositoryError, match="update organizations returned no rows"):
        update_by_id(client, "organizations", "missing", {"name": "Nope"})


def test_first_row_accepts_single_mapping_rpc_payload() -> None:
    """Supabase RPCs may return one object instead of a list of objects."""
    row = first_row(_SingleRowResult({"id": "org-1", "slug": "demo"}), context="rpc")

    assert row == {"id": "org-1", "slug": "demo"}


def test_result_scalar_int_reads_a_bare_postgrest_scalar() -> None:
    """A scalar-returning RPC lands as a bare int in data (the real shape)."""
    assert result_scalar_int(_SingleRowResult(5)) == 5
    assert result_scalar_int(_SingleRowResult(0)) == 0


def test_result_scalar_int_accepts_wrapped_and_string_shapes() -> None:
    """Defend the one-row-list, single-key-object, and stringified variants."""
    assert result_scalar_int(_SingleRowResult("7")) == 7
    assert result_scalar_int(_SingleRowResult([3])) == 3
    assert result_scalar_int(_SingleRowResult([{"scalar_rpc_result": 4}])) == 4
    assert result_scalar_int(_SingleRowResult({"count": 9})) == 9


def test_result_scalar_int_defaults_empty_to_zero() -> None:
    """An empty or absent result is zero, never an error."""
    assert result_scalar_int(_SingleRowResult(None)) == 0
    assert result_scalar_int(_SingleRowResult([])) == 0
    assert result_scalar_int(_SingleRowResult({})) == 0


def test_result_rows_rejects_a_scalar_payload() -> None:
    """A bare scalar (a mis-routed scalar RPC) fails loudly, not with a TypeError."""
    with pytest.raises(RepositoryError, match="result_scalar_int"):
        result_rows(_SingleRowResult(1))
