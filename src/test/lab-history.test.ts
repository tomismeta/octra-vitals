import assert from "node:assert/strict";
import test from "node:test";

import { buildLabHistoryMirrorSql } from "../lib/lab-history.js";
import { normalizeReadOnlySql, octraSqliteConfig, octraSqliteQueryProof, parseOctraSqliteOutput } from "../lib/octra-sqlite-client.js";
import type { ProgramHistoryWindow } from "../lib/summary-window.js";

function sampleHistory(): ProgramHistoryWindow {
  return {
    first_index: 10,
    row_count: 2,
    row_len: 208,
    window: "",
    window_hash: "sha256:window",
    history_discovery: "aml_fact_family_core_capsules_verified",
    history_root: "a".repeat(64),
    capsules_root: "b".repeat(64),
    rows: [
      {
        row_version: "00",
        snapshot_index: 10,
        observed_at_unix: 1_798_000_000,
        octra_epoch: 123,
        external_block: 456,
        issued_raw: "623000000000000",
        burned_raw: "377000000000000",
        encrypted_raw: "12413100000000",
        total_locked_raw: "201000000000000",
        total_wrapped_raw: "190000000000000",
        total_unclaimed_raw: "10000000000000",
        route_count: 1,
        payload_hash_prefix: "0123456789abcdef01234567"
      },
      {
        row_version: "00",
        snapshot_index: 11,
        observed_at_unix: 1_798_000_900,
        octra_epoch: 124,
        external_block: 457,
        issued_raw: "623100000000000",
        burned_raw: "376900000000000",
        encrypted_raw: "12413100000000",
        total_locked_raw: "201100000000000",
        total_wrapped_raw: "190100000000000",
        total_unclaimed_raw: "10000000000000",
        route_count: 1,
        payload_hash_prefix: "89abcdef0123456701234567"
      }
    ],
    proof: {
      scope: "full_chain",
      truncated: false,
      families: [{ family_id: "0000", schema_id: "0000", family_root: "a".repeat(64) }],
      capsules: [{ family_id: "0000", capsule_id: "2026-06-28T00.0000", ordinal: 0, root_after: "a".repeat(64) }]
    },
    eras: [{
      era_id: "octDevCircle",
      era_program: "octDevCircle",
      era_network_id: "octra-devnet",
      manifest: "octra-vitals-fact-ledger.v2",
      history_model: "aml_fact_family_core_capsules_verified",
      first_index: 10,
      latest_index: 11,
      row_count: 2,
      root_hash: "a".repeat(64),
      capsules_root: "b".repeat(64),
      proof_scope: "full_chain",
      proof_truncated: false
    }]
  };
}

