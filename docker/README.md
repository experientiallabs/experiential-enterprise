# Experiential Labs Local Integration Stack

This stack runs the local platform surface:

- Supabase-compatible Postgres/PostgREST/Auth/Storage/Kong control plane.
- Combined control/gateway API and private gateway worker as separate
  processes.
- Next.js web UI.

Start it from the repository root:

```bash
./scripts/integration_stack.sh up
./scripts/integration_stack.sh smoke
```

Open http://localhost:3300.
Sign in with `admin@xplabs.ai` and the password from
`EXPLABS_AUTH_ADMIN_PASSWORD` in `docker/.env` (default `3XP321!`).

## Demo account (populated demo org)

Every fresh reset also seeds a **demo-shape organization** so the workspace
surfaces are evaluable with realistic data instead of empty states. This is
dev-only: the seed refuses to run when `EXPLABS_DEPLOYMENT_ENVIRONMENT` is
`production`, and no production workflow runs a seed script.

Sign in with:

- Email: `demo@experientiallabs.ai`
- Password: `DemoShape2026!`

(Override with `EXPLABS_DEMO_SEED_EMAIL` / `EXPLABS_DEMO_SEED_PASSWORD` before a
reset.) The demo org is a YC-funded startup, so it lands with a healthy credit
balance. You get, with no clicks:

- **Overview** — 90 contiguous days of personal usage across six models
  (activity contribution graph, top-models, spend chart, per-model requests all
  populated), plus a Members section with two teammates.
- **Telemetry** — request history with a realistic status mix (completed,
  failed, cancelled, incomplete) across both the platform-funded and BYOK
  (pass-through) lanes.
- **Credits** — a ledger with the $20 signup grant, a $326 YC launch grant, and
  two Stripe top-ups; balance reflects the platform-funded spend.
