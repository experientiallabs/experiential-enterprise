# Migration + schema-gate + jwt-mint image for the Helm chart.
#
# One image drives four chart roles, all non-interactive (each caller supplies
# its own command): the migrate Job, the universal schema-gate initContainer on
# every app pod, the trial jwt-mint hook, and the trial auth-seed hook.
#
# Base carries psql. On top we add:
#   - the Supabase CLI  -> enterprise `supabase db push` (hosted-parity ledger)
#   - openssl           -> trial jwt-mint (HS256 signing; Helm has no HMAC)
#   - kubectl           -> trial jwt-mint writes the minted JWT Secret
#   - wget              -> auth-seed waits on the GoTrue /health endpoint
# and the repo's migration SQL, seeds, config.toml, and the shell scripts the
# chart Jobs invoke. Migration SQL (219 files) is baked in because it exceeds
# the ConfigMap size limit.
#
# Build context = repo root. Pinned to mirror docker/compose.yml's Postgres.
FROM supabase/postgres:15.8.1.060

# BuildKit provides TARGETARCH; default keeps a plain `docker build` working.
ARG TARGETARCH=amd64
ARG SUPABASE_CLI_VERSION=2.115.0
ARG KUBECTL_VERSION=v1.29.10

USER root
WORKDIR /app

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends bash ca-certificates curl wget openssl tar; \
    rm -rf /var/lib/apt/lists/*

# kubectl — used only by the trial jwt-mint hook to write the JWT Secret.
RUN set -eux; \
    curl -fsSLo /usr/local/bin/kubectl \
      "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl"; \
    chmod +x /usr/local/bin/kubectl; \
    kubectl version --client=true

# Supabase CLI — enterprise migrate runs `supabase db push`.
RUN set -eux; \
    curl -fsSLo /tmp/supabase.tar.gz \
      "https://github.com/supabase/cli/releases/download/v${SUPABASE_CLI_VERSION}/supabase_${SUPABASE_CLI_VERSION}_linux_${TARGETARCH}.tar.gz"; \
    tar -xzf /tmp/supabase.tar.gz -C /usr/local/bin supabase; \
    rm -f /tmp/supabase.tar.gz; \
    chmod +x /usr/local/bin/supabase; \
    supabase --version

# Migration SQL, seeds, config.toml (supabase db push reads supabase/ from CWD).
COPY supabase/ /app/supabase/
# The migrate/seed/wait scripts the trial Jobs invoke.
COPY docker/supabase/ /app/docker/supabase/
# The fail-closed runtime-schema gate (both ledgers).
COPY scripts/porter/verify_project_serving_schema.sh /app/scripts/porter/verify_project_serving_schema.sh
# The HS256 JWT minting script (trial jwt-mint hook).
COPY infra/trial/scripts/mint_supabase_jwts.sh /app/infra/trial/scripts/mint_supabase_jwts.sh

RUN chmod +x \
    /app/docker/supabase/*.sh \
    /app/scripts/porter/verify_project_serving_schema.sh \
    /app/infra/trial/scripts/mint_supabase_jwts.sh

# Non-root hardening. Every role needs only network + a mounted DB URL (+ the
# kube API via the ServiceAccount token for jwt-mint), none of which need root.
# The installed binaries (psql, supabase, kubectl) live in world-executable
# paths; /app and a writable HOME are owned by the runtime user so kubectl and
# the Supabase CLI can write their caches. /tmp stays world-writable for scratch.
RUN set -eux; \
    groupadd -g 10001 explabs; \
    useradd -u 10001 -g 10001 -m -d /home/explabs -s /bin/bash explabs; \
    chown -R explabs:explabs /app /home/explabs
ENV HOME=/home/explabs

# Each k8s Job/initContainer overrides command; reset the base entrypoint so the
# Postgres entrypoint never runs.
ENTRYPOINT []
CMD ["/bin/bash"]

# Run as the non-root user by default (numeric uid so a runAsNonRoot policy is
# satisfied and the identity is unambiguous).
USER 10001
