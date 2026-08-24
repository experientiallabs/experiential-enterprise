# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Guards on local-stack isolation that product tests cannot cover.

The local Supabase/Docker stacks live in shell scripts and a compose file, so
the only place their isolation properties can be asserted is here, against the
files themselves. Both guards pin fixes for cross-stack writes that bit real
sessions: a seed script that silently targeted the DEFAULT Supabase port even
when the caller's stack was re-ported, and a compose network whose fixed name
joined every default-configured stack onto one shared DNS namespace.
"""

from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def test_seed_script_never_defaults_to_the_shared_supabase_port() -> None:
    """The seed resolves its own stack or fails loudly; it never assumes 54332.

    A hardcoded default port made an isolated (re-ported) stack's seed land in
    whichever OTHER stack owned the default port — another session's database.
    """
    seed = (REPO_ROOT / "scripts" / "seed_supabase_local.sh").read_text()
    assert "54332" not in seed, "the seed script must not assume the default Supabase port"
    # The loud-failure branch must exist: no resolvable stack means exit, not
    # a silent default.
    assert "supabase status" in seed
    assert "exit 1" in seed
    # A caller's exported SUPABASE_DB_URL must survive the .env.local sourcing,
    # or a stale dotfile entry redirects the integration runner's seed to a
    # different database than the stack it just started.
    assert seed.index('caller_db_url="${SUPABASE_DB_URL:-}"') < seed.index("source "), (
        "the caller's SUPABASE_DB_URL must be captured before the env file is sourced"
    )


def test_integration_runner_exports_stack_coordinates_before_seeding() -> None:
    """The runner seeds only after exporting the started stack's own env.

    Seeding before the `supabase status -o env` export left SUPABASE_DB_URL
    unset during the seed, which (combined with any default) targets the wrong
    stack. Hardcoded port fallbacks are equally banned: a stack that cannot
    report its own coordinates is a failure to surface, not paper over.
    """
    runner = (REPO_ROOT / "scripts" / "run_supabase_integration_tests.sh").read_text()
    export_at = runner.index("supabase status -o env")
    seed_at = runner.index("seed_supabase_local.sh")
    assert export_at < seed_at, "stack env must be exported before the seed runs"
    for port in ("54331", "54332"):
        assert port not in runner, (
            "the runner must take coordinates from the stack it started, never hardcoded ports"
        )


def test_compose_network_is_derived_per_project_not_shared() -> None:
    """The docker stack's network name derives from the compose project.

    A fixed `name:` override joined every stack whose EXPLABS_STACK_PROJECT_NAME
    was unset onto one shared network, where containers from different sessions
    resolved each other's supabase-db by DNS.
    """
    compose = (REPO_ROOT / "docker" / "compose.yml").read_text()
    networks_block = compose.split("\nnetworks:", 1)[1]
    assert "name:" not in networks_block, (
        "the compose network must have no fixed name; compose derives <project>_explabs"
    )
    assert "explabs-local-network" not in compose
