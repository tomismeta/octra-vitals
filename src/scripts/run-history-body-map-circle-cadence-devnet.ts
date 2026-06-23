#!/usr/bin/env node
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { contractReceipt, octraProgramRpcUrl, octraRpc, recommendedOu } from "../lib/octra-rpc.js";
import { loadWalletFromEnv, publicTransactionJson, signTransaction, transactionHash, type OctraTransaction, type OperatorWallet } from "../lib/octra-transaction.js";
import {
  HISTORY_ROW_LEN,
  capsuleMetaHashHex,
  capsuleTxIndexHashHex,
  encodeHistoryRow,
  foldCapsulesRootHex,
  makeCapsule,
  makeTxIndex,
  syntheticHistoryRow,
  type HistoryObservationRow
} from "../lib/aml-history-probe.js";

interface CompileArtifact {
  schema: "octra-vitals-history-body-map-probe-compile-v1";
  source_hash: string;
  bytecode_hash: string;
  verification_hash: string;
  bytecode: string;
  verification?: {
    verified?: boolean;
    safety?: string;
    errors?: number;
    warnings?: number;
  };
}

interface SubmittedCall {
  method: string;
  nonce: number;
  tx_hash: string;
  receipt: Record<string, unknown> | null;
  elapsed_ms: number;
}

interface ProgressCapsule {
  capsule_number: number;
  capsule_id: string;
  status: "open" | "sealed";
  row_count: number;
  first_index: number;
  last_index: number;
  start_root_hex: string;
  end_root_hex: string | null;
  body_hash_hex: string | null;
  meta_hash_hex: string | null;
  tx_index_hash_hex: string | null;
  append_tx_hashes: string[];
  append_calls: SubmittedCall[];
  seal: SubmittedCall | null;
  capsules_root_after_seal: string | null;
}

interface ProgressFile {
  schema: "octra-vitals-history-body-map-circle-cadence-progress-v1";
  status: "initialized" | "running" | "partial" | "completed" | "failed";
  generated_at: string;
  updated_at: string;
  rpc_url: string;
  wallet_address: string;
  circle_id: string;
  base_capsule_count: number;
  target_capsules: number;
  row_limit: number;
  next_index: number;
  running_history_root: string;
  running_capsules_root: string;
  source_hash: string;
  bytecode_hash: string;
  verification_hash: string;
  capsules: ProgressCapsule[];
  error: string | null;
}

const root = resolve(new URL("../..", import.meta.url).pathname);
const compilePath = join(root, "build", "program-history-body-map-probe", "compile.json");
const submitEnabled = process.env.VITALS_HISTORY_BODY_MAP_CIRCLE_CADENCE_SUBMIT === "1";
const submitAck = process.env.VITALS_HISTORY_BODY_MAP_CIRCLE_CADENCE_ACK === "1";
const waitForConfirmations = process.env.VITALS_HISTORY_BODY_MAP_CIRCLE_CADENCE_WAIT !== "0";

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isoStamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function reportPath(): string {
  const configured = process.env.VITALS_HISTORY_BODY_MAP_CIRCLE_CADENCE_REPORT;
  if (configured) return configured;
  return join(root, "reports", `aml-history-body-map-circle-cadence-devnet-${isoStamp().replace(/[:]/g, "")}.json`);
}

function progressPath(outputPath: string): string {
  return process.env.VITALS_HISTORY_BODY_MAP_CIRCLE_CADENCE_PROGRESS || `${outputPath}.progress.json`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, stableJson(value));
  await rename(tempPath, path);
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

function txSummary(tx: any): Record<string, unknown> | null {
  if (!tx || typeof tx !== "object") return null;
  const summary: Record<string, unknown> = {};
  for (const key of ["hash", "status", "op_type", "from", "to_", "nonce", "epoch", "amount_raw", "ou", "reject_type", "reject_reason"]) {
    if (key in tx) summary[key] = tx[key];
  }
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
      // Fresh transactions may not be indexed immediately.
    }
  }
  return latest || await octraRpc<any>("octra_transaction", [hash]);
}

async function requireConfirmed(hash: string, label: string): Promise<void> {
  if (!waitForConfirmations) return;
  const tx = await pollTx(hash);
  if (txStatus(tx) !== "confirmed") {
    throw new Error(`${label} did not confirm: ${JSON.stringify(txSummary(tx) || tx)}`);
  }
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
        event: event?.event || null,
        values: Array.isArray(event?.values) ? event.values : []
      }))
      : []
  };
}

