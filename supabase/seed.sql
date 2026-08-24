-- Control-plane seed for the Experiential Labs world-model platform.
--
-- Idempotent and safe to re-run on the local docker stack, Supabase preview
-- branches, and production: control-plane rows (organizations, users)
-- upsert on stable ids, while the generated demo world-model rows
-- are create-if-missing so a re-seed never regresses live product state.
-- Callers may set the `explabs.seed_*` GUCs before \i-ing this
-- file; unset GUCs fall back to the committed local demo defaults below
-- (except the password, which falls back to a random throwaway so a bare
-- re-seed never installs a known credential).

do $$
begin
  perform set_config(
    'explabs.seed_admin_email',
    coalesce(
      nullif(current_setting('explabs.seed_admin_email', true), ''),
      'admin@xplabs.ai'
    ),
    false
  );
  perform set_config(
    'explabs.seed_admin_password',
    coalesce(
      nullif(current_setting('explabs.seed_admin_password', true), ''),
      encode(gen_random_bytes(24), 'base64')
    ),
    false
  );
end
$$;

-- The operator org: its owner is the seeded platform admin (who bypasses the
-- credit gate), and the $20 signup grant is meant for customer tenants, so a
-- standing operator grant is seeded below with a stable id.
insert into public.organizations (id, slug, name, spend_unlocked_at)
values (
  '00000000-0000-0000-0000-000000000001',
  'experiential-labs',
  'Experiential Labs',
  -- The operator org has a founding admin (the seeded platform admin below), so
  -- the P1025 spend gate would lock it until unlocked; unlock it at seed time so
  -- the operator can spend immediately. (demo-examples / default-models are
  -- membership-less and so are never gated.)
  now()
)
-- Upsert on the stable primary key, not the mutable slug: a rename keeps id
-- 0...01 but changes slug, so an `on conflict (slug)` upsert would miss the
-- existing row and collide on the id pkey, breaking every re-seed.
on conflict (id) do update set
  slug = excluded.slug,
  name = excluded.name,
  spend_unlocked_at = coalesce(public.organizations.spend_unlocked_at, excluded.spend_unlocked_at);

-- Admin auth user. On the docker stack this block is a no-op during the
-- migrate pass (GoTrue has not created auth.users yet) and takes effect when
-- the supabase-auth-seed service re-runs seed.sql after GoTrue is healthy.
do $$
declare
  admin_user_id uuid := '00000000-0000-0000-0000-000000000099';
  admin_email text := current_setting('explabs.seed_admin_email');
  admin_password text := current_setting('explabs.seed_admin_password');
begin
  if to_regclass('auth.users') is null then
    raise notice 'Skipping admin auth seed because auth.users does not exist yet.';
  else
    insert into auth.users (
      instance_id,
      id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      recovery_sent_at,
      last_sign_in_at,
      raw_app_meta_data,
      raw_user_meta_data,
      created_at,
      updated_at,
      confirmation_token,
      email_change,
      email_change_token_new,
      recovery_token
    )
    values (
      '00000000-0000-0000-0000-000000000000',
      admin_user_id,
      'authenticated',
      'authenticated',
      admin_email,
      crypt(admin_password, gen_salt('bf')),
      now(),
      now(),
      now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{}'::jsonb,
      now(),
      now(),
      '',
      '',
      '',
      ''
    )
    on conflict (id) do update set
      aud = excluded.aud,
      role = excluded.role,
      email = excluded.email,
      encrypted_password = excluded.encrypted_password,
      email_confirmed_at = excluded.email_confirmed_at,
      raw_app_meta_data = excluded.raw_app_meta_data,
      raw_user_meta_data = excluded.raw_user_meta_data,
      updated_at = now();

    -- Modern GoTrue identity shape (uuid id + provider_id). Older auth
    -- schemas are unsupported; a failing insert here should fail the seed.
    if to_regclass('auth.identities') is not null then
      delete from auth.identities
      where user_id = admin_user_id
        and provider = 'email';

      insert into auth.identities (
        id,
        user_id,
        provider_id,
        identity_data,
        provider,
        last_sign_in_at,
        created_at,
        updated_at
      )
      values (
        admin_user_id,
        admin_user_id,
        admin_user_id::text,
        jsonb_build_object(
          'sub', admin_user_id::text,
          'email', admin_email,
          'email_verified', true,
          'phone_verified', false
        ),
        'email',
        now(),
        now(),
        now()
      );
    end if;
  end if;

  insert into public.organization_members (org_id, user_id, role)
  values (
    '00000000-0000-0000-0000-000000000001',
    admin_user_id,
    'admin'
  )
  on conflict (org_id, user_id) do update set
    role = excluded.role;

  -- Mark the operator org for the same application bootstrap a fresh
  -- self-serve account received. The exact frozen F1 fixture image consumed this after
  -- provisioning the shared catalog, importing the ready starter world
  -- model; no agent, build, or provider work happens here.
  insert into public.account_workspaces (user_id, org_id)
  values (admin_user_id, '00000000-0000-0000-0000-000000000001')
  on conflict (user_id) do update set
    org_id = excluded.org_id;

  -- The deployment admin is also a platform operator: sees the admin panel
  -- and manages org invitations.
  insert into public.platform_admins (user_id)
  values (admin_user_id)
  on conflict (user_id) do nothing;
end
$$;

-- Attach the signup org provisioning trigger. On the docker stack GoTrue
-- creates auth.users after migrations run, so the migration defers and this
-- seed pass (which waits for GoTrue) attaches it.
select public.ensure_signup_org_trigger();

-- The auth-user cleanup trigger has the same Docker ordering constraint.
-- Hosted Supabase attaches it during migration; local seed attaches it after
-- GoTrue creates auth.users.
select public.ensure_auth_user_cleanup_trigger();

-- The signup-notification trigger (Slack ping + PostHog capture) has the
-- same Docker ordering constraint again.
select public.ensure_notify_signup_trigger();

-- Credential rotation (revokes pre-unlock keys/sessions the moment an org's
-- spend is unlocked) now lives on public.organizations, which exists at migrate
-- time, so its trigger attaches in the migration -- no seed-time deferral.

-- The demo-examples org holds the bundled example world models behind the
-- shared catalog (customers browse and import them on demand; signup clones
-- nothing). It has no members (platform admins reach it through their
-- bypass); its credit is a standing seeded grant, not an exemption, so it
-- runs the same enforcement path as every tenant.
insert into public.organizations (id, slug, name)
values (
  '00000000-0000-0000-0000-000000000002',
  'demo-examples',
  'Demo Examples'
)
on conflict (id) do update set
  slug = excluded.slug,
  name = excluded.name;

-- The default-models workspace (the product owner, 2026-07-30): the org whose endpoints ARE
-- the published defaults. The /models door and every member catalog list this
-- workspace's endpoints, so curating the defaults is workspace administration:
-- add, rename, or delete an endpoint here and every audience follows. Like
-- demo-examples it has no members; platform admins manage it through their
-- bypass. Numbers shown for a default come from its endpoint's installed
-- improvement report, never from hand-written copy.
insert into public.organizations (id, slug, name)
values (
  '00000000-0000-0000-0000-000000000003',
  'default-models',
  'Default Models'
)
on conflict (id) do update set
  slug = excluded.slug,
  name = excluded.name;

-- Standing grants for the two platform orgs (idempotent on stable ids; the
-- $20 signup-promo trigger also fires on their first insert, which is fine —
-- these are the headroom on top). Fresh stacks get them at first boot;
-- existing stacks already hold the migration's opening grant and simply gain
-- this headroom once.
insert into public.credit_ledger (id, org_id, entry_type, amount_usd, reason, source)
values
  (
    '00000000-0000-0000-0000-00000000c001',
    '00000000-0000-0000-0000-000000000001',
    'grant',
    1000,
    'Operator org standing credit',
    'admin'
  ),
  (
    '00000000-0000-0000-0000-00000000c002',
    '00000000-0000-0000-0000-000000000002',
    'grant',
    1000,
    'Demo examples standing credit',
    'admin'
  ),
  -- The default-models workspace serves the public door AND carries the
  -- seeded (priced) demo telemetry; without headroom its ~$25 of derived
  -- spend would eat the $20 welcome grant and the zero-balance gate would
  -- 402 the playground on a fresh stack.
  (
    '00000000-0000-0000-0000-00000000c003',
    '00000000-0000-0000-0000-000000000003',
    'grant',
    1000,
    'Default-models workspace standing credit',
    'admin'
  )
on conflict (id) do nothing;

-- Converge stacks seeded before #367 renamed the flagship world model
-- tau2-bench -> tau-bench. Create-if-missing model seeds never delete, so a
-- pre-#367 volume keeps a stale 'tau2-bench' row (a different id than the
-- current tau-bench seeded below); drop it so a re-seed of an old stack
-- converges on the current name. The world_models delete cascades to its
-- builds, uploads, and bundle artifacts, and any endpoint that referenced it
-- keeps serving with world_model_id nulled (the policy is self-contained).
delete from public.world_models
where org_id = '00000000-0000-0000-0000-000000000002'
  and name = 'tau2-bench';

-- Demo world-model, bundle-artifact, and trace-upload rows derived from
-- example traces and their vendored BUILT bundles, generated once and frozen.
-- Seeding only populates the database: the demo models arrive 'ready' with
-- their committed bundle artifacts, their measured held-out fidelity, and a
-- completed build_jobs row recording the evaluated run that measured it,
-- and the exact frozen F1 fixture image uploads the trace and bundle bytes to the
-- storage paths these rows reference — no build ever runs at seed time.
-- BEGIN generated at frozen Platform F1 revision; historical rows are immutable.

-- Demo world model seeded from the tau-bench example traces
-- (12 traces / 67 adapter-mapped steps). Its committed BUILT bundle is
-- seeded as its ready artifact below; the frozen fixture image uploads the trace
-- and bundle bytes, so seeding never runs a build.
-- Create-if-missing only: re-seeding a live database must not regress rows
-- the product has since updated (e.g. a rebuilt model back to the seed).
insert into public.world_models (
  id,
  org_id,
  name,
  display_name,
  status,
  serve_provider,
  serve_model,
  embed_provider,
  embed_dim,
  gepa_budget,
  trace_adapter,
  config
)
values (
  'b5edaef1-2acd-5dd3-a0fb-0f012cda0316',
  '00000000-0000-0000-0000-000000000002',
  'tau-bench',
  'Tau Bench',
  'created',
  'azure',
  'gpt-5.5',
  'hashing',
  512,
  null,
  'otel-genai',
  '{"endpoint": "https://example-demo.openai.azure.com", "top_k": 5, "train_split": 0.8}'::jsonb
)
on conflict (id) do nothing;

-- The vendored built bundle's artifacts row. Digest and size are those of
-- the committed tau-bench bundle bytes,
-- which the frozen fixture image uploads to this exact bucket and path; the
-- serving registry downloads from the row's own bucket and verifies against
-- them, so the seeded model loads regardless of any env bucket override.
insert into public.artifacts (
  id,
  org_id,
  kind,
  storage_bucket,
  storage_path,
  byte_size,
  sha256,
  world_model_id
)
values (
  '4ab20689-c665-541a-9b5d-852a0558917d',
  '00000000-0000-0000-0000-000000000002',
  'world_model_bundle',
  'explabs-artifacts',
  'models/b5edaef1-2acd-5dd3-a0fb-0f012cda0316/4ab20689-c665-541a-9b5d-852a0558917d.tar.gz',
  26663,
  '0e601e183c94e3b5abb2be6d41934df06514f07468439e0f1d9c68ed6e6a564f',
  'b5edaef1-2acd-5dd3-a0fb-0f012cda0316'
)
on conflict (id) do nothing;

-- The matching upload row, already in its post-build 'ingested' state with
-- the counts the trace adapter actually mapped while the vendored bundle was
-- generated (only GenAI spans become steps). The frozen fixture image puts the
-- fixture bytes at this exact storage path so the seeded upload is a real,
-- downloadable object.
insert into public.trace_uploads (
  id,
  org_id,
  world_model_id,
  filename,
  storage_path,
  byte_size,
  sha256,
  adapter,
  trace_count,
  step_count,
  status
)
values (
  '1a1b9401-0189-51d3-a96a-fc3ed794788b',
  '00000000-0000-0000-0000-000000000002',
  'b5edaef1-2acd-5dd3-a0fb-0f012cda0316',
  'tau-bench.otel.jsonl',
  'traces/b5edaef1-2acd-5dd3-a0fb-0f012cda0316/1a1b9401-0189-51d3-a96a-fc3ed794788b.jsonl',
  143785,
  '9f784766fa829a6c0c345089325fa32ea204c2fbfcdab6537dbe214b484d3794',
  'otel-genai',
  12,
  67,
  'ingested'
)
on conflict (id) do nothing;

