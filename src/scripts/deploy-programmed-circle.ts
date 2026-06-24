#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { contractReceipt, feeTelemetry, octraProgramRpcUrl, octraRpc, recommendedOu } from "../lib/octra-rpc.js";
import { loadWalletFromEnv, publicTransactionJson, signTransaction, transactionHash, type OctraTransaction, type OperatorWallet } from "../lib/octra-transaction.js";
import { sha256Hex } from "../lib/canonical-json.js";
import {
  FACT_LEDGER_MANIFEST,
  coreFactFamilyDefinition,
  encodeFactFamilyDefinition
} from "../lib/aml-fact-ledger.js";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const root = resolve(new URL("../..", import.meta.url).pathname);
type ProgrammedCircleProgramKind = "v0" | "fact-ledger";

function programmedCircleProgramKind(): ProgrammedCircleProgramKind {
  const configured = process.env.VITALS_PROGRAMMED_CIRCLE_PROGRAM || process.env.VITALS_RECORD_SNAPSHOT_VERSION;
  if (configured === "fact-ledger" || configured === "fact-v1") return "fact-ledger";
  if (configured === "v0" || configured === undefined || configured === "") return "v0";
  throw new Error("VITALS_PROGRAMMED_CIRCLE_PROGRAM must be v0 or fact-ledger");
}

const programKind = programmedCircleProgramKind();
const artifactDir = process.env.VITALS_PROGRAMMED_CIRCLE_ARTIFACT_DIR || (programKind === "fact-ledger" ? "program-fact-ledger" : "program-circle");
const sourcePath = process.env.VITALS_PROGRAMMED_CIRCLE_SOURCE || join(root, artifactDir, "main.aml");
const outPath = process.argv.find((arg) => arg.endsWith(".json")) || join(root, "build", "programmed-circle-deploy.json");
const deployEnabled = process.env.VITALS_DEPLOY_PROGRAMMED_CIRCLE === "1";
const deployAcknowledged = process.env.VITALS_DEPLOY_PROGRAMMED_CIRCLE_ACK === "1";
const waitForConfirmations = process.env.VITALS_DEPLOY_WAIT !== "0";
const requireContractReceipt = waitForConfirmations && process.env.VITALS_REQUIRE_CONTRACT_RECEIPT !== "0";
const expectedAmlManifest = programKind === "fact-ledger" ? FACT_LEDGER_MANIFEST : "vitals-circle-state.v0";

interface CompileResult {
  bytecode?: string;
  bytecode_b64?: string;
  size?: number;
  instructions?: number;
  version?: string;
  verification?: unknown;
  certificate?: {
    source_hash?: string;
    bytecode_hash?: string;
    verification_hash?: string;
  };
}

function assertSafeCompile(compile: CompileResult): void {
  const verification = compile.verification as any;
  if (
    !verification ||
    verification.verified !== true ||
    verification.safety !== "safe" ||
    verification.errors !== 0 ||
    verification.warnings !== 0
  ) {
    throw new Error(`programmed Circle AML verification failed: ${JSON.stringify(verification || null)}`);
  }
  if (!compile.certificate?.bytecode_hash || !compile.certificate?.verification_hash) {
    throw new Error("programmed Circle AML compile did not return certificate hashes");
  }
}

function prefixedHash(value: string | undefined | null): string | null {
  if (!value) return null;
  return value.startsWith("sha256:") ? value : `sha256:${value}`;
}

function compactJsonHash(value: unknown): string {
  return `sha256:${sha256Hex(JSON.stringify(value))}`;
}

function bytecodeHash(bytecodeBase64: string): string {
  return `sha256:${sha256Hex(Buffer.from(bytecodeBase64, "base64"))}`;
}

