#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sha256Hex } from "../lib/canonical-json.js";

type JsonRecord = Record<string, unknown>;

const root = resolve(new URL("../..", import.meta.url).pathname);
const programDir = join(root, "program-circle");
const compilePath = join(root, "build", "program-circle", "compile.json");

const requiredFunctions = [
  "manifest",
  "is_initialized",
  "get_owner",
  "get_operator",
  "is_paused",
  "get_successor_program",
  "is_successor_set",
  "get_snapshot_count",
  "get_latest_snapshot_index",
  "get_latest_snapshot_id",
  "get_latest_observed_at",
  "get_latest_epoch",
  "get_latest_payload_hash",
  "get_latest_evidence_manifest_hash",
  "get_latest_source_refs_hash",
  "get_latest_summary_hash",
  "get_latest_snapshot",
  "get_latest_evidence_manifest",
  "get_latest_source_refs",
  "get_latest_summary",
  "get_latest_submitter",
  "get_recent_summary_window",
  "get_recent_summary_window_hash",
  "get_recent_summary_window_first_index",
  "get_recent_summary_window_row_count",
  "get_summary_row_len",
  "get_summary_window_rows",
  "get_latest_bundle",
  "initialize_v0",
  "set_operator",
  "set_paused",
  "set_successor_program",
  "record_snapshot_v0"
];

const forbiddenFunctions = [
  "get_snapshot",
  "get_snapshot_evidence_manifest",
  "get_snapshot_source_refs",
  "get_snapshot_source_refs_hash",
  "get_snapshot_submitter",
  "get_snapshot_meta",
  "get_record",
  "get_record_value",
  "put_record",
  "put_record_value",
  "stage_snapshot",
  "stage_epoch",
  "stage_hash",
  "record_snapshot",
  "record_snapshot_compact"
];

const forbiddenSourceSnippets = [
  "snapshot_payloads",
  "snapshot_evidence_manifests",
  "snapshot_source_refs",
  "snapshot_exists",
  "snapshot_meta",
  "snapshot_submitters",
  "records:",
  "pending_snapshot_id",
  "pending_payload_hash",
  "put_record",
  "stage_snapshot",
  "stage_epoch",
  "stage_hash",
  "record_snapshot_compact"
];

