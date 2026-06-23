#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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

interface StoredCapsule {
  capsule_number: number;
  capsule_id: string;
  row_count: number;
  first_index: number;
  last_index: number;
  body: string;
  meta_row: string;
  tx_index: string;
  body_bytes: number;
  meta_bytes: number;
  tx_index_bytes: number;
  body_hash_hex: string;
  meta_hash_hex: string;
  tx_index_hash_hex: string;
  start_root_hex: string;
  end_root_hex: string;
  append_efforts: unknown[];
  append_elapsed_ms: number[];
  append_tx_hashes: string[];
  seal: SubmittedCall;
  capsules_root_after_seal: string;
}

const root = resolve(new URL("../..", import.meta.url).pathname);
const compilePath = join(root, "build", "program-history-body-map-probe", "compile.json");
const submitEnabled = process.env.VITALS_HISTORY_BODY_MAP_PROBE_SUBMIT === "1";
const submitAck = process.env.VITALS_HISTORY_BODY_MAP_PROBE_ACK === "1";
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
  return join(root, "reports", `aml-history-body-map-probe-devnet-${isoStamp().replace(/[:]/g, "")}.json`);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stableJson(value));
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

function configuredCapsuleCount(): number {
  const value = Number(process.env.VITALS_HISTORY_BODY_MAP_PROBE_CAPSULES || "2");
  if (!Number.isInteger(value) || value <= 0 || value > 12) throw new Error("VITALS_HISTORY_BODY_MAP_PROBE_CAPSULES must be 1..12");
  return value;
}

function configuredRowLimit(): number {
  const value = Number(process.env.VITALS_HISTORY_BODY_MAP_PROBE_ROW_LIMIT || "48");
  if (![12, 24, 48, 96].includes(value)) throw new Error("VITALS_HISTORY_BODY_MAP_PROBE_ROW_LIMIT must be one of 12,24,48,96");
  return value;
}

