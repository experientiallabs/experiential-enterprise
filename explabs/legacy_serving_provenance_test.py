# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Static guards for the Experiential import and process-role boundary."""

import ast
import importlib.util
import os
import subprocess
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
_APPROVED_EXPERIENTIAL_IMPORTS = {
    # explabs/gateway/* is the ONLY package allowed to
    # import Experiential: it composes Experiential's Rust gateway and Python
    # fallback over Platform Postgres for the gateway worker role, while API/control roles
    # stay Experiential-free (proven below). The catalog builder serializes
    # Experiential snapshot contracts; the storage adapters implement its
    # persistence Protocols
    # (GatewayControlStore, AttemptLedger) against Postgres.
    # The Anthropic Messages adapter decodes inbound /v1/messages bodies via
    # Experiential's chat decoder and dispatches through GatewayService.complete — a
    # pure protocol seam inside the worker role, never the api/control roles.
    "explabs/gateway/anthropic_messages.py": {
        "exp.common.core.artifacts",
        "exp.runtime.gateway.service",
        "exp.runtime.openai_protocol.requests",
    },
    "explabs/gateway/catalog.py": {
        "exp.common.core.artifacts",
        "exp.common.models",
        "exp.runtime.gateway.contracts",
        # PublishedAliasMetadata for the 0.5.x /v1/models listing delegation.
        "exp.runtime.gateway.discovery",
        "exp.runtime.gateway.execution",
        "exp.runtime.gateway.routing",
        "exp.runtime.models",
    },
    "explabs/gateway/control_store.py": {
        "exp.common.core.artifacts",
        "exp.runtime.gateway.contracts",
        "exp.runtime.gateway.interfaces",
        "exp.runtime.gateway.sqlite.store",
    },
    "explabs/gateway/ledger.py": {
        "exp.common.models.gateway_catalog",
        "exp.runtime.gateway.budgets",
        "exp.runtime.gateway.contracts",
        "exp.runtime.gateway.interfaces",
        "exp.runtime.gateway.ledger",
        "exp.runtime.gateway.sqlite.store",
        "exp.runtime.models.providers.async_transport",
    },
    # Content-free request lineage: digests over the canonical request at the
    # authorize seam (sha256_json + the GatewayRequest contract).
    "explabs/gateway/lineage.py": {
        "exp.common.core.artifacts",
        "exp.runtime.gateway.contracts",
    },
    # Opt-in prompt capture: serializes the canonical messages at the same
    # authorize seam (the GatewayRequest contract only).
    "explabs/gateway/capture.py": {
        "exp.runtime.gateway.contracts",
    },
    "explabs/gateway/protocol_state.py": {
        "exp.runtime.openai_protocol.errors",
        "exp.runtime.openai_protocol.state",
    },
    "explabs/gateway/worker.py": {
        "exp.common.models.gateway_catalog",
        "exp.runtime.gateway.budgets",
        "exp.runtime.gateway.contracts",
        "exp.runtime.gateway.execution",
        "exp.runtime.gateway.health",
        "exp.runtime.gateway.interfaces",
        "exp.runtime.gateway.ledger",
        "exp.runtime.gateway.native_bridge",
        "exp.runtime.gateway.native_server",
        "exp.runtime.gateway.routing",
        "exp.runtime.gateway.service",
        "exp.runtime.gateway.sqlite.store",
        "exp.runtime.openai_protocol.state",
    },
    "explabs/gateway/native_host.py": {
        # Contract and deployment types back the Postgres write-ledger adapter
        # that Experiential's native control plane drives (see 0.5.1's
        # NativeGatewayComponents.write_ledger seam).
        "exp.common.models.gateway_catalog",
        "exp.runtime.gateway.contracts",
        "exp.runtime.gateway.interfaces",
        "exp.runtime.gateway.native_bridge",
        "exp.runtime.models",
        "exp.runtime.openai_protocol.errors",
    },
}
_DELETED_MODULE_PREFIXES = (
    "explabs.api.routes.account",
    "explabs.api.routes.builds",
    "explabs.api.routes.catalog",
    "explabs.api.routes.endpoints",
    "explabs.api.routes.project_serving",
    "explabs.api.routes.registry",
    "explabs.api.routes.runs",
    "explabs.api.routes.telemetry",
    "explabs.api.routes.trace_ingests",
    "explabs.api.routes.traces",
    "explabs.api.routes.world_models",
    "explabs.api.schemas",
    "explabs.api.services.dispatch",
    "explabs.api.serving_v1",
    "explabs.cli",
    "explabs.engine",
    "explabs.integrations.wmo_serving",
    "explabs.integrations.wmo_serving_economics",
    "explabs.integrations.wmo_serving_fixture",
    "explabs.integrations.wmo_serving_fixture_build",
    "explabs.integrations.wmo_serving_fixture_store",
    "explabs.persistence.account_defaults",
    "explabs.persistence.catalog_examples",
    "explabs.persistence.seed_bundles",
    "explabs.persistence.seed_fixtures",
    "explabs.persistence.seed_runs",
    "explabs.persistence.storage_retry",
    "explabs.workers.build_runner",
    "explabs.workers.control",
    "explabs.workers.heartbeat",
    "explabs.workers.routing_optimize_runner",
    "explabs.workers.run_feed",
    "explabs.workers.stall_reaper",
)


