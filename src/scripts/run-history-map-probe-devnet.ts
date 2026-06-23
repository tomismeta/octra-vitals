#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { contractCallAtUrl, contractReceipt, octraProgramRpcUrl, octraRpc, recommendedOu } from "../lib/octra-rpc.js";
import { loadWalletFromEnv, publicTransactionJson, signTransaction, transactionHash, type OctraTransaction, type OperatorWallet } from "../lib/octra-transaction.js";
import {
  calendarStatNodeHashHex,
  capsuleMetaHashHex,
  encodeCalendarStatNode,
  makeCapsule,
  syntheticCalendarStatNode,
  syntheticHistoryRow,
  type HistoryObservationRow
} from "../lib/aml-history-probe.js";

interface CompileArtifact {
  schema: "octra-vitals-history-map-probe-compile-v1";
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

const root = resolve(new URL("../..", import.meta.url).pathname);
const compilePath = join(root, "build", "program-history-map-probe", "compile.json");
const submitEnabled = process.env.VITALS_HISTORY_MAP_PROBE_SUBMIT === "1";
const submitAck = process.env.VITALS_HISTORY_MAP_PROBE_ACK === "1";
const waitForConfirmations = process.env.VITALS_HISTORY_MAP_PROBE_WAIT !== "0";

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isoStamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function reportPath(): string {
  const configured = process.env.VITALS_HISTORY_MAP_PROBE_REPORT;
  if (configured) return configured;
  return join(root, "reports", `aml-history-map-probe-devnet-${isoStamp().replace(/[:]/g, "")}.json`);
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

function bundleCount(): number {
  const value = Number(process.env.VITALS_HISTORY_MAP_PROBE_BUNDLES || "3");
  if (!Number.isInteger(value) || value <= 0 || value > 12) throw new Error("VITALS_HISTORY_MAP_PROBE_BUNDLES must be 1..12");
  return value;
}

function periodIds(first: HistoryObservationRow) {
  const iso = new Date(first.observed_at_unix * 1000).toISOString();
  return {
    day: `D:${iso.slice(0, 10)}`,
    month: `M:${iso.slice(0, 7)}`,
    year: `Y:${iso.slice(0, 4)}`
  };
}

async function readContractViews(url: string, programAddress: string, lastBundle: Record<string, string>): Promise<Record<string, unknown>> {
  const [manifest, metaLen, calendarLen, metaCount, nodeCount, latestCapsuleId, latestMetaHash, latestCalendarKey, latestCalendarHash, calendarTip, capsuleMeta, dayNode, monthNode, yearNode] = await Promise.all([
    contractCallAtUrl<string>(url, programAddress, "manifest"),
    contractCallAtUrl<number>(url, programAddress, "get_capsule_meta_len"),
    contractCallAtUrl<number>(url, programAddress, "get_calendar_node_len"),
    contractCallAtUrl<number>(url, programAddress, "get_capsule_meta_count"),
    contractCallAtUrl<number>(url, programAddress, "get_calendar_node_count"),
    contractCallAtUrl<string>(url, programAddress, "get_latest_capsule_id"),
    contractCallAtUrl<string>(url, programAddress, "get_latest_capsule_meta_hash"),
    contractCallAtUrl<string>(url, programAddress, "get_latest_calendar_key"),
    contractCallAtUrl<string>(url, programAddress, "get_latest_calendar_node_hash"),
    contractCallAtUrl<string>(url, programAddress, "get_calendar_tip_hash"),
    contractCallAtUrl<string>(url, programAddress, "get_capsule_meta", [lastBundle.capsule_id]),
    contractCallAtUrl<string>(url, programAddress, "get_calendar_node", [lastBundle.day_key]),
    contractCallAtUrl<string>(url, programAddress, "get_calendar_node", [lastBundle.month_key]),
    contractCallAtUrl<string>(url, programAddress, "get_calendar_node", [lastBundle.year_key])
  ]);
  return {
    manifest,
    capsule_meta_len: metaLen,
    calendar_node_len: calendarLen,
    capsule_meta_count: metaCount,
    calendar_node_count: nodeCount,
    latest_capsule_id: latestCapsuleId,
    latest_capsule_meta_hash: latestMetaHash,
    latest_calendar_key: latestCalendarKey,
    latest_calendar_node_hash: latestCalendarHash,
    calendar_tip_hash: calendarTip,
    last_capsule_meta_matches: capsuleMeta === lastBundle.meta_row,
    last_day_node_matches: dayNode === lastBundle.day_node,
    last_month_node_matches: monthNode === lastBundle.month_node,
    last_year_node_matches: yearNode === lastBundle.year_node
  };
}

const rpcUrl = octraProgramRpcUrl();
if (!/devnet/i.test(rpcUrl)) {
  throw new Error(`refusing to run history map probe against non-devnet RPC: ${rpcUrl}`);
}

const artifact = JSON.parse(await readFile(compilePath, "utf8")) as CompileArtifact;
if (artifact.schema !== "octra-vitals-history-map-probe-compile-v1" || !artifact.bytecode) {
  throw new Error(`${compilePath} is not a compiled history map probe artifact`);
}
if (!artifact.verification || artifact.verification.verified !== true || artifact.verification.safety !== "safe" || artifact.verification.errors !== 0 || artifact.verification.warnings !== 0) {
  throw new Error("history map probe compile artifact is not formally safe");
}

const bundlesToWrite = bundleCount();
const outputPath = reportPath();

if (!submitEnabled) {
  await writeJson(outputPath, {
    schema: "octra-vitals-history-map-probe-run-v1",
    status: "dry_run",
    generated_at: isoStamp(),
    rpc_url: rpcUrl,
    bundles: bundlesToWrite,
    source_hash: artifact.source_hash,
    bytecode_hash: artifact.bytecode_hash,
    verification_hash: artifact.verification_hash,
    next_step: "set VITALS_HISTORY_MAP_PROBE_SUBMIT=1 and VITALS_HISTORY_MAP_PROBE_ACK=1 on a devnet host with a limited wallet"
  });
  console.log(stableJson({
    status: "dry_run",
    report_path: outputPath,
    bundles: bundlesToWrite
  }));
  process.exit(0);
}

if (!submitAck) throw new Error("set VITALS_HISTORY_MAP_PROBE_ACK=1 to acknowledge devnet map probe submission");
const wallet = loadWalletFromEnv({
  privateKeyEnv: ["VITALS_HISTORY_PROBE_PRIVATE_KEY_B64"],
  addressEnv: ["VITALS_HISTORY_PROBE_ADDRESS"],
  label: "history map probe wallet"
});
if (!wallet) throw new Error("history map probe requires VITALS_HISTORY_PROBE_PRIVATE_KEY_B64");

let nonce = await nextNonce(wallet.address);
const programAddress = await computeProgramAddress(artifact.bytecode, wallet.address, nonce);
const deployOu = process.env.VITALS_HISTORY_MAP_PROBE_DEPLOY_OU || await recommendedOu("deploy", "50000000");
const callOu = process.env.VITALS_HISTORY_MAP_PROBE_CALL_OU || await recommendedOu("call", "1000");
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
}, "deploy history map probe");
nonce += 1;

