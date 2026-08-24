# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Typed repository helpers around the Supabase Python client."""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from typing import Protocol, Self, TypeVar, runtime_checkable

type JsonObject = dict[str, object]
type JsonPayload = Mapping[str, object]


class SupabaseQueryResult(Protocol):
    """Supabase query result shape used by repository stores."""

    @property
    def data(self) -> list[JsonObject]:
        """Return result rows."""
        ...

    @property
    def count(self) -> int | None:
        """Return the total matching-row count when the query requested one."""
        ...


_QueryT_co = TypeVar("_QueryT_co", covariant=True)


class SupabaseNegatedFilter(Protocol[_QueryT_co]):
    """The ``not_`` chain: applies the next filter negated onto the query."""

    def is_(self, column: str, value: object) -> _QueryT_co:
        """Filter by NOT IS; PostgREST spells SQL NULL as the string "null"."""
        ...


class SupabaseQueryBuilder(Protocol):
    """Subset of the Supabase table query builder used by platform stores."""

    def select(self, columns: str = "*", *, count: str | None = None) -> Self:
        """Select columns, optionally requesting a total row count (``exact``)."""
        ...

    def insert(self, json: JsonPayload | Sequence[JsonPayload]) -> Self:
        """Insert one row or many rows."""
        ...

    def upsert(
        self,
        json: JsonPayload | Sequence[JsonPayload],
        *,
        on_conflict: str | None = None,
        ignore_duplicates: bool = False,
    ) -> Self:
        """Upsert one row or many rows."""
        ...

    def update(self, json: JsonPayload) -> Self:
        """Update rows."""
        ...

    def eq(self, column: str, value: object) -> Self:
        """Filter by equality."""
        ...

    def in_(self, column: str, values: Sequence[object]) -> Self:
        """Filter by membership in a set of values."""
        ...

    def is_(self, column: str, value: object) -> Self:
        """Filter by IS; PostgREST spells SQL NULL as the string "null"."""
        ...

    @property
    def not_(self) -> SupabaseNegatedFilter[Self]:
        """Negate the next filter (postgrest's ``query.not_.is_(...)`` chain)."""
        ...

    def gt(self, column: str, value: object) -> Self:
        """Filter by greater-than (used for cursor paging by monotonic keys)."""
        ...

    def gte(self, column: str, value: object) -> Self:
        """Filter by greater-than-or-equal (used for inclusive window lower bounds)."""
        ...

    def lte(self, column: str, value: object) -> Self:
        """Filter by less-than-or-equal (used for inclusive visibility cutoffs)."""
        ...

    def order(self, column: str, *, desc: bool = False) -> Self:
        """Order returned rows by a column."""
        ...

    def limit(self, count: int) -> Self:
        """Limit returned rows."""
        ...

    def range(self, start: int, end: int) -> Self:
        """Return only rows in the inclusive [start, end] window."""
        ...

    def execute(self) -> SupabaseQueryResult:
        """Execute the query."""
        ...


@runtime_checkable
class DeleteCapableQuery(Protocol):
    """Query builder that also supports PostgREST DELETE.

    ``SupabaseQueryBuilder`` deliberately stays delete-less; deleting stores
    check this narrow capability protocol at runtime instead of widening the
    client type everywhere. Client-side proxies that wrap the real builder
    (e.g. the retry proxy) must forward ``delete`` so the capability survives
    wrapping.
    """

    def delete(self) -> SupabaseQueryBuilder:
        """Start a delete statement."""
        ...


class SupabaseStorageBucket(Protocol):
    """Subset of Supabase Storage bucket methods used by artifacts."""

    def upload(
        self,
        path: str,
        file: bytes,
        file_options: Mapping[str, object] | None = None,
    ) -> object:
        """Upload bytes to storage."""
        ...

    def create_signed_url(self, path: str, expires_in: int) -> JsonObject:
        """Create a signed URL for a stored object."""
        ...

    def create_signed_upload_url(self, path: str) -> JsonObject:
        """Create a signed URL a client can PUT object bytes to directly."""
        ...

    def move(self, from_path: str, to_path: str) -> object:
        """Move a stored object to a new path within the bucket."""
        ...


