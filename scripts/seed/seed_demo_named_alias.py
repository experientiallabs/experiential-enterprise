# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Seed one demo named alias so the Aliases settings page is not empty.

Named aliases (identity tier P-E) are admin-defined model names an org repoints
over time. Unlike catalog aliases they are NOT built by the SQL seeds: a named
alias copies a target model's CURRENT catalog alias revision (its snapshot +
single-model pool), and those catalog aliases are synthesized by the runtime
catalog refresher at API/worker cold boot, not at ``supabase db push`` time.

So a demo alias has to be created AFTER the stack is up, over the same admin API
the dashboard uses. This is that post-boot step: it POSTs ``/api/aliases`` for
the operator org, pointing a friendly name (default ``coding``) at the first
target model that is actually routable in this deployment's catalog.

It is idempotent (skips when a named alias already exists) and credential-aware:
an environment with no routable model yet (a keyless local stack) has nothing to
point an alias at, so the step logs and skips cleanly instead of failing the
assembly, matching the platform's "gate demos on credential presence" rule.

Invoked from the demo / preview-assembly path once the stack is healthy::

    uv run python scripts/seed/seed_demo_named_alias.py

Configuration (all optional except the two the web app already requires):

    EXPLABS_BACKEND_URL             base API url (required)
    EXPLABS_API_KEY                 deployment bearer key (required)
    EXPLABS_DEMO_ALIAS_ORGS         'org_id:actor_id' pairs, comma-separated, to
                                    fill several orgs in one run (e.g. operator +
                                    demo); the demo org's ids live in the caller's
                                    config, not this helper. Overrides the two below.
    EXPLABS_DEMO_ALIAS_ORG_ID       single org to own the alias (default: operator org)
    EXPLABS_DEMO_ALIAS_ACTOR_ID     acting admin user (default: seeded admin)
    EXPLABS_DEMO_ALIAS_NAME         alias slug (default: coding)
    EXPLABS_DEMO_ALIAS_PREFERRED_MODELS  comma-ordered target preferences
