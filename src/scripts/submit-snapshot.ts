#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { circleProgramViewAtUrl, configuredProgrammedCircleId, stateTargetMode, type StateTargetMode } from "../lib/circle-program.js";
import { contractCall, contractCallAtUrl, contractReceipt, feeTelemetry, octraProgramRpcUrls, octraRpc, recommendedOu } from "../lib/octra-rpc.js";
import { loadOperatorWalletFromEnv, publicTransactionJson, signTransaction, transactionHash, type OctraTransaction } from "../lib/octra-transaction.js";
import {
  decodeHistoryV1CapsuleMeta,
  historyV1CapsuleBodyHashHex,
  historyV1CapsuleMetaHashHex,
  historyV1FoldCapsulesRootHex,
  historyV1FoldHistoryRootHex,
  historyV1RowHashHex,
  HISTORY_V1_ROW_LEN
} from "../lib/aml-history-v1.js";
import { parseSummaryWindow } from "../lib/summary-window.js";
import type { RecordSnapshotCall, RecordSnapshotCallV1 } from "./build-record-snapshot-call.js";

export interface SubmitSnapshotOptions {
  dataDir?: string | null;
  generatedAt?: string;
  outPath?: string;
  pendingSubmissionPath?: string | null;
  submitEnabled?: boolean;
  waitForConfirmations?: boolean;
  writeLatestReceipt?: boolean;
}

export interface WriteLatestReceiptOptions {
  dataDir?: string | null | undefined;
  path?: string | undefined;
}

const root = resolve(new URL("../..", import.meta.url).pathname);

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function isDirectCli(metaUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(resolve(argvPath));
  } catch {
    return fileURLToPath(metaUrl) === resolve(argvPath);
  }
}

function minProgramRpcUrls(forceMultiRpc: boolean): number {
  const configured = process.env.VITALS_MIN_PROGRAM_RPC_URLS;
  const parsed = configured ? Number(configured) : forceMultiRpc ? 2 : 1;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("VITALS_MIN_PROGRAM_RPC_URLS must be a positive integer");
  }
  return Math.max(forceMultiRpc ? 2 : 1, parsed);
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function configuredProgramAddress(call: RecordSnapshotCall): string | null {
  const value = process.env.VITALS_STATE_PROGRAM_ADDRESS || call.program_address;
  if (!value || value === "pending") return null;
  return value;
}

async function nextNonce(address: string): Promise<number> {
  const balance = await octraRpc<any>("octra_balance", [address]);
  const nonce = Number(balance?.pending_nonce ?? balance?.nonce ?? 0);
  if (!Number.isInteger(nonce) || nonce < 0) throw new Error(`invalid nonce response for ${address}`);
  return nonce + 1;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function txStatus(tx: any): string {
  return String(tx?.status || tx?.transaction?.status || "");
}

function txError(tx: any): unknown {
  return tx?.error || tx?.receipt?.error || tx?.reject_reason || tx?.reject_type || null;
}

function txSummary(tx: any): Record<string, unknown> | null {
  if (!tx || typeof tx !== "object") return null;
  const summary: Record<string, unknown> = {};
  for (const key of ["hash", "status", "op_type", "from", "to_", "nonce", "epoch", "amount_raw", "ou", "reject_type", "reject_reason"]) {
    if (key in tx) summary[key] = tx[key];
  }
  const error = txError(tx);
  if (error) summary.error = error;
  return summary;
}

async function pollTx(hash: string, attempts = 45): Promise<any> {
  let latest: any = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(2000);
    try {
      latest = await octraRpc<any>("octra_transaction", [hash]);
      const status = txStatus(latest);
      if (status === "confirmed" || status === "rejected") return latest;
    } catch {
      // Newly submitted transactions may not be queryable immediately.
    }
  }
  return latest || await octraRpc<any>("octra_transaction", [hash]);
}

async function requireConfirmed(hash: string, label: string, waitForConfirmations: boolean): Promise<any> {
  if (!waitForConfirmations) return null;
  const tx = await pollTx(hash);
  if (txStatus(tx) !== "confirmed") {
    throw new Error(`${label} did not confirm: ${JSON.stringify(txSummary(tx) || tx)}`);
  }
  return tx;
}

async function writeTextAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, text);
  await rename(tmpPath, path);
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, stableJson(value));
}

export async function writeSubmitSnapshotReport(report: unknown, outPath: string): Promise<void> {
  await writeJsonAtomic(outPath, report);
}

export async function writeLatestReceipt(report: Record<string, any>, options: WriteLatestReceiptOptions = {}): Promise<void> {
  const dataDir = options.dataDir ?? process.env.VITALS_DATA_DIR;
  const receiptPath = options.path || (dataDir ? join(dataDir, "latest_submit_receipt.json") : null);
  if (!receiptPath) return;
  await writeJsonAtomic(receiptPath, {
    schema: "octra-vitals-latest-submit-receipt-v0",
    generated_at: report.generated_at,
    run_id: report.run_id || null,
    program_address: report.program_address,
    target_kind: report.target_kind || "state_program",
    programmed_circle_id: report.programmed_circle_id || null,
    operator_address: report.operator_address,
    commit_mode: report.commit_mode,
    snapshot_id: report.snapshot_id,
    snapshot_index: report.snapshot_index || null,
    status: report.status,
    tx_hash: report.tx_hash,
    tx_hashes: report.tx_hashes,
    nonces: report.nonces,
    confirmations: report.confirmations,
    native_receipts: report.native_receipts || null,
    readback: report.readback,
    expected_hashes: report.expected_hashes,
    fee_telemetry: report.fee_telemetry || null,
    timings_ms: report.timings_ms || null,
    paths: report.paths || null
  });
}

