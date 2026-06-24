import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, sha256Tagged } from "../lib/canonical-json.js";
import {
  capsuleIdForObservedAt,
  decodeHistoryV1CapsuleMeta,
  encodeHistoryV1Row,
  historyV1CapsuleMetaFromBody,
  historyV1EmptyCapsulesRootHex,
  historyV1EmptyHistoryRootHex,
  historyV1RowFromSnapshot,
  historyV1RowHashHex,
  HISTORY_V1_CAPSULE_META_LEN,
  HISTORY_V1_CAPSULE_ROW_LIMIT,
  HISTORY_V1_ROW_LEN,
  type HistoryV1ObservationRow
} from "../lib/aml-history-v1.js";
import {
  FACT_LEDGER_CORE_FAMILY_ID,
  FACT_LEDGER_CORE_SCHEMA_ID,
  FACT_LEDGER_CORE_SCHEMA_VERSION,
  FACT_LEDGER_MANIFEST,
  factLedgerRowHashHex
} from "../lib/aml-fact-ledger.js";
import type { SnapshotArtifact, SnapshotPayload } from "../lib/types.js";
import { buildRecordSnapshotCall } from "../scripts/build-record-snapshot-call.js";

function row(index: number, overrides: Partial<HistoryV1ObservationRow> = {}): HistoryV1ObservationRow {
  return {
    row_version: "00",
    snapshot_index: index,
    observed_at_unix: 1780000000 + index * 900,
    octra_epoch: 1000000 + index,
    external_block: 25000000 + index,
    max_supply_raw: "1000000000000000",
    issued_raw: "622000000000000",
    burned_raw: "378000000000000",
    encrypted_raw: "12413100000000",
    total_locked_raw: "201000000000000",
    total_wrapped_raw: "190000000000000",
    total_unclaimed_raw: "10000000000000",
    vault_balance_raw: "201000000000000",
    unit_status: "00",
    conservation_status: "G",
    route_count: 1,
    payload_hash_hex: "a".repeat(64),
    ...overrides
  };
}

function snapshotFixture(): SnapshotArtifact {
  const payload: SnapshotPayload = {
    schema_version: "octra-vitals-snapshot-v0",
    units: {
      oct_decimals: 6,
      woct_decimals: 6
    },
    octra: {
      epoch: 123456,
      state_root: "state",
      txid_hi: "txid",
      network_version: "v3.0.0",
      validator: "octValidator",
      timestamp: "1780000000"
    },
    supply: {
      max_oct_raw: "1000000000000000",
      issued_oct_raw: "622250139356816",
      encrypted_oct_raw: "12413100000000",
      burned_oct_raw: "377749860643184",
      confirmed_burned_oct_raw: "377749860643184"
    },
    bridge: {
      vault_address: "octVault",
      vault_balance_oct_raw: "201384879191180",
      total_locked_oct_raw: "201384879191180",
      total_unlocked_oct_raw: "7499870852064",
      lock_nonce: "8013",
      unlock_count: "806",
      woct_supply_raw: "190000000000000",
      unclaimed_oct_raw: "10257868180118"
    },
    ethereum: {
      chain_id: 1,
      block_number: "25338859",
      block_hash: "0xblock",
      woct_address: "0xwoct",
      bridge_address: "0xbridge"
    },
    relayer: {
      latest_finalized_epoch: 123455,
      latest_scanned_epoch: 123455,
      recovery_updated_at: 1780000000,
      mode: "validator-signed-light-path"
    },
    routes: [{
      route_id: "octra-7777-ethereum-1",
      src_chain: "octra",
      src_chain_id: 7777,
      dst_chain: "ethereum",
      dst_chain_id: 1,
      asset: "OCT",
      vault_address: "octVault",
      wrapped_address: "0xwoct",
      bridge_address: "0xbridge",
      locked_raw: "201384879191180",
      wrapped_supply_raw: "190000000000000",
      unclaimed_raw: "10257868180118",
      source_ref_ids: ["woct"]
    }],
    health: {
      conservation: {
        status: "green",
        ok: true,
        flags: [],
        deltas: {
          cap_remaining_raw: "0",
          cap_burn_mismatch_raw: "0",
          encrypted_minus_issued_raw: "0",
          bridge_claim_balance_raw: "0",
          bridge_claim_overage_raw: "0",
          vault_surplus_raw: "0"
        }
      }
    }
  };
  const evidenceManifest = {
    schema_version: "octra-vitals-evidence-manifest-v0",
    observed_at: "2026-06-23T12:15:00Z",
    parser_version: "test",
    entries: []
  };
  const sourceRefs: any[] = [];
  const canonicalPayload = canonicalJson(payload);
  const canonicalEvidenceManifest = canonicalJson(evidenceManifest);
  const canonicalSourceRefs = canonicalJson(sourceRefs);
  return {
    envelope: {
      schema_version: "octra-vitals-envelope-v0",
      snapshot_id: "vitals.2026-06-23T12:15:00Z",
      observed_at: "2026-06-23T12:15:00Z",
      payload_hash: sha256Tagged("octra-vitals:snapshot:v0", canonicalPayload),
      evidence_manifest_hash: sha256Tagged("octra-vitals:evidence:v0", canonicalEvidenceManifest),
      canonicalization: "jcs-rfc8785-or-equivalent-v1",
      payload,
      source_refs: sourceRefs,
      submitted_by: "octOperator"
    },
    evidence_manifest: evidenceManifest,
    canonical_source_refs: canonicalSourceRefs,
    canonical_payload: canonicalPayload,
    canonical_evidence_manifest: canonicalEvidenceManifest,
    generated_at: "2026-06-23T12:15:01Z"
  };
}