async function submitTx(wallet: OperatorWallet, tx: OctraTransaction, label: string): Promise<{ tx_hash: string; nonce: number; elapsed_ms: number }> {
  const signed = signTransaction(tx, wallet);
  const txJson = publicTransactionJson(signed);
  const started = Date.now();
  let submitResult: any;
  try {
    submitResult = await octraRpc<any>("octra_submit", [txJson], { retry: false });
  } catch (error) {
    const messageBytes = tx.message ? Buffer.byteLength(tx.message, "utf8") : 0;
    const dataBytes = tx.encrypted_data ? Buffer.byteLength(tx.encrypted_data, "utf8") : 0;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} submit failed nonce=${tx.nonce} op_type=${tx.op_type} message_bytes=${messageBytes} data_bytes=${dataBytes}: ${detail}`);
  }
  const txHash = submitResult?.tx_hash || submitResult?.hash || transactionHash(signed);
  await requireConfirmed(txHash, label);
  return {
    tx_hash: txHash,
    nonce: tx.nonce,
    elapsed_ms: Date.now() - started
  };
}

async function submitCircleCall(
  wallet: OperatorWallet,
  circleId: string,
  method: string,
  params: unknown[],
  nonce: number,
  ou: string
): Promise<SubmittedCall> {
  const submitted = await submitTx(wallet, {
    from: wallet.address,
    to_: circleId,
    amount: "0",
    nonce,
    ou,
    timestamp: Date.now() / 1000,
    op_type: "circle_call",
    encrypted_data: method,
    message: JSON.stringify(params)
  }, method);
  let receipt: Record<string, unknown> | null = null;
  if (waitForConfirmations) {
    receipt = receiptSummary(await contractReceipt(submitted.tx_hash));
  }
  return {
    method,
    nonce: submitted.nonce,
    tx_hash: submitted.tx_hash,
    receipt,
    elapsed_ms: submitted.elapsed_ms
  };
}

async function circleView<T = any>(circleId: string, method: string, params: unknown[], caller: string): Promise<T> {
  const result = await octraRpc<any>("octra_circleView", [circleId, method, params, caller, false]);
  if (result && typeof result === "object" && "result" in result) return result.result as T;
  return result as T;
}

function configuredRowsPerRun(): number {
  const value = Number(process.env.VITALS_HISTORY_BODY_MAP_CIRCLE_CADENCE_ROWS_PER_RUN || "1");
  if (!Number.isInteger(value) || value <= 0 || value > 96) {
    throw new Error("VITALS_HISTORY_BODY_MAP_CIRCLE_CADENCE_ROWS_PER_RUN must be a positive integer no greater than 96");
  }
  return value;
}

function configuredTargetCapsules(currentCapsules: number): number {
  const configured = process.env.VITALS_HISTORY_BODY_MAP_CIRCLE_CADENCE_TARGET_CAPSULES;
  if (!configured) return currentCapsules + 1;
  const value = Number(configured);
  if (!Number.isInteger(value) || value <= currentCapsules || value > currentCapsules + 24) {
    throw new Error("VITALS_HISTORY_BODY_MAP_CIRCLE_CADENCE_TARGET_CAPSULES must be greater than the current capsule count and within 24 new capsules");
  }
  return value;
}

function configuredCircleId(): string {
  const value = process.env.VITALS_HISTORY_BODY_MAP_CIRCLE_CADENCE_CIRCLE_ID || process.env.VITALS_HISTORY_BODY_MAP_CIRCLE_PROBE_EXISTING_CIRCLE_ID || "";
  if (!/^oct[1-9A-HJ-NP-Za-km-z]{30,}$/.test(value)) {
    throw new Error("set VITALS_HISTORY_BODY_MAP_CIRCLE_CADENCE_CIRCLE_ID to a devnet programmed Circle id");
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

function rowsForCapsule(firstIndex: number, rowLimit: number): HistoryObservationRow[] {
  return Array.from({ length: rowLimit }, (_, offset) => syntheticProbeRow(firstIndex + offset));
}

function buildCapsuleFromProgress(capsule: ProgressCapsule): ReturnType<typeof makeCapsule> & { tx_index: string } {
  const rows = rowsForCapsule(capsule.first_index, capsule.row_count);
  const txIndex = makeTxIndex(capsule.append_tx_hashes);
  return {
    ...makeCapsule(rows, {
      capsuleId: capsule.capsule_id,
      startRootHex: capsule.start_root_hex,
      txIndex
    }),
    tx_index: txIndex
  };
}

function publicCapsuleReport(capsule: ProgressCapsule): Record<string, unknown> {
  const rebuilt = capsule.status === "sealed" ? buildCapsuleFromProgress(capsule) : null;
  return {
    capsule_number: capsule.capsule_number,
    capsule_id: capsule.capsule_id,
    status: capsule.status,
    row_count: capsule.row_count,
    first_index: capsule.first_index,
    last_index: capsule.last_index,
    body_bytes: rebuilt?.body.length ?? capsule.append_tx_hashes.length * HISTORY_ROW_LEN,
    meta_bytes: rebuilt?.meta_row.length ?? null,
    tx_index_bytes: rebuilt?.tx_index.length ?? capsule.append_tx_hashes.length * 64,
    body_hash_hex: rebuilt?.body_hash_hex ?? capsule.body_hash_hex,
    meta_hash_hex: rebuilt?.meta_hash_hex ?? capsule.meta_hash_hex,
    tx_index_hash_hex: rebuilt ? capsuleTxIndexHashHex(rebuilt.tx_index) : capsule.tx_index_hash_hex,
    start_root_hex: capsule.start_root_hex,
    end_root_hex: rebuilt?.meta.end_root_hex ?? capsule.end_root_hex,
    append_efforts: capsule.append_calls.map((append) => append.receipt?.effort ?? null),
    append_elapsed_ms: capsule.append_calls.map((append) => append.elapsed_ms),
    append_tx_hashes: capsule.append_tx_hashes,
    seal: capsule.seal,
    capsules_root_after_seal: capsule.capsules_root_after_seal
  };
}

async function validateCircleState(progress: ProgressFile): Promise<void> {
  const [snapshotCount, capsuleCount, capsulesRoot, openCount, openEndRoot] = await Promise.all([
    circleView<number | string>(progress.circle_id, "get_snapshot_count", [], progress.wallet_address),
    circleView<number | string>(progress.circle_id, "get_capsule_count", [], progress.wallet_address),
    circleView<string>(progress.circle_id, "get_capsules_root", [], progress.wallet_address),
    circleView<number | string>(progress.circle_id, "get_open_capsule_row_count", [], progress.wallet_address),
    circleView<string>(progress.circle_id, "get_open_capsule_end_root", [], progress.wallet_address)
  ]);
  const openCapsule = progress.capsules.find((capsule) => capsule.status === "open") || null;
  if (Number(snapshotCount) !== progress.next_index - 1) {
    throw new Error(`Circle snapshot_count ${snapshotCount} != progress ${progress.next_index - 1}`);
  }
  if (Number(capsuleCount) !== progress.base_capsule_count + progress.capsules.filter((capsule) => capsule.status === "sealed").length) {
    throw new Error("Circle capsule count did not match progress");
  }
  if (String(capsulesRoot) !== progress.running_capsules_root) {
    throw new Error("Circle capsules_root did not match progress");
  }
  if (Number(openCount) !== (openCapsule?.append_tx_hashes.length ?? 0)) {
    throw new Error("Circle open capsule row count did not match progress");
  }
  if (String(openEndRoot) !== progress.running_history_root) {
    throw new Error("Circle open end root did not match progress");
  }
}

async function createProgress(
  wallet: OperatorWallet,
  artifact: CompileArtifact,
  circleId: string,
  targetCapsules: number,
  progressFilePath: string
): Promise<ProgressFile> {
  const [manifest, rowLimit, snapshotCount, capsuleCount, capsulesRoot, openCount, openEndRoot] = await Promise.all([
    circleView<string>(circleId, "manifest", [], wallet.address),
    circleView<number | string>(circleId, "get_capsule_row_limit", [], wallet.address),
    circleView<number | string>(circleId, "get_snapshot_count", [], wallet.address),
    circleView<number | string>(circleId, "get_capsule_count", [], wallet.address),
    circleView<string>(circleId, "get_capsules_root", [], wallet.address),
    circleView<number | string>(circleId, "get_open_capsule_row_count", [], wallet.address),
    circleView<string>(circleId, "get_open_capsule_end_root", [], wallet.address)
  ]);
  if (manifest !== "octra-vitals-history-body-map-probe.v1") {
    throw new Error(`unexpected Circle manifest: ${manifest}`);
  }
  if (Number(openCount) !== 0) {
    throw new Error("cannot start Circle cadence progress from a Circle with open rows; resume with an existing progress file");
  }
  const progress: ProgressFile = {
    schema: "octra-vitals-history-body-map-circle-cadence-progress-v1",
    status: "initialized",
    generated_at: isoStamp(),
    updated_at: isoStamp(),
    rpc_url: octraProgramRpcUrl(),
    wallet_address: wallet.address,
    circle_id: circleId,
    base_capsule_count: Number(capsuleCount),
    target_capsules: targetCapsules,
    row_limit: Number(rowLimit),
    next_index: Number(snapshotCount) + 1,
    running_history_root: String(openEndRoot),
    running_capsules_root: String(capsulesRoot),
    source_hash: artifact.source_hash,
    bytecode_hash: artifact.bytecode_hash,
    verification_hash: artifact.verification_hash,
    capsules: [],
    error: null
  };
  await writeJson(progressFilePath, progress);
  return progress;
}

async function readback(progress: ProgressFile): Promise<Record<string, unknown>> {
  const [programInfo, manifest, snapshotCount, capsuleCount, capsulesRoot, openCount, openEndRoot, latestCapsuleId] = await Promise.all([
    octraRpc<any>("octra_circleProgramInfo", [progress.circle_id]),
    circleView<string>(progress.circle_id, "manifest", [], progress.wallet_address),
    circleView<number | string>(progress.circle_id, "get_snapshot_count", [], progress.wallet_address),
    circleView<number | string>(progress.circle_id, "get_capsule_count", [], progress.wallet_address),
    circleView<string>(progress.circle_id, "get_capsules_root", [], progress.wallet_address),
    circleView<number | string>(progress.circle_id, "get_open_capsule_row_count", [], progress.wallet_address),
    circleView<string>(progress.circle_id, "get_open_capsule_end_root", [], progress.wallet_address),
    circleView<string>(progress.circle_id, "get_latest_capsule_id", [], progress.wallet_address)
  ]);
  const capsuleReadbacks = await Promise.all(progress.capsules.filter((capsule) => capsule.status === "sealed").map(async (capsule) => {
    const rebuilt = buildCapsuleFromProgress(capsule);
    const [body, meta, txIndex] = await Promise.all([
      circleView<string>(progress.circle_id, "get_capsule_body", [capsule.capsule_id], progress.wallet_address),
      circleView<string>(progress.circle_id, "get_capsule_meta", [capsule.capsule_id], progress.wallet_address),
      circleView<string>(progress.circle_id, "get_capsule_tx_index", [capsule.capsule_id], progress.wallet_address)
    ]);
    return {
      capsule_id: capsule.capsule_id,
      body_bytes: body.length,
      meta_bytes: meta.length,
      tx_index_bytes: txIndex.length,
      body_matches: body === rebuilt.body,
      meta_matches: meta === rebuilt.meta_row,
      tx_index_matches: txIndex === rebuilt.tx_index
    };
  }));
  return {
    program_info: programInfo,
    manifest,
    snapshot_count: snapshotCount,
    capsule_count: capsuleCount,
    capsules_root: capsulesRoot,
    capsules_root_matches: String(capsulesRoot) === progress.running_capsules_root,
    open_capsule_row_count: openCount,
    open_capsule_end_root: openEndRoot,
    open_capsule_end_root_matches: String(openEndRoot) === progress.running_history_root,
    latest_capsule_id: latestCapsuleId,
    capsule_readbacks: capsuleReadbacks
  };
}

async function saveProgress(path: string, progress: ProgressFile): Promise<void> {
  progress.updated_at = isoStamp();
  await writeJson(path, progress);
}

async function writeReport(path: string, progress: ProgressFile, status: "partial" | "submitted"): Promise<void> {
  await writeJson(path, {
    schema: "octra-vitals-history-body-map-circle-cadence-run-v1",
    status,
    generated_at: isoStamp(),
    rpc_url: progress.rpc_url,
    wallet_address: progress.wallet_address,
    circle_id: progress.circle_id,
    base_capsule_count: progress.base_capsule_count,
    target_capsules: progress.target_capsules,
    row_limit: progress.row_limit,
    rows_recorded: progress.next_index - 1,
    source_hash: progress.source_hash,
    bytecode_hash: progress.bytecode_hash,
    verification_hash: progress.verification_hash,
    capsules: progress.capsules.map(publicCapsuleReport),
    readback: await readback(progress)
  });
}

async function run(): Promise<void> {
  const rpcUrl = octraProgramRpcUrl();
  if (!/devnet/i.test(rpcUrl)) {
    throw new Error(`refusing to run history body-map Circle cadence against non-devnet RPC: ${rpcUrl}`);
  }
  const artifact = JSON.parse(await readFile(compilePath, "utf8")) as CompileArtifact;
  if (artifact.schema !== "octra-vitals-history-body-map-probe-compile-v1" || !artifact.bytecode) {
    throw new Error(`${compilePath} is not a compiled history body-map probe artifact`);
  }
  if (!artifact.verification || artifact.verification.verified !== true || artifact.verification.safety !== "safe" || artifact.verification.errors !== 0 || artifact.verification.warnings !== 0) {
    throw new Error("history body-map probe compile artifact is not formally safe");
  }
  const circleId = configuredCircleId();
  const rowsPerRun = configuredRowsPerRun();
  const outputPath = reportPath();
  const progressFilePath = progressPath(outputPath);

  if (!submitEnabled) {
    const [snapshotCount, capsuleCount, openCount] = await Promise.all([
      circleView<number | string>(circleId, "get_snapshot_count", [], process.env.VITALS_OPERATOR_ADDRESS || process.env.VITALS_DEPLOYER_ADDRESS || ""),
      circleView<number | string>(circleId, "get_capsule_count", [], process.env.VITALS_OPERATOR_ADDRESS || process.env.VITALS_DEPLOYER_ADDRESS || ""),
      circleView<number | string>(circleId, "get_open_capsule_row_count", [], process.env.VITALS_OPERATOR_ADDRESS || process.env.VITALS_DEPLOYER_ADDRESS || "")
    ]);
    await writeJson(outputPath, {
      schema: "octra-vitals-history-body-map-circle-cadence-run-v1",
      status: "dry_run",
      generated_at: isoStamp(),
      rpc_url: rpcUrl,
      circle_id: circleId,
      snapshot_count: snapshotCount,
      capsule_count: capsuleCount,
      open_capsule_row_count: openCount,
      rows_per_run: rowsPerRun,
      source_hash: artifact.source_hash,
      bytecode_hash: artifact.bytecode_hash,
      verification_hash: artifact.verification_hash,
      progress_path: progressFilePath
    });
    console.log(stableJson({
      status: "dry_run",
      report_path: outputPath,
      progress_path: progressFilePath,
      circle_id: circleId,
      rows_per_run: rowsPerRun
    }));
    return;
  }
  if (!submitAck) throw new Error("set VITALS_HISTORY_BODY_MAP_CIRCLE_CADENCE_ACK=1 to acknowledge devnet Circle cadence submission");
  const wallet = loadWalletFromEnv({
    privateKeyEnv: ["VITALS_HISTORY_PROBE_PRIVATE_KEY_B64"],
    addressEnv: ["VITALS_HISTORY_PROBE_ADDRESS"],
    label: "history body-map Circle cadence wallet"
  });
  if (!wallet) throw new Error("history body-map Circle cadence requires VITALS_HISTORY_PROBE_PRIVATE_KEY_B64");

  let progress: ProgressFile;
  if (await pathExists(progressFilePath)) {
    progress = JSON.parse(await readFile(progressFilePath, "utf8")) as ProgressFile;
    if (progress.schema !== "octra-vitals-history-body-map-circle-cadence-progress-v1") throw new Error("invalid progress file schema");
    if (progress.wallet_address !== wallet.address) throw new Error("progress wallet address does not match current wallet");
    if (progress.circle_id !== circleId) throw new Error("progress Circle id does not match current Circle id");
    progress.target_capsules = Math.max(progress.target_capsules, configuredTargetCapsules(progress.base_capsule_count));
    progress.status = "running";
    progress.error = null;
    await saveProgress(progressFilePath, progress);
  } else {
    const currentCapsules = Number(await circleView<number | string>(circleId, "get_capsule_count", [], wallet.address));
    progress = await createProgress(wallet, artifact, circleId, configuredTargetCapsules(currentCapsules), progressFilePath);
    progress.status = "running";
    await saveProgress(progressFilePath, progress);
  }

  await validateCircleState(progress);
  const callOu = process.env.VITALS_HISTORY_BODY_MAP_CIRCLE_CADENCE_CALL_OU || await recommendedOu("circle_call", "1000");
  let nonce = await nextNonce(wallet.address);
  let rowsAppendedThisRun = 0;

  while (progress.base_capsule_count + progress.capsules.filter((capsule) => capsule.status === "sealed").length < progress.target_capsules) {
    let capsule = progress.capsules.find((candidate) => candidate.status === "open") || null;
    if (!capsule) {
      const firstIndex = progress.next_index;
      const preview = makeCapsule(rowsForCapsule(firstIndex, progress.row_limit), {
        startRootHex: progress.running_history_root
      });
      capsule = {
        capsule_number: progress.base_capsule_count + progress.capsules.length + 1,
        capsule_id: preview.meta.capsule_id,
        status: "open",
        row_count: progress.row_limit,
        first_index: firstIndex,
        last_index: firstIndex + progress.row_limit - 1,
        start_root_hex: progress.running_history_root,
        end_root_hex: null,
        body_hash_hex: null,
        meta_hash_hex: null,
        tx_index_hash_hex: null,
        append_tx_hashes: [],
        append_calls: [],
        seal: null,
        capsules_root_after_seal: null
      };
      progress.capsules.push(capsule);
      await saveProgress(progressFilePath, progress);
    }

    while (capsule.append_tx_hashes.length < capsule.row_count && rowsAppendedThisRun < rowsPerRun) {
      const rowIndex = capsule.first_index + capsule.append_tx_hashes.length;
      const row = syntheticProbeRow(rowIndex);
      const append = await submitCircleCall(wallet, progress.circle_id, "append_probe_row", [capsule.capsule_id, row.snapshot_index, encodeHistoryRow(row)], nonce, callOu);
      nonce += 1;
      rowsAppendedThisRun += 1;
      capsule.append_calls.push(append);
      capsule.append_tx_hashes.push(append.tx_hash);
      progress.next_index = rowIndex + 1;
      progress.running_history_root = String(await circleView<string>(progress.circle_id, "get_open_capsule_end_root", [], wallet.address));
      await saveProgress(progressFilePath, progress);
    }

    if (capsule.append_tx_hashes.length === capsule.row_count) {
      const rebuilt = buildCapsuleFromProgress(capsule);
      const seal = await submitCircleCall(wallet, progress.circle_id, "seal_and_rotate", [rebuilt.meta_row, rebuilt.tx_index], nonce, callOu);
      nonce += 1;
      progress.running_history_root = rebuilt.meta.end_root_hex;
      progress.running_capsules_root = foldCapsulesRootHex(
        progress.running_capsules_root,
        rebuilt.meta.capsule_id,
        rebuilt.body_hash_hex,
        rebuilt.meta_hash_hex,
        rebuilt.meta.end_root_hex
      );
      capsule.status = "sealed";
      capsule.end_root_hex = rebuilt.meta.end_root_hex;
      capsule.body_hash_hex = rebuilt.body_hash_hex;
      capsule.meta_hash_hex = rebuilt.meta_hash_hex;
      capsule.tx_index_hash_hex = capsuleTxIndexHashHex(rebuilt.tx_index);
      capsule.seal = seal;
      capsule.capsules_root_after_seal = progress.running_capsules_root;
      await saveProgress(progressFilePath, progress);
      await validateCircleState(progress);
    }

    if (rowsAppendedThisRun >= rowsPerRun) break;
  }

  const completed = progress.base_capsule_count + progress.capsules.filter((capsule) => capsule.status === "sealed").length >= progress.target_capsules;
  progress.status = completed ? "completed" : "partial";
  progress.error = null;
  await saveProgress(progressFilePath, progress);
  await writeReport(outputPath, progress, completed ? "submitted" : "partial");
  console.log(stableJson({
    status: completed ? "submitted" : "partial",
    rpc_url: progress.rpc_url,
    circle_id: progress.circle_id,
    target_capsules: progress.target_capsules,
    row_limit: progress.row_limit,
    rows_appended_this_run: rowsAppendedThisRun,
    rows_recorded: progress.next_index - 1,
    report_path: outputPath,
    progress_path: progressFilePath,
    capsules_root: progress.running_capsules_root
  }));
}

const outputPathForFailure = reportPath();
const progressFilePathForFailure = progressPath(outputPathForFailure);
try {
  await run();
} catch (error) {
  if (await pathExists(progressFilePathForFailure)) {
    try {
      const progress = JSON.parse(await readFile(progressFilePathForFailure, "utf8")) as ProgressFile;
      progress.status = "failed";
      progress.error = error instanceof Error ? error.message : String(error);
      await saveProgress(progressFilePathForFailure, progress);
    } catch {
      // The thrown error below is more useful than a failed diagnostic write.
    }
  }
  throw error;
}
