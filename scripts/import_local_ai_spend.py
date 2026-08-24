# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Attribute your existing AI spend from LOCAL Codex + Claude Code logs.

This is the reference implementation of the onboarding "bootstrap your
dashboard with your real historical AI spend" step. It parses the session logs
that Codex and Claude Code already keep on your own machine — through the
shared typed parsers in ``explabs.agent_sessions.records``, the same ones the
``explabs-agent-sessions`` local report uses — extracts PER-TURN USAGE
METADATA ONLY, and POSTs the aggregated batch to
``/api/gateway/usage/import`` so a fresh dashboard opens with your real
history instead of empty.

PRIVACY: this reads token/usage metadata only. It never reads, prints, stores,
or transmits any prompt, response, tool argument, file content, or other
message text. It deliberately ignores ``~/.codex/history.jsonl`` (which holds
prompt text). Only model ids, token counts, and timestamps leave the machine.

The source field mappings and token normalization (fresh vs cached input,
reasoning subset) are documented once, on ``explabs.agent_sessions.records``.

Usage:
    uv run python scripts/import_local_ai_spend.py \
        --base-url https://api.your-deployment.example.com \
        --api-key "$EXPLABS_ORG_KEY"

    # Inspect what would be sent without uploading:
    uv run python scripts/import_local_ai_spend.py --dry-run
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from collections.abc import Iterator
from pathlib import Path
from urllib import error, request

from explabs.agent_sessions.records import TurnUsage, collect_turns

# One POST carries at most this many records; larger histories split across
# batches (each batch keeps its own idempotency key).
_BATCH_SIZE = 2_000
_REQUEST_TIMEOUT_SECONDS = 60


def _payload(record: TurnUsage) -> dict[str, object]:
    """Render one turn as the import endpoint's JSON record shape."""
    return {
        "model": record.model,
        "input_tokens": record.input_tokens,
        "output_tokens": record.output_tokens,
        "cached_tokens": record.cached_tokens,
        "reasoning_tokens": record.reasoning_tokens,
        "timestamp": record.timestamp,
        "source": record.source.value,
        "event_id": record.event_id,
    }


def _int(value: object) -> int:
    """Coerce a JSON number to a non-negative int; anything else is zero."""
    if isinstance(value, bool):
        return 0
    if isinstance(value, int | float):
        return max(int(value), 0)
    return 0


def _post_batch(
    base_url: str, api_key: str, batch_id: str, records: list[TurnUsage]
) -> dict[str, object]:
    """POST one batch to the import endpoint and return its JSON response."""
    if not base_url.startswith(("http://", "https://")):
        msg = f"base-url must be an http(s) URL, got: {base_url}"
        raise ValueError(msg)
    body = json.dumps(
        {"batch_id": batch_id, "records": [_payload(record) for record in records]}
    ).encode("utf-8")
    # The URL scheme is validated above; only http(s) reaches urlopen.
    req = request.Request(  # noqa: S310
        f"{base_url.rstrip('/')}/api/gateway/usage/import",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    with request.urlopen(req, timeout=_REQUEST_TIMEOUT_SECONDS) as response:  # noqa: S310
        parsed = json.loads(response.read().decode("utf-8"))
    return parsed if isinstance(parsed, dict) else {}


def _summary(records: list[TurnUsage]) -> str:
    """Build a metadata-only summary of what will be imported."""
    by_source: dict[str, int] = {}
    by_model: dict[str, int] = {}
    for record in records:
        by_source[record.source.value] = by_source.get(record.source.value, 0) + 1
        by_model[record.model] = by_model.get(record.model, 0) + 1
    lines = [f"{len(records)} usage records (metadata only)"]
    for source, count in sorted(by_source.items()):
        lines.append(f"  source {source}: {count} turns")
    top = sorted(by_model.items(), key=lambda item: item[1], reverse=True)[:10]
    for model, count in top:
        lines.append(f"  model {model}: {count} turns")
    return "\n".join(lines)


def _batches(records: list[TurnUsage]) -> Iterator[tuple[str, list[TurnUsage]]]:
    """Split records into stable-id batches of at most ``_BATCH_SIZE``."""
    for index in range(0, len(records), _BATCH_SIZE):
        chunk = records[index : index + _BATCH_SIZE]
        batch_id = f"local-import-{uuid.uuid4().hex[:12]}-{index // _BATCH_SIZE}"
        yield batch_id, chunk


def main(argv: list[str] | None = None) -> int:
    """Parse local logs and import their usage metadata."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=os.environ.get("EXPLABS_BASE_URL", ""))
    parser.add_argument("--api-key", default=os.environ.get("EXPLABS_ORG_KEY", ""))
    parser.add_argument("--claude-dir", default=str(Path.home() / ".claude" / "projects"))
    parser.add_argument("--codex-dir", default=str(Path.home() / ".codex" / "sessions"))
    parser.add_argument(
        "--dry-run", action="store_true", help="Parse and summarize; do not upload."
    )
    args = parser.parse_args(argv)

    records = collect_turns(Path(args.claude_dir), Path(args.codex_dir))
    print(_summary(records))
    if not records:
        print("No local usage found; nothing to import.")
        return 0
    if args.dry_run:
        print("\nDry run: sample record (metadata only):")
        print(json.dumps(_payload(records[0]), indent=2))
        return 0
    if not args.base_url or not args.api_key:
        print("\nProvide --base-url and --api-key (or EXPLABS_BASE_URL / EXPLABS_ORG_KEY).")
        return 2

    imported = 0
    duplicates = 0
    for batch_id, chunk in _batches(records):
        try:
            result = _post_batch(args.base_url, args.api_key, batch_id, chunk)
        except error.HTTPError as http_error:
            print(f"Import failed ({http_error.code}): {http_error.read().decode('utf-8')}")
            return 1
        except error.URLError as url_error:
            print(f"Import failed: {url_error.reason}")
            return 1
        imported += _int(result.get("imported"))
        duplicates += _int(result.get("duplicates"))
    print(f"\nImported {imported} new records ({duplicates} already present).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
