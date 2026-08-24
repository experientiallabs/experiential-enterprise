# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Persistence for the shared world-model catalog.

A ``wm_catalog_entries`` row is one platform-global, importable world model:
an immutable snapshot of a ready model's serve/embed configuration, metrics,
and built bundle. The entry owns its bundle metadata inline (never an FK into
the tenant-scoped ``artifacts`` table, whose rows cascade away with their
org) and the bundle bytes live once at the entry's ``storage_path``
in the shared artifacts bucket. Retirement is a soft ``deprecated_at``
timestamp: deprecated entries disappear from listing and reject new imports
while rows that already imported them keep serving the pinned bundle.
"""

from __future__ import annotations

import re
from collections.abc import Sequence

from pydantic import BaseModel, ConfigDict

from explabs.db.ids import new_uuid
from explabs.db.repositories import (
    DeleteCapableQuery,
    JsonObject,
    JsonPayload,
    RepositoryError,
    SupabaseClient,
    first_row,
    insert_row,
    result_rows,
    update_by_id,
)
from explabs.db.stores.trace_store import DEFAULT_TRACE_ADAPTER
from explabs.db.stores.transitions import now_iso

# Entry names double as default world-model names on import, which double as
# on-disk directory names; keep them wmo-slug-safe like world_models.name.
_NAME_PATTERN = re.compile(r"[a-z0-9][a-z0-9\-_]*")


def is_valid_entry_name(name: str) -> bool:
    """Return whether a name satisfies the wmo slug rule for entries.

    Exposed so routes can reject a bad name before side effects (the publish
    flow copies bundle bytes into catalog storage before inserting the row);
    :meth:`CatalogEntryStore.create` stays the validating authority.
    """
    return _NAME_PATTERN.fullmatch(name) is not None


# Default cap on list queries, matching the platform's other stores.
DEFAULT_LIST_LIMIT = 100


class CatalogEntryRecord(BaseModel):
    """Typed snapshot of a ``wm_catalog_entries`` row."""

    model_config = ConfigDict(frozen=True)

    id: str
    name: str
    display_name: str | None
    description: str | None
    serve_provider: str
    serve_model: str
    embed_provider: str | None
    embed_dim: int | None
    trace_adapter: str
    config: dict[str, object]
    metrics: dict[str, object] | None
    trace_count: int | None
    step_count: int | None
    storage_bucket: str
    storage_path: str
    byte_size: int
    sha256: str
    import_count: int
    traces_filename: str | None
    traces_storage_path: str | None
    traces_byte_size: int | None
    traces_sha256: str | None
    source_world_model_id: str | None
    # Vendored eval-scenario set cloned onto imports (payload + honesty stats),
    # so imported/starter models carry scenarios without a mining run.
    scenario_set: dict[str, object] | None = None
    deprecated_at: str | None
    created_at: str

    @classmethod
    def from_row(cls, row: JsonObject) -> CatalogEntryRecord:
        """Parse a persisted row."""
        return cls.model_validate(dict(row))


class CatalogEntryStore:
    """Persist shared world-model catalog entries."""

    def __init__(self, client: SupabaseClient) -> None:
        """Initialize the store.

        Args:
            client: Supabase client.
        """
        self._client = client

    def create(
        self,
        *,
        name: str,
        serve_provider: str,
        serve_model: str,
        storage_path: str,
        byte_size: int,
        sha256: str,
        storage_bucket: str,
        display_name: str | None = None,
        description: str | None = None,
        embed_provider: str | None = None,
        embed_dim: int | None = None,
        trace_adapter: str = DEFAULT_TRACE_ADAPTER,
        config: JsonPayload | None = None,
        metrics: JsonPayload | None = None,
        trace_count: int | None = None,
        step_count: int | None = None,
        traces_filename: str | None = None,
        traces_storage_path: str | None = None,
        traces_byte_size: int | None = None,
        traces_sha256: str | None = None,
        source_world_model_id: str | None = None,
        scenario_set: JsonPayload | None = None,
        entry_id: str | None = None,
    ) -> CatalogEntryRecord:
        """Publish one immutable catalog entry.

        The caller uploads the bundle bytes to ``storage_path`` first; the row
        is the durable, integrity-bearing pointer the platform serves from.

        Args:
            name: wmo-slug-safe entry name, unique among live entries.
            serve_provider: Serving LLM provider the bundle was built on.
            serve_model: Serving LLM model name.
            storage_path: Canonical bundle object path within the bucket.
            byte_size: Bundle size in bytes.
            sha256: Content digest of the bundle bytes.
            storage_bucket: Storage bucket holding the bundle.
            display_name: Optional human-facing name.
            description: Optional human-facing description for the catalog.
            embed_provider: Optional embedding provider.
            embed_dim: Optional embedding dimension.
            trace_adapter: Trace ingestion adapter the source was built with.
            config: Extra build configuration snapshot.
            metrics: Build metrics snapshot.
            trace_count: Traces in the bundle's replay buffer, when known.
            step_count: Steps in the bundle's replay buffer, when known.
            traces_filename: Corpus filename, when the entry carries traces.
            traces_storage_path: Corpus object path (all-or-nothing with the
                other ``traces_*`` fields; the db CHECK enforces it).
            traces_byte_size: Corpus size in bytes.
            traces_sha256: Corpus content digest.
            source_world_model_id: Provenance link to the published model.
            scenario_set: Vendored eval-scenario set cloned onto imports
                (payload + honesty stats, ScenarioSetStore.create's inputs).
            entry_id: Pre-generated row identifier so callers can derive the
                canonical id-bearing storage path before the upload; defaults
                to a fresh uuid.

        Returns:
            Created record.

        Raises:
            ValueError: If the name is not wmo-slug-safe, ``byte_size`` is
                negative, or ``storage_path``/``sha256`` is empty.
        """
        if _NAME_PATTERN.fullmatch(name) is None:
            msg = f"catalog entry name must match [a-z0-9][a-z0-9-_]*: {name!r}"
            raise ValueError(msg)
        if byte_size < 0:
            msg = f"catalog entry byte_size must be >= 0, got {byte_size}"
            raise ValueError(msg)
        if not storage_path:
            msg = "catalog entry storage_path is required"
            raise ValueError(msg)
        if not sha256:
            msg = "catalog entry sha256 is required"
            raise ValueError(msg)
        row = insert_row(
            self._client,
            "wm_catalog_entries",
            {
                "id": entry_id if entry_id is not None else new_uuid(),
                "name": name,
                "display_name": display_name,
                "description": description,
                "serve_provider": serve_provider,
                "serve_model": serve_model,
                "embed_provider": embed_provider,
                "embed_dim": embed_dim,
                "trace_adapter": trace_adapter,
                "config": dict(config or {}),
                "metrics": dict(metrics) if metrics is not None else None,
                "trace_count": trace_count,
                "step_count": step_count,
                "traces_filename": traces_filename,
                "traces_storage_path": traces_storage_path,
                "traces_byte_size": traces_byte_size,
                "traces_sha256": traces_sha256,
                "storage_bucket": storage_bucket,
                "storage_path": storage_path,
                "byte_size": byte_size,
                "sha256": sha256,
                "import_count": 0,
                "source_world_model_id": source_world_model_id,
                "scenario_set": dict(scenario_set) if scenario_set is not None else None,
                "deprecated_at": None,
                "created_at": now_iso(),
            },
        )
        return CatalogEntryRecord.from_row(row)

    def get(self, entry_id: str) -> CatalogEntryRecord:
        """Fetch a catalog entry by identifier.

        Args:
            entry_id: Catalog entry identifier.

        Returns:
            Current record.

        Raises:
            RepositoryError: If the entry does not exist.
        """
        result = self._client.table("wm_catalog_entries").select("*").eq("id", entry_id).execute()
        return CatalogEntryRecord.from_row(first_row(result, context="fetch catalog entry"))

    def find_live_by_name(self, name: str) -> CatalogEntryRecord | None:
        """Return the live (non-deprecated) entry holding ``name``, if any.

        Args:
            name: Entry name.

        Returns:
            Live record, or ``None`` when the name is free.
        """
        result = (
            self._client.table("wm_catalog_entries")
            .select("*")
            .eq("name", name)
            .is_("deprecated_at", None)
            .execute()
        )
        rows = result_rows(result)
        if not rows:
            return None
        return CatalogEntryRecord.from_row(rows[0])

    def list_live(self, *, limit: int = DEFAULT_LIST_LIMIT) -> tuple[CatalogEntryRecord, ...]:
        """List live (non-deprecated) entries, most-imported first.

        Ordering happens in the database, before the limit, so a popular
        older entry can never be truncated away by a recency window.
        ``import_count`` is a cumulative download counter (re-imports and
        deletions both leave it monotone), not a distinct-org endorsement.

        Args:
            limit: Maximum number of rows returned.

        Returns:
            Live entries ordered by ``import_count`` then ``created_at``,
            both descending.
        """
        # Every column except the vendored scenario_set: the set is tens of
        # kilobytes per entry and no list consumer reads it (the view is an
        # explicit allowlist), so it stays out of the hot list payload. Built
        # from the record model so a new column cannot silently drop out.
        columns = ",".join(
            field for field in CatalogEntryRecord.model_fields if field != "scenario_set"
        )
        result = (
            self._client.table("wm_catalog_entries")
            .select(columns)
            .is_("deprecated_at", None)
            .order("import_count", desc=True)
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        return tuple(CatalogEntryRecord.from_row(row) for row in result_rows(result))

    def like(self, entry_id: str, user_id: str) -> None:
        """Record that a user likes an entry (idempotent).

        Args:
            entry_id: Catalog entry identifier.
            user_id: Acting user's auth identifier.
        """
        self._client.table("wm_catalog_entry_likes").upsert(
            {
                "entry_id": entry_id,
                "user_id": user_id,
                "created_at": now_iso(),
            },
            on_conflict="entry_id,user_id",
        ).execute()

    def unlike(self, entry_id: str, user_id: str) -> None:
        """Remove a user's like from an entry (idempotent).

        Args:
            entry_id: Catalog entry identifier.
            user_id: Acting user's auth identifier.

        Raises:
            RepositoryError: If the client cannot delete.
        """
        query = self._client.table("wm_catalog_entry_likes")
        if not isinstance(query, DeleteCapableQuery):
            msg = "Supabase query builder does not support delete"
            raise RepositoryError(msg)
        query.delete().eq("entry_id", entry_id).eq("user_id", user_id).execute()

    def like_counts(self, entry_ids: Sequence[str]) -> dict[str, int]:
        """Return the like tally for each of the given entries.

        Counting happens in the database (the ``catalog_like_counts``
        aggregate function): fetching raw like rows would silently
        undercount once a listing's likes exceed PostgREST's max-rows cap.

        Args:
            entry_ids: Entry identifiers to tally.

        Returns:
            Mapping of entry id to like count; entries with no likes map to 0.
        """
        counts = dict.fromkeys(entry_ids, 0)
        if not entry_ids:
            return counts
        result = self._client.rpc(
            "catalog_like_counts", {"in_entry_ids": list(entry_ids)}
        ).execute()
        for row in result_rows(result):
            like_count = row["like_count"]
            if not isinstance(like_count, int):
                msg = f"catalog_like_counts returned a non-integer count: {like_count!r}"
                raise RepositoryError(msg)
            counts[str(row["entry_id"])] = like_count
        return counts

    def liked_entry_ids(self, user_id: str, entry_ids: Sequence[str]) -> set[str]:
        """Return which of the given entries the user has liked.

        Args:
            user_id: Acting user's auth identifier.
            entry_ids: Entry identifiers to check.

        Returns:
            Subset of ``entry_ids`` the user likes.
        """
        if not entry_ids:
            return set()
        result = (
            self._client.table("wm_catalog_entry_likes")
            .select("entry_id")
            .eq("user_id", user_id)
            .in_("entry_id", list(entry_ids))
            .execute()
        )
        return {str(row["entry_id"]) for row in result_rows(result)}

    def rollback_import(self, world_model_id: str, entry_id: str) -> None:
        """Atomically undo a counted import whose follow-up writes failed.

        One SQL transaction (the ``rollback_catalog_import`` function)
        removes the imported row and its cloned trace uploads and gives the
        fence trigger's metered download back — all-or-nothing, so a partial
        compensation can never leak the counter or strand rows.

        Args:
            world_model_id: The half-imported world model to remove.
            entry_id: Catalog entry whose download is returned.
        """
        self._client.rpc(
            "rollback_catalog_import",
            {"in_world_model_id": world_model_id, "in_entry_id": entry_id},
        ).execute()

    def backfill_scenario_set(self, entry_id: str, scenario_set: JsonPayload) -> CatalogEntryRecord:
        """Attach a vendored eval-scenario set to an entry that has none.

        Entries are content-versioned on the bundle digest, so a deployment
        upgraded after the scenario-vendoring change holds its existing rows
        forever; this fills the new column on those rows. Fill-if-null only:
        a non-null set (a later vendor generation, or operator curation) is
        never overwritten - replacing one rides a bundle version bump.

        Args:
            entry_id: Catalog entry identifier.
            scenario_set: Vendored set (ScenarioSetStore.create's inputs).

        Returns:
            The entry's current record after the call (backfilled or already
            set - the fill-if-null filter lives in the UPDATE itself, so a
            concurrent curation between read and write cannot be overwritten).

        Raises:
            RepositoryError: If the entry does not exist.
        """
        self._client.table("wm_catalog_entries").update({"scenario_set": dict(scenario_set)}).eq(
            "id", entry_id
        ).is_("scenario_set", None).execute()
        return self.get(entry_id)

    def heal_display_copy(
        self,
        entry_id: str,
        *,
        display_name: str | None,
        description: str | None,
        name: str | None = None,
    ) -> CatalogEntryRecord:
        """Converge an entry's copy (and, on a rename, its name) to the vendored example.

        Entries are content-versioned on the bundle digest, so a copy-only
        rename in the vendored examples (e.g. "Terminal Tasks" becoming
        "Terminal-Bench 2.0") never produces a new version; deployments would
        show the old name forever. The same holds for the entry NAME itself
        when an example is renamed (benchmark names giving way to capability
        names): the id stays keyed to the former name, and this heal moves the
        row. The provisioner calls this only for entries it OWNS (the seed
        identity check), so operator-published entries are never rewritten.

        Args:
            entry_id: Catalog entry identifier.
            display_name: Vendored human-facing name.
            description: Vendored card copy.
            name: Vendored entry name, when the example was renamed.

        Returns:
            Updated record.

        Raises:
            RepositoryError: If the entry does not exist.
        """
        patch: JsonObject = {"display_name": display_name, "description": description}
        if name is not None:
            patch["name"] = name
        row = update_by_id(
            self._client,
            "wm_catalog_entries",
            entry_id,
            patch,
        )
        return CatalogEntryRecord.from_row(row)

    def deprecate(self, entry_id: str) -> CatalogEntryRecord:
        """Soft-retire an entry: hide it from listing and block new imports.

        Existing imports keep serving the pinned bundle; deprecation is
        idempotent (an already-deprecated entry keeps its original timestamp).

        Args:
            entry_id: Catalog entry identifier.

        Returns:
            Updated record.

        Raises:
            RepositoryError: If the entry does not exist.
        """
        current = self.get(entry_id)
        if current.deprecated_at is not None:
            return current
        row = update_by_id(
            self._client,
            "wm_catalog_entries",
            entry_id,
            {"deprecated_at": now_iso()},
        )
        return CatalogEntryRecord.from_row(row)
