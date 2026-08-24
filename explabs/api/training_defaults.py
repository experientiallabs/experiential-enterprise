# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""The platform default for automatic training spend.

One module so the create path (which enforces the cap) and the usage surface
(which shows and edits it) share a single number without importing each
other's route modules. The org override lives on ``organizations
.training_cap_usd``; null there means this default applies.
"""

# What a fresh creation's automatic router-training run may spend when the org
# has not set its own ceiling. The gate this binds is the sweep's PRE-SPEND
# PROJECTION, which is deliberately generous (it assumes every call is a full
# 4k-in/600-out turn, 12 steps per cell; measured runs land an order of
# magnitude under it). $100 covers the default suggested suite with reasoning
# arms and premium natives with room to spare (the product owner, 2026-07-31); a customer
# who connects a much larger pool still gets the loud narrow-the-pool refusal,
# and the org credit gate applies before anything is queued.
DEFAULT_CREATE_TRAINING_CAP_USD = 100.0

# The most any org may set as its automatic-training ceiling, matching the
# manual optimize route's own per-run bound: a typo in a settings field should
# cost an argument with the API, not a bill.
MAX_TRAINING_CAP_USD = 500.0
