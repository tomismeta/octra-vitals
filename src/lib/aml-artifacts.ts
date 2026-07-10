import { readFile } from "node:fs/promises";
import { sha256Hex } from "./canonical-json.js";

export interface AmlCompileResult {
  bytecode?: string;
  bytecode_b64?: string;
  size?: number;
  instructions?: number;
  version?: string;
  abi?: unknown;
  disasm?: string;
  verification?: any;
  certificate?: {
    source_hash?: string;
    bytecode_hash?: string;
    verification_hash?: string;
    compiler?: string;
    compiler_version?: string;
    [key: string]: unknown;
  };
}

export interface ApprovedAmlRelease {
  schema: "octra-vitals-approved-aml-release-v1";
  source_hash: string;
  bytecode_hash: string;
  verification_hash: string;
  abi_hash: string;
  disasm_hash: string;
  state_layout_hash: string;
  compiler: string | null;
  compiler_version: string | null;
}

export interface ValidatedAmlCompile {
  result: AmlCompileResult;
  code_b64: string;
  source_hash: string;
  bytecode_hash: string;
  verification_hash: string;
  abi_hash: string;
  disasm_hash: string;
  state_layout_hash: string;
}

export function normalizeSha256(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const normalized = value.replace(/^sha256:/, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(normalized) ? `sha256:${normalized}` : null;
}

export function hashJsonCompact(value: unknown): string {
  return `sha256:${sha256Hex(JSON.stringify(value))}`;
}

export function amlBytecodeHash(codeB64: string): string {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(codeB64) || codeB64.length % 4 !== 0) {
    throw new Error("AML bytecode is not canonical base64");
  }
  const decoded = Buffer.from(codeB64, "base64");
  if (!decoded.length || decoded.toString("base64") !== codeB64) {
    throw new Error("AML bytecode base64 is empty or non-canonical");
  }
  return `sha256:${sha256Hex(decoded)}`;
}

export function amlStateLayoutHash(source: string): string {
  const match = /\n\s*state\s*\{([\s\S]*?)\n\s*\}/.exec(source);
  const normalized = match
    ? `${String(match[1]).split("\n").map((line) => line.trim()).filter(Boolean).join("\n")}\n`
    : "stateless\n";
  return `sha256:${sha256Hex(normalized)}`;
}

export function validateAmlCompile(source: string, result: AmlCompileResult): ValidatedAmlCompile {
  const verification = result.verification;
  if (
    verification?.verified !== true ||
    verification?.safety !== "safe" ||
    verification?.errors !== 0 ||
    verification?.warnings !== 0
  ) {
    throw new Error(`AML formal verification failed: ${JSON.stringify({
      verified: verification?.verified ?? false,
      safety: verification?.safety ?? null,
      errors: verification?.errors ?? null,
      warnings: verification?.warnings ?? null
    })}`);
  }
  const codeB64 = result.bytecode || result.bytecode_b64;
  if (!codeB64) throw new Error("AML compiler did not return bytecode");
  const sourceHash = `sha256:${sha256Hex(source)}`;
  const bytecodeHash = amlBytecodeHash(codeB64);
  const verificationHash = hashJsonCompact(verification);
  const certificateSourceHash = normalizeSha256(result.certificate?.source_hash);
  const certificateBytecodeHash = normalizeSha256(result.certificate?.bytecode_hash);
  const certificateVerificationHash = normalizeSha256(result.certificate?.verification_hash);
  const failures = [
    certificateSourceHash !== sourceHash ? "certificate_source_hash" : null,
    certificateBytecodeHash !== bytecodeHash ? "certificate_bytecode_hash" : null,
    certificateVerificationHash !== verificationHash ? "certificate_verification_hash" : null
  ].filter(Boolean);
  if (failures.length) throw new Error(`AML compiler certificate mismatch: ${failures.join(", ")}`);
  return {
    result,
    code_b64: codeB64,
    source_hash: sourceHash,
    bytecode_hash: bytecodeHash,
    verification_hash: verificationHash,
    abi_hash: hashJsonCompact(typeof result.abi === "string" ? JSON.parse(result.abi) : result.abi),
    disasm_hash: `sha256:${sha256Hex(`${String(result.disasm || "").trim()}\n`)}`,
    state_layout_hash: amlStateLayoutHash(source)
  };
}

export function assertAmlCompilerAgreement(primary: ValidatedAmlCompile, candidate: ValidatedAmlCompile, url: string): void {
  const fields: Array<keyof Pick<ValidatedAmlCompile, "source_hash" | "bytecode_hash" | "verification_hash" | "abi_hash" | "disasm_hash" | "state_layout_hash">> = [
    "source_hash",
    "bytecode_hash",
    "verification_hash",
    "abi_hash",
    "disasm_hash",
    "state_layout_hash"
  ];
  for (const field of fields) {
    if (candidate[field] !== primary[field]) throw new Error(`AML compiler disagreement from ${url}: ${field}`);
  }
  if (String(candidate.result.version || "") !== String(primary.result.version || "")) {
    throw new Error(`AML compiler disagreement from ${url}: version`);
  }
  for (const field of ["compiler", "compiler_version"] as const) {
    if (String(candidate.result.certificate?.[field] || "") !== String(primary.result.certificate?.[field] || "")) {
      throw new Error(`AML compiler disagreement from ${url}: certificate.${field}`);
    }
  }
}