async function readJsonIfExists<T = any>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function assertCompileMatchesPinnedArtifacts(source: string, compile: CompileResult, codeB64: string): Promise<void> {
  if (process.env.VITALS_ALLOW_PROGRAMMED_CIRCLE_ARTIFACT_DRIFT === "1") return;
  const sourceHash = `sha256:${sha256Hex(source)}`;
  const compiledBytecodeHash = bytecodeHash(codeB64);
  const compileArtifact = await readJsonIfExists<Record<string, any>>(join(root, "build", artifactDir, "compile.json"));
  if (compileArtifact) {
    const failures = [
      compileArtifact.source_hash && normalizeComparableHash(compileArtifact.source_hash) !== sourceHash ? "compile_artifact_source_hash" : null,
      compileArtifact.bytecode_hash && normalizeComparableHash(compileArtifact.bytecode_hash) !== compiledBytecodeHash ? "compile_artifact_bytecode_hash" : null,
      compileArtifact.verification_hash && prefixedHash(compile.certificate?.verification_hash) !== normalizeComparableHash(compileArtifact.verification_hash) ? "compile_artifact_verification_hash" : null,
      prefixedHash(compile.certificate?.source_hash) !== sourceHash ? "source_hash" : null,
      prefixedHash(compile.certificate?.bytecode_hash) !== compiledBytecodeHash ? "bytecode_hash" : null
    ].filter(Boolean);
    if (failures.length) {
      throw new Error(`programmed Circle compile output drifted from ${artifactDir} compile artifact: ${failures.join(", ")}`);
    }
    return;
  }
  const [pinnedVerificationText, pinnedCertificateText, pinnedAbiText, pinnedLowered] = await Promise.all([
    readFile(join(root, artifactDir, "formal_verification.json"), "utf8"),
    readFile(join(root, artifactDir, "formal_certificate.json"), "utf8"),
    readFile(join(root, artifactDir, "abi.json"), "utf8"),
    readFile(join(root, artifactDir, "lowered.oasm"), "utf8")
  ]);
  const pinnedVerification = JSON.parse(pinnedVerificationText);
  const pinnedCertificate = JSON.parse(pinnedCertificateText);
  const pinnedAbi = JSON.parse(pinnedAbiText);
  const verificationHash = compactJsonHash(pinnedVerification);
  const failures = [
    prefixedHash(compile.certificate?.source_hash) && prefixedHash(compile.certificate?.source_hash) !== sourceHash ? "source_hash" : null,
    prefixedHash(compile.certificate?.bytecode_hash) !== compiledBytecodeHash ? "bytecode_hash" : null,
    prefixedHash(compile.certificate?.verification_hash) !== verificationHash ? "verification_hash" : null,
    prefixedHash(pinnedCertificate.source_hash) !== sourceHash ? "pinned_source_hash" : null,
    prefixedHash(pinnedCertificate.bytecode_hash) !== compiledBytecodeHash ? "pinned_bytecode_hash" : null,
    prefixedHash(pinnedCertificate.verification_hash) !== verificationHash ? "pinned_verification_hash" : null,
    compactJsonHash(compile.verification) !== verificationHash ? "verification_body" : null,
    compactJsonHash((compile as any).abi) !== compactJsonHash(pinnedAbi) ? "abi" : null,
    `${String((compile as any).disasm || "").trim()}\n` !== `${pinnedLowered.trim()}\n` ? "lowered_oasm" : null
  ].filter(Boolean);
  if (failures.length) {
    throw new Error(`programmed Circle compile output drifted from pinned artifacts: ${failures.join(", ")}`);
  }
}

