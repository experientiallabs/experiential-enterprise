# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""WMO-free metadata for Platform-funded Project launch models.

This module is the authorization list for models Platform can fund from its
own environment credentials. Project setup uses the provider/model identity
and credential availability; catalog materialization additionally reads the
declared prices and capabilities for providers WMO cannot discover offline.
Credential values never leave the environment or enter these records.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

PlatformLaunchProviderName = Literal["openai", "anthropic", "gemini", "bedrock"]
PlatformLaunchModelKey = tuple[PlatformLaunchProviderName, str]

ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY"
OPENAI_API_KEY_ENV = "OPENAI_API_KEY"
GEMINI_API_KEY_ENV = "GEMINI_API_KEY"
# Bedrock has no API key: WMO's client reads the standard AWS credential
# chain, so Platform funding requires the ambient key pair (region may come
# from AWS_REGION or the boto chain).
AWS_ACCESS_KEY_ID_ENV = "AWS_ACCESS_KEY_ID"
AWS_SECRET_ACCESS_KEY_ENV = "AWS_SECRET_ACCESS_KEY"


@dataclass(frozen=True, slots=True)
class PlatformLaunchModelMetadata:
    """One environment-backed model Platform may fund for a Project launch."""

    provider: PlatformLaunchProviderName
    model: str
    display_name: str
    required_env: tuple[str, ...]
    usd_per_mtok_input: float
    usd_per_mtok_output: float
    usd_per_mtok_cached_input: float | None = None
    reasoning_levels: tuple[str, ...] = ()
    # Explicit capability declarations for providers WMO cannot discover
    # offline (Bedrock); native providers leave these None and rely on WMO's
    # maintained model table.
    context_window_tokens: int | None = None
    maximum_output_tokens: int | None = None

    @property
    def key(self) -> PlatformLaunchModelKey:
        """Return the stable provider/model selection key."""
        return self.provider, self.model

    def is_available(self, env: Mapping[str, str]) -> bool:
        """Return whether every credential variable required by this model is set.

        Args:
            env: Environment mapping whose values remain process-local.

        Returns:
            ``True`` when every required variable has a non-empty value.
        """
        return all(env.get(name) for name in self.required_env)


