# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Route modules and shared route dependencies for the platform API."""

from __future__ import annotations

from typing import cast

from fastapi import Request

from explabs.db.client import get_supabase_client
from explabs.db.repositories import (
    JsonObject,
    SupabaseClient,
    find_one_by_columns,
)


class ApiError(RuntimeError):
    """API error with an explicit HTTP status code.

    Raised by route handlers for typed request failures (404/409/413/422) and
    rendered by the app-level exception handler as ``{"error": message}``,
    with optional stable ``code`` and ``action`` fields.
    """

    def __init__(
        self,
        message: str,
        *,
        status_code: int,
        code: str | None = None,
        action: str | None = None,
    ) -> None:
        """Initialize the error.

        Args:
            message: Human-facing error message.
            status_code: HTTP status code to respond with.
            code: Optional stable customer-safe machine reason.
            action: Optional stable customer-safe remediation action.
        """
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.action = action


def get_supabase(request: Request) -> SupabaseClient:
    """Return the app's Supabase client, constructing it on first use."""
    client = getattr(request.app.state, "supabase_client", None)
    if client is None:
        client = get_supabase_client(service_role=True)
        request.app.state.supabase_client = client
    return cast("SupabaseClient", client)


def load_org_row(client: SupabaseClient, org_id: str) -> JsonObject:
    """Fetch an organization row or fail with a typed 404.

    Args:
        client: Supabase client.
        org_id: Organization identifier.

    Returns:
        Raw organization row (callers gate on the org with
        ``require_org_role`` after this existence check).

    Raises:
        ApiError: 404 if the organization does not exist.
    """
    row = find_one_by_columns(client, "organizations", {"id": org_id})
    if row is None:
        msg = f"Organization not found: {org_id}"
        raise ApiError(msg, status_code=404)
    return row
