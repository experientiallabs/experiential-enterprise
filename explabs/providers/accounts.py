# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""The probe contract and the per-provider dispatch.

A probe answers one question — "does this credential work at its provider
right now?" — with a key-level :class:`ProbeResult`. Verdicts are verbose on
purpose: the raw provider status/code/message ride beside remediation text
informative enough that an agent can self-correct from the text alone.
"""

from __future__ import annotations

import httpx
from pydantic import BaseModel, ConfigDict

from explabs.db.repositories import JsonObject
from explabs.db.stores.provider_connection_store import (
    ConnectableProvider,
    ConnectionStatus,
    ProviderConnectionRecord,
)

# One bounded round-trip per check; a hung provider must not hang the PUT
# that saves the key.
PROBE_TIMEOUT_SECONDS = 10.0


class ProbeDetail(BaseModel):
    """Verbose capture of one probe verdict, stored as ``status_detail``."""

    model_config = ConfigDict(frozen=True)

    # The provider's raw evidence, kept verbatim so nothing is lost between
    # the wire and the settings row.
    provider_status: int | None = None
    provider_code: str | None = None
    provider_message: str | None = None
    # House style: what failed, the offending value, what to do.
    remediation: str
    # Extra non-secret payload a successful probe yields (OpenRouter's
    # limit/usage figures); the spend adapters read it.
    provider_payload: JsonObject | None = None


class ProbeResult(BaseModel):
    """A key-level verdict; never ``UNCHECKED`` (a probe always concludes)."""

    model_config = ConfigDict(frozen=True)

    status: ConnectionStatus
    detail: ProbeDetail


def probe_connection(  # noqa: PLR0911 - one verdict ladder; each branch is a distinct verdict
    record: ProviderConnectionRecord,
    credential: str,
    *,
    transport: httpx.BaseTransport | None = None,
) -> ProbeResult:
    """Run the stored connection's credential against its provider.

    Args:
        record: The connection row (provider + non-secret config).
        credential: The released Vault secret.
        transport: Optional httpx transport override for tests; the SDK-backed
            providers (bedrock, modal) expose their own seams instead.

    Returns:
        The provider's verdict on the key.
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

    match record.provider:
        case ConnectableProvider.OPENAI:
            return openai.probe(credential, transport=transport)
        case ConnectableProvider.ANTHROPIC:
            return anthropic.probe(credential, transport=transport)
        case ConnectableProvider.GEMINI:
            return gemini.probe(credential, transport=transport)
        case ConnectableProvider.AZURE_OPENAI:
            return azure_openai.probe(credential, record.azure_config(), transport=transport)
        case ConnectableProvider.OPENROUTER:
            return openrouter.probe(credential, transport=transport)
        case ConnectableProvider.BEDROCK:
            return bedrock.probe(credential, record.bedrock_config())
        case ConnectableProvider.FIREWORKS:
            return fireworks.probe(credential, transport=transport)
        case ConnectableProvider.MODAL:
            return modal.probe(credential)


def probe_client(transport: httpx.BaseTransport | None) -> httpx.Client:
    """A bounded HTTP client for one probe call."""
    return httpx.Client(timeout=PROBE_TIMEOUT_SECONDS, transport=transport)


def masked(credential: str) -> str:
    """The only spelling of a credential a verdict may carry."""
    return f"····{credential[-4:]}" if len(credential) >= 8 else "the pasted value"


def unreachable(provider_label: str, error: httpx.HTTPError) -> ProbeResult:
    """The provider could not be reached: our check failed, not their key."""
    return ProbeResult(
        status=ConnectionStatus.PROVIDER_ERROR,
        detail=ProbeDetail(
            provider_code=type(error).__name__,
            provider_message=str(error) or None,
            remediation=(
                f"{provider_label} could not be reached to verify the key "
                f"({type(error).__name__}). The key is saved but unverified; "
                "this was our check failing, not your key. Real traffic will "
                "verify it, or rotate the key to re-run the check."
            ),
        ),
    )


def server_error(provider_label: str, response: httpx.Response) -> ProbeResult:
    """The provider answered 5xx: their outage, not the key's fault."""
    return ProbeResult(
        status=ConnectionStatus.PROVIDER_ERROR,
        detail=ProbeDetail(
            provider_status=response.status_code,
            provider_message=response_message(response),
            remediation=(
                f"{provider_label} answered HTTP {response.status_code} while we "
                "verified the key — a provider-side error, not your key. The key "
                "is saved; real traffic will verify it, or rotate the key to "
                "re-run the check."
            ),
        ),
    )


def rate_limited(provider_label: str, response: httpx.Response) -> ProbeResult:
    """The provider throttled the account the key belongs to."""
    return ProbeResult(
        status=ConnectionStatus.RATE_LIMITED,
        detail=ProbeDetail(
            provider_status=response.status_code,
            provider_code=response_error_field(response, "code"),
            provider_message=response_message(response),
            remediation=(
                f"{provider_label} rate-limited this account while we verified "
                "the key. The key itself is accepted; wait for the limit to "
                "reset or raise the account's rate limits, then send traffic "
                "normally."
            ),
        ),
    )


def response_message(response: httpx.Response) -> str | None:
    """The human-readable message inside a provider error body, if any."""
    payload = response_json(response)
    if payload is None:
        text = response.text.strip()
        return text or None
    raw_error = payload.get("error")
    error = json_object(raw_error)
    if error is not None:
        message = error.get("message")
        if isinstance(message, str) and message:
            return message
    if isinstance(raw_error, str) and raw_error:
        return raw_error
    message = payload.get("message")
    if isinstance(message, str) and message:
        return message
    return None


def response_error_field(response: httpx.Response, field: str) -> str | None:
    """One string field off the provider's ``error`` object, if present."""
    payload = response_json(response)
    if payload is None:
        return None
    error = json_object(payload.get("error"))
    if error is None:
        return None
    value = error.get(field)
    return value if isinstance(value, str) and value else None


def response_json(response: httpx.Response) -> JsonObject | None:
    """The response body as a JSON object, or None for anything else."""
    try:
        payload = response.json()
    except ValueError:
        return None
    return json_object(payload)


def json_object(value: object) -> JsonObject | None:
    """An untyped JSON value as ``JsonObject``, or None for anything else."""
    if not isinstance(value, dict):
        return None
    return {str(key): item for key, item in value.items()}
