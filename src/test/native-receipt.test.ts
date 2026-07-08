import assert from "node:assert/strict";
import test from "node:test";

import { verifyNativeSnapshotReceipt } from "../lib/native-receipt.js";
import type { SnapshotArtifact } from "../lib/types.js";

const snapshot = {
  envelope: {
    snapshot_id: "vitals.2026-07-08T12:34:56Z",
    observed_at: "2026-07-08T12:34:56Z",
    payload_hash: "sha256:payload",
    evidence_manifest_hash: "sha256:evidence",
    source_refs: []
  },
  canonical_source_refs: "[]"
} as unknown as SnapshotArtifact;

test("native receipt verifier accepts fact-ledger SnapshotRecorded layout", () => {
  const proof = verifyNativeSnapshotReceipt({
    contract: "octCircle",
    method: "record_snapshot_fact_v2",
    success: true,
    events: [{
      event: "SnapshotRecorded",
      values: [
        "vitals.2026-07-08T12:34:56Z",
        "42",
        "core",
        "sha256:payload",
        "history-row-hash",
        "2026-07-08T12:34:56Z",
        "2026-07-08T12.0000",
        "octOperator"
      ]
    }]
  }, {
    target_kind: "circle_program",
    programmed_circle_id: "octCircle",
    commit_mode: "fact-v2",
    snapshot_index: 42,
    expected_hashes: {
      history_row_hash: "history-row-hash"
    },
    fact_ledger: {
      capsule_base_id: "2026-07-08T12"
    }
  }, snapshot);

  assert.equal(proof.verified, true);
  assert.equal(proof.checks.method_matches, true);
  assert.equal(proof.checks.history_row_hash_matches, true);
  assert.equal(proof.checks.capsule_id_matches, true);
});

test("native receipt verifier keeps v0 event layout checks", () => {
  const proof = verifyNativeSnapshotReceipt({
    contract: "octProgram",
    method: "record_snapshot_v0",
    success: true,
    events: [{
      event: "SnapshotRecorded",
      values: [
        "vitals.2026-07-08T12:34:56Z",
        "42",
        "unused",
        "sha256:payload",
        "sha256:evidence",
        "sha256:source-refs",
        "sha256:summary"
      ]
    }]
  }, {
    target_kind: "state_program",
    program_address: "octProgram",
    commit_mode: "v0",
    snapshot_index: 42,
    expected_hashes: {
      source_refs_hash: "sha256:source-refs",
      summary_hash: "sha256:summary"
    }
  }, snapshot);

  assert.equal(proof.verified, true);
  assert.equal(proof.checks.evidence_hash_matches, true);
});

test("native receipt verifier rejects forged fact-ledger row hash", () => {
  const proof = verifyNativeSnapshotReceipt({
    contract: "octCircle",
    method: "record_snapshot_fact_v1",
    success: true,
    events: [{
      event: "SnapshotRecorded",
      values: [
        "vitals.2026-07-08T12:34:56Z",
        "42",
        "core",
        "sha256:payload",
        "wrong-row-hash",
        "2026-07-08T12:34:56Z",
        "2026-07-08T12.0000",
        "octOperator"
      ]
    }]
  }, {
    target_kind: "circle_program",
    programmed_circle_id: "octCircle",
    commit_mode: "fact-v1",
    snapshot_index: 42,
    expected_hashes: {
      history_row_hash: "history-row-hash"
    }
  }, snapshot);

  assert.equal(proof.verified, false);
  assert.equal(proof.checks.history_row_hash_matches, false);
});

test("native receipt verifier rejects fact-ledger receipts without expected row hash", () => {
  const proof = verifyNativeSnapshotReceipt({
    contract: "octCircle",
    method: "record_snapshot_fact_v2",
    success: true,
    events: [{
      event: "SnapshotRecorded",
      values: [
        "vitals.2026-07-08T12:34:56Z",
        "42",
        "core",
        "sha256:payload",
        "history-row-hash",
        "2026-07-08T12:34:56Z",
        "2026-07-08T12.0000",
        "octOperator"
      ]
    }]
  }, {
    target_kind: "circle_program",
    programmed_circle_id: "octCircle",
    commit_mode: "fact-v2",
    snapshot_index: 42
  }, snapshot);

  assert.equal(proof.verified, false);
  assert.equal(proof.checks.history_row_hash_matches, false);
});
