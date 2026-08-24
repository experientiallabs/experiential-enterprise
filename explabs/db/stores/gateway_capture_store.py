# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Read/broadcast store over the opt-in captured-prompt table.

The write path lives in the gateway worker (explabs/gateway/capture.py); this
store serves the api process: the tenant reads behind the request log's
prompt expansion and the Insights group labels, and the broadcast tick's
work queue. Every tenant read is org-scoped inside the SQL function; the
queue is service-role machinery driven by the scheduled internal route,
never by tenants.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict

from explabs.db.repositories import JsonObject, SupabaseClient, result_rows, result_scalar_strings


class CapturedPromptRow(BaseModel):
    """One captured request prompt (org-scoped read)."""

    model_config = ConfigDict(frozen=True)

    request_id: str
    # The canonical GatewayMessage array as captured.
    messages: tuple[JsonObject, ...]
    captured_at: str

    @classmethod
    def from_row(cls, row: JsonObject) -> CapturedPromptRow:
        """Parse a captured-prompt RPC row."""
        return cls.model_validate(dict(row))


class PromptGroupSnippetRow(BaseModel):
    """The latest captured text snippet for one prompt group."""

    model_config = ConfigDict(frozen=True)

    prompt_sha256: str
    snippet: str
    captured_at: str

    @classmethod
    def from_row(cls, row: JsonObject) -> PromptGroupSnippetRow:
        """Parse a group-snippet RPC row."""
        return cls.model_validate(dict(row))


class CaptureExportRow(BaseModel):
    """One undelivered captured prompt, with its request's model alias."""

    model_config = ConfigDict(frozen=True)

    request_id: str
    org_id: str
    alias: str
    prompt_sha256: str | None = None
    messages: tuple[JsonObject, ...]
    captured_at: str

    @classmethod
    def from_row(cls, row: JsonObject) -> CaptureExportRow:
        """Parse a broadcast-queue RPC row."""
        return cls.model_validate(dict(row))


class GatewayCaptureStore:
    """RPC wrappers over ``gateway_captured_prompts``."""

    def __init__(self, client: SupabaseClient) -> None:
        """Bind the Supabase client."""
        self._client = client

    def read_prompt(self, org_id: str, request_id: str) -> CapturedPromptRow | None:
        """One request's captured prompt, or None when never captured."""
        result = self._client.rpc(
            "gateway_captured_prompt_read",
            {"in_org": org_id, "in_request_id": request_id},
        ).execute()
        rows = result_rows(result)
        if not rows:
            return None
        return CapturedPromptRow.from_row(rows[0])

    def group_snippets(self, org_id: str) -> tuple[PromptGroupSnippetRow, ...]:
        """The latest captured snippet per prompt group for one org."""
        result = self._client.rpc(
            "gateway_prompt_group_snippets",
            {"in_org": org_id},
        ).execute()
        return tuple(PromptGroupSnippetRow.from_row(row) for row in result_rows(result))

    def to_export(
        self, *, limit: int = 100, exclude_orgs: tuple[str, ...] = ()
    ) -> tuple[CaptureExportRow, ...]:
        """Oldest undelivered captures across all orgs (broadcast queue).

        ``exclude_orgs`` skips orgs whose destination already failed this
        tick, so the drain loop reaches rows queued behind that backlog.
        """
        result = self._client.rpc(
            "gateway_captured_prompts_to_export",
            {"in_limit": limit, "in_exclude_orgs": list(exclude_orgs)},
        ).execute()
        return tuple(CaptureExportRow.from_row(row) for row in result_rows(result))

    def mark_exported(self, request_ids: tuple[str, ...]) -> tuple[str, ...]:
        """Claim rows for delivery, returning exactly the claimed ids.

        The stamp re-verifies the org's CURRENT consent transactionally; the
        broadcaster must ship only what this returned.
        """
        if not request_ids:
            return ()
        result = self._client.rpc(
            "gateway_captured_prompts_mark_exported",
            {"p_request_ids": list(request_ids)},
        ).execute()
        return result_scalar_strings(result)

    def unmark_exported(self, request_ids: tuple[str, ...]) -> None:
        """Release claimed rows back to the queue after a failed ship."""
        if not request_ids:
            return
        self._client.rpc(
            "gateway_captured_prompts_unmark_exported",
            {"p_request_ids": list(request_ids)},
        ).execute()
