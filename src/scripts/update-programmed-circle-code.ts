#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { circleProgramInfoAtUrl, octraProgramRpcUrl, octraRpc, recommendedOu } from "../lib/octra-rpc.js";
import { loadWalletFromEnv, publicTransactionJson, signTransaction, transactionHash, type OctraTransaction, type OperatorWallet } from "../lib/octra-transaction.js";
import { writeJsonAtomic } from "./submit-snapshot.js";

const root = resolve(new URL("../..", import.meta.url).pathname);
const artifactDir = process.env.VITALS_PROGRAMMED_CIRCLE_ARTIFACT_DIR || "program-fact-ledger";
const compilePath = process.env.VITALS_PROGRAMMED_CIRCLE_COMPILE_ARTIFACT || join(root, "build", artifactDir, "compile.json");
const outPath = process.env.VITALS_PROGRAMMED_CIRCLE_UPDATE_OUT || join(root, "build", "programmed-circle-code-update.json");
const updateEnabled = process.env.VITALS_UPDATE_PROGRAMMED_CIRCLE === "1";
const updateAck = process.env.VITALS_UPDATE_PROGRAMMED_CIRCLE_ACK === "1";
const waitForConfirmations = process.env.VITALS_DEPLOY_WAIT !== "0";

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertNetworkIntent(url: string): void {
  if (/devnet/i.test(url)) return;
  if (process.env.VITALS_UPDATE_PROGRAMMED_CIRCLE_ALLOW_MAINNET === "1") return;
  throw new Error(`refusing programmed-Circle code update on non-devnet RPC ${url}`);
}

function normalizeHash(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return value.startsWith("sha256:") ? value : `sha256:${value}`;
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

async function waitConfirmed(hash: string): Promise<Record<string, unknown> | null> {
  if (!waitForConfirmations) return null;
  let latest: any = null;
  for (let attempt = 0; attempt < 45; attempt += 1) {
    await sleep(2000);
    try {
      latest = await octraRpc<any>("octra_transaction", [hash]);
      const status = txStatus(latest);
      if (status === "confirmed") return latest;
      if (status === "rejected") break;
    } catch {
      // New transactions can take a moment to appear.
    }
  }
  throw new Error(`programmed-Circle code update did not confirm: ${stableJson(latest)}`);
}

async function submitUpdate(wallet: OperatorWallet, circleId: string, codeB64: string, ou: string): Promise<Record<string, unknown>> {
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
  const submitResult = await octraRpc<any>("octra_submit", [publicTransactionJson(signed)]);
  const txHash = submitResult?.tx_hash || submitResult?.hash || transactionHash(signed);
  const confirmation = await waitConfirmed(txHash);
  return {
    tx_hash: txHash,
    nonce,
    ou,
    submit_result: submitResult,
    confirmation_status: confirmation ? txStatus(confirmation) : "not_waited"
  };
}

const rpcUrl = octraProgramRpcUrl();
assertNetworkIntent(rpcUrl);
const circleId = process.env.VITALS_PROGRAMMED_CIRCLE_ID;
if (!circleId || circleId === "pending") throw new Error("VITALS_PROGRAMMED_CIRCLE_ID is required");

const compile = JSON.parse(await readFile(compilePath, "utf8")) as Record<string, any>;
const verification = compile.verification || {};
if (verification.verified !== true || verification.safety !== "safe" || verification.errors !== 0 || verification.warnings !== 0) {
  throw new Error(`compile artifact is not safe/verified: ${stableJson(verification)}`);
}
const codeB64 = compile.bytecode || compile.bytecode_b64;
if (!codeB64) throw new Error(`compile artifact ${compilePath} does not contain bytecode`);
const expectedCodeHash = normalizeHash(compile.bytecode_hash || compile.certificate?.bytecode_hash);
if (!expectedCodeHash) throw new Error(`compile artifact ${compilePath} does not contain bytecode hash`);

const beforeInfo = await circleProgramInfoAtUrl(rpcUrl, circleId).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
const beforeCodeHash = normalizeHash((beforeInfo as any)?.code_hash || (beforeInfo as any)?.program?.code_hash);
const wallet = loadWalletFromEnv({
  privateKeyEnv: ["VITALS_DEPLOYER_PRIVATE_KEY_B64", "VITALS_OPERATOR_PRIVATE_KEY_B64", "OCTRA_PRIVATE_KEY_B64"],
  addressEnv: ["VITALS_DEPLOYER_ADDRESS", "VITALS_OPERATOR_ADDRESS"],
  label: "programmed Circle updater"
});
const ou = process.env.VITALS_PROGRAM_UPDATE_OU || process.env.VITALS_CIRCLE_PROGRAM_UPDATE_OU || await recommendedOu("circle_program_update", "200000");
const missing = [
  updateEnabled && !wallet ? "VITALS_DEPLOYER_PRIVATE_KEY_B64 or VITALS_OPERATOR_PRIVATE_KEY_B64" : null,
  updateEnabled && !updateAck ? "VITALS_UPDATE_PROGRAMMED_CIRCLE_ACK=1" : null
].filter((value): value is string => Boolean(value));
if (updateEnabled && missing.length) throw new Error(`missing requirements: ${missing.join(", ")}`);

let update: Record<string, unknown> | null = null;
if (updateEnabled) {
  if (!wallet) throw new Error("wallet required");
  update = await submitUpdate(wallet, circleId, codeB64, ou);
}

const afterInfo = updateEnabled
  ? await circleProgramInfoAtUrl(rpcUrl, circleId)
  : beforeInfo;
const afterCodeHash = normalizeHash((afterInfo as any)?.code_hash || (afterInfo as any)?.program?.code_hash);
const codeHashMatches = updateEnabled ? afterCodeHash === expectedCodeHash : null;
if (updateEnabled && !codeHashMatches) {
  throw new Error(`live code hash mismatch after update: expected ${expectedCodeHash}, got ${afterCodeHash}`);
}

const report = {
  schema: "octra-vitals-programmed-circle-code-update-v0",
  generated_at: isoNow(),
  status: updateEnabled ? "updated" : "dry_run",
  rpc_url: rpcUrl,
  artifact_dir: artifactDir,
  compile_path: compilePath.replace(`${root}/`, ""),
  circle_id: circleId,
  updater_address: wallet?.address || process.env.VITALS_DEPLOYER_ADDRESS || process.env.VITALS_OPERATOR_ADDRESS || null,
  expected_code_hash: expectedCodeHash,
  before_code_hash: beforeCodeHash,
  after_code_hash: afterCodeHash,
  code_hash_matches: codeHashMatches,
  source_hash: normalizeHash(compile.source_hash || compile.certificate?.source_hash),
  verification_hash: normalizeHash(compile.verification_hash || compile.certificate?.verification_hash),
  compiler_version: compile.compiler_version || compile.version || null,
  instructions: compile.instructions || null,
  size: compile.size || null,
  update_enabled: updateEnabled,
  missing_requirements: missing,
  ou,
  update
};

await writeJsonAtomic(outPath, report);
console.log(stableJson({
  schema: report.schema,
  status: report.status,
  circle_id: circleId,
  before_code_hash: beforeCodeHash,
  expected_code_hash: expectedCodeHash,
  after_code_hash: afterCodeHash,
  code_hash_matches: codeHashMatches,
  report_path: outPath
}));
