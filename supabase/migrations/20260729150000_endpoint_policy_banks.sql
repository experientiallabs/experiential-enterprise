-- The kNN router's evidence, so a hosted endpoint can serve the validated
-- champion instead of only `static`.
--
-- A kNN policy is two artifacts, not one. `endpoints.policy` holds the JSON
-- dump, but the neighbors it actually routes against (an L2-normalized fit
-- embedding matrix plus the measured per-scenario reward and cost cells) are a
-- binary sidecar next to policy.json on disk, ~172KB of the 177KB at 3072
-- dimensions. Storing only the JSON produces a row that validates and cannot
-- serve: the engine's knn_bank() raises FileNotFoundError at first request.
--
-- So the bank is a storage object and the row points at it, content-addressed
-- exactly like catalog bundles (`catalog/{entry_id}/{sha256}.tar.gz`) so a
-- concurrent writer can never leave a row pointing at someone else's bytes,
-- and so an unchanged bank re-published is the same object.
--
-- Why not store the vectors in Postgres: they are opaque float32 blobs that no
-- query ever filters or joins on, and the bucket already has provisioning,
-- cleanup tooling, and a verified-download path (`_download_verified` checks
-- digest AND byte length) that a bytea column would have to reinvent.
--
-- Why not recompute the embeddings from Azure at mount instead of storing them:
-- the reward and cost cells are MEASURED and cannot be recomputed at all, and
-- re-embedding would make routing decisions depend on an embedding deployment
-- version we do not control, so a silent upstream model update would move
-- routes with no artifact change. Serving has to be reproducible from the row.

alter table public.endpoints
  -- Object path within the artifacts bucket (see policy_bank_storage_path).
  add column policy_bank_path text,
  -- Digest of the bank bytes. Verified on every download, so a corrupted or
  -- swapped object fails loudly instead of routing against wrong evidence.
  add column policy_bank_sha256 text
    check (policy_bank_sha256 ~ '^[0-9a-f]{64}$'),
  -- Byte length, verified alongside the digest and used to reject an oversized
  -- bank before it is downloaded into a serving pod.
  add column policy_bank_bytes bigint
    check (policy_bank_bytes > 0);

-- All three or none. A path without a digest is an unverifiable download, and a
-- digest without a path points at nothing; either half-written row would be
-- discovered at serve time, which is the wrong place to find out.
alter table public.endpoints
  add constraint endpoints_policy_bank_all_or_nothing
  check (
    (policy_bank_path is null
      and policy_bank_sha256 is null
      and policy_bank_bytes is null)
    or (policy_bank_path is not null
      and policy_bank_sha256 is not null
      and policy_bank_bytes is not null)
  );

-- The fail-closed rule, in the database rather than in the serving path: a knn
-- policy without its bank is simply not storable. The engine already refuses to
-- serve one (knn_bank() raises with a message telling you to copy the sidecar),
-- but that refusal happens on a customer's request, against a row that looked
-- fine when it was written. This moves the failure to the writer.
--
-- Stated as "not knn implies nothing required" so `static` and `rank` rows,
-- which have no bank, stay legal and unchanged.
alter table public.endpoints
  add constraint endpoints_knn_policy_has_bank
  check (
    coalesce(policy->>'kind', '') <> 'knn'
    or policy_bank_path is not null
  );

comment on column public.endpoints.policy_bank_path is
  'Artifacts-bucket object path for a knn policy''s .npz evidence sidecar; null for static and rank policies. Server-internal, like policy: no read RPC returns it.';

comment on column public.endpoints.policy_bank_sha256 is
  'sha256 of the bank bytes, verified on download so wrong evidence cannot route.';

comment on column public.endpoints.policy_bank_bytes is
  'Byte length of the bank object, verified on download and checked against the serving-side size cap.';
