#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { contractReceipt, feeTelemetry, isExplicitDevelopmentRpcUrl, octraProgramRpcUrl, octraProgramRpcUrls, octraRpc, recommendedOu, rpcUrlLabel } from "../lib/octra-rpc.js";
import { loadWalletFromEnv, publicTransactionJson, signTransaction, submittedTransactionHash, transactionHash, type OctraTransaction, type OperatorWallet } from "../lib/octra-transaction.js";
import { sha256Hex } from "../lib/canonical-json.js";
import { assertAmlCompileApproved, readApprovedAmlRelease, validateAmlCompile, type AmlCompileResult } from "../lib/aml-artifacts.js";
import { assertDistinctProductionRoles, parseFactLedgerLatestBundle } from "../lib/fact-ledger-deployment.js";
import {
  FACT_LEDGER_MANIFEST,
  coreFactFamilyDefinition,
  encodeFactFamilyDefinition
} from "../lib/aml-fact-ledger.js";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const root = resolve(new URL("../..", import.meta.url).pathname);

function assertProgramKind(): void {
  const configured = process.env.VITALS_PROGRAMMED_CIRCLE_PROGRAM || process.env.VITALS_RECORD_SNAPSHOT_VERSION;
  if (configured === "fact-ledger" || configured === "fact-v1" || configured === "fact-v2" || configured === undefined || configured === "") return;
  throw new Error("VITALS_PROGRAMMED_CIRCLE_PROGRAM must be fact-ledger");
}

assertProgramKind();
const programKind = "fact-ledger";
const artifactDir = process.env.VITALS_PROGRAMMED_CIRCLE_ARTIFACT_DIR || "program-fact-ledger";
if (!/^[A-Za-z0-9._/-]+$/.test(artifactDir) || artifactDir.startsWith("/") || artifactDir.split("/").includes("..")) {
  throw new Error("VITALS_PROGRAMMED_CIRCLE_ARTIFACT_DIR must stay within the release");
}
const artifactRoot = resolve(root, artifactDir);
const sourcePath = resolve(root, process.env.VITALS_PROGRAMMED_CIRCLE_SOURCE || join(artifactDir, "main.aml"));
if (sourcePath !== artifactRoot && !sourcePath.startsWith(`${artifactRoot}/`)) {
  throw new Error("VITALS_PROGRAMMED_CIRCLE_SOURCE must stay within its artifact directory");
}
const outPath = process.argv.find((arg) => arg.endsWith(".json")) || join(root, "build", "programmed-circle-deploy.json");
const deployEnabled = process.env.VITALS_DEPLOY_PROGRAMMED_CIRCLE === "1";
const deployAcknowledged = process.env.VITALS_DEPLOY_PROGRAMMED_CIRCLE_ACK === "1";
const waitForConfirmations = process.env.VITALS_DEPLOY_WAIT !== "0";
const requireContractReceipt = waitForConfirmations && process.env.VITALS_REQUIRE_CONTRACT_RECEIPT !== "0";
const expectedAmlManifest = FACT_LEDGER_MANIFEST;

interface CompileResult extends AmlCompileResult {}

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