function snapshotIdOfCall(call: RecordSnapshotCall): string | null {
  return typeof call.params[0] === "string" ? call.params[0] : null;
}

function summarizeReport(report: unknown, outPath: string): unknown {
  if (!report || typeof report !== "object") return report;
  const value = report as Record<string, any>;
  return {
    schema: value.schema,
    status: value.status,
    generated_at: value.generated_at,
    run_id: value.run_id,
    submit_enabled: value.submit_enabled,
    program_address: value.program_address,
    operator_address: value.operator_address,
    commit_mode: value.commit_mode,
    call_count: value.call_count,
    compact_message_bytes: value.compact_message_bytes,
    tx_hash: value.tx_hash,
    tx_hashes: value.tx_hashes,
    nonce: value.nonce,
    nonces: value.nonces,
    ou: value.ou,
    missing_requirements: value.missing_requirements,
    expected_hashes: value.expected_hashes || value.call?.expected_hashes,
    native_receipts: value.native_receipts || null,
    timings_ms: value.timings_ms,
    report_path: outPath
  };
}

function receiptSummary(receipt: any): Record<string, unknown> | null {
  if (!receipt || typeof receipt !== "object") return null;
  return {
    contract: receipt.contract || null,
    method: receipt.method || null,
    success: receipt.success ?? null,
    effort: receipt.effort ?? null,
    epoch: receipt.epoch ?? null,
    ts: receipt.ts ?? null,
    error: receipt.error ?? null,
    events: Array.isArray(receipt.events)
      ? receipt.events.map((event: any) => ({
        contract: event?.contract || null,
        event: event?.event || null,
        values: Array.isArray(event?.values) ? event.values : []
      }))
      : []
  };
}

function verifySnapshotReceipt(receipt: any, targetId: string, call: RecordSnapshotCall): Record<string, unknown> {
  const summary = receiptSummary(receipt);
  if (!summary) throw new Error("contract_receipt returned an empty receipt");
  const events = Array.isArray((summary as any).events) ? (summary as any).events : [];
  const snapshotEvent = events.find((event: any) => event.event === "SnapshotRecorded");
  const values = Array.isArray(snapshotEvent?.values) ? snapshotEvent.values : [];
  const snapshotId = snapshotIdOfCall(call);
  if (call.commit_mode === "v1") {
    const checks = {
      contract_matches: summary.contract === targetId,
      method_matches: summary.method === call.method,
      success: summary.success === true,
      snapshot_event_present: Boolean(snapshotEvent),
      snapshot_id_matches: snapshotId ? values[0] === snapshotId : false,
      snapshot_index_matches: call.snapshot_index ? String(values[1]) === String(call.snapshot_index) : true,
      payload_hash_matches: values[3] === call.expected_hashes.payload_hash,
      history_row_hash_matches: values[4] === call.expected_hashes.history_row_hash
    };
    const ok = Object.values(checks).every(Boolean);
    if (!ok) {
      throw new Error(`contract_receipt did not match submitted v1 snapshot: ${JSON.stringify(checks)}`);
    }
    return {
      ...summary,
      verified_against_call: true,
      checks
    };
  }
  const checks = {
    contract_matches: summary.contract === targetId,
    method_matches: summary.method === call.method,
    success: summary.success === true,
    snapshot_event_present: Boolean(snapshotEvent),
    snapshot_id_matches: snapshotId ? values[0] === snapshotId : false,
    snapshot_index_matches: call.snapshot_index ? String(values[1]) === String(call.snapshot_index) : true,
    payload_hash_matches: values[3] === call.expected_hashes.payload_hash,
    evidence_hash_matches: values[4] === call.expected_hashes.evidence_manifest_hash,
    source_refs_hash_matches: values[5] === call.expected_hashes.source_refs_hash,
    summary_hash_matches: call.expected_hashes.summary_hash ? values[6] === call.expected_hashes.summary_hash : true
  };
  const ok = Object.values(checks).every(Boolean);
  if (!ok) {
    throw new Error(`contract_receipt did not match submitted snapshot: ${JSON.stringify(checks)}`);
  }
  return {
    ...summary,
    verified_against_call: true,
    checks
  };
}

