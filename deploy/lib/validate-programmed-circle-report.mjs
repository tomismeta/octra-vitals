#!/usr/bin/env node
import fs from "node:fs";

const [reportPath, outputPath, expectedOwnerUidText] = process.argv.slice(2);
if (!reportPath || !outputPath) {
  throw new Error("usage: validate-programmed-circle-report.mjs REPORT OUTPUT_ENV");
}

const reportFd = fs.openSync(reportPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
let reportText;
try {
  const info = fs.fstatSync(reportFd);
  if (!info.isFile()) throw new Error("deployment report must be a regular non-symlink file");
  if (info.size > 1024 * 1024) throw new Error("deployment report exceeds the 1 MiB limit");
  if ((info.mode & 0o022) !== 0) throw new Error("deployment report must not be group/world writable");
  if (expectedOwnerUidText !== undefined) {
    const expectedOwnerUid = Number(expectedOwnerUidText);
    if (!Number.isSafeInteger(expectedOwnerUid) || expectedOwnerUid < 0) throw new Error("expected report owner uid is invalid");
    if (info.uid !== 0 && info.uid !== expectedOwnerUid) throw new Error("deployment report is not owned by root or the cold-owner account");
  }
  reportText = fs.readFileSync(reportFd, "utf8");
} finally {
  fs.closeSync(reportFd);
}
const report = JSON.parse(reportText);

function assertNoControls(value, path = "report") {
  if (typeof value === "string" && /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${path} contains control characters`);
  if (Array.isArray(value)) value.forEach((item, index) => assertNoControls(item, `${path}[${index}]`));
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) assertNoControls(item, `${path}.${key}`);
  }
}

function requiredString(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

assertNoControls(report);
if (report.schema !== "octra-vitals-programmed-circle-deploy-v0") throw new Error("unsupported deployment report schema");
if (report.status !== "initialized" || report.deploy_enabled !== true) throw new Error("deployment report is not a completed deployment");
if (report.program_kind !== "fact-ledger") throw new Error("deployment report is not a fact-ledger deployment");
const address = /^oct[1-9A-HJ-NP-Za-km-z]{44}$/;
const hash = /^sha256:[0-9a-f]{64}$/;
const circleId = requiredString(report.circle_id, "circle_id", address);
const deployer = requiredString(report.deployer_address, "deployer_address", address);
const operator = requiredString(report.operator_address, "operator_address", address);
const env = report.env_next;
if (!env || typeof env !== "object") throw new Error("env_next is missing");
const caller = requiredString(env.VITALS_CIRCLE_VIEW_CALLER_ADDRESS || deployer, "Circle view caller", address);
if (caller !== deployer) throw new Error("Circle view caller must match deployment owner");
const artifactDir = requiredString(env.VITALS_PROGRAMMED_CIRCLE_ARTIFACT_DIR || report.artifact_dir, "artifact_dir", /^[A-Za-z0-9._/-]{1,120}$/);
if (artifactDir.startsWith("/") || artifactDir.split("/").includes("..")) throw new Error("artifact_dir must stay within the release");
const recordVersion = requiredString(env.VITALS_RECORD_SNAPSHOT_VERSION, "record snapshot version", /^fact-v2$/);
const network = requiredString(env.VITALS_FACT_LEDGER_NETWORK_ID, "fact-ledger network", /^[a-z0-9._-]{1,32}$/i);
const sourceHash = requiredString(env.VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_SOURCE_HASH, "source hash", hash);
const bytecodeHash = requiredString(env.VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_BYTECODE_HASH, "bytecode hash", hash);
const verificationHash = requiredString(env.VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_VERIFICATION_HASH, "verification hash", hash);
const cutoverAck = requiredString(env.VITALS_FACT_LEDGER_CUTOVER_ACK, "fact-ledger cutover acknowledgement", /^[A-Za-z0-9:._-]{1,160}$/);
if (cutoverAck !== `fact-v2:circle_program:${circleId}`) throw new Error("fact-ledger cutover acknowledgement does not match Circle");
if (report.views?.owner_matches !== true || report.views?.operator_matches !== true) {
  throw new Error("deployment report does not prove owner/operator readback");
}

const values = {
  REPORT_CIRCLE_ID: circleId,
  REPORT_CALLER: caller,
  REPORT_OPERATOR: operator,
  REPORT_PROGRAM_KIND: "fact-ledger",
  REPORT_ARTIFACT_DIR: artifactDir,
  REPORT_RECORD_VERSION: recordVersion,
  REPORT_FACT_ACK: cutoverAck,
  REPORT_FACT_NETWORK: network,
  REPORT_FACT_SOURCE_HASH: sourceHash,
  REPORT_FACT_BYTECODE_HASH: bytecodeHash,
  REPORT_FACT_VERIFICATION_HASH: verificationHash
};
const outputFd = fs.openSync(
  outputPath,
  fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
  0o600
);
try {
  const info = fs.fstatSync(outputFd);
  if (!info.isFile() || info.nlink !== 1) throw new Error("validated env output must be a single-link regular file");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error("validated env output must be owned by the validator account");
  }
  fs.fchmodSync(outputFd, 0o600);
  fs.writeFileSync(outputFd, `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`, "utf8");
  fs.fsyncSync(outputFd);
} finally {
  fs.closeSync(outputFd);
}
