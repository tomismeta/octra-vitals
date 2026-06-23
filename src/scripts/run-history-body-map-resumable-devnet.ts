#!/usr/bin/env node
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { constants as fsConstants } from "node:fs";
import { contractCallAtUrl, contractReceipt, octraProgramRpcUrl, octraRpc, recommendedOu } from "../lib/octra-rpc.js";
import { loadWalletFromEnv, publicTransactionJson, signTransaction, transactionHash, type OctraTransaction, type OperatorWallet } from "../lib/octra-transaction.js";
import {
  capsuleMetaHashHex,
  capsuleTxIndexHashHex,
  emptyCapsulesRootHex,
  encodeHistoryRow,
  foldCapsulesRootHex,
  makeCapsule,
  makeTxIndex,
  syntheticHistoryRow,
  type HistoryCapsule,
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
  schema: "octra-vitals-history-body-map-progress-v1";
  status: "initialized" | "running" | "completed" | "failed";
  generated_at: string;
  updated_at: string;
  rpc_url: string;
  wallet_address: string;
  program_address: string;
  target_capsules: number;
  row_limit: number;
  next_index: number;
  running_history_root: string;
  running_capsules_root: string;
  source_hash: string;
  bytecode_hash: string;
  verification_hash: string;
  deploy: {
    tx_hash: string;
    nonce: number;
    ou: string;
    elapsed_ms: number;
  } | null;
  initialize: SubmittedCall | null;
  capsules: ProgressCapsule[];
  error: string | null;
}

const root = resolve(new URL("../..", import.meta.url).pathname);
const compilePath = join(root, "build", "program-history-body-map-probe", "compile.json");
const submitEnabled = process.env.VITALS_HISTORY_BODY_MAP_PROBE_SUBMIT === "1";
const submitAck = process.env.VITALS_HISTORY_BODY_MAP_PROBE_ACK === "1";
const resumeEnabled = process.env.VITALS_HISTORY_BODY_MAP_PROBE_RESUME === "1";
const waitForConfirmations = process.env.VITALS_HISTORY_BODY_MAP_PROBE_WAIT !== "0";

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isoStamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function reportPath(): string {
  const configured = process.env.VITALS_HISTORY_BODY_MAP_PROBE_REPORT;
  if (configured) return configured;
  return join(root, "reports", `aml-history-body-map-resumable-devnet-${isoStamp().replace(/[:]/g, "")}.json`);
}