PLATFORM_LAUNCH_MODEL_CATALOG: tuple[PlatformLaunchModelMetadata, ...] = (
    PlatformLaunchModelMetadata(
        provider="openai",
        model="gpt-5.6-terra",
        display_name="GPT-5.6 Terra",
        required_env=(OPENAI_API_KEY_ENV,),
        usd_per_mtok_input=1.00,
        usd_per_mtok_output=6.00,
        reasoning_levels=("low", "medium", "high"),
    ),
    PlatformLaunchModelMetadata(
        provider="openai",
        model="gpt-5.6-sol",
        display_name="GPT-5.6 Sol",
        required_env=(OPENAI_API_KEY_ENV,),
        usd_per_mtok_input=5.00,
        usd_per_mtok_output=30.00,
        reasoning_levels=("low", "medium", "high"),
    ),
    PlatformLaunchModelMetadata(
        provider="openai",
        model="gpt-5.6-luna",
        display_name="GPT-5.6 Luna",
        required_env=(OPENAI_API_KEY_ENV,),
        usd_per_mtok_input=0.10,
        usd_per_mtok_output=0.60,
        reasoning_levels=("low", "medium", "high"),
    ),
    PlatformLaunchModelMetadata(
        provider="anthropic",
        model="claude-fable-5",
        display_name="Claude Fable 5",
        required_env=(ANTHROPIC_API_KEY_ENV,),
        usd_per_mtok_input=10.00,
        usd_per_mtok_output=50.00,
        usd_per_mtok_cached_input=1.00,
        reasoning_levels=("low", "medium", "high", "max"),
    ),
    PlatformLaunchModelMetadata(
        provider="anthropic",
        model="claude-opus-5",
        display_name="Claude Opus 5",
        required_env=(ANTHROPIC_API_KEY_ENV,),
        usd_per_mtok_input=5.00,
        usd_per_mtok_output=25.00,
        usd_per_mtok_cached_input=0.50,
        reasoning_levels=("low", "medium", "high", "max"),
    ),
    PlatformLaunchModelMetadata(
        provider="anthropic",
        model="claude-sonnet-5",
        display_name="Claude Sonnet 5",
        required_env=(ANTHROPIC_API_KEY_ENV,),
        usd_per_mtok_input=3.00,
        usd_per_mtok_output=15.00,
        usd_per_mtok_cached_input=0.30,
        reasoning_levels=("low", "medium", "high", "max"),
    ),
    PlatformLaunchModelMetadata(
        provider="anthropic",
        model="claude-opus-4-8",
        display_name="Claude Opus 4.8",
        required_env=(ANTHROPIC_API_KEY_ENV,),
        usd_per_mtok_input=5.00,
        usd_per_mtok_output=25.00,
        usd_per_mtok_cached_input=0.50,
    ),
    PlatformLaunchModelMetadata(
        provider="anthropic",
        model="claude-sonnet-4-6",
        display_name="Claude Sonnet 4.6",
        required_env=(ANTHROPIC_API_KEY_ENV,),
        usd_per_mtok_input=3.00,
        usd_per_mtok_output=15.00,
        usd_per_mtok_cached_input=0.30,
    ),
    PlatformLaunchModelMetadata(
        provider="anthropic",
        model="claude-haiku-4-5",
        display_name="Claude Haiku 4.5",
        required_env=(ANTHROPIC_API_KEY_ENV,),
        usd_per_mtok_input=1.00,
        usd_per_mtok_output=5.00,
        usd_per_mtok_cached_input=0.10,
    ),
    PlatformLaunchModelMetadata(
        provider="gemini",
        model="gemini-2.5-pro",
        display_name="Gemini 2.5 Pro",
        required_env=(GEMINI_API_KEY_ENV,),
        usd_per_mtok_input=1.25,
        usd_per_mtok_output=10.00,
    ),
    PlatformLaunchModelMetadata(
        provider="gemini",
        model="gemini-2.5-flash",
        display_name="Gemini 2.5 Flash",
        required_env=(GEMINI_API_KEY_ENV,),
        usd_per_mtok_input=0.30,
        usd_per_mtok_output=2.50,
    ),
    PlatformLaunchModelMetadata(
        provider="bedrock",
        model="us.anthropic.claude-opus-4-5-v1:0",
        display_name="Claude Opus 4.5 (Bedrock)",
        required_env=(AWS_ACCESS_KEY_ID_ENV, AWS_SECRET_ACCESS_KEY_ENV),
        usd_per_mtok_input=5.00,
        usd_per_mtok_output=25.00,
        context_window_tokens=200_000,
        maximum_output_tokens=32_000,
    ),
    PlatformLaunchModelMetadata(
        provider="bedrock",
        model="us.anthropic.claude-haiku-4-5-v1:0",
        display_name="Claude Haiku 4.5 (Bedrock)",
        required_env=(AWS_ACCESS_KEY_ID_ENV, AWS_SECRET_ACCESS_KEY_ENV),
        usd_per_mtok_input=1.00,
        usd_per_mtok_output=5.00,
        context_window_tokens=200_000,
        maximum_output_tokens=32_000,
    ),
)


def available_platform_launch_models(
    env: Mapping[str, str] | None = None,
) -> tuple[PlatformLaunchModelMetadata, ...]:
    """Return launch models backed by configured Platform credentials.

    Args:
        env: Environment mapping, defaulting to ``os.environ``.

    Returns:
        Configured catalog entries in stable display order. No environment
        names or values are included in the returned public metadata.
    """
    resolved = env if env is not None else os.environ
    return tuple(entry for entry in PLATFORM_LAUNCH_MODEL_CATALOG if entry.is_available(resolved))


def available_platform_launch_model_keys(
    env: Mapping[str, str] | None = None,
) -> frozenset[PlatformLaunchModelKey]:
    """Return configured provider/model keys for setup authorization.

    Args:
        env: Environment mapping, defaulting to ``os.environ``.

    Returns:
        An immutable set containing no secret or environment-variable data.
    """
    return frozenset(entry.key for entry in available_platform_launch_models(env))