async function readAndVerifyProgramReadbackV0(programAddress: string, call: RecordSnapshotCall): Promise<Record<string, unknown>> {
  const [latestPayloadHash, latestEvidenceHash, latestSourceRefsHash, latestSummaryHash, latestSummary, latestIndex, window, windowHash, firstIndex, rowCount] = await Promise.all([
    contractCall<string>(programAddress, "get_latest_payload_hash"),
    contractCall<string>(programAddress, "get_latest_evidence_manifest_hash"),
    contractCall<string>(programAddress, "get_latest_source_refs_hash"),
    contractCall<string>(programAddress, "get_latest_summary_hash"),
    contractCall<string>(programAddress, "get_latest_summary"),
    contractCall<number>(programAddress, "get_latest_snapshot_index"),
    contractCall<string>(programAddress, "get_recent_summary_window"),
    contractCall<string>(programAddress, "get_recent_summary_window_hash"),
    contractCall<number>(programAddress, "get_recent_summary_window_first_index"),
    contractCall<number>(programAddress, "get_recent_summary_window_row_count")
  ]);
  if (latestPayloadHash !== call.expected_hashes.payload_hash) {
    throw new Error(`readback payload hash mismatch: expected ${call.expected_hashes.payload_hash}, got ${latestPayloadHash}`);
  }
  if (latestEvidenceHash !== call.expected_hashes.evidence_manifest_hash) {
    throw new Error(`readback evidence hash mismatch: expected ${call.expected_hashes.evidence_manifest_hash}, got ${latestEvidenceHash}`);
  }
  if (latestSourceRefsHash !== call.expected_hashes.source_refs_hash) {
    throw new Error(`readback source refs hash mismatch: expected ${call.expected_hashes.source_refs_hash}, got ${latestSourceRefsHash}`);
  }
  if (call.expected_hashes.summary_hash && latestSummaryHash !== call.expected_hashes.summary_hash) {
    throw new Error(`readback summary hash mismatch: expected ${call.expected_hashes.summary_hash}, got ${latestSummaryHash}`);
  }
  if (call.summary?.row && latestSummary !== call.summary.row) {
    throw new Error("readback latest summary row does not match submitted summary row");
  }
  if (call.snapshot_index && Number(latestIndex) !== call.snapshot_index) {
    throw new Error(`readback latest index mismatch: expected ${call.snapshot_index}, got ${latestIndex}`);
  }
  const parsedWindow = parseSummaryWindow(window || "", Number(firstIndex || 0), Number(rowCount || 0), windowHash);
  if (call.summary?.row && !(window || "").endsWith(call.summary.row)) {
    throw new Error("readback summary window does not end with submitted summary row");
  }

  return {
    payload_hash: latestPayloadHash,
    evidence_manifest_hash: latestEvidenceHash,
    source_refs_hash: latestSourceRefsHash,
    summary_hash: latestSummaryHash,
    latest_summary_row: latestSummary,
    latest_snapshot_index: latestIndex,
    summary_window_hash: parsedWindow.window_hash,
    summary_window_rows: parsedWindow.row_count,
    matches_expected: true
  };
}

async function readAndVerifyProgramReadbackV1(programAddress: string, call: RecordSnapshotCallV1): Promise<Record<string, unknown>> {
  const [
    latestPayloadHash,
    latestEvidenceHash,
    latestSourceRefsHash,
    latestSummaryHash,
    latestSummary,
    latestIndex,
    latestHistoryRow,
    latestHistoryRowHash,
    historyRoot,
    capsulesRoot,
    openCapsuleBody,
    openCapsuleRowCount,
    openCapsuleEndRoot,
    capsuleCount,
    latestCapsuleId,
    latestCapsuleRootAfter
  ] = await Promise.all([
    contractCall<string>(programAddress, "get_latest_payload_hash"),
    contractCall<string>(programAddress, "get_latest_evidence_manifest_hash"),
    contractCall<string>(programAddress, "get_latest_source_refs_hash"),
    contractCall<string>(programAddress, "get_latest_summary_hash"),
    contractCall<string>(programAddress, "get_latest_summary"),
    contractCall<number>(programAddress, "get_latest_snapshot_index"),
    contractCall<string>(programAddress, "get_latest_history_row"),
    contractCall<string>(programAddress, "get_latest_history_row_hash"),
    contractCall<string>(programAddress, "get_history_root"),
    contractCall<string>(programAddress, "get_capsules_root"),
    contractCall<string>(programAddress, "get_open_capsule_body"),
    contractCall<number>(programAddress, "get_open_capsule_row_count"),
    contractCall<string>(programAddress, "get_open_capsule_end_root"),
    contractCall<number>(programAddress, "get_capsule_count"),
    contractCall<string>(programAddress, "get_latest_capsule_id"),
    contractCall<string>(programAddress, "get_latest_capsule_root_after")
  ]);
  const latestCapsuleBody = Number(openCapsuleRowCount || 0) === 0 && latestCapsuleId
    ? await contractCall<string>(programAddress, "get_history_capsule_body", [latestCapsuleId])
    : "";
  const latestCapsuleMeta = Number(openCapsuleRowCount || 0) === 0 && latestCapsuleId
    ? await contractCall<string>(programAddress, "get_history_capsule_meta", [latestCapsuleId])
    : "";
  return verifyV1Readback({
    call,
    latestPayloadHash,
    latestEvidenceHash,
    latestSourceRefsHash,
    latestSummaryHash,
    latestSummary,
    latestIndex,
    latestHistoryRow,
    latestHistoryRowHash,
    historyRoot,
    capsulesRoot,
    openCapsuleBody,
    openCapsuleRowCount,
    openCapsuleEndRoot,
    capsuleCount,
    latestCapsuleId,
    latestCapsuleRootAfter,
    latestCapsuleBody,
    latestCapsuleMeta
  });
}

async function readAndVerifyProgramReadback(programAddress: string, call: RecordSnapshotCall): Promise<Record<string, unknown>> {
  return call.commit_mode === "v1"
    ? readAndVerifyProgramReadbackV1(programAddress, call)
    : readAndVerifyProgramReadbackV0(programAddress, call);
}

