#!/usr/bin/env node
import {
  buildProbeEstimates,
  CAPSULE_META_LEN,
  HISTORY_PROBE_SCHEMA,
  HISTORY_ROW_LEN,
  makeCapsule,
  makeTxIndex,
  syntheticHistoryRow,
  syntheticTxHash
} from "../lib/aml-history-probe.js";

const rowCounts = [12, 24, 48, 96, 192, 384];
const sampleRows = Array.from({ length: 48 }, (_, index) => syntheticHistoryRow(index + 1));
const sampleTxIndex = makeTxIndex(sampleRows.map((row) => syntheticTxHash(row.snapshot_index)));
const sampleCapsule = makeCapsule(sampleRows, { txIndex: sampleTxIndex });

const report = {
  schema: HISTORY_PROBE_SCHEMA,
  generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  status: "local-plan",
  row_len: HISTORY_ROW_LEN,
  capsule_meta_len: CAPSULE_META_LEN,
  candidates: [
    "plain AML-resident capsules",
    "AML-resident calendar capsules",
    "AML metadata plus Circle-asset capsule bodies fallback"
  ],
  row_counts: rowCounts,
  estimates: buildProbeEstimates(rowCounts),
  sample_capsule: {
    capsule_id: sampleCapsule.meta.capsule_id,
    row_count: sampleCapsule.meta.row_count,
    body_bytes: sampleCapsule.body.length,
    meta_bytes: sampleCapsule.meta_row.length,
    body_hash_hex: sampleCapsule.body_hash_hex,
    start_root_hex: sampleCapsule.meta.start_root_hex,
    end_root_hex: sampleCapsule.meta.end_root_hex,
    tx_index_hash_hex: sampleCapsule.meta.tx_index_hash_hex,
    meta_hash_hex: sampleCapsule.meta_hash_hex
  },
  next_steps: [
    "compile isolated program-history-probe/main.aml against devnet compiler",
    "deploy disposable devnet probe Circle/program",
    "append synthetic rows for each row-count candidate",
    "record effort, receipt, read sizes, and verification timings",
    "choose candidate A, B, C, or stop"
  ]
};

console.log(`${JSON.stringify(report, null, 2)}\n`);
