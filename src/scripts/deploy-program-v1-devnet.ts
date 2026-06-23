#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { circleProgramViewAtUrl, configuredProgrammedCircleId } from "../lib/circle-program.js";
import { contractReceipt, feeTelemetry, octraProgramRpcUrl, octraRpc, recommendedOu } from "../lib/octra-rpc.js";
import { loadWalletFromEnv, publicTransactionJson, signTransaction, transactionHash, type OctraTransaction, type OperatorWallet } from "../lib/octra-transaction.js";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const root = resolve(new URL("../..", import.meta.url).pathname);
const compilePath = join(root, "build", "program-v1", "compile.json");
const outPath = process.env.VITALS_PROGRAM_V1_DEVNET_DEPLOY_REPORT ||
  join(root, "reports", `program-v1-devnet-deploy-${new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[:]/g, "")}.json`);
const deployEnabled = process.env.VITALS_PROGRAM_V1_DEVNET_DEPLOY === "1";
const deployAck = process.env.VITALS_PROGRAM_V1_DEVNET_DEPLOY_ACK === "1";
const waitForConfirmations = process.env.VITALS_DEPLOY_WAIT !== "0";
const requireContractReceipt = waitForConfirmations && process.env.VITALS_REQUIRE_CONTRACT_RECEIPT !== "0";

interface CompileArtifact {
  schema: string;
  source_hash: string;
  bytecode_hash: string | null;
  verification_hash: string | null;
  bytecode?: string;
  size?: number;
  instructions?: number;
  verification?: {
    verified?: boolean;
    safety?: string;
    errors?: number;
    warnings?: number;
  } | null;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function writeReport(report: unknown): Promise<void> {
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, stableJson(report));
  console.log(stableJson({
    schema: (report as any).schema,
    status: (report as any).status,
    rpc_url: (report as any).rpc_url,
    deploy_enabled: (report as any).deploy_enabled,
    circle_id: (report as any).circle_id,
    program_update_tx_hash: (report as any).program_update_tx_hash,
    initialize_tx_hash: (report as any).initialize_tx_hash,
    report_path: outPath
  }));
}

function assertDevnetRpc(url: string): void {
  if (!/devnet/i.test(url)) {
    throw new Error(`refusing v1 rehearsal deploy against non-devnet RPC URL: ${url}`);
  }
}

function assertSafeCompile(compile: CompileArtifact): void {
  const verification = compile.verification;
  if (
    !verification ||
    verification.verified !== true ||
    verification.safety !== "safe" ||
    verification.errors !== 0 ||
    verification.warnings !== 0
  ) {
    throw new Error(`program v1 AML verification failed: ${JSON.stringify(verification || null)}`);
  }
  if (!compile.bytecode || !compile.bytecode_hash || !compile.verification_hash) {
    throw new Error("program v1 compile artifact is missing bytecode or certificate hashes");
  }
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
      // Fresh transactions may take a moment to become queryable.
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
        contract: event?.contract || null,
        event: event?.event || null,
        values: Array.isArray(event?.values) ? event.values : []
      }))
      : []
  };
}

async function submitTx(wallet: OperatorWallet, tx: OctraTransaction, label: string): Promise<{ tx_hash: string; submit_result: unknown; confirmation: unknown }> {
  const signed = signTransaction(tx, wallet);
  const submitResult = await octraRpc<any>("octra_submit", [publicTransactionJson(signed)], { retry: false });
  const txHash = submitResult?.tx_hash || submitResult?.hash || transactionHash(signed);
  const confirmation = await requireConfirmed(txHash, label);
  return {
    tx_hash: txHash,
    submit_result: submitResult,
    confirmation
  };
}

async function circleView<T>(rpcUrl: string, circleId: string, method: string, caller: string, params: unknown[] = []): Promise<T> {
  return circleProgramViewAtUrl<T>(rpcUrl, circleId, method, params, caller);
}

const rpcUrl = octraProgramRpcUrl();
assertDevnetRpc(rpcUrl);
const compile = JSON.parse(await readFile(compilePath, "utf8")) as CompileArtifact;
assertSafeCompile(compile);