"""

from __future__ import annotations

import os
import sys

import httpx

# The operator workspace the seeded platform admin owns (supabase/seed.sql). It
# is the org a fresh sign-in lands in, so its Aliases page is the one to fill.
_DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001"
# The seeded platform admin (supabase/seed.sql); a platform_admins row lets it
# pass the alias routes' org-admin gate (explabs/api/tenancy.py).
_DEFAULT_ACTOR_ID = "00000000-0000-0000-0000-000000000099"
_DEFAULT_ALIAS_NAME = "coding"
# Ordered target preferences, all pinned launch-catalog slugs
# (supabase/seed-gateway-catalog.sql). The first one that is routable in this
# deployment wins; a Qwen coding model leads, per the demo intent.
_DEFAULT_PREFERRED = ("qwen3.6-27b", "qwen3.5-9b", "deepseek-v4-pro", "gpt-5.5")

# The create route returns 409 for two very different reasons; the message is
# how they are told apart (explabs/api/routes/aliases.py).
_ALREADY_EXISTS = "already exists"
_NOT_ROUTABLE = "no routable deployment"


def candidate_targets(preferred: list[str], available: list[str]) -> list[str]:
    """Order the models to try, preferred-and-available first.

    A preferred slug that this deployment's catalog does not carry is dropped;
    every other available model is kept as a fallback so the alias still gets a
    real target when none of the preferences are present or routable.
    """
    available_set = set(available)
    ordered = [slug for slug in preferred if slug in available_set]
    ordered.extend(slug for slug in available if slug not in preferred)
    return ordered


class _AliasSeeder:
    """POSTs the demo alias over the admin API the dashboard itself uses."""

    def __init__(self, client: httpx.Client, org_id: str, actor_id: str) -> None:
        self._client = client
        self._org_id = org_id
        self._actor_id = actor_id

    def _headers(self) -> dict[str, str]:
        return {"X-Explabs-Actor-Id": self._actor_id}

    def existing_named_alias(self) -> str | None:
        """Return the name of an existing named alias, if the org has one."""
        response = self._client.get(
            "/api/aliases", params={"org_id": self._org_id}, headers=self._headers()
        )
        response.raise_for_status()
        aliases = response.json().get("aliases", [])
        return None if not aliases else str(aliases[0]["name"])

    def available_model_slugs(self) -> list[str]:
        """List the catalog model slugs an alias could point at."""
        response = self._client.get("/api/models", params={"limit": 1000}, headers=self._headers())
        response.raise_for_status()
        return [str(entry["model"]["slug"]) for entry in response.json().get("models", [])]

    def create(self, name: str, model: str) -> str:
        """Create the alias; return "created", "exists", or "not-routable"."""
        response = self._client.post(
            "/api/aliases",
            json={"org_id": self._org_id, "name": name, "model": model},
            headers=self._headers(),
        )
        if response.status_code < 400:
            return "created"
        message = ""
        try:
            message = str(response.json().get("error", ""))
        except ValueError:
            message = response.text
        if response.status_code == 409 and _ALREADY_EXISTS in message:
            return "exists"
        if response.status_code == 409 and _NOT_ROUTABLE in message:
            return "not-routable"
        response.raise_for_status()
        raise RuntimeError(f"unexpected alias create response {response.status_code}: {message}")


def _required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        print(f"seed_demo_named_alias: {name} is not set; skipping.", file=sys.stderr)
        raise SystemExit(0)
    return value


def parse_org_targets(raw: str) -> list[tuple[str, str]]:
    """Parse ``org_id:actor_id`` pairs, comma-separated, into targets.

    Lets one invocation fill several orgs' Aliases pages (e.g. the operator org
    the admin lands in AND the demo org the demo login lands in). The demo org's
    ids live in the caller's config, not in this platform helper's defaults.
    A malformed pair is a config error and fails loudly rather than seeding the
    wrong org.
    """
    targets: list[tuple[str, str]] = []
    for pair in raw.split(","):
        cleaned = pair.strip()
        if not cleaned:
            continue
        org_id, separator, actor_id = cleaned.partition(":")
        if not separator or not org_id.strip() or not actor_id.strip():
            msg = f"EXPLABS_DEMO_ALIAS_ORGS entry '{cleaned}' must be 'org_id:actor_id'"
            raise ValueError(msg)
        targets.append((org_id.strip(), actor_id.strip()))
    return targets


def _resolve_targets() -> list[tuple[str, str]]:
    """The (org_id, actor_id) pairs to seed, from config or the operator default."""
    orgs_env = os.environ.get("EXPLABS_DEMO_ALIAS_ORGS")
    if orgs_env:
        return parse_org_targets(orgs_env)
    org_id = os.environ.get("EXPLABS_DEMO_ALIAS_ORG_ID", _DEFAULT_ORG_ID)
    actor_id = os.environ.get("EXPLABS_DEMO_ALIAS_ACTOR_ID", _DEFAULT_ACTOR_ID)
    return [(org_id, actor_id)]


def _seed_org(seeder: _AliasSeeder, org_id: str, name: str, preferred: list[str]) -> None:
    """Ensure one org has the demo named alias; idempotent and best-effort."""
    tag = f"seed_demo_named_alias[{org_id}]"
    existing = seeder.existing_named_alias()
    if existing is not None:
        print(f"{tag}: already has named alias '{existing}'; nothing to do.")
        return

    candidates = candidate_targets(preferred, seeder.available_model_slugs())
    if not candidates:
        print(f"{tag}: no catalog models available yet; skipping (nothing routable to point at).")
        return

    for model in candidates:
        match seeder.create(name, model):
            case "created":
                print(f"{tag}: created alias '{name}' -> {model}.")
                return
            case "exists":
                print(f"{tag}: alias '{name}' already exists; nothing to do.")
                return
            case "not-routable":
                continue

    print(f"{tag}: no candidate model is routable yet (keyless stack); skipping.")


def main() -> None:
    """Seed the demo named alias for every configured org, idempotently."""
    base_url = _required_env("EXPLABS_BACKEND_URL")
    api_key = _required_env("EXPLABS_API_KEY")
    name = os.environ.get("EXPLABS_DEMO_ALIAS_NAME", _DEFAULT_ALIAS_NAME)
    preferred_env = os.environ.get("EXPLABS_DEMO_ALIAS_PREFERRED_MODELS")
    preferred = (
        [slug.strip() for slug in preferred_env.split(",") if slug.strip()]
        if preferred_env
        else list(_DEFAULT_PREFERRED)
    )
    targets = _resolve_targets()

    with httpx.Client(
        base_url=base_url.rstrip("/"),
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=30.0,
    ) as client:
        for org_id, actor_id in targets:
            _seed_org(_AliasSeeder(client, org_id, actor_id), org_id, name, preferred)


if __name__ == "__main__":
    main()
