# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the demo named-alias seeding helper.

The helper's whole job is to make one idempotent, credential-aware admin call,
so the logic worth pinning is target ordering and how it reads the create
route's two distinct 409s (name taken vs. no routable deployment).
"""

from __future__ import annotations

import httpx
import pytest

from scripts.seed.seed_demo_named_alias import (
    _AliasSeeder,
    candidate_targets,
    parse_org_targets,
)


def test_candidate_targets_puts_available_preferences_first() -> None:
    """Preferred-and-available lead; the rest of the catalog follows as fallback."""
    ordered = candidate_targets(
        preferred=["qwen3.6-27b", "absent-model", "gpt-5.5"],
        available=["gpt-5.5", "deepseek-v4-pro", "qwen3.6-27b"],
    )
    # 'absent-model' is dropped (not in the catalog); deepseek follows as fallback.
    assert ordered == ["qwen3.6-27b", "gpt-5.5", "deepseek-v4-pro"]


def test_candidate_targets_empty_when_no_models_available() -> None:
    """A keyless stack with no catalog models yields no candidates to try."""
    assert candidate_targets(preferred=["qwen3.6-27b"], available=[]) == []


def test_parse_org_targets_reads_pairs_and_ignores_blanks() -> None:
    """One invocation can fill several orgs (operator + demo)."""
    parsed = parse_org_targets("org-1:user-1, org-2:user-2 ,")
    assert parsed == [("org-1", "user-1"), ("org-2", "user-2")]


@pytest.mark.parametrize("bad", ["org-only", "org:", ":actor", "org:actor:extra-ok"])
def test_parse_org_targets_rejects_malformed_pairs(bad: str) -> None:
    """A malformed target is a config error, not a silently skipped org."""
    # 'org:actor:extra-ok' is accepted (partition keeps 'actor:extra-ok' as the
    # actor), so only the truly shapeless entries raise.
    if bad == "org:actor:extra-ok":
        assert parse_org_targets(bad) == [("org", "actor:extra-ok")]
        return
    with pytest.raises(ValueError, match="org_id:actor_id"):
        parse_org_targets(bad)


def _seeder(handler: httpx.MockTransport) -> _AliasSeeder:
    client = httpx.Client(base_url="http://api.test", transport=handler)
    return _AliasSeeder(client, org_id="org-1", actor_id="user-1")


def test_create_reports_created_on_success() -> None:
    """A 2xx from the create route is a real new alias."""
    seeder = _seeder(
        httpx.MockTransport(lambda _request: httpx.Response(200, json={"name": "coding"}))
    )
    assert seeder.create("coding", "qwen3.6-27b") == "created"


def test_create_reads_name_taken_409_as_exists() -> None:
    """A 409 whose message is the name collision is idempotent success, not failure."""
    seeder = _seeder(
        httpx.MockTransport(
            lambda _request: httpx.Response(
                409, json={"error": "create conflicts with an existing alias: already exists"}
            )
        )
    )
    assert seeder.create("coding", "qwen3.6-27b") == "exists"


def test_create_reads_not_routable_409_as_skippable() -> None:
    """A 409 for an unroutable model tells the caller to try the next candidate."""
    seeder = _seeder(
        httpx.MockTransport(
            lambda _request: httpx.Response(
                409,
                json={"error": "model 'x' has no routable deployment in the gateway catalog yet"},
            )
        )
    )
    assert seeder.create("coding", "x") == "not-routable"


def test_existing_named_alias_returns_first_name() -> None:
    """Idempotency guard: an org that already has a named alias short-circuits."""
    seeder = _seeder(
        httpx.MockTransport(
            lambda _request: httpx.Response(200, json={"aliases": [{"name": "coding"}]})
        )
    )
    assert seeder.existing_named_alias() == "coding"


def test_existing_named_alias_none_when_empty() -> None:
    """No named aliases yet means the seeder should proceed to create one."""
    seeder = _seeder(
        httpx.MockTransport(lambda _request: httpx.Response(200, json={"aliases": []}))
    )
    assert seeder.existing_named_alias() is None