const wallet = loadWalletFromEnv({
  privateKeyEnv: ["VITALS_PROGRAM_V1_DEVNET_PRIVATE_KEY_B64", "VITALS_HISTORY_PROBE_PRIVATE_KEY_B64"],
  addressEnv: ["VITALS_PROGRAM_V1_DEVNET_ADDRESS", "VITALS_HISTORY_PROBE_ADDRESS"],
  label: "program v1 devnet deployer"
});
const deployerAddress = wallet?.address || process.env.VITALS_PROGRAM_V1_DEVNET_ADDRESS || process.env.VITALS_HISTORY_PROBE_ADDRESS || null;
const operatorAddress = process.env.VITALS_PROGRAM_V1_DEVNET_OPERATOR_ADDRESS || deployerAddress;
const predecessorProgram = process.env.VITALS_PROGRAM_V1_PREDECESSOR_PROGRAM ||
  configuredProgrammedCircleId(process.env.VITALS_DEVNET_PROGRAMMED_CIRCLE_ID || process.env.VITALS_PROGRAMMED_CIRCLE_ID) ||
  process.env.VITALS_STATE_PROGRAM_ADDRESS ||
  "";
const missing = [
  deployerAddress ? null : "VITALS_PROGRAM_V1_DEVNET_ADDRESS or VITALS_HISTORY_PROBE_ADDRESS",
  operatorAddress ? null : "VITALS_PROGRAM_V1_DEVNET_OPERATOR_ADDRESS or deployer address",
  predecessorProgram && predecessorProgram !== "pending" ? null : "VITALS_PROGRAM_V1_PREDECESSOR_PROGRAM or VITALS_DEVNET_PROGRAMMED_CIRCLE_ID",
  deployEnabled && !wallet ? "VITALS_PROGRAM_V1_DEVNET_PRIVATE_KEY_B64 or VITALS_HISTORY_PROBE_PRIVATE_KEY_B64" : null,
  deployEnabled && !deployAck ? "VITALS_PROGRAM_V1_DEVNET_DEPLOY_ACK=1" : null
].filter((value): value is string => Boolean(value));
if (deployEnabled && missing.length) throw new Error(`missing requirements: ${missing.join(", ")}`);

