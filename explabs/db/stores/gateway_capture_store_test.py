# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the captured-prompt dashboard read store."""

from __future__ import annotations

import pytest

from explabs.db.fake_supabase_test import FakeQuery, FakeSupabaseClient
from explabs.db.repositories import RepositoryError
from explabs.db.stores.gateway_capture_store import GatewayCaptureStore

_ORG_ID = "00000000-0000-0000-0000-00000000d001"
_OTHER_ORG_ID = "00000000-0000-0000-0000-00000000d002"


def _client() -> FakeSupabaseClient:
    client = FakeSupabaseClient()
    client.tables["organizations"] = [{"id": _ORG_ID, "capture_prompt_content": True}]
    client.tables["gateway_captured_prompts"] = [
        {
            "request_id": "request-1",
            "org_id": _ORG_ID,
            "prompt_sha256": "ab12" * 16,
            "messages": [
                {"role": "system", "content": "You are the store-test agent."},
                {"role": "user", "content": "hi"},
            ],
            "captured_at": "2026-08-22T10:00:00+00:00",
        }
    ]
    return client


def test_read_prompt_is_org_scoped() -> None:
    """The owner reads its captured prompt; another org reads None."""
    store = GatewayCaptureStore(_client())
    row = store.read_prompt(_ORG_ID, "request-1")
    assert row is not None
    assert row.messages[0]["content"] == "You are the store-test agent."
    assert store.read_prompt(_OTHER_ORG_ID, "request-1") is None
    assert store.read_prompt(_ORG_ID, "request-missing") is None


def test_group_snippets_label_prompt_groups() -> None:
    """Snippets come back per prompt group with the system-prompt text."""
    store = GatewayCaptureStore(_client())
    snippets = store.group_snippets(_ORG_ID)
    assert [snippet.prompt_sha256 for snippet in snippets] == ["ab12" * 16]
    assert snippets[0].snippet.startswith("You are the store-test agent.")
    assert store.group_snippets(_OTHER_ORG_ID) == ()


def test_mark_exported_reads_bare_string_array() -> None:
    """A set-returning text RPC returns claimed ids as a bare string array."""
    client = _client()

    claimed = GatewayCaptureStore(client).mark_exported(("request-1",))

    assert claimed == ("request-1",)
    assert client.tables["gateway_captured_prompts"][0]["exported_at"] is not None


def test_mark_exported_accepts_an_empty_rpc_result() -> None:
    """No claimable rows produce an empty tuple."""
    client = _client()

    assert GatewayCaptureStore(client).mark_exported(("request-missing",)) == ()


def test_mark_exported_rejects_a_bogus_rpc_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    """An unexpected claim payload fails loudly instead of dropping ids."""

    def bogus_rpc(self: FakeQuery) -> object:
        _ = self
        return {"request_id": "request-1"}

    monkeypatch.setattr(FakeQuery, "_rpc", bogus_rpc)

    with pytest.raises(RepositoryError, match="result_scalar_strings"):
        GatewayCaptureStore(_client()).mark_exported(("request-1",))