async function readAndVerifyCircleReadbackFromUrlV0(circleId: string, call: RecordSnapshotCall, url: string): Promise<Record<string, unknown>> {
  const [latestPayloadHash, latestEvidenceHash, latestSourceRefsHash, latestSummaryHash, latestSummary, latestIndex, window, windowHash, firstIndex, rowCount] = await Promise.all([
    circleProgramViewAtUrl<string>(url, circleId, "get_latest_payload_hash"),
    circleProgramViewAtUrl<string>(url, circleId, "get_latest_evidence_manifest_hash"),
    circleProgramViewAtUrl<string>(url, circleId, "get_latest_source_refs_hash"),
    circleProgramViewAtUrl<string>(url, circleId, "get_latest_summary_hash"),
    circleProgramViewAtUrl<string>(url, circleId, "get_latest_summary"),
    circleProgramViewAtUrl<number>(url, circleId, "get_latest_snapshot_index"),
    circleProgramViewAtUrl<string>(url, circleId, "get_recent_summary_window"),
    circleProgramViewAtUrl<string>(url, circleId, "get_recent_summary_window_hash"),
    circleProgramViewAtUrl<number>(url, circleId, "get_recent_summary_window_first_index"),
    circleProgramViewAtUrl<number>(url, circleId, "get_recent_summary_window_row_count")
  ]);
  if (latestPayloadHash !== call.expected_hashes.payload_hash) {
    throw new Error(`readback payload hash mismatch: expected ${call.expected_hashes.payload_hash}, got ${latestPayloadHash}`);
  }
  if (latestEvidenceHash !== call.expected_hashes.evidence_manifest_hash) {
    throw new Error(`readback evidence hash mismatch: expected ${call.expected_hashes.evidence_manifest_hash}, got ${latestEvidenceHash}`);
  }
  if (latestSourceRefsHash !== call.expected_hashes.source_refs_hash) {
    throw new Error(`readback source refs hash mismatch: expected ${call.expected_hashes.source_refs_hash}, got ${latestSourceRefsHash}`);
  }
  if (call.expected_hashes.summary_hash && latestSummaryHash !== call.expected_hashes.summary_hash) {
    throw new Error(`readback summary hash mismatch: expected ${call.expected_hashes.summary_hash}, got ${latestSummaryHash}`);
  }
  if (call.summary?.row && latestSummary !== call.summary.row) {
    throw new Error("readback latest summary row does not match submitted summary row");
  }
  if (call.snapshot_index && Number(latestIndex) !== call.snapshot_index) {
    throw new Error(`readback latest index mismatch: expected ${call.snapshot_index}, got ${latestIndex}`);
  }
  const parsedWindow = parseSummaryWindow(window || "", Number(firstIndex || 0), Number(rowCount || 0), windowHash);
  if (call.summary?.row && !(window || "").endsWith(call.summary.row)) {
    throw new Error("readback summary window does not end with submitted summary row");
  }

  return {
    payload_hash: latestPayloadHash,
    evidence_manifest_hash: latestEvidenceHash,
    source_refs_hash: latestSourceRefsHash,
    summary_hash: latestSummaryHash,
    latest_summary_row: latestSummary,
    latest_snapshot_index: latestIndex,
    summary_window_hash: parsedWindow.window_hash,
    summary_window_rows: parsedWindow.row_count,
    rpc_url: url,
    matches_expected: true
  };
}

