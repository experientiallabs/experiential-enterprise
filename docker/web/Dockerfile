FROM node:22-bookworm-slim

ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
# Single-stage image: this covers both the `pnpm web:build` below and the
# runtime entrypoint, so Next.js phones home from neither.
ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile

COPY apps/web ./apps/web
COPY docker ./docker

RUN pnpm web:build

ENTRYPOINT ["/app/docker/web/entrypoint.sh"]