export function approvedAmlRelease(value: ValidatedAmlCompile): ApprovedAmlRelease {
  return {
    schema: "octra-vitals-approved-aml-release-v1",
    source_hash: value.source_hash,
    bytecode_hash: value.bytecode_hash,
    verification_hash: value.verification_hash,
    abi_hash: value.abi_hash,
    disasm_hash: value.disasm_hash,
    state_layout_hash: value.state_layout_hash,
    compiler: value.result.certificate?.compiler ? String(value.result.certificate.compiler) : null,
    compiler_version: value.result.certificate?.compiler_version
      ? String(value.result.certificate.compiler_version)
      : value.result.version ? String(value.result.version) : null
  };
}

export function assertAmlCompileApproved(value: ValidatedAmlCompile, approved: ApprovedAmlRelease): void {
  if (approved.schema !== "octra-vitals-approved-aml-release-v1") throw new Error("unsupported approved AML release schema");
  const actual = approvedAmlRelease(value);
  const failures = [
    actual.source_hash !== normalizeSha256(approved.source_hash) ? "source_hash" : null,
    actual.bytecode_hash !== normalizeSha256(approved.bytecode_hash) ? "bytecode_hash" : null,
    actual.verification_hash !== normalizeSha256(approved.verification_hash) ? "verification_hash" : null,
    actual.abi_hash !== normalizeSha256(approved.abi_hash) ? "abi_hash" : null,
    actual.disasm_hash !== normalizeSha256(approved.disasm_hash) ? "disasm_hash" : null,
    actual.state_layout_hash !== normalizeSha256(approved.state_layout_hash) ? "state_layout_hash" : null,
    approved.compiler && actual.compiler !== approved.compiler ? "compiler" : null,
    approved.compiler_version && actual.compiler_version !== approved.compiler_version ? "compiler_version" : null
  ].filter(Boolean);
  if (failures.length) throw new Error(`AML compile is not the approved release: ${failures.join(", ")}`);
}

export function assertPreviousCompileApproved(result: AmlCompileResult & Record<string, unknown>, approved: ApprovedAmlRelease): void {
  const codeB64 = result.bytecode || result.bytecode_b64;
  if (!codeB64) throw new Error("previous AML compile artifact has no bytecode");
  const verification = result.verification;
  const abi = typeof result.abi === "string" ? JSON.parse(result.abi) : result.abi;
  const sourceHash = normalizeSha256(result.source_hash) || normalizeSha256(result.certificate?.source_hash);
  const failures = [
    sourceHash !== normalizeSha256(approved.source_hash) ? "source_hash" : null,
    amlBytecodeHash(codeB64) !== normalizeSha256(approved.bytecode_hash) ? "bytecode_hash" : null,
    hashJsonCompact(verification) !== normalizeSha256(approved.verification_hash) ? "verification_hash" : null,
    hashJsonCompact(abi) !== normalizeSha256(approved.abi_hash) ? "abi_hash" : null,
    `sha256:${sha256Hex(`${String(result.disasm || "").trim()}\n`)}` !== normalizeSha256(approved.disasm_hash) ? "disasm_hash" : null,
    normalizeSha256(result.certificate?.source_hash) !== normalizeSha256(approved.source_hash) ? "certificate_source_hash" : null,
    normalizeSha256(result.certificate?.bytecode_hash) !== normalizeSha256(approved.bytecode_hash) ? "certificate_bytecode_hash" : null,
    normalizeSha256(result.certificate?.verification_hash) !== normalizeSha256(approved.verification_hash) ? "certificate_verification_hash" : null,
    approved.compiler && String(result.certificate?.compiler || "") !== approved.compiler ? "compiler" : null,
    approved.compiler_version && String(result.certificate?.compiler_version || result.version || "") !== approved.compiler_version ? "compiler_version" : null
  ].filter(Boolean);
  if (failures.length) throw new Error(`previous AML compile is not the approved live release: ${failures.join(", ")}`);
}

export function assertAmlAbiBackwardCompatible(previous: any, candidate: any): void {
  const previousFunctions = Array.isArray(previous?.functions) ? previous.functions : [];
  const candidateFunctions = namedAbiEntries(candidate?.functions, "function");
  for (const previousFunction of previousFunctions) {
    const name = String(previousFunction?.name || "");
    const next = candidateFunctions.get(name);
    if (!name || !next) throw new Error(`AML ABI removed function ${name || "<unnamed>"}`);
    for (const field of ["inputs", "output", "view", "payable"] as const) {
      if (JSON.stringify(next[field]) !== JSON.stringify(previousFunction[field])) {
        throw new Error(`AML ABI changed ${name}.${field}`);
      }
    }
  }
  const candidateEvents = namedAbiEntries(candidate?.events, "event");
  for (const previousEvent of Array.isArray(previous?.events) ? previous.events : []) {
    const name = String(previousEvent?.name || "");
    const next = candidateEvents.get(name);
    if (!name || !next) throw new Error(`AML ABI removed event ${name || "<unnamed>"}`);
    if (JSON.stringify(next.fields) !== JSON.stringify(previousEvent.fields)) {
      throw new Error(`AML ABI changed ${name}.fields`);
    }
  }
}

function namedAbiEntries(value: unknown, label: string): Map<string, any> {
  const result = new Map<string, any>();
  for (const entry of Array.isArray(value) ? value : []) {
    const name = String(entry?.name || "");
    if (!name) throw new Error(`AML ABI has unnamed ${label}`);
    if (result.has(name)) throw new Error(`AML ABI has duplicate ${label} ${name}`);
    result.set(name, entry);
  }
  return result;
}

export async function readApprovedAmlRelease(path: string): Promise<ApprovedAmlRelease> {
  return JSON.parse(await readFile(path, "utf8")) as ApprovedAmlRelease;
}