test("lab query guard wraps bounded read-only select SQL", () => {
  const normalized = normalizeReadOnlySql("select snapshot_index from snapshots order by snapshot_index desc", 25);

  assert.equal(normalized.limit, 25);
  assert.match(normalized.sql, /^select \* from \(select snapshot_index/);
  assert.match(normalized.sql, /limit 25$/);
});

test("lab query guard rejects mutating SQL", () => {
  assert.throws(() => normalizeReadOnlySql("delete from snapshots"), /only_select_queries_allowed/);
  assert.throws(() => normalizeReadOnlySql("select 1; drop table snapshots"), /only_one_read_only_statement_allowed/);
  assert.throws(() => normalizeReadOnlySql("select * from snapshots -- nope"), /sql_comments_not_allowed/);
});

test("octra-sqlite output parser accepts query and write envelopes", () => {
  const query = parseOctraSqliteOutput(JSON.stringify({
    ok: true,
    type: "query",
    columns: ["snapshot_index"],
    rows: [[465]],
    row_count: 1
  }));

  assert.deepEqual(query.columns, ["snapshot_index"]);
  assert.deepEqual(query.rows, [[465]]);
  assert.equal(query.row_count, 1);

  const write = parseOctraSqliteOutput(JSON.stringify({
    ok: true,
    type: "write",
    status: "confirmed",
    tx_hash: "abc123",
    receipt: { success: true }
  }));

  assert.deepEqual(write, { columns: [], ok: true, row_count: 0, rows: [] });

  const writeScript = parseOctraSqliteOutput(JSON.stringify({
    ok: true,
    type: "write_script",
    schema: "octra-sqlite.cli.v1",
    statements: 14,
    batches: 1,
    writes: [{ status: "confirmed" }]
  }));

  assert.deepEqual(writeScript, { columns: [], ok: true, row_count: 0, rows: [] });

  const restore = parseOctraSqliteOutput(JSON.stringify({
    ok: true,
    type: "restore",
    statements: 3279,
    batches: 200,
    writes: [{ status: "confirmed" }, { status: "confirmed" }]
  }));

  assert.deepEqual(restore, { columns: [], ok: true, row_count: 0, rows: [] });
  assert.throws(() => parseOctraSqliteOutput(JSON.stringify({ ok: false, error: "bad" })), /octra_sqlite_not_ok/);
});

test("lab query proof describes Circle read without exposing auth material", async () => {
  const normalized = normalizeReadOnlySql("select snapshot_index from snapshots", 10);
  const proof = await octraSqliteQueryProof(normalized, {
    enabled: true,
    reason: null,
    bin: "/opt/octra-sqlite/bin/octra-sqlite",
    configPath: null,
    database: "oct://devnet/octExample",
    databaseUri: "oct://devnet/octExample",
    network: "devnet"
  });

  assert.equal(proof.database_uri, "oct://devnet/octExample");
  assert.equal(proof.circle_id, "octExample");
  assert.equal(proof.rpc_url, "https://devnet.octrascan.io/rpc");
  assert.equal(proof.jsonrpc_method, "octra_circleViewAuth");
  assert.equal(proof.circle_method, "query_typed");
  assert.equal(proof.normalized_limit, 10);
  assert.match(proof.normalized_sql, /^select \* from \(select snapshot_index/);
  assert.match(proof.normalized_sql_sha256, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(proof.params_shape, [
    "circle_id",
    "query_typed",
    "[normalized_sql]",
    "caller",
    "public_key_b64",
    "view_signature",
    "false"
  ]);
});

test("lab database config requires an explicit oct URI and explicit mainnet enable", () => {
  const plain = octraSqliteConfig({
    VITALS_LAB_HISTORY_ENABLED: "1",
    VITALS_LAB_HISTORY_DATABASE: "vitals_history_lab",
    VITALS_LAB_HISTORY_NETWORK: "devnet"
  } as NodeJS.ProcessEnv);

  assert.equal(plain.enabled, false);
  assert.equal(plain.reason, "lab_history_database_uri_required");

  const mismatch = octraSqliteConfig({
    VITALS_LAB_HISTORY_ENABLED: "1",
    VITALS_LAB_HISTORY_DATABASE_URI: "oct://mainnet/octExample",
    VITALS_LAB_HISTORY_NETWORK: "devnet"
  } as NodeJS.ProcessEnv);

  assert.equal(mismatch.enabled, false);
  assert.equal(mismatch.reason, "lab_history_network_mismatch");

  const mainnetWithoutEnable = octraSqliteConfig({
    VITALS_LAB_HISTORY_ENABLED: "1",
    VITALS_LAB_HISTORY_DATABASE_URI: "oct://mainnet/octExample",
  } as NodeJS.ProcessEnv);

  assert.equal(mainnetWithoutEnable.enabled, false);
  assert.equal(mainnetWithoutEnable.reason, "lab_history_mainnet_requires_explicit_enable");

  const mainnetWithEnable = octraSqliteConfig({
    VITALS_LAB_HISTORY_ENABLED: "1",
    VITALS_LAB_HISTORY_DATABASE_URI: "oct://mainnet/octExample",
    VITALS_LAB_HISTORY_NETWORK: "mainnet",
    VITALS_LAB_HISTORY_ALLOW_MAINNET: "1"
  } as NodeJS.ProcessEnv);

  assert.equal(mainnetWithEnable.enabled, true);
  assert.equal(mainnetWithEnable.network, "mainnet");

  const unsupported = octraSqliteConfig({
    VITALS_LAB_HISTORY_ENABLED: "1",
    VITALS_LAB_HISTORY_DATABASE_URI: "oct://stage/octExample"
  } as NodeJS.ProcessEnv);

  assert.equal(unsupported.enabled, false);
  assert.equal(unsupported.reason, "lab_history_network_unsupported");

  const devnet = octraSqliteConfig({
    VITALS_LAB_HISTORY_ENABLED: "1",
    VITALS_LAB_HISTORY_DATABASE_URI: "oct://devnet/octExample",
    VITALS_LAB_HISTORY_NETWORK: "devnet"
  } as NodeJS.ProcessEnv);

  assert.equal(devnet.enabled, true);
  assert.equal(devnet.network, "devnet");
  assert.equal(devnet.database, "oct://devnet/octExample");
});

test("lab mirror SQL preserves AML authority and derived query fields", () => {
  const { sql, summary } = buildLabHistoryMirrorSql(sampleHistory(), {
    target_kind: "circle_program",
    target_id: "octDevCircle"
  }, "2026-06-28T12:00:00Z");

  assert.equal(summary.row_count, 2);
  assert.equal(summary.latest_index, 11);
  assert.equal(summary.complete_through_index, 11);
  assert.equal(summary.mirrored_latest_index, 11);
  assert.equal(summary.proof_scope, "full_chain");
  assert.match(sql, /insert or replace into mirror_meta/);
  assert.match(sql, /canonical_state_source/);
  assert.match(sql, /aml_fact_ledger/);
  assert.match(sql, /insert or replace into snapshots/);
  assert.match(sql, /circle_program:octDevCircle/);
  assert.match(sql, /insert or replace into core_accounting_facts/);
  assert.match(sql, /public_balance_raw/);
  assert.match(sql, /unclassified_raw/);
  assert.match(sql, /woct_coverage_ppm/);
});
