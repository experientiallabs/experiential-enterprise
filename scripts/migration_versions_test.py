# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Repository contracts for Supabase migration filenames."""

from collections import Counter
from pathlib import Path


def test_supabase_migration_versions_are_unique() -> None:
    """A branch rebase must not create duplicate migration primary keys."""
    migrations = Path(__file__).resolve().parents[1] / "supabase" / "migrations"
    versions = [path.name.partition("_")[0] for path in migrations.glob("*.sql")]
    duplicates = sorted(version for version, count in Counter(versions).items() if count > 1)

    assert duplicates == [], f"duplicate Supabase migration versions: {', '.join(duplicates)}"
