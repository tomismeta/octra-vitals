#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertAmlCompileApproved,
  readApprovedAmlRelease,
  validateAmlCompile,
  type AmlCompileResult
} from "../lib/aml-artifacts.js";
import { isExplicitDevelopmentRpcUrl } from "../lib/octra-rpc.js";

const root = resolve(new URL("../..", import.meta.url).pathname);
const artifactDir = process.env.VITALS_PROGRAMMED_CIRCLE_ARTIFACT_DIR || "program-fact-ledger";
if (!/^[A-Za-z0-9._/-]+$/.test(artifactDir) || artifactDir.startsWith("/") || artifactDir.split("/").includes("..")) {
  throw new Error("VITALS_PROGRAMMED_CIRCLE_ARTIFACT_DIR must stay within the release");
}
const artifactRoot = join(root, artifactDir);
const sourcePath = resolve(root, process.env.VITALS_PROGRAMMED_CIRCLE_SOURCE || join(artifactDir, "main.aml"));
const compilePath = resolve(root, process.env.VITALS_PROGRAMMED_CIRCLE_COMPILE_ARTIFACT || join("build", artifactDir, "compile.json"));
const approvedPath = join(root, artifactDir, "approved-release.json");
const buildRoot = join(root, "build");
if (sourcePath !== artifactRoot && !sourcePath.startsWith(`${artifactRoot}/`)) {
  throw new Error("promoted AML source must stay within its artifact directory");
}
if (compilePath !== buildRoot && !compilePath.startsWith(`${buildRoot}/`)) {
  throw new Error("promoted AML compile artifact must stay under build/");
}

const source = await readFile(sourcePath, "utf8");
const raw = JSON.parse(await readFile(compilePath, "utf8")) as AmlCompileResult & {
  schema?: string;
  compiler_version?: string;
  compiler_rpc_urls?: unknown;
  compiler_rpc_agreement?: unknown;
};
if (raw.schema !== "octra-vitals-fact-ledger-program-compile-v2") {
  throw new Error("promoted AML compile artifact must use the v2 quorum schema");
}
const urls = Array.isArray(raw.compiler_rpc_urls)
  ? raw.compiler_rpc_urls.filter((value): value is string => typeof value === "string" && value.length > 0)
  : [];
const deploymentEnvironment = String(process.env.DEPLOY_ENVIRONMENT || process.env.VITALS_DEPLOY_ENVIRONMENT || "mainnet").toLowerCase();
const developmentPromotion = deploymentEnvironment !== "mainnet" && urls.length > 0 && urls.every(isExplicitDevelopmentRpcUrl);
const defaultMinimum = developmentPromotion ? 1 : 2;
const singleCompilerMainnetAck = "I ACCEPT SINGLE AML COMPILER RPC FOR MAINNET";
const singleCompilerMainnetAccepted =
  deploymentEnvironment === "mainnet" &&
  urls.length === 1 &&
  process.env.VITALS_SINGLE_COMPILER_RPC_MAINNET_ACK === singleCompilerMainnetAck;
const minimum = Number(process.env.VITALS_MIN_COMPILER_RPC_URLS || defaultMinimum);
if (!Number.isSafeInteger(minimum) || (!singleCompilerMainnetAccepted && minimum < defaultMinimum)) {
  throw new Error(`promoted AML artifacts require at least ${defaultMinimum} compiler RPC${defaultMinimum === 1 ? "" : "s"}`);
}
const effectiveMinimum = singleCompilerMainnetAccepted ? 1 : minimum;
if (raw.compiler_rpc_agreement !== true || new Set(urls).size < effectiveMinimum) {
  throw new Error(`promoted AML compile artifact does not prove ${effectiveMinimum}-provider compiler agreement`);
}
const compile: AmlCompileResult = { ...raw };
if (!compile.version && raw.compiler_version) compile.version = raw.compiler_version;
const validated = validateAmlCompile(source, compile);
assertAmlCompileApproved(validated, await readApprovedAmlRelease(approvedPath));

console.log(JSON.stringify({
  schema: "octra-vitals-promoted-aml-compile-verification-v1",
  ok: true,
  compile_path: compilePath.replace(`${root}/`, ""),
  source_hash: validated.source_hash,
  bytecode_hash: validated.bytecode_hash,
  verification_hash: validated.verification_hash,
  state_layout_hash: validated.state_layout_hash,
  compiler_rpc_urls: urls,
  compiler_rpc_agreement: true,
  single_compiler_mainnet_acknowledged: singleCompilerMainnetAccepted
}, null, 2));