- **API keys** — two API keys (with a per-key daily cap / rate limit on the
  production key) plus BYOK provider connections seeded from any real provider
  keys present in the stack env (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`),
  each with a declared balance and ~60 days of snapshot history. Connections
  are only created for keys that are actually present — the seed never installs
  a fake key, because a BYOK connection routes that provider's traffic and a
  fake key would fail auth on every live call. OpenAI is intentionally left off
  the BYOK list so its models stay on the platform-funded lane the app serves
  with its own key; that is the demo's platform-funded showcase, while the
  OpenRouter connection demonstrates the BYOK pass-through lane.

The demo org's documented platform key (safe to publish — a known local-dev
credential) is `xpl_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0`, usable against the
local `/v1` gateway. All seeded values are deterministic, so repeated resets
produce identical data.

For a local Supabase CLI stack (`supabase db reset`) the same demo org is
seeded by `scripts/seed_supabase_local.sh`; in the Docker stack it is seeded in
the post-GoTrue auth pass (`docker/supabase/seed-auth-user.sh`). The seed itself
is `supabase/seed-demo.sql`.

Experiential's Rust OpenAI-compatible `/v1` data plane runs only in `gateway-worker`
(`EXPLABS_GATEWAY_WORKER_ONLY=1` on the api image), which authenticates real
`xpl_` keys against Postgres. The `api` process mounts the control `/api`
routes and the public `/v1` edge, which relays serving traffic to the worker
via `EXPLABS_GATEWAY_WORKER_URL`. Locally the worker is also published on
`EXPLABS_GATEWAY_WORKER_HOST_PORT` (default 18081) for worker-direct
benchmarking and debugging; hosted deployments keep it cluster-private behind
the edge.

FastAPI `/api/*` routes require `Authorization: Bearer $EXPLABS_API_KEY`.
`EXPLABS_GATEWAY_WORKER_KEY` protects the worker's `/internal/drain` and must
be distinct from every other deployment key. `/health` (and the worker's
`/health/live` + `/health/ready`) remain unauthenticated for container health
checks.

Useful commands:

```bash
./scripts/integration_stack.sh logs
./scripts/integration_stack.sh dump-logs
./scripts/integration_stack.sh status
./scripts/integration_stack.sh down
./scripts/integration_stack.sh reset
```

## Gateway end-to-end suite

With the stack running, the ten-scenario gateway proof
(`explabs/gateway/e2e_test.py`) launches REAL `explabs-gateway-worker`
processes on the host against the stack's Postgres:

```bash
./scripts/ci/gateway_e2e.sh
```

The script derives `SUPABASE_DB_URL` from this directory's `.env` host port.

## Gateway load/latency smoke (two targets)

With the stack running, the closed-loop load smoke
(`explabs/gateway/load_test.py`) drives a host-side loopback provider through
both serving targets — the public `/v1` edge on `EXPLABS_API_HOST_PORT`
(default 18080) and the worker directly on `EXPLABS_GATEWAY_WORKER_HOST_PORT`
(default 18081) — so edge overhead and worker-native latency land in separate
reports. The gates are shape-only (all 200s, ledger settles terminal), never
absolute time:

```bash
./scripts/ci/gateway_load.sh
```

The script derives the targets and `SUPABASE_DB_URL` from this directory's
`.env` host ports and writes the report JSON to `EXPLABS_LOAD_REPORT_PATH`
(default `/tmp/gateway-load-report.json`, replaced each run). For deeper local
runs, invoke pytest directly with the env contract from the module docstring:
`SUPABASE_DB_URL` plus at least one of `EXPLABS_LOAD_WORKER_URL` /
`EXPLABS_LOAD_EDGE_URL`, with `EXPLABS_LOAD_CONCURRENCY` and
`EXPLABS_LOAD_DURATION_SECONDS` overriding the small default profile. Both
serving containers map `host.docker.internal` to `host-gateway` so the worker
reaches the host-side provider on Linux as well as Docker Desktop. The script
prints its report to stdout.

`docker/.env.example` contains deterministic local-only Supabase JWTs and host ports. The
wrapper copies it to `docker/.env` if needed. The wrapper also loads `.env.local` before
`docker/.env` when a repo-local file is present. Set `EXPLABS_STACK_LOCAL_ENV_FILE` to
point at a different local env file. This lets local-only keys participate in stack runs
while keeping the deterministic Docker Supabase values authoritative. Do not use these
values outside local development.
The local GoTrue service sets `GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated` so users
created through Auth signup receive the PostgREST role required for RLS checks; no-org
users still receive an empty project list.
Auth emails — above all the 6-digit sign-in codes of the optional email-code
login — are caught by the stack's mailpit at `http://localhost:${EXPLABS_MAILPIT_HOST_PORT:-55424}`;
nothing is ever sent to a real inbox.

On shared Docker hosts, set a unique `EXPLABS_STACK_PROJECT_NAME` and host ports in the
gitignored `docker/.env` before running `reset`; otherwise parallel worktrees can contend
for the same Compose project, network, image, and ports.

By default the wrapper rebuilds the `api` and `web` images.
Set `EXPLABS_STACK_SKIP_BUILD=1` to skip that in-compose build and reuse images already
loaded into the Docker daemon under the `explabs-local-api` and
`explabs-local-web` tags. Those tags are
shared daemon-wide: set `EXPLABS_API_IMAGE` and `EXPLABS_WEB_IMAGE` to
checkout-unique values in `docker/.env` so one checkout's `--build` cannot silently
replace another running stack's code.

The smoke profile runs its services in sequence. `stack-smoke` checks the
database, control API, the gateway worker's `/health/ready`, auth, and web
routes. Then
`gateway-worker-acceptance` proves the worker's data plane end to end without
any funded provider: it hosts a loopback OpenAI-compatible SSE provider inside
its own container, seeds one organization, `xpl_` key, and loopback model row,
waits for the worker's catalog refresher to serve it, streams one
official-client chat completion, asserts the exact
`gateway_requests`/`gateway_attempts`/`gateway_usage_events` ledger rows and a
uniform 401 for an unknown key, and removes every row it or the worker's
refresher created.

Pinned third-party stack images interpolate `EXPLABS_STACK_REGISTRY_PREFIX` (default
empty, meaning Docker Hub — local development needs no registry login). Set it to your
own mirror prefix, ending in `/`, to pull the pinned images from a registry you control;
the tags must exist there or the pull fails with "manifest unknown".
