#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { contractReceipt, feeTelemetry, octraProgramRpcUrl, octraRpc, recommendedOu } from "../lib/octra-rpc.js";
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

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const root = resolve(new URL("../..", import.meta.url).pathname);
const compilePath = join(root, "build", "program-history-body-map-probe", "compile.json");
const submitEnabled = process.env.VITALS_HISTORY_BODY_MAP_CIRCLE_PROBE_SUBMIT === "1";
const submitAck = process.env.VITALS_HISTORY_BODY_MAP_CIRCLE_PROBE_ACK === "1";
const waitForConfirmations = process.env.VITALS_HISTORY_BODY_MAP_CIRCLE_PROBE_WAIT !== "0";
const existingCircleId = process.env.VITALS_HISTORY_BODY_MAP_CIRCLE_PROBE_EXISTING_CIRCLE_ID || "";

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

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isoStamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function reportPath(): string {
  const configured = process.env.VITALS_HISTORY_BODY_MAP_CIRCLE_PROBE_REPORT;
  if (configured) return configured;
  return join(root, "reports", `aml-history-body-map-circle-probe-devnet-${isoStamp().replace(/[:]/g, "")}.json`);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stableJson(value));
}

function u32be(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value, 0);
  return out;
}

function u64be(value: number): Buffer {
  const out = Buffer.alloc(8);
  const big = BigInt(value);
  out.writeUInt32BE(Number((big >> 32n) & 0xffffffffn), 0);
  out.writeUInt32BE(Number(big & 0xffffffffn), 4);
  return out;
}

function h256Raw(tag: string, parts: Uint8Array[]): Buffer {
  const framed: Uint8Array[] = [Buffer.from(tag), Buffer.from([0])];
  for (const part of parts) framed.push(u32be(part.length), part);
  return createHash("sha256").update(Buffer.concat(framed)).digest();
}

function h256Hex(tag: string, parts: Uint8Array[]): string {
  return h256Raw(tag, parts).toString("hex");
}

function base58Encode(bytes: Buffer): string {
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let encoded = "";
  while (value > 0n) {
    const digit = Number(value % 58n);
    value /= 58n;
    encoded = BASE58_ALPHABET[digit] + encoded;
  }
  for (const byte of bytes) {
    if (byte === 0) encoded = `1${encoded}`;
    else break;
  }
  return encoded || "1";
}

function canonicalCircleDeployPayload(): string {
  return [
    "{",
    "\"runtime\":\"octb\",",
    "\"privacy_class\":\"public\",",
    "\"browser_mode\":\"gateway_allowed\",",
    "\"resource_mode\":\"public_resources\",",
    "\"code_b64\":null,",
    "\"policy_hash\":null,",
    "\"members_root\":null,",
    "\"export_policy\":null,",
    "\"limits\":{",
    "\"max_stable_bytes\":\"33554432\",",
    "\"max_assets_bytes\":\"33554432\",",
    "\"max_inline_value\":\"65536\",",
    "\"max_wasm_bytes\":\"33554432\"",
    "}}"
  ].join("");
}