const [deployOu, updateOu, callOu, deployFee, updateFee, callFee] = await Promise.all([
  recommendedOu("deploy_circle", "200000"),
  recommendedOu("circle_program_update", "200000"),
  recommendedOu("circle_call", "1000"),
  feeTelemetry("deploy_circle"),
  feeTelemetry("circle_program_update"),
  feeTelemetry("circle_call")
]);
const canonicalPayload = canonicalCircleDeployPayload();
const nonce = deployerAddress ? await nextNonce(deployerAddress) : 0;
const circleId = deployerAddress ? circleIdOfDeploy(deployerAddress, nonce, canonicalPayload) : "pending";
const baseReport = {
  schema: "octra-vitals-program-v1-devnet-deploy-v0",
  generated_at: isoNow(),
  status: deployEnabled ? "submitting" : "dry_run",
  rpc_url: rpcUrl,
  source_path: "program-v1/main.aml",
  source_hash: compile.source_hash,
  bytecode_hash: compile.bytecode_hash,
  verification_hash: compile.verification_hash,
  instructions: compile.instructions || null,
  size: compile.size || null,
  verification: compile.verification || null,
  deploy_enabled: deployEnabled,
  deployer_address: deployerAddress || "pending",
  operator_address: operatorAddress || "pending",
  predecessor_program: predecessorProgram || "pending",
  circle_id: circleId,
  missing_requirements: missing,
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

if (!deployEnabled) {
  await writeReport({
    ...baseReport,
    status: "dry_run",
    next_step: "set VITALS_PROGRAM_V1_DEVNET_DEPLOY=1 and VITALS_PROGRAM_V1_DEVNET_DEPLOY_ACK=1 to deploy the devnet-only v1 rehearsal Circle"
  });
} else {
  if (!wallet || !operatorAddress || !predecessorProgram) throw new Error("wallet, operator, and predecessor are required when deploy is enabled");
  let currentNonce = nonce;
  const deploySubmission = await submitTx(wallet, {
    from: wallet.address,
    to_: circleId,
    amount: "0",
    nonce: currentNonce,
    ou: deployOu,
    timestamp: Date.now() / 1000,
    op_type: "deploy_circle",
    message: canonicalPayload
  }, "program v1 devnet Circle deploy");
  currentNonce += 1;

  const updateSubmission = await submitTx(wallet, {
    from: wallet.address,
    to_: circleId,
    amount: "0",
    nonce: currentNonce,
    ou: updateOu,
    timestamp: Date.now() / 1000,
    op_type: "circle_program_update",
    message: JSON.stringify({ code_b64: compile.bytecode })
  }, "program v1 devnet program_update");
  currentNonce += 1;

  const initSubmission = await submitTx(wallet, {
    from: wallet.address,
    to_: circleId,
    amount: "0",
    nonce: currentNonce,
    ou: callOu,
    timestamp: Date.now() / 1000,
    op_type: "circle_call",
    encrypted_data: "initialize_v1",
    message: JSON.stringify([operatorAddress, predecessorProgram])
  }, "program v1 devnet initialize_v1");

  let initReceipt: Record<string, unknown> | null = null;
  let initReceiptError: string | null = null;
  if (waitForConfirmations) {
    try {
      initReceipt = receiptSummary(await contractReceipt(initSubmission.tx_hash));
    } catch (error) {
      initReceiptError = error instanceof Error ? error.message : String(error);
    }
  }
  if (requireContractReceipt && (initReceipt?.success !== true || initReceipt?.method !== "initialize_v1" || initReceipt?.contract !== circleId)) {
    throw new Error(`program v1 initialize_v1 receipt did not verify: ${JSON.stringify(initReceipt || { error: initReceiptError })}`);
  }

  const [programInfo, manifest, initialized, owner, operator, predecessor, count, historyRoot, capsulesRoot] = await Promise.all([
    octraRpc<any>("octra_circleProgramInfo", [circleId]),
    circleView<string>(rpcUrl, circleId, "manifest", wallet.address),
    circleView<boolean | string>(rpcUrl, circleId, "is_initialized", wallet.address),
    circleView<string>(rpcUrl, circleId, "get_owner", wallet.address),
    circleView<string>(rpcUrl, circleId, "get_operator", wallet.address),
    circleView<string>(rpcUrl, circleId, "get_predecessor_program", wallet.address),
    circleView<number | string>(rpcUrl, circleId, "get_snapshot_count", wallet.address),
    circleView<string>(rpcUrl, circleId, "get_history_root", wallet.address),
    circleView<string>(rpcUrl, circleId, "get_capsules_root", wallet.address)
  ]);
  const initializedOk = initialized === true || initialized === "true";
  const ownerOk = owner === wallet.address;
  const operatorOk = operator === operatorAddress;
  const predecessorOk = predecessor === predecessorProgram;
  if (manifest !== "vitals-circle-state.v1" || !initializedOk || !ownerOk || !operatorOk || !predecessorOk) {
    throw new Error(`program v1 initialization verification failed: ${JSON.stringify({
      manifest,
      initialized,
      owner,
      expected_owner: wallet.address,
      operator,
      expected_operator: operatorAddress,
      predecessor,
      expected_predecessor: predecessorProgram
    })}`);
  }

  await writeReport({
    ...baseReport,
    status: "initialized",
    deploy_tx_hash: deploySubmission.tx_hash,
    deploy_submit_result: deploySubmission.submit_result,
    deploy_tx: txSummary(deploySubmission.confirmation),
    program_update_tx_hash: updateSubmission.tx_hash,
    program_update_submit_result: updateSubmission.submit_result,
    program_update_tx: txSummary(updateSubmission.confirmation),
    initialize_tx_hash: initSubmission.tx_hash,
    initialize_submit_result: initSubmission.submit_result,
    initialize_tx: txSummary(initSubmission.confirmation),
    initialize_receipt: initReceipt,
    initialize_receipt_error: initReceiptError,
    program_info: programInfo,
    views: {
      manifest,
      initialized,
      owner,
      operator,
      predecessor,
      owner_matches: ownerOk,
      operator_matches: operatorOk,
      predecessor_matches: predecessorOk,
      snapshot_count: count,
      history_root: historyRoot,
      capsules_root: capsulesRoot
    },
    env_next: {
      VITALS_STATE_TARGET_MODE: "circle_program",
      VITALS_RECORD_SNAPSHOT_VERSION: "v1",
      VITALS_PROGRAMMED_CIRCLE_ID: circleId,
      VITALS_CIRCLE_VIEW_CALLER_ADDRESS: wallet.address
    }
  });
}
