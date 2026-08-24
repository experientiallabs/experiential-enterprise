# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the Experiential-free Platform launch-model availability seam."""

from __future__ import annotations

import subprocess
import sys

from explabs.platform_launch_models import (
    PLATFORM_LAUNCH_MODEL_CATALOG,
    available_platform_launch_model_keys,
    available_platform_launch_models,
)


def test_environment_availability_is_exact_and_secret_free() -> None:
    """Only configured provider rosters appear and returned metadata has no values."""
    secret = "must-never-appear"
    available = available_platform_launch_models({"OPENAI_API_KEY": secret})

    assert available
    assert {entry.provider for entry in available} == {"openai"}
    assert all(secret not in repr(entry) for entry in available)
    assert available_platform_launch_model_keys({"ANTHROPIC_API_KEY": secret}) == frozenset(
        entry.key for entry in PLATFORM_LAUNCH_MODEL_CATALOG if entry.provider == "anthropic"
    )


def test_launch_roster_is_bounded_unique_and_priced() -> None:
    """The Project launch catalog is an explicit secret-free authorization list."""
    keys = [entry.key for entry in PLATFORM_LAUNCH_MODEL_CATALOG]

    assert len(keys) == len(set(keys))
    assert {entry.provider for entry in PLATFORM_LAUNCH_MODEL_CATALOG} == {
        "openai",
        "anthropic",
        "gemini",
        "bedrock",
    }
    assert all(entry.model and entry.display_name for entry in PLATFORM_LAUNCH_MODEL_CATALOG)
    assert all(entry.usd_per_mtok_input > 0 for entry in PLATFORM_LAUNCH_MODEL_CATALOG)
    assert all(entry.usd_per_mtok_output > 0 for entry in PLATFORM_LAUNCH_MODEL_CATALOG)


def test_availability_module_imports_without_experiential() -> None:
    """The setup availability seam remains usable after the Experiential repin."""
    command = (
        "import sys; import explabs.platform_launch_models; "
        "assert not any(name == 'exp' or name.startswith('exp.') for name in sys.modules)"
    )
    subprocess.run(
        [sys.executable, "-c", command],
        check=True,
        capture_output=True,
        text=True,
    )