function verifyV1Readback(input: {
  call: RecordSnapshotCallV1;
  latestPayloadHash: string;
  latestEvidenceHash: string;
  latestSourceRefsHash: string;
  latestSummaryHash: string;
  latestSummary: string;
  latestIndex: number;
  latestHistoryRow: string;
  latestHistoryRowHash: string;
  historyRoot: string;
  capsulesRoot: string;
  openCapsuleBody: string;
  openCapsuleRowCount: number;
  openCapsuleEndRoot: string;
  capsuleCount: number;
  latestCapsuleId: string;
  latestCapsuleRootAfter: string;
  latestCapsuleBody?: string;
  latestCapsuleMeta?: string;
  rpc_url?: string;
}): Record<string, unknown> {
  const {
    call,
    latestPayloadHash,
    latestEvidenceHash,
    latestSourceRefsHash,
    latestSummaryHash,
    latestSummary,
    latestIndex,
    latestHistoryRow,
    latestHistoryRowHash,
    historyRoot,
    capsulesRoot,
    openCapsuleBody,
    openCapsuleRowCount,
    openCapsuleEndRoot,
    capsuleCount,
    latestCapsuleId,
    latestCapsuleRootAfter,
    latestCapsuleBody,
    latestCapsuleMeta,
    rpc_url
  } = input;
  if (latestPayloadHash !== call.expected_hashes.payload_hash) {
    throw new Error(`readback payload hash mismatch: expected ${call.expected_hashes.payload_hash}, got ${latestPayloadHash}`);
  }
  if (latestEvidenceHash !== call.expected_hashes.evidence_manifest_hash) {
    throw new Error(`readback evidence hash mismatch: expected ${call.expected_hashes.evidence_manifest_hash}, got ${latestEvidenceHash}`);
  }
  if (latestSourceRefsHash !== call.expected_hashes.source_refs_hash) {
    throw new Error(`readback source refs hash mismatch: expected ${call.expected_hashes.source_refs_hash}, got ${latestSourceRefsHash}`);
  }
  if (latestSummaryHash !== call.expected_hashes.summary_hash) {
    throw new Error(`readback summary hash mismatch: expected ${call.expected_hashes.summary_hash}, got ${latestSummaryHash}`);
  }
  if (latestSummary !== call.summary.row) {
    throw new Error("readback latest summary row does not match submitted summary row");
  }
  if (latestHistoryRow !== call.history.row) {
    throw new Error("readback latest history row does not match submitted history row");
  }
  const recomputedHistoryRowHash = historyV1RowHashHex(latestHistoryRow);
  if (recomputedHistoryRowHash !== latestHistoryRowHash) {
    throw new Error(`readback latest history row hash is not faithful: expected ${recomputedHistoryRowHash}, got ${latestHistoryRowHash}`);
  }
  if (latestHistoryRowHash !== call.expected_hashes.history_row_hash) {
    throw new Error(`readback history row hash mismatch: expected ${call.expected_hashes.history_row_hash}, got ${latestHistoryRowHash}`);
  }
  if (Number(latestIndex) !== call.snapshot_index) {
    throw new Error(`readback latest index mismatch: expected ${call.snapshot_index}, got ${latestIndex}`);
  }
  if (Number(openCapsuleRowCount || 0) > 0) {
    if (!openCapsuleBody.endsWith(call.history.row)) {
      throw new Error("readback open capsule body does not end with submitted history row");
    }
    const rowLen = call.history.row.length;
    if (openCapsuleBody.length !== Number(openCapsuleRowCount || 0) * rowLen) {
      throw new Error("readback open capsule body length does not match open capsule row count");
    }
  } else if (latestCapsuleBody) {
    if (!latestCapsuleBody.endsWith(call.history.row)) {
      throw new Error("readback latest sealed capsule body does not end with submitted history row");
    }
  }
  if (historyRoot !== openCapsuleEndRoot) {
    throw new Error("readback history root does not match open capsule end root");
  }
  let latestCapsuleVerified = false;
  if (latestCapsuleId) {
    if (!latestCapsuleBody || !latestCapsuleMeta) {
      throw new Error("readback latest sealed capsule is missing body or metadata");
    }
    const meta = decodeHistoryV1CapsuleMeta(latestCapsuleMeta);
    if (meta.capsule_id !== latestCapsuleId) {
      throw new Error(`readback latest capsule id mismatch: expected ${latestCapsuleId}, got ${meta.capsule_id}`);
    }
    const rowCount = Number(meta.row_count);
    if (rowCount < 1) throw new Error("readback latest sealed capsule row count is empty");
    if (latestCapsuleBody.length !== rowCount * HISTORY_V1_ROW_LEN) {
      throw new Error("readback latest sealed capsule body length does not match metadata row count");
    }
    const rows: string[] = [];
    for (let offset = 0; offset < latestCapsuleBody.length; offset += HISTORY_V1_ROW_LEN) {
      rows.push(latestCapsuleBody.slice(offset, offset + HISTORY_V1_ROW_LEN));
    }
    const bodyHash = historyV1CapsuleBodyHashHex(latestCapsuleBody);
    if (bodyHash !== meta.body_hash_hex) {
      throw new Error(`readback latest sealed capsule body hash mismatch: expected ${meta.body_hash_hex}, got ${bodyHash}`);
    }
    const metaHash = historyV1CapsuleMetaHashHex(latestCapsuleMeta);
    const endRoot = historyV1FoldHistoryRootHex(meta.start_root_hex, rows);
    if (endRoot !== meta.end_root_hex) {
      throw new Error(`readback latest sealed capsule end root mismatch: expected ${meta.end_root_hex}, got ${endRoot}`);
    }
    const rootAfter = historyV1FoldCapsulesRootHex(meta.capsules_root_before_hex, meta.capsule_id, bodyHash, metaHash, endRoot);
    if (rootAfter !== latestCapsuleRootAfter) {
      throw new Error(`readback latest sealed capsule root-after mismatch: expected ${latestCapsuleRootAfter}, got ${rootAfter}`);
    }
    if (capsulesRoot !== latestCapsuleRootAfter) {
      throw new Error("readback capsules root does not match latest sealed capsule root-after");
    }
    latestCapsuleVerified = true;
  }
  return {
    payload_hash: latestPayloadHash,
    evidence_manifest_hash: latestEvidenceHash,
    source_refs_hash: latestSourceRefsHash,
    summary_hash: latestSummaryHash,
    latest_summary_row: latestSummary,
    latest_snapshot_index: latestIndex,
    history_row_hash: latestHistoryRowHash,
    history_root: historyRoot,
    capsules_root: capsulesRoot,
    open_capsule_rows: Number(openCapsuleRowCount || 0),
    capsule_count: Number(capsuleCount || 0),
    latest_capsule_id: latestCapsuleId || null,
    latest_capsule_root_after: latestCapsuleRootAfter || null,
    latest_capsule_verified: latestCapsuleVerified,
    ...(rpc_url ? { rpc_url } : {}),
    matches_expected: true
  };
}