function circleIdOfDeploy(deployer: string, nonce: number, canonicalPayload: string): string {
  const payloadHash = h256Hex("octra:circle_deploy_payload:v1", [Buffer.from(canonicalPayload)]);
  const seed = h256Raw("octra:circle_deploy_id:v1", [
    Buffer.from(deployer),
    u64be(nonce),
    Buffer.from(payloadHash)
  ]);
  const base58 = base58Encode(seed);
  const base58Part = base58.length >= 44
    ? base58.slice(0, 44)
    : base58.repeat(Math.ceil(44 / base58.length)).slice(0, 44);
  return `oct${base58Part}`;
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

async function submitTx(wallet: OperatorWallet, tx: OctraTransaction, label: string): Promise<{ tx_hash: string; nonce: number; elapsed_ms: number; submit_result: unknown }> {
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
    elapsed_ms: Date.now() - started,
    submit_result: submitResult
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

function configuredRowLimit(): number {
  const value = Number(process.env.VITALS_HISTORY_BODY_MAP_CIRCLE_PROBE_ROW_LIMIT || "48");
  if (![12, 24, 48].includes(value)) throw new Error("VITALS_HISTORY_BODY_MAP_CIRCLE_PROBE_ROW_LIMIT must be one of 12,24,48");
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

const rpcUrl = octraProgramRpcUrl();
if (!/devnet/i.test(rpcUrl)) {
  throw new Error(`refusing to run history body-map Circle probe against non-devnet RPC: ${rpcUrl}`);
}

const artifact = JSON.parse(await readFile(compilePath, "utf8")) as CompileArtifact;
if (artifact.schema !== "octra-vitals-history-body-map-probe-compile-v1" || !artifact.bytecode) {
  throw new Error(`${compilePath} is not a compiled history body-map probe artifact`);
}
if (!artifact.verification || artifact.verification.verified !== true || artifact.verification.safety !== "safe" || artifact.verification.errors !== 0 || artifact.verification.warnings !== 0) {
  throw new Error("history body-map probe compile artifact is not formally safe");
}

const rowLimit = configuredRowLimit();
const outputPath = reportPath();
const [deployOu, updateOu, callOu, deployFee, updateFee, callFee] = await Promise.all([
  process.env.VITALS_HISTORY_BODY_MAP_CIRCLE_PROBE_DEPLOY_OU || recommendedOu("deploy_circle", "200000"),
  process.env.VITALS_HISTORY_BODY_MAP_CIRCLE_PROBE_UPDATE_OU || recommendedOu("circle_program_update", "200000"),
  process.env.VITALS_HISTORY_BODY_MAP_CIRCLE_PROBE_CALL_OU || recommendedOu("circle_call", "1000"),
  feeTelemetry("deploy_circle"),
  feeTelemetry("circle_program_update"),
  feeTelemetry("circle_call")
]);
const wallet = loadWalletFromEnv({
  privateKeyEnv: ["VITALS_HISTORY_PROBE_PRIVATE_KEY_B64"],
  addressEnv: ["VITALS_HISTORY_PROBE_ADDRESS"],
  label: "history body-map Circle probe wallet"
});
const deployerAddress = wallet?.address || process.env.VITALS_DEPLOYER_ADDRESS || process.env.VITALS_OPERATOR_ADDRESS || null;
const canonicalPayload = canonicalCircleDeployPayload();
const next = deployerAddress ? await nextNonce(deployerAddress) : 0;
const circleId = existingCircleId || (deployerAddress ? circleIdOfDeploy(deployerAddress, next, canonicalPayload) : "pending");

if (!submitEnabled) {
  await writeJson(outputPath, {
    schema: "octra-vitals-history-body-map-circle-probe-run-v1",
    status: "dry_run",
    generated_at: isoStamp(),
    rpc_url: rpcUrl,
    circle_id: circleId,
    deployer_address: deployerAddress || "pending",
    existing_circle: Boolean(existingCircleId),
    row_limit: rowLimit,
    body_bytes: rowLimit * 295,
    source_hash: artifact.source_hash,
    bytecode_hash: artifact.bytecode_hash,
    verification_hash: artifact.verification_hash,
    deploy_payload: JSON.parse(canonicalPayload),
    ou: {
      deploy_circle: deployOu,
      circle_program_update: updateOu,
      circle_call: callOu
    },
    fee_telemetry: {
      deploy_circle: deployFee,
      circle_program_update: updateFee,
      circle_call: callFee
    },
    next_step: "set VITALS_HISTORY_BODY_MAP_CIRCLE_PROBE_SUBMIT=1 and VITALS_HISTORY_BODY_MAP_CIRCLE_PROBE_ACK=1 on a devnet host with a limited wallet"
  });
  console.log(stableJson({
    status: "dry_run",
    report_path: outputPath,
    circle_id: circleId,
    row_limit: rowLimit
  }));
  process.exit(0);
}

if (!submitAck) throw new Error("set VITALS_HISTORY_BODY_MAP_CIRCLE_PROBE_ACK=1 to acknowledge devnet Circle probe submission");
if (!wallet) throw new Error("history body-map Circle probe requires VITALS_HISTORY_PROBE_PRIVATE_KEY_B64");

const partialReport: Record<string, unknown> = {
  schema: "octra-vitals-history-body-map-circle-probe-run-v1",
  status: "running",
  generated_at: isoStamp(),
  rpc_url: rpcUrl,
  wallet_address: wallet.address,
  circle_id: circleId,
  existing_circle: Boolean(existingCircleId),
  starting_nonce: next,
  row_limit: rowLimit,
  rows_total: rowLimit,
  source_hash: artifact.source_hash,
  bytecode_hash: artifact.bytecode_hash,
  verification_hash: artifact.verification_hash,
  deploy: null,
  program_update: null,
  initialize: null,
  submitted_appends: [],
  ou: {
    deploy_circle: deployOu,
    circle_program_update: updateOu,
    circle_call: callOu
  },
  fee_telemetry: {
    deploy_circle: deployFee,
    circle_program_update: updateFee,
    circle_call: callFee
  }
};

try {
  let nonce = next;
  if (!existingCircleId) {
    const deploy = await submitTx(wallet, {
      from: wallet.address,
      to_: circleId,
      amount: "0",
      nonce,
      ou: deployOu,
      timestamp: Date.now() / 1000,
      op_type: "deploy_circle",
      message: canonicalPayload
    }, "deploy history body-map probe Circle");
    partialReport.deploy = {
      tx_hash: deploy.tx_hash,
      nonce: deploy.nonce,
      ou: deployOu,
      elapsed_ms: deploy.elapsed_ms
    };
    await writeJson(outputPath, partialReport);
    nonce += 1;
  } else {
    partialReport.deploy = {
      skipped: true,
      reason: "existing Circle supplied by VITALS_HISTORY_BODY_MAP_CIRCLE_PROBE_EXISTING_CIRCLE_ID"
    };
    await writeJson(outputPath, partialReport);
  }

  const programUpdate = await submitTx(wallet, {
    from: wallet.address,
    to_: circleId,
    amount: "0",
    nonce,
    ou: updateOu,
    timestamp: Date.now() / 1000,
    op_type: "circle_program_update",
    message: JSON.stringify({ code_b64: artifact.bytecode })
  }, "program_update history body-map probe Circle");
  partialReport.program_update = {
    tx_hash: programUpdate.tx_hash,
    nonce: programUpdate.nonce,
    ou: updateOu,
    elapsed_ms: programUpdate.elapsed_ms
  };
  await writeJson(outputPath, partialReport);
  nonce += 1;

  const initialize = await submitCircleCall(wallet, circleId, "initialize_probe", [wallet.address, rowLimit], nonce, callOu);
  partialReport.initialize = initialize;
  await writeJson(outputPath, partialReport);
  nonce += 1;

  const rows = Array.from({ length: rowLimit }, (_, offset) => syntheticProbeRow(offset + 1));
  const preview = makeCapsule(rows);
  const appends: SubmittedCall[] = [];
  const appendTxHashes: string[] = [];
  for (const row of rows) {
    const append = await submitCircleCall(wallet, circleId, "append_probe_row", [preview.meta.capsule_id, row.snapshot_index, encodeHistoryRow(row)], nonce, callOu);
    nonce += 1;
    appends.push(append);
    appendTxHashes.push(append.tx_hash);
    partialReport.submitted_appends = appends.map((submitted) => ({
      method: submitted.method,
      nonce: submitted.nonce,
      tx_hash: submitted.tx_hash,
      receipt: submitted.receipt,
      elapsed_ms: submitted.elapsed_ms
    }));
    await writeJson(outputPath, partialReport);
  }

  const txIndex = makeTxIndex(appendTxHashes);
  const capsule = makeCapsule(rows, { capsuleId: preview.meta.capsule_id, txIndex });
  const expectedCapsulesRoot = foldCapsulesRootHex(
    emptyCapsulesRootHex(),
    capsule.meta.capsule_id,
    capsule.body_hash_hex,
    capsule.meta_hash_hex,
    capsule.meta.end_root_hex
  );
  const seal = await submitCircleCall(wallet, circleId, "seal_and_rotate", [capsule.meta_row, txIndex], nonce, callOu);

  const [programInfo, manifest, snapshotCount, capsuleCount, capsulesRoot, openCount, latestCapsuleId, latestBodyHash, latestMetaHash, latestTxIndexHash, body, meta, returnedTxIndex] = await Promise.all([
    octraRpc<any>("octra_circleProgramInfo", [circleId]),
    circleView<string>(circleId, "manifest", [], wallet.address),
    circleView<number>(circleId, "get_snapshot_count", [], wallet.address),
    circleView<number>(circleId, "get_capsule_count", [], wallet.address),
    circleView<string>(circleId, "get_capsules_root", [], wallet.address),
    circleView<number>(circleId, "get_open_capsule_row_count", [], wallet.address),
    circleView<string>(circleId, "get_latest_capsule_id", [], wallet.address),
    circleView<string>(circleId, "get_latest_capsule_body_hash", [], wallet.address),
    circleView<string>(circleId, "get_latest_capsule_meta_hash", [], wallet.address),
    circleView<string>(circleId, "get_latest_capsule_tx_index_hash", [], wallet.address),
    circleView<string>(circleId, "get_capsule_body", [capsule.meta.capsule_id], wallet.address),
    circleView<string>(circleId, "get_capsule_meta", [capsule.meta.capsule_id], wallet.address),
    circleView<string>(circleId, "get_capsule_tx_index", [capsule.meta.capsule_id], wallet.address)
  ]);

  const report = {
    ...partialReport,
    status: "submitted",
    generated_at: isoStamp(),
    capsule: {
      capsule_id: capsule.meta.capsule_id,
      row_count: rowLimit,
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
      capsules_root_after_seal: expectedCapsulesRoot
    },
    readback: {
      program_info: programInfo,
      manifest,
      snapshot_count: snapshotCount,
      capsule_count: capsuleCount,
      capsules_root: capsulesRoot,
      capsules_root_matches: capsulesRoot === expectedCapsulesRoot,
      open_capsule_row_count: openCount,
      latest_capsule_id: latestCapsuleId,
      latest_capsule_body_hash: latestBodyHash,
      latest_capsule_meta_hash: latestMetaHash,
      latest_capsule_tx_index_hash: latestTxIndexHash,
      body_bytes: body.length,
      meta_bytes: meta.length,
      tx_index_bytes: returnedTxIndex.length,
      body_matches: body === capsule.body,
      meta_matches: meta === capsule.meta_row,
      tx_index_matches: returnedTxIndex === txIndex
    }
  };

  await writeJson(outputPath, report);
  console.log(stableJson({
    status: "submitted",
    rpc_url: rpcUrl,
    circle_id: circleId,
    row_limit: rowLimit,
    report_path: outputPath,
    capsules_root: expectedCapsulesRoot,
    readback_ok: report.readback.capsules_root_matches && report.readback.body_matches && report.readback.meta_matches && report.readback.tx_index_matches
  }));
} catch (error) {
  partialReport.status = "failed";
  partialReport.updated_at = isoStamp();
  partialReport.error = error instanceof Error ? error.message : String(error);
  await writeJson(outputPath, partialReport);
  throw error;
}
