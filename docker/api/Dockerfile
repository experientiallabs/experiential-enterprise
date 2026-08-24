FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && python --version \
  && rm -rf /var/lib/apt/lists/*

# Install third-party dependencies first, keyed only on the lockfile and project
# metadata. Everything (including exp-gateway-native, which ships prebuilt
# manylinux abi3 wheels) resolves from PyPI, so no Rust or C toolchain is
# needed. This layer is reused across PRs whenever dependencies are unchanged,
# instead of being busted by every source edit. Project source is copied
# afterward.
COPY pyproject.toml uv.lock README.md LICENSE ./
RUN uv sync --frozen --no-install-project --no-dev

COPY explabs ./explabs
COPY docker ./docker

# Install the first-party project now that its source is present; the dependency
# layer above is reused, so this step only builds explabs-platform itself.
RUN uv sync --frozen --no-dev

FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && python --version \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app /app

ENTRYPOINT ["/app/docker/api/entrypoint.sh"]