function progressPath(outputPath: string): string {
  return process.env.VITALS_HISTORY_BODY_MAP_PROBE_PROGRESS || `${outputPath}.progress.json`;
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

async function computeProgramAddress(bytecode: string, deployer: string, nonce: number): Promise<string> {
  const result = await octraRpc<any>("octra_computeContractAddress", [bytecode, deployer, nonce]);
  const address = result?.address;
  if (!address || typeof address !== "string") throw new Error("octra_computeContractAddress did not return an address");
  return address;
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

async function requireConfirmed(hash: string, label: string): Promise<any> {
  if (!waitForConfirmations) return null;
  const tx = await pollTx(hash);
  if (txStatus(tx) !== "confirmed") {
    throw new Error(`${label} did not confirm: ${JSON.stringify(txSummary(tx) || tx)}`);
  }
  return tx;
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

async function submitCall(
  wallet: OperatorWallet,
  programAddress: string,
  method: string,
  params: unknown[],
  nonce: number,
  ou: string
): Promise<SubmittedCall> {
  const submitted = await submitTx(wallet, {
    from: wallet.address,
    to_: programAddress,
    amount: "0",
    nonce,
    ou,
    timestamp: Date.now() / 1000,
    op_type: "call",
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

function configuredTargetCapsuleCount(): number {
  const value = Number(process.env.VITALS_HISTORY_BODY_MAP_PROBE_CAPSULES || "2");
  if (!Number.isInteger(value) || value <= 0 || value > 24) throw new Error("VITALS_HISTORY_BODY_MAP_PROBE_CAPSULES must be 1..24");
  return value;
}

function configuredRowLimit(): number {
  const value = Number(process.env.VITALS_HISTORY_BODY_MAP_PROBE_ROW_LIMIT || "48");
  if (![12, 24, 48, 96].includes(value)) throw new Error("VITALS_HISTORY_BODY_MAP_PROBE_ROW_LIMIT must be one of 12,24,48,96");
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

function buildCapsuleFromProgress(capsule: ProgressCapsule): HistoryCapsule & { tx_index: string } {
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
    body_bytes: rebuilt?.body.length ?? capsule.append_tx_hashes.length * 295,
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

function progressFromSeedReport(
  seed: any,
  wallet: OperatorWallet,
  artifact: CompileArtifact,
  rpcUrl: string,
  targetCapsules: number,
  rowLimit: number
): ProgressFile {
  if (!seed || seed.schema !== "octra-vitals-history-body-map-probe-run-v1") {
    throw new Error("seed report must be a body-map probe run report");
  }
  if (Number(seed.row_limit) !== rowLimit) {
    throw new Error(`seed row_limit ${seed.row_limit} does not match configured row limit ${rowLimit}`);
  }
  const seedCapsules = Array.isArray(seed.stored_capsules) ? seed.stored_capsules : [];
  let runningCapsulesRoot = emptyCapsulesRootHex();
  let runningHistoryRoot = "";
  const capsules: ProgressCapsule[] = seedCapsules.map((capsule: any, index: number) => {
    const appendTxHashes = Array.isArray(capsule.append_tx_hashes) ? capsule.append_tx_hashes.map(String) : [];
    if (appendTxHashes.length !== rowLimit) throw new Error(`seed capsule ${index + 1} has ${appendTxHashes.length} tx hashes`);
    const record: ProgressCapsule = {
      capsule_number: Number(capsule.capsule_number ?? index + 1),
      capsule_id: String(capsule.capsule_id),
      status: "sealed",
      row_count: Number(capsule.row_count ?? rowLimit),
      first_index: Number(capsule.first_index),
      last_index: Number(capsule.last_index),
      start_root_hex: String(capsule.start_root_hex),
      end_root_hex: String(capsule.end_root_hex),
      body_hash_hex: String(capsule.body_hash_hex),
      meta_hash_hex: String(capsule.meta_hash_hex),
      tx_index_hash_hex: String(capsule.tx_index_hash_hex),
      append_tx_hashes: appendTxHashes,
      append_calls: appendTxHashes.map((txHash: string, offset: number) => ({
        method: "append_probe_row",
        nonce: 0,
        tx_hash: txHash,
        receipt: null,
        elapsed_ms: 0
      })),
      seal: capsule.seal || null,
      capsules_root_after_seal: String(capsule.capsules_root_after_seal)
    };
    const rebuilt = buildCapsuleFromProgress(record);
    if (rebuilt.body_hash_hex !== record.body_hash_hex) throw new Error(`seed capsule ${record.capsule_id} body hash mismatch`);
    if (rebuilt.meta_hash_hex !== record.meta_hash_hex) throw new Error(`seed capsule ${record.capsule_id} meta hash mismatch`);
    if (capsuleTxIndexHashHex(rebuilt.tx_index) !== record.tx_index_hash_hex) throw new Error(`seed capsule ${record.capsule_id} tx-index hash mismatch`);
    runningCapsulesRoot = foldCapsulesRootHex(
      runningCapsulesRoot,
      record.capsule_id,
      rebuilt.body_hash_hex,
      rebuilt.meta_hash_hex,
      rebuilt.meta.end_root_hex
    );
    if (runningCapsulesRoot !== record.capsules_root_after_seal) {
      throw new Error(`seed capsule ${record.capsule_id} capsules_root mismatch`);
    }
    runningHistoryRoot = rebuilt.meta.end_root_hex;
    return record;
  });
  if (!runningHistoryRoot && typeof seed.readback?.open_capsule_end_root === "string") {
    runningHistoryRoot = seed.readback.open_capsule_end_root;
  }
  if (!runningHistoryRoot) throw new Error("seed report did not provide a running history root");
  const lastCapsule = capsules[capsules.length - 1];
  const nextIndex = lastCapsule ? lastCapsule.last_index + 1 : 1;
  return {
    schema: "octra-vitals-history-body-map-progress-v1",
    status: "running",
    generated_at: isoStamp(),
    updated_at: isoStamp(),
    rpc_url: rpcUrl,
    wallet_address: wallet.address,
    program_address: String(seed.program_address),
    target_capsules: targetCapsules,
    row_limit: rowLimit,
    next_index: nextIndex,
    running_history_root: runningHistoryRoot,
    running_capsules_root: runningCapsulesRoot,
    source_hash: artifact.source_hash,
    bytecode_hash: artifact.bytecode_hash,
    verification_hash: artifact.verification_hash,
    deploy: seed.deploy || null,
    initialize: seed.initialize || null,
    capsules,
    error: null
  };
}

async function validateProgramState(progress: ProgressFile): Promise<void> {
  const [snapshotCount, capsuleCount, capsulesRoot, openCount, openEndRoot] = await Promise.all([
    contractCallAtUrl<number>(progress.rpc_url, progress.program_address, "get_snapshot_count"),
    contractCallAtUrl<number>(progress.rpc_url, progress.program_address, "get_capsule_count"),
    contractCallAtUrl<string>(progress.rpc_url, progress.program_address, "get_capsules_root"),
    contractCallAtUrl<number>(progress.rpc_url, progress.program_address, "get_open_capsule_row_count"),
    contractCallAtUrl<string>(progress.rpc_url, progress.program_address, "get_open_capsule_end_root")
  ]);
  const expectedSnapshotCount = progress.next_index - 1;
  const expectedCapsuleCount = progress.capsules.filter((capsule) => capsule.status === "sealed").length;
  const openCapsule = progress.capsules.find((capsule) => capsule.status === "open");
  if (Number(snapshotCount) !== expectedSnapshotCount) {
    throw new Error(`program snapshot_count ${snapshotCount} != progress ${expectedSnapshotCount}`);
  }
  if (Number(capsuleCount) !== expectedCapsuleCount) {
    throw new Error(`program capsule_count ${capsuleCount} != progress ${expectedCapsuleCount}`);
  }
  if (String(capsulesRoot) !== progress.running_capsules_root) {
    throw new Error("program capsules_root did not match progress");
  }
  if (Number(openCount) !== (openCapsule?.append_tx_hashes.length ?? 0)) {
    throw new Error(`program open row count ${openCount} did not match progress`);
  }
  if (!openCapsule && String(openEndRoot) !== progress.running_history_root) {
    throw new Error("program open end root did not match progress running root");
  }
}

async function readContractViews(url: string, programAddress: string, capsules: ProgressCapsule[], expectedCapsulesRoot: string): Promise<Record<string, unknown>> {
  const [manifest, rowLen, metaLen, snapshotCount, capsuleCount, capsulesRoot, rowLimit, openCount, openEndRoot, latestCapsuleId, latestBodyHash, latestMetaHash, latestTxIndexHash] = await Promise.all([
    contractCallAtUrl<string>(url, programAddress, "manifest"),
    contractCallAtUrl<number>(url, programAddress, "get_row_len"),
    contractCallAtUrl<number>(url, programAddress, "get_capsule_meta_len"),
    contractCallAtUrl<number>(url, programAddress, "get_snapshot_count"),
    contractCallAtUrl<number>(url, programAddress, "get_capsule_count"),
    contractCallAtUrl<string>(url, programAddress, "get_capsules_root"),
    contractCallAtUrl<number>(url, programAddress, "get_capsule_row_limit"),
    contractCallAtUrl<number>(url, programAddress, "get_open_capsule_row_count"),
    contractCallAtUrl<string>(url, programAddress, "get_open_capsule_end_root"),
    contractCallAtUrl<string>(url, programAddress, "get_latest_capsule_id"),
    contractCallAtUrl<string>(url, programAddress, "get_latest_capsule_body_hash"),
    contractCallAtUrl<string>(url, programAddress, "get_latest_capsule_meta_hash"),
    contractCallAtUrl<string>(url, programAddress, "get_latest_capsule_tx_index_hash")
  ]);
  const sealedCapsules = capsules.filter((capsule) => capsule.status === "sealed");
  const capsuleReadbacks = await Promise.all(sealedCapsules.map(async (capsule) => {
    const rebuilt = buildCapsuleFromProgress(capsule);
    const [body, meta, txIndex] = await Promise.all([
      contractCallAtUrl<string>(url, programAddress, "get_capsule_body", [capsule.capsule_id]),
      contractCallAtUrl<string>(url, programAddress, "get_capsule_meta", [capsule.capsule_id]),
      contractCallAtUrl<string>(url, programAddress, "get_capsule_tx_index", [capsule.capsule_id])
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
    manifest,
    row_len: rowLen,
    capsule_meta_len: metaLen,
    snapshot_count: snapshotCount,
    capsule_count: capsuleCount,
    capsules_root: capsulesRoot,
    capsules_root_matches: capsulesRoot === expectedCapsulesRoot,
    capsule_row_limit: rowLimit,
    open_capsule_row_count: openCount,
    open_capsule_end_root: openEndRoot,
    latest_capsule_id: latestCapsuleId,
    latest_capsule_body_hash: latestBodyHash,
    latest_capsule_meta_hash: latestMetaHash,
    latest_capsule_tx_index_hash: latestTxIndexHash,
    capsule_readbacks: capsuleReadbacks
  };
}

async function saveProgress(path: string, progress: ProgressFile): Promise<void> {
  progress.updated_at = isoStamp();
  await writeJson(path, progress);
}

async function createFreshProgress(
  wallet: OperatorWallet,
  artifact: CompileArtifact,
  rpcUrl: string,
  targetCapsules: number,
  rowLimit: number,
  progressFilePath: string
): Promise<ProgressFile> {
  let nonce = await nextNonce(wallet.address);
  const programAddress = await computeProgramAddress(artifact.bytecode, wallet.address, nonce);
  const deployOu = process.env.VITALS_HISTORY_BODY_MAP_PROBE_DEPLOY_OU || await recommendedOu("deploy", "50000000");
  const callOu = process.env.VITALS_HISTORY_BODY_MAP_PROBE_CALL_OU || await recommendedOu("call", "1000");
  const progress: ProgressFile = {
    schema: "octra-vitals-history-body-map-progress-v1",
    status: "initialized",
    generated_at: isoStamp(),
    updated_at: isoStamp(),
    rpc_url: rpcUrl,
    wallet_address: wallet.address,
    program_address: programAddress,
    target_capsules: targetCapsules,
    row_limit: rowLimit,
    next_index: 1,
    running_history_root: "",
    running_capsules_root: emptyCapsulesRootHex(),
    source_hash: artifact.source_hash,
    bytecode_hash: artifact.bytecode_hash,
    verification_hash: artifact.verification_hash,
    deploy: null,
    initialize: null,
    capsules: [],
    error: null
  };
  await saveProgress(progressFilePath, progress);
  const deploySubmitted = await submitTx(wallet, {
    from: wallet.address,
    to_: programAddress,
    amount: "0",
    nonce,
    ou: deployOu,
    timestamp: Date.now() / 1000,
    op_type: "deploy",
    encrypted_data: artifact.bytecode,
    message: "[]"
  }, "deploy history body-map probe");
  progress.deploy = {
    tx_hash: deploySubmitted.tx_hash,
    nonce: deploySubmitted.nonce,
    ou: deployOu,
    elapsed_ms: deploySubmitted.elapsed_ms
  };
  progress.status = "running";
  await saveProgress(progressFilePath, progress);
  nonce += 1;
  progress.initialize = await submitCall(wallet, programAddress, "initialize_probe", [wallet.address, rowLimit], nonce, callOu);
  progress.running_history_root = await contractCallAtUrl<string>(rpcUrl, programAddress, "get_open_capsule_end_root");
  await saveProgress(progressFilePath, progress);
  return progress;
}

async function run(): Promise<void> {
  const rpcUrl = octraProgramRpcUrl();
  if (!/devnet/i.test(rpcUrl) && process.env.VITALS_HISTORY_BODY_MAP_PROBE_ALLOW_NON_DEVNET !== "1") {
    throw new Error(`refusing to run history body-map probe against non-devnet RPC: ${rpcUrl}`);
  }
  const artifact = JSON.parse(await readFile(compilePath, "utf8")) as CompileArtifact;
  if (artifact.schema !== "octra-vitals-history-body-map-probe-compile-v1" || !artifact.bytecode) {
    throw new Error(`${compilePath} is not a compiled history body-map probe artifact`);
  }
  if (!artifact.verification || artifact.verification.verified !== true || artifact.verification.safety !== "safe" || artifact.verification.errors !== 0 || artifact.verification.warnings !== 0) {
    throw new Error("history body-map probe compile artifact is not formally safe");
  }
  const targetCapsules = configuredTargetCapsuleCount();
  const rowLimit = configuredRowLimit();
  const outputPath = reportPath();
  const progressFilePath = progressPath(outputPath);

  if (!submitEnabled) {
    await writeJson(outputPath, {
      schema: "octra-vitals-history-body-map-resumable-run-v1",
      status: "dry_run",
      generated_at: isoStamp(),
      rpc_url: rpcUrl,
      target_capsules: targetCapsules,
      row_limit: rowLimit,
      rows_total: targetCapsules * rowLimit,
      body_bytes_per_capsule: rowLimit * 295,
      source_hash: artifact.source_hash,
      bytecode_hash: artifact.bytecode_hash,
      verification_hash: artifact.verification_hash,
      progress_path: progressFilePath,
      next_step: "set VITALS_HISTORY_BODY_MAP_PROBE_SUBMIT=1 and VITALS_HISTORY_BODY_MAP_PROBE_ACK=1 on a devnet host with a limited wallet"
    });
    console.log(stableJson({
      status: "dry_run",
      report_path: outputPath,
      progress_path: progressFilePath,
      target_capsules: targetCapsules,
      row_limit: rowLimit
    }));
    return;
  }
  if (!submitAck) throw new Error("set VITALS_HISTORY_BODY_MAP_PROBE_ACK=1 to acknowledge devnet body-map probe submission");

  const wallet = loadWalletFromEnv({
    privateKeyEnv: ["VITALS_DEPLOYER_PRIVATE_KEY_B64", "VITALS_OPERATOR_PRIVATE_KEY_B64", "OCTRA_PRIVATE_KEY_B64"],
    addressEnv: ["VITALS_DEPLOYER_ADDRESS", "VITALS_OPERATOR_ADDRESS"],
    label: "history body-map probe wallet"
  });
  if (!wallet) throw new Error("history body-map probe requires VITALS_DEPLOYER_PRIVATE_KEY_B64 or VITALS_OPERATOR_PRIVATE_KEY_B64");

  let progress: ProgressFile;
  if (await pathExists(progressFilePath)) {
    if (!resumeEnabled) throw new Error(`progress file exists; set VITALS_HISTORY_BODY_MAP_PROBE_RESUME=1 to resume ${progressFilePath}`);
    progress = JSON.parse(await readFile(progressFilePath, "utf8")) as ProgressFile;
    if (progress.schema !== "octra-vitals-history-body-map-progress-v1") throw new Error("invalid progress file schema");
    if (progress.wallet_address !== wallet.address) throw new Error("progress wallet address does not match current wallet");
    progress.target_capsules = Math.max(progress.target_capsules, targetCapsules);
    progress.status = "running";
    progress.error = null;
    await saveProgress(progressFilePath, progress);
  } else if (process.env.VITALS_HISTORY_BODY_MAP_PROBE_SEED_REPORT) {
    const seed = JSON.parse(await readFile(process.env.VITALS_HISTORY_BODY_MAP_PROBE_SEED_REPORT, "utf8"));
    progress = progressFromSeedReport(seed, wallet, artifact, rpcUrl, targetCapsules, rowLimit);
    await saveProgress(progressFilePath, progress);
  } else {
    progress = await createFreshProgress(wallet, artifact, rpcUrl, targetCapsules, rowLimit, progressFilePath);
  }

  await validateProgramState(progress);
  const callOu = process.env.VITALS_HISTORY_BODY_MAP_PROBE_CALL_OU || await recommendedOu("call", "1000");
  let nonce = await nextNonce(wallet.address);

  while (progress.capsules.filter((capsule) => capsule.status === "sealed").length < progress.target_capsules) {
    let capsule = progress.capsules.find((candidate) => candidate.status === "open") || null;
    if (!capsule) {
      const firstIndex = progress.next_index;
      const rows = rowsForCapsule(firstIndex, progress.row_limit);
      const capsuleOptions: Parameters<typeof makeCapsule>[1] = {};
      if (progress.running_history_root) capsuleOptions.startRootHex = progress.running_history_root;
      const preview = makeCapsule(rows, capsuleOptions);
      capsule = {
        capsule_number: progress.capsules.length + 1,
        capsule_id: preview.meta.capsule_id,
        status: "open",
        row_count: progress.row_limit,
        first_index: firstIndex,
        last_index: firstIndex + progress.row_limit - 1,
        start_root_hex: preview.meta.start_root_hex,
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

    while (capsule.append_tx_hashes.length < capsule.row_count) {
      const rowIndex = capsule.first_index + capsule.append_tx_hashes.length;
      const row = syntheticProbeRow(rowIndex);
      const append = await submitCall(wallet, progress.program_address, "append_probe_row", [capsule.capsule_id, row.snapshot_index, encodeHistoryRow(row)], nonce, callOu);
      nonce += 1;
      capsule.append_calls.push(append);
      capsule.append_tx_hashes.push(append.tx_hash);
      progress.next_index = rowIndex + 1;
      await saveProgress(progressFilePath, progress);
    }

    const rebuilt = buildCapsuleFromProgress(capsule);
    const seal = await submitCall(wallet, progress.program_address, "seal_and_rotate", [rebuilt.meta_row, rebuilt.tx_index], nonce, callOu);
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
    await validateProgramState(progress);
  }

  const readback = await readContractViews(progress.rpc_url, progress.program_address, progress.capsules, progress.running_capsules_root);
  progress.status = "completed";
  progress.error = null;
  await saveProgress(progressFilePath, progress);
  const report = {
    schema: "octra-vitals-history-body-map-resumable-run-v1",
    status: "submitted",
    generated_at: isoStamp(),
    rpc_url: progress.rpc_url,
    wallet_address: progress.wallet_address,
    program_address: progress.program_address,
    target_capsules: progress.target_capsules,
    row_limit: progress.row_limit,
    rows_total: progress.target_capsules * progress.row_limit,
    source_hash: progress.source_hash,
    bytecode_hash: progress.bytecode_hash,
    verification_hash: progress.verification_hash,
    progress_path: progressFilePath,
    deploy: progress.deploy,
    initialize: progress.initialize,
    stored_capsules: progress.capsules.map(publicCapsuleReport),
    readback
  };
  await writeJson(outputPath, report);
  console.log(stableJson({
    status: "submitted",
    rpc_url: progress.rpc_url,
    program_address: progress.program_address,
    target_capsules: progress.target_capsules,
    row_limit: progress.row_limit,
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