-- The completed build behind the vendored bundle, so the model's build
-- history shows real provenance instead of a ready model with no builds.
-- For measured fixtures this is the evaluated run that produced the pinned
-- fidelity, verbatim (completed 'evaluating' phase with its per-step ticks
-- and the real metered usage); otherwise it mirrors a GEPA-off, eval-off
-- build ('indexed' progress, no usage). No worker/runtime either way: the
-- row records provenance, nothing was dispatched at seed time. Timestamps
-- are seed-run time.
insert into public.build_jobs (
  id,
  world_model_id,
  trace_upload_id,
  evaluate,
  status,
  gepa_budget,
  runtime_backend,
  runtime_call_id,
  worker_id,
  heartbeat_at,
  progress,
  usage,
  error,
  started_at,
  finished_at
)
values (
  '79721b41-337f-5575-ad92-f29ea1f63a99',
  'b5edaef1-2acd-5dd3-a0fb-0f012cda0316',
  '1a1b9401-0189-51d3-a96a-fc3ed794788b',
  true,
  'completed',
  null,
  null,
  null,
  null,
  null,
  '{"activity": "evaluating held-out fidelity: 7/7 steps", "eval_done": 7, "eval_total": 7, "frontier_size": 1, "held_out_accuracy": 0.0, "phase": "evaluating", "rollouts_done": 0, "steps": 67, "test": 1, "traces": 12, "train": 11}'::jsonb,
  '{"by_phase": {"gepa": {"calls": 7, "cost_usd": 0.37529999999999997, "input_tokens": 23490, "output_tokens": 8595}, "judge": {"calls": 7, "cost_usd": 0.09205, "input_tokens": 6800, "output_tokens": 1935}}, "duration_seconds": 70.847113513, "kind": "build", "run_id": "bf83f9b83fee42f69f833ce1e2f98604", "total": {"calls": 14, "cost_usd": 0.46735, "input_tokens": 30290, "output_tokens": 10530}}'::jsonb,
  null,
  now(),
  now()
)
on conflict (id) do nothing;

-- Stamp the freshly inserted model ready with its vendored bundle. Guarded
-- on the just-inserted 'created' status so it fires exactly once: a model
-- that ever left 'created' on a live database (rebuilt, building, failed)
-- is never regressed to the seed artifact. Metrics carry the model's
-- measured held-out fidelity (pinned verbatim from the evaluated run the
-- build_jobs row above records) — or the honest never-evaluated snapshot
-- when no measurement is pinned.
update public.world_models
set
  status = 'ready',
  artifact_id = '4ab20689-c665-541a-9b5d-852a0558917d',
  metrics = '{"eval_error": null, "evaluated_steps": 7, "held_out_accuracy": 0.6602857142857143, "held_out_ci95": 0.07143207122854553, "held_out_std": 0.09642423270662427, "judge_agreement": null, "judge_model": null, "rollouts_used": 0}'::jsonb,
  updated_at = now()
where id = 'b5edaef1-2acd-5dd3-a0fb-0f012cda0316'
  and status = 'created';

-- Demo world model seeded from the terminal-tasks example traces
-- (71 traces / 158 adapter-mapped steps). Its committed BUILT bundle is
-- seeded as its ready artifact below; the frozen fixture image uploads the trace
-- and bundle bytes, so seeding never runs a build.
-- Create-if-missing only: re-seeding a live database must not regress rows
-- the product has since updated (e.g. a rebuilt model back to the seed).
insert into public.world_models (
  id,
  org_id,
  name,
  display_name,
  status,
  serve_provider,
  serve_model,
  embed_provider,
  embed_dim,
  gepa_budget,
  trace_adapter,
  config
)
values (
  'fa7c063b-7fd8-54c5-89e4-47649b101f67',
  '00000000-0000-0000-0000-000000000002',
  'terminal-tasks',
  'Terminal Tasks',
  'created',
  'azure',
  'gpt-5.5',
  'hashing',
  512,
  null,
  'otel-genai',
  '{"endpoint": "https://example-demo.openai.azure.com", "top_k": 5, "train_split": 0.8}'::jsonb
)
on conflict (id) do nothing;

-- The vendored built bundle's artifacts row. Digest and size are those of
-- the committed terminal-tasks bundle bytes,
-- which the frozen fixture image uploads to this exact bucket and path; the
-- serving registry downloads from the row's own bucket and verifies against
-- them, so the seeded model loads regardless of any env bucket override.
insert into public.artifacts (
  id,
  org_id,
  kind,
  storage_bucket,
  storage_path,
  byte_size,
  sha256,
  world_model_id
)
values (
  '48a79c60-6991-560c-a591-018bc07bdc73',
  '00000000-0000-0000-0000-000000000002',
  'world_model_bundle',
  'explabs-artifacts',
  'models/fa7c063b-7fd8-54c5-89e4-47649b101f67/48a79c60-6991-560c-a591-018bc07bdc73.tar.gz',
  67440,
  'f9fa4f939abc5467482c1469678f1fbb13ed0c3aae4ebb7618cd7ce7bb264848',
  'fa7c063b-7fd8-54c5-89e4-47649b101f67'
)
on conflict (id) do nothing;

-- The matching upload row, already in its post-build 'ingested' state with
-- the counts the trace adapter actually mapped while the vendored bundle was
-- generated (only GenAI spans become steps). The frozen fixture image puts the
-- fixture bytes at this exact storage path so the seeded upload is a real,
-- downloadable object.
insert into public.trace_uploads (
  id,
  org_id,
  world_model_id,
  filename,
  storage_path,
  byte_size,
  sha256,
  adapter,
  trace_count,
  step_count,
  status
)
values (
  '356ea359-3bc7-517a-bd22-c6d6cab456f9',
  '00000000-0000-0000-0000-000000000002',
  'fa7c063b-7fd8-54c5-89e4-47649b101f67',
  'terminal-tasks.otel.jsonl',
  'traces/fa7c063b-7fd8-54c5-89e4-47649b101f67/356ea359-3bc7-517a-bd22-c6d6cab456f9.jsonl',
  240660,
  '2cf4fefd6408fa4e67892ef7ac83134876533977b0a8d14de9aa138cddd70a96',
  'otel-genai',
  71,
  158,
  'ingested'
)
on conflict (id) do nothing;

-- The completed build behind the vendored bundle, so the model's build
-- history shows real provenance instead of a ready model with no builds.
-- For measured fixtures this is the evaluated run that produced the pinned
-- fidelity, verbatim (completed 'evaluating' phase with its per-step ticks
-- and the real metered usage); otherwise it mirrors a GEPA-off, eval-off
-- build ('indexed' progress, no usage). No worker/runtime either way: the
-- row records provenance, nothing was dispatched at seed time. Timestamps
-- are seed-run time.
insert into public.build_jobs (
  id,
  world_model_id,
  trace_upload_id,
  evaluate,
  status,
  gepa_budget,
  runtime_backend,
  runtime_call_id,
  worker_id,
  heartbeat_at,
  progress,
  usage,
  error,
  started_at,
  finished_at
)
values (
  'bf2a7187-eb1c-51a8-8d1e-177344af1029',
  'fa7c063b-7fd8-54c5-89e4-47649b101f67',
  '356ea359-3bc7-517a-bd22-c6d6cab456f9',
  true,
  'completed',
  null,
  null,
  null,
  null,
  null,
  '{"activity": "evaluating held-out fidelity: 42/42 steps", "eval_done": 42, "eval_total": 42, "frontier_size": 1, "held_out_accuracy": 0.0, "phase": "evaluating", "rollouts_done": 0, "steps": 158, "test": 12, "traces": 71, "train": 59}'::jsonb,
  '{"by_phase": {"gepa": {"calls": 42, "cost_usd": 1.7742850000000001, "input_tokens": 79973, "output_tokens": 45814}, "judge": {"calls": 42, "cost_usd": 0.4284200000000001, "input_tokens": 28078, "output_tokens": 9601}}, "duration_seconds": 122.85450225299999, "kind": "build", "run_id": "a082599cb3794ff8aa9fa755d4d558da", "total": {"calls": 84, "cost_usd": 2.202705, "input_tokens": 108051, "output_tokens": 55415}}'::jsonb,
  null,
  now(),
  now()
)
on conflict (id) do nothing;

-- Stamp the freshly inserted model ready with its vendored bundle. Guarded
-- on the just-inserted 'created' status so it fires exactly once: a model
-- that ever left 'created' on a live database (rebuilt, building, failed)
-- is never regressed to the seed artifact. Metrics carry the model's
-- measured held-out fidelity (pinned verbatim from the evaluated run the
-- build_jobs row above records) — or the honest never-evaluated snapshot
-- when no measurement is pinned.
update public.world_models
set
  status = 'ready',
  artifact_id = '48a79c60-6991-560c-a591-018bc07bdc73',
  metrics = '{"eval_error": null, "evaluated_steps": 42, "held_out_accuracy": 0.6996666666666667, "held_out_ci95": 0.08844286726678625, "held_out_std": 0.2924363721325235, "judge_agreement": null, "judge_model": null, "rollouts_used": 0}'::jsonb,
  updated_at = now()
where id = 'fa7c063b-7fd8-54c5-89e4-47649b101f67'
  and status = 'created';

-- END generated at frozen Platform F1 revision.