const initialize = await submitCall(wallet, programAddress, "initialize_probe", [wallet.address], nonce, callOu);
nonce += 1;

let nextIndex = 1;
const bundles: Array<Record<string, unknown>> = [];
let lastBundleForReadback: Record<string, string> | null = null;

for (let bundleIndex = 0; bundleIndex < bundlesToWrite; bundleIndex += 1) {
  const rows = Array.from({ length: 48 }, (_, offset) => syntheticHistoryRow(nextIndex + offset, {
    issued_raw: String(622000000000000n + BigInt(nextIndex + offset) * 1000n),
    total_locked_raw: String(200000000000000n + BigInt(nextIndex + offset) * 1000n),
    total_wrapped_raw: String(190000000000000n + BigInt(nextIndex + offset) * 1000n),
    total_unclaimed_raw: String(10000000000000n + BigInt(nextIndex + offset) * 1000n)
  }));
  const capsule = makeCapsule(rows);
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!first || !last) throw new Error("missing synthetic rows");
  const periods = periodIds(first);
  const dayNode = encodeCalendarStatNode(syntheticCalendarStatNode("D", periods.day, first, last, {
    startRootHex: capsule.meta.start_root_hex,
    endRootHex: capsule.meta.end_root_hex,
    count: rows.length,
    sourceChildCount: 1
  }));
  const monthNode = encodeCalendarStatNode(syntheticCalendarStatNode("M", periods.month, first, last, {
    startRootHex: capsule.meta.start_root_hex,
    endRootHex: capsule.meta.end_root_hex,
    count: rows.length,
    sourceChildCount: 1
  }));
  const yearNode = encodeCalendarStatNode(syntheticCalendarStatNode("Y", periods.year, first, last, {
    startRootHex: capsule.meta.start_root_hex,
    endRootHex: capsule.meta.end_root_hex,
    count: rows.length,
    sourceChildCount: 1
  }));
  const submitted = await submitCall(wallet, programAddress, "put_capsule_calendar_bundle", [
    capsule.meta.capsule_id,
    capsule.meta_row,
    periods.day,
    dayNode,
    periods.month,
    monthNode,
    periods.year,
    yearNode
  ], nonce, callOu);
  nonce += 1;
  nextIndex += rows.length;

  lastBundleForReadback = {
    capsule_id: capsule.meta.capsule_id,
    meta_row: capsule.meta_row,
    day_key: periods.day,
    day_node: dayNode,
    month_key: periods.month,
    month_node: monthNode,
    year_key: periods.year,
    year_node: yearNode
  };
  bundles.push({
    bundle_index: bundleIndex + 1,
    capsule_id: capsule.meta.capsule_id,
    first_index: first.snapshot_index,
    last_index: last.snapshot_index,
    meta_bytes: capsule.meta_row.length,
    calendar_node_bytes_each: dayNode.length,
    bundle_payload_bytes: capsule.meta_row.length + dayNode.length + monthNode.length + yearNode.length,
    meta_hash_hex: capsuleMetaHashHex(capsule.meta_row),
    day_node_hash_hex: calendarStatNodeHashHex(dayNode),
    month_node_hash_hex: calendarStatNodeHashHex(monthNode),
    year_node_hash_hex: calendarStatNodeHashHex(yearNode),
    submission: submitted
  });
}

if (!lastBundleForReadback) throw new Error("no map probe bundles written");
const readback = await readContractViews(rpcUrl, programAddress, lastBundleForReadback);
const report = {
  schema: "octra-vitals-history-map-probe-run-v1",
  status: "submitted",
  generated_at: isoStamp(),
  rpc_url: rpcUrl,
  wallet_address: wallet.address,
  program_address: programAddress,
  bundles: bundlesToWrite,
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
  bundle_writes: bundles,
  readback
};
await writeJson(outputPath, report);
console.log(stableJson({
  status: "submitted",
  rpc_url: rpcUrl,
  program_address: programAddress,
  bundles: bundlesToWrite,
  report_path: outputPath,
  deploy_tx_hash: deploySubmitted.tx_hash
}));
