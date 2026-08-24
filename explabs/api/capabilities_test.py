# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Unit tests for the enterprise capability registry's default-off posture."""

from __future__ import annotations

import pytest

from explabs.api.capabilities import (
    EnterpriseCapability,
    org_capabilities,
    require_capability,
)
from explabs.api.routes import ApiError
from explabs.db.fake_supabase_test import FakeSupabaseClient


def _client(entitlements: list[dict[str, object]] | None = None) -> FakeSupabaseClient:
    """A fake client, optionally seeded with org_entitlements rows."""
    client = FakeSupabaseClient()
    client.tables["org_entitlements"] = list(entitlements or [])
    return client


_ALL_KEYS = {"audit_log", "sso", "scim", "teams", "data_controls"}


def test_capability_keys_are_pinned() -> None:
    """The five keys are a cross-team contract; renaming one breaks siblings."""
    assert {capability.value for capability in EnterpriseCapability} == _ALL_KEYS


def test_everything_unlicensed_without_the_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """An unset env var means OFF by default: every capability unlicensed."""
    monkeypatch.delenv("EXPLABS_EE_CAPABILITIES", raising=False)
    assert org_capabilities(_client(), "org-1") == dict.fromkeys(_ALL_KEYS, "unlicensed")


def test_empty_env_is_also_fully_unlicensed(monkeypatch: pytest.MonkeyPatch) -> None:
    """An empty value must not license anything (no empty-key artifacts)."""
    monkeypatch.setenv("EXPLABS_EE_CAPABILITIES", "")
    assert set(org_capabilities(_client(), "org-1").values()) == {"unlicensed"}


def test_listed_keys_become_available(monkeypatch: pytest.MonkeyPatch) -> None:
    """Comma-separated keys license exactly themselves; whitespace tolerated."""
    monkeypatch.setenv("EXPLABS_EE_CAPABILITIES", " audit_log , sso ")
    capabilities = org_capabilities(_client(), "org-1")
    assert capabilities["audit_log"] == "available"
    assert capabilities["sso"] == "available"
    assert capabilities["scim"] == "unlicensed"
    assert capabilities["teams"] == "unlicensed"


def test_unknown_env_keys_are_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    """A stray key never widens the registry beyond the pinned enum."""
    monkeypatch.setenv("EXPLABS_EE_CAPABILITIES", "audit_log,made_up")
    capabilities = org_capabilities(_client(), "org-1")
    assert set(capabilities) == _ALL_KEYS
    assert capabilities["audit_log"] == "available"


def test_require_capability_passes_when_licensed(monkeypatch: pytest.MonkeyPatch) -> None:
    """A licensed capability gate is a no-op."""
    monkeypatch.setenv("EXPLABS_EE_CAPABILITIES", "scim")
    require_capability(_client(), "org-1", EnterpriseCapability.SCIM)


def test_require_capability_raises_absent_not_forbidden(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Unlicensed means 404, never 403: the surface must not be enumerable."""
    monkeypatch.delenv("EXPLABS_EE_CAPABILITIES", raising=False)
    with pytest.raises(ApiError) as excinfo:
        require_capability(_client(), "org-1", EnterpriseCapability.AUDIT_LOG)
    assert excinfo.value.status_code == 404
    assert str(excinfo.value) == "Not found"


def test_org_entitlement_row_licenses_one_org(monkeypatch: pytest.MonkeyPatch) -> None:
    """The hosted tier: a grant row licenses exactly the granted org."""
    monkeypatch.delenv("EXPLABS_EE_CAPABILITIES", raising=False)
    client = _client([{"org_id": "org-1", "capability": "teams", "expires_at": None}])
    assert org_capabilities(client, "org-1")["teams"] == "available"
    assert org_capabilities(client, "org-1")["sso"] == "unlicensed"
    assert org_capabilities(client, "org-2")["teams"] == "unlicensed"


def test_expired_entitlement_is_inert(monkeypatch: pytest.MonkeyPatch) -> None:
    """A time-bound pilot ends by itself: an expired row grants nothing."""
    monkeypatch.delenv("EXPLABS_EE_CAPABILITIES", raising=False)
    client = _client(
        [{"org_id": "org-1", "capability": "sso", "expires_at": "2026-01-01T00:00:00+00:00"}]
    )
    assert org_capabilities(client, "org-1")["sso"] == "unlicensed"


def test_instance_license_and_org_grants_union(monkeypatch: pytest.MonkeyPatch) -> None:
    """Self-host env licenses instance-wide; org rows add on top."""
    monkeypatch.setenv("EXPLABS_EE_CAPABILITIES", "audit_log")
    client = _client([{"org_id": "org-1", "capability": "scim", "expires_at": None}])
    capabilities = org_capabilities(client, "org-1")
    assert capabilities["audit_log"] == "available"
    assert capabilities["scim"] == "available"
    assert org_capabilities(client, "org-2")["scim"] == "unlicensed"