-- Seeded ready endpoints (the UI's "models"). The flagship is the tau-bench
-- world model surfaced as a ready endpoint in the memberless demo-examples
-- template org — what anonymous catalog play and platform-admin walkthroughs
-- see. The two operator-org endpoints are the ones the demo serving log below
-- references by id (so Usage's endpoint breakdown resolves to real Models
-- rows instead of dangling ids); they carry no world model, serving only the
-- static policy. Fresh self-serve orgs get their own 'default' endpoint from
-- the pre-Project account bootstrap at signup/seed, not from this block.
--
-- COUPLING: the policy is a static snapshot of what
-- explabs.engine.serving_pool.build_static_policy('claude-opus-4-8') emits on a
-- Bedrock-credentialed deployment (the demo/local target) — the product owner's ruling is
-- the strongest serveable pool model, keeping accuracy and cost. SQL cannot
-- derive the env-dependent pool, so the shape is pinned here (same shape the
-- endpoints_test _ROW_POLICY documents); a deployment without Bedrock
-- credentials could not serve this pool live. API views never expose the raw
-- policy, only default_model and the (empty) cluster/anchor summaries.
-- Create-if-missing on the id, like every demo row above.
--
-- REPORT: each seeded endpoint carries a research-derived "optimized" improvement
-- report so the Models page shows real evidence on day one instead of empty
-- zeros. It is the DERIVED output of
-- explabs.engine.seed_report.build_optimized_report — every dollar figure is the
-- catalog list price over a stated eval workload (never typed in), per-model task
-- success is measured on the tau-bench held-out benchmark (NOT the customer's
-- traffic, as the scenario_label states), and the headline reproduces the guarded
-- router's balanced held-out point (traffic routed plurality to a strong cheap
-- model, the frontier kept for the rest: +~1pt quality at ~-25% cost). The JSON
-- below is generated, not hand-authored (seed_report_test pins it to the builder);
-- endpoint_id is stamped per row. A real optimizer run later replaces the whole
-- report via the endpoint's id (on conflict do nothing preserves it on re-seed).
with default_policy as (
  select '{
    "version": 2,
    "kind": "static",
    "default_model": "claude-opus-4-8",
    "pool": [
      {
        "name": "claude-opus-4-8",
        "kind": "anthropic",
        "model": "claude-opus-4-8",
        "endpoint": null,
        "deployment": null,
        "api_version": null,
        "region": null,
        "api_key_env": "ANTHROPIC_API_KEY",
        "tier": "frontier",
        "input_per_mtok": 5.0,
        "output_per_mtok": 25.0,
        "cached_input_per_mtok": 0.5
      }
    ],
    "embedder": {
      "kind": "hashing",
      "dim": 512,
      "deployment": null,
      "endpoint": null,
      "api_key_env": null,
      "batch": 256
    },
    "clusters": [],
    "top_k_clusters": 2,
    "beta": 6.0,
    "default_rank": 999,
    "sticky": true,
    "support_tilt_gamma": 0.0,
    "cost_scale": 0.0,
    "guard_model": null,
    "min_support": null,
    "guard_margin": null,
    "fitted_from": null
  }'::jsonb as policy
),
-- BEGIN measured bench reports (explabs/engine/bench_reports/*.json; pinned by
-- seed_report_test). Each published default carries ITS OWN benchmark's REAL
-- measured improvement report - the bench-defaults program's actual artifacts
-- (20 pinned scenarios per benchmark, every candidate measured with real
-- episodes, paired against Claude Fable 5 under identical pins) - because
-- three tiles quoting one shared blob read as a broken page and claim numbers
-- nobody measured for that benchmark (the product owner, 2026-07-30). Dollar-quoted so the
-- JSON needs no escaping; endpoint_id is the empty placeholder, stamped per
-- row below. A real optimizer run later replaces the whole report via the
-- endpoint's id.
bench_reports(benchmark, report) as (
  values
    ('swe-bench', $swe_report${"baseline": {"label": "Claude Fable 5", "model_id": "fable-5", "tier": "frontier"}, "candidates": [{"accuracy": 0.675, "cost_per_run_usd": 0.41808752499999996, "label": "GPT-5.5", "latency_p50_ms": 4535.315291985171, "latency_p95_ms": 18067.810091777937, "model_id": "gpt-5.5", "scored_episodes": 40, "success_rate": 0.675, "tier": "frontier", "unscored_episodes": 0}, {"accuracy": 0.4, "cost_per_run_usd": 0.02781300375, "label": "GPT-5.4 mini", "latency_p50_ms": 1671.064229507465, "latency_p95_ms": 3567.4762026697863, "model_id": "gpt-5.4-mini", "scored_episodes": 40, "success_rate": 0.4, "tier": "frontier", "unscored_episodes": 0}, {"accuracy": 0.6, "cost_per_run_usd": 0.3354094744, "label": "DeepSeek V4 Pro", "latency_p50_ms": 2556.1097295139916, "latency_p95_ms": 15141.44743700308, "model_id": "deepseek-v4-pro", "scored_episodes": 40, "success_rate": 0.6, "tier": "open", "unscored_episodes": 0}, {"accuracy": 0.425, "cost_per_run_usd": 0.4161713754, "label": "Kimi K2.6", "latency_p50_ms": 2363.4289169858675, "latency_p95_ms": 23565.121895298944, "model_id": "kimi-k2.6", "scored_episodes": 40, "success_rate": 0.425, "tier": "open", "unscored_episodes": 0}, {"accuracy": 0.5384615384615384, "cost_per_run_usd": 0.3865236292307692, "label": "GLM-5.2", "latency_p50_ms": 3241.904333990533, "latency_p95_ms": 26931.294775320566, "model_id": "glm-5.2", "scored_episodes": 39, "success_rate": 0.5384615384615384, "tier": "open", "unscored_episodes": 1}, {"accuracy": 0.875, "cost_per_run_usd": 1.2195850125, "label": "Claude Fable 5", "latency_p50_ms": 8035.571958491346, "latency_p95_ms": 40051.70362225326, "model_id": "fable-5", "scored_episodes": 40, "success_rate": 0.875, "tier": "frontier", "unscored_episodes": 0}, {"accuracy": 0.675, "cost_per_run_usd": 0.53200892625, "label": "Claude Sonnet 5", "latency_p50_ms": 3017.4128125217976, "latency_p95_ms": 31195.260075204715, "model_id": "sonnet-5", "scored_episodes": 40, "success_rate": 0.675, "tier": "frontier", "unscored_episodes": 0}, {"accuracy": 0.425, "cost_per_run_usd": 0.2839803375, "label": "Claude Haiku 4.5", "latency_p50_ms": 1817.061145993648, "latency_p95_ms": 7304.5860936064855, "model_id": "haiku-4-5", "scored_episodes": 40, "success_rate": 0.425, "tier": "frontier", "unscored_episodes": 0}, {"accuracy": 0.775, "cost_per_run_usd": 0.31356543124999997, "label": "Claude Opus 4.8", "latency_p50_ms": 3461.553416971583, "latency_p95_ms": 9955.181146491668, "model_id": "opus-4-8", "scored_episodes": 40, "success_rate": 0.775, "tier": "frontier", "unscored_episodes": 0}, {"accuracy": 0.85, "cost_per_run_usd": 0.7770521312499999, "label": "Claude Opus 5", "latency_p50_ms": 6173.7557080050465, "latency_p95_ms": 29579.12282499019, "model_id": "opus-5", "scored_episodes": 40, "success_rate": 0.85, "tier": "frontier", "unscored_episodes": 0}, {"accuracy": 0.6410256410256411, "cost_per_run_usd": 0.6326074, "label": "Kimi K3", "latency_p50_ms": 5607.309250015533, "latency_p95_ms": 23306.42823340604, "model_id": "kimi-k3", "scored_episodes": 39, "success_rate": 0.6410256410256411, "tier": "frontier", "unscored_episodes": 1}, {"accuracy": 0.7, "cost_per_run_usd": 0.19584855, "label": "GPT-5.6 Sol", "latency_p50_ms": 4144.1044170060195, "latency_p95_ms": 9668.334679337568, "model_id": "gpt-5.6-sol", "scored_episodes": 40, "success_rate": 0.7, "tier": "frontier", "unscored_episodes": 0}, {"accuracy": 0.6, "cost_per_run_usd": 0.07661503124999999, "label": "GPT-5.6 Terra", "latency_p50_ms": 2250.6581244961126, "latency_p95_ms": 5367.732760256331, "model_id": "gpt-5.6-terra", "scored_episodes": 40, "success_rate": 0.6, "tier": "frontier", "unscored_episodes": 0}, {"accuracy": 0.5, "cost_per_run_usd": 0.028696757499999996, "label": "GPT-5.6 Luna", "latency_p50_ms": 2020.9135625045747, "latency_p95_ms": 5313.891426747432, "model_id": "gpt-5.6-luna", "scored_episodes": 40, "success_rate": 0.5, "tier": "frontier", "unscored_episodes": 0}, {"accuracy": 0.02631578947368421, "cost_per_run_usd": 0.09905543947368421, "label": "Qwen3.5 9B", "latency_p50_ms": 6308.913957996992, "latency_p95_ms": 24126.317040994763, "model_id": "qwen3.5-9b", "scored_episodes": 38, "success_rate": 0.02631578947368421, "tier": "open", "unscored_episodes": 2}, {"accuracy": 0.55, "cost_per_run_usd": 0.20782963, "label": "Qwen3.6 27B", "latency_p50_ms": 3190.7118749804795, "latency_p95_ms": 20453.644958196674, "model_id": "qwen3.6-27b", "scored_episodes": 40, "success_rate": 0.55, "tier": "open", "unscored_episodes": 0}], "cost_assumptions": "Costs are measured candidate-side per eval episode at the pool's per-token prices (single-shot; provider prompt-cache effects on multi-turn traffic not yet modeled).", "endpoint_id": "", "generated_at": "2026-07-29T17:13:46.229012+00:00", "headline": {"accuracy": 0.85, "baseline_accuracy": 0.875, "baseline_cost_per_run_usd": 1.2195850125, "baseline_latency_p50_ms": 8035.571958491346, "baseline_latency_p95_ms": 40051.70362225326, "cost_per_run_usd": 0.7770521312499999, "latency_p50_ms": 6173.7557080050465, "latency_p95_ms": 29579.12282499019, "scenarios_compared": 20, "scenarios_excluded": 0}, "model_mix": [{"model_id": "opus-5", "share": 1.0}], "scenario_count": 20, "scenario_ids": ["django__django-15280", "django__django-13343", "django__django-12708", "matplotlib__matplotlib-13989", "django__django-11815", "django__django-11790", "django__django-16429", "django__django-13513", "django__django-16938", "django__django-14792", "astropy__astropy-8707", "astropy__astropy-14598", "django__django-12965", "django__django-12419", "django__django-12406", "django__django-11119", "django__django-12308", "astropy__astropy-14539", "matplotlib__matplotlib-14623", "django__django-17084"], "scenario_label": "on all 20 pinned SWE-Bench-Verified instances (2 real episodes per instance per candidate, 16 candidates, 640 episodes), scored by the SWE-bench test suite itself rather than an LLM judge, at a 75-call cap against mini-swe-agent's shipped 250 (the cap binds only the cheap arms: 2% of fable-5 cells hit it, 82% of qwen3.5-9b cells did), measured relative to fable-5 under identical pins and therefore not comparable to leaderboard numbers"}$swe_report$::jsonb),
    ('tau-bench', $tau_report${"baseline": {"label": "Claude Fable 5", "model_id": "fable-5", "tier": "frontier"}, "candidates": [{"accuracy": 0.5641025641025641, "cost_per_run_usd": 0.34523371794871793, "label": "GPT-5.5", "latency_p50_ms": 2428.148874489125, "latency_p95_ms": 9992.955523199635, "model_id": "gpt-5.5", "scored_episodes": 39, "success_rate": 0.5641025641025641, "tier": "frontier", "unscored_episodes": 0}, {"accuracy": 0.0, "cost_per_run_usd": 0.0, "label": "GPT-5.4 mini", "latency_p50_ms": 0.0, "latency_p95_ms": 0.0, "model_id": "gpt-5.4-mini", "scored_episodes": 0, "success_rate": 0.0, "tier": "frontier", "unscored_episodes": 0}, {"accuracy": 0.625, "cost_per_run_usd": 0.15874202795, "label": "DeepSeek V4 Pro", "latency_p50_ms": 2392.7187919907738, "latency_p95_ms": 9173.836937503074, "model_id": "deepseek-v4-pro", "scored_episodes": 40, "success_rate": 0.625, "tier": "open", "unscored_episodes": 0}, {"accuracy": 0.625, "cost_per_run_usd": 0.08324614512499999, "label": "Kimi K2.6", "latency_p50_ms": 2868.4478540089913, "latency_p95_ms": 13244.08532763191, "model_id": "kimi-k2.6", "scored_episodes": 40, "success_rate": 0.625, "tier": "open", "unscored_episodes": 0}, {"accuracy": 0.75, "cost_per_run_usd": 0.12704036400000002, "label": "GLM-5.2", "latency_p50_ms": 3115.1249590038788, "latency_p95_ms": 24384.73424359836, "model_id": "glm-5.2", "scored_episodes": 40, "success_rate": 0.75, "tier": "open", "unscored_episodes": 0}, {"accuracy": 0.7567567567567568, "cost_per_run_usd": 1.02113, "label": "Claude Fable 5", "latency_p50_ms": 5299.2334160080645, "latency_p95_ms": 9912.31028381153, "model_id": "fable-5", "scored_episodes": 37, "success_rate": 0.7567567567567568, "tier": "frontier", "unscored_episodes": 0}, {"accuracy": 0.7, "cost_per_run_usd": 0.384595875, "label": "Claude Sonnet 5", "latency_p50_ms": 2882.079500006512, "latency_p95_ms": 9677.925557893468, "model_id": "sonnet-5", "scored_episodes": 40, "success_rate": 0.7, "tier": "frontier", "unscored_episodes": 0}, {"accuracy": 0.35, "cost_per_run_usd": 0.082287725, "label": "Claude Haiku 4.5", "latency_p50_ms": 2300.663562491536, "latency_p95_ms": 4868.308103701565, "model_id": "haiku-4-5", "scored_episodes": 40, "success_rate": 0.35, "tier": "frontier", "unscored_episodes": 0}, {"accuracy": 0.625, "cost_per_run_usd": 0.56615125, "label": "Claude Opus 4.8", "latency_p50_ms": 2790.236625005491, "latency_p95_ms": 7565.0051916978555, "model_id": "opus-4-8", "scored_episodes": 40, "success_rate": 0.625, "tier": "frontier", "unscored_episodes": 0}, {"accuracy": 0.7368421052631579, "cost_per_run_usd": 0.5228081578947369, "label": "Claude Opus 5", "latency_p50_ms": 3883.8125829934143, "latency_p95_ms": 8557.500037489808, "model_id": "opus-5", "scored_episodes": 38, "success_rate": 0.7368421052631579, "tier": "frontier", "unscored_episodes": 0}, {"accuracy": 0.675, "cost_per_run_usd": 0.24991455, "label": "Kimi K3", "latency_p50_ms": 3430.240812493139, "latency_p95_ms": 12585.918756092724, "model_id": "kimi-k3", "scored_episodes": 40, "success_rate": 0.675, "tier": "frontier", "unscored_episodes": 0}, {"accuracy": 0.675, "cost_per_run_usd": 0.315527625, "label": "GPT-5.6 Sol", "latency_p50_ms": 2173.741666978458, "latency_p95_ms": 5091.784832795383, "model_id": "gpt-5.6-sol", "scored_episodes": 40, "success_rate": 0.675, "tier": "frontier", "unscored_episodes": 0}, {"accuracy": 0.65, "cost_per_run_usd": 0.1466075625, "label": "GPT-5.6 Terra", "latency_p50_ms": 1478.1449164875085, "latency_p95_ms": 4631.614131407696, "model_id": "gpt-5.6-terra", "scored_episodes": 40, "success_rate": 0.65, "tier": "frontier", "unscored_episodes": 0}, {"accuracy": 0.375, "cost_per_run_usd": 0.048495575, "label": "GPT-5.6 Luna", "latency_p50_ms": 1540.407166001387, "latency_p95_ms": 3937.0805828017183, "model_id": "gpt-5.6-luna", "scored_episodes": 40, "success_rate": 0.375, "tier": "frontier", "unscored_episodes": 0}, {"accuracy": 0.35, "cost_per_run_usd": 0.0036175450000000007, "label": "Qwen3.5 9B", "latency_p50_ms": 7990.633395995246, "latency_p95_ms": 52566.378662508214, "model_id": "qwen3.5-9b", "scored_episodes": 40, "success_rate": 0.35, "tier": "open", "unscored_episodes": 0}, {"accuracy": 0.675, "cost_per_run_usd": 0.0391693775, "label": "Qwen3.6 27B", "latency_p50_ms": 6421.013916507945, "latency_p95_ms": 42810.88161475054, "model_id": "qwen3.6-27b", "scored_episodes": 40, "success_rate": 0.675, "tier": "open", "unscored_episodes": 0}], "cost_assumptions": "Costs are measured candidate-side per eval episode at the pool's per-token prices (single-shot; provider prompt-cache effects on multi-turn traffic not yet modeled).", "endpoint_id": "", "generated_at": "2026-07-29T17:17:25.059240+00:00", "headline": {"accuracy": 0.7368421052631579, "baseline_accuracy": 0.7567567567567568, "baseline_cost_per_run_usd": 1.02113, "baseline_latency_p50_ms": 5299.2334160080645, "baseline_latency_p95_ms": 9912.31028381153, "cost_per_run_usd": 0.36989368421052626, "latency_p50_ms": 2936.4647080074064, "latency_p95_ms": 9651.874728899566, "scenarios_compared": 19, "scenarios_excluded": 1}, "model_mix": [{"model_id": "sonnet-5", "share": 1.0}], "scenario_count": 20, "scenario_ids": ["airline:12", "airline:4", "airline:40", "airline:44", "airline:0", "airline:6", "airline:22", "retail:33", "retail:100", "retail:102", "retail:86", "retail:88", "retail:92", "retail:52", "retail:8", "telecom:[mobile_data_issue]airplane_mode_on|bad_network_preference|bad_vpn|data_mode_off|data_saver_mode_on|data_usage_exceeded[PERSONA:Hard]", "telecom:[mms_issue]airplane_mode_on|bad_network_preference|bad_wifi_calling|break_apn_mms_setting|break_app_both_permissions|data_mode_off|data_usage_exceeded|unseat_sim_card[PERSONA:Hard]", "telecom:[service_issue]airplane_mode_on|break_apn_settings|contract_end_suspension|lock_sim_card_pin|unseat_sim_card[PERSONA:Easy]", "telecom:[mms_issue]airplane_mode_on|bad_network_preference|bad_wifi_calling|break_apn_mms_setting|break_app_both_permissions|data_mode_off|data_usage_exceeded|unseat_sim_card|user_abroad_roaming_disabled_off[PERSONA:Hard]", "telecom:[mobile_data_issue]airplane_mode_on|bad_network_preference|bad_vpn|data_mode_off|data_saver_mode_on|data_usage_exceeded|user_abroad_roaming_disabled_off[PERSONA:Hard]"], "scenario_label": "on the 20 pinned tau2-bench eval scenarios, real benchmark episodes (provenance real_episode), 2 episodes each; large well-resolved cost savings with QUALITY UNRESOLVED at this sample size (quality CIs span about +-20 points); measured winner glm-5.2 excluded from serving: no authoritative serving price; gpt-5.6-* measured with reasoning off (reasoning_effort=none): the only tool-calling configuration reachable via chat completions, which is what the product serves"}$tau_report$::jsonb),
    ('terminal-bench-2', $tb2_report${"baseline": {"label": "Claude Fable 5", "model_id": "fable-5", "tier": "frontier"}, "candidates": [{"accuracy": 0.65, "cost_per_run_usd": 0.85085215, "label": "GPT-5.5", "latency_p50_ms": 7774.021148681641, "latency_p95_ms": 48868.613052368164, "model_id": "gpt-5.5", "scored_episodes": 40, "success_rate": 0.65, "tier": "frontier", "unscored_episodes": 0}, {"accuracy": 0.275, "cost_per_run_usd": 0.4528823475, "label": "GPT-5.4 mini", "latency_p50_ms": 2790.4839515686035, "latency_p95_ms": 6276.577401161194, "model_id": "gpt-5.4-mini", "scored_episodes": 40, "success_rate": 0.275, "tier": "frontier", "unscored_episodes": 0}, {"accuracy": 0.55, "cost_per_run_usd": 3.1596992253750003, "label": "DeepSeek V4 Pro", "latency_p50_ms": 9837.61751651764, "latency_p95_ms": 60103.04869413376, "model_id": "deepseek-v4-pro", "scored_episodes": 40, "success_rate": 0.55, "tier": "open", "unscored_episodes": 0}, {"accuracy": 0.625, "cost_per_run_usd": 0.7799444389, "label": "Kimi K2.6", "latency_p50_ms": 6655.95817565918, "latency_p95_ms": 65282.41605758667, "model_id": "kimi-k2.6", "scored_episodes": 40, "success_rate": 0.625, "tier": "open", "unscored_episodes": 0}, {"accuracy": 0.725, "cost_per_run_usd": 0.8758858469999999, "label": "GLM-5.2", "latency_p50_ms": 11949.299693107605, "latency_p95_ms": 178080.3258419037, "model_id": "glm-5.2", "scored_episodes": 40, "success_rate": 0.725, "tier": "open", "unscored_episodes": 0}, {"accuracy": 0.775, "cost_per_run_usd": 2.01013895, "label": "Claude Fable 5", "latency_p50_ms": 7582.324504852295, "latency_p95_ms": 120642.84871816635, "model_id": "fable-5", "scored_episodes": 40, "success_rate": 0.775, "tier": "frontier", "unscored_episodes": 0}, {"accuracy": 0.8, "cost_per_run_usd": 0.9461717025, "label": "Claude Sonnet 5", "latency_p50_ms": 6142.0698165893555, "latency_p95_ms": 90148.12369346619, "model_id": "sonnet-5", "scored_episodes": 40, "success_rate": 0.8, "tier": "frontier", "unscored_episodes": 0}, {"accuracy": 0.275, "cost_per_run_usd": 0.307724555, "label": "Claude Haiku 4.5", "latency_p50_ms": 3501.186966896057, "latency_p95_ms": 16190.529251098631, "model_id": "haiku-4-5", "scored_episodes": 40, "success_rate": 0.275, "tier": "frontier", "unscored_episodes": 0}, {"accuracy": 0.725, "cost_per_run_usd": 0.9939045125, "label": "Claude Opus 4.8", "latency_p50_ms": 7994.603753089905, "latency_p95_ms": 27019.73224878311, "model_id": "opus-4-8", "scored_episodes": 40, "success_rate": 0.725, "tier": "frontier", "unscored_episodes": 0}, {"accuracy": 0.8, "cost_per_run_usd": 1.2456853875, "label": "Claude Opus 5", "latency_p50_ms": 8955.561876296997, "latency_p95_ms": 186715.23189544678, "model_id": "opus-5", "scored_episodes": 40, "success_rate": 0.8, "tier": "frontier", "unscored_episodes": 0}, {"accuracy": 0.7, "cost_per_run_usd": 0.382564785, "label": "Kimi K3", "latency_p50_ms": 10690.230131149292, "latency_p95_ms": 211334.8115682602, "model_id": "kimi-k3", "scored_episodes": 40, "success_rate": 0.7, "tier": "frontier", "unscored_episodes": 0}, {"accuracy": 0.7, "cost_per_run_usd": 0.3239259375, "label": "GPT-5.6 Sol", "latency_p50_ms": 9204.678058624268, "latency_p95_ms": 38790.08412361145, "model_id": "gpt-5.6-sol", "scored_episodes": 40, "success_rate": 0.7, "tier": "frontier", "unscored_episodes": 0}, {"accuracy": 0.675, "cost_per_run_usd": 0.42147781250000005, "label": "GPT-5.6 Terra", "latency_p50_ms": 5936.44380569458, "latency_p95_ms": 21307.505321502686, "model_id": "gpt-5.6-terra", "scored_episodes": 40, "success_rate": 0.675, "tier": "frontier", "unscored_episodes": 0}, {"accuracy": 0.525, "cost_per_run_usd": 0.18812328, "label": "GPT-5.6 Luna", "latency_p50_ms": 4383.163332939148, "latency_p95_ms": 14684.400224685669, "model_id": "gpt-5.6-luna", "scored_episodes": 40, "success_rate": 0.525, "tier": "frontier", "unscored_episodes": 0}, {"accuracy": 0.1, "cost_per_run_usd": 0.1650043975, "label": "Qwen3.5 9B", "latency_p50_ms": 10040.907859802246, "latency_p95_ms": 70584.44719314575, "model_id": "qwen3.5-9b", "scored_episodes": 40, "success_rate": 0.1, "tier": "open", "unscored_episodes": 0}, {"accuracy": 0.55, "cost_per_run_usd": 0.09000625125, "label": "Qwen3.6 27B", "latency_p50_ms": 17867.260694503784, "latency_p95_ms": 145927.64670848846, "model_id": "qwen3.6-27b", "scored_episodes": 40, "success_rate": 0.55, "tier": "open", "unscored_episodes": 0}], "cost_assumptions": "Costs are measured candidate-side per eval episode at the pool's per-token prices (single-shot; provider prompt-cache effects on multi-turn traffic not yet modeled).", "endpoint_id": "", "generated_at": "2026-07-29T23:39:47.482366+00:00", "headline": {"accuracy": 0.8, "baseline_accuracy": 0.775, "baseline_cost_per_run_usd": 2.01013895, "baseline_latency_p50_ms": 7582.324504852295, "baseline_latency_p95_ms": 120642.84871816635, "cost_per_run_usd": 0.9461717025, "latency_p50_ms": 6142.0698165893555, "latency_p95_ms": 90148.12369346619, "scenarios_compared": 20, "scenarios_excluded": 0}, "model_mix": [{"model_id": "sonnet-5", "share": 1.0}], "scenario_count": 20, "scenario_ids": ["build-pov-ray", "constraints-scheduling", "distribution-search", "dna-assembly", "fix-ocaml-gc", "gcode-to-text", "kv-store-grpc", "make-mips-interpreter", "merge-diff-arc-agi-task", "nginx-request-logging", "path-tracing-reverse", "polyglot-c-py", "pytorch-model-cli", "pytorch-model-recovery", "raman-fitting", "reshard-c4-data", "schemelike-metacircular-eval", "sparql-university", "winning-avg-corewars", "write-compressor"], "scenario_label": "on the 20 pinned Terminal-Bench 2.0 tasks (real benchmark episodes, 2 per task; quality delta +2.5pt unresolved at this sample size; gpt-5.6 family measured with reasoning off, the only tool-calling configuration the serving path reaches)"}$tb2_report$::jsonb)
)
-- END measured bench reports.
insert into public.endpoints (id, org_id, world_model_id, name, status, policy, report, is_catalog_default)
select seeded.id, seeded.org_id, seeded.world_model_id, seeded.name, 'ready',
  default_policy.policy,
  -- Stamp the endpoint's own id into its benchmark's report; a declared clone
  -- additionally wears the default's identity (cloned_from_default), exactly
  -- what the one-click add writes.
  case when seeded.clone_of is not null then
    jsonb_set(
      jsonb_set(bench_reports.report, '{endpoint_id}', to_jsonb(seeded.id::text)),
      '{cloned_from_default}', to_jsonb(seeded.clone_of)
    )
  else
    jsonb_set(bench_reports.report, '{endpoint_id}', to_jsonb(seeded.id::text))
  end,
  seeded.is_default
from default_policy,
  (values
    -- The operator workspace starts with ONE attached model: the coding
    -- default as a declared clone (the product owner, 2026-07-31). The other two defaults
    -- stay addable cards, and onboarding redirects away because a model
    -- already exists.
    (
      '7e1e0000-0000-4000-8000-000000000001'::uuid,
      '00000000-0000-0000-0000-000000000001'::uuid,
      null::uuid,
      'coding',
      'swe-bench',
      false,
      'coding'
    ),
    -- Flagship: the tau-bench world model as a ready endpoint in demo-examples.
    (
      '5e1f0000-0000-4000-8000-000000000003'::uuid,
      '00000000-0000-0000-0000-000000000002'::uuid,
      'b5edaef1-2acd-5dd3-a0fb-0f012cda0316'::uuid,
      'customer-support',
      'tau-bench',
      false,
      null
    ),
    -- The published defaults: one ready endpoint per default, living in the
    -- default-models workspace (the product owner, 2026-07-30; moved from the operator
    -- org). The door and the member catalog list this workspace's endpoints,
    -- so these three rows ARE the customer-service / terminal / coding trio.
    -- The demo serving log below references all three by id.
    -- D-DEFAULTS: the trio is flagged so every org's workspace list appends
    -- these rows read-only and onboarding can pick the coding flagship.
    (
      '5e1f0000-0000-4000-8000-000000000001'::uuid,
      '00000000-0000-0000-0000-000000000003'::uuid,
      null::uuid,
      'coding',
      'swe-bench',
      true,
      null
    ),
    (
      '5e1f0000-0000-4000-8000-000000000002'::uuid,
      '00000000-0000-0000-0000-000000000003'::uuid,
      null::uuid,
      'terminal-use',
      'terminal-bench-2',
      true,
      null
    ),
    (
      '5e1f0000-0000-4000-8000-000000000004'::uuid,
      '00000000-0000-0000-0000-000000000003'::uuid,
      null::uuid,
      'customer-support',
      'tau-bench',
      true,
      null
    )
  ) as seeded(id, org_id, world_model_id, name, benchmark, is_default, clone_of)
  join bench_reports on bench_reports.benchmark = seeded.benchmark
-- A live org may already carry the same slug under its own id (the one-click
-- add ran before a re-seed); the per-org name is unique, so skip rather than
-- collide - that org already has the model this row would give it.
where not exists (
  select 1 from public.endpoints existing
  where existing.org_id = seeded.org_id
    and existing.name = seeded.name
    and existing.id <> seeded.id
)
on conflict (id) do update set org_id = excluded.org_id, is_catalog_default = excluded.is_catalog_default;

-- BEGIN serving requests (aux-telemetry v2). Demo serving log for the
-- default-models workspace (00000000-...-0003): the Telemetry page, each
-- model page's Telemetry tab, and the Usage timeseries need rows to render
-- locally until the serving path writes real ones. Local stacks only: hosted
-- deploys run migrations and use the reviewed frozen-fixture lane, never this file.
-- The CODING default (swe-bench) is the workspace starter members clone, so
-- it carries the comprehensive log (360 rows) and its routed-model mix
-- mirrors the coding report's blend (DeepSeek V4 Pro ~48%, Claude Fable 5
-- ~27%, Claude Opus 4.8 ~25%); terminal-bench-2 and tau-bench carry 90
-- benchmark-flavored rows each so every default renders. The operator
-- workspace additionally gets its own coding model (seeded below) with the
-- same 360-row treatment, so the admin's first signed-in /telemetry and the
-- model's Telemetry tab read live without a workspace switch. Rows are
-- field-complete against D-SERVING-LOG: the operator-only routing audit
-- (model / provider_model / cluster / routing_reason / leg) is populated,
-- cached tokens appear on ~40% of rows, ~6% are errors with rotating
-- upstream messages, and bodies are OpenAI-shaped per cluster.
-- Ids are deterministic (uuid v4-shaped from a counter); timestamps are
-- relative to now() and re-seeding refreshes the whole row (`on conflict do
-- update`), so a long-lived local stack keeps a live-looking window. Each
-- endpoint clusters in the last 24 hours and 7 days with a ~4-week tail so
-- every window renders.
-- Every row is PRICED (the product owner, 2026-07-31, superseding the earlier unpriced
-- ruling): cost is computed from the routed model's verified list prices for
-- exactly this row's tokens, what real metering would have recorded, so
-- Usage's priced spend, the per-bucket saved_usd, and the model page's
-- Savings (these same tokens at fable-5 rates, the frontier anchor) all
-- resolve instead of reading "no verified price". Nothing is invented: the
-- rates are AGENT_MODEL_CATALOG's published numbers and the tokens are the
-- row's own. The derived spend lands on the org meters via the spend
-- trigger; the standing credits seeded above (c001..c003) keep every seeded
-- workspace far from the zero-balance gate. The conflict update REPRICES
-- rows an older stack seeded (the trigger nets the delta), so re-seeding
-- converges old unpriced demos too.

-- The 48-row v1 block (ids a11e0000-...) is superseded by these rows; v1
-- rows were unpriced, so deleting them moves no spend counter.
delete from public.serving_requests
where id between 'a11e0000-0000-4000-8000-000000000000'
             and 'a11e0000-0000-4000-8000-ffffffffffff';

-- The operator workspace loads in with the CODING model already added: the
-- same shape "Add to workspace" produces (the catalog default's policy and
-- report under a workspace-owned row), so a fresh local stack's first
-- signed-in screen is a workspace with a model whose Telemetry tab and
-- /telemetry page read live (rows below, n > 540). Guarded on the
-- (org, name) slot: a stack where someone already added or created the
-- coding model keeps their row untouched, and the telemetry rows attach to
-- whichever row owns the slot.
insert into public.endpoints (id, org_id, world_model_id, name, status, policy, report)
select
  'ade00000-0000-4000-8000-000000000001'::uuid,
  '00000000-0000-0000-0000-000000000001'::uuid,
  null,
  name,
  status,
  policy,
  -- The declared-clone contract the one-click add writes: the report is the
  -- default's, re-stamped with this row's own id and the clone marker that
  -- keeps the model's default identity through renames.
  jsonb_set(
    jsonb_set(report, '{endpoint_id}', to_jsonb('ade00000-0000-4000-8000-000000000001'::text)),
    '{cloned_from_default}', to_jsonb('coding'::text)
  )
from public.endpoints
where id = '5e1f0000-0000-4000-8000-000000000001'
  and not exists (
    select 1 from public.endpoints
    where org_id = '00000000-0000-0000-0000-000000000001' and name = 'coding'
  )
on conflict (id) do nothing;

insert into public.serving_requests (
  id,
  org_id,
  endpoint_id,
  endpoint_label,
  model,
  provider_model,
  cluster_id,
  cluster_label,
  routing_reason,
  leg,
  byok,
  input_tokens,
  output_tokens,
  cached_tokens,
  cost_usd,
  latency_ms,
  ttfb_ms,
  status,
  error_message,
  request,
  response,
  created_at
)
with shaped as (
  select
    n,
    -- n 1..360 = the catalog coding default; 361..450 terminal; 451..540
    -- tau; 541..900 = the operator workspace's own coding model (same
    -- content generators, its endpoint seeded just above).
    case when n <= 360 or n > 540 then 'coding'
         when n <= 450 then 'terminal-use'
         else 'customer-support' end as ep_name,
    -- Workspace rows resolve their endpoint by the (org, name) slot, not a
    -- fixed id: on a fresh stack that is the guarded row seeded above, and
    -- on a stack where a member added the coding model themselves it is
    -- THEIR model, so the demo telemetry follows whichever row owns the slot.
    case when n <= 360 then '5e1f0000-0000-4000-8000-000000000001'::uuid
         when n <= 450 then '5e1f0000-0000-4000-8000-000000000002'::uuid
         when n <= 540 then '5e1f0000-0000-4000-8000-000000000004'::uuid
         else (
           select id from public.endpoints
           where org_id = '00000000-0000-0000-0000-000000000001'
             and name = 'coding'
         ) end as ep_id,
    case when n <= 540 then '00000000-0000-0000-0000-000000000003'::uuid
         else '00000000-0000-0000-0000-000000000001'::uuid end as row_org_id,
    -- Per-endpoint counter, so each endpoint gets its own time spread.
    case when n <= 360 then n
         when n <= 450 then n - 360
         when n <= 540 then n - 450
         else n - 540 end as k,
    -- How many of the endpoint's rows land in the last 24h / last 7d.
    case when n <= 360 or n > 540 then 72 else 18 end as day1,
    case when n <= 360 or n > 540 then 220 else 55 end as week1,
    (n % 16 = 0) as is_err,
    (n * 31) % 100 as mix,
    (n * 13) % 4 as ck,
    500 + (n * 997) % 9000 as input_toks
  from generate_series(1, 900) as n
),
detailed as (
  select
    shaped.*,
    -- Errors fail before producing output: no output tokens.
    case when is_err then 0 else 90 + (n * 613) % 2600 end as output_toks,
    case when n % 5 < 2
      then (input_toks * (case n % 5 when 0 then 60 else 35 end)) / 100
      else 0 end as cached_toks,
    -- Routed-model mix per benchmark: coding mirrors the report blend;
    -- terminal skews to Sonnet (routing degenerates there); tau rides the
    -- kNN champion's open-weight pick with the anchor beside it.
    case
      when ep_name = 'coding' then
        case when mix < 48 then 'deepseek-v4-pro'
             when mix < 75 then 'claude-fable-5'
             else 'claude-opus-4-8' end
      when ep_name = 'terminal-use' then
        case when mix < 60 then 'claude-sonnet-5'
             when mix < 85 then 'claude-fable-5'
             else 'claude-opus-4-8' end
      else
        -- kimi-k2.6, not the measured winner glm-5.2: GLM has no
        -- authoritative serving price (its own report excludes it from
        -- serving for exactly that), and every seeded row must price.
        case when mix < 45 then 'kimi-k2.6'
             when mix < 80 then 'claude-opus-4-8'
             else 'claude-fable-5' end
    end as model_name,
    case ep_name
      when 'coding' then
        (array['bug-fix', 'test-repair', 'code-review', 'refactor'])[ck + 1]
      when 'terminal-use' then
        (array['shell-tasks', 'file-edits', 'build-and-test', 'git-operations'])[ck + 1]
      else
        (array['booking-changes', 'refunds', 'order-status', 'policy-questions'])[ck + 1]
    end as cluster_name,
    case ep_name
      when 'coding' then (array[
        'Fix the crash in parser.py when the config has no [tools] section, and add a regression test.',
        'tests/test_auth.py::test_refresh fails after the token change; make the suite green without weakening the assertion.',
        'Review this diff for correctness: fn total(xs) { return xs.reduce((a, b) => a + b, 0) }',
        'Extract the retry logic in http/client.py into a shared helper with exponential backoff and jitter.'
      ])[ck + 1]
      when 'terminal-use' then (array[
        'Find every file over 100MB under /var and compress each with zstd, keeping the originals.',
        'Apply the patch to src/server.py so the retry loop backs off exponentially with jitter.',
        'Run the test suite and fix the failing assertion in tests/test_parser.py without touching fixtures.',
        'Rebase feature/telemetry onto main and resolve the conflict in api/routes.py preserving both hunks.'
      ])[ck + 1]
      else (array[
        'I need to move my flight from Tuesday to Thursday, same fare class if possible.',
        'My last invoice charged twice for the pro plan, can you check what happened?',
        'Where is order #48213? It was supposed to arrive yesterday.',
        'Can I get a refund on a basic economy ticket if I cancel within 24 hours of booking?'
      ])[ck + 1]
    end as user_text,
    case ep_name
      when 'coding' then (array[
        'Fixed: parser.py now defaults to an empty [tools] table and the new regression test covers the missing-section case; suite green (212 passed).',
        'Repaired tests/test_auth.py::test_refresh by freezing the clock around the rotation window; the assertion is unchanged and the suite is green.',
        'The reducer is correct for non-empty arrays and the 0 seed also covers the empty case; no defect found.',
        'Extracted retry_with_backoff into http/util.py with full jitter; both call sites migrated and unit tests added.'
      ])[ck + 1]
      when 'terminal-use' then (array[
        'Compressed 7 files under /var (largest 412MB -> 96MB); originals kept, archives verified with zstd -t.',
        'Patched src/server.py: the retry loop now backs off 2^k * 250ms with full jitter; unit tests pass.',
        'Fixed tests/test_parser.py::test_nested_quotes by handling escaped delimiters; suite green (214 passed).',
        'Rebase complete; resolved api/routes.py keeping both route registrations; history is linear.'
      ])[ck + 1]
      else (array[
        'Your Tuesday 10:05 departure is moved to Thursday 10:20 in the same fare class; confirmation code unchanged.',
        'I found the duplicate charge on the July invoice and flagged it for refund; you will see the credit within 3 business days.',
        'Order #48213 cleared the regional hub this morning and is out for delivery; the carrier now estimates today by 6pm.',
        'Yes: within 24 hours of booking a full refund applies even on basic economy; after that the ticket is non-refundable.'
      ])[ck + 1]
    end as assistant_text
  from shaped
),
-- Each routed model's verified list prices (USD per Mtok), verbatim from
-- AGENT_MODEL_CATALOG. cached_rate is the provider's published cache-READ
-- rate (Anthropic bills 0.1x input); Azure Foundry publishes none for
-- DeepSeek/Kimi, so their cached tokens bill at the full input rate, the
-- platform's own convention, never silently cheaper.
priced as (
  select
    detailed.*,
    case model_name
      when 'deepseek-v4-pro' then 1.74
      when 'kimi-k2.6' then 0.95
      when 'claude-sonnet-5' then 3.00
      when 'claude-opus-4-8' then 5.00
      else 10.00 -- claude-fable-5
    end as in_rate,
    case model_name
      when 'deepseek-v4-pro' then 3.48
      when 'kimi-k2.6' then 4.00
      when 'claude-sonnet-5' then 15.00
      when 'claude-opus-4-8' then 25.00
      else 50.00 -- claude-fable-5
    end as out_rate,
    case model_name
      when 'claude-sonnet-5' then 0.30
      when 'claude-opus-4-8' then 0.50
      when 'claude-fable-5' then 1.00
      else null
    end as cached_rate
  from detailed
)
select
  ('a11e0001-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
  row_org_id,
  ep_id,
  ep_name,
  model_name,
  case
    when model_name in ('deepseek-v4-pro', 'kimi-k2.6') then 'azure/' || model_name
    else 'anthropic/' || model_name
  end,
  'cluster-' || ck::text,
  cluster_name,
  case
    when model_name = 'claude-fable-5' then
      'stat-guard: low-confidence cluster match (z=1.' || (n % 9)::text || '2), escalated to frontier anchor'
    when model_name = 'claude-opus-4-8' then
      'default: endpoint policy pick (served model)'
    when cached_toks > 0 then
      'cache-aware: warm prefix (' || (cached_toks / 1000)::text || 'k cached) kept on ' || model_name
    else
      'knn: cluster ' || cluster_name || ' (d=0.' || (10 + n % 30)::text
        || '), p(win)=0.' || (82 + n % 17)::text || ' -> ' || model_name
  end,
  'serving',
  false,
  input_toks,
  output_toks,
  cached_toks,
  -- Priced at the routed model's list rates for exactly this row's tokens
  -- (the product owner, 2026-07-31): what real metering would have recorded. Error rows
  -- price their consumed input (partial usage keeps its real cost); the
  -- frontier baseline is these same tokens at fable-5 rates, computed by the
  -- API from the token columns, which is what makes Savings resolvable.
  round(
    (
      (
        (input_toks - cached_toks) * in_rate
        + cached_toks * coalesce(cached_rate, in_rate)
        + output_toks * out_rate
      ) / 1e6
    )::numeric,
    6
  ),
  case
    when is_err then 1200 + (n * 211) % 45000
    when model_name in ('claude-fable-5', 'claude-opus-4-8')
      then 1600 + output_toks / 2 + (n * 389) % 2400
    else 300 + output_toks / 2 + (n * 389) % 1200
  end,
  case when is_err and n % 2 = 0 then null else 80 + (n * 127) % 650 end,
  case when is_err then 'error' else 'ok' end,
  case when is_err then (array[
    'upstream provider returned 529 (overloaded); retries exhausted',
    'request exceeded model context window (131072 tokens)',
    'upstream timeout after 60000 ms',
    'provider returned 429 (rate limited); retries exhausted',
    'tool schema rejected by provider: parameters.command missing type'
  ])[(n / 16) % 5 + 1] end,
  jsonb_build_object(
    'model', ep_name,
    'stream', true,
    'temperature', 0,
    'max_tokens', 4096,
    'messages', jsonb_build_array(
      jsonb_build_object('role', 'user', 'content', user_text)
    )
  ),
  case when is_err then null else jsonb_build_object(
    'id', 'cmpl-seed-' || n::text,
    'object', 'chat.completion',
    'model', model_name,
    'choices', jsonb_build_array(
      jsonb_build_object('index', 0, 'finish_reason', 'stop', 'message',
        jsonb_build_object('role', 'assistant', 'content', assistant_text)
      )
    ),
    'usage', jsonb_build_object(
      'prompt_tokens', input_toks,
      'completion_tokens', output_toks,
      'prompt_tokens_details', jsonb_build_object('cached_tokens', cached_toks)
    )
  ) end,
  now() - (
    interval '1 minute'
    * case
        when k <= day1 then (k * 337) % 1440
        when k <= week1 then 1440 + (k * 1237) % (6 * 1440)
        else 10080 + (k * 2707) % (23 * 1440)
      end
  )
from priced
-- The workspace rows exist only while SOME org-workspace coding endpoint
-- owns the slot (seeded or member-added); otherwise they would dangle.
where n <= 540
   or exists (
     select 1 from public.endpoints
     where org_id = '00000000-0000-0000-0000-000000000001' and name = 'coding'
   )
on conflict (id) do update set
  -- Full-row refresh: these rows are wholly seed-owned, so a re-seed (or a
  -- future reshape of this block under the same ids) must converge content,
  -- not just timestamps. cost_usd re-nulls priced rows an older stack wrote
  -- (the spend trigger nets the old cost back out of the org counter);
  -- org_id re-homes demo telemetry seeded before the default-models
  -- workspace move (2026-07-30).
  org_id = excluded.org_id,
  endpoint_id = excluded.endpoint_id,
  endpoint_label = excluded.endpoint_label,
  model = excluded.model,
  provider_model = excluded.provider_model,
  cluster_id = excluded.cluster_id,
  cluster_label = excluded.cluster_label,
  routing_reason = excluded.routing_reason,
  leg = excluded.leg,
  byok = excluded.byok,
  input_tokens = excluded.input_tokens,
  output_tokens = excluded.output_tokens,
  cached_tokens = excluded.cached_tokens,
  cost_usd = excluded.cost_usd,
  latency_ms = excluded.latency_ms,
  ttfb_ms = excluded.ttfb_ms,
  status = excluded.status,
  error_message = excluded.error_message,
  request = excluded.request,
  response = excluded.response,
  created_at = excluded.created_at;
-- END serving requests (aux-telemetry v2).

-- Curation copy for the published default models (the product owner, 2026-07-30). One row
-- per default endpoint in the default-models workspace, keyed by slug =
-- endpoint name: display title, benchmark, description, tags, and the two
-- catalog joins. NUMBERS DO NOT LIVE HERE: headline is retired (seeded null,
-- never read) because every figure shown for a default is derived from its
-- workspace endpoint's installed improvement report. A workspace endpoint
-- with no curation row still publishes, under its own name.
insert into public.default_models (
  id, slug, title, benchmark, description, tags,
  world_model_slug, catalog_entry_name, headline, display_order
) values
  (
    '00000000-0000-0000-0000-000000000d01',
    'customer-support',
    'customer-support',
    'τ²-bench',
    'Multi-turn customer-service tool use: look up a user, book or modify an order, and hold to the domain''s policy across the conversation.',
    '["tool-calls", "customer-service", "multi-turn"]'::jsonb,
    'tau-bench',
    'customer-support',
    null,
    1
  ),
  (
    '00000000-0000-0000-0000-000000000d02',
    'terminal-use',
    'terminal-use',
    'Terminal-Bench 2.0',
    'Command-line work in a container: inspect a filesystem, run shell commands, and read their output to drive a task to completion.',
    '["terminal", "shell", "containers"]'::jsonb,
    null,
    'terminal',
    null,
    2
  ),
  (
    '00000000-0000-0000-0000-000000000d03',
    'coding',
    'coding',
    'SWE-bench',
    'Repository-level bug fixing: read the failing test, navigate an unfamiliar codebase, and produce a patch that resolves the issue.',
    '["code", "patching", "repositories"]'::jsonb,
    null,
    'docker-env',
    null,
    3
  )
on conflict (id) do update set
  slug = excluded.slug,
  title = excluded.title,
  benchmark = excluded.benchmark,
  description = excluded.description,
  tags = excluded.tags,
  world_model_slug = excluded.world_model_slug,
  catalog_entry_name = excluded.catalog_entry_name,
  headline = excluded.headline,
  display_order = excluded.display_order;

-- BEGIN demo Projects. The Projects surfaces (grid, detail tabs, playground
-- picker, serving telemetry, org usage) need rows to render on a fresh stack,
-- so the demo-examples workspace carries four projects frozen at the four
-- lifecycle moments the product distinguishes:
--   tau-bench-router     completed, activated, PAUSED serving (see below)
--   swe-bench-triage     mid-build, its optimization attempt queued (see the
--                        drain invariant on the jobs insert below)
--   terminal-bench-agent failed, with the retryable public error the UI maps
--   support-copilot      configured but never built
-- Same rules as every demo block above: stable ids, create-if-missing (a
-- re-seed never regresses rows the product has since updated), scoped to
-- demo-examples. The completed project is seeded PAUSED on purpose: pausing
-- makes admission refuse chats with the clean allowlisted 'model_paused'
-- error BEFORE the runtime would try to load a policy bank, so the serving
-- lane demos its refusal path instead of 500ing on the artifact bytes no
-- seed can fabricate. Unpausing it against a stack that never ran a real
-- optimization will surface a runtime load error on the first chat - that is
-- the honest behavior, not a seed defect. Storage objects behind the trace
-- sources and stage bundle are likewise metadata-only: browsing renders,
-- re-downloading those exact objects does not.
insert into public.optimizer_projects (id, org_id, slug, display_name, description, created_at)
values
  (
    'de300000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000002',
    'tau-bench-router',
    'Tau Bench Router',
    'Routes airline and retail support conversations from the tau-bench corpus across a cost-tiered candidate pool.',
    now() - interval '21 days'
  ),
  (
    'de300000-0000-4000-8000-000000000002',
    '00000000-0000-0000-0000-000000000002',
    'swe-bench-triage',
    'SWE-bench Triage',
    'Triages repository bug reports before patch generation; its optimization attempt is queued for the router fit.',
    now() - interval '6 days'
  ),
  (
    'de300000-0000-4000-8000-000000000003',
    '00000000-0000-0000-0000-000000000002',
    'terminal-bench-agent',
    'Terminal Bench Agent',
    'Container shell-work traces from terminal-bench; the last build attempt failed at the world-model stage.',
    now() - interval '10 days'
  ),
  (
    'de300000-0000-4000-8000-000000000004',
    '00000000-0000-0000-0000-000000000002',
    'support-copilot',
    'Support Copilot',
    'Imported Langfuse conversations for a support copilot; traces and models are configured, no build has run.',
    now() - interval '2 days'
  )
on conflict do nothing;

-- Link the demo projects to their matching seeded demo simulations, so the
-- Dataset, Scenarios, and fidelity reads (which all go through
-- optimizer_projects.world_model_id) render from the simulations' committed
-- fixture data. Fill-if-null only: a member's later re-link or unlink is
-- never overwritten by a re-seed. swe-bench-triage and support-copilot stay
-- unlinked on purpose — no seeded world model matches them (swe-bench exists
-- only as an endpoint report theme), and unlinked is itself a product state
-- the tabs must render honestly.
update public.optimizer_projects
set world_model_id = links.world_model_id
from (
  values
    ('de300000-0000-4000-8000-000000000001'::uuid, 'b5edaef1-2acd-5dd3-a0fb-0f012cda0316'::uuid),
    ('de300000-0000-4000-8000-000000000003'::uuid, 'fa7c063b-7fd8-54c5-89e4-47649b101f67'::uuid)
) as links(project_id, world_model_id)
where optimizer_projects.id = links.project_id
  and optimizer_projects.world_model_id is null;

-- One acquired trace source per project, current, with its (metadata-only)
-- storage object. Sizes/counts echo the committed fixture corpora so the
-- numbers read plausibly next to the legacy demo world models.
insert into public.optimizer_project_trace_sources (
  id, project_id, org_id, source_kind, source_label, sha256,
  byte_size, content_type, record_count_estimate, acquired_at
)
values
  (
    'de300000-0000-4000-8000-000000000101',
    'de300000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000002',
    'otel-genai', 'tau-bench.otel.jsonl',
    encode(sha256(convert_to('demo-project-source-tau', 'UTF8')), 'hex'),
    231424, 'application/x-ndjson', 12, now() - interval '21 days'
  ),
  (
    'de300000-0000-4000-8000-000000000102',
    'de300000-0000-4000-8000-000000000002',
    '00000000-0000-0000-0000-000000000002',
    'chat-json', 'swe-bench-triage-conversations.json',
    encode(sha256(convert_to('demo-project-source-swe', 'UTF8')), 'hex'),
    482304, 'application/json', 38, now() - interval '6 days'
  ),
  (
    'de300000-0000-4000-8000-000000000103',
    'de300000-0000-4000-8000-000000000003',
    '00000000-0000-0000-0000-000000000002',
    'otel-genai', 'terminal-tasks.otel.jsonl',
    encode(sha256(convert_to('demo-project-source-terminal', 'UTF8')), 'hex'),
    173568, 'application/x-ndjson', 9, now() - interval '10 days'
  ),
  (
    'de300000-0000-4000-8000-000000000104',
    'de300000-0000-4000-8000-000000000004',
    '00000000-0000-0000-0000-000000000002',
    'langfuse', 'support-copilot-langfuse-export.json',
    encode(sha256(convert_to('demo-project-source-support', 'UTF8')), 'hex'),
    96256, 'application/json', 24, now() - interval '2 days'
  )
on conflict do nothing;

insert into public.optimizer_project_trace_source_objects (source_id, storage_bucket, storage_path)
values
  ('de300000-0000-4000-8000-000000000101', 'explabs-artifacts', 'projects/de300000-0000-4000-8000-000000000001/sources/tau-bench.otel.jsonl'),
  ('de300000-0000-4000-8000-000000000102', 'explabs-artifacts', 'projects/de300000-0000-4000-8000-000000000002/sources/swe-bench-triage-conversations.json'),
  ('de300000-0000-4000-8000-000000000103', 'explabs-artifacts', 'projects/de300000-0000-4000-8000-000000000003/sources/terminal-tasks.otel.jsonl'),
  ('de300000-0000-4000-8000-000000000104', 'explabs-artifacts', 'projects/de300000-0000-4000-8000-000000000004/sources/support-copilot-langfuse-export.json')
on conflict do nothing;

insert into public.optimizer_project_trace_current_sources (project_id, org_id, source_id)
values
  ('de300000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000002', 'de300000-0000-4000-8000-000000000101'),
  ('de300000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000002', 'de300000-0000-4000-8000-000000000102'),
  ('de300000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000002', 'de300000-0000-4000-8000-000000000103'),
  ('de300000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000002', 'de300000-0000-4000-8000-000000000104')
on conflict do nothing;

-- Setups across the widened provider surface: platform-funded openai,
-- anthropic, and gemini bindings plus one local (customer OpenAI-compatible
-- server) embedder carrying the base_url/metadata columns the widening
-- migration added, so the Config tab demos every binding shape that needs no
-- stored credential. BYOK bindings are deliberately absent: they would need a
-- provider_connections row, and a connection without a live Vault secret is
-- a broken Settings surface, not a demo.
insert into public.optimizer_project_setups (
  id, project_id, version, system_kind, system_prompt,
  maximum_model_calls, run_budget_usd, max_parallel_requests
)
values
  (
    'de300000-0000-4000-8000-000000000201',
    'de300000-0000-4000-8000-000000000001',
    3, 'builtin_chat',
    'You are a customer support agent for an airline and retail marketplace. Resolve the request within policy; escalate when policy requires a human.',
    8, 25, 4
  ),
  (
    'de300000-0000-4000-8000-000000000202',
    'de300000-0000-4000-8000-000000000002',
    1, 'builtin_chat',
    'Triage the incoming repository bug report: identify the failing surface, likely root cause file, and severity.',
    6, 15, 4
  ),
  (
    'de300000-0000-4000-8000-000000000203',
    'de300000-0000-4000-8000-000000000003',
    2, 'builtin_chat',
    'Operate a container shell to complete the requested task. Inspect before you mutate; verify after you act.',
    10, 20, 2
  ),
  (
    'de300000-0000-4000-8000-000000000204',
    'de300000-0000-4000-8000-000000000004',
    1, 'builtin_chat',
    'Answer product support questions from the connected knowledge base tone guide. Never invent order state.',
    8, 10, 4
  )
on conflict do nothing;

insert into public.optimizer_project_setup_models (
  id, setup_id, role, alias, model, provider, credential_source,
  connection_alias, provider_connection_id, base_url, model_metadata
)
values
  -- tau-bench-router: the completed project exercises the widest mix.
  ('de300000-0000-4000-8000-000000000211', 'de300000-0000-4000-8000-000000000201', 'world_model', 'world', 'gpt-5.6-terra', 'openai', 'platform', null, null, null, null),
  ('de300000-0000-4000-8000-000000000212', 'de300000-0000-4000-8000-000000000201', 'judge', 'judge', 'claude-opus-4-8', 'anthropic', 'platform', null, null, null, null),
  ('de300000-0000-4000-8000-000000000213', 'de300000-0000-4000-8000-000000000201', 'embedder', 'embed', 'qwen3-embedding-4b', 'local', 'byok', null, null, 'http://models.internal:8000/v1', '{"supports_embeddings": true}'::jsonb),
  ('de300000-0000-4000-8000-000000000214', 'de300000-0000-4000-8000-000000000201', 'baseline', 'baseline', 'gpt-5.6-terra', 'openai', 'platform', null, null, null, null),
  ('de300000-0000-4000-8000-000000000215', 'de300000-0000-4000-8000-000000000201', 'candidate', 'candidate-frontier', 'gpt-5.6-sol', 'openai', 'platform', null, null, null, null),
  ('de300000-0000-4000-8000-000000000216', 'de300000-0000-4000-8000-000000000201', 'candidate', 'candidate-fast', 'claude-haiku-4-5', 'anthropic', 'platform', null, null, null, null),
  ('de300000-0000-4000-8000-000000000217', 'de300000-0000-4000-8000-000000000201', 'candidate', 'candidate-flash', 'gemini-2.5-flash', 'gemini', 'platform', null, null, null, null),
  -- swe-bench-triage: a lean two-candidate pool mid-build.
  ('de300000-0000-4000-8000-000000000221', 'de300000-0000-4000-8000-000000000202', 'world_model', 'world', 'gpt-5.6-terra', 'openai', 'platform', null, null, null, null),
  ('de300000-0000-4000-8000-000000000222', 'de300000-0000-4000-8000-000000000202', 'judge', 'judge', 'claude-sonnet-5', 'anthropic', 'platform', null, null, null, null),
  ('de300000-0000-4000-8000-000000000223', 'de300000-0000-4000-8000-000000000202', 'baseline', 'baseline', 'claude-fable-5', 'anthropic', 'platform', null, null, null, null),
  ('de300000-0000-4000-8000-000000000224', 'de300000-0000-4000-8000-000000000202', 'candidate', 'candidate-frontier', 'claude-fable-5', 'anthropic', 'platform', null, null, null, null),
  ('de300000-0000-4000-8000-000000000225', 'de300000-0000-4000-8000-000000000202', 'candidate', 'candidate-fast', 'gpt-5.6-luna', 'openai', 'platform', null, null, null, null),
  -- terminal-bench-agent: the failed attempt's pinned pool.
  ('de300000-0000-4000-8000-000000000231', 'de300000-0000-4000-8000-000000000203', 'world_model', 'world', 'gpt-5.6-terra', 'openai', 'platform', null, null, null, null),
  ('de300000-0000-4000-8000-000000000232', 'de300000-0000-4000-8000-000000000203', 'judge', 'judge', 'gpt-5.6-terra', 'openai', 'platform', null, null, null, null),
  ('de300000-0000-4000-8000-000000000233', 'de300000-0000-4000-8000-000000000203', 'baseline', 'baseline', 'claude-sonnet-4-6', 'anthropic', 'platform', null, null, null, null),
  ('de300000-0000-4000-8000-000000000234', 'de300000-0000-4000-8000-000000000203', 'candidate', 'candidate-frontier', 'claude-opus-5', 'anthropic', 'platform', null, null, null, null),
  ('de300000-0000-4000-8000-000000000235', 'de300000-0000-4000-8000-000000000203', 'candidate', 'candidate-fast', 'gemini-2.5-flash', 'gemini', 'platform', null, null, null, null),
  -- support-copilot: configured, never built.
  ('de300000-0000-4000-8000-000000000241', 'de300000-0000-4000-8000-000000000204', 'world_model', 'world', 'gpt-5.6-terra', 'openai', 'platform', null, null, null, null),
  ('de300000-0000-4000-8000-000000000242', 'de300000-0000-4000-8000-000000000204', 'judge', 'judge', 'claude-fable-5', 'anthropic', 'platform', null, null, null, null),
  ('de300000-0000-4000-8000-000000000243', 'de300000-0000-4000-8000-000000000204', 'baseline', 'baseline', 'gemini-2.5-pro', 'gemini', 'platform', null, null, null, null),
  ('de300000-0000-4000-8000-000000000244', 'de300000-0000-4000-8000-000000000204', 'candidate', 'candidate-frontier', 'gemini-2.5-pro', 'gemini', 'platform', null, null, null, null),
  ('de300000-0000-4000-8000-000000000245', 'de300000-0000-4000-8000-000000000204', 'candidate', 'candidate-fast', 'gemini-2.5-flash', 'gemini', 'platform', null, null, null, null)
on conflict do nothing;

-- The three attempts. INVARIANT: seeded rows must never look live to a
-- release drain, which gates a deploy on accepting_workers=0 AND
-- active_jobs=0, where active means status in claimed/running. So this file
-- seeds no optimizer_project_workers row and no claimed/running job — a
-- seeded "live" claim would deadlock a deploy against work nothing will ever
-- finish. The mid-build story
-- is therefore a QUEUED optimization pinned behind a fixed far-future
-- available_at: real workers never claim it (the claim RPC only takes jobs
-- whose available_at has passed), the drain's queued count merely observes
-- it, and the tile reads the honest "Queued". Terminal jobs carry no claim
-- (the claim-shape constraint makes the states exact). The queued job still
-- holds its project's current slot, so the project correctly refuses a
-- second concurrent build; cancel it from the UI to free the slot.
insert into public.optimizer_project_jobs (
  id, project_id, status, operation, domain_stage, stage, progress, spend_usd,
  public_error_code, public_error_message, public_error_retryable, public_error_action,
  worker_id, claim_token, claim_generation, attempt_count,
  heartbeat_at, lease_expires_at, available_at, started_at, completed_at, created_at, updated_at
)
values
  (
    'de300000-0000-4000-8000-000000000301',
    'de300000-0000-4000-8000-000000000001',
    'completed', 'optimization', 'ready', 'wmo_workflow',
    '{"message":"Optimization complete: router fitted, measured on held-out traffic, and installed"}'::jsonb,
    18.734210, null, null, null, null,
    null, null, 2, 1, null, null,
    now() - interval '14 days',
    now() - interval '14 days', now() - interval '13 days 4 hours',
    now() - interval '14 days', now() - interval '13 days 4 hours'
  ),
  (
    'de300000-0000-4000-8000-000000000302',
    'de300000-0000-4000-8000-000000000002',
    'queued', 'optimization', 'optimizing_router', 'wmo_workflow',
    '{"message":"Optimization queued: 412 scored rollouts staged for the router fit"}'::jsonb,
    6.204118, null, null, null, null,
    null, null, 2, 1,
    null, null,
    timestamptz '2126-01-01 00:00:00+00', null, null,
    now() - interval '3 hours 10 minutes', now() - interval '3 hours'
  ),
  (
    'de300000-0000-4000-8000-000000000303',
    'de300000-0000-4000-8000-000000000003',
    'failed', 'optimization', 'building_world_model', 'wmo_workflow',
    '{"message":"World-model build calls were refused by the provider"}'::jsonb,
    2.417804,
    'provider_failed',
    'The provider refused the world-model build calls with sustained rate limits. No charge was made for refused calls; retry when provider capacity recovers.',
    true, 'retry',
    null, null, 2, 2, null, null,
    now() - interval '3 days 3 hours',
    now() - interval '3 days 2 hours', now() - interval '3 days',
    now() - interval '3 days 3 hours', now() - interval '3 days'
  )
on conflict do nothing;

-- Each project's authoritative current pointer; a later real enqueue replaces
-- these rows itself, and the conflict target keeps a re-seed from clobbering it.
insert into public.optimizer_project_current_jobs (project_id, job_id)
values
  ('de300000-0000-4000-8000-000000000001', 'de300000-0000-4000-8000-000000000301'),
  ('de300000-0000-4000-8000-000000000002', 'de300000-0000-4000-8000-000000000302'),
  ('de300000-0000-4000-8000-000000000003', 'de300000-0000-4000-8000-000000000303')
on conflict (project_id) do nothing;

-- The provider-free preparation the completed attempt pinned. Paid inputs may
-- only reference a prepared source (the pin trigger enforces it), so the
-- completed project carries its preparation attempt too: job, frozen inputs,
-- recorded output, and the current-preparation pointer.
insert into public.optimizer_project_jobs (
  id, project_id, status, operation, domain_stage, stage, progress, spend_usd,
  claim_generation, attempt_count, started_at, completed_at, created_at, updated_at
)
values (
  'de300000-0000-4000-8000-000000000300',
  'de300000-0000-4000-8000-000000000001',
  'completed', 'preparation', null, 'preparing_traces',
  '{"message":"Traces prepared: 12 conversations mapped into the provider-free bundle"}'::jsonb,
  0, 2, 1,
  now() - interval '14 days 2 hours', now() - interval '14 days 1 hour',
  now() - interval '14 days 2 hours', now() - interval '14 days 1 hour'
)
on conflict do nothing;

insert into public.optimizer_project_preparation_inputs (
  job_id, project_id, org_id, source_id, source_kind, source_label,
  source_sha256, source_byte_size, source_content_type,
  source_storage_bucket, source_storage_path,
  wmo_revision, wmo_project_id, wmo_source_id
)
values (
  'de300000-0000-4000-8000-000000000300',
  'de300000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000002',
  'de300000-0000-4000-8000-000000000101',
  'otel-genai', 'tau-bench.otel.jsonl',
  encode(sha256(convert_to('demo-project-source-tau', 'UTF8')), 'hex'),
  231424, 'application/x-ndjson',
  'explabs-artifacts',
  'projects/de300000-0000-4000-8000-000000000001/sources/tau-bench.otel.jsonl',
  repeat('d', 40),
  'platform-project-de3000000000400080000000000000001',
  'platform-source-de3000000000400080000000000000101'
)
on conflict do nothing;

insert into public.optimizer_project_preparation_outputs (
  job_id, project_id, source_id, source_sha256,
  bundle_storage_bucket, bundle_storage_path, bundle_sha256, bundle_size_bytes
)
values (
  'de300000-0000-4000-8000-000000000300',
  'de300000-0000-4000-8000-000000000001',
  'de300000-0000-4000-8000-000000000101',
  encode(sha256(convert_to('demo-project-source-tau', 'UTF8')), 'hex'),
  'explabs-artifacts',
  'projects/de300000-0000-4000-8000-000000000001/attempts/0300/prepared.wmo.zip',
  encode(sha256(convert_to('demo-project-prepared-bundle-tau', 'UTF8')), 'hex'),
  524288
)
on conflict do nothing;

insert into public.optimizer_project_preparations (
  project_id, job_id, source_id, source_sha256,
  bundle_storage_bucket, bundle_storage_path, bundle_sha256, bundle_size_bytes,
  generation, prepared_at
)
values (
  'de300000-0000-4000-8000-000000000001',
  'de300000-0000-4000-8000-000000000300',
  'de300000-0000-4000-8000-000000000101',
  encode(sha256(convert_to('demo-project-source-tau', 'UTF8')), 'hex'),
  'explabs-artifacts',
  'projects/de300000-0000-4000-8000-000000000001/attempts/0300/prepared.wmo.zip',
  encode(sha256(convert_to('demo-project-prepared-bundle-tau', 'UTF8')), 'hex'),
  524288, 1, now() - interval '14 days 1 hour'
)
on conflict do nothing;

-- The completed attempt's pinned inputs. The schema_version-2 snapshot is
-- computed here with the enqueue RPC's own expressions over the seeded setup
-- rows (including the deterministic internal_alias/internal_connection_alias
-- hashes), so its DATA always agrees with the seeded bindings. The CTE below
-- is still a copy of the snapshot builder in enqueue_optimizer_project_wmo_job
-- (and its replace twin): if that builder's shape moves — a schema_version
-- bump, a new hash term — this block must move with it, or the seeded
-- snapshot silently stops parsing as a PinnedProjectSetup. Serving admission
-- requires this row and the completing_report stage commit below before it
-- will admit (or cleanly refuse) a chat.
with pinned_models as (
  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'role', models.role,
      'public_alias', models.alias,
      'internal_alias',
        'model-' || pg_catalog.replace(models.role, '_', '-') || '-' ||
        pg_catalog.substr(
          pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(
                models.role || pg_catalog.chr(31) || models.alias || pg_catalog.chr(31) ||
                models.provider || pg_catalog.chr(31) || models.model || pg_catalog.chr(31) ||
                models.credential_source || pg_catalog.chr(31) ||
                coalesce(models.connection_alias, ''),
                'UTF8'
              )
            ),
            'hex'
          ),
          1,
          24
        ),
      'model', models.model,
      'provider', models.provider,
      'base_url', models.base_url,
      'metadata', models.model_metadata,
      'credential_source', models.credential_source,
      'connection_alias', models.connection_alias,
      'internal_connection_alias',
        'connection-' || models.credential_source || '-' || models.provider || '-' ||
        pg_catalog.substr(
          pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(
                models.provider || pg_catalog.chr(31) || models.credential_source ||
                pg_catalog.chr(31) || coalesce(models.connection_alias, '') ||
                pg_catalog.chr(31) || coalesce(models.base_url, ''),
                'UTF8'
              )
            ),
            'hex'
          ),
          1,
          24
        ),
      'connection_config', (
        select pc.config
        from public.provider_connections as pc
        where pc.id = models.provider_connection_id
      )
    ) order by
      case models.role
        when 'world_model' then 1
        when 'judge' then 2
        when 'embedder' then 3
        when 'baseline' then 4
        else 5
      end,
      models.alias
  ) as models
  from public.optimizer_project_setup_models as models
  where models.setup_id = 'de300000-0000-4000-8000-000000000201'
),
pinned_snapshot as (
  select pg_catalog.jsonb_build_object(
    'schema_version', 2,
    'setup_version', setups.version,
    'system', pg_catalog.jsonb_build_object(
      'kind', setups.system_kind,
      'system_prompt', setups.system_prompt,
      'maximum_model_calls', setups.maximum_model_calls
    ),
    'models', pinned_models.models,
    'run_budget_usd', setups.run_budget_usd::text,
    'execution', pg_catalog.jsonb_build_object(
      'max_parallel_requests', setups.max_parallel_requests
    )
  ) as snapshot
  from public.optimizer_project_setups as setups, pinned_models
  where setups.id = 'de300000-0000-4000-8000-000000000201'
)
insert into public.optimizer_project_job_inputs (
  job_id, project_id, org_id, source_id, source_kind, source_label,
  source_sha256, source_byte_size, source_content_type,
  source_storage_bucket, source_storage_path,
  setup_id, setup_version, setup_snapshot, setup_sha256, ceiling_usd,
  wmo_revision, wmo_project_id, wmo_source_id, wmo_attempt_id,
  authority_sha256, attempt_created_at
)
select
  'de300000-0000-4000-8000-000000000301',
  'de300000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000002',
  'de300000-0000-4000-8000-000000000101',
  'otel-genai', 'tau-bench.otel.jsonl',
  encode(sha256(convert_to('demo-project-source-tau', 'UTF8')), 'hex'),
  231424, 'application/x-ndjson',
  'explabs-artifacts',
  'projects/de300000-0000-4000-8000-000000000001/sources/tau-bench.otel.jsonl',
  'de300000-0000-4000-8000-000000000201', 3,
  pinned_snapshot.snapshot,
  encode(sha256(convert_to(pinned_snapshot.snapshot::text, 'UTF8')), 'hex'),
  25.000000,
  repeat('d', 40),
  'platform-project-de3000000000400080000000000000001',
  'platform-source-de3000000000400080000000000000101',
  'platform-attempt-de3000000000400080000000000000301',
  encode(sha256(convert_to('demo-project-authority-tau-0301', 'UTF8')), 'hex'),
  now() - interval '14 days'
from pinned_snapshot
on conflict do nothing;

-- The frozen completing_report commit that proves the attempt produced an
-- installable policy. Bundle and catalog identities are metadata-only, like
-- every other demo storage path in this file.
insert into public.optimizer_project_wmo_stage_commits (
  job_id, project_id, attempt_id, authority_sha256, stage,
  bundle_storage_bucket, bundle_storage_path, bundle_sha256, bundle_size_bytes,
  spend_ledger, spend_entries, spend_total_usd, host_managed_spend_usd,
  policy_id, report_id, catalog_artifact_id, catalog_manifest_sha256
)
values (
  'de300000-0000-4000-8000-000000000301',
  'platform-project-de3000000000400080000000000000001',
  'platform-attempt-de3000000000400080000000000000301',
  encode(sha256(convert_to('demo-project-authority-tau-0301', 'UTF8')), 'hex'),
  'completing_report',
  'explabs-artifacts',
  'projects/de300000-0000-4000-8000-000000000001/attempts/0301/completing_report.wmo.zip',
  encode(sha256(convert_to('demo-project-bundle-tau-0301', 'UTF8')), 'hex'),
  1843200,
  '{"outcome": "completed", "total_usd": "18.734210"}'::jsonb,
  '[{"operation_id": "demo.tau.report", "amount_usd": "18.734210", "status": "observed", "billing_source": "host_managed"}]'::jsonb,
  18.734210, 18.734210,
  'policy.demo.tau', 'report.demo.tau', 'artifact.demo.tau',
  encode(sha256(convert_to('demo-project-manifest-tau-0301', 'UTF8')), 'hex')
)
on conflict do nothing;

-- The customer-safe held-out report and source-separated build ledger the
-- Overview and Usage tabs render, exactly in the allowlisted result shape.
insert into public.optimizer_project_results (job_id, project_id, report, build_spend)
values (
  'de300000-0000-4000-8000-000000000301',
  'de300000-0000-4000-8000-000000000001',
  '{"held_out_task_count": 96, "routed": {"score": {"point": 0.842, "ci95_lower": 0.801, "ci95_upper": 0.879, "measured_task_count": 94, "missing_task_count": 2}, "candidate_cost_usd": {"point": 0.0072, "ci95_lower": 0.0061, "ci95_upper": 0.0084, "measured_task_count": 94, "missing_task_count": 2}, "candidate_latency_seconds": {"point": 2.31, "ci95_lower": 2.02, "ci95_upper": 2.66, "measured_task_count": 94, "missing_task_count": 2}}, "baseline": {"score": {"point": 0.815, "ci95_lower": 0.771, "ci95_upper": 0.854, "measured_task_count": 94, "missing_task_count": 2}, "candidate_cost_usd": {"point": 0.0214, "ci95_lower": 0.0195, "ci95_upper": 0.0233, "measured_task_count": 94, "missing_task_count": 2}, "candidate_latency_seconds": {"point": 3.87, "ci95_lower": 3.41, "ci95_upper": 4.35, "measured_task_count": 94, "missing_task_count": 2}}, "paired_quality": {"compared_task_count": 92, "excluded_task_count": 4, "routed_weighted_score": 0.842, "baseline_weighted_score": 0.815, "weighted_difference": 0.027, "difference_ci95_lower": -0.004, "difference_ci95_upper": 0.058}, "fallback_count": 3, "fallback_rate": 0.03125, "coverage": {"planned_row_count": 96, "observed_row_count": 0, "completed_row_count": 94, "failed_row_count": 2, "not_run_row_count": 0, "missing_score_row_count": 2, "missing_cost_row_count": 2, "missing_latency_row_count": 2}}'::jsonb,
  '{"ceiling_usd": "25.000000", "total_usd": "18.734210", "host_managed_usd": "18.734210", "customer_managed_usd": "0.000000", "outcome": "completed", "restart": "completed_stage_bundle", "components": [{"component": "world_model", "operation_count": 384, "amount_usd": "9.812400", "statuses": ["observed"], "billing_source": "host_managed"}, {"component": "candidate", "operation_count": 288, "amount_usd": "6.421810", "statuses": ["observed"], "billing_source": "host_managed"}, {"component": "judge", "operation_count": 96, "amount_usd": "2.104000", "statuses": ["observed"], "billing_source": "host_managed"}, {"component": "router_embedding", "operation_count": 96, "amount_usd": "0.396000", "statuses": ["observed"], "billing_source": "host_managed"}]}'::jsonb
)
on conflict do nothing;

-- Activate the router, then pause serving: the card reads Serving, admission
-- exercises every real check, and the pause refusal fires before any policy
-- load could touch the absent bundle bytes (rationale in the block header).
insert into public.optimizer_project_active_routers (project_id, job_id, generation, activated_at)
values (
  'de300000-0000-4000-8000-000000000001',
  'de300000-0000-4000-8000-000000000301',
  1, now() - interval '13 days'
)
on conflict do nothing;

insert into public.optimizer_project_serving_settings (project_id, paused)
values ('de300000-0000-4000-8000-000000000001', true)
on conflict do nothing;

-- Serving log for the activated project: 120 project-shaped rows so its
-- Telemetry tab, the org Telemetry page, current-month serving usage, and the
-- Usage timeseries all read live. Project serving rows are immutable (their
-- settled economics may never be rewritten), so unlike the endpoint demo log
-- above these are strictly create-if-missing: deterministic ids, relative
-- timestamps clustered in the last day / week with a four-week tail at first
-- seed, ~6% clean allowlisted refusals carrying the 'none' billing shape.
-- Rows are host_managed and priced modestly (~$1 total lands on the org
-- meters via the spend trigger; the workspace's standing credit dwarfs it).
-- Bodies stay null: the project's serving settings do not opt into body
-- storage. The component pair each row must carry is inserted in the same
-- statement, satisfying the deferred pair check. Successful rows carry the
-- selected-candidate attribution across the setup's three seeded candidates
-- (mostly the cheap pair, a minority on the strong one), priced at per-model
-- rates; refusals stay unattributed because no candidate served them. Since
-- project rows are update-immutable, older stacks converge through the
-- guarded delete below, never through an update.

-- Converge stacks seeded before serving rows carried model attribution:
-- drop ONLY seed-owned rows (the de3e id range, this project) that are still
-- unattributed, so the insert below re-creates them with the mix. Rows that
-- already carry a model - including all future seeded rows - are never
-- touched, and real (non-seed-id) traffic is out of range. Asymmetry the
-- compensation below exists for: project-row INSERTS never meter the org
-- spend counters (the settlement lane owns that), but the delete guard DOES
-- unwind cost_usd - so an uncompensated converge would subtract spend that
-- was never added. The same statement re-adds exactly what the guard unwound.
with doomed as (
  delete from public.serving_requests
  where optimizer_project_id = 'de300000-0000-4000-8000-000000000001'
    and id between 'de3e0000-0000-4000-8000-000000000000'
               and 'de3e0000-0000-4000-8000-ffffffffffff'
    and model is null
    and status = 'ok'
  returning org_id, coalesce(cost_usd, 0) as cost_usd
)
select public.apply_org_unbillable_spend_delta(doomed.org_id, sum(doomed.cost_usd))
from doomed
group by doomed.org_id
having sum(doomed.cost_usd) > 0;

with shaped as (
  select
    n,
    ('de3e0000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid as id,
    n % 17 = 0 as refused,
    case
      when n % 17 = 0 then null
      when n % 20 < 9 then 'claude-haiku-4-5'
      when n % 20 < 16 then 'gemini-2.5-flash'
      else 'gpt-5.6-sol'
    end as served_model,
    420 + (n * 137) % 2400 as in_tokens,
    90 + (n * 71) % 760 as out_tokens,
    round((case
      -- Per-model list-price-shaped rates so cost stays coherent with the
      -- candidate that served the row (strong model an order pricier).
      when n % 20 >= 16 then 0.0000030 * (420 + (n * 137) % 2400)
                             + 0.0000120 * (90 + (n * 71) % 760)
      when n % 20 >= 9 then 0.0000003 * (420 + (n * 137) % 2400)
                            + 0.0000012 * (90 + (n * 71) % 760)
      else 0.0000004 * (420 + (n * 137) % 2400)
           + 0.0000020 * (90 + (n * 71) % 760)
    end)::numeric, 6) as total_cost,
    case
      when n <= 40 then now() - make_interval(mins => 20 + (n * 631) % 1380)
      when n <= 90 then now() - make_interval(hours => 26 + ((n - 40) * 97) % 140)
      else now() - make_interval(hours => 170 + ((n - 90) * 439) % 480)
    end as at
  from generate_series(1, 120) as series(n)
),
requests as (
  insert into public.serving_requests (
    id, org_id, endpoint_id, endpoint_label,
    optimizer_project_id, server_interaction_id,
    active_router_job_id, active_router_generation, settlement_sha256,
    optimizer_project_billing_source, optimizer_project_billing_breakdown,
    byok, model, input_tokens, output_tokens, cached_tokens,
    cost_usd, latency_ms, ttfb_ms, status, error_message, created_at
  )
  select
    shaped.id,
    '00000000-0000-0000-0000-000000000002',
    'de300000-0000-4000-8000-000000000001',
    'tau-bench-router',
    'de300000-0000-4000-8000-000000000001',
    md5('demo-project-interaction-' || shaped.n)::uuid,
    'de300000-0000-4000-8000-000000000301',
    1,
    encode(sha256(convert_to('demo-project-settlement-' || shaped.n, 'UTF8')), 'hex'),
    case when shaped.refused then 'none' else 'host_managed' end,
    case when shaped.refused
      then '{"router_embedding": "not_applicable", "selected_candidate": "not_applicable"}'::jsonb
      else '{"router_embedding": "host_managed", "selected_candidate": "host_managed"}'::jsonb
    end,
    false,
    shaped.served_model,
    shaped.in_tokens,
    case when shaped.refused then 0 else shaped.out_tokens end,
    case when not shaped.refused and shaped.n % 5 < 2
      then (shaped.in_tokens * 3) / 5 else 0 end,
    case when shaped.refused then null else shaped.total_cost end,
    380 + (shaped.n * 211) % 2200,
    110 + (shaped.n * 53) % 540,
    case when shaped.refused then 'error' else 'ok' end,
    case when shaped.refused then
      (array['provider_failed', 'service_unavailable'])[1 + (shaped.n / 17) % 2]
    else null end,
    shaped.at
  from shaped
  on conflict (id) do nothing
  returning id
)
insert into public.optimizer_project_serving_components (
  serving_request_id, operation_id, operation_ordinal, component,
  billing_source, disposition, operation_count, usage, cost_usd,
  cost_provenance, created_at
)
select
  shaped.id,
  'routed-operation-' || substr(md5('demo-' || pair.component || '-' || shaped.n), 1, 20),
  pair.ordinal,
  pair.component,
  case when shaped.refused then 'not_applicable' else 'host_managed' end,
  case when shaped.refused then 'definitely_not_incurred' else 'observed' end,
  case when shaped.refused then 0 else 1 end,
  case
    when shaped.refused then '{}'::jsonb
    when pair.component = 'router_embedding'
      then jsonb_build_object('input_tokens', shaped.in_tokens, 'output_tokens', 0)
    else jsonb_build_object('input_tokens', shaped.in_tokens, 'output_tokens', shaped.out_tokens)
  end,
  case
    when shaped.refused then 0
    when pair.component = 'router_embedding' then round(shaped.total_cost * 0.08, 6)
    else shaped.total_cost - round(shaped.total_cost * 0.08, 6)
  end,
  'observed',
  shaped.at
from shaped
join requests on requests.id = shaped.id
cross join (values ('router_embedding', 1::int2), ('selected_candidate', 2::int2))
  as pair(component, ordinal)
on conflict (serving_request_id, component) do nothing;
-- END demo Projects.
