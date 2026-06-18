#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { sha256Hex } from "../lib/canonical-json.js";
import { contractSource, octraRpc, vmContract } from "../lib/octra-rpc.js";

const root = resolve(new URL("../..", import.meta.url).pathname);
const outPath = process.argv[2] || join(root, "build", "verify_deployed_program_source.json");

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function normalizeHash(value: unknown): string | null {
  if (!value) return null;
  const text = String(value);
  return text.startsWith("sha256:") ? text : `sha256:${text}`;
}

function extractContractSource(value: any): string | null {
  if (!value || typeof value !== "object") return null;
  for (const key of ["source", "aml_source", "contract_source", "code"]) {
    if (typeof value[key] === "string" && value[key].length > 0) return value[key];
  }
  return null;
}

function extractBytecodeHash(value: any): string | null {
  if (!value || typeof value !== "object") return null;
  for (const key of ["bytecode_hash", "code_hash", "hash"]) {
    if (value[key]) return normalizeHash(value[key]);
  }
  if (value.contract && typeof value.contract === "object") return extractBytecodeHash(value.contract);
  return null;
}

async function writeReport(report: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, stableJson(report));
  console.log(stableJson({
    status: report.status,
    program_address: report.program_address,
    source_hash: report.source_hash,
    bytecode_hash: report.bytecode_hash,
    source_hash_matches: report.source_hash_matches,
    bytecode_hash_matches: report.bytecode_hash_matches,
    report_path: outPath
  }));
}

const programAddress = process.env.VITALS_STATE_PROGRAM_ADDRESS;
if (!programAddress || programAddress === "pending") {
  throw new Error("VITALS_STATE_PROGRAM_ADDRESS is required");
}

const [source, abi, compile] = await Promise.all([
  readFile(join(root, "program", "main.aml"), "utf8"),
  readFile(join(root, "program", "abi.json"), "utf8").then((text) => JSON.parse(text)),
  readFile(join(root, "build", "program", "compile.json"), "utf8").then((text) => JSON.parse(text))
]);
const expectedSourceHash = `sha256:${sha256Hex(source)}`;
const expectedBytecodeHash = String(compile.bytecode_hash || "");

let verifyResult: unknown = null;
let saveAbiResult: unknown = null;
let saveAbiFallbackResult: unknown = null;
try {
  verifyResult = await octraRpc("contract_verify", [programAddress, source]);
  try {
    saveAbiResult = await octraRpc("contract_saveAbi", [programAddress, abi]);
  } catch {
    saveAbiFallbackResult = await octraRpc("contract_saveAbi", [programAddress, JSON.stringify(abi)]);
  }
} catch (error) {
  await writeReport({
    schema: "octra-vitals-deployed-source-verification-v0",
    status: "failed",
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    program_address: programAddress,
    source_hash: expectedSourceHash,
    bytecode_hash: expectedBytecodeHash,
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
}

const [sourceBody, vmBody] = await Promise.all([
  contractSource(programAddress),
  vmContract(programAddress)
]);
const liveSource = extractContractSource(sourceBody);
const liveSourceHash = liveSource ? `sha256:${sha256Hex(liveSource)}` : null;
const liveBytecodeHash = extractBytecodeHash(vmBody);
const sourceMatches = liveSourceHash === expectedSourceHash;
const bytecodeMatches = liveBytecodeHash === expectedBytecodeHash;

await writeReport({
  schema: "octra-vitals-deployed-source-verification-v0",
  status: sourceMatches && bytecodeMatches ? "verified" : "mismatch",
  generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  program_address: programAddress,
  source_hash: expectedSourceHash,
  bytecode_hash: expectedBytecodeHash,
  live_source_hash: liveSourceHash,
  live_bytecode_hash: liveBytecodeHash,
  source_hash_matches: sourceMatches,
  bytecode_hash_matches: bytecodeMatches,
  contract_verify_result: verifyResult,
  contract_saveAbi_result: saveAbiResult || saveAbiFallbackResult,
  contract_source: sourceBody,
  vm_contract: vmBody
});

if (!sourceMatches || !bytecodeMatches) process.exitCode = 1;