function canonicalCircleDeployPayload(codeB64: string | null): string {
  return [
    "{",
    "\"runtime\":\"octb\",",
    "\"privacy_class\":\"public\",",
    "\"browser_mode\":\"gateway_allowed\",",
    "\"resource_mode\":\"public_resources\",",
    `"code_b64":${codeB64 === null ? "null" : JSON.stringify(codeB64)},`,
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

function reportDeployPayload(canonicalPayload: string, deployWithCode: boolean, codeB64: string): Record<string, unknown> {
  const payload = JSON.parse(canonicalPayload) as Record<string, unknown>;
  if (deployWithCode) payload.code_b64 = `[embedded:${bytecodeHash(codeB64)}]`;
  return payload;
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function nextNonce(address: string): Promise<number> {
  const balance = await octraRpc<any>("octra_balance", [address]);
  const nonce = Number(balance?.pending_nonce ?? balance?.nonce ?? 0);
  if (!Number.isSafeInteger(nonce) || nonce < 0 || nonce >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`invalid nonce response for ${address}`);
  }
  return nonce + 1;
}

async function submitTx(
  wallet: OperatorWallet,
  tx: OctraTransaction,
  onPrepared: (prepared: Record<string, unknown>) => Promise<void>
) {
  const signed = signTransaction(tx, wallet);
  const localTxHash = transactionHash(signed);
  await onPrepared({
    prepared_tx_hash: localTxHash,
    tx_hash: localTxHash,
    hash_source: "prepared_transaction",
    nonce: tx.nonce,
    op_type: tx.op_type,
    to: tx.to_,
    confirmation_status: "prepared"
  });
  const txJson = publicTransactionJson(signed);
  const submitResult = await octraRpc<any>("octra_submit", [txJson]);
  const { txHash, returnedTxHash, hashSource } = submittedTransactionHash(submitResult, localTxHash);
  return {
    prepared_tx_hash: localTxHash,
    tx_hash: txHash,
    returned_tx_hash: returnedTxHash,
    hash_source: hashSource,
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

async function circleViewAtUrl(url: string, circleId: string, method: string, caller: string): Promise<unknown> {
  const result = await octraRpc<any>("octra_circleView", [circleId, method, [], caller, false], { url });
  if (result && typeof result === "object" && "result" in result) return result.result;
  return result;
}

function requiredHex64(value: unknown, label: string): string {
  const text = String(value || "").replace(/^sha256:/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`${label} must be 64 lowercase hex characters`);
  return text;
}

function requiredAddress(value: unknown, label: string): string {
  const text = String(value || "");
  if (!/^oct[1-9A-HJ-NP-Za-km-z]{44}$/.test(text)) throw new Error(`${label} is not a valid Octra address`);
  return text;
}

function requiredSafeIndex(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is invalid`);
  return parsed;
}

async function resolveFactLedgerPredecessor(callerAddress: string, nextCircleId: string) {
  const zeroRoot = "0".repeat(64);
  const configuredPredecessor =
    process.env.VITALS_FACT_LEDGER_PREDECESSOR_PROGRAM ||
    process.env.VITALS_PREDECESSOR_PROGRAM ||
    "";
  if (!configuredPredecessor) {
    throw new Error("VITALS_FACT_LEDGER_PREDECESSOR_PROGRAM must explicitly name a predecessor or genesis");
  }
  const cleanGenesis = /^(self|none|genesis|clean)$/i.test(configuredPredecessor);
  const predecessorAddress = cleanGenesis ? nextCircleId : requiredAddress(configuredPredecessor, "fact-ledger predecessor");
  const explicitIndex = process.env.VITALS_FACT_LEDGER_PREDECESSOR_FINAL_INDEX || process.env.VITALS_PREDECESSOR_FINAL_INDEX;
  const explicitRoot = process.env.VITALS_FACT_LEDGER_PREDECESSOR_FINAL_ROOT || process.env.VITALS_PREDECESSOR_FINAL_ROOT;
  if (cleanGenesis) {
    if (explicitIndex && Number(explicitIndex) !== 0) throw new Error("genesis predecessor index must be zero");
    if (explicitRoot && requiredHex64(explicitRoot, "genesis predecessor root") !== zeroRoot) {
      throw new Error("genesis predecessor root must be zero");
    }
    return {
      predecessorAddress,
      predecessorFinalIndex: 0,
      predecessorFinalRoot: zeroRoot,
      eraFirstSnapshotIndex: 1,
      rpcUrlsChecked: 0,
      predecessorFrozen: true
    };
  }

  const reads = await Promise.all(octraProgramRpcUrls().map(async (url) => {
    const beforeText = String(await circleViewAtUrl(url, predecessorAddress, "get_latest_bundle", callerAddress));
    const [manifest, count, paused, successorSet] = await Promise.all([
      circleViewAtUrl(url, predecessorAddress, "manifest", callerAddress).catch(() => ""),
      circleViewAtUrl(url, predecessorAddress, "get_snapshot_count", callerAddress),
      circleViewAtUrl(url, predecessorAddress, "is_paused", callerAddress).catch(() => false),
      circleViewAtUrl(url, predecessorAddress, "is_successor_set", callerAddress).catch(() => false)
    ]);
    const countNumber = requiredSafeIndex(count, "predecessor snapshot count");
    const afterText = String(await circleViewAtUrl(url, predecessorAddress, "get_latest_bundle", callerAddress));
    if (beforeText !== afterText) throw new Error(`predecessor advanced during fenced read from ${rpcUrlLabel(url)}`);
    let bundle;
    if (manifest === "vitals-circle-state.v0") {
      const legacyBundleIndex = requiredSafeIndex(afterText.split("|")[0], "v0 predecessor latest bundle index");
      if (legacyBundleIndex !== countNumber) {
        throw new Error(`v0 predecessor snapshot count mismatch from ${rpcUrlLabel(url)}`);
      }
      const summaryWindowHash = await circleViewAtUrl(url, predecessorAddress, "get_recent_summary_window_hash", callerAddress);
      bundle = {
        snapshot_index: countNumber,
        snapshot_id: "",
        payload_hash: "",
        history_row_hash: "",
        history_root: requiredHex64(summaryWindowHash, "v0 predecessor summary window hash"),
        catalog_root: ""
      };
    } else {
      bundle = parseFactLedgerLatestBundle(afterText, { allowRootOnly: true });
      const historyRoot = await circleViewAtUrl(url, predecessorAddress, "get_history_root", callerAddress);
      if (countNumber !== bundle.snapshot_index) throw new Error(`predecessor snapshot count mismatch from ${rpcUrlLabel(url)}`);
      if (requiredHex64(historyRoot, "predecessor history root") !== bundle.history_root) {
        throw new Error(`predecessor history root mismatch from ${rpcUrlLabel(url)}`);
      }
    }
    return {
      url,
      manifest,
      bundle,
      frozen: paused === true || paused === "true" || successorSet === true || successorSet === "true"
    };
  }));
  const primary = reads[0];
  if (!primary) throw new Error("no predecessor RPC URL configured");
  for (const candidate of reads.slice(1)) {
    if (candidate.manifest !== primary.manifest || JSON.stringify(candidate.bundle) !== JSON.stringify(primary.bundle) || candidate.frozen !== primary.frozen) {
      throw new Error(`predecessor RPC disagreement from ${rpcUrlLabel(candidate.url)}`);
    }
  }
  if (!primary.frozen) throw new Error("predecessor must be paused or have its successor set before a new era is deployed");
  const predecessorFinalIndex = primary.bundle.snapshot_index;
  const predecessorFinalRoot = primary.bundle.history_root;
  if (explicitIndex && Number(explicitIndex) !== predecessorFinalIndex) throw new Error("explicit predecessor index does not match fenced read");
  if (explicitRoot && requiredHex64(explicitRoot, "explicit predecessor root") !== predecessorFinalRoot) {
    throw new Error("explicit predecessor root does not match fenced read");
  }
  const expectedFreezeAck = `${predecessorAddress}:${predecessorFinalIndex}:${predecessorFinalRoot}`;
  if (process.env.VITALS_PREDECESSOR_FROZEN_ACK !== expectedFreezeAck) {
    throw new Error(`predecessor freeze requires VITALS_PREDECESSOR_FROZEN_ACK=${expectedFreezeAck}`);
  }
  return {
    predecessorAddress,
    predecessorFinalIndex,
    predecessorFinalRoot,
    eraFirstSnapshotIndex: predecessorFinalIndex + 1,
    rpcUrlsChecked: reads.length,
    predecessorFrozen: true
  };
}

function factLedgerNetworkId(): string {
  const configured = process.env.VITALS_FACT_LEDGER_NETWORK_ID || process.env.VITALS_OCTRA_NETWORK_ID;
  if (configured) {
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(configured)) throw new Error("VITALS_FACT_LEDGER_NETWORK_ID is invalid");
    return configured;
  }
  if (deployEnabled) throw new Error("VITALS_FACT_LEDGER_NETWORK_ID is required for deployment");
  return "pending";
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
const buildRoot = resolve(root, "build");
const compilePath = resolve(root, process.env.VITALS_PROGRAMMED_CIRCLE_COMPILE_ARTIFACT || join("build", artifactDir, "compile.json"));
if (compilePath !== buildRoot && !compilePath.startsWith(`${buildRoot}/`)) {
  throw new Error("VITALS_PROGRAMMED_CIRCLE_COMPILE_ARTIFACT must stay under build/");
}
const compileRaw = JSON.parse(await readFile(compilePath, "utf8")) as CompileResult & { compiler_version?: string };
const compile: CompileResult = { ...compileRaw };
if (!compile.version && compileRaw.compiler_version) compile.version = compileRaw.compiler_version;
assertSafeCompile(compile);
const validatedCompile = validateAmlCompile(source, compile);
await assertCompileMatchesPinnedArtifacts(source, compile, validatedCompile.code_b64);
await assertAmlCompileApproved(
  validatedCompile,
  await readApprovedAmlRelease(join(root, artifactDir, "approved-release.json"))
);
const codeB64 = validatedCompile.code_b64;
const deployWithCode = process.env.VITALS_DEPLOY_CIRCLE_WITH_CODE === "1";

const wallet = loadWalletFromEnv({
  privateKeyEnv: ["VITALS_DEPLOYER_PRIVATE_KEY_B64"],
  addressEnv: ["VITALS_DEPLOYER_ADDRESS"],
  label: "programmed Circle deployer"
});
const deployerAddress = wallet?.address || process.env.VITALS_DEPLOYER_ADDRESS || null;
const operatorAddress = process.env.VITALS_INITIAL_OPERATOR_ADDRESS || null;
if (deployerAddress) requiredAddress(deployerAddress, "programmed Circle deployer");
if (operatorAddress) requiredAddress(operatorAddress, "initial operator");
const configuredRpcUrls = octraProgramRpcUrls();
const productionWrite = deployEnabled && !isExplicitDevelopmentRpcUrl(octraProgramRpcUrl());
const minimumProgramRpcUrls = Number(process.env.VITALS_MIN_PROGRAM_RPC_URLS || (productionWrite ? 2 : 1));
if (!Number.isSafeInteger(minimumProgramRpcUrls) || minimumProgramRpcUrls < (productionWrite ? 2 : 1)) {
  throw new Error(`VITALS_MIN_PROGRAM_RPC_URLS must be at least ${productionWrite ? 2 : 1}`);
}
if (deployerAddress && operatorAddress) assertDistinctProductionRoles(deployerAddress, operatorAddress, productionWrite);
const missing = [
  deployerAddress ? null : "VITALS_DEPLOYER_ADDRESS",
  operatorAddress ? null : "VITALS_INITIAL_OPERATOR_ADDRESS",
  deployEnabled && !wallet ? "VITALS_DEPLOYER_PRIVATE_KEY_B64" : null,
  deployEnabled && !deployAcknowledged ? "VITALS_DEPLOY_PROGRAMMED_CIRCLE_ACK=1" : null,
  deployEnabled && !waitForConfirmations ? "VITALS_DEPLOY_WAIT must not be 0" : null,
  deployEnabled && configuredRpcUrls.length < minimumProgramRpcUrls
    ? `${minimumProgramRpcUrls} distinct OCTRA_PROGRAM_RPC_URLS` : null,
  productionWrite && process.env.VITALS_DEPLOY_PROGRAMMED_CIRCLE_ALLOW_MAINNET !== "1"
    ? "VITALS_DEPLOY_PROGRAMMED_CIRCLE_ALLOW_MAINNET=1" : null
].filter((value): value is string => Boolean(value));
if (deployEnabled && missing.length) throw new Error(`missing requirements: ${missing.join(", ")}`);

const canonicalPayload = canonicalCircleDeployPayload(deployWithCode ? codeB64 : null);
const nonce = deployerAddress ? await nextNonce(deployerAddress) : 0;
const circleId = deployerAddress ? circleIdOfDeploy(deployerAddress, nonce, canonicalPayload) : "pending";
const factLedgerPredecessor = deployerAddress && circleId !== "pending"
  ? await resolveFactLedgerPredecessor(deployerAddress, circleId)
  : null;
const factLedgerCoreDefinition = factLedgerPredecessor
  ? encodeFactFamilyDefinition(coreFactFamilyDefinition(factLedgerPredecessor.eraFirstSnapshotIndex))
  : null;
const factLedgerNetwork = factLedgerNetworkId();
const baseReport = {
  schema: "octra-vitals-programmed-circle-deploy-v0",
  generated_at: isoNow(),
  status: deployEnabled ? "submitting" : "dry_run",
  rpc_url: rpcUrlLabel(octraProgramRpcUrl()),
  program_kind: programKind,
  artifact_dir: artifactDir,
  source_path: sourcePath.replace(`${root}/`, ""),
  compile_path: compilePath.replace(`${root}/`, ""),
  source_hash: validatedCompile.source_hash,
  bytecode_hash: validatedCompile.bytecode_hash,
  verification_hash: validatedCompile.verification_hash,
  compiler_version: compile.version || null,
  instructions: compile.instructions || null,
  size: compile.size || null,
  verification: compile.verification || null,
  deploy_enabled: deployEnabled,
  deploy_with_code: deployWithCode,
  deployer_address: deployerAddress || "pending",
  operator_address: operatorAddress || "pending",
  circle_id: circleId,
  fact_ledger: factLedgerPredecessor ? {
    manifest: FACT_LEDGER_MANIFEST,
    network_id: factLedgerNetwork,
    predecessor_program: factLedgerPredecessor.predecessorAddress,
    predecessor_final_root: factLedgerPredecessor.predecessorFinalRoot,
    predecessor_final_index: factLedgerPredecessor.predecessorFinalIndex,
    era_first_snapshot_index: factLedgerPredecessor.eraFirstSnapshotIndex,
    predecessor_frozen: factLedgerPredecessor.predecessorFrozen,
    predecessor_rpc_urls_checked: factLedgerPredecessor.rpcUrlsChecked
  } : null,
  missing_requirements: missing,
  deploy_payload: reportDeployPayload(canonicalPayload, deployWithCode, codeB64),
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
    next_step: deployWithCode
      ? "set VITALS_DEPLOY_PROGRAMMED_CIRCLE=1 and VITALS_DEPLOY_PROGRAMMED_CIRCLE_ACK=1 to deploy and initialize a devnet/mainnet rehearsal Circle"
      : "set VITALS_DEPLOY_PROGRAMMED_CIRCLE=1 and VITALS_DEPLOY_PROGRAMMED_CIRCLE_ACK=1 to deploy, program_update, and initialize a devnet/mainnet rehearsal Circle"
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
  const deploySubmission = await submitTx(wallet, deployTx, (prepared) => writeReport({
    ...baseReport,
    status: "deploy_prepared",
    pending_transaction: { label: "deploy_circle", ...prepared }
  }));
  const deployConfirmation = await requireConfirmed(deploySubmission.tx_hash, "programmed Circle deploy");
  currentNonce += 1;

  let updateSubmission: Awaited<ReturnType<typeof submitTx>> | null = null;
  let updateConfirmation: any = null;
  if (!deployWithCode) {
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
    updateSubmission = await submitTx(wallet, updateTx, (prepared) => writeReport({
      ...baseReport,
      status: "program_update_prepared",
      deploy_tx_hash: deploySubmission.tx_hash,
      deploy_tx: txSummary(deployConfirmation),
      pending_transaction: { label: "circle_program_update", ...prepared }
    }));
    updateConfirmation = await requireConfirmed(updateSubmission.tx_hash, "programmed Circle program_update");
    currentNonce += 1;
  }

  const [preInitializeProgramInfo, preInitializeOwner, preInitializeState] = await Promise.all([
    octraRpc<any>("octra_circleProgramInfo", [circleId]),
    circleView(circleId, "get_owner", wallet.address),
    circleView(circleId, "is_initialized", wallet.address)
  ]);
  const preInitializeMetadataOwner = String(preInitializeProgramInfo?.owner || "");
  const preInitializeOwnerUnset = preInitializeOwner === "0" || preInitializeOwner === 0 || preInitializeOwner === null;
  const preInitializeOwnerAcceptable = preInitializeOwner === wallet.address ||
    (preInitializeOwnerUnset && preInitializeMetadataOwner === wallet.address);
  if (!preInitializeOwnerAcceptable || preInitializeState === true || preInitializeState === "true") {
    throw new Error(`program constructor ownership check failed before initialization: ${JSON.stringify({
      owner: preInitializeOwner,
      expected_owner: wallet.address,
      circle_metadata_owner: preInitializeMetadataOwner || null,
      initialized: preInitializeState
    })}`);
  }

  const initMethod = "initialize_fact_ledger";
  const initParams = [
    operatorAddress,
    factLedgerPredecessor?.predecessorAddress,
    factLedgerPredecessor?.predecessorFinalRoot,
    factLedgerPredecessor?.predecessorFinalIndex,
    factLedgerPredecessor?.eraFirstSnapshotIndex,
    factLedgerNetwork,
    circleId,
    factLedgerCoreDefinition
  ];
  if (
    !factLedgerPredecessor ||
    !factLedgerCoreDefinition ||
    !factLedgerNetwork ||
    initParams.some((value) => value === undefined || value === null || value === "")
  ) {
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
  const initSubmission = await submitTx(wallet, initTx, (prepared) => writeReport({
    ...baseReport,
    status: "initialize_prepared",
    deploy_tx_hash: deploySubmission.tx_hash,
    deploy_tx: txSummary(deployConfirmation),
    program_update_tx_hash: updateSubmission?.tx_hash || null,
    program_update_tx: updateConfirmation ? txSummary(updateConfirmation) : null,
    pending_transaction: { label: initMethod, ...prepared }
  }));
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
    circleView(circleId, "get_era_network_id", wallet.address),
    circleView(circleId, "get_era_program", wallet.address),
    circleView(circleId, "get_predecessor_program", wallet.address),
    circleView(circleId, "get_predecessor_final_root", wallet.address),
    circleView(circleId, "get_predecessor_final_index", wallet.address),
    circleView(circleId, "get_era_first_snapshot_index", wallet.address)
  ]);
  const initializedOk = initialized === true || initialized === "true";
  const ownerOk = owner === wallet.address;
  const operatorOk = operator === operatorAddress;
  const factLedgerOk = (
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
      expected_era_program: circleId,
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
    program_update_tx_hash: updateSubmission?.tx_hash || null,
    program_update_submit_result: updateSubmission?.submit_result || null,
    program_update_tx: updateConfirmation ? txSummary(updateConfirmation) : null,
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
      VITALS_PROGRAMMED_CIRCLE_PROGRAM: "fact-ledger",
      VITALS_PROGRAMMED_CIRCLE_ARTIFACT_DIR: artifactDir,
      VITALS_RECORD_SNAPSHOT_VERSION: "fact-v2",
      VITALS_FACT_LEDGER_CUTOVER_ACK: `fact-v2:circle_program:${circleId}`,
      VITALS_FACT_LEDGER_NETWORK_ID: factLedgerNetwork,
      VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_SOURCE_HASH: validatedCompile.source_hash,
      VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_BYTECODE_HASH: validatedCompile.bytecode_hash,
      VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_VERIFICATION_HASH: validatedCompile.verification_hash
    }
  });
}
