#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runtimeVitalsManifest, stableJson } from "../lib/vitals-manifest.js";

const root = resolve(new URL("../..", import.meta.url).pathname);
const manifestPath = join(root, "app", "vitals.manifest.json");
const deployPath = join(root, "build", "deploy_program.json");
const compilePath = join(root, "build", "program", "compile.json");

async function readJsonOrNull(path: string): Promise<Record<string, any> | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
  } catch {
    return null;
  }
}

const [manifest, deploy, compile] = await Promise.all([
  readFile(manifestPath, "utf8").then((text) => JSON.parse(text)),
  readJsonOrNull(deployPath),
  readFile(compilePath, "utf8").then((text) => JSON.parse(text))
]);

const deployMatchesCompile =
  deploy?.source_hash === compile.source_hash &&
  deploy?.bytecode_hash === compile.bytecode_hash &&
  deploy?.verification_hash === compile.verification_hash;
const circleProgramMode = process.env.VITALS_STATE_TARGET_MODE === "circle_program";
const envProgramAddress = circleProgramMode ? undefined : process.env.VITALS_STATE_PROGRAM_ADDRESS;
if (envProgramAddress && envProgramAddress !== "pending" && (!deployMatchesCompile || envProgramAddress !== deploy?.program_address)) {
  throw new Error("VITALS_STATE_PROGRAM_ADDRESS does not match the current deploy artifact; refusing to stamp unchecked authority into the app manifest");
}
const programAddress = circleProgramMode ? "pending" : (deployMatchesCompile ? deploy?.program_address : null) || "pending";

if (programAddress === "pending" && process.env.VITALS_REQUIRE_DEPLOYED_PROGRAM === "1") {
  throw new Error("program address missing or stale; deploy the Vitals State Program first or set VITALS_STATE_PROGRAM_ADDRESS");
}

const nextManifest: Record<string, any> = {
  ...runtimeVitalsManifest(manifest),
  state_program_address: programAddress,
  state_program_source_hash: compile.source_hash,
  state_program_bytecode_hash: compile.bytecode_hash,
  state_program_verification_hash: compile.verification_hash,
  state_program_verification_safety: compile.verification?.safety || "unknown"
};

await writeFile(manifestPath, stableJson(nextManifest));
console.log(stableJson({
  manifest: "app/vitals.manifest.json",
  site_circle_id: nextManifest.site_circle_id,
  state_program_address: nextManifest.state_program_address,
  state_program_source_hash: nextManifest.state_program_source_hash,
  state_program_bytecode_hash: nextManifest.state_program_bytecode_hash,
  state_program_verification_hash: nextManifest.state_program_verification_hash
}));
