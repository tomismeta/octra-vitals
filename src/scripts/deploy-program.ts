#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { octraRpc, recommendedOu } from "../lib/octra-rpc.js";
import { loadWalletFromEnv, publicTransactionJson, signTransaction, transactionHash, type OctraTransaction } from "../lib/octra-transaction.js";

interface CompileArtifact {
  schema: "octra-vitals-program-compile-v0";
  source_hash: string;
  bytecode_hash: string;
  verification_hash: string;
  bytecode: string;
  abi: unknown;
}

const root = resolve(new URL("../..", import.meta.url).pathname);
const compilePath = join(root, "build", "program", "compile.json");
const outPath = process.argv[2] || join(root, "build", "deploy_program.json");
const deployEnabled = process.env.VITALS_DEPLOY_STATE_PROGRAM === "1";

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function firstEnv(...names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return null;
}

async function writeReport(report: unknown): Promise<void> {
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, stableJson(report));
  console.log(stableJson(summarizeReport(report)));
}

function summarizeReport(report: unknown): unknown {
  if (!report || typeof report !== "object") return report;
  const value = report as Record<string, any>;
  return {
    schema: value.schema,
    status: value.status,
    generated_at: value.generated_at,
    deploy_enabled: value.deploy_enabled,
    program_address: value.program_address,
    predicted_program_address: value.predicted_program_address,
    deployer_address: value.deployer_address,
    initial_operator_address: value.initial_operator_address,
    tx_hash: value.tx_hash,
    nonce: value.nonce,
    ou: value.ou,
    missing_requirements: value.missing_requirements,
    source_hash: value.source_hash,
    bytecode_hash: value.bytecode_hash,
    verification_hash: value.verification_hash,
    report_path: outPath
  };
}

async function nextNonce(address: string): Promise<number> {
  const balance = await octraRpc<any>("octra_balance", [address]);
  const nonce = Number(balance?.pending_nonce ?? balance?.nonce ?? 0);
  if (!Number.isInteger(nonce) || nonce < 0) throw new Error(`invalid nonce response for ${address}`);
  return nonce + 1;
}

async function computeProgramAddress(bytecode: string, deployer: string, nonce: number): Promise<string | null> {
  try {
    const result = await octraRpc<any>("octra_computeContractAddress", [bytecode, deployer, nonce]);
    return result?.address || null;
  } catch {
    return null;
  }
}

const artifact = JSON.parse(await readFile(compilePath, "utf8")) as CompileArtifact;
if (artifact.schema !== "octra-vitals-program-compile-v0" || !artifact.bytecode) {
  throw new Error(`${compilePath} is not a compiled Vitals State Program artifact`);
}

const deployerAddress = firstEnv("VITALS_DEPLOYER_ADDRESS", "VITALS_OPERATOR_ADDRESS");
const initialOperatorAddress = firstEnv("VITALS_INITIAL_OPERATOR_ADDRESS", "VITALS_OPERATOR_ADDRESS", "VITALS_DEPLOYER_ADDRESS");
const missing = [
  deployerAddress ? null : "VITALS_DEPLOYER_ADDRESS or VITALS_OPERATOR_ADDRESS",
  initialOperatorAddress ? null : "VITALS_INITIAL_OPERATOR_ADDRESS or VITALS_OPERATOR_ADDRESS"
].filter((value): value is string => Boolean(value));

if (!deployEnabled) {
  let predictedAddress: string | null = null;
  let predictedNonce: number | null = null;
  if (deployerAddress) {
    predictedNonce = await nextNonce(deployerAddress);
    predictedAddress = await computeProgramAddress(artifact.bytecode, deployerAddress, predictedNonce);
    if (!predictedAddress) throw new Error("dry-run could not compute program address");
  }
  await writeReport({
    schema: "octra-vitals-deploy-program-report-v0",
    status: "dry_run",
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    deploy_enabled: false,
    deployer_address: deployerAddress || "pending",
    initial_operator_address: initialOperatorAddress || "pending",
    predicted_program_address: predictedAddress || "pending",
    predicted_nonce: predictedNonce,
    missing_requirements: missing,
    source_hash: artifact.source_hash,
    bytecode_hash: artifact.bytecode_hash,
    verification_hash: artifact.verification_hash,
    constructor_params: initialOperatorAddress ? [initialOperatorAddress] : [],
    next_step: "set VITALS_DEPLOYER_ADDRESS, VITALS_INITIAL_OPERATOR_ADDRESS, VITALS_DEPLOYER_PRIVATE_KEY_B64, and VITALS_DEPLOY_STATE_PROGRAM=1 on the target host to deploy"
  });
} else {
  if (!initialOperatorAddress) throw new Error("VITALS_INITIAL_OPERATOR_ADDRESS or VITALS_OPERATOR_ADDRESS is required to deploy");
  const wallet = loadWalletFromEnv({
    privateKeyEnv: ["VITALS_DEPLOYER_PRIVATE_KEY_B64", "VITALS_OPERATOR_PRIVATE_KEY_B64", "OCTRA_PRIVATE_KEY_B64"],
    addressEnv: ["VITALS_DEPLOYER_ADDRESS", "VITALS_OPERATOR_ADDRESS"],
    label: "deployer"
  });
  if (!wallet) throw new Error("VITALS_DEPLOYER_PRIVATE_KEY_B64 or VITALS_OPERATOR_PRIVATE_KEY_B64 is required when VITALS_DEPLOY_STATE_PROGRAM=1");

  const nonce = await nextNonce(wallet.address);
  const programAddress = await computeProgramAddress(artifact.bytecode, wallet.address, nonce);
  if (!programAddress) throw new Error("octra_computeContractAddress did not return a program address");

  const ou = process.env.VITALS_DEPLOY_OU || await recommendedOu("deploy", "50000000");
  const tx: OctraTransaction = {
    from: wallet.address,
    to_: programAddress,
    amount: "0",
    nonce,
    ou,
    timestamp: Date.now() / 1000,
    op_type: "deploy",
    encrypted_data: artifact.bytecode,
    message: JSON.stringify([initialOperatorAddress])
  };
  const signed = signTransaction(tx, wallet);
  const txJson = publicTransactionJson(signed);
  const submitResult = await octraRpc<any>("octra_submit", [txJson]);
  const txHash = submitResult?.tx_hash || submitResult?.hash || transactionHash(signed);

  await writeReport({
    schema: "octra-vitals-deploy-program-report-v0",
    status: "submitted",
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    program_address: programAddress,
    deployer_address: wallet.address,
    initial_operator_address: initialOperatorAddress,
    tx_hash: txHash,
    nonce,
    ou,
    source_hash: artifact.source_hash,
    bytecode_hash: artifact.bytecode_hash,
    verification_hash: artifact.verification_hash,
    submit_result: submitResult,
    next_step: "after confirmation, set VITALS_STATE_PROGRAM_ADDRESS to program_address and run npm run program:verify-source"
  });
}
