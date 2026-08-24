-- Provider account snapshots: what each BYOK provider account could report
-- at a moment in time — month-to-date spend, credits remaining, usage limit —
-- so the Overview can show credits across accounts changing over time.
--
-- Sources are labeled honestly and permanently:
--   provider_api   the provider's own account/billing API, read with the
--                  stored credential (OpenRouter key+credits, Anthropic/OpenAI
--                  admin-key cost reports, Fireworks billing summary, Modal
--                  SDK billing summary)
--   our_side       our-side cloud billing (AWS Cost Explorer for Bedrock)
--   self_reported  the customer-declared balance gauge; it must never
--                  masquerade as a provider read
--
-- Org members read snapshots under RLS; only the service role writes them
-- (the spend-refresh endpoint and the declared-balance PATCH). The provider
-- column mirrors the referenced connection row, whose CHECK constraint owns
-- the provider vocabulary.

create table public.provider_account_snapshots (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid not null references public.provider_connections(id) on delete cascade,
  provider text not null,
  taken_at timestamptz not null default now(),
  spend_usd numeric(14, 6) check (spend_usd is null or spend_usd >= 0),
  credits_remaining_usd numeric(14, 6)
    check (credits_remaining_usd is null or credits_remaining_usd >= 0),
  usage_limit_usd numeric(14, 6) check (usage_limit_usd is null or usage_limit_usd >= 0),
  source text not null check (source in ('provider_api', 'our_side', 'self_reported')),
  detail jsonb
);

comment on table public.provider_account_snapshots is
  'One reading per row of what a BYOK provider account reported (or was declared to hold) at taken_at; the credits-over-time history behind the Overview.';
comment on column public.provider_account_snapshots.spend_usd is
  'Month-to-date (or current-cycle) spend in USD, when the source reports one.';
comment on column public.provider_account_snapshots.credits_remaining_usd is
  'Remaining credit in USD, when the source reports one (only OpenRouter has a real balance API; self_reported rows carry the declared figure).';
comment on column public.provider_account_snapshots.usage_limit_usd is
  'Account/key usage limit in USD, when the source reports one (detail may name the window, e.g. OpenRouter limit_reset).';
comment on column public.provider_account_snapshots.source is
  'provider_api = the provider''s own billing API; our_side = our-side cloud billing (AWS Cost Explorer); self_reported = the customer-declared gauge.';
comment on column public.provider_account_snapshots.detail is
  'Non-secret extras from the read: per-model/per-service breakdowns, raw figures, provider notes. Never key material.';

-- The refresh endpoint reads "latest provider read per connection"; the
-- Overview reads an org's history newest-first.
create index provider_account_snapshots_connection_taken_idx
  on public.provider_account_snapshots (connection_id, taken_at desc);
create index provider_account_snapshots_org_taken_idx
  on public.provider_account_snapshots (org_id, taken_at desc);

alter table public.provider_account_snapshots enable row level security;

create policy provider_account_snapshots_select_member
  on public.provider_account_snapshots
  for select
  to authenticated
  using (org_id in (select public.member_org_ids()));

-- No insert/update/delete policies on purpose: snapshots are written only by
-- the service role (which bypasses RLS), from the spend-refresh endpoint and
-- the declared-balance PATCH.