test("history v1 row is fixed-width and commits to the full payload hash", () => {
  const encoded = encodeHistoryV1Row(row(7));

  assert.equal(encoded.length, HISTORY_V1_ROW_LEN);
  assert.equal(encoded.slice(-64), "a".repeat(64));
  assert.match(historyV1RowHashHex(encoded), /^[0-9a-f]{64}$/);
});

test("history v1 row rejects truncated payload hashes", () => {
  assert.throws(
    () => encodeHistoryV1Row(row(1, { payload_hash_hex: "0123456789abcdef01234567" })),
    /payload_hash_hex must be 64 hex chars/
  );
});

test("snapshot-derived v1 row carries conservation and bridge fields", () => {
  const snapshot = snapshotFixture();
  const model = historyV1RowFromSnapshot(snapshot, 42);
  const encoded = encodeHistoryV1Row(model);

  assert.equal(model.snapshot_index, 42);
  assert.equal(model.observed_at_unix, 1782216900);
  assert.equal(model.conservation_status, "G");
  assert.equal(model.vault_balance_raw, "201384879191180");
  assert.equal(model.payload_hash_hex, snapshot.envelope.payload_hash.replace(/^sha256:/, ""));
  assert.equal(encoded.length, HISTORY_V1_ROW_LEN);
});

test("capsule metadata is fixed-width and separates before-root from stored after-root", () => {
  const body = Array.from({ length: HISTORY_V1_CAPSULE_ROW_LIMIT }, (_, index) => encodeHistoryV1Row(row(index + 1))).join("");
  const capsule = historyV1CapsuleMetaFromBody({
    capsuleId: "2026-06-23T00.0000",
    body,
    startRootHex: historyV1EmptyHistoryRootHex(),
    capsulesRootBeforeHex: historyV1EmptyCapsulesRootHex()
  });

  assert.equal(capsule.meta_row.length, HISTORY_V1_CAPSULE_META_LEN);
  assert.deepEqual(decodeHistoryV1CapsuleMeta(capsule.meta_row), capsule.meta);
  assert.equal(capsule.meta.capsules_root_before_hex, historyV1EmptyCapsulesRootHex());
  assert.match(capsule.root_after_hex, /^[0-9a-f]{64}$/);
  assert.notEqual(capsule.root_after_hex, capsule.meta.capsules_root_before_hex);
});

test("capsule metadata supports partial boundary seals", () => {
  const body = Array.from({ length: 4 }, (_, index) => encodeHistoryV1Row(row(index + 1))).join("");
  const capsule = historyV1CapsuleMetaFromBody({
    capsuleId: "2026-06-23T00.0000",
    body,
    startRootHex: historyV1EmptyHistoryRootHex(),
    capsulesRootBeforeHex: historyV1EmptyCapsulesRootHex()
  });

  assert.equal(capsule.meta_row.length, HISTORY_V1_CAPSULE_META_LEN);
  assert.equal(capsule.meta.first_index, "0000000001");
  assert.equal(capsule.meta.last_index, "0000000004");
  assert.equal(capsule.meta.row_count, "000004");
  assert.equal(capsule.meta.first_observed_unix, "001780000900");
  assert.equal(capsule.meta.last_observed_unix, "001780003600");
});

test("capsule metadata rejects empty and overfull bodies", () => {
  assert.throws(
    () => historyV1CapsuleMetaFromBody({
      capsuleId: "2026-06-23T00.0000",
      body: "",
      startRootHex: historyV1EmptyHistoryRootHex(),
      capsulesRootBeforeHex: historyV1EmptyCapsulesRootHex()
    }),
    /at least one row/
  );

  const overfull = Array.from({ length: HISTORY_V1_CAPSULE_ROW_LIMIT + 1 }, (_, index) => encodeHistoryV1Row(row(index + 1))).join("");
  assert.throws(
    () => historyV1CapsuleMetaFromBody({
      capsuleId: "2026-06-23T00.0000",
      body: overfull,
      startRootHex: historyV1EmptyHistoryRootHex(),
      capsulesRootBeforeHex: historyV1EmptyCapsulesRootHex()
    }),
    /exceeds 48 rows/
  );
});