class SupabaseStorage(Protocol):
    """Supabase Storage facade."""

    def from_(self, bucket: str) -> SupabaseStorageBucket:
        """Return a storage bucket client."""
        ...


@runtime_checkable
class RemoveCapableStorageBucket(Protocol):
    """Storage bucket client that can permanently remove objects."""

    def remove(self, paths: Sequence[str]) -> object:
        """Permanently remove stored objects by path."""
        ...


class SupabaseClient(Protocol):
    """Subset of Supabase client methods used by platform stores."""

    storage: SupabaseStorage

    def table(self, table_name: str) -> SupabaseQueryBuilder:
        """Return a table query builder."""
        ...

    def rpc(self, fn: str, params: JsonPayload | None = None) -> SupabaseQueryBuilder:
        """Return an RPC query builder."""
        ...


class RepositoryError(RuntimeError):
    """Raised when a repository operation returns an invalid shape."""


def payload_copy(payload: JsonPayload) -> JsonObject:
    """Return a mutable JSON payload copy.

    Args:
        payload: JSON-compatible mapping.

    Returns:
        Copied payload.
    """
    return dict(payload)


def first_row(result: SupabaseQueryResult, *, context: str) -> JsonObject:
    """Return the first query result row.

    Args:
        result: Supabase query result.
        context: Operation label used in error messages.

    Returns:
        First result row.

    Raises:
        RepositoryError: If the query returned no rows.
    """
    data: object = result.data
    if isinstance(data, Mapping):
        return _json_object_from_items(data.items(), context=context)
    if not data:
        msg = f"{context} returned no rows"
        raise RepositoryError(msg)
    if isinstance(data, Sequence) and not isinstance(data, (str, bytes)):
        row = data[0]
        if isinstance(row, Mapping):
            return _json_object_from_items(row.items(), context=context)
    msg = f"{context} returned invalid row payload"
    raise RepositoryError(msg)


def result_rows(result: SupabaseQueryResult) -> tuple[JsonObject, ...]:
    """Return copied query result rows.

    Args:
        result: Supabase query result.

    Returns:
        Result rows.

    Raises:
        RepositoryError: If ``data`` is not a row list. A scalar-returning
            Postgres function comes back from PostgREST as a bare value (not a
            list), which is not iterable here; route those through
            ``result_scalar_int`` or ``result_scalar_strings`` instead of
            failing with a cryptic TypeError.
    """
    data: object = result.data
    if not isinstance(data, Sequence) or isinstance(data, (str, bytes)):
        msg = (
            f"result_rows expected a row list but got {type(data).__name__}; "
            "a scalar-returning RPC must use result_scalar_int or "
            "result_scalar_strings"
        )
        raise RepositoryError(msg)
    return tuple(dict(row) for row in data)


def is_unique_violation(error: Exception) -> bool:
    """Return whether an exception is a PostgreSQL unique-violation (23505).

    postgrest surfaces the SQLSTATE either as a ``code`` attribute or inside a
    dict argument depending on the client version, so both shapes are checked.
    """
    direct = getattr(error, "code", None)
    if direct == "23505":
        return True
    return any(
        isinstance(argument, dict) and argument.get("code") == "23505" for argument in error.args
    )


def result_scalar_int(result: SupabaseQueryResult) -> int:
    """Return an integer-returning RPC's scalar result as an ``int``.

    PostgREST returns a scalar-returning Postgres function's result BARE in
    ``data`` (e.g. ``5``), not as a list of rows, so such a call cannot go
    through ``result_rows``. Accept the bare int (the real shape), and defend the
    one-row-list and single-key-object shapes some client paths wrap it in,
    defaulting an empty result to 0.

    Args:
        result: Supabase RPC result for an integer-returning function.

    Returns:
        The scalar as an int, or 0 for an empty/absent result.
    """
    data: object = result.data
    if isinstance(data, Mapping):
        data = next(iter(data.values()), 0) if data else 0
    elif isinstance(data, Sequence) and not isinstance(data, (str, bytes)):
        data = data[0] if data else 0
        if isinstance(data, Mapping):
            data = next(iter(data.values()), 0) if data else 0
    match data:
        case bool():
            # bool is an int subclass; normalize before the int branch.
            return int(data)
        case int():
            return data
        case str() if data.strip():
            return int(data)
        case _:
            return 0


