# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""The dispatch covers every connectable provider; helpers stay honest."""

from __future__ import annotations

import httpx
import pytest

from explabs.db.stores.provider_connection_store import (
    ConnectableProvider,
    ConnectionStatus,
    ProviderConnectionRecord,
)
from explabs.providers.accounts import masked, probe_connection, response_message

_CONFIGS: dict[ConnectableProvider, dict[str, object]] = {
    ConnectableProvider.AZURE_OPENAI: {
        "endpoint": "https://my-resource.openai.azure.com",
        "deployments": {"gpt-5.5": "my-gpt-55"},
    },
    ConnectableProvider.BEDROCK: {"region": "us-east-1", "access_key_id": "AKIAEXAMPLEEXAMPLE"},
    ConnectableProvider.FIREWORKS: {"account_id": "my-account"},
}


def _record(provider: ConnectableProvider) -> ProviderConnectionRecord:
    return ProviderConnectionRecord(
        id="conn-1",
        org_id="org-1",
        provider=provider,
        config=_CONFIGS.get(provider, {}),
    )


@pytest.mark.parametrize("provider", list(ConnectableProvider))
def test_every_provider_dispatches_to_its_probe(
    provider: ConnectableProvider, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The match is exhaustive: a new enum member without a probe cannot ship.

    Each provider module's probe is stubbed at its own seam, so this test
    proves the dispatch wiring, not the provider logic (their own suites do).
    """
    from explabs.providers import (
        anthropic,
        azure_openai,
        bedrock,
        fireworks,
        gemini,
        modal,
        openai,
        openrouter,
    )

    module = {
        ConnectableProvider.OPENAI: openai,
        ConnectableProvider.ANTHROPIC: anthropic,
        ConnectableProvider.GEMINI: gemini,
        ConnectableProvider.AZURE_OPENAI: azure_openai,
        ConnectableProvider.OPENROUTER: openrouter,
        ConnectableProvider.BEDROCK: bedrock,
        ConnectableProvider.FIREWORKS: fireworks,
        ConnectableProvider.MODAL: modal,
    }[provider]
    calls: list[str] = []

    def stub(*args: object, **kwargs: object) -> object:
        calls.append(provider.value)
        from explabs.providers.accounts import ProbeDetail, ProbeResult

        return ProbeResult(status=ConnectionStatus.VALID, detail=ProbeDetail(remediation="stubbed"))

    monkeypatch.setattr(module, "probe", stub)
    result = probe_connection(_record(provider), "credential-value-1234")
    assert calls == [provider.value]
    assert result.status is ConnectionStatus.VALID


def test_masked_never_echoes_short_or_full_credentials() -> None:
    """Verdict text may carry the last four characters at most."""
    assert masked("sk-live-key-abcd") == "····abcd"
    assert masked("tiny") == "the pasted value"


def test_response_message_reads_the_common_error_shapes() -> None:
    """OpenAI-style nested, flat string, and non-JSON bodies all resolve."""
    nested = httpx.Response(400, json={"error": {"message": "nested message"}})
    assert response_message(nested) == "nested message"
    flat = httpx.Response(400, json={"error": "flat message"})
    assert response_message(flat) == "flat message"
    top = httpx.Response(400, json={"message": "top-level message"})
    assert response_message(top) == "top-level message"
    text = httpx.Response(502, text="Bad Gateway")
    assert response_message(text) == "Bad Gateway"
    empty = httpx.Response(500)
    assert response_message(empty) is None