test("capsule ids use deterministic 12h UTC halves with overflow segments", () => {
  assert.equal(capsuleIdForObservedAt("2026-06-23T00:00:00Z"), "2026-06-23T00.0000");
  assert.equal(capsuleIdForObservedAt("2026-06-23T11:59:59Z"), "2026-06-23T00.0000");
  assert.equal(capsuleIdForObservedAt("2026-06-23T12:00:00Z"), "2026-06-23T12.0000");
  assert.equal(capsuleIdForObservedAt("2026-06-23T12:00:00Z", 1), "2026-06-23T12.0001");
  assert.throws(() => capsuleIdForObservedAt("2026-06-23T12:00:00Z", 10000), /0\.\.9999/);
});

test("capsule metadata allows same-half overflow capsules with distinct ids", () => {
  const firstBody = Array.from({ length: HISTORY_V1_CAPSULE_ROW_LIMIT }, (_, index) => encodeHistoryV1Row(row(index + 1))).join("");
  const first = historyV1CapsuleMetaFromBody({
    capsuleId: "2026-06-23T00.0000",
    body: firstBody,
    startRootHex: historyV1EmptyHistoryRootHex(),
    capsulesRootBeforeHex: historyV1EmptyCapsulesRootHex()
  });
  const secondBody = Array.from({ length: 2 }, (_, index) => encodeHistoryV1Row(row(HISTORY_V1_CAPSULE_ROW_LIMIT + index + 1))).join("");
  const second = historyV1CapsuleMetaFromBody({
    capsuleId: "2026-06-23T00.0001",
    body: secondBody,
    startRootHex: first.end_root_hex,
    capsulesRootBeforeHex: first.root_after_hex
  });

  assert.equal(first.meta.capsule_id, "2026-06-23T00.0000");
  assert.equal(second.meta.capsule_id, "2026-06-23T00.0001");
  assert.equal(second.meta.first_index, "0000000049");
  assert.equal(second.meta.row_count, "000002");
  assert.equal(second.meta.start_root_hex, first.end_root_hex);
  assert.equal(second.meta.capsules_root_before_hex, first.root_after_hex);
});

test("record snapshot builder can emit v1 bundles without changing the v0 default", async () => {
  const snapshot = snapshotFixture();
  const v0 = await buildRecordSnapshotCall(snapshot, { snapshotIndex: 5, recordVersion: "v0" });
  const v1 = await buildRecordSnapshotCall(snapshot, { snapshotIndex: 5, recordVersion: "v1" });
  const factV1 = await buildRecordSnapshotCall(snapshot, { snapshotIndex: 5, recordVersion: "fact-v1" });

  assert.equal(v0.method, "record_snapshot_v0");
  assert.equal(v1.method, "record_snapshot_v1");
  assert.equal(v1.history.row.length, HISTORY_V1_ROW_LEN);
  assert.equal(v1.expected_hashes.history_row_hash, historyV1RowHashHex(v1.history.row));
  assert.equal(v1.params[2], 1782216900);
  assert.equal(factV1.method, "record_snapshot_fact_v1");
  assert.equal(factV1.commit_mode, "fact-v1");
  assert.equal(factV1.fact_ledger.manifest, FACT_LEDGER_MANIFEST);
  assert.equal(factV1.fact_ledger.core_family_id, FACT_LEDGER_CORE_FAMILY_ID);
  assert.equal(factV1.fact_ledger.core_schema_id, FACT_LEDGER_CORE_SCHEMA_ID);
  assert.equal(factV1.fact_ledger.capsule_base_id, "2026-06-23T12");
  assert.equal(factV1.history.schema_version, FACT_LEDGER_CORE_SCHEMA_VERSION);
  assert.equal(factV1.history.row, v1.history.row);
  assert.equal(factV1.expected_hashes.history_row_hash, factLedgerRowHashHex(FACT_LEDGER_CORE_FAMILY_ID, FACT_LEDGER_CORE_SCHEMA_ID, factV1.history.row));
  assert.notEqual(factV1.expected_hashes.history_row_hash, v1.expected_hashes.history_row_hash);
  assert.equal(factV1.snapshot_id, snapshot.envelope.snapshot_id);
  assert.equal(factV1.observed_at, snapshot.envelope.observed_at);
  assert.equal(factV1.params.length, 9);
  assert.equal(factV1.params[0], snapshot.canonical_payload);
  assert.equal(factV1.params[5], snapshot.envelope.observed_at);
  assert.equal(factV1.params[6], "2026-06-23T12");
  assert.equal(factV1.params[7], Number(factV1.history.row.slice(27, 39)));
  assert.equal(factV1.params[8], factV1.snapshot_index);
});
