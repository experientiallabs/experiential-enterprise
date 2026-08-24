# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""ID helpers for persisted platform records."""

from __future__ import annotations

from uuid import uuid4


def new_uuid() -> str:
    """Return a new UUID string.

    Returns:
        UUID string.
    """
    return str(uuid4())
