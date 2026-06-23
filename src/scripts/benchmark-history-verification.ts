#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  HISTORY_ROW_LEN,
  capsuleBodyHashHex,
  capsuleMetaHashHex,
  capsuleTxIndexHashHex,
  decodeHistoryRow,
  emptyCapsulesRootHex,
  emptyHistoryRootHex,
  foldCapsulesRootHex,
  foldHistoryRootHex,
  makeCapsule,
  makeTxIndex,
  syntheticHistoryRow,
  syntheticTxHash,
  type HistoryCapsule,
  type HistoryObservationRow
} from "../lib/aml-history-probe.js";
import {
  decodeHistoryV1Row,
  encodeHistoryV1Row,
  historyV1CapsuleBodyHashHex,
  historyV1CapsuleMetaFromBody,
  historyV1CapsuleMetaHashHex,
  historyV1EmptyCapsulesRootHex,
  historyV1EmptyHistoryRootHex,
  historyV1FoldCapsulesRootHex,
  HISTORY_V1_CAPSULE_ROW_LIMIT,
  HISTORY_V1_ROW_LEN,
  type HistoryV1ObservationRow
} from "../lib/aml-history-v1.js";

const root = resolve(new URL("../..", import.meta.url).pathname);

interface BenchmarkCapsule extends HistoryCapsule {
  tx_index: string;
}

interface BenchmarkCase {
  label: string;
  days: number;
  capsules: number;
}

interface BenchmarkV1Capsule {
  capsule_id: string;
  body: string;
  meta_row: string;
  body_hash_hex: string;
  meta_hash_hex: string;
  end_root_hex: string;
  root_after_hex: string;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isoStamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function reportPath(): string {
  return process.env.VITALS_HISTORY_VERIFY_BENCHMARK_REPORT ||
    join(root, "reports", `history-verification-benchmark-${isoStamp().replace(/[:]/g, "")}.json`);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stableJson(value));
}

function configuredIterations(): number {
  const value = Number(process.env.VITALS_HISTORY_VERIFY_BENCHMARK_ITERATIONS || "5");
  if (!Number.isInteger(value) || value <= 0 || value > 100) {
    throw new Error("VITALS_HISTORY_VERIFY_BENCHMARK_ITERATIONS must be 1..100");
  }
  return value;
}

function syntheticProbeRow(index: number): HistoryObservationRow {
  return syntheticHistoryRow(index, {
    issued_raw: String(622000000000000n + BigInt(index) * 1000n),
    total_locked_raw: String(200000000000000n + BigInt(index) * 1000n),
    total_wrapped_raw: String(190000000000000n + BigInt(index) * 1000n),
    total_unclaimed_raw: String(10000000000000n + BigInt(index) * 1000n)
  });
}

function syntheticV1Row(index: number): HistoryV1ObservationRow {
  return {
    row_version: "00",
    snapshot_index: index,
    observed_at_unix: 1780000000 + index * 900,
    octra_epoch: 1000000 + index,
    external_block: 25000000 + index,
    max_supply_raw: "1000000000000000",
    issued_raw: String(622000000000000n + BigInt(index) * 1000n),
    burned_raw: String(378000000000000n - BigInt(index) * 1000n),
    encrypted_raw: "12413100000000",
    total_locked_raw: String(200000000000000n + BigInt(index) * 1000n),
    total_wrapped_raw: String(190000000000000n + BigInt(index) * 1000n),
    total_unclaimed_raw: String(10000000000000n + BigInt(index) * 1000n),
    vault_balance_raw: String(200000000000000n + BigInt(index) * 1000n),
    unit_status: "00",
    conservation_status: "G",
    route_count: 1,
    payload_hash_hex: syntheticTxHash(index)
  };
}

function buildCapsules(capsuleCount: number, rowLimit: number): { capsules: BenchmarkCapsule[]; capsulesRoot: string } {
  const capsules: BenchmarkCapsule[] = [];
  let nextIndex = 1;
  let historyRoot = emptyHistoryRootHex();
  let capsulesRoot = emptyCapsulesRootHex();
  for (let capsuleIndex = 0; capsuleIndex < capsuleCount; capsuleIndex += 1) {
    const rows = Array.from({ length: rowLimit }, (_, offset) => syntheticProbeRow(nextIndex + offset));
    const txIndex = makeTxIndex(rows.map((row) => syntheticTxHash(row.snapshot_index)));
    const capsule = makeCapsule(rows, {
      startRootHex: historyRoot,
      txIndex
    });
    const benchmarkCapsule = {
      ...capsule,
      tx_index: txIndex
    };
    capsules.push(benchmarkCapsule);
    historyRoot = capsule.meta.end_root_hex;
    capsulesRoot = foldCapsulesRootHex(
      capsulesRoot,
      capsule.meta.capsule_id,
      capsule.body_hash_hex,
      capsule.meta_hash_hex,
      capsule.meta.end_root_hex
    );
    nextIndex += rowLimit;
  }
  return { capsules, capsulesRoot };
}

