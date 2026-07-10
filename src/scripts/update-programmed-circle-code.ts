#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  amlBytecodeHash,
  assertAmlCompileApproved,
  readApprovedAmlRelease,
  validateAmlCompile,
  type AmlCompileResult
} from "../lib/aml-artifacts.js";
import { circleProgramViewAtUrl } from "../lib/circle-program.js";
import { circleProgramInfoAtUrl, isExplicitDevelopmentRpcUrl, octraProgramRpcUrls, octraRpc, recommendedOu, rpcUrlLabel } from "../lib/octra-rpc.js";
import { loadWalletFromEnv, publicTransactionJson, signTransaction, transactionHash, type OctraTransaction, type OperatorWallet } from "../lib/octra-transaction.js";
import { writeJsonAtomic } from "./submit-snapshot.js";

const root = resolve(new URL("../..", import.meta.url).pathname);
const artifactDir = process.env.VITALS_PROGRAMMED_CIRCLE_ARTIFACT_DIR || "program-fact-ledger";
if (!/^[A-Za-z0-9._/-]+$/.test(artifactDir) || artifactDir.startsWith("/") || artifactDir.split("/").includes("..")) {
  throw new Error("VITALS_PROGRAMMED_CIRCLE_ARTIFACT_DIR must stay within the release");
}
const artifactRoot = resolve(root, artifactDir);
const buildRoot = resolve(root, "build");
const sourcePath = resolve(root, process.env.VITALS_PROGRAMMED_CIRCLE_SOURCE || join(artifactDir, "main.aml"));
const approvedPath = join(artifactRoot, "approved-release.json");
const compilePath = resolve(root, process.env.VITALS_PROGRAMMED_CIRCLE_COMPILE_ARTIFACT || join("build", artifactDir, "compile.json"));
if (sourcePath !== artifactRoot && !sourcePath.startsWith(`${artifactRoot}/`)) {
  throw new Error("VITALS_PROGRAMMED_CIRCLE_SOURCE must stay within its artifact directory");
}
if (compilePath !== buildRoot && !compilePath.startsWith(`${buildRoot}/`)) {
  throw new Error("VITALS_PROGRAMMED_CIRCLE_COMPILE_ARTIFACT must stay under build/");
}
const outPath = process.env.VITALS_PROGRAMMED_CIRCLE_UPDATE_OUT || join(root, "build", "programmed-circle-code-update.json");
const updateEnabled = process.env.VITALS_UPDATE_PROGRAMMED_CIRCLE === "1";
const waitForConfirmations = process.env.VITALS_DEPLOY_WAIT !== "0";

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function normalizeHash(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const text = value.replace(/^sha256:/, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(text) ? `sha256:${text}` : null;
}

function codeHashFromInfo(info: any): string | null {
  return normalizeHash(info?.code_hash || info?.program?.code_hash);
}

function assertNetworkIntent(urls: string[]): void {
  const unsafe = urls.filter((url) => !isExplicitDevelopmentRpcUrl(url));
  if (unsafe.length && process.env.VITALS_UPDATE_PROGRAMMED_CIRCLE_ALLOW_MAINNET !== "1") {
    throw new Error(`refusing programmed-Circle code update on non-devnet RPC(s): ${unsafe.map(rpcUrlLabel).join(", ")}`);
  }
}

function assertRpcQuorum(urls: string[]): void {
  const productionRpc = urls.some((url) => !isExplicitDevelopmentRpcUrl(url));
  const configured = Number(process.env.VITALS_MIN_PROGRAM_RPC_URLS || (productionRpc ? 2 : 1));
  if (!Number.isSafeInteger(configured) || configured < (productionRpc ? 2 : 1)) {
    throw new Error(`VITALS_MIN_PROGRAM_RPC_URLS must be at least ${productionRpc ? 2 : 1}`);
  }
  if (urls.length < configured) throw new Error(`program update requires ${configured} RPC URLs; got ${urls.length}`);
}

async function nextNonce(address: string): Promise<number> {
  const balance = await octraRpc<any>("octra_balance", [address]);
  const nonce = Number(balance?.pending_nonce ?? balance?.nonce ?? 0);
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error(`invalid nonce response for ${address}`);
  return nonce + 1;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function txStatus(tx: any): string {
  return String(tx?.status || tx?.transaction?.status || "");
}

async function waitConfirmed(hash: string): Promise<Record<string, unknown> | null> {
  if (!waitForConfirmations) return null;
  let latest: any = null;
  for (let attempt = 0; attempt < 45; attempt += 1) {
    await sleep(2_000);
    try {
      latest = await octraRpc<any>("octra_transaction", [hash]);
      const status = txStatus(latest);
      if (status === "confirmed") return latest;
      if (status === "rejected") break;
    } catch {
      // A submitted transaction can take a moment to become readable.
    }
  }
  throw new Error(`programmed-Circle code update did not confirm: ${stableJson(latest)}`);
}

async function submitUpdate(
  wallet: OperatorWallet,
  circleId: string,
  codeB64: string,
  ou: string,
  onPrepared: (submission: Record<string, unknown>) => void
): Promise<Record<string, unknown>> {
  const nonce = await nextNonce(wallet.address);
  const tx: OctraTransaction = {
    from: wallet.address,
    to_: circleId,
    amount: "0",
    nonce,
    ou,
    timestamp: Date.now() / 1000,
    op_type: "circle_program_update",
    message: JSON.stringify({ code_b64: codeB64 })
  };
  const signed = signTransaction(tx, wallet);
  const localTxHash = transactionHash(signed);
  const prepared = {
    tx_hash: localTxHash,
    nonce,
    ou,
    confirmation_status: "prepared"
  };
  onPrepared(prepared);
  const submitResult = await octraRpc<any>("octra_submit", [publicTransactionJson(signed)]);
  const reportedTxHash = submitResult?.tx_hash || submitResult?.hash;
  if (reportedTxHash) {
    const normalized = String(reportedTxHash).replace(/^sha256:/, "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalized) || normalized !== localTxHash) {
      throw new Error("programmed-Circle update RPC returned a transaction hash that does not match the signed transaction");
    }
  }
  return {
    ...prepared,
    submit_result: submitResult,
    confirmation_status: "submitted"
  };
}

async function confirmUpdate(submission: Record<string, unknown>): Promise<Record<string, unknown>> {
  const txHash = String(submission.tx_hash || "");
  if (!txHash) throw new Error("programmed-Circle code update submission has no transaction hash");
  const confirmation = await waitConfirmed(txHash);
  return {
    ...submission,
    confirmation_status: confirmation ? txStatus(confirmation) : "not_waited"
  };
}

async function view(url: string, circleId: string, method: string, params: unknown[] = []): Promise<unknown> {
  return circleProgramViewAtUrl(url, circleId, method, params);
}

async function readStateInvariantAtUrl(url: string, circleId: string): Promise<Record<string, unknown>> {
  const bundleBefore = String(await view(url, circleId, "get_latest_bundle"));
  const scalarMethods = [
    "manifest",
    "is_initialized",
    "get_owner",
    "get_operator",
    "is_paused",
    "get_successor_program",
    "is_successor_set",
    "get_era_program",
    "get_era_network_id",
    "get_predecessor_program",
    "get_predecessor_final_root",
    "get_predecessor_final_index",
    "get_predecessor_anchor_hash",
    "get_era_first_snapshot_index",
    "get_snapshot_count",
    "get_latest_snapshot_index",
    "get_latest_snapshot_id",
    "get_latest_observed_at",
    "get_latest_epoch",
    "get_latest_payload_hash",
    "get_latest_evidence_manifest_hash",
    "get_latest_source_refs_hash",
    "get_latest_summary_hash",
    "get_latest_history_row_hash",
    "get_latest_submitter",
    "get_catalog_root",
    "get_family_count"
  ];
  const scalarValues = await Promise.all(scalarMethods.map((method) => view(url, circleId, method)));
  const scalars = Object.fromEntries(scalarMethods.map((method, index) => [method, scalarValues[index]]));
  const familyCount = Number(scalars.get_family_count || 0);
  if (!Number.isSafeInteger(familyCount) || familyCount < 0 || familyCount > 9_999) {
    throw new Error(`invalid fact family count from ${rpcUrlLabel(url)}`);
  }
  const families = await Promise.all(Array.from({ length: familyCount }, async (_, ordinal) => {
    const ordinalKey = String(ordinal).padStart(4, "0");
    const familyId = String(await view(url, circleId, "get_family_id_at", [ordinalKey]));
    const methods = [
      "get_family_definition",
      "get_family_root",
      "get_family_capsules_root",
      "get_family_latest_index",
      "get_family_capsule_count",
      "get_family_latest_capsule_id",
      "get_family_open_capsule_id",
      "get_family_open_capsule_row_count",
      "get_family_open_capsule_start_root",
      "get_family_open_capsule_end_root"
    ];
    const values = await Promise.all(methods.map((method) => view(url, circleId, method, [familyId])));
    return { ordinal, family_id: familyId, ...Object.fromEntries(methods.map((method, index) => [method, values[index]])) };
  }));
  const bundleAfter = String(await view(url, circleId, "get_latest_bundle"));
  if (bundleBefore !== bundleAfter) throw new Error(`program state advanced during upgrade invariant read from ${rpcUrlLabel(url)}`);
  return { latest_bundle: bundleAfter, scalars, families };
}

async function readProgramState(urls: string[], circleId: string): Promise<{
  code_hash: string;
  invariant: Record<string, unknown>;
  rpc_urls_checked: number;
}> {
  const reads = await Promise.all(urls.map(async (url) => {
    const [info, invariant] = await Promise.all([
      circleProgramInfoAtUrl(url, circleId),
      readStateInvariantAtUrl(url, circleId)
    ]);
    const codeHash = codeHashFromInfo(info);
    if (!codeHash) throw new Error(`program code hash unavailable from ${rpcUrlLabel(url)}`);
    return { url, codeHash, invariant };
  }));
  const primary = reads[0];
  if (!primary) throw new Error("no Octra program RPC URL configured");
  for (const candidate of reads.slice(1)) {
    if (candidate.codeHash !== primary.codeHash) throw new Error(`program code hash RPC disagreement from ${rpcUrlLabel(candidate.url)}`);
    if (stableJson(candidate.invariant) !== stableJson(primary.invariant)) {
      throw new Error(`program state invariant RPC disagreement from ${rpcUrlLabel(candidate.url)}`);
    }
  }
  return { code_hash: primary.codeHash, invariant: primary.invariant, rpc_urls_checked: reads.length };
}

const urls = octraProgramRpcUrls();
if (!urls.length) throw new Error("no Octra program RPC URL configured");
assertNetworkIntent(urls);
assertRpcQuorum(urls);
const circleId = process.env.VITALS_PROGRAMMED_CIRCLE_ID;
if (!circleId || circleId === "pending") throw new Error("VITALS_PROGRAMMED_CIRCLE_ID is required");

const source = await readFile(sourcePath, "utf8");
const compileRaw = JSON.parse(await readFile(compilePath, "utf8")) as AmlCompileResult & { compiler_version?: string };
const compile: AmlCompileResult = { ...compileRaw };
if (!compile.version && compileRaw.compiler_version) compile.version = compileRaw.compiler_version;
const candidate = validateAmlCompile(source, compile);
assertAmlCompileApproved(candidate, await readApprovedAmlRelease(approvedPath));
const expectedCodeHash = candidate.bytecode_hash;

const before = await readProgramState(urls, circleId);
const liveNetworkId = String((before.invariant as any)?.scalars?.get_era_network_id || "");
if (!/^[A-Za-z0-9._-]{1,32}$/.test(liveNetworkId)) throw new Error("live AML network id is missing or invalid");
const configuredNetworkId = process.env.VITALS_FACT_LEDGER_NETWORK_ID;
if (configuredNetworkId && configuredNetworkId !== liveNetworkId) {
  throw new Error(`configured fact-ledger network ${configuredNetworkId} does not match live network ${liveNetworkId}`);
}
if (!/(?:^|[._-])(?:devnet|testnet|stage|local)(?:[._-]|$)/i.test(liveNetworkId) &&
    process.env.VITALS_UPDATE_PROGRAMMED_CIRCLE_ALLOW_MAINNET !== "1") {
  throw new Error(`refusing programmed-Circle code update for non-development AML network ${liveNetworkId}`);
}
const migrationAck = `${circleId}:${before.code_hash}->${expectedCodeHash}`;
const codeChangeRequired = before.code_hash !== expectedCodeHash;
const defaultPreviousCompilePath = join(root, artifactDir, "previous-approved-compile.json");
const previousCompilePath = process.env.VITALS_PROGRAM_UPDATE_PREVIOUS_COMPILE_ARTIFACT ||
  await readFile(defaultPreviousCompilePath).then(() => defaultPreviousCompilePath).catch(() => null);
let previousCodeB64: string | null = null;
if (previousCompilePath) {
  const previous = JSON.parse(await readFile(previousCompilePath, "utf8")) as Record<string, any>;
  previousCodeB64 = previous.bytecode || previous.bytecode_b64 || null;
  if (!previousCodeB64) throw new Error("previous compile artifact does not contain bytecode");
  const previousHash = amlBytecodeHash(previousCodeB64);
  if (previousHash !== before.code_hash) {
    throw new Error(`previous compile artifact hash ${previousHash} does not match live code ${before.code_hash}`);
  }
}

const wallet = loadWalletFromEnv({
  privateKeyEnv: ["VITALS_DEPLOYER_PRIVATE_KEY_B64"],
  addressEnv: ["VITALS_DEPLOYER_ADDRESS"],
  label: "programmed Circle owner/updater"
});
const liveAmlOwner = String((before.invariant as any)?.scalars?.get_owner || "");
const livePaused = (before.invariant as any)?.scalars?.is_paused === true ||
  (before.invariant as any)?.scalars?.is_paused === "true";
if (updateEnabled && codeChangeRequired && wallet && wallet.address !== liveAmlOwner) {
  throw new Error(`owner wallet ${wallet.address} does not match live AML owner ${liveAmlOwner || "<missing>"}`);
}
const ou = process.env.VITALS_PROGRAM_UPDATE_OU || process.env.VITALS_CIRCLE_PROGRAM_UPDATE_OU || await recommendedOu("circle_program_update", "200000");
const missing = [
  updateEnabled && codeChangeRequired && !wallet ? "VITALS_DEPLOYER_PRIVATE_KEY_B64" : null,
  updateEnabled && codeChangeRequired && process.env.VITALS_PROGRAM_UPDATE_COMPATIBILITY_ACK !== migrationAck
    ? `VITALS_PROGRAM_UPDATE_COMPATIBILITY_ACK=${migrationAck}` : null,
  updateEnabled && codeChangeRequired && !previousCodeB64 ? "VITALS_PROGRAM_UPDATE_PREVIOUS_COMPILE_ARTIFACT" : null,
  updateEnabled && codeChangeRequired && !waitForConfirmations ? "VITALS_DEPLOY_WAIT must not be 0" : null,
  updateEnabled && codeChangeRequired && !livePaused ? "pause the fact-ledger before updating its code" : null
].filter((value): value is string => Boolean(value));
if (updateEnabled && missing.length) throw new Error(`missing requirements: ${missing.join(", ")}`);

let status = !updateEnabled ? "dry_run" : codeChangeRequired ? "updating" : "already_current";
let update: Record<string, unknown> | null = null;
let rollback: Record<string, unknown> | null = null;
let after = before;
let failure: string | null = null;
let rollbackFailure: string | null = null;

if (updateEnabled && codeChangeRequired) {
  if (!wallet || !previousCodeB64) throw new Error("owner wallet and previous bytecode are required");
  try {
    update = await submitUpdate(wallet, circleId, candidate.code_b64, ou, (prepared) => {
      update = prepared;
    });
    update = await confirmUpdate(update);
    after = await readProgramState(urls, circleId);
    if (after.code_hash !== expectedCodeHash) {
      throw new Error(`live code hash mismatch after update: expected ${expectedCodeHash}, got ${after.code_hash}`);
    }
    if (stableJson(after.invariant) !== stableJson(before.invariant)) {
      throw new Error("program state invariants changed during the in-place code update");
    }
    status = "updated";
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    if (update) {
      try {
        rollback = await submitUpdate(wallet, circleId, previousCodeB64, ou, (prepared) => {
          rollback = prepared;
        });
        rollback = await confirmUpdate(rollback);
        after = await readProgramState(urls, circleId);
        if (after.code_hash !== before.code_hash || stableJson(after.invariant) !== stableJson(before.invariant)) {
          throw new Error("rollback state or code verification failed");
        }
        status = "rolled_back";
      } catch (rollbackError) {
        rollbackFailure = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        status = "rollback_failed";
        try {
          after = await readProgramState(urls, circleId);
        } catch {
          // Preserve the last verified state in the emergency report.
        }
      }
    } else {
      status = "failed_before_submission";
    }
  }
}

const report = {
  schema: "octra-vitals-programmed-circle-code-update-v1",
  generated_at: isoNow(),
  status,
  rpc_urls: urls.map(rpcUrlLabel),
  rpc_agreement: true,
  artifact_dir: artifactDir,
  compile_path: compilePath.replace(`${root}/`, ""),
  previous_compile_path: previousCompilePath,
  circle_id: circleId,
  updater_address: wallet?.address || process.env.VITALS_DEPLOYER_ADDRESS || null,
  expected_code_hash: expectedCodeHash,
  before_code_hash: before.code_hash,
  after_code_hash: after.code_hash,
  code_hash_matches: after.code_hash === expectedCodeHash,
  state_invariants_unchanged: stableJson(after.invariant) === stableJson(before.invariant),
  source_hash: candidate.source_hash,
  verification_hash: candidate.verification_hash,
  state_layout_hash: candidate.state_layout_hash,
  compiler_version: compile.version || null,
  instructions: compile.instructions || null,
  size: compile.size || null,
  update_enabled: updateEnabled,
  code_change_required: codeChangeRequired,
  required_compatibility_ack: migrationAck,
  missing_requirements: missing,
  ou,
  update,
  rollback,
  rollback_failure: rollbackFailure,
  failure,
  before_invariant: before.invariant,
  after_invariant: after.invariant
};

await writeJsonAtomic(outPath, report);
console.log(stableJson({
  schema: report.schema,
  status: report.status,
  circle_id: circleId,
  before_code_hash: before.code_hash,
  expected_code_hash: expectedCodeHash,
  after_code_hash: after.code_hash,
  state_invariants_unchanged: report.state_invariants_unchanged,
  report_path: outPath
}));

if (failure) {
  const rollbackText = rollbackFailure ? `; rollback failure=${rollbackFailure}` : "";
  throw new Error(`program update did not complete: ${failure}; final status=${status}${rollbackText}`);
}
