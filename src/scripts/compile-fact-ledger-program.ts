#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  approvedAmlRelease,
  assertAmlAbiBackwardCompatible,
  assertAmlCompileApproved,
  assertAmlCompilerAgreement,
  assertPreviousCompileApproved,
  readApprovedAmlRelease,
  validateAmlCompile,
  type AmlCompileResult
} from "../lib/aml-artifacts.js";
import { isExplicitDevelopmentRpcUrl, octraProgramRpcUrls, octraRpc, rpcUrlLabel } from "../lib/octra-rpc.js";

const root = resolve(new URL("../..", import.meta.url).pathname);
const sourcePath = join(root, "program-fact-ledger", "main.aml");
const artifactDir = join(root, "program-fact-ledger");
const buildDir = join(root, "build", "program-fact-ledger");
const approvedPath = join(artifactDir, "approved-release.json");
const refreshPins = process.argv.includes("--refresh-pins");

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stableJson(value));
}

function compilerUrls(): string[] {
  const configured = process.env.OCTRA_COMPILER_RPC_URLS;
  const urls = configured
    ? configured.split(",").map((url) => url.trim()).filter(Boolean)
    : octraProgramRpcUrls();
  return Array.from(new Set(urls));
}

function assertCompilerNetworkIntent(urls: string[]): void {
  const unsafe = urls.filter((url) => !isExplicitDevelopmentRpcUrl(url));
  if (unsafe.length && process.env.VITALS_COMPILE_ALLOW_MAINNET !== "1") {
    throw new Error(`refusing AML compilation through non-devnet RPC(s): ${unsafe.map(rpcUrlLabel).join(", ")}`);
  }
}

const source = await readFile(sourcePath, "utf8");
const urls = compilerUrls();
if (!urls.length) throw new Error("no AML compiler RPC URL configured");
assertCompilerNetworkIntent(urls);
const production = /^(prod|production)$/i.test(process.env.VITALS_GATEWAY_ROLE || "");
const configuredMinimum = Number(process.env.VITALS_MIN_COMPILER_RPC_URLS || (refreshPins || production ? 2 : 1));
if (!Number.isSafeInteger(configuredMinimum) || configuredMinimum < 1) {
  throw new Error("VITALS_MIN_COMPILER_RPC_URLS must be a positive integer");
}
if (urls.length < configuredMinimum) {
  throw new Error(`at least ${configuredMinimum} independent AML compiler RPC URLs are required; got ${urls.length}`);
}
if (new Set(urls.map(rpcUrlLabel)).size < configuredMinimum) {
  throw new Error(`at least ${configuredMinimum} distinct AML compiler RPC authorities are required`);
}
const currentApproved = await readApprovedAmlRelease(approvedPath);
let previousApprovedCompile: (AmlCompileResult & Record<string, unknown>) | null = null;
let previousApprovedCompileInput: string | null = null;
if (refreshPins) {
  const candidates = process.env.VITALS_PROGRAM_UPDATE_PREVIOUS_COMPILE_ARTIFACT
    ? [resolve(root, process.env.VITALS_PROGRAM_UPDATE_PREVIOUS_COMPILE_ARTIFACT)]
    : [join(buildDir, "compile.json"), join(artifactDir, "previous-approved-compile.json")];
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      const previous = JSON.parse(await readFile(candidate, "utf8")) as AmlCompileResult & Record<string, unknown>;
      assertPreviousCompileApproved(previous, currentApproved);
      previousApprovedCompile = previous;
      previousApprovedCompileInput = candidate;
      break;
    } catch (error) {
      failures.push(`${candidate.replace(`${root}/`, "")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!previousApprovedCompile) {
    throw new Error(`pin refresh requires a compile artifact matching the previous approved release: ${failures.join(" | ")}`);
  }
}

const compiled = await Promise.all(urls.map(async (url) => ({
  url,
  value: validateAmlCompile(source, await octraRpc<AmlCompileResult>("octra_compileAml", [source], { url }))
})));
const primary = compiled[0];
if (!primary) throw new Error("AML compiler returned no result");
for (const candidate of compiled.slice(1)) assertAmlCompilerAgreement(primary.value, candidate.value, rpcUrlLabel(candidate.url));

if (refreshPins) {
  const expectedAck = primary.value.source_hash;
  if (process.env.VITALS_REFRESH_AML_PINS_ACK !== expectedAck) {
    throw new Error(`--refresh-pins requires VITALS_REFRESH_AML_PINS_ACK=${expectedAck}`);
  }
  if (primary.value.state_layout_hash !== currentApproved.state_layout_hash) {
    throw new Error("AML state layout changed; create a separately reviewed new era instead of refreshing in-place pins");
  }
  assertAmlAbiBackwardCompatible(
    JSON.parse(await readFile(join(artifactDir, "abi.json"), "utf8")),
    typeof primary.value.result.abi === "string" ? JSON.parse(primary.value.result.abi) : primary.value.result.abi
  );
} else {
  assertAmlCompileApproved(primary.value, currentApproved);
}

const result = primary.value.result;
const abi = typeof result.abi === "string" ? JSON.parse(result.abi) : result.abi;
const compileArtifact = {
  schema: "octra-vitals-fact-ledger-program-compile-v2",
  generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  source_path: "program-fact-ledger/main.aml",
  source_hash: primary.value.source_hash,
  bytecode_hash: primary.value.bytecode_hash,
  verification_hash: primary.value.verification_hash,
  abi_hash: primary.value.abi_hash,
  disasm_hash: primary.value.disasm_hash,
  state_layout_hash: primary.value.state_layout_hash,
  bytecode: primary.value.code_b64,
  size: result.size,
  instructions: result.instructions,
  compiler_version: result.version,
  compiler_rpc_urls: urls.map(rpcUrlLabel),
  compiler_rpc_agreement: true,
  abi,
  disasm: result.disasm,
  verification: result.verification || null,
  certificate: result.certificate || null
};

await mkdir(buildDir, { recursive: true });
if (refreshPins && previousApprovedCompile) {
  await writeJson(join(buildDir, "previous-approved-compile.json"), previousApprovedCompile);
  await writeJson(join(artifactDir, "previous-approved-compile.json"), previousApprovedCompile);
}
await writeJson(join(buildDir, "compile.json"), compileArtifact);
if (refreshPins) {
  await writeJson(join(artifactDir, "abi.json"), abi);
  await writeFile(join(artifactDir, "lowered.oasm"), `${String(result.disasm || "").trim()}\n`);
  await writeJson(join(artifactDir, "formal_verification.json"), result.verification || {});
  await writeJson(join(artifactDir, "formal_certificate.json"), result.certificate || {});
  await writeJson(approvedPath, approvedAmlRelease(primary.value));
}

console.log(stableJson({
  source_hash: primary.value.source_hash,
  bytecode_hash: primary.value.bytecode_hash,
  verification_hash: primary.value.verification_hash,
  safety: result.verification?.safety || null,
  verified: result.verification?.verified || false,
  instructions: result.instructions,
  size: result.size,
  compiler_rpc_urls: urls.map(rpcUrlLabel),
  compiler_rpc_agreement: true,
  outputs: ["build/program-fact-ledger/compile.json"],
  previous_approved_compile: refreshPins ? "build/program-fact-ledger/previous-approved-compile.json" : null,
  previous_approved_compile_input: previousApprovedCompileInput?.replace(`${root}/`, "") || null,
  pinned_artifacts_updated: refreshPins
}));
