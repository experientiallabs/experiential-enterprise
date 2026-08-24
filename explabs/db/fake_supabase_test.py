# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Reusable fake Supabase client for repository tests."""

from __future__ import annotations

import calendar
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import cast

import httpx
from postgrest.exceptions import APIError as PostgrestAPIError

from explabs.db.repositories import JsonObject, JsonPayload, SupabaseStorage

# PostgREST caps an unbounded select at this many rows (Supabase's default
# ``db-max-rows``). A read that neither ranges nor limits silently truncates
# here, so the fake enforces it: paging bugs surface in tests instead of prod.
_POSTGREST_DEFAULT_MAX_ROWS = 1000


@dataclass(frozen=True)
class FakeResult:
    """Fake Supabase query result; RPC scalar values are cast at the boundary."""

    data: list[JsonObject]
    count: int | None = None


def _fake_num(value: object) -> float:
    """Coerce an untyped fake-table value to a number (JsonObject values are object)."""
    return float(value) if isinstance(value, (int, float)) else 0.0


def _fake_int(value: object, default: int) -> int:
    """Coerce an untyped fake RPC/table value to int, or use ``default``."""
    if isinstance(value, bool) or not isinstance(value, int | str):
        return default
    return int(value)


def _fake_avg(values: list[object]) -> float | None:
    """Average the non-null numeric values (SQL ``avg`` ignores nulls)."""
    present = [float(v) for v in values if isinstance(v, (int, float))]
    return sum(present) / len(present) if present else None


def _shift_months(moment: datetime, months: int) -> datetime:
    """Add calendar months like Postgres ``interval 'N months'`` (day clamped)."""
    month_index = moment.month - 1 + months
    year = moment.year + month_index // 12
    month = month_index % 12 + 1
    day = min(moment.day, calendar.monthrange(year, month)[1])
    return moment.replace(year=year, month=month, day=day)


class FakeSupabaseClient:
    """In-memory Supabase client for unit tests."""

    def __init__(self) -> None:
        """Initialize empty fake tables and storage."""
        self.tables: dict[str, list[JsonObject]] = {}
        self.fake_storage = FakeStorage()
        self.storage: SupabaseStorage = self.fake_storage
        self.executed_selects: list[str] = []
        self.executed_rpcs: list[str] = []
        # One entry per write round-trip (execute call), keyed by table name, so
        # tests can assert that bulk writes stay constant as row counts grow.
        self.write_counts: dict[str, int] = {}
        # Fake Vault: trace-connection credentials keyed by connection id, so
        # ingest tests can round-trip upsert -> release without real Vault.
        self.vault_secrets: dict[str, str] = {}
        # Columns the database fills with `generated always as identity`, which
        # reads depend on: `run_events.pos` is the arrival-order cursor the run
        # tail pages by, so an insert here has to assign it like Postgres does.
        self.identity_columns: dict[str, str] = {"run_events": "pos"}
        self._identity_counters: dict[str, int] = {}

    def next_identity(self, table_name: str) -> int:
        """Return the next table-global identity value, mirroring Postgres."""
        value = self._identity_counters.get(table_name, 0) + 1
        self._identity_counters[table_name] = value
        return value

    def table(self, table_name: str) -> FakeQuery:
        """Return a fake table query builder."""
        self.tables.setdefault(table_name, [])
        return FakeQuery(client=self, table_name=table_name)

    def rpc(self, fn: str, params: JsonPayload | None = None) -> FakeQuery:
        """Return a fake RPC query builder."""
        return FakeQuery(
            client=self,
            table_name="rpc",
            operation="rpc",
            rpc_name=fn,
            rpc_params=dict(params or {}),
        )

    def next_id(self, table_name: str) -> str:
        """Return a deterministic row ID for a table."""
        return f"{table_name}-{len(self.tables.setdefault(table_name, [])) + 1}"