function capsuleIdForIndex(capsuleIndex: number): string {
  const ms = Date.UTC(2026, 5, 7, 0, 0, 0) + capsuleIndex * 12 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 13);
}

function buildV1Capsules(capsuleCount: number): { capsules: BenchmarkV1Capsule[]; capsulesRoot: string } {
  const capsules: BenchmarkV1Capsule[] = [];
  let nextIndex = 1;
  let historyRoot = historyV1EmptyHistoryRootHex();
  let capsulesRoot = historyV1EmptyCapsulesRootHex();
  for (let capsuleIndex = 0; capsuleIndex < capsuleCount; capsuleIndex += 1) {
    const body = Array.from({ length: HISTORY_V1_CAPSULE_ROW_LIMIT }, (_, offset) => (
      encodeHistoryV1Row(syntheticV1Row(nextIndex + offset))
    )).join("");
    const capsule = historyV1CapsuleMetaFromBody({
      capsuleId: capsuleIdForIndex(capsuleIndex),
      body,
      startRootHex: historyRoot,
      capsulesRootBeforeHex: capsulesRoot
    });
    capsules.push({
      capsule_id: capsule.meta.capsule_id,
      body,
      meta_row: capsule.meta_row,
      body_hash_hex: capsule.body_hash_hex,
      meta_hash_hex: capsule.meta_hash_hex,
      end_root_hex: capsule.end_root_hex,
      root_after_hex: capsule.root_after_hex
    });
    historyRoot = capsule.end_root_hex;
    capsulesRoot = capsule.root_after_hex;
    nextIndex += HISTORY_V1_CAPSULE_ROW_LIMIT;
  }
  return { capsules, capsulesRoot };
}

function verifyCapsules(capsules: BenchmarkCapsule[], expectedCapsulesRoot: string): { rows: number; bytes: number; capsulesRoot: string } {
  let capsulesRoot = emptyCapsulesRootHex();
  let rows = 0;
  let bytes = 0;
  for (const capsule of capsules) {
    if (capsuleBodyHashHex(capsule.body) !== capsule.body_hash_hex) {
      throw new Error(`capsule ${capsule.meta.capsule_id} body hash mismatch`);
    }
    if (capsuleMetaHashHex(capsule.meta_row) !== capsule.meta_hash_hex) {
      throw new Error(`capsule ${capsule.meta.capsule_id} meta hash mismatch`);
    }
    if (capsuleTxIndexHashHex(capsule.tx_index) !== capsule.meta.tx_index_hash_hex) {
      throw new Error(`capsule ${capsule.meta.capsule_id} tx-index hash mismatch`);
    }
    const encodedRows: string[] = [];
    for (let offset = 0; offset < capsule.body.length; offset += HISTORY_ROW_LEN) {
      const encoded = capsule.body.slice(offset, offset + HISTORY_ROW_LEN);
      const decoded = decodeHistoryRow(encoded);
      if (decoded.snapshot_index !== capsule.meta.first_index + encodedRows.length) {
        throw new Error(`capsule ${capsule.meta.capsule_id} index mismatch`);
      }
      encodedRows.push(encoded);
    }
    if (encodedRows.length !== capsule.meta.row_count) {
      throw new Error(`capsule ${capsule.meta.capsule_id} row count mismatch`);
    }
    const endRoot = foldHistoryRootHex(capsule.meta.start_root_hex, encodedRows);
    if (endRoot !== capsule.meta.end_root_hex) {
      throw new Error(`capsule ${capsule.meta.capsule_id} end root mismatch`);
    }
    capsulesRoot = foldCapsulesRootHex(
      capsulesRoot,
      capsule.meta.capsule_id,
      capsule.body_hash_hex,
      capsule.meta_hash_hex,
      capsule.meta.end_root_hex
    );
    rows += encodedRows.length;
    bytes += capsule.body.length + capsule.meta_row.length + capsule.tx_index.length;
  }
  if (capsulesRoot !== expectedCapsulesRoot) {
    throw new Error("capsules root mismatch");
  }
  return { rows, bytes, capsulesRoot };
}

