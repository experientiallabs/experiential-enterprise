# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for database ID helpers."""

from __future__ import annotations

from uuid import UUID

from explabs.db.ids import new_uuid


def test_new_uuid_returns_valid_uuid_string() -> None:
    """New IDs are valid UUID strings."""
    UUID(new_uuid())
