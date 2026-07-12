import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const source = await readFile(resolve(new URL("../..", import.meta.url).pathname, "program-fact-ledger/main.aml"), "utf8");

test("fact-ledger deployment owner is captured before permissionless initialization", () => {
  const constructor = source.match(/constructor\(\) \{([\s\S]*?)\n  \}/)?.[1] || "";
  const initialize = source.match(/public fn initialize_fact_ledger[^\{]+\{([\s\S]*?)\n  \}/)?.[1] || "";
  assert.match(constructor, /self\.owner = caller/);
  assert.match(initialize, /require\(caller == self\.owner, "not deployment owner"\)/);
  assert.doesNotMatch(initialize, /self\.owner = caller/);
});

test("fact-ledger hardening preserves the established state layout", () => {
  const state = source.match(/state \{([\s\S]*?)\n  \}/)?.[1] || "";
  const fields = [...state.matchAll(/^\s{4}([a-z0-9_]+):/gm)].map((match) => match[1]);
  assert.deepEqual(fields, [
    "initialized", "owner", "operator", "successor_program", "successor_set", "era_program", "era_network_id",
    "predecessor_program", "predecessor_set", "predecessor_final_root", "predecessor_final_index", "predecessor_anchor_hash",
    "era_first_snapshot_index", "paused", "snapshot_count", "latest_snapshot_index", "latest_snapshot_id", "latest_observed_at",
    "latest_epoch", "latest_payload_hash", "latest_evidence_manifest_hash", "latest_source_refs_hash", "latest_summary_hash",
    "latest_history_row_hash", "latest_payload", "latest_evidence_manifest", "latest_source_refs", "latest_summary", "latest_history_row",
    "latest_submitter", "catalog_root", "family_count", "family_id_by_ordinal", "family_definition_by_id", "family_root_by_id",
    "family_capsules_root_by_id", "family_latest_index_by_id", "family_capsule_count_by_id", "family_latest_capsule_id_by_id",
    "family_open_capsule_base_id_by_id", "family_open_capsule_segment_by_id", "family_open_capsule_id_by_id",
    "family_open_capsule_body_by_id", "family_open_capsule_row_count_by_id", "family_open_capsule_first_index_by_id",
    "family_open_capsule_start_root_by_id", "family_open_capsule_end_root_by_id", "family_capsule_id_by_key",
    "family_capsule_body_by_key", "family_capsule_meta_by_key", "family_capsule_root_after_by_key"
  ]);
});

test("fact-ledger rejects clock rollback and sealed capsule key reuse", () => {
  assert.equal((source.match(/observed_at not increasing/g) || []).length, 2);
  assert.match(source, /private fn observed_at_after/);
  assert.doesNotMatch(source, /observed_at > self\.latest_observed_at/);
  assert.match(source, /observed_at month range/);
  assert.match(source, /observed_at February day range/);
  assert.match(source, /observed_at short month day range/);
  assert.equal((source.match(/capsule body slot occupied/g) || []).length, 2);
  assert.match(source, /core burned separator/);
  assert.match(source, /aux row schema separator/);
});