function verifyV1Capsules(capsules: BenchmarkV1Capsule[], expectedCapsulesRoot: string): { rows: number; bytes: number; capsulesRoot: string } {
  let capsulesRoot = historyV1EmptyCapsulesRootHex();
  let rows = 0;
  let bytes = 0;
  for (const capsule of capsules) {
    if (historyV1CapsuleBodyHashHex(capsule.body) !== capsule.body_hash_hex) {
      throw new Error(`v1 capsule ${capsule.capsule_id} body hash mismatch`);
    }
    if (historyV1CapsuleMetaHashHex(capsule.meta_row) !== capsule.meta_hash_hex) {
      throw new Error(`v1 capsule ${capsule.capsule_id} meta hash mismatch`);
    }
    const encodedRows: string[] = [];
    for (let offset = 0; offset < capsule.body.length; offset += HISTORY_V1_ROW_LEN) {
      const encoded = capsule.body.slice(offset, offset + HISTORY_V1_ROW_LEN);
      const decoded = decodeHistoryV1Row(encoded);
      if (decoded.snapshot_index !== rows + encodedRows.length + 1) {
        throw new Error(`v1 capsule ${capsule.capsule_id} index mismatch`);
      }
      encodedRows.push(encoded);
    }
    capsulesRoot = historyV1FoldCapsulesRootHex(
      capsulesRoot,
      capsule.capsule_id,
      capsule.body_hash_hex,
      capsule.meta_hash_hex,
      capsule.end_root_hex
    );
    if (capsulesRoot !== capsule.root_after_hex) {
      throw new Error(`v1 capsule ${capsule.capsule_id} root-after mismatch`);
    }
    rows += encodedRows.length;
    bytes += capsule.body.length + capsule.meta_row.length;
  }
  if (capsulesRoot !== expectedCapsulesRoot) {
    throw new Error("v1 capsules root mismatch");
  }
  return { rows, bytes, capsulesRoot };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  const value = sorted[midpoint];
  if (value === undefined) throw new Error("cannot compute median of empty list");
  if (sorted.length % 2 === 1) return value;
  const previous = sorted[midpoint - 1];
  if (previous === undefined) throw new Error("cannot compute median of malformed list");
  return (previous + value) / 2;
}

const rowLimit = 48;
const iterations = configuredIterations();
const cases: BenchmarkCase[] = [
  { label: "1d", days: 1, capsules: 2 },
  { label: "7d", days: 7, capsules: 14 },
  { label: "30d", days: 30, capsules: 60 },
  { label: "1y", days: 365, capsules: 730 }
];

const results = cases.map((benchmarkCase) => {
  const { capsules, capsulesRoot } = buildCapsules(benchmarkCase.capsules, rowLimit);
  const timings: number[] = [];
  let verified: ReturnType<typeof verifyCapsules> | null = null;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const started = performance.now();
    verified = verifyCapsules(capsules, capsulesRoot);
    timings.push(performance.now() - started);
  }
  if (!verified) throw new Error("benchmark did not run");
  return {
    label: benchmarkCase.label,
    days: benchmarkCase.days,
    row_limit: rowLimit,
    capsules: benchmarkCase.capsules,
    rows: verified.rows,
    bytes_verified: verified.bytes,
    iterations,
    min_ms: Number(Math.min(...timings).toFixed(3)),
    median_ms: Number(median(timings).toFixed(3)),
    max_ms: Number(Math.max(...timings).toFixed(3)),
    capsules_root: verified.capsulesRoot
  };
});

const v1Results = cases.map((benchmarkCase) => {
  const { capsules, capsulesRoot } = buildV1Capsules(benchmarkCase.capsules);
  const timings: number[] = [];
  let verified: ReturnType<typeof verifyV1Capsules> | null = null;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const started = performance.now();
    verified = verifyV1Capsules(capsules, capsulesRoot);
    timings.push(performance.now() - started);
  }
  if (!verified) throw new Error("v1 benchmark did not run");
  return {
    label: benchmarkCase.label,
    days: benchmarkCase.days,
    row_limit: HISTORY_V1_CAPSULE_ROW_LIMIT,
    capsules: benchmarkCase.capsules,
    rows: verified.rows,
    bytes_verified: verified.bytes,
    iterations,
    min_ms: Number(Math.min(...timings).toFixed(3)),
    median_ms: Number(median(timings).toFixed(3)),
    max_ms: Number(Math.max(...timings).toFixed(3)),
    capsules_root: verified.capsulesRoot
  };
});

const report = {
  schema: "octra-vitals-history-verification-benchmark-v1",
  generated_at: isoStamp(),
  runtime: "node",
  note: "Measures local capsule/body/root verification CPU only; it excludes RPC latency and browser layout/render cost.",
  results,
  production_v1_results: v1Results
};

const outputPath = reportPath();
await writeJson(outputPath, report);
console.log(stableJson({
  status: "ok",
  report_path: outputPath,
  results: results.map((result) => ({
    label: result.label,
    rows: result.rows,
    bytes_verified: result.bytes_verified,
    median_ms: result.median_ms
  })),
  production_v1_results: v1Results.map((result) => ({
    label: result.label,
    rows: result.rows,
    bytes_verified: result.bytes_verified,
    median_ms: result.median_ms
  }))
}));