def _production_python_files() -> tuple[Path, ...]:
    """Return every current non-test Python source below ``explabs``.

    Returns:
        Stable repository-relative production source paths.
    """
    return tuple(
        sorted(
            path.relative_to(_ROOT)
            for path in (_ROOT / "explabs").rglob("*.py")
            if not path.name.endswith("_test.py") and path.name != "conftest.py"
        )
    )


def _module_imports(relative_path: Path) -> tuple[set[str], set[str]]:
    """Collect imported module bases and possible imported submodules.

    Args:
        relative_path: Repository-relative Python source path.

    Returns:
        Imported module bases and base-plus-member candidates.
    """
    source_path = _ROOT / relative_path
    tree = ast.parse(source_path.read_text(encoding="utf-8"))
    module_parts = list(relative_path.with_suffix("").parts)
    if module_parts[-1] == "__init__":
        module_parts.pop()
    else:
        module_parts.pop()
    package = ".".join(module_parts)
    bases: set[str] = set()
    candidates: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported = {alias.name for alias in node.names}
            bases.update(imported)
            candidates.update(imported)
            continue
        if not isinstance(node, ast.ImportFrom):
            continue
        raw_module = node.module or ""
        if node.level:
            base = importlib.util.resolve_name(f"{'.' * node.level}{raw_module}", package)
        else:
            base = raw_module
        if base:
            bases.add(base)
            candidates.add(base)
            candidates.update(f"{base}.{alias.name}" for alias in node.names if alias.name != "*")
    return bases, candidates


def test_current_experiential_imports_match_the_exact_worker_and_serving_allowlist() -> None:
    """Production Experiential imports match the approved serving seams."""
    importers: dict[str, set[str]] = {}
    legacy_importers: dict[str, set[str]] = {}
    for relative_path in _production_python_files():
        bases, _ = _module_imports(relative_path)
        exp_modules = {module for module in bases if module == "exp" or module.startswith("exp.")}
        if exp_modules:
            importers[str(relative_path)] = exp_modules
        wmo_modules = {module for module in bases if module == "wmo" or module.startswith("wmo.")}
        if wmo_modules:
            legacy_importers[str(relative_path)] = wmo_modules

    assert importers == _APPROVED_EXPERIENTIAL_IMPORTS
    assert legacy_importers == {}


_ROLE_FLAGS = {
    "EXPLABS_GATEWAY_ONLY",
    "EXPLABS_CONTROL_ONLY",
    "EXPLABS_GATEWAY_WORKER_ONLY",
    "EXPLABS_PROJECT_SERVING_ONLY",
}


def test_no_api_process_role_imports_experiential() -> None:
    """Every API and control process role stays Experiential-free at runtime.

    The project-router serving lane is retired and Experiential's gateway runs
    only behind ``EXPLABS_GATEWAY_WORKER_ONLY`` (exercised separately below).
    ``EXPLABS_PROJECT_SERVING_ONLY`` is exercised too because stale deployment
    specs still set it until integration-P7 drops the pod; the flag must be
    inert rather than resurrect an in-process WMO route.
    """
    program = (
        "import sys; import explabs.api.app; "
        "assert not any(name == 'exp' or name.startswith('exp.') for name in sys.modules)"
    )
    exp_free_roles = sorted(_ROLE_FLAGS - {"EXPLABS_GATEWAY_WORKER_ONLY"})
    for role in (None, *exp_free_roles):
        environment = {key: value for key, value in os.environ.items() if key not in _ROLE_FLAGS}
        if role is not None:
            environment[role] = "1"
        result = subprocess.run(
            [sys.executable, "-c", program],
            cwd=_ROOT,
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0, (role, result.stderr)


def test_gateway_worker_role_mounts_experiential_without_touching_the_database() -> None:
    """The worker role is the ONE process shape that loads Experiential's gateway.

    This is the deliberate exemption to the Experiential-free rule above:
    booting with ``EXPLABS_GATEWAY_WORKER_ONLY=1`` must compose Experiential's
    data plane (proving
    the lazy import actually fires) while construction performs no network
    I/O — the database here is an unroutable placeholder, so any eager
    connection attempt would fail the import.
    """
    program = (
        "import sys; from explabs.api.app import app; "
        "assert any(name == 'exp' or name.startswith('exp.') for name in sys.modules); "
        "paths = {route.path for route in app.routes}; "
        "assert {'/health/live', '/health/ready', '/internal/drain'} <= paths, paths"
    )
    environment = {key: value for key, value in os.environ.items() if key not in _ROLE_FLAGS}
    environment["EXPLABS_GATEWAY_WORKER_ONLY"] = "1"
    environment["SUPABASE_DB_URL"] = "postgresql://gateway:placeholder@127.0.0.1:9/postgres"
    environment["EXPLABS_GATEWAY_WORKER_KEY"] = "provenance-test-drain-key"
    result = subprocess.run(
        [sys.executable, "-c", program],
        cwd=_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def test_current_production_imports_no_deleted_module() -> None:
    """No current production module may recover a deleted legacy code path."""
    forbidden: dict[str, set[str]] = {}
    for relative_path in _production_python_files():
        _, candidates = _module_imports(relative_path)
        matches = {
            module
            for module in candidates
            if any(
                module == prefix or module.startswith(f"{prefix}.")
                for prefix in _DELETED_MODULE_PREFIXES
            )
        }
        if matches:
            forbidden[str(relative_path)] = matches

    assert forbidden == {}