async function readAndVerifyCircleReadbackFromUrlV1(circleId: string, call: RecordSnapshotCallV1, url: string): Promise<Record<string, unknown>> {
  const [
    latestPayloadHash,
    latestEvidenceHash,
    latestSourceRefsHash,
    latestSummaryHash,
    latestSummary,
    latestIndex,
    latestHistoryRow,
    latestHistoryRowHash,
    historyRoot,
    capsulesRoot,
    openCapsuleBody,
    openCapsuleRowCount,
    openCapsuleEndRoot,
    capsuleCount,
    latestCapsuleId,
    latestCapsuleRootAfter
  ] = await Promise.all([
    circleProgramViewAtUrl<string>(url, circleId, "get_latest_payload_hash"),
    circleProgramViewAtUrl<string>(url, circleId, "get_latest_evidence_manifest_hash"),
    circleProgramViewAtUrl<string>(url, circleId, "get_latest_source_refs_hash"),
    circleProgramViewAtUrl<string>(url, circleId, "get_latest_summary_hash"),
    circleProgramViewAtUrl<string>(url, circleId, "get_latest_summary"),
    circleProgramViewAtUrl<number>(url, circleId, "get_latest_snapshot_index"),
    circleProgramViewAtUrl<string>(url, circleId, "get_latest_history_row"),
    circleProgramViewAtUrl<string>(url, circleId, "get_latest_history_row_hash"),
    circleProgramViewAtUrl<string>(url, circleId, "get_history_root"),
    circleProgramViewAtUrl<string>(url, circleId, "get_capsules_root"),
    circleProgramViewAtUrl<string>(url, circleId, "get_open_capsule_body"),
    circleProgramViewAtUrl<number>(url, circleId, "get_open_capsule_row_count"),
    circleProgramViewAtUrl<string>(url, circleId, "get_open_capsule_end_root"),
    circleProgramViewAtUrl<number>(url, circleId, "get_capsule_count"),
    circleProgramViewAtUrl<string>(url, circleId, "get_latest_capsule_id"),
    circleProgramViewAtUrl<string>(url, circleId, "get_latest_capsule_root_after")
  ]);
  const [latestCapsuleBody, latestCapsuleMeta] = latestCapsuleId
    ? await Promise.all([
      circleProgramViewAtUrl<string>(url, circleId, "get_history_capsule_body", [latestCapsuleId]),
      circleProgramViewAtUrl<string>(url, circleId, "get_history_capsule_meta", [latestCapsuleId])
    ])
    : ["", ""];
  return verifyV1Readback({
    call,
    latestPayloadHash,
    latestEvidenceHash,
    latestSourceRefsHash,
    latestSummaryHash,
    latestSummary,
    latestIndex,
    latestHistoryRow,
    latestHistoryRowHash,
    historyRoot,
    capsulesRoot,
    openCapsuleBody,
    openCapsuleRowCount,
    openCapsuleEndRoot,
    capsuleCount,
    latestCapsuleId,
    latestCapsuleRootAfter,
    latestCapsuleBody,
    latestCapsuleMeta,
    rpc_url: url
  });
}

async function readAndVerifyCircleReadbackFromUrl(circleId: string, call: RecordSnapshotCall, url: string): Promise<Record<string, unknown>> {
  return call.commit_mode === "v1"
    ? readAndVerifyCircleReadbackFromUrlV1(circleId, call, url)
    : readAndVerifyCircleReadbackFromUrlV0(circleId, call, url);
}

function assertSameCircleReadback(primary: Record<string, unknown>, candidate: Record<string, unknown>): void {
  for (const key of ["payload_hash", "evidence_manifest_hash", "source_refs_hash", "summary_hash", "latest_summary_row", "latest_snapshot_index", "summary_window_hash", "summary_window_rows", "history_row_hash", "history_root", "capsules_root", "open_capsule_rows", "capsule_count", "latest_capsule_id", "latest_capsule_root_after", "latest_capsule_verified"]) {
    if (!(key in primary) && !(key in candidate)) continue;
    if (candidate[key] !== primary[key]) {
      throw new Error(`programmed Circle readback RPC mismatch for ${key} from ${candidate.rpc_url}`);
    }
  }
}

async function readAndVerifyCircleReadback(circleId: string, call: RecordSnapshotCall): Promise<Record<string, unknown>> {
  const urls = octraProgramRpcUrls();
  const [primaryUrl, ...otherUrls] = urls;
  if (!primaryUrl) throw new Error("no Octra program RPC URL configured");
  const primary = await readAndVerifyCircleReadbackFromUrl(circleId, call, primaryUrl);
  if (!otherUrls.length) return primary;
  const candidates = await Promise.all(otherUrls.map((url) => readAndVerifyCircleReadbackFromUrl(circleId, call, url)));
  for (const candidate of candidates) assertSameCircleReadback(primary, candidate);
  return {
    ...primary,
    rpc_agreement: true,
    rpc_urls_checked: urls.length
  };
}

function targetIdForCall(call: RecordSnapshotCall, targetKind: StateTargetMode): string | null {
  if (targetKind === "circle_program") return configuredProgrammedCircleId() || call.circle_id || null;
  return configuredProgramAddress(call);
}

async function readAndVerifyTargetReadback(targetKind: StateTargetMode, targetId: string, call: RecordSnapshotCall): Promise<Record<string, unknown>> {
  return targetKind === "circle_program"
    ? readAndVerifyCircleReadback(targetId, call)
    : readAndVerifyProgramReadback(targetId, call);
}

function isRpcAgreementError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /RPC mismatch|RPC disagreement|program history RPC mismatch|programmed Circle readback RPC mismatch/i.test(message);
}

async function alreadyRecordedReadback(targetKind: StateTargetMode, targetId: string, call: RecordSnapshotCall): Promise<Record<string, unknown> | null> {
  try {
    return await readAndVerifyTargetReadback(targetKind, targetId, call);
  } catch (error) {
    if (isRpcAgreementError(error)) throw error;
    return null;
  }
}

async function readSnapshotCountAtUrl(targetKind: StateTargetMode, targetId: string, url: string): Promise<number> {
  const value = targetKind === "circle_program"
    ? await circleProgramViewAtUrl<number>(url, targetId, "get_snapshot_count")
    : await contractCallAtUrl<number>(url, targetId, "get_snapshot_count");
  return Number(value || 0);
}