@dataclass
class FakeQuery:
    """In-memory Supabase query builder."""

    client: FakeSupabaseClient
    table_name: str
    operation: str = "select"
    payloads: list[JsonObject] = field(default_factory=list)
    filters: list[tuple[str, object]] = field(default_factory=list)
    not_is_filters: list[tuple[str, object]] = field(default_factory=list)
    in_filters: list[tuple[str, list[object]]] = field(default_factory=list)
    gt_filters: list[tuple[str, object]] = field(default_factory=list)
    gte_filters: list[tuple[str, object]] = field(default_factory=list)
    lte_filters: list[tuple[str, object]] = field(default_factory=list)
    order_by: list[tuple[str, bool]] = field(default_factory=list)
    limit_count: int | None = None
    range_window: tuple[int, int] | None = None
    count_mode: str | None = None
    on_conflict: str | None = None
    rpc_name: str | None = None
    rpc_params: JsonObject = field(default_factory=dict)
    ignore_duplicates: bool = False

    def select(self, columns: str = "*", *, count: str | None = None) -> FakeQuery:
        """Record a select operation, optionally requesting a total count."""
        _ = columns
        self.operation = "select"
        self.count_mode = count
        return self

    def insert(self, json: JsonPayload | Sequence[JsonPayload]) -> FakeQuery:
        """Record an insert operation."""
        self.operation = "insert"
        self.payloads = _payload_sequence(json)
        return self

    def upsert(
        self,
        json: JsonPayload | Sequence[JsonPayload],
        *,
        on_conflict: str | None = None,
        ignore_duplicates: bool = False,
    ) -> FakeQuery:
        """Record an upsert operation."""
        self.operation = "upsert"
        self.payloads = _payload_sequence(json)
        self.on_conflict = on_conflict
        self.ignore_duplicates = ignore_duplicates
        return self

    def update(self, json: JsonPayload) -> FakeQuery:
        """Record an update operation."""
        self.operation = "update"
        self.payloads = [dict(json)]
        return self

    def delete(self) -> FakeQuery:
        """Record a delete operation."""
        self.operation = "delete"
        return self

    def eq(self, column: str, value: object) -> FakeQuery:
        """Add an equality filter."""
        self.filters.append((column, value))
        return self

    def in_(self, column: str, values: Sequence[object]) -> FakeQuery:
        """Add a membership filter matching rows whose column is in values."""
        self.in_filters.append((column, list(values)))
        return self

    def is_(self, column: str, value: object) -> FakeQuery:
        """Add an IS filter; PostgREST spells SQL NULL as the string "null"."""
        self.filters.append((column, None if value == "null" else value))
        return self

    @property
    def not_(self) -> _FakeNegation:
        """Negation proxy mirroring postgrest-py's ``query.not_.is_(...)``."""
        return _FakeNegation(self)

    def gt(self, column: str, value: object) -> FakeQuery:
        """Add a greater-than filter."""
        self.gt_filters.append((column, value))
        return self

    def gte(self, column: str, value: object) -> FakeQuery:
        """Add a greater-than-or-equal filter."""
        self.gte_filters.append((column, value))
        return self

    def lte(self, column: str, value: object) -> FakeQuery:
        """Add a less-than-or-equal filter."""
        self.lte_filters.append((column, value))
        return self

    def order(self, column: str, *, desc: bool = False) -> FakeQuery:
        """Record a result ordering."""
        self.order_by.append((column, desc))
        return self

    def limit(self, count: int) -> FakeQuery:
        """Record a result limit."""
        self.limit_count = count
        return self

    def range(self, start: int, end: int) -> FakeQuery:
        """Record an inclusive [start, end] result window."""
        self.range_window = (start, end)
        return self

    def execute(self) -> FakeResult:
        """Execute the fake query."""
        match self.operation:
            case "insert":
                self._record_write()
                return FakeResult(self._insert())
            case "upsert":
                self._record_write()
                return FakeResult(self._upsert())
            case "update":
                self._record_write()
                return FakeResult(self._update())
            case "delete":
                self._record_write()
                return FakeResult(self._delete())
            case "select":
                rows, total = self._select_with_total()
                return FakeResult(rows, count=total if self.count_mode is not None else None)
            case "rpc":
                # PostgREST returns a scalar-returning function's result BARE in
                # ``data`` (an int, not a row list). Mirror that here so a store
                # that wrongly routes such an RPC through result_rows fails in the
                # test exactly as it would in production. The cast keeps
                # FakeResult conformant to the row-typed protocol at this test
                # boundary; result_scalar_int reads the scalar back out.
                return FakeResult(cast("list[JsonObject]", self._rpc()))
            case _:
                msg = f"unsupported fake operation {self.operation}"
                raise RuntimeError(msg)

    def _record_write(self) -> None:
        """Count one write round-trip against the target table."""
        counts = self.client.write_counts
        counts[self.table_name] = counts.get(self.table_name, 0) + 1

    def _insert(self) -> list[JsonObject]:
        """Insert fake rows."""
        table = self.client.tables.setdefault(self.table_name, [])
        inserted: list[JsonObject] = []
        for payload in self.payloads:
            row = self._new_row(payload)
            table.append(row)
            inserted.append(dict(row))
        return inserted

    def _new_row(self, payload: JsonObject) -> JsonObject:
        """Build one row the way the database would, filling generated columns.

        Identity values are assigned on INSERT only: an upsert that resolves to
        an existing row must keep the position it was first given.

        Values are consumed the way Postgres consumes them, including for rows
        that ``ON CONFLICT DO NOTHING`` discards (see ``_upsert``), so a
        replayed batch leaves holes here as it does in production.
        Strictly-increasing-with-arrival is the only property either side
        guarantees; asserting literal identity values asserts nothing real.
        """
        row = dict(payload)
        row.setdefault("id", self.client.next_id(self.table_name))
        identity = self.client.identity_columns.get(self.table_name)
        if identity is not None:
            row[identity] = self.client.next_identity(self.table_name)
        return row

    def _upsert(self) -> list[JsonObject]:
        """Upsert fake rows."""
        if self.on_conflict is None:
            return self._insert()
        conflict_columns = tuple(column.strip() for column in self.on_conflict.split(","))
        table = self.client.tables.setdefault(self.table_name, [])
        upserted: list[JsonObject] = []
        for payload in self.payloads:
            existing = _find_conflict(table, payload, conflict_columns)
            if existing is None:
                row = self._new_row(payload)
                table.append(row)
                upserted.append(dict(row))
            elif self.ignore_duplicates:
                # PostgREST resolution=ignore-duplicates: the conflicting row
                # is left untouched and not returned. Postgres still evaluates
                # the candidate row's identity default before discarding it, so
                # burn the value here too — otherwise a replay-heavy test would
                # see gapless positions that production never produces.
                if self.client.identity_columns.get(self.table_name) is not None:
                    self.client.next_identity(self.table_name)
                continue
            else:
                existing.update(payload)
                upserted.append(dict(existing))
        return upserted

    def _update(self) -> list[JsonObject]:
        """Update fake rows honoring both eq and in_ filters, like PostgREST."""
        table = self.client.tables.setdefault(self.table_name, [])
        payload = self.payloads[0]
        updated: list[JsonObject] = []
        for row in table:
            if (
                _matches(row, self.filters)
                and _matches_not_is(row, self.not_is_filters)
                and _matches_in(row, self.in_filters)
                and _matches_gt(row, self.gt_filters)
                and _matches_gte(row, self.gte_filters)
                and _matches_lte(row, self.lte_filters)
            ):
                row.update(payload)
                updated.append(dict(row))
        return updated

    def _delete(self) -> list[JsonObject]:
        """Delete matching fake rows, returning deleted copies like PostgREST."""
        table = self.client.tables.setdefault(self.table_name, [])
        remaining: list[JsonObject] = []
        deleted: list[JsonObject] = []
        for row in table:
            if (
                _matches(row, self.filters)
                and _matches_not_is(row, self.not_is_filters)
                and _matches_in(row, self.in_filters)
                and _matches_gt(row, self.gt_filters)
                and _matches_gte(row, self.gte_filters)
                and _matches_lte(row, self.lte_filters)
            ):
                deleted.append(dict(row))
            else:
                remaining.append(row)
        self.client.tables[self.table_name] = remaining
        return deleted

    def _gateway_budget_balances(self) -> list[JsonObject]:
        """Fake the P-D budgets read seam: budget rows with derived spend.

        The real function computes reserved/settled from gateway_attempts with
        the enforcement scope resolution; the fake sums any seeded
        ``gateway_budget_spend`` helper rows keyed by budget_id so route tests
        can assert a meter without reproducing the SQL join. Budgets with no
        seeded spend report zero, which is the common case.
        """
        org_id = self.rpc_params.get("p_org_id")
        period = self.rpc_params.get("p_period")
        # Recurring ('*') rows govern every month, so they fold into any
        # month's read exactly like the real seam.
        budgets = [
            dict(row)
            for row in self.client.tables.get("gateway_budgets", [])
            if row.get("org_id") == org_id and row.get("period") in (period, "*")
        ]
        spend_rows = self.client.tables.get("gateway_budget_spend", [])
        spend_by_budget: dict[str, JsonObject] = {}
        for spend in spend_rows:
            budget_id = spend.get("budget_id")
            if isinstance(budget_id, str):
                spend_by_budget[budget_id] = spend
        empty: JsonObject = {}
        results: list[JsonObject] = []
        for budget in budgets:
            spend = spend_by_budget.get(str(budget.get("budget_id"))) or empty
            results.append(
                {
                    "budget_id": budget.get("budget_id"),
                    "period": budget.get("period"),
                    "scope_kind": budget.get("scope_kind"),
                    "api_key_id": budget.get("api_key_id"),
                    "identity_id": budget.get("identity_id"),
                    "alias_id": budget.get("alias_id"),
                    "pool_id": budget.get("pool_id"),
                    "deployment_id": budget.get("deployment_id"),
                    "limit_micro_usd": budget.get("limit_micro_usd"),
                    "reserved_micro_usd": spend.get("reserved_micro_usd", 0),
                    "settled_micro_usd": spend.get("settled_micro_usd", 0),
                }
            )
        return results

    def _select(self) -> list[JsonObject]:
        """Select fake rows."""
        rows, _total = self._select_with_total()
        return rows

    def _select_with_total(self) -> tuple[list[JsonObject], int]:
        """Select fake rows plus the pre-window total, like PostgREST count=exact."""
        self.client.executed_selects.append(self.table_name)
        table = self.client.tables.setdefault(self.table_name, [])
        rows = [
            dict(row)
            for row in table
            if _matches(row, self.filters)
            and _matches_not_is(row, self.not_is_filters)
            and _matches_in(row, self.in_filters)
            and _matches_gt(row, self.gt_filters)
            and _matches_gte(row, self.gte_filters)
            and _matches_lte(row, self.lte_filters)
        ]
        # Apply orderings in reverse so the first recorded order wins, matching SQL.
        for column, descending in reversed(self.order_by):
            rows.sort(
                key=lambda row, column=column: _order_key(row.get(column)), reverse=descending
            )
        total = len(rows)
        if self.range_window is None and self.limit_count is None:
            # An unbounded read truncates at PostgREST's default cap, matching prod.
            rows = rows[:_POSTGREST_DEFAULT_MAX_ROWS]
        if self.range_window is not None:
            start, end = self.range_window
            rows = rows[start : end + 1]
        if self.limit_count is not None:
            rows = rows[: self.limit_count]
        return rows, total

    def _auth_user_verification(self) -> list[JsonObject]:
        """Mirror the definer read: one row of email + inbox_proven.

        Email comes from the seeded ``auth_users`` table; ``inbox_proven`` mirrors
        the decoupled inbox-proof signal -- the user is the FOUNDING admin
        (earliest ``organization_members`` admin row) of an org whose
        ``spend_unlocked_at`` is set -- so the domain-join gate exercises the same
        signal the spend gate uses, not the raw login flag.
        """
        target = self.rpc_params.get("target_user_id")
        user = next(
            (row for row in self.client.tables.get("auth_users", []) if row.get("id") == target),
            None,
        )
        if user is None:
            return []
        return [{"email": user.get("email"), "inbox_proven": self._inbox_proven(target)}]

    def _inbox_proven(self, user_id: object) -> bool:
        """Whether ``user_id`` is the founding admin of any spend-unlocked org."""
        members = self.client.tables.get("organization_members", [])
        orgs = {org.get("id"): org for org in self.client.tables.get("organizations", [])}
        for member in members:
            if member.get("user_id") != user_id or member.get("role") != "admin":
                continue
            org = orgs.get(member.get("org_id"))
            if org is None or org.get("spend_unlocked_at") is None:
                continue
            admin_created = [
                (other.get("created_at") or "")
                for other in members
                if other.get("org_id") == member.get("org_id") and other.get("role") == "admin"
            ]
            if (member.get("created_at") or "") == min(admin_created):
                return True
        return False

    def _approve_org_join_request(self) -> list[JsonObject]:
        """Mirror approve_org_join_request: settle + grant membership atomically.

        A pending request flips to approved and inserts an organization_members
        row (on-conflict-do-nothing); an already-decided request is returned
        unchanged and grants nothing.
        """
        request_id = self.rpc_params.get("p_request_id")
        decided_by = self.rpc_params.get("p_decided_by")
        requests = self.client.tables.setdefault("org_join_requests", [])
        target = next((row for row in requests if row.get("id") == request_id), None)
        if target is None:
            return []
        if target.get("status") == "pending":
            target["status"] = "approved"
            target["decided_at"] = "2026-08-21T00:00:00Z"
            target["decided_by"] = decided_by
            members = self.client.tables.setdefault("organization_members", [])
            already = any(
                member.get("org_id") == target.get("org_id")
                and member.get("user_id") == target.get("user_id")
                for member in members
            )
            if not already:
                members.append(
                    {
                        "org_id": target.get("org_id"),
                        "user_id": target.get("user_id"),
                        "role": "user",
                    }
                )
        return [dict(target)]

    def _rpc(self) -> list[JsonObject] | list[str] | int | bool:
        """Run a fake RPC.

        Most functions return a row list; a scalar-returning function returns a
        bare int, and a set-returning scalar function returns a bare list of
        scalar values, mirroring the shapes PostgREST sends.
        """
        if self.rpc_name is not None:
            self.client.executed_rpcs.append(self.rpc_name)
        handlers: dict[str, Callable[[], list[JsonObject] | list[str] | int | bool]] = {
            "list_org_secrets": list,
            "record_wm_step": self._record_wm_step,
            "catalog_like_counts": self._catalog_like_counts,
            "rollback_catalog_import": self._rollback_catalog_import,
            "ensure_account_starter_world_model": self._ensure_account_starter_world_model,
            "search_telemetry_spans": self._search_telemetry_spans,
            "list_telemetry_groups": self._list_telemetry_groups,
            "list_serving_requests": self._list_serving_requests,
            "serving_request_stats": self._serving_request_stats,
            "list_serving_request_buckets": self._list_serving_request_buckets,
            "list_serving_endpoints": self._list_serving_endpoints,
            "apply_yc_launch_grant": self._apply_yc_launch_grant,
            "process_expiring_grants": self._process_expiring_grants,
            "set_org_welcome_trigger": self._set_org_welcome_trigger,
            "apply_welcome_trigger_by_label": self._apply_welcome_trigger_by_label,
            "claim_welcome_trigger_showing": self._claim_welcome_trigger_showing,
            "upsert_trace_connection": self._upsert_trace_connection,
            "release_trace_connection_credential": self._release_trace_connection_credential,
            "complete_telemetry_trace_ingest": self._complete_telemetry_trace_ingest,
            "accept_telemetry_trace_ingest": self._accept_telemetry_trace_ingest,
            "record_telemetry_trace_object": self._record_telemetry_trace_object,
            "fail_telemetry_trace_ingest": self._fail_telemetry_trace_ingest,
            "claim_abandoned_telemetry_trace_ingests": (
                self._claim_abandoned_telemetry_trace_ingests
            ),
            "ack_abandoned_telemetry_trace_ingest": self._ack_abandoned_telemetry_trace_ingest,
            "claim_trace_clickhouse_projection": self._claim_trace_clickhouse_projection,
            "ack_trace_clickhouse_projection": self._ack_trace_clickhouse_projection,
            "nack_trace_clickhouse_projection": self._nack_trace_clickhouse_projection,
            "claim_trace_clickhouse_deletion": self._claim_trace_clickhouse_deletion,
            "ack_trace_clickhouse_deletion": self._ack_trace_clickhouse_deletion,
            "nack_trace_clickhouse_deletion": self._nack_trace_clickhouse_deletion,
            "register_optimizer_project_trace_source": (
                self._register_optimizer_project_trace_source
            ),
            "endpoint_usage_rollup": self._endpoint_usage_rollup,
            "endpoint_usage_timeseries": self._endpoint_usage_timeseries,
            "gateway_usage_timeseries": self._gateway_usage_timeseries,
            "gateway_usage_by_key": self._gateway_usage_by_key,
            "gateway_usage_by_provider": self._gateway_usage_by_provider,
            "gateway_usage_by_prompt": self._gateway_usage_by_prompt,
            "gateway_captured_prompt_read": self._gateway_captured_prompt_read,
            "gateway_prompt_group_snippets": self._gateway_prompt_group_snippets,
            "gateway_captured_prompts_to_export": self._gateway_captured_prompts_to_export,
            "gateway_captured_prompts_mark_exported": self._gateway_captured_prompts_mark_exported,
            "gateway_captured_prompts_unmark_exported": self._gateway_captured_prompts_unmark_exported,
            "gateway_imported_usage_by_model": self._gateway_imported_usage_by_model,
            "gateway_observed_model_stats": self._gateway_observed_model_stats,
            "gateway_insights_metrics": self._gateway_insights_metrics,
            "gateway_insights_tokens_per_second": self._gateway_insights_tokens_per_second,
            "gateway_insights_top_apps": self._gateway_insights_top_apps,
            "list_gateway_usage_events": self._list_gateway_usage_events,
            "upsert_provider_connection": self._upsert_provider_connection,
            "release_provider_connection_credential": self._release_provider_connection_credential,
            "set_provider_connection_spend_credential": (
                self._set_provider_connection_spend_credential
            ),
            "release_provider_connection_spend_credential": (
                self._release_provider_connection_spend_credential
            ),
            "delete_provider_connection": self._delete_provider_connection,
            "set_tool_account_credential": self._set_tool_account_credential,
            "release_tool_account_credential": self._release_tool_account_credential,
            "delete_tool_account": self._delete_tool_account,
            "get_optimizer_project_available_credit": (
                self._get_optimizer_project_available_credit
            ),
            "get_optimizer_project_setup": self._get_optimizer_project_setup,
            "replace_optimizer_project_setup": self._replace_optimizer_project_setup,
            "list_runs": self._list_runs,
            "list_run_cells": self._list_run_cells,
            "run_cell_stats": self._run_cell_stats,
            "adopt_default_model": self._adopt_default_model,
            "get_optimizer_project_result_projection": self._get_project_result_projection,
            "gateway_usage_daily_read": self._gateway_usage_daily_read,
            "gateway_usage_platform_read": self._gateway_usage_platform_read,
            "model_promotion_apply": self._model_promotion_apply,
            "recommended_models_apply": self._recommended_models_apply,
            "add_org_label": self._add_org_label,
            "remove_org_label": self._remove_org_label,
            "add_org_admin_note": self._add_org_admin_note,
            "delete_org_admin_note": self._delete_org_admin_note,
            "gateway_usage_events_read": self._gateway_usage_events_read,
            "gateway_key_limits_effective": self._gateway_key_limits_effective,
            "gateway_budget_balances": self._gateway_budget_balances,
            "auth_user_verification": self._auth_user_verification,
            "approve_org_join_request": self._approve_org_join_request,
        }
        handler = handlers.get(self.rpc_name or "")
        if handler is None:
            msg = f"unsupported fake rpc {self.rpc_name}"
            raise RuntimeError(msg)
        return handler()

    def _complete_telemetry_trace_ingest(self) -> list[JsonObject]:
        """Mirror the atomic receipt completion and projection enqueue RPC."""
        ingest_id = self.rpc_params.get("in_ingest_id")
        path = self.rpc_params.get("in_result_path")
        ingests = self.client.tables.setdefault("trace_ingests", [])
        target = next(
            (
                row
                for row in ingests
                if row.get("id") == ingest_id
                and row.get("world_model_id") is None
                and row.get("upload_path") == path
            ),
            None,
        )
        if target is None:
            msg = "router-free telemetry trace ingest not found"
            raise RuntimeError(msg)
        target.update(
            {
                "status": "done",
                "result_path": path,
                "trace_count": self.rpc_params.get("in_trace_count"),
                "step_count": 0,
                "trace_upload_id": None,
                "object_sha256": self.rpc_params.get("in_object_sha256"),
                "byte_size": self.rpc_params.get("in_byte_size"),
                "trace_projection_status": "pending",
                "trace_projection_version": self.rpc_params.get("in_projection_version"),
                "trace_projected_rows": None,
                "trace_projected_at": None,
                "trace_projection_error_code": None,
                "updated_at": datetime.now(UTC).isoformat(),
            }
        )
        queue = self.client.tables.setdefault("trace_clickhouse_projections", [])
        queued = next((row for row in queue if row.get("ingest_id") == ingest_id), None)
        payload: JsonObject = {
            "ingest_id": ingest_id,
            "org_id": target.get("org_id"),
            "projection_version": self.rpc_params.get("in_projection_version"),
            "state": "pending",
            "attempts": 0,
        }
        if queued is None:
            queue.append(payload)
        else:
            queued.update(payload)
        return [dict(target)]

    def _accept_telemetry_trace_ingest(self) -> list[JsonObject]:
        """Mirror accept: pending → running and enqueue one projection job."""
        ingest_id = self.rpc_params.get("in_ingest_id")
        target = next(
            (
                row
                for row in self.client.tables.setdefault("trace_ingests", [])
                if row.get("id") == ingest_id and row.get("world_model_id") is None
            ),
            None,
        )
        if target is None:
            msg = "router-free telemetry trace ingest not found"
            raise RuntimeError(msg)
        if target.get("status") == "pending":
            target.update(
                {
                    "status": "running",
                    "result_path": target.get("result_path") or target.get("upload_path"),
                    "trace_projection_status": "pending",
                    "trace_projection_version": target.get("trace_projection_version") or 1,
                    "trace_projection_error_code": None,
                    "updated_at": datetime.now(UTC).isoformat(),
                }
            )
        if target.get("status") in {"pending", "running"} or (
            target.get("status") == "done" and target.get("trace_projection_status") != "done"
        ):
            queue = self.client.tables.setdefault("trace_clickhouse_projections", [])
            if not any(row.get("ingest_id") == ingest_id for row in queue):
                queue.append(
                    {
                        "ingest_id": ingest_id,
                        "org_id": target.get("org_id"),
                        "projection_version": target.get("trace_projection_version") or 1,
                        "state": "pending",
                        "attempts": 0,
                    }
                )
        return [dict(target)]

    def _record_telemetry_trace_object(self) -> list[JsonObject]:
        """Mirror worker-computed object identity while a claim is live."""
        ingest_id = self.rpc_params.get("in_ingest_id")
        claim_token = self.rpc_params.get("in_claim_token")
        queued = next(
            (
                row
                for row in self.client.tables.setdefault("trace_clickhouse_projections", [])
                if row.get("ingest_id") == ingest_id
                and row.get("state") == "running"
                and row.get("claim_token") == claim_token
            ),
            None,
        )
        target = next(
            (
                row
                for row in self.client.tables.setdefault("trace_ingests", [])
                if row.get("id") == ingest_id and row.get("world_model_id") is None
            ),
            None,
        )
        if queued is None or target is None:
            msg = "verified telemetry trace object could not be recorded"
            raise RuntimeError(msg)
        target.update(
            {
                "object_sha256": self.rpc_params.get("in_object_sha256"),
                "byte_size": self.rpc_params.get("in_byte_size"),
                "trace_count": self.rpc_params.get("in_trace_count"),
                "result_path": target.get("result_path") or target.get("upload_path"),
                "updated_at": datetime.now(UTC).isoformat(),
            }
        )
        return [dict(target)]

    def _fail_telemetry_trace_ingest(self) -> bool:
        """Mirror a claim-fenced terminal validation failure."""
        ingest_id = self.rpc_params.get("in_ingest_id")
        claim_token = self.rpc_params.get("in_claim_token")
        queue = self.client.tables.setdefault("trace_clickhouse_projections", [])
        owned = next(
            (
                row
                for row in queue
                if row.get("ingest_id") == ingest_id
                and row.get("state") == "running"
                and row.get("claim_token") == claim_token
            ),
            None,
        )
        if owned is None:
            return False
        queue.remove(owned)
        target = next(
            (
                row
                for row in self.client.tables.setdefault("trace_ingests", [])
                if row.get("id") == ingest_id
            ),
            None,
        )
        if target is not None:
            error_code = self.rpc_params.get("in_error_code")
            target.update(
                {
                    "status": "error",
                    "error_code": error_code,
                    "error_message": self.rpc_params.get("in_error_message"),
                    "trace_projection_status": "error",
                    "trace_projection_error_code": error_code,
                    "updated_at": datetime.now(UTC).isoformat(),
                }
            )
        return True

    def _claim_abandoned_telemetry_trace_ingests(self) -> list[JsonObject]:
        """Return abandoned or failed uploads that still own an object path."""
        older_than = _fake_int(self.rpc_params.get("in_older_than_seconds"), 7200)
        limit = _fake_int(self.rpc_params.get("in_limit"), 16)
        now = datetime.now(UTC)
        claimed: list[JsonObject] = []
        for row in self.client.tables.setdefault("trace_ingests", []):
            if row.get("world_model_id") is not None or not row.get("upload_path"):
                continue
            created = datetime.fromisoformat(str(row.get("created_at") or now.isoformat()))
            pending_stale = (
                row.get("status") == "pending"
                and row.get("trace_projection_status") is None
                and (now - created).total_seconds() >= older_than
            )
            failed = row.get("status") == "error" and row.get("error_code") in {
                "abandoned_upload",
                "object_missing",
                "object_too_large",
                "object_malformed",
            }
            if not pending_stale and not failed:
                continue
            row.update(
                {
                    "status": "error",
                    "error_code": row.get("error_code") or "abandoned_upload",
                    "error_message": row.get("error_message") or "abandoned signed upload",
                    "updated_at": now.isoformat(),
                }
            )
            claimed.append(dict(row))
            if len(claimed) >= limit:
                break
        return claimed

    def _ack_abandoned_telemetry_trace_ingest(self) -> bool:
        """Clear locators or delete an error ingest after Storage cleanup."""
        ingest_id = self.rpc_params.get("in_ingest_id")
        delete_row = bool(self.rpc_params.get("in_delete_row"))
        rows = self.client.tables.setdefault("trace_ingests", [])
        target = next(
            (
                row
                for row in rows
                if row.get("id") == ingest_id
                and row.get("world_model_id") is None
                and row.get("status") == "error"
            ),
            None,
        )
        if target is None:
            return False
        if delete_row:
            rows.remove(target)
        else:
            target["upload_path"] = None
            target["result_path"] = None
            target["updated_at"] = datetime.now(UTC).isoformat()
        return True

    def _claim_trace_clickhouse_projection(self) -> list[JsonObject]:
        """Lease one pending fake projection job for worker tests."""
        limit = _fake_int(self.rpc_params.get("in_limit"), 1)
        claimed: list[JsonObject] = []
        for queued in self.client.tables.setdefault("trace_clickhouse_projections", []):
            if queued.get("state") not in {None, "pending"} and queued.get("claimed_until"):
                continue
            if queued.get("state") == "running" and queued.get("claimed_until"):
                continue
            ingest = next(
                (
                    row
                    for row in self.client.tables.setdefault("trace_ingests", [])
                    if row.get("id") == queued.get("ingest_id")
                ),
                None,
            )
            if ingest is None:
                continue
            token = str(uuid.uuid4())
            queued.update(
                {
                    "state": "running",
                    "attempts": _fake_int(queued.get("attempts"), 0) + 1,
                    "claim_token": token,
                    "claimed_by": self.rpc_params.get("in_worker_id"),
                }
            )
            ingest["trace_projection_status"] = "running"
            claimed.append(
                {
                    "ingest_id": ingest["id"],
                    "org_id": ingest["org_id"],
                    "result_path": ingest.get("result_path") or ingest.get("upload_path"),
                    "object_sha256": ingest.get("object_sha256"),
                    "byte_size": ingest.get("byte_size"),
                    "source": ingest.get("source") or {},
                    "received_at": ingest.get("created_at") or datetime.now(UTC).isoformat(),
                    "projection_version": queued.get("projection_version") or 1,
                    "projection_attempt": queued.get("attempts") or 1,
                    "claim_token": token,
                }
            )
            if len(claimed) >= limit:
                break
        return claimed

    def _ack_trace_clickhouse_projection(self) -> bool:
        """Acknowledge one fake projection claim."""
        ingest_id = self.rpc_params.get("in_ingest_id")
        claim_token = self.rpc_params.get("in_claim_token")
        queue = self.client.tables.setdefault("trace_clickhouse_projections", [])
        owned = next(
            (
                row
                for row in queue
                if row.get("ingest_id") == ingest_id and row.get("claim_token") == claim_token
            ),
            None,
        )
        if owned is None:
            return False
        queue.remove(owned)
        target = next(
            (
                row
                for row in self.client.tables.setdefault("trace_ingests", [])
                if row.get("id") == ingest_id
            ),
            None,
        )
        if target is not None:
            status = target.get("status")
            if target.get("world_model_id") is None and status in {None, "pending", "running"}:
                status = "done"
            target.update(
                {
                    "status": status,
                    "trace_projection_status": "done",
                    "trace_projected_rows": self.rpc_params.get("in_projected_rows"),
                    "trace_projected_at": datetime.now(UTC).isoformat(),
                    "trace_projection_error_code": None,
                }
            )
        return True

    def _claim_trace_clickhouse_deletion(self) -> list[JsonObject]:
        """Return no ClickHouse erasures unless a test seeded the outbox."""
        claimed: list[JsonObject] = []
        limit = _fake_int(self.rpc_params.get("in_limit"), 16)
        for queued in self.client.tables.setdefault("trace_clickhouse_deletions", []):
            if queued.get("state") == "running":
                continue
            token = str(uuid.uuid4())
            queued.update({"state": "running", "claim_token": token})
            claimed.append(
                {
                    "ingest_id": queued.get("ingest_id"),
                    "org_id": queued.get("org_id"),
                    "claim_token": token,
                }
            )
            if len(claimed) >= limit:
                break
        return claimed

    def _ack_trace_clickhouse_deletion(self) -> bool:
        """Remove one fake erasure job."""
        ingest_id = self.rpc_params.get("in_ingest_id")
        claim_token = self.rpc_params.get("in_claim_token")
        rows = self.client.tables.setdefault("trace_clickhouse_deletions", [])
        owned = next(
            (
                row
                for row in rows
                if row.get("ingest_id") == ingest_id and row.get("claim_token") == claim_token
            ),
            None,
        )
        if owned is None:
            return False
        rows.remove(owned)
        return True

    def _nack_trace_clickhouse_deletion(self) -> bool:
        """Release one fake erasure job."""
        ingest_id = self.rpc_params.get("in_ingest_id")
        claim_token = self.rpc_params.get("in_claim_token")
        queued = next(
            (
                row
                for row in self.client.tables.setdefault("trace_clickhouse_deletions", [])
                if row.get("ingest_id") == ingest_id and row.get("claim_token") == claim_token
            ),
            None,
        )
        if queued is None:
            return False
        queued.update({"state": "pending", "claim_token": None})
        return True

    def _nack_trace_clickhouse_projection(self) -> bool:
        """Release one fake projection claim for retry."""
        ingest_id = self.rpc_params.get("in_ingest_id")
        claim_token = self.rpc_params.get("in_claim_token")
        queued = next(
            (
                row
                for row in self.client.tables.setdefault("trace_clickhouse_projections", [])
                if row.get("ingest_id") == ingest_id and row.get("claim_token") == claim_token
            ),
            None,
        )
        if queued is None:
            return False
        queued.update({"state": "pending", "claim_token": None, "claimed_by": None})
        return True

    def _get_project_result_projection(self) -> list[JsonObject]:
        """Model the result projection RPC: a seeded row or the no-result shape."""
        project_id = self.rpc_params.get("p_project_id")
        rows = self.client.tables.setdefault("optimizer_project_result_rows", [])
        seeded = next((row for row in rows if row.get("project_id") == project_id), None)
        if seeded is not None:
            return [dict(seeded)]
        archived = any(
            row.get("id") == project_id and row.get("archived_at") is not None
            for row in self.client.tables.setdefault("optimizer_projects", [])
        )
        return [
            {
                "project_id": project_id,
                "model": "",
                "router_id": None,
                "active_generation": None,
                "active": False,
                "archived": archived,
                "activated_at": None,
                "current_job_active": False,
                "completed_at": None,
                "report": None,
                "build_spend": None,
            }
        ]

    def _gateway_usage_daily_rows(self) -> list[JsonObject]:
        """Shared filter for the gateway rollup fake: org, user, day window."""
        params = self.rpc_params
        user = params.get("in_user")
        from_day = params.get("in_from")
        to_day = params.get("in_to")
        return [
            row
            for row in self.client.tables.setdefault("gateway_usage_daily", [])
            if row.get("org_id") == params.get("in_org")
            and (user is None or row.get("user_id") == user)
            and (from_day is None or str(row.get("day", "")) >= str(from_day))
            and (to_day is None or str(row.get("day", "")) <= str(to_day))
        ]

    def _grouped_usage_rollup(
        self, rows: list[JsonObject], group_by: str, entity_dim: str
    ) -> list[JsonObject]:
        """Group rollup rows by day, alias, or the entity dimension, summing metrics.

        The shared shape of the tenant and platform usage-read RPCs: the same
        bucket seed, metric sums, day-desc vs spend-desc ordering, and limit
        cap, with `entity_dim` naming the non-model grouping column
        ("user_id" for the tenant read, "org_id" for the platform read).
        """
        grouped: dict[str, JsonObject] = {}
        for row in rows:
            match group_by:
                case "day":
                    key, dims = str(row["day"]), {"day": row["day"]}
                case "day_model":
                    key = f"{row['day']}|{row['alias']}"
                    dims = {"day": row["day"], "alias": row["alias"]}
                case "model":
                    key, dims = str(row["alias"]), {"alias": row["alias"]}
                case _:
                    key, dims = str(row[entity_dim]), {entity_dim: row[entity_dim]}
            bucket = grouped.setdefault(
                key,
                {
                    "day": None,
                    entity_dim: None,
                    "alias": None,
                    **dims,
                    "requests": 0,
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "spend_micro_usd": 0,
                },
            )
            for column in ("requests", "input_tokens", "output_tokens", "spend_micro_usd"):
                bucket[column] = int(_fake_num(bucket[column]) + _fake_num(row.get(column)))
        buckets = list(grouped.values())
        if group_by == "day":
            buckets.sort(key=lambda bucket: str(bucket["day"]), reverse=True)
        elif group_by == "day_model":
            # Day descending, biggest spender first within a day, alias tiebreak
            # — matching the RPC so cap truncation drops the oldest days.
            buckets.sort(
                key=lambda bucket: (-_fake_num(bucket["spend_micro_usd"]), str(bucket["alias"]))
            )
            buckets.sort(key=lambda bucket: str(bucket["day"]), reverse=True)
        else:
            # Spend descending with the grouped dimension as the stable tiebreak.
            tiebreak = "alias" if group_by == "model" else entity_dim
            buckets.sort(
                key=lambda bucket: (-_fake_num(bucket["spend_micro_usd"]), str(bucket[tiebreak]))
            )
        raw_limit = self.rpc_params.get("in_limit")
        cap = min(max(raw_limit if isinstance(raw_limit, int) else 400, 1), 2000)
        return [dict(bucket) for bucket in buckets[:cap]]

    def _gateway_usage_daily_read(self) -> list[JsonObject]:
        """Model `gateway_usage_daily_read`: grouped sums over one org's rollup."""
        group_by = str(self.rpc_params.get("in_group_by") or "day")
        if group_by not in ("day", "day_model", "model", "member"):
            msg = "invalid gateway usage grouping (expected day, day_model, model, or member)"
            raise RuntimeError(msg)
        return self._grouped_usage_rollup(self._gateway_usage_daily_rows(), group_by, "user_id")

    def _model_promotion_apply(self) -> list[JsonObject]:
        """Model `model_promotion_apply`: atomic terms + membership apply."""
        params = self.rpc_params
        promotion_id = params.get("p_promotion_id")
        members = params.get("p_members") or []
        promotions = self.client.tables.setdefault("model_promotions", [])
        terms = {
            "label": params.get("p_label"),
            "providers": params.get("p_providers") or [],
            "family_keys": params.get("p_family_keys") or [],
            "audience_labels": params.get("p_audience_labels") or [],
            "funding_scope": params.get("p_funding_scope") or "platform_funded",
            "per_org_cap_micro_usd": params.get("p_per_org_cap_micro_usd"),
            "discount_cap_micro_usd": params.get("p_discount_cap_micro_usd"),
            "cap_scope": params.get("p_cap_scope"),
            "percent_off": params.get("p_percent_off"),
            "active": params.get("p_active"),
            "display_order": params.get("p_display_order"),
            "covers_all_models": isinstance(members, list) and len(members) == 0,
        }
        if promotion_id is None:
            # UUID-shaped and deterministic (labels are unique): the routes
            # validate the id's uuid form at the boundary, so the fake must
            # mint ids real Postgres could have.
            promotion_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"promo:{terms['label']}"))
            promotions.append({"id": promotion_id, **terms})
        else:
            target = next((row for row in promotions if row.get("id") == promotion_id), None)
            if target is None:
                # Real-shaped: the SQL function raises SQLSTATE P0002, which
                # PostgREST surfaces as an APIError the store maps to its
                # typed not-found.
                raise PostgrestAPIError(
                    {
                        "message": "promotion does not exist",
                        "code": "P0002",
                        "hint": None,
                        "details": None,
                    }
                )
            target.update(terms)
        rows = self.client.tables.setdefault("model_promotion_models", [])
        rows[:] = [row for row in rows if row.get("promotion_id") != promotion_id]
        if isinstance(members, list):
            for entry in cast("list[object]", members):
                if isinstance(entry, dict):
                    typed = cast("JsonObject", entry)
                    rows.append(
                        {
                            "promotion_id": promotion_id,
                            "model_id": typed.get("model_id"),
                            "slug": typed.get("slug"),
                        }
                    )
        return [{"promotion_id": promotion_id}]

    def _add_org_label(self) -> list[JsonObject]:
        """Model `add_org_label`: idempotent upsert on (org_id, key)."""
        params = self.rpc_params
        org_id = params.get("in_org")
        key = params.get("in_key")
        labels = self.client.tables.setdefault("org_labels", [])
        existing = next(
            (row for row in labels if row.get("org_id") == org_id and row.get("key") == key),
            None,
        )
        if existing is not None:
            return [dict(existing)]
        row: JsonObject = {
            "id": f"org-label-{len(labels) + 1}",
            "org_id": org_id,
            "key": key,
            "created_by": params.get("in_admin"),
            "created_at": "2026-08-23T00:00:00Z",
        }
        labels.append(row)
        return [dict(row)]

    def _remove_org_label(self) -> list[JsonObject]:
        """Model `remove_org_label`: idempotent delete on (org_id, key)."""
        params = self.rpc_params
        org_id = params.get("in_org")
        key = params.get("in_key")
        labels = self.client.tables.setdefault("org_labels", [])
        self.client.tables["org_labels"] = [
            row for row in labels if not (row.get("org_id") == org_id and row.get("key") == key)
        ]
        return []

    def _add_org_admin_note(self) -> list[JsonObject]:
        """Model `add_org_admin_note`: insert one author-attributed note."""
        params = self.rpc_params
        notes = self.client.tables.setdefault("org_admin_notes", [])
        row: JsonObject = {
            "id": f"org-note-{len(notes) + 1}",
            "org_id": params.get("in_org"),
            "author_user_id": params.get("in_author"),
            "author_email": params.get("in_author_email"),
            "body": str(params.get("in_body") or "").strip(),
            "created_at": "2026-08-23T00:00:00Z",
            "updated_at": "2026-08-23T00:00:00Z",
        }
        notes.append(row)
        return [dict(row)]

    def _delete_org_admin_note(self) -> list[JsonObject]:
        """Model `delete_org_admin_note`: delete by (org, id), returning the deleted row.

        Scoped to both org and note id: a mismatched org matches nothing, so a
        note never deletes through another org's URL.
        """
        org_id = self.rpc_params.get("in_org")
        note_id = self.rpc_params.get("in_note")
        notes = self.client.tables.setdefault("org_admin_notes", [])
        target = next(
            (row for row in notes if row.get("id") == note_id and row.get("org_id") == org_id),
            None,
        )
        if target is None:
            return []
        notes.remove(target)
        return [dict(target)]

    def _recommended_models_apply(self) -> list[JsonObject]:
        """Model `recommended_models_apply`: atomic whole-set preferred_rank swap.

        Mirrors the SQL exactly: refuses an empty or duplicate-bearing list
        (SQLSTATE 22023) and any slug without a public model (P0002, naming
        every missing slug), then unpins every other public model and assigns
        ranks 0..N-1 in list order, returning the resulting band.
        """
        raw = self.rpc_params.get("p_slugs")
        slugs = [str(slug) for slug in cast("list[object]", raw)] if isinstance(raw, list) else []
        if not slugs or len(set(slugs)) != len(slugs):
            raise PostgrestAPIError(
                {
                    "message": "recommended set must name at least one model slug"
                    if not slugs
                    else "recommended slugs must be unique: list order defines the rank",
                    "code": "22023",
                    "hint": None,
                    "details": None,
                }
            )
        public_rows = [
            row
            for row in self.client.tables.setdefault("models", [])
            if row.get("owning_org_id") is None
        ]
        by_slug = {str(row.get("slug")): row for row in public_rows}
        missing = [slug for slug in slugs if slug not in by_slug]
        if missing:
            raise PostgrestAPIError(
                {
                    "message": f"unknown public model slugs: {', '.join(missing)}",
                    "code": "P0002",
                    "hint": None,
                    "details": None,
                }
            )
        for row in public_rows:
            row["preferred_rank"] = None
        for rank, slug in enumerate(slugs):
            by_slug[slug]["preferred_rank"] = rank
        return [
            {
                "slug": slug,
                "display_name": by_slug[slug].get("display_name"),
                "preferred_rank": rank,
            }
            for rank, slug in enumerate(slugs)
        ]

    def _gateway_usage_platform_read(self) -> list[JsonObject]:
        """Model `gateway_usage_platform_read`: grouped sums across all orgs."""
        params = self.rpc_params
        group_by = str(params.get("in_group_by") or "day")
        if group_by not in ("day", "model", "org"):
            msg = "invalid platform usage grouping (expected day, model, or org)"
            raise RuntimeError(msg)
        from_day = params.get("in_from")
        to_day = params.get("in_to")
        rows = [
            row
            for row in self.client.tables.setdefault("gateway_usage_daily", [])
            if (from_day is None or str(row.get("day", "")) >= str(from_day))
            and (to_day is None or str(row.get("day", "")) <= str(to_day))
        ]
        return self._grouped_usage_rollup(rows, group_by, "org_id")

    def _gateway_usage_events_read(self) -> list[JsonObject]:
        """Model `gateway_usage_events_read`: keyset page, newest first."""
        params = self.rpc_params
        api_key = params.get("in_api_key")
        from_day = params.get("in_from")
        to_day = params.get("in_to")
        cursor_day = params.get("in_cursor_day")
        cursor_created = params.get("in_cursor_created")
        cursor_request = params.get("in_cursor_request")

        def triple(row: JsonObject) -> tuple[str, str, str]:
            return (
                str(row.get("day", "")),
                str(row.get("created_at", "")),
                str(row.get("request_id", "")),
            )

        rows = [
            row
            for row in self.client.tables.setdefault("gateway_usage_events", [])
            if row.get("org_id") == params.get("in_org")
            and (api_key is None or row.get("api_key_id") == api_key)
            and (from_day is None or str(row.get("day", "")) >= str(from_day))
            and (to_day is None or str(row.get("day", "")) <= str(to_day))
            and (
                cursor_day is None
                or cursor_created is None
                or cursor_request is None
                or triple(row) < (str(cursor_day), str(cursor_created), str(cursor_request))
            )
        ]
        rows.sort(key=triple, reverse=True)
        raw_limit = params.get("in_limit")
        cap = min(max(raw_limit if isinstance(raw_limit, int) else 50, 1), 200)
        columns = (
            "request_id",
            "api_key_id",
            "user_id",
            "alias",
            "provider",
            "lane",
            "input_tokens",
            "output_tokens",
            "cost_micro_usd",
            "estimated_cost_micro_usd",
            "latency_ms",
            "status",
            "attempt_count",
            "day",
            "created_at",
        )
        return [{column: row.get(column) for column in columns} for row in rows[:cap]]

    def _gateway_key_limits_effective(self) -> list[JsonObject]:
        """Model `gateway_key_limits_effective`: explicit row else lockstep defaults."""
        api_key_id = self.rpc_params.get("in_api_key")
        key = next(
            (
                row
                for row in self.client.tables.setdefault("api_keys", [])
                if row.get("id") == api_key_id
            ),
            None,
        )
        if key is None:
            msg = "api key does not exist"
            raise RuntimeError(msg)
        limits = next(
            (
                row
                for row in self.client.tables.setdefault("gateway_key_limits", [])
                if row.get("api_key_id") == api_key_id
            ),
            None,
        )
        if limits is not None:
            return [
                {
                    "api_key_id": api_key_id,
                    "daily_spend_cap_micro_usd": limits.get("daily_spend_cap_micro_usd"),
                    "requests_per_minute": limits.get("requests_per_minute"),
                    "tokens_per_minute": limits.get("tokens_per_minute"),
                    "source": "explicit",
                }
            ]
        free_credit_funded = not any(
            row.get("org_id") == key.get("org_id") and row.get("source") == "stripe"
            for row in self.client.tables.setdefault("credit_ledger", [])
        )
        return [
            {
                "api_key_id": api_key_id,
                "daily_spend_cap_micro_usd": 50_000_000 if free_credit_funded else None,
                "requests_per_minute": 60,
                "tokens_per_minute": None,
                "source": "default",
            }
        ]

    def _list_project_serving_models(self) -> list[JsonObject]:
        """Model the active Project serving inventory RPC over one fake table."""
        org_id = self.rpc_params.get("p_org_id")
        rows = self.client.tables.setdefault("project_serving_model_rows", [])
        # The RPC projection is exactly the customer-safe identity triple.
        return [
            {"project_id": row["project_id"], "slug": row["slug"], "created_at": row["created_at"]}
            for row in rows
            if row.get("org_id") == org_id
        ]

    def _upsert_trace_connection(self) -> list[JsonObject]:
        """Model `upsert_trace_connection`: insert-or-rotate one (org, kind) connection."""
        params = self.rpc_params
        org_id = params.get("in_org_id")
        kind = params.get("in_kind")
        secret = params.get("in_secret")
        if not isinstance(secret, str) or not secret:
            msg = "connection credential is required"
            raise RuntimeError(msg)
        rows = self.client.tables.setdefault("trace_connections", [])
        row = next((r for r in rows if r.get("org_id") == org_id and r.get("kind") == kind), None)
        if row is None:
            row = {
                "id": f"conn-{len(rows) + 1}",
                "org_id": org_id,
                "kind": kind,
                "config": params.get("in_config") or {},
                "credential_last4": secret[-4:],
            }
            rows.append(row)
        else:
            row["config"] = params.get("in_config") or {}
            row["credential_last4"] = secret[-4:]
        self.client.vault_secrets[str(row["id"])] = secret
        return [dict(row)]

    def _endpoint_usage_rollup(self) -> list[JsonObject]:
        """Model `endpoint_usage_rollup`: group one endpoint's rows by routed model."""
        params = self.rpc_params
        org_id = params.get("in_org")
        endpoint_id = params.get("in_endpoint")
        grouped: dict[str, JsonObject] = {}
        for row in self.client.tables.setdefault("serving_requests", []):
            if row.get("org_id") != org_id or row.get("endpoint_id") != endpoint_id:
                continue
            model = str(row.get("model") or "")
            bucket = grouped.setdefault(
                model,
                {
                    "model": model,
                    "request_count": 0,
                    "error_count": 0,
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "cost_usd": 0.0,
                    "unpriced_count": 0,
                },
            )
            if row.get("status") == "error":
                bucket["error_count"] = _fake_num(bucket["error_count"]) + 1
            else:
                bucket["request_count"] = _fake_num(bucket["request_count"]) + 1
            # Tokens and cost sum over ALL rows: errored requests can carry
            # real billed usage (mirrors the SQL rollup).
            bucket["input_tokens"] = _fake_num(bucket["input_tokens"]) + _fake_num(
                row.get("input_tokens")
            )
            bucket["output_tokens"] = _fake_num(bucket["output_tokens"]) + _fake_num(
                row.get("output_tokens")
            )
            cost = row.get("cost_usd")
            if cost is None:
                if row.get("status") != "error":
                    bucket["unpriced_count"] = _fake_num(bucket["unpriced_count"]) + 1
            else:
                bucket["cost_usd"] = _fake_num(bucket["cost_usd"]) + _fake_num(cost)
        ordered = sorted(grouped.values(), key=lambda b: -_fake_num(b.get("request_count")))
        return [dict(b) for b in ordered]

    def _endpoint_usage_timeseries(self) -> list[JsonObject]:
        """Model `endpoint_usage_timeseries`: (model, epoch-floor bucket) cells."""
        raw_step = self.rpc_params.get("in_bucket_seconds")
        step = max(raw_step if isinstance(raw_step, int) else 86_400, 60)
        cells: dict[tuple[int, str], list[JsonObject]] = {}
        for row in self._serving_rows_in_window():
            created = datetime.fromisoformat(str(row.get("created_at", "")))
            if created.tzinfo is None:
                # Postgres buckets in UTC; a naive fixture must not shift by
                # the test machine's local offset.
                created = created.replace(tzinfo=UTC)
            key = (int(created.timestamp() // step) * step, str(row.get("model") or ""))
            cells.setdefault(key, []).append(row)

        def token_sum(members: list[JsonObject], column: str, *, zero_cost_only: bool) -> int:
            return int(
                sum(
                    _fake_num(member.get(column))
                    for member in members
                    if not zero_cost_only or member.get("cost_usd") == 0
                )
            )

        return [
            {
                "bucket_start": datetime.fromtimestamp(key_start, tz=UTC).isoformat(),
                "model": key_model,
                "request_count": sum(1 for m in members if m.get("status") != "error"),
                "error_count": sum(1 for m in members if m.get("status") == "error"),
                "input_tokens": token_sum(members, "input_tokens", zero_cost_only=False),
                "output_tokens": token_sum(members, "output_tokens", zero_cost_only=False),
                "cached_tokens": token_sum(members, "cached_tokens", zero_cost_only=False),
                "cost_usd": sum(
                    _fake_num(m.get("cost_usd")) for m in members if m.get("cost_usd") is not None
                ),
                "unpriced_count": sum(
                    1 for m in members if m.get("status") != "error" and m.get("cost_usd") is None
                ),
                "zero_cost_input_tokens": token_sum(members, "input_tokens", zero_cost_only=True),
                "zero_cost_output_tokens": token_sum(members, "output_tokens", zero_cost_only=True),
                "zero_cost_cached_tokens": token_sum(members, "cached_tokens", zero_cost_only=True),
            }
            for (key_start, key_model), members in sorted(cells.items())
        ]

    def _gateway_usage_rows(self) -> list[JsonObject]:
        """Return gateway usage events matching the shared org/window params."""
        params = self.rpc_params
        org_id = params.get("in_org")
        after = params.get("in_after")
        return [
            row
            for row in self.client.tables.setdefault("gateway_usage_events", [])
            if row.get("org_id") == org_id
            and (after is None or str(row.get("created_at", "")) >= str(after))
        ]

    def _gateway_key_label(self, api_key_id: object) -> str | None:
        """Left-join the api_keys label; a deleted key reads back as None."""
        for key_row in self.client.tables.setdefault("api_keys", []):
            if key_row.get("id") == api_key_id:
                return cast("str | None", key_row.get("name"))
        return None

    def _gateway_usage_timeseries(self) -> list[JsonObject]:
        """Model `gateway_usage_timeseries`: (bucket, alias, lane) cells."""
        params = self.rpc_params
        raw_step = params.get("in_bucket_seconds")
        step = max(raw_step if isinstance(raw_step, int) else 86_400, 60)
        alias = params.get("in_alias")
        api_key_id = params.get("in_api_key_id")
        lane = params.get("in_lane")
        cells: dict[tuple[int, str, str | None], list[JsonObject]] = {}
        for row in self._gateway_usage_rows():
            if alias is not None and row.get("alias") != alias:
                continue
            if api_key_id is not None and row.get("api_key_id") != api_key_id:
                continue
            if lane is not None and row.get("lane") != lane:
                continue
            created = datetime.fromisoformat(str(row.get("created_at", "")))
            if created.tzinfo is None:
                created = created.replace(tzinfo=UTC)
            key = (
                int(created.timestamp() // step) * step,
                str(row.get("alias") or ""),
                cast("str | None", row.get("lane")),
            )
            cells.setdefault(key, []).append(row)
        return [
            {
                "bucket_start": datetime.fromtimestamp(key_start, tz=UTC).isoformat(),
                "alias": key_alias,
                "lane": key_lane,
                "request_count": len(members),
                "error_count": sum(1 for m in members if m.get("status") != "completed"),
                "input_tokens": int(sum(_fake_num(m.get("input_tokens")) for m in members)),
                "output_tokens": int(sum(_fake_num(m.get("output_tokens")) for m in members)),
                "cost_micro_usd": int(sum(_fake_num(m.get("cost_micro_usd")) for m in members)),
                "estimated_cost_micro_usd": int(
                    sum(_fake_num(m.get("estimated_cost_micro_usd")) for m in members)
                ),
                "cached_input_tokens": int(
                    sum(_fake_num(m.get("cached_input_tokens", 0)) for m in members)
                ),
            }
            for (key_start, key_alias, key_lane), members in sorted(
                cells.items(), key=lambda item: (item[0][0], item[0][1], item[0][2] or "")
            )
        ]

    def _gateway_usage_by_key(self) -> list[JsonObject]:
        """Model `gateway_usage_by_key`: (api key, alias) rollup with labels.

        A null api_key_id (key hard-deleted before settlement) groups as its
        own bucket, exactly as SQL `group by` treats null.
        """
        cells: dict[tuple[str | None, str], list[JsonObject]] = {}
        for row in self._gateway_usage_rows():
            key = (cast("str | None", row.get("api_key_id")), str(row.get("alias") or ""))
            cells.setdefault(key, []).append(row)
        return [
            {
                "api_key_id": key_id,
                "key_label": self._gateway_key_label(key_id),
                "alias": key_alias,
                "request_count": len(members),
                "error_count": sum(1 for m in members if m.get("status") != "completed"),
                "input_tokens": int(sum(_fake_num(m.get("input_tokens")) for m in members)),
                "output_tokens": int(sum(_fake_num(m.get("output_tokens")) for m in members)),
                "cost_micro_usd": int(sum(_fake_num(m.get("cost_micro_usd")) for m in members)),
                "estimated_cost_micro_usd": int(
                    sum(_fake_num(m.get("estimated_cost_micro_usd")) for m in members)
                ),
                "last_used_at": max(str(m.get("created_at", "")) for m in members),
            }
            for (key_id, key_alias), members in sorted(
                cells.items(), key=lambda item: (item[0][0] is None, item[0][0] or "", item[0][1])
            )
        ]

    def _gateway_imported_usage_by_model(self) -> list[JsonObject]:
        """Model `gateway_imported_usage_by_model`: per-(source, model) rollup.

        ``model`` is the catalog alias when matched and present, else the raw
        log string — the same key ``ImportedModelRollup`` uses.
        """
        org_id = self.rpc_params.get("in_org")
        cells: dict[tuple[str, str, bool], list[JsonObject]] = {}
        for row in self.client.tables.setdefault("gateway_imported_usage_events", []):
            if row.get("org_id") != org_id:
                continue
            source = str(row.get("import_source") or "")
            matched = bool(row.get("model_matched"))
            alias = row.get("alias")
            model = str(alias) if matched and alias is not None else str(row.get("model_raw") or "")
            cells.setdefault((source, model, matched), []).append(row)

        def sort_key(
            item: tuple[tuple[str, str, bool], list[JsonObject]],
        ) -> tuple[int, int, str, str, bool]:
            (source, model, matched), members = item
            cost = int(sum(_fake_num(m.get("estimated_cost_micro_usd")) for m in members))
            return (-cost, -len(members), source, model, not matched)

        return [
            {
                "import_source": source,
                "model": model,
                "model_matched": matched,
                "request_count": len(members),
                "input_tokens": int(sum(_fake_num(m.get("input_tokens")) for m in members)),
                "output_tokens": int(sum(_fake_num(m.get("output_tokens")) for m in members)),
                "cached_input_tokens": int(
                    sum(_fake_num(m.get("cached_input_tokens")) for m in members)
                ),
                "reasoning_tokens": int(sum(_fake_num(m.get("reasoning_tokens")) for m in members)),
                "estimated_cost_micro_usd": int(
                    sum(_fake_num(m.get("estimated_cost_micro_usd")) for m in members)
                ),
            }
            for (source, model, matched), members in sorted(cells.items(), key=sort_key)
        ]

    def _gateway_usage_by_provider(self) -> list[JsonObject]:
        """Model `gateway_usage_by_provider`: per-provider rollup.

        A null provider (nothing was dispatched) groups as its own bucket,
        exactly as SQL `group by` treats null.
        """
        cells: dict[str | None, list[JsonObject]] = {}
        for row in self._gateway_usage_rows():
            cells.setdefault(cast("str | None", row.get("provider")), []).append(row)
        return [
            {
                "provider": provider,
                "request_count": len(members),
                "error_count": sum(1 for m in members if m.get("status") != "completed"),
                "input_tokens": int(sum(_fake_num(m.get("input_tokens")) for m in members)),
                "output_tokens": int(sum(_fake_num(m.get("output_tokens")) for m in members)),
                "cost_micro_usd": int(sum(_fake_num(m.get("cost_micro_usd")) for m in members)),
                "estimated_cost_micro_usd": int(
                    sum(_fake_num(m.get("estimated_cost_micro_usd")) for m in members)
                ),
                "last_used_at": max(str(m.get("created_at", "")) for m in members),
            }
            for provider, members in sorted(
                cells.items(),
                key=lambda item: (-len(item[1]), item[0] is None, item[0] or ""),
            )
        ]

    def _gateway_observed_model_stats(self) -> list[JsonObject]:
        """Model `gateway_observed_model_stats`: one aggregate row per route.

        Mirrors the SQL exactly: dispatched (provider non-null) terminal events
        inside the window, per (alias, provider); p50s interpolate like
        statistics.median over completed events with positive latency; routes
        below in_min_sample never appear.
        """
        params = self.rpc_params
        after = params.get("in_after")
        raw_min = params.get("in_min_sample")
        min_sample = raw_min if isinstance(raw_min, int) else 20
        routes: dict[tuple[str, str], list[JsonObject]] = {}
        for row in self.client.tables.get("gateway_usage_events", []):
            provider = row.get("provider")
            if provider is None:
                continue
            if after is not None and str(row.get("created_at", "")) < str(after):
                continue
            key = (str(row.get("alias") or ""), str(provider))
            routes.setdefault(key, []).append(row)
        rows: list[JsonObject] = []
        for (alias, provider), members in sorted(routes.items()):
            if len(members) < min_sample:
                continue
            completed = [m for m in members if m.get("status") == "completed"]
            latencies = sorted(
                float(_fake_num(m.get("latency_ms")))
                for m in completed
                if m.get("latency_ms") is not None and _fake_num(m.get("latency_ms")) > 0
            )
            throughputs = sorted(
                float(_fake_num(m.get("output_tokens"))) / (_fake_num(m.get("latency_ms")) / 1000.0)
                for m in completed
                if m.get("latency_ms") is not None
                and _fake_num(m.get("latency_ms")) > 0
                and _fake_num(m.get("output_tokens")) > 0
            )

            def p50(values: list[float]) -> float | None:
                if not values:
                    return None
                mid = len(values) // 2
                if len(values) % 2 == 1:
                    return values[mid]
                return (values[mid - 1] + values[mid]) / 2.0

            rows.append(
                {
                    "alias": alias,
                    "provider": provider,
                    "sample_count": len(members),
                    "completed_count": len(completed),
                    "latency_p50_ms": p50(latencies),
                    "throughput_p50_tps": p50(throughputs),
                }
            )
        return rows

    def _insights_window_rows(self) -> list[JsonObject]:
        """Org/window rows for the insights RPCs (adds the in_before bound)."""
        before = self.rpc_params.get("in_before")
        return [
            row
            for row in self._gateway_usage_rows()
            if before is None or str(row.get("created_at", "")) < str(before)
        ]

    def _gateway_insights_metrics(self) -> list[JsonObject]:
        """Model `gateway_insights_metrics`: day/model/provider deep aggregates."""
        params = self.rpc_params
        group_by = str(params.get("in_group_by") or "day")
        raw_step = params.get("in_bucket_seconds")
        step = max(raw_step if isinstance(raw_step, int) else 86_400, 60)
        cells: dict[str, list[JsonObject]] = {}
        for row in self._insights_window_rows():
            match group_by:
                case "day":
                    created = datetime.fromisoformat(str(row.get("created_at", "")))
                    if created.tzinfo is None:
                        created = created.replace(tzinfo=UTC)
                    floored = int(created.timestamp() // step) * step
                    bucket = datetime.fromtimestamp(floored, tz=UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
                case "model":
                    bucket = str(row.get("alias") or "")
                case _:
                    bucket = cast("str | None", row.get("provider")) or "(no dispatch)"
            cells.setdefault(bucket, []).append(row)
        result: list[JsonObject] = []
        for bucket in sorted(cells):
            members = cells[bucket]
            total_input = sum(_fake_num(m.get("input_tokens")) for m in members)
            total_cached = sum(_fake_num(m.get("cached_input_tokens", 0)) for m in members)
            dispatched = [m for m in members if m.get("generation_duration_ms") is not None]
            gen_ms = sum(_fake_num(m.get("generation_duration_ms")) for m in dispatched)
            out_dispatched = sum(_fake_num(m.get("output_tokens")) for m in dispatched)
            result.append(
                {
                    "bucket_key": bucket,
                    "request_count": len(members),
                    "completed_count": sum(1 for m in members if m.get("status") == "completed"),
                    "error_count": sum(1 for m in members if m.get("status") != "completed"),
                    "prompt_tokens": int(total_input),
                    "completion_tokens": int(
                        sum(_fake_num(m.get("output_tokens")) for m in members)
                    ),
                    "reasoning_tokens": int(
                        sum(_fake_num(m.get("reasoning_tokens", 0)) for m in members)
                    ),
                    "cached_input_tokens": int(total_cached),
                    "cache_hit_rate": (total_cached / total_input) if total_input else None,
                    "tokens_per_second": (out_dispatched / (gen_ms / 1000)) if gen_ms else None,
                    "avg_generation_duration_ms": _fake_avg(
                        [m.get("generation_duration_ms") for m in members]
                    ),
                    "avg_routing_overhead_ms": _fake_avg(
                        [m.get("routing_overhead_ms") for m in members]
                    ),
                    "avg_latency_ms": _fake_avg([m.get("latency_ms") for m in members]),
                    "cost_micro_usd": int(sum(_fake_num(m.get("cost_micro_usd")) for m in members)),
                    "estimated_cost_micro_usd": int(
                        sum(_fake_num(m.get("estimated_cost_micro_usd")) for m in members)
                    ),
                }
            )
        return result

    def _gateway_insights_tokens_per_second(self) -> list[JsonObject]:
        """Model `gateway_insights_tokens_per_second`: tok/s bucketed over time."""
        params = self.rpc_params
        raw_step = params.get("in_bucket_seconds")
        step = max(raw_step if isinstance(raw_step, int) else 3_600, 60)
        alias = params.get("in_alias")
        provider = params.get("in_provider")
        buckets: dict[int, list[JsonObject]] = {}
        for row in self._insights_window_rows():
            if row.get("generation_duration_ms") is None:
                continue
            if alias is not None and row.get("alias") != alias:
                continue
            if provider is not None and row.get("provider") != provider:
                continue
            created = datetime.fromisoformat(str(row.get("created_at", "")))
            if created.tzinfo is None:
                created = created.replace(tzinfo=UTC)
            buckets.setdefault(int(created.timestamp() // step) * step, []).append(row)
        result: list[JsonObject] = []
        for start in sorted(buckets):
            members = buckets[start]
            gen_ms = sum(_fake_num(m.get("generation_duration_ms")) for m in members)
            completion = sum(_fake_num(m.get("output_tokens")) for m in members)
            result.append(
                {
                    "bucket_start": datetime.fromtimestamp(start, tz=UTC).isoformat(),
                    "request_count": len(members),
                    "completion_tokens": int(completion),
                    "generation_ms": int(gen_ms),
                    "tokens_per_second": (completion / (gen_ms / 1000)) if gen_ms else None,
                }
            )
        return result

    def _gateway_insights_top_apps(self) -> list[JsonObject]:
        """Model `gateway_insights_top_apps`: per-(API key) attribution ranking."""
        raw_limit = self.rpc_params.get("in_limit")
        cap = min(max(raw_limit if isinstance(raw_limit, int) else 20, 1), 100)
        cells: dict[str | None, list[JsonObject]] = {}
        for row in self._insights_window_rows():
            cells.setdefault(cast("str | None", row.get("api_key_id")), []).append(row)
        rows: list[JsonObject] = [
            {
                "api_key_id": key_id,
                "app_label": self._gateway_key_label(key_id),
                "request_count": len(members),
                "error_count": sum(1 for m in members if m.get("status") != "completed"),
                "prompt_tokens": int(sum(_fake_num(m.get("input_tokens")) for m in members)),
                "completion_tokens": int(sum(_fake_num(m.get("output_tokens")) for m in members)),
                "reasoning_tokens": int(
                    sum(_fake_num(m.get("reasoning_tokens", 0)) for m in members)
                ),
                "cost_micro_usd": int(sum(_fake_num(m.get("cost_micro_usd")) for m in members)),
                "estimated_cost_micro_usd": int(
                    sum(_fake_num(m.get("estimated_cost_micro_usd")) for m in members)
                ),
                "last_used_at": max(str(m.get("created_at", "")) for m in members),
            }
            for key_id, members in cells.items()
        ]
        rows.sort(key=lambda item: (-cast("int", item["request_count"]), str(item["api_key_id"])))
        return rows[:cap]

    def _captured_prompt_rows(self) -> list[JsonObject]:
        return self.client.tables.setdefault("gateway_captured_prompts", [])

    def _gateway_captured_prompt_read(self) -> list[JsonObject]:
        """Model `gateway_captured_prompt_read`: one org-scoped captured row."""
        params = self.rpc_params
        return [
            {
                "request_id": row.get("request_id"),
                "messages": row.get("messages"),
                "captured_at": row.get("captured_at"),
            }
            for row in self._captured_prompt_rows()
            if row.get("org_id") == params.get("in_org")
            and row.get("request_id") == params.get("in_request_id")
        ]

    def _gateway_prompt_group_snippets(self) -> list[JsonObject]:
        """Model `gateway_prompt_group_snippets`: latest snippet per group."""
        params = self.rpc_params
        latest: dict[str, JsonObject] = {}
        for row in self._captured_prompt_rows():
            if row.get("org_id") != params.get("in_org"):
                continue
            group = row.get("prompt_sha256")
            if group is None:
                continue
            current = latest.get(str(group))
            if current is None or str(row.get("captured_at", "")) > str(
                current.get("captured_at", "")
            ):
                latest[str(group)] = row

        def snippet(messages: object) -> str:
            rows: list[JsonObject] = [
                cast("JsonObject", message)
                for message in (messages if isinstance(messages, list) else [])
                if isinstance(message, dict)
            ]
            for roles in (("system", "developer"), None):
                for message in rows:
                    content = message.get("content")
                    if content is None:
                        continue
                    if roles is not None and message.get("role") not in roles:
                        continue
                    return str(content)[:160]
            return ""

        return [
            {
                "prompt_sha256": group,
                "snippet": snippet(row.get("messages")),
                "captured_at": row.get("captured_at"),
            }
            for group, row in sorted(latest.items())
        ]

    def _gateway_captured_prompts_to_export(self) -> list[JsonObject]:
        """Model the broadcast queue: oldest undelivered rows joined to the alias."""
        params = self.rpc_params
        raw_limit = params.get("in_limit")
        limit = min(max(raw_limit if isinstance(raw_limit, int) else 100, 1), 500)
        raw_excluded = params.get("in_exclude_orgs")
        excluded = set(raw_excluded) if isinstance(raw_excluded, list) else set()
        aliases = {
            row.get("request_id"): row.get("alias")
            for row in self.client.tables.setdefault("gateway_requests", [])
        }
        consenting = {
            row.get("id")
            for row in self.client.tables.setdefault("organizations", [])
            if row.get("capture_prompt_content")
        }
        pending = [
            row
            for row in self._captured_prompt_rows()
            if row.get("exported_at") is None
            and row.get("org_id") in consenting
            and row.get("org_id") not in excluded
        ]
        pending.sort(key=lambda row: str(row.get("captured_at", "")))
        return [
            {
                "request_id": row.get("request_id"),
                "org_id": row.get("org_id"),
                "alias": aliases.get(row.get("request_id"), ""),
                "prompt_sha256": row.get("prompt_sha256"),
                "messages": row.get("messages"),
                "captured_at": row.get("captured_at"),
            }
            for row in pending[:limit]
        ]

    def _gateway_captured_prompts_mark_exported(self) -> list[str]:
        """Model the consent-checked broadcast CLAIM: a bare list of claimed ids."""
        params = self.rpc_params
        raw_ids = params.get("p_request_ids")
        ids = set(raw_ids) if isinstance(raw_ids, list) else set()
        consenting = {
            row.get("id")
            for row in self.client.tables.setdefault("organizations", [])
            if row.get("capture_prompt_content")
        }
        claimed: list[str] = []
        for row in self._captured_prompt_rows():
            if (
                row.get("request_id") in ids
                and row.get("exported_at") is None
                and row.get("org_id") in consenting
            ):
                row["exported_at"] = "2026-08-23T12:00:00+00:00"
                claimed.append(str(row.get("request_id")))
        return claimed

    def _gateway_captured_prompts_unmark_exported(self) -> list[JsonObject]:
        """Model the claim release after a failed ship."""
        params = self.rpc_params
        raw_ids = params.get("p_request_ids")
        ids = set(raw_ids) if isinstance(raw_ids, list) else set()
        for row in self._captured_prompt_rows():
            if row.get("request_id") in ids:
                row["exported_at"] = None
        return []

    def _gateway_usage_by_prompt(self) -> list[JsonObject]:
        """Model `gateway_usage_by_prompt`: (prompt digest, alias) rollup.

        Rows without a prompt digest (pre-lineage settlements) are excluded,
        matching the SQL RPC's honest-window predicate.
        """
        params = self.rpc_params
        after = params.get("in_after")
        cells: dict[tuple[str, str], list[JsonObject]] = {}
        for row in self._gateway_usage_rows():
            prompt = row.get("prompt_sha256")
            if prompt is None:
                continue
            if after is not None and str(row.get("created_at", "")) < str(after):
                continue
            key = (str(prompt), str(row.get("alias") or ""))
            cells.setdefault(key, []).append(row)
        return [
            {
                "prompt_sha256": prompt,
                "alias": alias,
                "request_count": len(members),
                "error_count": sum(1 for m in members if m.get("status") != "completed"),
                "conversation_count": len({m.get("conversation_sha256") for m in members}),
                "agent_count": len({m.get("api_key_id") for m in members}),
                "input_tokens": int(sum(_fake_num(m.get("input_tokens")) for m in members)),
                "output_tokens": int(sum(_fake_num(m.get("output_tokens")) for m in members)),
                "cached_input_tokens": int(
                    sum(_fake_num(m.get("cached_input_tokens", 0)) for m in members)
                ),
                "cost_micro_usd": int(sum(_fake_num(m.get("cost_micro_usd")) for m in members)),
                "estimated_cost_micro_usd": int(
                    sum(_fake_num(m.get("estimated_cost_micro_usd")) for m in members)
                ),
                "stable_prefix_chars": int(
                    max(_fake_num(m.get("stable_prefix_chars", 0)) for m in members)
                ),
                "last_used_at": max(str(m.get("created_at", "")) for m in members),
            }
            for (prompt, alias), members in sorted(
                cells.items(), key=lambda item: (-len(item[1]), item[0][0], item[0][1])
            )
        ]

    def _list_gateway_usage_events(self) -> list[JsonObject]:
        """Model `list_gateway_usage_events`: newest first, keyset cursor."""
        params = self.rpc_params
        before = params.get("in_before")
        alias = params.get("in_alias")
        api_key_id = params.get("in_api_key_id")
        lane = params.get("in_lane")
        status = params.get("in_status")
        cursor_ts = params.get("in_cursor_ts")
        cursor_id = params.get("in_cursor_id")
        rows = [
            row
            for row in self._gateway_usage_rows()
            if (before is None or str(row.get("created_at", "")) < str(before))
            and (alias is None or row.get("alias") == alias)
            and (api_key_id is None or row.get("api_key_id") == api_key_id)
            and (lane is None or row.get("lane") == lane)
            and (
                status is None
                or (status == "error" and row.get("status") != "completed")
                or row.get("status") == status
            )
            and (
                cursor_ts is None
                or cursor_id is None
                or (str(row.get("created_at", "")), str(row.get("request_id", "")))
                < (str(cursor_ts), str(cursor_id))
            )
        ]
        rows.sort(
            key=lambda row: (str(row.get("created_at", "")), str(row.get("request_id", ""))),
            reverse=True,
        )
        raw_limit = params.get("in_limit")
        limit = min(max(raw_limit if isinstance(raw_limit, int) else 50, 1), 200)
        event_columns = (
            "request_id",
            "api_key_id",
            "alias",
            "provider",
            "lane",
            "input_tokens",
            "output_tokens",
            "cost_micro_usd",
            "estimated_cost_micro_usd",
            "latency_ms",
            "status",
            "attempt_count",
            "created_at",
            "tools_used",
            "failure_class",
            "error_message",
            "ttft_ms",
        )
        # Content-free per-call metadata columns with server-side defaults; a
        # seed row may omit them and read back the RPC's defaults.
        defaulted_columns = {
            "cached_input_tokens": 0,
            "reasoning_tokens": 0,
            "pricing_known": True,
        }
        return [
            {
                **{column: row.get(column) for column in event_columns},
                **{
                    column: row.get(column, default)
                    for column, default in defaulted_columns.items()
                },
                "key_label": self._gateway_key_label(row.get("api_key_id")),
            }
            for row in rows[:limit]
        ]

    def _upsert_provider_connection(self) -> list[JsonObject]:
        """Model `upsert_provider_connection`: insert-or-rotate one (org, provider) key."""
        params = self.rpc_params
        org_id = params.get("in_org_id")
        provider = params.get("in_provider")
        secret = params.get("in_secret")
        if not isinstance(secret, str) or not secret:
            msg = "provider credential is required"
            raise RuntimeError(msg)
        if len(secret) < 12:
            msg = "provider credential is too short to be a real API key"
            raise RuntimeError(msg)
        rows = self.client.tables.setdefault("provider_connections", [])
        row = next(
            (r for r in rows if r.get("org_id") == org_id and r.get("provider") == provider), None
        )
        if row is None:
            row = {
                "id": f"provider-conn-{len(rows) + 1}",
                "org_id": org_id,
                "provider": provider,
                "setup_alias": provider,
                "config": params.get("in_config") or {},
                "credential_last4": secret[-4:],
                "status": "unchecked",
                "status_detail": None,
                "status_checked_at": None,
                "status_source": None,
            }
            rows.append(row)
        else:
            row["config"] = params.get("in_config") or {}
            row["credential_last4"] = secret[-4:]
            # Rotation resets the verdict: the fresh key never wears the old
            # key's status while its own hookup check runs.
            row["status"] = "unchecked"
            row["status_detail"] = None
            row["status_checked_at"] = None
            row["status_source"] = None
        self.client.vault_secrets[str(row["id"])] = secret
        self._bump_org_endpoints(org_id)
        return [dict(row)]

    def _bump_org_endpoints(self, org_id: object) -> None:
        """Model the RPCs' revision bump: key changes rebuild cached runtimes."""
        for endpoint in self.client.tables.setdefault("endpoints", []):
            if endpoint.get("org_id") == org_id:
                endpoint["updated_at"] = f"bumped-{len(self.client.executed_rpcs)}"

    def _set_tool_account_credential(self) -> list[JsonObject]:
        """Model `set_tool_account_credential`: insert-or-rotate one (org, vendor) cred."""
        params = self.rpc_params
        org_id = params.get("in_org_id")
        vendor = params.get("in_vendor")
        secret = params.get("in_secret")
        if not isinstance(secret, str) or len(secret) < 12:
            msg = "tool account credential is too short to be a real credential"
            raise RuntimeError(msg)
        rows = self.client.tables.setdefault("tool_accounts", [])
        row = next(
            (r for r in rows if r.get("org_id") == org_id and r.get("vendor") == vendor), None
        )
        if row is None:
            row = {
                "id": f"tool-account-{len(rows) + 1}",
                "org_id": org_id,
                "vendor": vendor,
                "config": params.get("in_config") or {},
                "credential_last4": secret[-4:],
                "declared_balance_usd": None,
                "declared_balance_set_at": None,
                "balance_source": None,
                "low_balance_threshold_usd": 5,
                "last_fetch_at": None,
                "last_fetch_status": None,
                "last_fetch_message": None,
            }
            rows.append(row)
        else:
            if params.get("in_config") is not None:
                row["config"] = params.get("in_config")
            row["credential_last4"] = secret[-4:]
        self.client.vault_secrets[f"tool:{row['id']}"] = secret
        return [
            {
                "id": row["id"],
                "org_id": row["org_id"],
                "vendor": row["vendor"],
                "config": row["config"],
                "credential_last4": row["credential_last4"],
            }
        ]

    def _release_tool_account_credential(self) -> list[JsonObject]:
        """Model `release_tool_account_credential`: decrypt from the fake Vault."""
        account_id = self.rpc_params.get("in_account_id")
        secret = self.client.vault_secrets.get(f"tool:{account_id}")
        if secret is None:
            msg = f"tool account has no stored credential: {account_id}"
            raise RuntimeError(msg)
        return [{"credential": secret}]

    def _delete_tool_account(self) -> list[JsonObject]:
        """Model `delete_tool_account`: drop the row and its fake Vault secret."""
        params = self.rpc_params
        org_id = params.get("in_org_id")
        vendor = params.get("in_vendor")
        rows = self.client.tables.setdefault("tool_accounts", [])
        row = next(
            (r for r in rows if r.get("org_id") == org_id and r.get("vendor") == vendor), None
        )
        if row is None:
            return [{"delete_tool_account": False}]
        rows.remove(row)
        self.client.vault_secrets.pop(f"tool:{row['id']}", None)
        return [{"delete_tool_account": True}]

    def _release_provider_connection_credential(self) -> list[JsonObject]:
        """Model `release_provider_connection_credential`: decrypt from the fake Vault."""
        connection_id = self.rpc_params.get("in_connection_id")
        secret = self.client.vault_secrets.get(str(connection_id))
        if secret is None:
            msg = f"provider connection not found: {connection_id}"
            raise RuntimeError(msg)
        return [{"credential": secret}]

    def _set_provider_connection_spend_credential(self) -> list[JsonObject]:
        """Model the spend-credential set: an admin key rides an existing row."""
        params = self.rpc_params
        org_id = params.get("in_org_id")
        provider = params.get("in_provider")
        secret = params.get("in_secret")
        if not isinstance(secret, str) or len(secret) < 12:
            msg = "provider spend credential is too short to be a real API key"
            raise RuntimeError(msg)
        rows = self.client.tables.setdefault("provider_connections", [])
        row = next(
            (r for r in rows if r.get("org_id") == org_id and r.get("provider") == provider), None
        )
        if row is None:
            msg = f"provider connection not found for org {org_id} provider {provider}"
            raise RuntimeError(msg)
        row["spend_credential_last4"] = secret[-4:]
        self.client.vault_secrets[f"spend:{row['id']}"] = secret
        return [
            {
                "id": row["id"],
                "provider": row["provider"],
                "spend_credential_last4": row["spend_credential_last4"],
            }
        ]

    def _release_provider_connection_spend_credential(self) -> list[JsonObject]:
        """Model the spend-credential release: decrypt the admin key."""
        connection_id = self.rpc_params.get("in_connection_id")
        secret = self.client.vault_secrets.get(f"spend:{connection_id}")
        if secret is None:
            msg = f"provider connection has no spend credential: {connection_id}"
            raise RuntimeError(msg)
        return [{"credential": secret}]

    def _delete_provider_connection(self) -> list[JsonObject]:
        """Model `delete_provider_connection`: drop the row and its fake Vault secrets."""
        params = self.rpc_params
        org_id = params.get("in_org_id")
        provider = params.get("in_provider")
        rows = self.client.tables.setdefault("provider_connections", [])
        row = next(
            (r for r in rows if r.get("org_id") == org_id and r.get("provider") == provider), None
        )
        if row is None:
            return [{"delete_provider_connection": False}]
        rows.remove(row)
        self.client.vault_secrets.pop(str(row["id"]), None)
        self.client.vault_secrets.pop(f"spend:{row['id']}", None)
        # The snapshots FK cascades with the connection row.
        self.client.tables["provider_account_snapshots"] = [
            snapshot
            for snapshot in self.client.tables.setdefault("provider_account_snapshots", [])
            if snapshot.get("connection_id") != row["id"]
        ]
        for model in self.client.tables.setdefault("optimizer_project_setup_models", []):
            if model.get("provider_connection_id") == row["id"]:
                model["provider_connection_id"] = None
        self._bump_org_endpoints(org_id)
        return [{"delete_provider_connection": True}]

    def _get_optimizer_project_setup(self) -> list[JsonObject]:
        """Return one parent and its children from one fake RPC snapshot."""
        snapshot = self._optimizer_project_setup_snapshot(self.rpc_params.get("in_project_id"))
        return [] if snapshot is None else [snapshot]

    def _get_optimizer_project_available_credit(self) -> list[JsonObject]:
        """Return one organization's exact fixed-point credit subtraction."""
        org_id = self.rpc_params.get("in_org_id")
        organization = next(
            (
                row
                for row in self.client.tables.setdefault("organizations", [])
                if row.get("id") == org_id
            ),
            None,
        )
        if organization is None:
            return []
        try:
            granted = Decimal(str(organization["credit_granted_usd"]))
            spent = Decimal(str(organization["billable_spend_usd"]))
        except (InvalidOperation, KeyError) as error:
            msg = "organization credit balance is invalid"
            raise RuntimeError(msg) from error
        return [{"available_credit_usd": format(granted - spent, ".6f")}]

    def _optimizer_project_setup_snapshot(self, project_id: object) -> JsonObject | None:
        """Capture one fake setup parent and child collection at a single point."""
        setup = next(
            (
                row
                for row in self.client.tables.setdefault("optimizer_project_setups", [])
                if row.get("project_id") == project_id
            ),
            None,
        )
        if setup is None:
            return None
        setup_id = setup.get("id")
        models = sorted(
            (
                dict(row)
                for row in self.client.tables.setdefault("optimizer_project_setup_models", [])
                if row.get("setup_id") == setup_id
            ),
            key=lambda row: (str(row.get("role")), str(row.get("alias"))),
        )
        snapshot = dict(setup)
        budget = snapshot.get("run_budget_usd")
        if budget is not None:
            snapshot["run_budget_usd"] = format(Decimal(str(budget)), ".6f")
        snapshot["models"] = models
        return snapshot

    def _replace_optimizer_project_setup(  # noqa: C901, PLR0912, PLR0915
        self,
    ) -> list[JsonObject]:
        """Model the atomic Project setup replacement and version compare."""
        params = self.rpc_params
        project_id = params.get("in_project_id")
        project = next(
            (
                row
                for row in self.client.tables.setdefault("optimizer_projects", [])
                if row.get("id") == project_id and row.get("archived_at") is None
            ),
            None,
        )
        if project is None:
            msg = "active Project not found"
            raise RuntimeError(msg)
        expected = params.get("in_expected_version")
        if isinstance(expected, bool) or not isinstance(expected, int) or expected < 0:
            msg = "expected Project setup version must not be negative"
            raise RuntimeError(msg)
        setups = self.client.tables.setdefault("optimizer_project_setups", [])
        current = next((row for row in setups if row.get("project_id") == project_id), None)
        raw_current_version = current.get("version") if current is not None else 0
        if isinstance(raw_current_version, bool) or not isinstance(raw_current_version, int):
            msg = "stored Project setup version is invalid"
            raise TypeError(msg)
        current_version = raw_current_version
        if expected != current_version:
            return [
                {
                    "applied": False,
                    "current_version": current_version,
                    "snapshot": None,
                }
            ]

        prompt = params.get("in_system_prompt")
        maximum_model_calls = params.get("in_maximum_model_calls")
        if (prompt is None) != (maximum_model_calls is None):
            msg = "built-in chat prompt and model-call bound must be configured together"
            raise RuntimeError(msg)
        if prompt is not None and (
            not isinstance(prompt, str)
            or not prompt.strip()
            or len(prompt) > 20_000
            or isinstance(maximum_model_calls, bool)
            or not isinstance(maximum_model_calls, int)
            or maximum_model_calls < 1
            or maximum_model_calls > 64
        ):
            msg = "invalid built-in chat system configuration"
            raise RuntimeError(msg)
        raw_budget = params.get("in_run_budget_usd")
        budget: Decimal | None = None
        if raw_budget is not None:
            try:
                budget = Decimal(str(raw_budget))
            except InvalidOperation as error:
                msg = "run budget must be a positive finite fixed-point number"
                raise RuntimeError(msg) from error
            if (
                not budget.is_finite()
                or budget <= 0
                or budget >= Decimal(100000000000000)
                or budget != budget.quantize(Decimal("0.000001"))
            ):
                msg = "run budget must be positive and finite"
                raise RuntimeError(msg)
            organization = next(
                (
                    row
                    for row in self.client.tables.setdefault("organizations", [])
                    if row.get("id") == project.get("org_id")
                ),
                None,
            )
            if organization is not None:
                available = Decimal(str(organization.get("credit_granted_usd", 0))) - Decimal(
                    str(organization.get("billable_spend_usd", 0))
                )
                if budget > available:
                    msg = "run budget exceeds available Platform credit"
                    raise RuntimeError(msg)
        parallel = params.get("in_max_parallel_requests")
        if parallel is not None and (
            isinstance(parallel, bool)
            or not isinstance(parallel, int)
            or parallel < 1
            or parallel > 16
        ):
            msg = "max_parallel_requests is outside the supported bound"
            raise RuntimeError(msg)

        raw_models = params.get("in_models")
        if not isinstance(raw_models, list) or len(raw_models) > 36:
            msg = "Project setup models must be a bounded array"
            raise RuntimeError(msg)
        raw_platform_models = params.get("in_available_platform_models")
        if not isinstance(raw_platform_models, list) or len(raw_platform_models) > 64:
            msg = "available Platform models must be a bounded array"
            raise RuntimeError(msg)
        available_platform_models: set[tuple[str, str]] = set()
        for value in raw_platform_models:
            if (
                not isinstance(value, Mapping)
                or any(not isinstance(key, str) for key in value)
                or set(value) != {"provider", "model"}
            ):
                msg = "available Platform models contain an invalid entry"
                raise RuntimeError(msg)
            entry = cast("Mapping[str, object]", value)
            provider = entry.get("provider")
            model_id = entry.get("model")
            if (
                provider not in {"openai", "anthropic", "gemini", "bedrock"}
                or not isinstance(model_id, str)
                or not model_id.strip()
                or len(model_id) > 255
                or (str(provider), model_id) in available_platform_models
            ):
                msg = "available Platform models contain an invalid identity"
                raise RuntimeError(msg)
            available_platform_models.add((str(provider), model_id))
        models: list[JsonObject] = []
        aliases: set[str] = set()
        role_counts: dict[str, int] = {}
        for value in raw_models:
            if not isinstance(value, Mapping):
                msg = "Project setup model entry must be an object"
                raise TypeError(msg)
            model = dict(value)
            role = model.get("role")
            alias = model.get("alias")
            model_id = model.get("model")
            provider = model.get("provider")
            credential_source = model.get("credential_source")
            connection_alias = model.get("connection_alias")
            connection_id = model.get("provider_connection_id")
            if role not in {"world_model", "judge", "embedder", "baseline", "candidate"}:
                msg = "invalid Project setup model role"
                raise RuntimeError(msg)
            if not isinstance(alias, str) or not alias or alias in aliases:
                msg = "Project setup model aliases must be unique"
                raise RuntimeError(msg)
            if not isinstance(model_id, str) or not model_id.strip() or len(model_id) > 255:
                msg = "invalid Project setup model identifier"
                raise RuntimeError(msg)
            if provider not in {
                "openai",
                "anthropic",
                "gemini",
                "azure_openai",
                "openrouter",
                "bedrock",
                "local",
            }:
                msg = "provider is not available for Project setup"
                raise RuntimeError(msg)
            if credential_source not in {"byok", "platform"}:
                msg = "invalid Project setup credential source"
                raise RuntimeError(msg)
            if connection_alias is not None and (
                not isinstance(connection_alias, str) or not connection_alias
            ):
                msg = "invalid Project setup connection alias"
                raise RuntimeError(msg)
            if provider == "local":
                if connection_id is not None or connection_alias is not None:
                    msg = "local Project setup model cannot carry a connection"
                    raise RuntimeError(msg)
                if not isinstance(model.get("base_url"), str) or not model["base_url"]:
                    msg = "local Project setup model requires a base_url"
                    raise RuntimeError(msg)
            elif credential_source == "byok" and (
                connection_id is None or connection_alias is None
            ):
                msg = "BYOK Project setup model requires an exact connection"
                raise RuntimeError(msg)
            if credential_source == "platform" and (
                connection_id is not None or connection_alias is not None
            ):
                msg = "Platform Project setup model cannot carry a connection"
                raise RuntimeError(msg)
            if (
                credential_source == "platform"
                and (str(provider), str(model_id)) not in available_platform_models
            ):
                msg = "Project setup references an unavailable Platform model"
                raise RuntimeError(msg)
            aliases.add(alias)
            role_text = str(role)
            role_counts[role_text] = role_counts.get(role_text, 0) + 1
            if credential_source == "byok" and provider != "local":
                connection = next(
                    (
                        row
                        for row in self.client.tables.setdefault("provider_connections", [])
                        if row.get("id") == connection_id
                        and row.get("org_id") == project.get("org_id")
                        and row.get("provider") == provider
                        and row.get("setup_alias") == connection_alias
                    ),
                    None,
                )
                if connection is None:
                    msg = "Project setup references an unavailable provider connection"
                    raise RuntimeError(msg)
            models.append(model)
        if (
            any(count > 1 for role, count in role_counts.items() if role != "candidate")
            or role_counts.get("candidate", 0) > 32
        ):
            msg = "Project setup model role cardinality is invalid"
            raise RuntimeError(msg)

        now = datetime.now(tz=UTC).isoformat()
        new_version = current_version + 1
        if current is None:
            current = {
                "id": self.client.next_id("optimizer_project_setups"),
                "project_id": project_id,
                "version": new_version,
                "system_kind": "builtin_chat" if prompt is not None else None,
                "system_prompt": prompt,
                "maximum_model_calls": maximum_model_calls,
                "run_budget_usd": budget,
                "max_parallel_requests": parallel,
                "created_at": now,
                "updated_at": now,
            }
            setups.append(current)
        else:
            current.update(
                {
                    "version": new_version,
                    "system_kind": "builtin_chat" if prompt is not None else None,
                    "system_prompt": prompt,
                    "maximum_model_calls": maximum_model_calls,
                    "run_budget_usd": budget,
                    "max_parallel_requests": parallel,
                    "updated_at": now,
                }
            )
        setup_id = current["id"]
        setup_models = self.client.tables.setdefault("optimizer_project_setup_models", [])
        setup_models[:] = [row for row in setup_models if row.get("setup_id") != setup_id]
        for model in models:
            setup_models.append(
                {
                    "id": self.client.next_id("optimizer_project_setup_models"),
                    "setup_id": setup_id,
                    **model,
                    "created_at": now,
                }
            )
        snapshot = self._optimizer_project_setup_snapshot(project_id)
        if snapshot is None:
            msg = "committed Project setup snapshot is unavailable"
            raise RuntimeError(msg)
        return [
            {
                "applied": True,
                "current_version": new_version,
                "snapshot": snapshot,
            }
        ]

    def _release_trace_connection_credential(self) -> list[JsonObject]:
        """Model `release_trace_connection_credential`: decrypt from the fake Vault."""
        connection_id = self.rpc_params.get("in_connection_id")
        secret = self.client.vault_secrets.get(str(connection_id))
        if secret is None:
            msg = f"trace connection not found: {connection_id}"
            raise RuntimeError(msg)
        return [{"credential": secret}]

    def _register_optimizer_project_trace_source(self) -> list[JsonObject]:
        """Atomically model immutable source registration and current selection."""
        params = self.rpc_params
        acquisitions = self.client.tables.setdefault("optimizer_project_trace_acquisitions", [])
        acquisition = next(
            (
                row
                for row in acquisitions
                if row.get("id") == params.get("in_acquisition_id")
                and row.get("project_id") == params.get("in_project_id")
                and row.get("org_id") == params.get("in_org_id")
                and row.get("source_kind") == params.get("in_source_kind")
                and row.get("source_label") == params.get("in_source_label")
                and row.get("state") == "acquiring"
            ),
            None,
        )
        if acquisition is None:
            msg = "trace acquisition is not claimable for source registration"
            raise RuntimeError(msg)

        now = datetime.now(UTC).isoformat()
        sources = self.client.tables.setdefault("optimizer_project_trace_sources", [])
        source = next(
            (
                row
                for row in sources
                if row.get("project_id") == params.get("in_project_id")
                and row.get("source_kind") == params.get("in_source_kind")
                and row.get("sha256") == params.get("in_sha256")
            ),
            None,
        )
        if source is None:
            source = {
                "id": self.client.next_id("optimizer_project_trace_sources"),
                "project_id": params.get("in_project_id"),
                "org_id": params.get("in_org_id"),
                "source_kind": params.get("in_source_kind"),
                "source_label": params.get("in_source_label"),
                "sha256": params.get("in_sha256"),
                "byte_size": params.get("in_byte_size"),
                "content_type": params.get("in_content_type"),
                "record_count_estimate": params.get("in_record_count_estimate"),
                "acquired_at": now,
                "created_at": now,
            }
            sources.append(source)
            self.client.tables.setdefault("optimizer_project_trace_source_objects", []).append(
                {
                    "source_id": source["id"],
                    "storage_bucket": params.get("in_storage_bucket"),
                    "storage_path": params.get("in_storage_path"),
                    "created_at": now,
                }
            )
        elif (
            source.get("org_id") != params.get("in_org_id")
            or source.get("byte_size") != params.get("in_byte_size")
            or source.get("record_count_estimate") != params.get("in_record_count_estimate")
        ):
            msg = "deduplicated trace source metadata does not match"
            raise RuntimeError(msg)

        current_rows = self.client.tables.setdefault("optimizer_project_trace_current_sources", [])
        current = next(
            (row for row in current_rows if row.get("project_id") == source["project_id"]),
            None,
        )
        current_payload: JsonObject = {
            "project_id": source["project_id"],
            "org_id": source["org_id"],
            "source_id": source["id"],
            "selected_at": now,
        }
        if current is None:
            current_rows.append(current_payload)
        else:
            current.update(current_payload)

        acquisition.update(
            {
                "state": "succeeded",
                "cursor": {"complete": True},
                "records_acquired": params.get("in_record_count_estimate"),
                "byte_size": params.get("in_byte_size"),
                "error_code": None,
                "source_id": source["id"],
                "completed_at": now,
                "updated_at": now,
            }
        )
        return [dict(source)]

    def _adopt_default_model(self) -> list[JsonObject]:
        """Model `adopt_default_model`: re-home an endpoint and all it owns.

        Mirrors the migration function (20260730160000) update-for-update so
        CLI tests exercise the same move the database performs: the endpoint,
        its endpoint-keyed history, and (when present) its world model plus
        every org-scoped row that model owns.
        """
        target = "00000000-0000-0000-0000-000000000003"
        endpoint_id = self.rpc_params.get("p_endpoint_id")
        tables = self.client.tables
        endpoint = next(
            (row for row in tables.setdefault("endpoints", []) if row["id"] == endpoint_id),
            None,
        )
        if endpoint is None:
            msg = f"adopt_default_model: no endpoint with id {endpoint_id}"
            raise RuntimeError(msg)
        shared = endpoint.get("world_model_id") is not None and any(
            row.get("world_model_id") == endpoint["world_model_id"] and row["id"] != endpoint_id
            for row in tables.setdefault("endpoints", [])
        )
        if shared:
            msg = "adopt_default_model: world model also backs another endpoint"
            raise RuntimeError(msg)
        endpoint["org_id"] = target

        def re_home(table: str, key: str, value: object) -> None:
            for row in tables.setdefault(table, []):
                if row.get(key) == value:
                    row["org_id"] = target

        for table in ("runs", "serving_requests", "routing_optimize_jobs"):
            re_home(table, "endpoint_id", endpoint_id)
        world_model_id = endpoint.get("world_model_id")
        if world_model_id is not None:
            re_home("world_models", "id", world_model_id)
            for table in (
                "runs",
                "artifacts",
                "build_jobs",
                "trace_ingests",
                "trace_uploads",
                "telemetry_spans",
                "wm_rollouts",
                "wm_sessions",
                "agent_cost_reports",
                "agent_opt_runs",
                "agents",
            ):
                re_home(table, "world_model_id", world_model_id)
        return []

    def _rollback_catalog_import(self) -> list[JsonObject]:
        """Model `rollback_catalog_import`: delete + floored decrement, atomically."""
        world_model_id = self.rpc_params.get("in_world_model_id")
        entry_id = self.rpc_params.get("in_entry_id")
        tables = self.client.tables
        tables["trace_uploads"] = [
            row
            for row in tables.setdefault("trace_uploads", [])
            if row.get("world_model_id") != world_model_id
        ]
        tables["world_models"] = [
            row for row in tables.setdefault("world_models", []) if row["id"] != world_model_id
        ]
        for row in tables.setdefault("wm_catalog_entries", []):
            if row["id"] == entry_id:
                count = row.get("import_count", 0)
                current = count if isinstance(count, int) else 0
                row["import_count"] = max(current - 1, 0)
        return []

    def _ensure_account_starter_world_model(self) -> list[JsonObject]:
        """Model the atomic account starter-model provisioning RPC."""
        params = self.rpc_params
        user_id = params.get("in_user_id")
        catalog_name = params.get("in_catalog_name")
        model_name = params.get("in_model_name")
        workspace = next(
            (
                row
                for row in self.client.tables.setdefault("account_workspaces", [])
                if row.get("user_id") == user_id
            ),
            None,
        )
        if workspace is None:
            return []

        models = self.client.tables.setdefault("world_models", [])
        starter_id = workspace.get("starter_world_model_id")
        if starter_id is not None:
            starter = next((row for row in models if row.get("id") == starter_id), None)
            if (
                starter is None
                or starter.get("org_id") != workspace.get("org_id")
                or starter.get("status") != "ready"
            ):
                msg = f"invalid starter world-model pointer for account {user_id}"
                raise RuntimeError(msg)
            return [dict(starter)]

        entry = next(
            (
                row
                for row in self.client.tables.setdefault("wm_catalog_entries", [])
                if row.get("name") == catalog_name and row.get("deprecated_at") is None
            ),
            None,
        )
        if entry is None:
            msg = f"required starter catalog entry is missing: {catalog_name}"
            raise RuntimeError(msg)
        if any(
            row.get("org_id") == workspace.get("org_id") and row.get("name") == model_name
            for row in models
        ):
            msg = f"reserved starter world-model name is already in use: {model_name}"
            raise RuntimeError(msg)
        if entry.get("traces_storage_path") is not None and any(
            entry.get(column) is None
            for column in ("traces_filename", "traces_byte_size", "traces_sha256")
        ):
            msg = f"starter catalog entry {entry.get('id')} has an incomplete trace corpus pointer"
            raise RuntimeError(msg)

        now = datetime.now(tz=UTC).isoformat()
        model_id = self.client.next_id("world_models")
        raw_config = entry.get("config")
        raw_metrics = entry.get("metrics")
        starter = {
            "id": model_id,
            "org_id": workspace["org_id"],
            "name": model_name,
            "display_name": entry.get("display_name"),
            "status": "ready",
            "serve_provider": entry.get("serve_provider"),
            "serve_model": entry.get("serve_model"),
            "embed_provider": entry.get("embed_provider"),
            "embed_dim": entry.get("embed_dim"),
            "gepa_budget": None,
            "trace_adapter": entry.get("trace_adapter"),
            "config": dict(raw_config) if isinstance(raw_config, Mapping) else {},
            "artifact_id": None,
            "catalog_entry_id": entry["id"],
            "metrics": dict(raw_metrics) if isinstance(raw_metrics, Mapping) else None,
            "error": None,
            "created_at": now,
            "updated_at": now,
        }
        models.append(starter)
        count = entry.get("import_count", 0)
        entry["import_count"] = (count if isinstance(count, int) else 0) + 1

        if entry.get("traces_storage_path") is not None:
            uploads = self.client.tables.setdefault("trace_uploads", [])
            upload_id = self.client.next_id("trace_uploads")
            uploads.append(
                {
                    "id": upload_id,
                    "org_id": workspace["org_id"],
                    "world_model_id": model_id,
                    "filename": entry["traces_filename"],
                    "storage_path": entry["traces_storage_path"],
                    "byte_size": entry["traces_byte_size"],
                    "sha256": entry["traces_sha256"],
                    "adapter": entry["trace_adapter"],
                    "trace_count": entry.get("trace_count"),
                    "step_count": entry.get("step_count"),
                    "status": "uploaded",
                    "created_at": now,
                }
            )
            progress: JsonObject = {"phase": "completed"}
            if entry.get("trace_count") is not None:
                progress["traces"] = entry["trace_count"]
            if entry.get("step_count") is not None:
                progress["steps"] = entry["step_count"]
            self.client.tables.setdefault("build_jobs", []).append(
                {
                    "id": self.client.next_id("build_jobs"),
                    "org_id": workspace["org_id"],
                    "world_model_id": model_id,
                    "trace_upload_id": upload_id,
                    "evaluate": False,
                    "status": "completed",
                    "gepa_budget": None,
                    "runtime_backend": "catalog-import",
                    "runtime_call_id": None,
                    "worker_id": None,
                    "heartbeat_at": None,
                    "progress": progress,
                    "usage": None,
                    "error": None,
                    "started_at": now,
                    "finished_at": now,
                    "created_at": now,
                }
            )

        workspace["starter_world_model_id"] = model_id
        workspace["updated_at"] = now
        return [dict(starter)]

    def _search_telemetry_spans(self) -> list[JsonObject]:
        """Model `search_telemetry_spans`: filter, order, and page in Python.

        Mirrors the SQL semantics the store relies on: transcript (seq
        ascending) order when scoped to one producer row or span set, newest
        first otherwise, and case-insensitive substring search.
        """
        params = self.rpc_params
        query = params.get("in_query")
        pattern = str(query).strip().lower() if isinstance(query, str) and query.strip() else None
        sources = params.get("in_sources")
        kinds = params.get("in_kinds")
        status = params.get("in_status")
        has_reasoning = params.get("in_has_reasoning")
        source_ref = params.get("in_source_ref")
        span_set = params.get("in_span_set")
        agent_id = params.get("in_agent")
        world_model_id = params.get("in_world_model")
        after = params.get("in_after")
        before = params.get("in_before")
        rows = [
            row
            for row in self.client.tables.setdefault("telemetry_spans", [])
            if row.get("org_id") == params.get("in_org")
            and (not isinstance(sources, list) or row.get("source") in sources)
            and (not isinstance(kinds, list) or row.get("kind") in kinds)
            and (status is None or row.get("status") == status)
            and (has_reasoning is None or (row.get("reasoning") is not None) == bool(has_reasoning))
            and (source_ref is None or row.get("source_ref") == source_ref)
            and (span_set is None or row.get("span_set_id") == span_set)
            and (agent_id is None or row.get("agent_id") == agent_id)
            and (world_model_id is None or row.get("world_model_id") == world_model_id)
            and (after is None or str(row.get("started_at", "")) >= str(after))
            and (before is None or str(row.get("started_at", "")) < str(before))
            and (pattern is None or pattern in str(row.get("search_text", "")).lower())
        ]
        if source_ref is not None or span_set is not None:
            rows.sort(key=lambda row: (str(row.get("source_ref", "")), int(row.get("seq", 0) or 0)))
        else:
            rows.sort(
                key=lambda row: (str(row.get("started_at", "")), int(row.get("seq", 0) or 0)),
                reverse=True,
            )
        raw_limit = params.get("in_limit")
        raw_offset = params.get("in_offset")
        limit = min(max(raw_limit if isinstance(raw_limit, int) else 100, 1), 500)
        offset = max(raw_offset if isinstance(raw_offset, int) else 0, 0)
        return [dict(row) for row in rows[offset : offset + limit]]

    def _list_telemetry_groups(self) -> list[JsonObject]:
        """Model `list_telemetry_groups`: per-producer aggregation with labels."""
        params = self.rpc_params
        query = params.get("in_query")
        pattern = str(query).strip().lower() if isinstance(query, str) and query.strip() else None
        sources = params.get("in_sources")
        agent_id = params.get("in_agent")
        world_model_id = params.get("in_world_model")
        after = params.get("in_after")
        before = params.get("in_before")
        rows = [
            row
            for row in self.client.tables.setdefault("telemetry_spans", [])
            if row.get("org_id") == params.get("in_org")
            and (not isinstance(sources, list) or row.get("source") in sources)
            and (agent_id is None or row.get("agent_id") == agent_id)
            and (world_model_id is None or row.get("world_model_id") == world_model_id)
            and (after is None or str(row.get("started_at", "")) >= str(after))
            and (before is None or str(row.get("started_at", "")) < str(before))
        ]
        grouped: dict[tuple[str, str], list[JsonObject]] = {}
        for row in rows:
            key = (str(row.get("source")), str(row.get("source_ref")))
            grouped.setdefault(key, []).append(row)
        # The SQL EXISTS subquery matches the pattern against ALL of the
        # group's spans, not just the ones inside the time window.
        org_rows = [
            row
            for row in self.client.tables.setdefault("telemetry_spans", [])
            if row.get("org_id") == params.get("in_org")
        ]
        label_lookups = {
            "agent_session": ("agent_sessions", "title"),
            "rollout": ("wm_rollouts", "task"),
            "wm_session": ("wm_sessions", "task"),
            "trace_upload": ("trace_uploads", "filename"),
        }
        groups: list[JsonObject] = []
        for (source, source_ref), members in grouped.items():
            if pattern is not None and not any(
                pattern in str(candidate.get("search_text", "")).lower()
                for candidate in org_rows
                if str(candidate.get("source")) == source
                and str(candidate.get("source_ref")) == source_ref
            ):
                continue
            label: object = None
            lookup = label_lookups.get(source)
            if lookup is not None:
                table_name, column = lookup
                parent = next(
                    (
                        candidate
                        for candidate in self.client.tables.setdefault(table_name, [])
                        if candidate.get("id") == source_ref
                    ),
                    None,
                )
                if parent is not None:
                    label = parent.get(column)
            if label is None:
                names = sorted(
                    str(member["name"]) for member in members if member.get("name") is not None
                )
                label = names[-1] if names else source
            started = sorted(str(member.get("started_at", "")) for member in members)
            models = sorted(
                str(member["model"]) for member in members if member.get("model") is not None
            )
            groups.append(
                {
                    "source": source,
                    "source_ref": source_ref,
                    "label": label,
                    "model": models[-1] if models else None,
                    "span_count": len(members),
                    "error_count": sum(1 for member in members if member.get("status") == "error"),
                    "reasoning_count": sum(
                        1 for member in members if member.get("reasoning") is not None
                    ),
                    "first_at": started[0],
                    "last_at": started[-1],
                }
            )
        groups.sort(key=lambda group: str(group.get("last_at", "")), reverse=True)
        raw_limit = params.get("in_limit")
        raw_offset = params.get("in_offset")
        limit = min(max(raw_limit if isinstance(raw_limit, int) else 50, 1), 200)
        offset = max(raw_offset if isinstance(raw_offset, int) else 0, 0)
        return groups[offset : offset + limit]

    def _serving_rows_in_window(self) -> list[JsonObject]:
        """Shared filter for the serving-request RPC fakes: org, endpoint, window."""
        params = self.rpc_params
        endpoint = params.get("in_endpoint")
        project = params.get("in_project")
        after = params.get("in_after")
        before = params.get("in_before")
        return [
            row
            for row in self.client.tables.setdefault("serving_requests", [])
            if row.get("org_id") == params.get("in_org")
            and (endpoint is None or row.get("endpoint_id") == endpoint)
            and (
                project is None or row.get("optimizer_project_id", row.get("project_id")) == project
            )
            and (after is None or str(row.get("created_at", "")) >= str(after))
            and (before is None or str(row.get("created_at", "")) < str(before))
        ]

    def _list_serving_requests(self) -> list[JsonObject]:
        """Model `list_serving_requests`: newest first, keyset cursor, no bodies."""
        params = self.rpc_params
        status = params.get("in_status")
        cursor_ts = params.get("in_cursor_ts")
        cursor_id = params.get("in_cursor_id")
        rows = [
            row
            for row in self._serving_rows_in_window()
            if (status is None or row.get("status") == status)
            and (
                cursor_ts is None
                or cursor_id is None
                or (str(row.get("created_at", "")), str(row.get("id", "")))
                < (str(cursor_ts), str(cursor_id))
            )
        ]
        rows.sort(
            key=lambda row: (str(row.get("created_at", "")), str(row.get("id", ""))),
            reverse=True,
        )
        raw_limit = params.get("in_limit")
        limit = min(max(raw_limit if isinstance(raw_limit, int) else 50, 1), 200)
        listed_columns = (
            "id",
            "endpoint_id",
            "endpoint_label",
        )
        scalar_columns = (
            "input_tokens",
            "output_tokens",
            "cached_tokens",
            "cost_usd",
            "latency_ms",
            "ttfb_ms",
            "status",
            "error_message",
            "created_at",
        )
        return [
            {
                **{column: row.get(column) for column in listed_columns},
                "project_id": row.get("optimizer_project_id", row.get("project_id")),
                "billing_source": row.get(
                    "optimizer_project_billing_source", row.get("billing_source")
                ),
                "billing_components": row.get(
                    "optimizer_project_billing_breakdown", row.get("billing_components")
                ),
                **{column: row.get(column) for column in scalar_columns},
            }
            for row in rows[:limit]
        ]

    def _serving_request_stats(self) -> list[JsonObject]:
        """Model `serving_request_stats`: one aggregate row, percentile_cont."""
        rows = self._serving_rows_in_window()

        def percentile(values: list[float], fraction: float) -> float | None:
            if not values:
                return None
            ordered = sorted(values)
            position = fraction * (len(ordered) - 1)
            low = int(position)
            high = min(low + 1, len(ordered) - 1)
            return ordered[low] + (ordered[high] - ordered[low]) * (position - low)

        def numeric(value: object) -> float | None:
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                return float(value)
            return None

        def total(column: str) -> int:
            return int(sum(numeric(row.get(column)) or 0 for row in rows))

        latencies = [value for row in rows if (value := numeric(row.get("latency_ms"))) is not None]
        costs = [value for row in rows if (value := numeric(row.get("cost_usd"))) is not None]
        return [
            {
                "request_count": len(rows),
                "error_count": sum(1 for row in rows if row.get("status") == "error"),
                "unpriced_count": sum(1 for row in rows if row.get("cost_usd") is None),
                "cost_usd_total": sum(costs) if costs else None,
                "input_tokens_total": total("input_tokens"),
                "output_tokens_total": total("output_tokens"),
                "cached_tokens_total": total("cached_tokens"),
                "latency_p50_ms": percentile(latencies, 0.5),
                "latency_p95_ms": percentile(latencies, 0.95),
            }
        ]

    def _list_serving_request_buckets(self) -> list[JsonObject]:
        """Model `list_serving_request_buckets`: epoch-floor grouping."""
        raw_step = self.rpc_params.get("in_bucket_seconds")
        step = max(raw_step if isinstance(raw_step, int) else 86_400, 60)
        buckets: dict[int, list[JsonObject]] = {}
        for row in self._serving_rows_in_window():
            created = datetime.fromisoformat(str(row.get("created_at", "")))
            if created.tzinfo is None:
                # Postgres buckets in UTC; a naive fixture must not shift by
                # the test machine's local offset.
                created = created.replace(tzinfo=UTC)
            key = int(created.timestamp() // step) * step
            buckets.setdefault(key, []).append(row)
        return [
            {
                "bucket_start": datetime.fromtimestamp(key, tz=UTC).isoformat(),
                "request_count": len(members),
                "error_count": sum(1 for member in members if member.get("status") == "error"),
            }
            for key, members in sorted(buckets.items())
        ]

    def _list_serving_endpoints(self) -> list[JsonObject]:
        """Model `list_serving_endpoints`: per-endpoint roll-up, most recent first."""
        params = self.rpc_params
        grouped: dict[str, list[JsonObject]] = {}
        for row in self.client.tables.setdefault("serving_requests", []):
            if row.get("org_id") != params.get("in_org"):
                continue
            grouped.setdefault(str(row.get("endpoint_id")), []).append(row)
        endpoints: list[JsonObject] = [
            {
                "endpoint_id": endpoint_id,
                "endpoint_label": str(
                    max(members, key=lambda member: str(member.get("created_at", ""))).get(
                        "endpoint_label", ""
                    )
                ),
                "request_count": len(members),
                "last_at": max(str(member.get("created_at", "")) for member in members),
            }
            for endpoint_id, members in grouped.items()
        ]
        endpoints.sort(key=lambda endpoint: str(endpoint["last_at"]), reverse=True)
        return endpoints[:100]

    def _apply_yc_launch_grant(self) -> list[JsonObject]:
        """Model `apply_yc_launch_grant`: `yc` label + launch grant, idempotent.

        Mirrors the SQL function: applies the generalized ``yc`` org label,
        inserts the ``yc_launch`` grant (carrying its expiry + billable-spend
        snapshot) keyed on the org's unique source_ref, folds any signup promo
        in, and bumps the granted counter inline. A replay (grant already
        present) is a no-op with ``newly_applied`` False. The expiry defaults to
        3 months when the caller passes none.
        """
        org_id = self.rpc_params.get("in_org")
        amount = _fake_num(self.rpc_params.get("in_amount"))
        created_by = self.rpc_params.get("in_created_by")
        org = next(
            (
                row
                for row in self.client.tables.setdefault("organizations", [])
                if row.get("id") == org_id
            ),
            None,
        )
        if org is None:
            raise RuntimeError({"code": "P0002", "message": f"organization not found: {org_id}"})
        now = datetime.now(UTC)
        raw_expiry = self.rpc_params.get("in_expires_at")
        expires = str(raw_expiry) if raw_expiry else _shift_months(now, 3).isoformat()
        billable = _fake_num(org.get("billable_spend_usd"))

        # Apply the `yc` label (the YC-company gate), idempotent per (org, key).
        labels = self.client.tables.setdefault("org_labels", [])
        if not any(row.get("org_id") == org_id and row.get("key") == "yc" for row in labels):
            labels.append(
                {
                    "id": self.client.next_id("org_labels"),
                    "org_id": org_id,
                    "key": "yc",
                    "created_by": created_by or "00000000-0000-0000-0000-000000000000",
                    "created_at": now.isoformat(),
                }
            )

        # The launch grant, one per org (source_ref = the org). Replay = no-op.
        ledger = self.client.tables.setdefault("credit_ledger", [])
        grant_ref = f"yc-launch:{org_id}"
        did_grant = not any(
            row.get("source") == "yc_launch" and row.get("source_ref") == grant_ref
            for row in ledger
        )
        if did_grant:
            ledger.append(
                {
                    "id": self.client.next_id("credit_ledger"),
                    "org_id": org_id,
                    "entry_type": "grant",
                    "amount_usd": amount,
                    "reason": "YC launch grant",
                    "source": "yc_launch",
                    "source_ref": grant_ref,
                    "created_by": str(created_by) if created_by else None,
                    "created_at": now.isoformat(),
                    "expires_at": expires,
                    "billable_spend_at_grant_usd": billable,
                }
            )
            promo_granted = sum(
                _fake_num(row.get("amount_usd"))
                for row in ledger
                if row.get("org_id") == org_id and row.get("source") == "signup_promo"
            )
            if promo_granted > 0:
                ledger.append(
                    {
                        "id": self.client.next_id("credit_ledger"),
                        "org_id": org_id,
                        "entry_type": "adjustment",
                        "amount_usd": -promo_granted,
                        "reason": "Welcome credit folded into the YC launch grant",
                        "source": "yc_launch",
                        "source_ref": f"promo-reversal:{org_id}",
                        "created_by": str(created_by) if created_by else None,
                        "created_at": now.isoformat(),
                    }
                )
            # The ledger trigger maintains the granted counter.
            org["credit_granted_usd"] = (
                _fake_num(org.get("credit_granted_usd")) + amount - promo_granted
            )
        return [
            {
                "granted_usd": amount,
                "expires_at": expires,
                "balance_usd": _fake_num(org.get("credit_granted_usd")) - billable,
                "org_slug": org.get("slug"),
                "org_name": org.get("name"),
                "newly_applied": did_grant,
            }
        ]

    def _process_expiring_grants(self) -> int:
        """Model `process_expiring_grants`: claw back unspent expired grants.

        credit_ledger is append-only, so "already handled" is not a flag on the
        grant — it is the existence of the grant's own ``grant-expiry:<id>``
        adjustment. A grant past ``expires_at`` with no such adjustment is
        processed: the clawback is the unspent part (amount minus spend since the
        grant), capped at the live balance so the balance never goes negative. A
        fully-spent expired grant (clawback 0) writes nothing and is a harmless
        no-op on later passes.
        """
        now = datetime.now(UTC)
        ledger = self.client.tables.setdefault("credit_ledger", [])
        processed = 0
        for grant in list(ledger):
            if grant.get("entry_type") != "grant":
                continue
            expires_at = grant.get("expires_at")
            if not expires_at or datetime.fromisoformat(str(expires_at)) > now:
                continue
            marker = f"grant-expiry:{grant.get('id')}"
            if any(
                row.get("source") == "yc_launch" and row.get("source_ref") == marker
                for row in ledger
            ):
                continue
            org = next(
                (
                    row
                    for row in self.client.tables.get("organizations", [])
                    if row.get("id") == grant.get("org_id")
                ),
                None,
            )
            if org is None:
                continue
            billable_now = _fake_num(org.get("billable_spend_usd"))
            balance = _fake_num(org.get("credit_granted_usd")) - billable_now
            snapshot = _fake_num(grant.get("billable_spend_at_grant_usd"))
            unspent = max(0.0, _fake_num(grant.get("amount_usd")) - (billable_now - snapshot))
            clawback = min(unspent, max(0.0, balance))
            if clawback > 0:
                ledger.append(
                    {
                        "id": self.client.next_id("credit_ledger"),
                        "org_id": grant.get("org_id"),
                        "entry_type": "adjustment",
                        "amount_usd": -clawback,
                        "reason": "Expired grant clawback (unspent portion)",
                        "source": "yc_launch",
                        "source_ref": marker,
                        "created_by": None,
                        "created_at": now.isoformat(),
                    }
                )
                org["credit_granted_usd"] = _fake_num(org.get("credit_granted_usd")) - clawback
                processed += 1
        return processed

    def _upsert_welcome_trigger(self, org_id: str) -> JsonObject:
        """Upsert one org_welcome_trigger row per set_org_welcome_trigger.

        Activating bumps ``triggered_at``; deactivating keeps the last one. Uses
        the rpc params for the new state and a fixed clock for determinism.
        """
        params = self.rpc_params
        active = bool(params.get("in_active"))
        triggers = self.client.tables.setdefault("org_welcome_trigger", [])
        now = "2026-08-24T00:00:00Z"
        existing = next((r for r in triggers if r.get("org_id") == org_id), None)
        row: JsonObject = (
            existing if existing is not None else {"org_id": org_id, "triggered_at": now}
        )
        if existing is None:
            triggers.append(row)
        row["active"] = active
        row["display_credit_usd"] = params.get("in_display_credit_usd")
        row["show_api_key"] = bool(params.get("in_show_api_key"))
        if active:
            row["triggered_at"] = now
        row["updated_by"] = params.get("in_updated_by")
        row["updated_at"] = now
        return dict(row)

    def _set_org_welcome_trigger(self) -> list[JsonObject]:
        """Model `set_org_welcome_trigger`: upsert one org's welcome trigger."""
        org_id = self.rpc_params.get("in_org")
        return [self._upsert_welcome_trigger(str(org_id))]

    def _apply_welcome_trigger_by_label(self) -> int:
        """Model `apply_welcome_trigger_by_label`: upsert for every labelled org."""
        key = self.rpc_params.get("in_key")
        org_ids = [
            str(row.get("org_id"))
            for row in self.client.tables.setdefault("org_labels", [])
            if row.get("key") == key
        ]
        for org_id in org_ids:
            self._upsert_welcome_trigger(org_id)
        return len(org_ids)

    def _claim_welcome_trigger_showing(self) -> bool:
        """Model `claim_welcome_trigger_showing`: atomic conditional seen-marker.

        Returns True only when this call inserts or advances the caller's seen
        marker (i.e. the activation is newer than what they last saw), matching
        the partial ON CONFLICT ... WHERE that makes exactly one racing caller
        win. The real function derives the user from the JWT; the fake accepts an
        optional ``in_user`` for exercising the marker table in-process.
        """
        params = self.rpc_params
        user_id = str(params.get("in_user") or "fake-user")
        org_id = str(params.get("in_org"))
        triggered_at = str(params.get("in_triggered_at"))
        seen = self.client.tables.setdefault("user_welcome_trigger_seen", [])
        existing = next(
            (r for r in seen if r.get("user_id") == user_id and r.get("org_id") == org_id),
            None,
        )
        if existing is None:
            seen.append({"user_id": user_id, "org_id": org_id, "seen_triggered_at": triggered_at})
            return True
        if str(existing.get("seen_triggered_at")) < triggered_at:
            existing["seen_triggered_at"] = triggered_at
            return True
        return False

    def _list_runs(self) -> list[JsonObject]:
        """Model `list_runs`: cross-org keyset list, newest first, org name joined."""
        params = self.rpc_params
        org = params.get("in_org")
        status = params.get("in_status")
        kind = params.get("in_kind")
        cursor_ts = params.get("in_cursor_ts")
        cursor_id = params.get("in_cursor_id")
        names = {
            str(row.get("id")): row.get("name")
            for row in self.client.tables.setdefault("organizations", [])
        }
        rows = [
            row
            for row in self.client.tables.setdefault("runs", [])
            if (org is None or row.get("org_id") == org)
            and (status is None or row.get("status") == status)
            and (kind is None or row.get("kind") == kind)
            and (
                cursor_ts is None
                or cursor_id is None
                or (str(row.get("created_at", "")), str(row.get("id", "")))
                < (str(cursor_ts), str(cursor_id))
            )
        ]
        rows.sort(
            key=lambda row: (str(row.get("created_at", "")), str(row.get("id", ""))), reverse=True
        )
        raw_limit = params.get("in_limit")
        limit = min(max(raw_limit if isinstance(raw_limit, int) else 50, 1), 200)
        listed_columns = (
            "id",
            "org_id",
            "external_id",
            "kind",
            "status",
            "benchmark",
            "arm",
            "world_model_id",
            "endpoint_id",
            "progress",
            "candidate_usd",
            "compressor_usd",
            "wm_usd",
            "error",
            "started_at",
            "heartbeat_at",
            "finished_at",
            "created_at",
        )
        return [
            {
                **{column: row.get(column) for column in listed_columns},
                "org_name": names.get(str(row.get("org_id"))),
            }
            for row in rows[:limit]
        ]

    def _run_cell_rows(self) -> list[JsonObject]:
        """Shared filter for the run-cell RPC fakes: one run's cells."""
        return [
            row
            for row in self.client.tables.setdefault("run_cells", [])
            if row.get("run_id") == self.rpc_params.get("in_run")
        ]

    def _list_run_cells(self) -> list[JsonObject]:
        """Model `list_run_cells`: model/scored filters, keyset by cell_key."""
        params = self.rpc_params
        model = params.get("in_model")
        scored = params.get("in_scored")
        errored = params.get("in_error")
        cursor_key = params.get("in_cursor_key")
        rows = [
            row
            for row in self._run_cell_rows()
            if (model is None or row.get("model") == model)
            and (
                scored is None
                or (scored and row.get("reward") is not None)
                or (not scored and row.get("reward") is None)
            )
            and (
                errored is None
                or (errored and row.get("error") is not None)
                or (not errored and row.get("error") is None)
            )
            and (cursor_key is None or str(row.get("cell_key", "")) > str(cursor_key))
        ]
        rows.sort(key=lambda row: str(row.get("cell_key", "")))
        raw_limit = params.get("in_limit")
        limit = min(max(raw_limit if isinstance(raw_limit, int) else 100, 1), 500)
        listed_columns = (
            "cell_key",
            "chunk",
            "scenario_id",
            "model",
            "episode",
            "reward",
            "success",
            "steps",
            "stop_reason",
            "error",
            "usage",
            "cost_usd",
            "detail",
            "updated_at",
        )
        return [{column: row.get(column) for column in listed_columns} for row in rows[:limit]]

    def _run_cell_stats(self) -> list[JsonObject]:
        """Model `run_cell_stats`: per-model counts, spend, and reward mean."""
        grouped: dict[str, list[JsonObject]] = {}
        for row in self._run_cell_rows():
            grouped.setdefault(str(row.get("model")), []).append(row)
        stats: list[JsonObject] = []
        for model, members in sorted(grouped.items()):
            rewards = [
                float(reward)
                for member in members
                if isinstance(reward := member.get("reward"), int | float)
            ]
            costs = [
                float(cost)
                for member in members
                if isinstance(cost := member.get("cost_usd"), int | float)
            ]
            stats.append(
                {
                    "model": model,
                    "cell_count": len(members),
                    "scored_count": sum(
                        1 for member in members if member.get("reward") is not None
                    ),
                    "error_count": sum(1 for member in members if member.get("error") is not None),
                    "unpriced_count": sum(
                        1 for member in members if member.get("cost_usd") is None
                    ),
                    "cost_usd_total": sum(costs) if costs else None,
                    "reward_mean": sum(rewards) / len(rewards) if rewards else None,
                }
            )
        return stats

    def _catalog_like_counts(self) -> list[JsonObject]:
        """Model the `catalog_like_counts` SQL aggregate: group-by tally."""
        raw_ids = self.rpc_params.get("in_entry_ids")
        entry_ids = {str(value) for value in raw_ids} if isinstance(raw_ids, list) else set()
        counts: dict[str, int] = {}
        for row in self.client.tables.setdefault("wm_catalog_entry_likes", []):
            entry_id = str(row["entry_id"])
            if entry_id in entry_ids:
                counts[entry_id] = counts.get(entry_id, 0) + 1
        return [{"entry_id": entry_id, "like_count": count} for entry_id, count in counts.items()]

    def _record_wm_step(self) -> list[JsonObject]:
        """Model the `record_wm_step` SQL function: claim + insert atomically.

        Either the session claim (active-status guard, dense step_index check,
        counter bump, optional usage replacement) and the ``wm_steps`` insert
        both happen, or neither does and zero rows come back.
        """
        params = self.rpc_params
        session = next(
            (
                row
                for row in self.client.tables.setdefault("wm_sessions", [])
                if row.get("id") == params["in_session_id"]
                and row.get("step_count") == params["in_step_index"]
                and row.get("status") == "active"
            ),
            None,
        )
        if session is None:
            return []
        step_index = session.get("step_count")
        if not isinstance(step_index, int):
            msg = "fake wm_sessions row has a non-integer step_count"
            raise TypeError(msg)
        now = datetime.now(tz=UTC).isoformat()
        session["step_count"] = step_index + 1
        session["last_step_at"] = now
        usage = params.get("in_usage")
        if usage is not None:
            session["usage"] = usage
            # The typed totals travel with the usage summary; token args left
            # null beside a summary keep the row's accumulated counts (SQL:
            # coalesce(in_*, wm_sessions.*)), while a null cost alongside a
            # summary means "unpriced serve model" and overwrites.
            in_input = params.get("in_input_tokens")
            in_output = params.get("in_output_tokens")
            session["input_tokens"] = (
                in_input if in_input is not None else session.get("input_tokens", 0)
            )
            session["output_tokens"] = (
                in_output if in_output is not None else session.get("output_tokens", 0)
            )
            session["cost_usd"] = params.get("in_cost_usd")
        step: JsonObject = {
            "id": self.client.next_id("wm_steps"),
            "wm_session_id": params["in_session_id"],
            "step_index": step_index,
            "action": params["in_action"],
            "observation": params["in_observation"],
            "latency_ms": params.get("in_latency_ms"),
            "created_at": now,
        }
        self.client.tables.setdefault("wm_steps", []).append(step)
        return [dict(step)]


class FakeStorage:
    """In-memory Supabase Storage facade."""

    def __init__(self) -> None:
        """Initialize fake storage buckets."""
        self.uploads: dict[tuple[str, str], bytes] = {}

    def from_(self, bucket: str) -> FakeStorageBucket:
        """Return a fake bucket client."""
        return FakeStorageBucket(bucket=bucket, uploads=self.uploads)


@dataclass(frozen=True)
class _FakeRawStorageHttp:
    """Accepts the raw-body upload the seed path sends (see storage_retry)."""

    uploads: dict[tuple[str, str], bytes]

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str] | None = None,
        content: bytes = b"",
    ) -> httpx.Response:
        """Store the raw body at the addressed bucket/path."""
        _ = headers
        assert method == "POST"
        prefix = "https://supabase.local/storage/v1/object/"
        assert url.startswith(prefix), url
        bucket, _sep, path = url.removeprefix(prefix).partition("/")
        self.uploads[(bucket, path)] = content
        return httpx.Response(200, request=httpx.Request(method, url))


@dataclass(frozen=True)
class FakeStorageBucket:
    """In-memory storage bucket."""

    bucket: str
    uploads: dict[tuple[str, str], bytes]

    # The seed's raw-body upload path (storage_retry.upload_seed_object)
    # reaches storage3's private authed httpx client; the fake mirrors that
    # private surface so seeds against the fake exercise the same shape.
    @property
    def _base_url(self) -> str:
        return "https://supabase.local/storage/v1/"

    @property
    def _client(self) -> _FakeRawStorageHttp:
        return _FakeRawStorageHttp(uploads=self.uploads)

    def upload(
        self,
        path: str,
        file: bytes,
        file_options: Mapping[str, object] | None = None,
    ) -> object:
        """Store uploaded bytes."""
        _ = file_options
        self.uploads[(self.bucket, path)] = file
        return {"path": path}

    def download(self, path: str) -> bytes:
        """Return previously stored bytes."""
        return self.uploads[(self.bucket, path)]

    def create_signed_url(self, path: str, expires_in: int) -> JsonObject:
        """Return a fake signed URL."""
        return {
            "signedURL": f"https://supabase.local/{self.bucket}/{path}?expires_in={expires_in}",
            "path": path,
        }

    def create_signed_upload_url(self, path: str) -> JsonObject:
        """Return a path-bound fake signed upload URL that cannot overwrite."""
        if (self.bucket, path) in self.uploads:
            msg = "The resource already exists"
            raise RuntimeError(msg)
        token = f"fake-{uuid.uuid4().hex}"
        return {
            "signed_url": (
                f"https://supabase.local/storage/v1/object/upload/sign/"
                f"{self.bucket}/{path}?token={token}"
            ),
            "token": token,
            "path": path,
        }

    def move(self, from_path: str, to_path: str) -> object:
        """Reassign stored bytes to a new path."""
        self.uploads[(self.bucket, to_path)] = self.uploads.pop((self.bucket, from_path))
        return {"message": "Successfully moved"}

    def remove(self, paths: Sequence[str]) -> object:
        """Remove stored bytes, ignoring paths that are already absent."""
        return [
            {"name": path}
            for path in paths
            if self.uploads.pop((self.bucket, path), None) is not None
        ]


class FakeDownloadStorage:
    """In-memory storage facade whose buckets also support download.

    The shared ``SupabaseStorage`` protocol only covers upload and signed
    URLs, so ``FakeSupabaseClient`` defaults to ``FakeStorage``. Tests that
    exercise download-capable boundaries (e.g. trace staging) swap this facade
    in over the client's existing uploads map::

        client.storage = FakeDownloadStorage(client.fake_storage.uploads)
    """

    def __init__(self, uploads: dict[tuple[str, str], bytes]) -> None:
        """Initialize the facade over a shared uploads map."""
        self.uploads = uploads

    def from_(self, bucket: str) -> FakeDownloadStorageBucket:
        """Return a download-capable fake bucket client."""
        return FakeDownloadStorageBucket(bucket=bucket, uploads=self.uploads)


@dataclass(frozen=True)
class FakeDownloadStorageBucket:
    """In-memory storage bucket that also supports download."""

    bucket: str
    uploads: dict[tuple[str, str], bytes]

    # Mirror the private storage3 surface the raw-body upload path reaches
    # (storage_retry.upload_object_raw), same as FakeStorageBucket.
    @property
    def _base_url(self) -> str:
        return "https://supabase.local/storage/v1/"

    @property
    def _client(self) -> _FakeRawStorageHttp:
        return _FakeRawStorageHttp(uploads=self.uploads)

    def upload(
        self,
        path: str,
        file: bytes,
        file_options: Mapping[str, object] | None = None,
    ) -> object:
        """Store uploaded bytes."""
        _ = file_options
        self.uploads[(self.bucket, path)] = file
        return {"path": path}

    def create_signed_url(self, path: str, expires_in: int) -> JsonObject:
        """Return a fake signed URL."""
        return {
            "signedURL": f"https://supabase.local/{self.bucket}/{path}?expires_in={expires_in}",
            "path": path,
        }

    def create_signed_upload_url(self, path: str) -> JsonObject:
        """Return a path-bound fake signed upload URL that cannot overwrite."""
        if (self.bucket, path) in self.uploads:
            msg = "The resource already exists"
            raise RuntimeError(msg)
        token = f"fake-{uuid.uuid4().hex}"
        return {
            "signed_url": (
                f"https://supabase.local/storage/v1/object/upload/sign/"
                f"{self.bucket}/{path}?token={token}"
            ),
            "token": token,
            "path": path,
        }

    def move(self, from_path: str, to_path: str) -> object:
        """Reassign stored bytes to a new path."""
        self.uploads[(self.bucket, to_path)] = self.uploads.pop((self.bucket, from_path))
        return {"message": "Successfully moved"}

    def remove(self, paths: Sequence[str]) -> object:
        """Remove stored bytes, ignoring paths that are already absent."""
        return [
            {"name": path}
            for path in paths
            if self.uploads.pop((self.bucket, path), None) is not None
        ]

    def download(self, path: str) -> bytes:
        """Return previously stored bytes."""
        return self.uploads[(self.bucket, path)]


def _payload_sequence(json: JsonPayload | Sequence[JsonPayload]) -> list[JsonObject]:
    """Normalize one-or-many payloads."""
    if isinstance(json, Mapping):
        return [{str(key): value for key, value in json.items()}]
    return [{str(key): value for key, value in item.items()} for item in json]


def _order_key(value: object) -> tuple[int, float, str]:
    """Return a SQL-like sort key: numerics numerically, text lexically, NULLs last."""
    if value is None:
        return (2, 0.0, "")
    if isinstance(value, bool | int | float):
        return (0, float(value), "")
    return (1, 0.0, str(value))


class _FakeNegation:
    """The ``not_`` chain: negates the next filter onto the parent query."""

    def __init__(self, query: FakeQuery) -> None:
        self._query = query

    def is_(self, column: str, value: object) -> FakeQuery:
        """Add a negated IS filter (``NOT column IS value``)."""
        self._query.not_is_filters.append((column, None if value == "null" else value))
        return self._query


def _matches(row: JsonObject, filters: list[tuple[str, object]]) -> bool:
    """Return whether a row matches equality filters."""
    return all(row.get(column) == value for column, value in filters)


def _matches_not_is(row: JsonObject, not_is_filters: list[tuple[str, object]]) -> bool:
    """Return whether a row matches all negated IS filters."""
    return all(row.get(column) is not value for column, value in not_is_filters)


def _matches_in(row: JsonObject, in_filters: list[tuple[str, list[object]]]) -> bool:
    """Return whether a row matches all membership (``in``) filters."""
    return all(row.get(column) in values for column, values in in_filters)


def _matches_gt(row: JsonObject, gt_filters: list[tuple[str, object]]) -> bool:
    """Return whether a row matches all greater-than filters.

    Covers the same two column shapes as ``_matches_lte``: numbers, and text
    (including ISO-8601 timestamps, which sort lexicographically because every
    writer stamps them in the same UTC format). Comparing only numbers made
    ``gt`` on a text column match nothing, which silently turned any keyset
    page over a text key into an empty result. A NULL never satisfies a bound,
    matching SQL.
    """
    for column, value in gt_filters:
        cell = row.get(column)
        if cell is None:
            return False
        if isinstance(cell, bool | int | float) and isinstance(value, bool | int | float):
            if cell <= value:
                return False
        elif str(cell) <= str(value):
            return False
    return True


def _matches_gte(row: JsonObject, gte_filters: list[tuple[str, object]]) -> bool:
    """Return whether a row matches all greater-than-or-equal filters.

    Covers the same number and ISO-8601 timestamp-string shapes as
    ``_matches_gt`` (inclusive lower bounds on a recent window). A NULL never
    satisfies a bound, matching SQL.
    """
    for column, value in gte_filters:
        cell = row.get(column)
        if cell is None:
            return False
        if isinstance(cell, bool | int | float) and isinstance(value, bool | int | float):
            if cell < value:
                return False
        elif str(cell) < str(value):
            return False
    return True


def _matches_lte(row: JsonObject, lte_filters: list[tuple[str, object]]) -> bool:
    """Return whether a row matches all less-than-or-equal filters.

    Covers the two column shapes the platform compares this way: numbers, and
    ISO-8601 timestamp strings, which sort lexicographically because every
    writer stamps them in the same UTC format. A NULL never satisfies a bound,
    matching SQL.
    """
    for column, value in lte_filters:
        cell = row.get(column)
        if cell is None:
            return False
        if isinstance(cell, bool | int | float) and isinstance(value, bool | int | float):
            if cell > value:
                return False
        elif str(cell) > str(value):
            return False
    return True


def _find_conflict(
    table: list[JsonObject],
    payload: JsonObject,
    conflict_columns: tuple[str, ...],
) -> JsonObject | None:
    """Find a row matching conflict columns."""
    for row in table:
        if all(row.get(column) == payload.get(column) for column in conflict_columns):
            return row
    return None


def test_fake_supabase_upsert_updates_conflict_row() -> None:
    """The fake client models Supabase upsert conflict behavior."""
    client = FakeSupabaseClient()

    first = (
        client.table("organizations")
        .upsert(
            {"org_id": "org", "slug": "same", "name": "old"},
            on_conflict="org_id,slug",
        )
        .execute()
        .data[0]
    )
    second = (
        client.table("organizations")
        .upsert(
            {"org_id": "org", "slug": "same", "name": "new"},
            on_conflict="org_id,slug",
        )
        .execute()
        .data[0]
    )

    assert first["id"] == second["id"]
    assert client.tables["organizations"][0]["name"] == "new"


def test_fake_supabase_select_orders_and_limits() -> None:
    """The fake client models PostgREST ordering combined with a row limit."""
    client = FakeSupabaseClient()
    client.tables["organizations"] = [
        {"id": "a", "created_at": "2026-06-06T00:00:00Z"},
        {"id": "c", "created_at": "2026-06-06T09:00:00Z"},
        {"id": "b", "created_at": "2026-06-06T05:00:00Z"},
    ]

    newest = (
        client.table("organizations").select().order("created_at", desc=True).limit(1).execute()
    )
    oldest_first = client.table("organizations").select().order("created_at").execute()

    assert [row["id"] for row in newest.data] == ["c"]
    assert [row["id"] for row in oldest_first.data] == ["a", "b", "c"]


def test_fake_supabase_range_windows_rows_and_counts_all_matches() -> None:
    """range() returns the inclusive window; count='exact' reports the pre-window total."""
    client = FakeSupabaseClient()
    client.tables["organizations"] = [
        {"id": "a", "created_at": "2026-06-06T00:00:00Z"},
        {"id": "b", "created_at": "2026-06-06T05:00:00Z"},
        {"id": "c", "created_at": "2026-06-06T09:00:00Z"},
    ]

    windowed = (
        client.table("organizations")
        .select(count="exact")
        .order("created_at", desc=True)
        .range(1, 2)
        .execute()
    )
    uncounted = client.table("organizations").select().order("created_at").execute()

    assert [row["id"] for row in windowed.data] == ["b", "a"]
    assert windowed.count == 3
    assert uncounted.count is None


def test_fake_supabase_orders_numeric_columns_numerically() -> None:
    """Integer columns sort by value rather than lexically, matching SQL."""
    client = FakeSupabaseClient()
    client.tables["wm_steps"] = [
        {"id": "s10", "step_index": 10},
        {"id": "s2", "step_index": 2},
        {"id": "s0", "step_index": 0},
    ]

    ordered = client.table("wm_steps").select().order("step_index").execute()

    assert [row["step_index"] for row in ordered.data] == [0, 2, 10]


def test_fake_download_storage_serves_uploaded_bytes() -> None:
    """The download-capable facade round-trips bytes over the shared uploads map."""
    client = FakeSupabaseClient()
    storage = FakeDownloadStorage(client.fake_storage.uploads)
    client.storage = storage

    storage.from_("explabs-artifacts").upload("org/traces.jsonl", b"trace-bytes")

    assert client.fake_storage.uploads[("explabs-artifacts", "org/traces.jsonl")] == b"trace-bytes"
    assert storage.from_("explabs-artifacts").download("org/traces.jsonl") == b"trace-bytes"


def test_fake_supabase_delete_removes_matching_rows_and_returns_them() -> None:
    """Delete honors filters, removes rows, and returns deleted copies."""
    client = FakeSupabaseClient()
    client.tables["world_models"] = [
        {"id": "wm-1", "org_id": "o1"},
        {"id": "wm-2", "org_id": "o2"},
    ]

    deleted = client.table("world_models").delete().eq("id", "wm-1").execute()
    missing = client.table("world_models").delete().eq("id", "wm-1").execute()

    assert [row["id"] for row in deleted.data] == ["wm-1"]
    assert missing.data == []
    assert [row["id"] for row in client.tables["world_models"]] == ["wm-2"]