async function readJson(path: string): Promise<JsonRecord> {
  return JSON.parse(await readFile(path, "utf8")) as JsonRecord;
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function stringField(object: JsonRecord, key: string): string | null {
  const value = object[key];
  return typeof value === "string" ? value : null;
}

function numberField(object: JsonRecord, key: string): number | null {
  const value = object[key];
  return typeof value === "number" ? value : null;
}

function prefixedHash(value: string | null): string | null {
  if (!value) return null;
  return value.startsWith("sha256:") ? value : `sha256:${value}`;
}

function compactJsonHash(value: unknown): string {
  return `sha256:${sha256Hex(JSON.stringify(value))}`;
}

function bytecodeHash(bytecodeBase64: string): string {
  return `sha256:${sha256Hex(Buffer.from(bytecodeBase64, "base64"))}`;
}

const failures: string[] = [];
const expect = (condition: boolean, message: string): void => {
  if (!condition) failures.push(message);
};

const [source, compileArtifact, abiArtifact, verificationArtifact, certificateArtifact, loweredOasm] = await Promise.all([
  readFile(join(programDir, "main.aml"), "utf8"),
  readJson(compilePath),
  readJson(join(programDir, "abi.json")),
  readJson(join(programDir, "formal_verification.json")),
  readJson(join(programDir, "formal_certificate.json")),
  readFile(join(programDir, "lowered.oasm"), "utf8")
]);

const sourceHash = `sha256:${sha256Hex(source)}`;
const bytecode = stringField(compileArtifact, "bytecode");
const compiledBytecodeHash = bytecode ? bytecodeHash(bytecode) : null;
const verificationHash = compactJsonHash(verificationArtifact);
const compileAbiHash = compactJsonHash(compileArtifact.abi);
const pinnedAbiHash = compactJsonHash(abiArtifact);
const compileVerificationHash = compactJsonHash(compileArtifact.verification);
const compileDisasm = stringField(compileArtifact, "disasm") || "";

expect(stringField(compileArtifact, "schema") === "octra-vitals-program-circle-compile-v0", "compile artifact schema changed");
expect(stringField(compileArtifact, "source_path") === "program-circle/main.aml", "compile artifact source_path must point at program-circle/main.aml");
expect(stringField(compileArtifact, "source_hash") === sourceHash, "compile source_hash does not match program-circle/main.aml");
expect(stringField(compileArtifact, "bytecode_hash") === compiledBytecodeHash, "compile bytecode_hash does not match bytecode bytes");
expect(stringField(compileArtifact, "verification_hash") === verificationHash, "compile verification_hash does not match formal_verification.json");
expect(compileVerificationHash === verificationHash, "fresh compile verification output differs from pinned formal_verification.json");
expect(compileAbiHash === pinnedAbiHash, "fresh compile ABI differs from pinned program-circle/abi.json");
expect(`${compileDisasm.trim()}\n` === `${loweredOasm.trim()}\n`, "fresh compile disassembly differs from pinned program-circle/lowered.oasm");
expect(prefixedHash(stringField(certificateArtifact, "source_hash")) === sourceHash, "certificate source_hash does not match program-circle/main.aml");
expect(prefixedHash(stringField(certificateArtifact, "bytecode_hash")) === compiledBytecodeHash, "certificate bytecode_hash does not match bytecode bytes");
expect(prefixedHash(stringField(certificateArtifact, "verification_hash")) === verificationHash, "certificate verification_hash does not match formal_verification.json");
expect(stringField(certificateArtifact, "compiler") === "octra_aml", "certificate compiler must be octra_aml");
expect(stringField(certificateArtifact, "compiler_version") === stringField(compileArtifact, "compiler_version"), "certificate compiler_version must match compile artifact");
expect(verificationArtifact.verified === true, "formal verification must be verified");
expect(stringField(verificationArtifact, "safety") === "safe", "formal verification safety must be safe");
expect(numberField(verificationArtifact, "errors") === 0, "formal verification must have zero errors");
expect(numberField(verificationArtifact, "warnings") === 0, "formal verification must have zero warnings");
expect(Array.isArray(verificationArtifact.trace) && verificationArtifact.trace.length > 0, "formal verification trace must be present");

if (Array.isArray(verificationArtifact.trace)) {
  for (const [index, entry] of verificationArtifact.trace.entries()) {
    const traceEntry = asRecord(entry, `formal verification trace entry ${index}`);
    expect(stringField(traceEntry, "status") === "pass", `formal verification trace entry ${index} must pass`);
  }
}

const abiFunctions = Array.isArray(abiArtifact.functions) ? abiArtifact.functions : [];
const abiFunctionNames = new Set(
  abiFunctions
    .map((entry) => asRecord(entry, "ABI function"))
    .map((entry) => stringField(entry, "name"))
    .filter((name): name is string => Boolean(name))
);

for (const functionName of requiredFunctions) expect(abiFunctionNames.has(functionName), `ABI missing ${functionName}`);
for (const functionName of forbiddenFunctions) expect(!abiFunctionNames.has(functionName), `ABI still exposes removed function ${functionName}`);
expect(abiFunctionNames.size === requiredFunctions.length, "ABI exposes unexpected public functions");

for (const snippet of forbiddenSourceSnippets) expect(!source.includes(snippet), `AML source still contains forbidden storage/path snippet ${snippet}`);
expect(source.includes("const SUMMARY_ROW_BYTES = 208"), "AML summary row byte cap drifted");
expect(source.includes("const SUMMARY_WINDOW_ROWS = 48"), "AML summary window row cap drifted");
expect(source.includes("const MAX_SUMMARY_WINDOW_BYTES = 9984"), "AML summary window byte cap drifted");
expect(source.includes("latest_payload: string"), "AML must keep latest payload body");
expect(source.includes("latest_evidence_manifest: string"), "AML must keep latest evidence manifest body");
expect(source.includes("latest_source_refs: string"), "AML must keep latest source refs body");
expect(!source.includes("map<"), "AML public v0 should not introduce maps");

expect(loweredOasm.trim().length > 0, "lowered.oasm must be non-empty");
expect((numberField(compileArtifact, "instructions") || 0) > 0, "compile instructions must be positive");
expect((numberField(compileArtifact, "size") || 0) > 0, "compile size must be positive");

const report = {
  ok: failures.length === 0,
  source_hash: sourceHash,
  bytecode_hash: compiledBytecodeHash,
  verification_hash: verificationHash,
  safety: stringField(verificationArtifact, "safety"),
  verified: verificationArtifact.verified === true,
  errors: numberField(verificationArtifact, "errors"),
  warnings: numberField(verificationArtifact, "warnings"),
  abi_functions: abiFunctionNames.size,
  trace_checks: Array.isArray(verificationArtifact.trace) ? verificationArtifact.trace.length : 0,
  failures
};

console.log(`${JSON.stringify(report, null, 2)}\n`);
if (failures.length > 0) process.exitCode = 1;
