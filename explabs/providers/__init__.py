# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Provider account adapters: hookup verification probes for BYOK credentials.

One module per connectable provider, each exposing ``probe(...)`` — a cheap,
live call against the provider's own API that classifies the credential into
the canonical connection status and captures the provider's raw error beside
our remediation text. ``accounts.probe_connection`` dispatches a stored
connection to its provider's probe.

These adapters live platform-side (not in WMO) on purpose: Bedrock needs
boto3, Modal needs the Modal SDK, and the secrets live in the platform Vault.
"""
