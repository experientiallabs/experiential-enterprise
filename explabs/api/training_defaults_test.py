# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""The training-cap constants' invariants."""

from explabs.api.training_defaults import DEFAULT_CREATE_TRAINING_CAP_USD, MAX_TRAINING_CAP_USD


def test_the_default_fits_under_the_settable_ceiling() -> None:
    """An org resetting to default must never land above what it could set."""
    assert 0 < DEFAULT_CREATE_TRAINING_CAP_USD <= MAX_TRAINING_CAP_USD