async function assertPreSubmitState(targetKind: StateTargetMode, targetId: string, call: RecordSnapshotCall): Promise<Record<string, unknown>> {
  const urls = octraProgramRpcUrls();
  const minUrls = minProgramRpcUrls(process.env.VITALS_REQUIRE_MULTI_RPC_FOR_SUBMIT === "1");
  if (urls.length < minUrls) {
    throw new Error(`at least ${minUrls} Octra program RPC URL(s) are required before snapshot submit; got ${urls.length}`);
  }
  const counts = await Promise.all(urls.map(async (url) => ({
    url,
    count: await readSnapshotCountAtUrl(targetKind, targetId, url)
  })));
  const [primary, ...rest] = counts;
  if (!primary) throw new Error("no Octra program RPC URL configured");
  for (const candidate of rest) {
    if (candidate.count !== primary.count) {
      throw new Error(`program RPC mismatch from ${candidate.url}: get_snapshot_count`);
    }
  }
  const expectedPrior = Number(call.snapshot_index || 0) - 1;
  if (primary.count !== expectedPrior) {
    throw new Error(`pre-submit state advanced or drifted: expected snapshot_count ${expectedPrior}, got ${primary.count}`);
  }
  return {
    snapshot_count: primary.count,
    expected_prior_snapshot_count: expectedPrior,
    rpc_urls_checked: urls.length,
    rpc_agreement: true
  };
}