function normalizeComparableHash(value: string): string {
  return value.startsWith("sha256:") ? value : `sha256:${value}`;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
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

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function nextNonce(address: string): Promise<number> {
  const balance = await octraRpc<any>("octra_balance", [address]);
  const nonce = Number(balance?.pending_nonce ?? balance?.nonce ?? 0);
  if (!Number.isInteger(nonce) || nonce < 0) throw new Error(`invalid nonce response for ${address}`);
  return nonce + 1;
}

async function submitTx(wallet: OperatorWallet, tx: OctraTransaction) {
  const signed = signTransaction(tx, wallet);
  const txJson = publicTransactionJson(signed);
  const submitResult = await octraRpc<any>("octra_submit", [txJson]);
  return {
    tx_hash: submitResult?.tx_hash || submitResult?.hash || transactionHash(signed),
    submit_result: submitResult
  };
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

async function pollTx(hash: string, attempts = 45): Promise<any> {
  let latest: any = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(2000);
    try {
      latest = await octraRpc<any>("octra_transaction", [hash]);
      const status = txStatus(latest);
      if (status === "confirmed" || status === "rejected") return latest;
    } catch {
      // New transactions can take a moment to appear.
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

async function circleView(circleId: string, method: string, caller: string): Promise<unknown> {
  const result = await octraRpc<any>("octra_circleView", [circleId, method, [], caller, false]);
  if (result && typeof result === "object" && "result" in result) return result.result;
  return result;
}

async function circleViewOptional<T = unknown>(circleId: string, method: string, caller: string, fallback: T): Promise<T> {
  try {
    const value = await circleView(circleId, method, caller);
    return value as T;
  } catch {
    return fallback;
  }
}

function hex64OrFallback(value: unknown, fallback: string): string {
  const text = String(value || "").replace(/^sha256:/, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(text) ? text : fallback;
}

async function resolveFactLedgerPredecessor(callerAddress: string, nextCircleId: string) {
  const zeroRoot = "0".repeat(64);
  const predecessorAddress =
    process.env.VITALS_FACT_LEDGER_PREDECESSOR_PROGRAM ||
    process.env.VITALS_PREDECESSOR_PROGRAM ||
    process.env.VITALS_PROGRAMMED_CIRCLE_ID ||
    nextCircleId;
  const explicitIndex = process.env.VITALS_FACT_LEDGER_PREDECESSOR_FINAL_INDEX || process.env.VITALS_PREDECESSOR_FINAL_INDEX;
  const explicitRoot = process.env.VITALS_FACT_LEDGER_PREDECESSOR_FINAL_ROOT || process.env.VITALS_PREDECESSOR_FINAL_ROOT;
  let predecessorFinalIndex = explicitIndex ? Number(explicitIndex) : 0;
  if (!Number.isInteger(predecessorFinalIndex) || predecessorFinalIndex < 0) {
    throw new Error("VITALS_FACT_LEDGER_PREDECESSOR_FINAL_INDEX must be a non-negative integer");
  }
  if (!explicitIndex && predecessorAddress && predecessorAddress !== nextCircleId) {
    predecessorFinalIndex = Number(await circleViewOptional(predecessorAddress, "get_snapshot_count", callerAddress, 0) || 0);
  }
  let predecessorFinalRoot = explicitRoot ? hex64OrFallback(explicitRoot, "") : "";
  if (!predecessorFinalRoot && predecessorAddress && predecessorAddress !== nextCircleId) {
    const rootRead =
      await circleViewOptional(predecessorAddress, "get_history_root", callerAddress, "") ||
      await circleViewOptional(predecessorAddress, "get_open_capsule_end_root", callerAddress, "") ||
      await circleViewOptional(predecessorAddress, "get_recent_summary_window_hash", callerAddress, "");
    predecessorFinalRoot = hex64OrFallback(rootRead, zeroRoot);
  }
  if (!predecessorFinalRoot) predecessorFinalRoot = zeroRoot;
  return {
    predecessorAddress,
    predecessorFinalIndex,
    predecessorFinalRoot,
    eraFirstSnapshotIndex: predecessorFinalIndex + 1
  };
}

function factLedgerNetworkId(): string {
  const configured = process.env.VITALS_FACT_LEDGER_NETWORK_ID || process.env.VITALS_OCTRA_NETWORK_ID;
  if (configured) return configured;
  return /devnet/i.test(octraProgramRpcUrl()) ? "octra-devnet" : "octra-mainnet";
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

const [source, recommendedDeployOu, recommendedUpdateOu, recommendedCallOu, deployFee, updateFee, callFee] = await Promise.all([
  readFile(sourcePath, "utf8"),
  recommendedOu("deploy_circle", "200000"),
  recommendedOu("circle_program_update", "200000"),
  recommendedOu("circle_call", "1000"),
  feeTelemetry("deploy_circle"),
  feeTelemetry("circle_program_update"),
  feeTelemetry("circle_call")
]);
const deployOu = process.env.VITALS_DEPLOY_CIRCLE_OU || recommendedDeployOu;
const updateOu = process.env.VITALS_PROGRAM_UPDATE_OU || process.env.VITALS_CIRCLE_PROGRAM_UPDATE_OU || recommendedUpdateOu;
const callOu = process.env.VITALS_INITIALIZE_CALL_OU || process.env.VITALS_CALL_OU || recommendedCallOu;
const compile = await octraRpc<CompileResult>("octra_compileAml", [source]);
assertSafeCompile(compile);
const codeB64 = compile.bytecode || compile.bytecode_b64;
if (!codeB64) throw new Error("octra_compileAml did not return bytecode");
await assertCompileMatchesPinnedArtifacts(source, compile, codeB64);

const wallet = loadWalletFromEnv({
  privateKeyEnv: ["VITALS_DEPLOYER_PRIVATE_KEY_B64", "VITALS_OPERATOR_PRIVATE_KEY_B64", "OCTRA_PRIVATE_KEY_B64"],
  addressEnv: ["VITALS_DEPLOYER_ADDRESS", "VITALS_OPERATOR_ADDRESS"],
  label: "programmed Circle deployer"
});
const deployerAddress = wallet?.address || process.env.VITALS_DEPLOYER_ADDRESS || process.env.VITALS_OPERATOR_ADDRESS || null;
const operatorAddress = process.env.VITALS_INITIAL_OPERATOR_ADDRESS || process.env.VITALS_OPERATOR_ADDRESS || deployerAddress || null;
const missing = [
  deployerAddress ? null : "VITALS_DEPLOYER_ADDRESS or VITALS_OPERATOR_ADDRESS",
  operatorAddress ? null : "VITALS_INITIAL_OPERATOR_ADDRESS or VITALS_OPERATOR_ADDRESS",
  deployEnabled && !wallet ? "VITALS_DEPLOYER_PRIVATE_KEY_B64 or VITALS_OPERATOR_PRIVATE_KEY_B64" : null,
  deployEnabled && !deployAcknowledged ? "VITALS_DEPLOY_PROGRAMMED_CIRCLE_ACK=1" : null
].filter((value): value is string => Boolean(value));
if (deployEnabled && missing.length) throw new Error(`missing requirements: ${missing.join(", ")}`);

const canonicalPayload = canonicalCircleDeployPayload();
const nonce = deployerAddress ? await nextNonce(deployerAddress) : 0;
const circleId = deployerAddress ? circleIdOfDeploy(deployerAddress, nonce, canonicalPayload) : "pending";
const factLedgerPredecessor = programKind === "fact-ledger" && deployerAddress && circleId !== "pending"
  ? await resolveFactLedgerPredecessor(deployerAddress, circleId)
  : null;
const factLedgerCoreDefinition = factLedgerPredecessor
  ? encodeFactFamilyDefinition(coreFactFamilyDefinition(factLedgerPredecessor.eraFirstSnapshotIndex))
  : null;
const factLedgerNetwork = programKind === "fact-ledger" ? factLedgerNetworkId() : null;
const baseReport = {
  schema: "octra-vitals-programmed-circle-deploy-v0",
  generated_at: isoNow(),
  status: deployEnabled ? "submitting" : "dry_run",
  rpc_url: octraProgramRpcUrl(),
  program_kind: programKind,
  artifact_dir: artifactDir,
  source_path: sourcePath.replace(`${root}/`, ""),
  source_hash: `sha256:${sha256Hex(source)}`,
  bytecode_hash: compile.certificate?.bytecode_hash ? `sha256:${compile.certificate.bytecode_hash}` : null,
  verification_hash: compile.certificate?.verification_hash ? `sha256:${compile.certificate.verification_hash}` : null,
  compiler_version: compile.version || null,
  instructions: compile.instructions || null,
  size: compile.size || null,
  verification: compile.verification || null,
  deploy_enabled: deployEnabled,
  deployer_address: deployerAddress || "pending",
  operator_address: operatorAddress || "pending",
  circle_id: circleId,
  fact_ledger: factLedgerPredecessor ? {
    manifest: FACT_LEDGER_MANIFEST,
    network_id: factLedgerNetwork,
    predecessor_program: factLedgerPredecessor.predecessorAddress,
    predecessor_final_root: factLedgerPredecessor.predecessorFinalRoot,
    predecessor_final_index: factLedgerPredecessor.predecessorFinalIndex,
    era_first_snapshot_index: factLedgerPredecessor.eraFirstSnapshotIndex
  } : null,
  missing_requirements: missing,
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
  }
};

if (!deployEnabled) {
  await writeReport({
    ...baseReport,
    status: "dry_run",
    next_step: "set VITALS_DEPLOY_PROGRAMMED_CIRCLE=1 and VITALS_DEPLOY_PROGRAMMED_CIRCLE_ACK=1 to deploy, program_update, and initialize a devnet/mainnet rehearsal Circle"
  });
} else {
  if (!wallet || !operatorAddress) throw new Error("wallet and operator are required when deploy is enabled");
  let currentNonce = nonce;
  const deployTx: OctraTransaction = {
    from: wallet.address,
    to_: circleId,
    amount: "0",
    nonce: currentNonce,
    ou: deployOu,
    timestamp: Date.now() / 1000,
    op_type: "deploy_circle",
    message: canonicalPayload
  };
  const deploySubmission = await submitTx(wallet, deployTx);
  const deployConfirmation = await requireConfirmed(deploySubmission.tx_hash, "programmed Circle deploy");
  currentNonce += 1;

  const updateTx: OctraTransaction = {
    from: wallet.address,
    to_: circleId,
    amount: "0",
    nonce: currentNonce,
    ou: updateOu,
    timestamp: Date.now() / 1000,
    op_type: "circle_program_update",
    message: JSON.stringify({ code_b64: codeB64 })
  };
  const updateSubmission = await submitTx(wallet, updateTx);
  const updateConfirmation = await requireConfirmed(updateSubmission.tx_hash, "programmed Circle program_update");
  currentNonce += 1;

  const initMethod = programKind === "fact-ledger" ? "initialize_fact_ledger" : "initialize_v0";
  const initParams = programKind === "fact-ledger"
    ? [
      operatorAddress,
      factLedgerPredecessor?.predecessorAddress,
      factLedgerPredecessor?.predecessorFinalRoot,
      factLedgerPredecessor?.predecessorFinalIndex,
      factLedgerPredecessor?.eraFirstSnapshotIndex,
      factLedgerNetwork,
      circleId,
      factLedgerCoreDefinition
    ]
    : [operatorAddress];
  if (programKind === "fact-ledger" && (
    !factLedgerPredecessor ||
    !factLedgerCoreDefinition ||
    !factLedgerNetwork ||
    initParams.some((value) => value === undefined || value === null || value === "")
  )) {
    throw new Error("fact-ledger initialization parameters were incomplete");
  }

  const initTx: OctraTransaction = {
    from: wallet.address,
    to_: circleId,
    amount: "0",
    nonce: currentNonce,
    ou: callOu,
    timestamp: Date.now() / 1000,
    op_type: "circle_call",
    encrypted_data: initMethod,
    message: JSON.stringify(initParams)
  };
  const initSubmission = await submitTx(wallet, initTx);
  const initConfirmation = await requireConfirmed(initSubmission.tx_hash, `programmed Circle ${initMethod}`);
  let initReceipt: Record<string, unknown> | null = null;
  let initReceiptError: string | null = null;
  if (waitForConfirmations) {
    try {
      initReceipt = receiptSummary(await contractReceipt(initSubmission.tx_hash));
    } catch (error) {
      initReceiptError = error instanceof Error ? error.message : String(error);
    }
  }
  if (requireContractReceipt && (initReceipt?.success !== true || initReceipt?.method !== initMethod || initReceipt?.contract !== circleId)) {
    throw new Error(`programmed Circle ${initMethod} receipt did not verify: ${JSON.stringify(initReceipt || { error: initReceiptError })}`);
  }

  const [
    programInfo,
    manifest,
    initialized,
    owner,
    operator,
    count,
    eraNetwork,
    eraProgram,
    predecessorProgram,
    predecessorRoot,
    predecessorIndex,
    eraFirstIndex
  ] = await Promise.all([
    octraRpc<any>("octra_circleProgramInfo", [circleId]),
    circleView(circleId, "manifest", wallet.address),
    circleView(circleId, "is_initialized", wallet.address),
    circleView(circleId, "get_owner", wallet.address),
    circleView(circleId, "get_operator", wallet.address),
    circleView(circleId, "get_snapshot_count", wallet.address),
    programKind === "fact-ledger" ? circleView(circleId, "get_era_network_id", wallet.address) : Promise.resolve(null),
    programKind === "fact-ledger" ? circleView(circleId, "get_era_program", wallet.address) : Promise.resolve(null),
    programKind === "fact-ledger" ? circleView(circleId, "get_predecessor_program", wallet.address) : Promise.resolve(null),
    programKind === "fact-ledger" ? circleView(circleId, "get_predecessor_final_root", wallet.address) : Promise.resolve(null),
    programKind === "fact-ledger" ? circleView(circleId, "get_predecessor_final_index", wallet.address) : Promise.resolve(null),
    programKind === "fact-ledger" ? circleView(circleId, "get_era_first_snapshot_index", wallet.address) : Promise.resolve(null)
  ]);
  const initializedOk = initialized === true || initialized === "true";
  const ownerOk = owner === wallet.address;
  const operatorOk = operator === operatorAddress;
  const factLedgerOk = programKind !== "fact-ledger" || (
    eraNetwork === factLedgerNetwork &&
    eraProgram === circleId &&
    predecessorProgram === factLedgerPredecessor?.predecessorAddress &&
    predecessorRoot === factLedgerPredecessor?.predecessorFinalRoot &&
    Number(predecessorIndex || 0) === factLedgerPredecessor?.predecessorFinalIndex &&
    Number(eraFirstIndex || 0) === factLedgerPredecessor?.eraFirstSnapshotIndex &&
    Number(count || 0) === factLedgerPredecessor?.predecessorFinalIndex
  );
  if (manifest !== expectedAmlManifest || !initializedOk || !ownerOk || !operatorOk || !factLedgerOk) {
    throw new Error(`programmed Circle initialization verification failed: ${JSON.stringify({
      manifest,
      expected_manifest: expectedAmlManifest,
      initialized,
      owner,
      expected_owner: wallet.address,
      operator,
      expected_operator: operatorAddress,
      era_network: eraNetwork,
      expected_era_network: factLedgerNetwork,
      era_program: eraProgram,
      expected_era_program: programKind === "fact-ledger" ? circleId : null,
      predecessor_program: predecessorProgram,
      expected_predecessor_program: factLedgerPredecessor?.predecessorAddress || null,
      predecessor_root: predecessorRoot,
      expected_predecessor_root: factLedgerPredecessor?.predecessorFinalRoot || null,
      predecessor_index: predecessorIndex,
      expected_predecessor_index: factLedgerPredecessor?.predecessorFinalIndex ?? null,
      era_first_index: eraFirstIndex,
      expected_era_first_index: factLedgerPredecessor?.eraFirstSnapshotIndex ?? null,
      snapshot_count: count
    })}`);
  }

  await writeReport({
    ...baseReport,
    status: "initialized",
    deploy_tx_hash: deploySubmission.tx_hash,
    deploy_submit_result: deploySubmission.submit_result,
    deploy_tx: txSummary(deployConfirmation),
    program_update_tx_hash: updateSubmission.tx_hash,
    program_update_submit_result: updateSubmission.submit_result,
    program_update_tx: txSummary(updateConfirmation),
    initialize_tx_hash: initSubmission.tx_hash,
    initialize_submit_result: initSubmission.submit_result,
    initialize_tx: txSummary(initConfirmation),
    initialize_receipt: initReceipt,
    initialize_receipt_error: initReceiptError,
    program_info: programInfo,
    views: {
      manifest,
      initialized,
      owner,
      operator,
      owner_matches: ownerOk,
      operator_matches: operatorOk,
      snapshot_count: count,
      era_network: eraNetwork,
      era_program: eraProgram,
      predecessor_program: predecessorProgram,
      predecessor_final_root: predecessorRoot,
      predecessor_final_index: predecessorIndex,
      era_first_snapshot_index: eraFirstIndex
    },
    env_next: {
      VITALS_STATE_TARGET_MODE: "circle_program",
      VITALS_PROGRAMMED_CIRCLE_ID: circleId,
      VITALS_CIRCLE_VIEW_CALLER_ADDRESS: wallet.address,
      ...(programKind === "fact-ledger" ? {
        VITALS_PROGRAMMED_CIRCLE_PROGRAM: "fact-ledger",
        VITALS_PROGRAMMED_CIRCLE_ARTIFACT_DIR: artifactDir,
        VITALS_RECORD_SNAPSHOT_VERSION: "fact-v1",
        VITALS_FACT_LEDGER_CUTOVER_ACK: `fact-v1:circle_program:${circleId}`,
        VITALS_FACT_LEDGER_NETWORK_ID: factLedgerNetwork,
        VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_SOURCE_HASH: `sha256:${sha256Hex(source)}`,
        VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_BYTECODE_HASH: compile.certificate?.bytecode_hash ? `sha256:${compile.certificate.bytecode_hash}` : null,
        VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_VERIFICATION_HASH: compile.certificate?.verification_hash ? `sha256:${compile.certificate.verification_hash}` : null
      } : {})
    }
  });
}
