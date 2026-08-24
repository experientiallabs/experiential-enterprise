# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""The orchestrator/worker secret boundary, enforced as a test.

Org secrets live in Supabase Vault behind security-definer RPCs granted to
service_role only; in Python, ``explabs/secrets.py`` is the single wrapper.
The API layer (the orchestrator) is the only place allowed to touch that
wrapper or to mint Supabase clients: worker runners and the engine receive an
injected client and job-scoped inputs, never ambient credential access
(the product owner, 2026-08-02). Today the workers run inline in the API process, so this
boundary cannot be enforced by the runtime; it is enforced here instead, so
the day a separate job service plugs into ``dispatch.py`` the worker tree is
already credential-clean and the new backend only has to honor the
dispatcher's contract.
"""

from __future__ import annotations

from pathlib import Path

_REPO_EXPLABS = Path(__file__).resolve().parent.parent

# Source references that would punch through the boundary. Plain-text scan on
# purpose: an import renamed to dodge a string match is reviewable, while an
# AST walk would miss the RPC names inside string literals.
_FORBIDDEN = (
    # The Vault wrapper and its RPCs: orchestrator-only.
    "explabs.secrets",
    "list_org_secrets",
    "upsert_org_secret",
    # Client minting: workers use the client the orchestrator injects, so a
    # future out-of-process backend cannot silently depend on pod-level
    # SUPABASE_* credentials being present.
    "get_supabase_client",
)

_BOUNDED_TREES = ("workers", "engine")


def _violations() -> list[str]:
    """Scan the bounded trees for forbidden credential references."""
    found: list[str] = []
    for tree in _BOUNDED_TREES:
        for path in sorted((_REPO_EXPLABS / tree).rglob("*.py")):
            if path.name.endswith("_test.py"):
                continue
            source = path.read_text(encoding="utf-8")
            found.extend(
                f"{path.relative_to(_REPO_EXPLABS.parent)}: {needle}"
                for needle in _FORBIDDEN
                if needle in source
            )
    return found


def test_workers_and_engine_never_touch_the_secret_seam() -> None:
    """No worker or engine module references Vault access or client minting."""
    assert _violations() == []


def test_the_scanner_itself_catches_a_violation() -> None:
    """Negative control: the needles match the code a violation would add.

    Guards the scanner, not the tree: if the wrapper's RPC names or the client
    factory are ever renamed, the needles silently stop matching anything and
    the boundary test above passes vacuously. This pins each needle to the
    real definition it polices.
    """
    secrets_source = (_REPO_EXPLABS / "secrets.py").read_text(encoding="utf-8")
    assert "list_org_secrets" in secrets_source
    assert "upsert_org_secret" in secrets_source
    client_source = (_REPO_EXPLABS / "db" / "client.py").read_text(encoding="utf-8")
    assert "def get_supabase_client" in client_source
