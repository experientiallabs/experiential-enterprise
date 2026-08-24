-- Two more per-endpoint serving controls (the model page's Config tab):
-- a pause switch and a monthly token ceiling beside the spend ceiling.
-- Defaults keep every existing row serving exactly as today.

alter table public.endpoints
  add column paused boolean not null default false,
  add column token_limit bigint;

alter table public.endpoints
  add constraint endpoints_token_limit_positive
    check (token_limit is null or token_limit > 0);