async function readContractViews(url: string, programAddress: string, capsules: StoredCapsule[], expectedCapsulesRoot: string): Promise<Record<string, unknown>> {
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
  const capsuleReadbacks = await Promise.all(capsules.map(async (capsule) => {
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
      body_matches: body === capsule.body,
      meta_matches: meta === capsule.meta_row,
      tx_index_matches: txIndex === capsule.tx_index
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

const rpcUrl = octraProgramRpcUrl();
if (!/devnet/i.test(rpcUrl)) {
  throw new Error(`refusing to run history body-map probe against non-devnet RPC: ${rpcUrl}`);
}

const artifact = JSON.parse(await readFile(compilePath, "utf8")) as CompileArtifact;
if (artifact.schema !== "octra-vitals-history-body-map-probe-compile-v1" || !artifact.bytecode) {
  throw new Error(`${compilePath} is not a compiled history body-map probe artifact`);
}
if (!artifact.verification || artifact.verification.verified !== true || artifact.verification.safety !== "safe" || artifact.verification.errors !== 0 || artifact.verification.warnings !== 0) {
  throw new Error("history body-map probe compile artifact is not formally safe");
}

const capsuleCount = configuredCapsuleCount();
const rowLimit = configuredRowLimit();
const outputPath = reportPath();

if (!submitEnabled) {
  await writeJson(outputPath, {
    schema: "octra-vitals-history-body-map-probe-run-v1",
    status: "dry_run",
    generated_at: isoStamp(),
    rpc_url: rpcUrl,
    capsules: capsuleCount,
    row_limit: rowLimit,
    rows_total: capsuleCount * rowLimit,
    body_bytes_per_capsule: rowLimit * 295,
    source_hash: artifact.source_hash,
    bytecode_hash: artifact.bytecode_hash,
    verification_hash: artifact.verification_hash,
    next_step: "set VITALS_HISTORY_BODY_MAP_PROBE_SUBMIT=1 and VITALS_HISTORY_BODY_MAP_PROBE_ACK=1 on a devnet host with a limited wallet"
  });
  console.log(stableJson({
    status: "dry_run",
    report_path: outputPath,
    capsules: capsuleCount,
    row_limit: rowLimit
  }));
  process.exit(0);
}

if (!submitAck) throw new Error("set VITALS_HISTORY_BODY_MAP_PROBE_ACK=1 to acknowledge devnet body-map probe submission");
const wallet = loadWalletFromEnv({
  privateKeyEnv: ["VITALS_HISTORY_PROBE_PRIVATE_KEY_B64"],
  addressEnv: ["VITALS_HISTORY_PROBE_ADDRESS"],
  label: "history body-map probe wallet"
});
if (!wallet) throw new Error("history body-map probe requires VITALS_HISTORY_PROBE_PRIVATE_KEY_B64");

let nonce = await nextNonce(wallet.address);
const programAddress = await computeProgramAddress(artifact.bytecode, wallet.address, nonce);
const deployOu = process.env.VITALS_HISTORY_BODY_MAP_PROBE_DEPLOY_OU || await recommendedOu("deploy", "50000000");
const callOu = process.env.VITALS_HISTORY_BODY_MAP_PROBE_CALL_OU || await recommendedOu("call", "1000");
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
nonce += 1;

const initialize = await submitCall(wallet, programAddress, "initialize_probe", [wallet.address, rowLimit], nonce, callOu);
nonce += 1;

let runningHistoryRoot: string | null = null;
let runningCapsulesRoot = emptyCapsulesRootHex();
let nextIndex = 1;
const capsules: StoredCapsule[] = [];

for (let capsuleNumber = 1; capsuleNumber <= capsuleCount; capsuleNumber += 1) {
  const rows: HistoryObservationRow[] = [];
  const appends: SubmittedCall[] = [];
  const appendTxHashes: string[] = [];
  for (let offset = 0; offset < rowLimit; offset += 1) {
    rows.push(syntheticHistoryRow(nextIndex + offset, {
      issued_raw: String(622000000000000n + BigInt(nextIndex + offset) * 1000n),
      total_locked_raw: String(200000000000000n + BigInt(nextIndex + offset) * 1000n),
      total_wrapped_raw: String(190000000000000n + BigInt(nextIndex + offset) * 1000n),
      total_unclaimed_raw: String(10000000000000n + BigInt(nextIndex + offset) * 1000n)
    }));
  }
  const first = rows[0];
  if (!first) throw new Error("missing first row");
  const previewCapsuleOptions: Parameters<typeof makeCapsule>[1] = {};
  if (runningHistoryRoot) previewCapsuleOptions.startRootHex = runningHistoryRoot;
  const appendCapsuleId = makeCapsule(rows, previewCapsuleOptions).meta.capsule_id;

  for (const row of rows) {
    const append = await submitCall(wallet, programAddress, "append_probe_row", [appendCapsuleId, row.snapshot_index, encodeHistoryRow(row)], nonce, callOu);
    nonce += 1;
    appends.push(append);
    appendTxHashes.push(append.tx_hash);
    nextIndex += 1;
  }

  const txIndex = makeTxIndex(appendTxHashes);
  const capsuleOptions: Parameters<typeof makeCapsule>[1] = {
    capsuleId: appendCapsuleId,
    txIndex
  };
  if (runningHistoryRoot) capsuleOptions.startRootHex = runningHistoryRoot;
  const capsule = makeCapsule(rows, capsuleOptions);
  runningHistoryRoot = capsule.meta.end_root_hex;
  runningCapsulesRoot = foldCapsulesRootHex(
    runningCapsulesRoot,
    capsule.meta.capsule_id,
    capsule.body_hash_hex,
    capsule.meta_hash_hex,
    capsule.meta.end_root_hex
  );
  const seal = await submitCall(wallet, programAddress, "seal_and_rotate", [capsule.meta_row, txIndex], nonce, callOu);
  nonce += 1;

  capsules.push({
    capsule_number: capsuleNumber,
    capsule_id: capsule.meta.capsule_id,
    row_count: rowLimit,
    first_index: capsule.meta.first_index,
    last_index: capsule.meta.last_index,
    body: capsule.body,
    meta_row: capsule.meta_row,
    tx_index: txIndex,
    body_bytes: capsule.body.length,
    meta_bytes: capsule.meta_row.length,
    tx_index_bytes: txIndex.length,
    body_hash_hex: capsule.body_hash_hex,
    meta_hash_hex: capsuleMetaHashHex(capsule.meta_row),
    tx_index_hash_hex: capsuleTxIndexHashHex(txIndex),
    start_root_hex: capsule.meta.start_root_hex,
    end_root_hex: capsule.meta.end_root_hex,
    append_efforts: appends.map((append) => append.receipt?.effort ?? null),
    append_elapsed_ms: appends.map((append) => append.elapsed_ms),
    append_tx_hashes: appendTxHashes,
    seal,
    capsules_root_after_seal: runningCapsulesRoot
  });
}

const readback = await readContractViews(rpcUrl, programAddress, capsules, runningCapsulesRoot);
const report = {
  schema: "octra-vitals-history-body-map-probe-run-v1",
  status: "submitted",
  generated_at: isoStamp(),
  rpc_url: rpcUrl,
  wallet_address: wallet.address,
  program_address: programAddress,
  capsules: capsuleCount,
  row_limit: rowLimit,
  rows_total: capsuleCount * rowLimit,
  source_hash: artifact.source_hash,
  bytecode_hash: artifact.bytecode_hash,
  verification_hash: artifact.verification_hash,
  deploy: {
    tx_hash: deploySubmitted.tx_hash,
    nonce: deploySubmitted.nonce,
    ou: deployOu,
    elapsed_ms: deploySubmitted.elapsed_ms
  },
  initialize,
  stored_capsules: capsules.map((capsule) => ({
    capsule_number: capsule.capsule_number,
    capsule_id: capsule.capsule_id,
    row_count: capsule.row_count,
    first_index: capsule.first_index,
    last_index: capsule.last_index,
    body_bytes: capsule.body_bytes,
    meta_bytes: capsule.meta_bytes,
    tx_index_bytes: capsule.tx_index_bytes,
    body_hash_hex: capsule.body_hash_hex,
    meta_hash_hex: capsule.meta_hash_hex,
    tx_index_hash_hex: capsule.tx_index_hash_hex,
    start_root_hex: capsule.start_root_hex,
    end_root_hex: capsule.end_root_hex,
    append_efforts: capsule.append_efforts,
    append_elapsed_ms: capsule.append_elapsed_ms,
    append_tx_hashes: capsule.append_tx_hashes,
    seal: capsule.seal,
    capsules_root_after_seal: capsule.capsules_root_after_seal
  })),
  readback
};
await writeJson(outputPath, report);
console.log(stableJson({
  status: "submitted",
  rpc_url: rpcUrl,
  program_address: programAddress,
  capsules: capsuleCount,
  row_limit: rowLimit,
  report_path: outputPath,
  deploy_tx_hash: deploySubmitted.tx_hash,
  capsules_root: runningCapsulesRoot
}));