def result_scalar_strings(result: SupabaseQueryResult) -> tuple[str, ...]:
    """Return a set-returning text RPC's scalar results as strings.

    PostgREST returns a set-returning scalar Postgres function's results as a
    bare JSON array of values (e.g. ``["request-a", "request-b"]``), not as a
    list of row objects, so such a call cannot go through ``result_rows``.
    Accept that real shape and default an empty/absent result to an empty
    tuple; unexpected values fail at the typed boundary rather than dropping
    claimed ids.

    Args:
        result: Supabase RPC result for a set-returning text function.

    Returns:
        The returned scalar strings, or an empty tuple for no results.

    Raises:
        RepositoryError: If ``data`` is not an array of strings.
    """
    data: object = result.data
    if data is None:
        return ()
    if not isinstance(data, Sequence) or isinstance(data, (str, bytes)):
        msg = (
            f"result_scalar_strings expected a bare array of strings but got {type(data).__name__}"
        )
        raise RepositoryError(msg)
    values: list[str] = []
    for value in data:
        if not isinstance(value, str):
            msg = (
                "result_scalar_strings expected a bare array of strings but "
                f"got {type(value).__name__} item"
            )
            raise RepositoryError(msg)
        values.append(value)
    return tuple(values)


def _json_object_from_items(
    items: Iterable[tuple[object, object]],
    *,
    context: str,
) -> JsonObject:
    """Validate and copy a Supabase object payload."""
    row: JsonObject = {}
    for key, value in items:
        if not isinstance(key, str):
            msg = f"{context} returned invalid row key"
            raise RepositoryError(msg)
        row[key] = value
    return row


def insert_row(client: SupabaseClient, table_name: str, payload: JsonPayload) -> JsonObject:
    """Insert one row and return it.

    Args:
        client: Supabase client.
        table_name: Table name.
        payload: Row payload.

    Returns:
        Inserted row.
    """
    result = client.table(table_name).insert(payload_copy(payload)).execute()
    return first_row(result, context=f"insert into {table_name}")


def insert_rows(
    client: SupabaseClient,
    table_name: str,
    payloads: Sequence[JsonPayload],
) -> tuple[JsonObject, ...]:
    """Insert many rows in one PostgREST round-trip and return them in order.

    Args:
        client: Supabase client.
        table_name: Table name.
        payloads: Row payloads (may be empty, which performs no request).

    Returns:
        Inserted rows in payload order.

    Raises:
        RepositoryError: If the insert returned a different number of rows.
    """
    if not payloads:
        return ()
    result = client.table(table_name).insert([payload_copy(payload) for payload in payloads])
    rows = result_rows(result.execute())
    if len(rows) != len(payloads):
        msg = f"insert into {table_name} returned {len(rows)} rows for {len(payloads)} payloads"
        raise RepositoryError(msg)
    return rows


def update_by_id(
    client: SupabaseClient,
    table_name: str,
    row_id: str,
    payload: JsonPayload,
) -> JsonObject:
    """Update one row by primary key.

    Args:
        client: Supabase client.
        table_name: Table name.
        row_id: Row identifier.
        payload: Update payload.

    Returns:
        Updated row.
    """
    result = client.table(table_name).update(payload_copy(payload)).eq("id", row_id).execute()
    return first_row(result, context=f"update {table_name}")


def find_one_by_columns(
    client: SupabaseClient,
    table_name: str,
    filters: JsonPayload,
) -> JsonObject | None:
    """Find one row by equality filters.

    Args:
        client: Supabase client.
        table_name: Table name.
        filters: Column filters.

    Returns:
        Matching row, if present.
    """
    query = client.table(table_name).select("*")
    for column, value in filters.items():
        query = query.eq(column, value)
    result = query.limit(1).execute()
    if not result.data:
        return None
    return dict(result.data[0])