export async function submitSnapshotCall(
  call: RecordSnapshotCall,
  options: SubmitSnapshotOptions = {}
): Promise<Record<string, any>> {
  if (
    !(
      (call.schema === "octra-vitals-record-snapshot-call-v0" && call.method === "record_snapshot_v0") ||
      (call.schema === "octra-vitals-record-snapshot-call-v1" && call.method === "record_snapshot_v1")
    ) ||
    !Array.isArray(call.params)
  ) {
    throw new Error("not a supported record_snapshot call bundle");
  }

  const submitEnabled = options.submitEnabled ?? process.env.VITALS_SUBMIT === "1";
  const waitForConfirmations = options.waitForConfirmations ?? process.env.VITALS_SUBMIT_WAIT !== "0";
  const generatedAt = options.generatedAt || isoNow();
  const targetKind = stateTargetMode();
  const targetId = targetIdForCall(call, targetKind);
  const programAddress = targetKind === "state_program" ? targetId : configuredProgramAddress(call);
  const programmedCircleId = targetKind === "circle_program" ? targetId : null;
  const operatorAddress = process.env.VITALS_OPERATOR_ADDRESS || null;
  const missing = [
    targetId ? null : targetKind === "circle_program" ? "VITALS_PROGRAMMED_CIRCLE_ID" : "VITALS_STATE_PROGRAM_ADDRESS",
    operatorAddress ? null : "VITALS_OPERATOR_ADDRESS"
  ].filter((value): value is string => Boolean(value));

  if (!submitEnabled) {
    return {
      schema: "octra-vitals-submit-snapshot-report-v0",
      status: "dry_run",
      generated_at: generatedAt,
      submit_enabled: false,
      target_kind: targetKind,
      program_address: programAddress || "pending",
      programmed_circle_id: programmedCircleId || "pending",
      operator_address: operatorAddress || "pending",
      missing_requirements: missing,
      commit_mode: call.commit_mode || "v0",
      call_count: 1,
      compact_message_bytes: call.compact_message_bytes || null,
      call: {
        method: call.method,
        params: call.params,
        snapshot_index: call.snapshot_index || null,
        summary: call.summary || null,
        history: call.commit_mode === "v1" ? call.history : null,
        expected_hashes: call.expected_hashes
      },
      next_step: targetKind === "circle_program"
        ? "set VITALS_PROGRAMMED_CIRCLE_ID, VITALS_OPERATOR_ADDRESS, VITALS_OPERATOR_PRIVATE_KEY_B64, VITALS_STATE_TARGET_MODE=circle_program, and VITALS_SUBMIT=1 on the target host to submit"
        : "set VITALS_STATE_PROGRAM_ADDRESS, VITALS_OPERATOR_ADDRESS, VITALS_OPERATOR_PRIVATE_KEY_B64, and VITALS_SUBMIT=1 on the target host to submit"
    };
  }

  if (!targetId) throw new Error(`${targetKind === "circle_program" ? "VITALS_PROGRAMMED_CIRCLE_ID" : "VITALS_STATE_PROGRAM_ADDRESS"} is required when VITALS_SUBMIT=1`);

  const existingReadback = await alreadyRecordedReadback(targetKind, targetId, call);
  if (existingReadback) {
    const report = {
      schema: "octra-vitals-submit-snapshot-report-v0",
      status: "already_recorded",
      generated_at: generatedAt,
      submit_enabled: true,
      target_kind: targetKind,
      program_address: programAddress || "pending",
      programmed_circle_id: programmedCircleId || null,
      operator_address: operatorAddress || "pending",
      commit_mode: call.commit_mode || "v0",
      snapshot_id: snapshotIdOfCall(call),
      snapshot_index: existingReadback.latest_snapshot_index,
      call_count: 0,
      compact_message_bytes: call.compact_message_bytes || null,
      tx_hash: null,
      tx_hashes: [],
      nonce: null,
      nonces: [],
      confirmations: [],
      expected_hashes: call.expected_hashes,
      readback: existingReadback,
      readonly_check: {
        method: call.commit_mode === "v1"
          ? "get_latest_payload_hash/get_latest_summary_hash/get_latest_history_row_hash"
          : "get_latest_payload_hash/get_latest_summary_hash/get_recent_summary_window_hash",
        expected_after_confirm: call.expected_hashes.payload_hash,
        actual_after_confirm: existingReadback.payload_hash
      }
    };
    if (options.writeLatestReceipt !== false) {
      await writeLatestReceipt(report, { dataDir: options.dataDir });
    }
    return report;
  }

  const preSubmitState = await assertPreSubmitState(targetKind, targetId, call);
  const wallet = loadOperatorWalletFromEnv();
  if (!wallet) throw new Error("VITALS_OPERATOR_PRIVATE_KEY_B64 is required when VITALS_SUBMIT=1");

  const nonce = await nextNonce(wallet.address);
  const opType = targetKind === "circle_program" ? "circle_call" : "call";
  const ou = process.env.VITALS_CALL_OU || await recommendedOu(opType, "1000");
  const fee = await feeTelemetry(opType);
  const callSpecs = [
    {
      label: call.method,
      method: call.method,
      params: call.params
    }
  ];

  const submissions = [];
  for (const [index, spec] of callSpecs.entries()) {
    const tx: OctraTransaction = {
      from: wallet.address,
      to_: targetId,
      amount: process.env.VITALS_CALL_AMOUNT_RAW || "0",
      nonce: nonce + index,
      ou,
      timestamp: Date.now() / 1000,
      op_type: opType,
      encrypted_data: spec.method,
      message: JSON.stringify(spec.params)
    };
    const signed = signTransaction(tx, wallet);
    const precomputedTxHash = transactionHash(signed);
    if (options.pendingSubmissionPath) {
      await writeJsonAtomic(options.pendingSubmissionPath, {
        schema: "octra-vitals-pending-submission-v0",
        generated_at: isoNow(),
        target_kind: targetKind,
        program_address: programAddress || "pending",
        programmed_circle_id: programmedCircleId || null,
        operator_address: wallet.address,
        snapshot_id: snapshotIdOfCall(call),
        snapshot_index: call.snapshot_index || null,
        method: spec.method,
        nonce: tx.nonce,
        tx_hash: precomputedTxHash,
        expected_hashes: call.expected_hashes
      });
    }
    const txJson = publicTransactionJson(signed);
    const submitResult = await octraRpc<any>("octra_submit", [txJson]);
    const txHash = submitResult?.tx_hash || submitResult?.hash || precomputedTxHash;
    submissions.push({
      label: spec.label,
      method: spec.method,
      nonce: tx.nonce,
      tx_hash: txHash,
      precomputed_tx_hash: precomputedTxHash,
      submit_result: submitResult
    });
  }
  const confirmations = [];
  const nativeReceipts = [];
  const requireReceipt = waitForConfirmations && process.env.VITALS_REQUIRE_CONTRACT_RECEIPT !== "0";
  for (const submission of submissions) {
    const confirmation = await requireConfirmed(submission.tx_hash, submission.label, waitForConfirmations);
    confirmations.push({
      label: submission.label,
      tx_hash: submission.tx_hash,
      status: confirmation ? txStatus(confirmation) : "not_waited",
      transaction: txSummary(confirmation)
    });
    if (waitForConfirmations) {
      try {
        const receipt = await contractReceipt(submission.tx_hash);
        nativeReceipts.push({
          label: submission.label,
          tx_hash: submission.tx_hash,
          receipt: verifySnapshotReceipt(receipt, targetId, call)
        });
      } catch (error) {
        if (requireReceipt) throw error;
        nativeReceipts.push({
          label: submission.label,
          tx_hash: submission.tx_hash,
          receipt: null,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  const readback = await readAndVerifyTargetReadback(targetKind, targetId, call);
  const report = {
    schema: "octra-vitals-submit-snapshot-report-v0",
    status: waitForConfirmations ? "confirmed" : "submitted",
    generated_at: generatedAt,
    submit_enabled: true,
    target_kind: targetKind,
    program_address: programAddress || "pending",
    programmed_circle_id: programmedCircleId || null,
    operator_address: wallet.address,
    commit_mode: call.commit_mode || "v0",
    snapshot_id: snapshotIdOfCall(call),
    snapshot_index: readback.latest_snapshot_index,
    call_count: callSpecs.length,
    compact_message_bytes: call.compact_message_bytes || null,
    tx_hash: submissions[submissions.length - 1]?.tx_hash,
    tx_hashes: submissions.map((submission) => submission.tx_hash),
    nonce,
    nonces: submissions.map((submission) => submission.nonce),
    ou,
    fee_telemetry: fee,
    submissions,
    confirmations,
    native_receipts: nativeReceipts,
    expected_hashes: call.expected_hashes,
    pre_submit_state: preSubmitState,
    readback,
    readonly_check: {
      method: call.commit_mode === "v1"
        ? "get_latest_payload_hash/get_latest_summary_hash/get_latest_history_row_hash"
        : "get_latest_payload_hash/get_latest_summary_hash/get_recent_summary_window_hash",
      expected_after_confirm: call.expected_hashes.payload_hash,
      actual_after_confirm: readback.payload_hash
    }
  };
  if (options.writeLatestReceipt !== false) {
    await writeLatestReceipt(report, { dataDir: options.dataDir });
  }
  return report;
}

async function main(): Promise<void> {
  const inputPath = process.argv[2] || join(root, "build", "record_snapshot_call.json");
  const outPath = process.argv[3] || join(root, "build", "submit_snapshot.json");
  const call = JSON.parse(await readFile(inputPath, "utf8")) as RecordSnapshotCall;
  const report = await submitSnapshotCall(call, { outPath });
  await writeSubmitSnapshotReport(report, outPath);
  console.log(stableJson(summarizeReport(report, outPath)));
}

if (isDirectCli(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
