PRAGMA foreign_keys = ON;

create table if not exists mirror_meta(
  key text primary key,
  value text not null
);

create table if not exists mirror_watermarks(
  source_id text primary key,
  source_range_first_index integer,
  source_range_latest_index integer,
  verified_range_first_index integer,
  verified_range_latest_index integer,
  last_complete_snapshot_index integer,
  latest_verified_root text,
  last_aml_readback_verified_at text,
  last_run_id text,
  transform_version text not null,
  complete integer not null,
  retention_policy text not null
);

create table if not exists aml_eras(
  era_id text primary key,
  circle_id text,
  network_id text,
  manifest text,
  history_model text,
  first_snapshot_index integer,
  latest_snapshot_index integer,
  row_count integer,
  predecessor_program text,
  predecessor_final_index integer,
  predecessor_final_root text,
  predecessor_anchor_hash text,
  boundary_verified integer not null default 0,
  root_hash text,
  catalog_root text,
  core_family_root text,
  core_capsules_root text,
  proof_scope text,
  proof_truncated integer,
  verified_at text
);

create table if not exists fact_families(
  era_id text not null,
  family_id text not null,
  schema_id text,
  family_name text,
  status text not null default 'mirrored',
  first_snapshot_index integer,
  row_len integer,
  field_manifest_hash text,
  definition_hash text,
  raw_json text,
  primary key(era_id, family_id)
);

create table if not exists fact_capsules(
  era_id text not null,
  family_id text not null,
  capsule_id text not null,
  ordinal integer,
  sealed integer not null default 0,
  first_snapshot_index integer,
  last_snapshot_index integer,
  row_count integer,
  row_len integer,
  body_hash text,
  meta_hash text,
  start_root text,
  end_root text,
  family_root_before text,
  family_root_after text,
  proof_scope text,
  verified_at text,
  raw_json text,
  primary key(era_id, family_id, capsule_id)
);

create table if not exists snapshots(
  snapshot_index integer primary key,
  era_id text,
  snapshot_id text not null,
  source_id text,
  observed_at text not null,
  observed_at_unix integer not null,
  octra_epoch integer,
  external_block integer,
  program_circle_id text,
  aml_tx_hash text,
  payload_hash_prefix text,
  evidence_manifest_hash text,
  source_refs_hash text,
  summary_hash text,
  core_row_hash text,
  capsule_id text,
  family_root_after text,
  conservation_status text,
  unit_status text,
  mirrored_at text not null,
  verified_at text not null,
  proof_scope text not null,
  source_class text not null,
  mirror_run_id text not null
);

create table if not exists core_accounting_facts(
  snapshot_index integer primary key,
  max_supply_raw text,
  issued_raw text not null,
  burned_raw text not null,
  encrypted_raw text not null,
  total_locked_raw text not null,
  total_wrapped_raw text not null,
  total_unclaimed_raw text not null,
  vault_balance_raw text,
  route_count integer,
  payload_hash_prefix text,
  core_row_hash text,
  foreign key(snapshot_index) references snapshots(snapshot_index)
);

create table if not exists derived_snapshot_metrics(
  snapshot_index integer not null,
  metric_key text not null,
  metric_label text not null,
  raw_value text not null,
  unit text not null,
  source_class text not null,
  derivation text not null,
  primary key(snapshot_index, metric_key),
  foreign key(snapshot_index) references snapshots(snapshot_index)
);

create table if not exists aux_metric_facts(
  snapshot_index integer not null,
  family_id text not null,
  schema_id text not null,
  slot_index integer not null,
  metric_id text not null,
  unit_id text not null,
  status text not null,
  source_class text not null,
  value_raw text not null,
  payload_hash_prefix text,
  row_hash text,
  primary key(snapshot_index, family_id, slot_index)
);

create table if not exists bridge_routes(
  snapshot_index integer not null,
  route_id text not null,
  dst_chain_id text,
  chain_label text,
  wrapped_supply_raw text,
  wrapped_token_address text,
  bridge_address text,
  vault_address text,
  block_number integer,
  source_class text not null,
  primary key(snapshot_index, route_id)
);

create table if not exists evidence_refs(
  evidence_hash text primary key,
  source_kind text,
  source_id text,
  source_class text not null,
  external_locator text,
  byte_length integer,
  redaction_class text not null default 'public_hash_only',
  retention_class text not null default 'hash_pointer'
);

create table if not exists snapshot_evidence_refs(
  snapshot_index integer not null,
  evidence_hash text not null,
  relation text not null,
  primary key(snapshot_index, evidence_hash, relation)
);

create table if not exists snapshot_verifications(
  snapshot_index integer not null,
  verification_type text not null,
  status text not null,
  checked_at text not null,
  source_range text,
  details_json text,
  primary key(snapshot_index, verification_type)
);

create table if not exists mirror_runs(
  run_id text primary key,
  started_at text not null,
  finished_at text,
  status text not null,
  source_first_index integer,
  source_latest_index integer,
  mirrored_through_index integer,
  verified_through_index integer,
  transform_version text not null,
  error text
);

create table if not exists integrity_issues(
  issue_id text primary key,
  severity text not null,
  issue_type text not null,
  affected_entity text not null,
  first_seen_at text not null,
  last_seen_at text not null,
  first_seen_snapshot integer,
  last_seen_snapshot integer,
  status text not null,
  run_id text,
  source_range text,
  diagnostic_json text
);

create index if not exists snapshots_observed_idx on snapshots(observed_at_unix desc, snapshot_index desc);
create index if not exists snapshots_payload_hash_idx on snapshots(payload_hash_prefix);
create unique index if not exists snapshots_tx_hash_uq on snapshots(aml_tx_hash) where aml_tx_hash is not null;
create index if not exists snapshots_status_idx on snapshots(conservation_status, snapshot_index desc) where conservation_status is not null;
create index if not exists derived_metric_series_idx on derived_snapshot_metrics(metric_key, snapshot_index desc);
create index if not exists aux_metric_series_idx on aux_metric_facts(family_id, metric_id, snapshot_index desc);
create index if not exists bridge_routes_chain_idx on bridge_routes(dst_chain_id, snapshot_index desc);
create index if not exists evidence_refs_source_idx on evidence_refs(source_id);
create index if not exists mirror_runs_status_idx on mirror_runs(status, started_at desc);
create index if not exists integrity_open_idx on integrity_issues(last_seen_at desc) where status != 'resolved';

insert or replace into mirror_meta(key, value) values
  ('schema', 'octra-vitals-lab-history-v0'),
  ('canonical_state_source', 'aml_fact_ledger'),
  ('mirror_role', 'derived_readback_cache'),
  ('mirror_canonical', 'false'),
  ('devnet_only', 'true');
