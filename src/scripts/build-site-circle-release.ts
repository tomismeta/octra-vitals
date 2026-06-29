#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { sha256Hex } from "../lib/canonical-json.js";
import { runtimeVitalsManifest, stableJson } from "../lib/vitals-manifest.js";

const root = resolve(new URL("../..", import.meta.url).pathname);
const appDir = join(root, "app");
const outPath = process.argv[2] || join(root, "build", "site-circle-release.json");

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8"
};

function octUri(path: string): string {
  return siteCircleId === "pending" ? "pending" : `oct://${siteCircleId}${path}`;
}

function gitText(args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

async function readJsonOrNull(path: string): Promise<Record<string, any> | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
  } catch {
    return null;
  }
}

const vitalsManifest = JSON.parse(await readFile(join(appDir, "vitals.manifest.json"), "utf8"));
const siteManifest = JSON.parse(await readFile(join(appDir, "manifest.json"), "utf8")) as {
  assets?: unknown[];
  entry?: string;
};
const manifestAssets = Array.isArray(siteManifest.assets)
  ? siteManifest.assets.filter((asset): asset is string => typeof asset === "string" && asset.startsWith("/"))
  : [];
const labAssets = ["/lab-history.html", "/lab-history.css", "/lab-history.js"];
const includeLabAssets = process.env.VITALS_LAB_HISTORY_ENABLED === "1" || process.env.VITALS_INCLUDE_LAB_HISTORY_ASSETS === "1";
const releaseAssets = includeLabAssets
  ? Array.from(new Set([...manifestAssets, ...labAssets]))
  : manifestAssets;
const assets: string[] = releaseAssets.length
  ? releaseAssets
  : [siteManifest.entry || "/index.html"];
const siteCircleId = process.env.VITALS_SITE_CIRCLE_ID || vitalsManifest.site_circle_id || "pending";
const programmedCircleId = process.env.VITALS_PROGRAMMED_CIRCLE_ID || vitalsManifest.programmed_circle_id || "pending";
const stateTargetMode = process.env.VITALS_STATE_TARGET_MODE === "circle_program" ? "circle_program" : "state_program";
const stateProgramAddress = stateTargetMode === "circle_program"
  ? null
  : process.env.VITALS_STATE_PROGRAM_ADDRESS || vitalsManifest.state_program_address || "pending";
const releaseGitCommit = process.env.VITALS_RELEASE_GIT_COMMIT || gitText(["rev-parse", "HEAD"]) || "unknown";
const releaseGitDirty = process.env.VITALS_RELEASE_GIT_DIRTY === "1"
  || (process.env.VITALS_RELEASE_GIT_DIRTY === undefined && (gitText(["status", "--porcelain"]) || "").length > 0);
const compileArtifact = await readJsonOrNull(join(root, "build", "program", "compile.json"));
const allowArtifactDrift = process.env.VITALS_ALLOW_MANIFEST_ARTIFACT_DRIFT === "1";
const expectedProgramHashes = {
  source: process.env.VITALS_STATE_PROGRAM_SOURCE_HASH || vitalsManifest.state_program_source_hash || compileArtifact?.source_hash || "pending",
  bytecode: process.env.VITALS_STATE_PROGRAM_BYTECODE_HASH || vitalsManifest.state_program_bytecode_hash || compileArtifact?.bytecode_hash || "pending",
  verification: process.env.VITALS_STATE_PROGRAM_VERIFICATION_HASH || vitalsManifest.state_program_verification_hash || compileArtifact?.verification_hash || "pending"
};
if (stateTargetMode === "state_program" && stateProgramAddress && stateProgramAddress !== "pending" && !allowArtifactDrift) {
  if (!compileArtifact) {
    throw new Error("build/program/compile.json is required when releasing against a standalone state program");
  }
  const mismatches = [
    expectedProgramHashes.source !== compileArtifact.source_hash ? "source" : null,
    expectedProgramHashes.bytecode !== compileArtifact.bytecode_hash ? "bytecode" : null,
    expectedProgramHashes.verification !== compileArtifact.verification_hash ? "verification" : null
  ].filter(Boolean);
  if (mismatches.length) {
    throw new Error(`vitals.manifest.json program hashes drift from build/program/compile.json: ${mismatches.join(", ")}`);
  }
}

const entries = await Promise.all(assets.map(async (assetPath) => {
  const filePath = join(appDir, assetPath.replace(/^\//, ""));
  const bytes = assetPath === "/vitals.manifest.json"
    ? Buffer.from(stableJson(runtimeVitalsManifest(vitalsManifest, { siteCircleId, programmedCircleId })))
    : await readFile(filePath);
  const fileInfo = await stat(filePath);
  return {
    path: assetPath,
    file: `app${assetPath}`,
    resource_key: `path|${assetPath}`,
    oct_uri: octUri(assetPath),
    content_type: contentTypes[extname(assetPath)] || "application/octet-stream",
    bytes: assetPath === "/vitals.manifest.json" ? bytes.length : fileInfo.size,
    sha256: `sha256:${sha256Hex(bytes)}`
  };
}));

const release = {
  schema: "octra-vitals-site-circle-release-v0",
  generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  app_name: "Octra Vitals",
  app_version: process.env.VITALS_APP_VERSION || "0.1.0",
  release_git_commit: releaseGitCommit,
  release_git_dirty: releaseGitDirty,
  circle_config: "circle.json",
  circle_manifest: "app/manifest.json",
  site_circle_id: siteCircleId,
  entry: "/index.html",
  entry_uri: octUri("/index.html"),
  state_target_mode: stateTargetMode,
  programmed_circle_id: programmedCircleId,
  state_program_address: stateProgramAddress,
  state_program_source_hash: expectedProgramHashes.source,
  state_program_bytecode_hash: expectedProgramHashes.bytecode,
  state_program_verification_hash: expectedProgramHashes.verification,
  authority: {
    canonical_app: "site-circle",
    canonical_state: stateTargetMode === "circle_program" ? "vitals-circle-program" : "vitals-state-program",
    gateway_role: "https-transport-adapter"
  },
  assets: entries
};

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, stableJson(release));
console.log(stableJson({
  out: outPath,
  schema: release.schema,
  site_circle_id: release.site_circle_id,
  entry_uri: release.entry_uri,
  state_target_mode: release.state_target_mode,
  programmed_circle_id: release.programmed_circle_id,
  state_program_address: release.state_program_address,
  release_git_commit: release.release_git_commit,
  release_git_dirty: release.release_git_dirty,
  assets: release.assets.length,
  asset_hashes: release.assets.map((asset) => ({ path: asset.path, sha256: asset.sha256 }))
}));
