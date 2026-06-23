#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { octraRpc } from "../lib/octra-rpc.js";
import { sha256Hex } from "../lib/canonical-json.js";

const root = resolve(new URL("../..", import.meta.url).pathname);
const sourcePath = join(root, "program-v1", "main.aml");
const buildDir = join(root, "build", "program-v1");

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stableJson(value));
}

const source = await readFile(sourcePath, "utf8");
const result = await octraRpc<any>("octra_compileAml", [source]);
const abi = typeof result.abi === "string" ? JSON.parse(result.abi) : result.abi;

const compileArtifact = {
  schema: "octra-vitals-program-v1-compile",
  generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  source_path: "program-v1/main.aml",
  source_hash: `sha256:${sha256Hex(source)}`,
  bytecode_hash: result.certificate?.bytecode_hash ? `sha256:${result.certificate.bytecode_hash}` : null,
  verification_hash: result.certificate?.verification_hash ? `sha256:${result.certificate.verification_hash}` : null,
  bytecode: result.bytecode,
  size: result.size,
  instructions: result.instructions,
  compiler_version: result.version,
  abi,
  disasm: result.disasm,
  verification: result.verification || null,
  certificate: result.certificate || null
};

await mkdir(buildDir, { recursive: true });
await writeJson(join(buildDir, "compile.json"), compileArtifact);
await writeJson(join(root, "program-v1", "abi.json"), abi);
await writeFile(join(root, "program-v1", "lowered.oasm"), `${result.disasm || ""}\n`);
await writeJson(join(root, "program-v1", "formal_verification.json"), result.verification || {});
await writeJson(join(root, "program-v1", "formal_certificate.json"), result.certificate || {});

console.log(stableJson({
  source_hash: compileArtifact.source_hash,
  bytecode_hash: compileArtifact.bytecode_hash,
  verification_hash: compileArtifact.verification_hash,
  safety: result.verification?.safety || null,
  verified: result.verification?.verified || false,
  instructions: result.instructions,
  size: result.size,
  outputs: [
    "program-v1/abi.json",
    "program-v1/lowered.oasm",
    "program-v1/formal_verification.json",
    "program-v1/formal_certificate.json",
    "build/program-v1/compile.json"
  ]
}));
