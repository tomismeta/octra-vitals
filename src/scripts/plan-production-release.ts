#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stableJson } from "../lib/vitals-manifest.js";

type JsonRecord = Record<string, any>;

interface ReleaseAsset {
  path: string;
  sha256: string;
}

interface ReleaseManifest {
  release_git_commit: string;
  release_git_dirty: boolean;
  site_circle_id: string;
  state_target_mode: string;
  programmed_circle_id?: string | null;
  state_program_address?: string | null;
  assets: ReleaseAsset[];
}

interface AuditManifest {
  files?: Array<{
    path: string;
    sha256: string;
  }>;
}

const root = resolve(new URL("../..", import.meta.url).pathname);

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

function stripSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function gitText(args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

async function fetchJson(gatewayUrl: string, path: string): Promise<{ status: number; body: JsonRecord | null; error: string | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.DEPLOY_RELEASE_PLAN_TIMEOUT_MS || 20_000));
  try {
    const response = await fetch(`${gatewayUrl}${path}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
    const text = await response.text();
    let body: JsonRecord | null = null;
    try {
      body = text ? JSON.parse(text) as JsonRecord : null;
    } catch {
      body = null;
    }
    return {
      status: response.status,
      body,
      error: response.ok ? null : `${path} returned ${response.status}: ${text.slice(0, 200)}`
    };
  } catch (error) {
    return {
      status: 0,
      body: null,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function assetMap(assets: ReleaseAsset[]): Map<string, string> {
  return new Map(assets.map((asset) => [asset.path, asset.sha256]));
}

function siteExpectedAssetMap(site: JsonRecord | null): Map<string, string> {
  const assets = site?.site_integrity?.assets;
  if (!Array.isArray(assets)) return new Map();
  const pairs: Array<[string, string]> = [];
  for (const asset of assets) {
    if (typeof asset?.path === "string" && typeof asset?.expected_sha256 === "string") {
      pairs.push([asset.path, asset.expected_sha256]);
    }
  }
  return new Map(pairs);
}

function changedAssets(candidate: Map<string, string>, live: Map<string, string>) {
  const paths = Array.from(new Set([...candidate.keys(), ...live.keys()])).sort();
  return paths
    .map((path) => ({
      path,
      live_sha256: live.get(path) || null,
      candidate_sha256: candidate.get(path) || null,
      changed: live.get(path) !== candidate.get(path)
    }))
    .filter((item) => item.changed);
}

function auditFileMap(audit: AuditManifest | null): Map<string, string> {
  const files = Array.isArray(audit?.files) ? audit.files : [];
  const pairs: Array<[string, string]> = [];
  for (const file of files) {
    if (typeof file.path === "string" && typeof file.sha256 === "string") {
      pairs.push([file.path, file.sha256]);
    }
  }
  return new Map(pairs);
}

function changedAuditFiles(candidate: AuditManifest | null, live: AuditManifest | null) {
  const candidateFiles = auditFileMap(candidate);
  const liveFiles = auditFileMap(live);
  const paths = Array.from(new Set([...candidateFiles.keys(), ...liveFiles.keys()])).sort();
  return paths
    .map((path) => ({
      path,
      live_sha256: liveFiles.get(path) || null,
      candidate_sha256: candidateFiles.get(path) || null,
      changed: liveFiles.get(path) !== candidateFiles.get(path)
    }))
    .filter((item) => item.changed);
}

function touchesProducerRuntime(path: string): boolean {
  return [
    "src/scripts/run-snapshot-update.ts",
    "src/scripts/build-snapshot.ts",
    "src/scripts/build-record-snapshot-call.ts",
    "src/scripts/submit-snapshot.ts",
    "src/lib/snapshot.ts",
    "src/lib/summary-window.ts",
    "src/lib/octra-rpc.ts",
    "src/lib/program-state.ts",
    "src/lib/circle-program.ts",
    "src/lib/canonical-json.ts",
    "src/lib/units.ts",
    "src/lib/types.ts"
  ].includes(path);
}

function touchesProgram(path: string): boolean {
  return path.startsWith("program-circle/") ||
    path.startsWith("program/") ||
    path.startsWith("program-v1/") ||
    path.startsWith("program-fact-ledger/") ||
    path.startsWith("program-fact-ledger-probe/");
}

const gatewayUrl = stripSlash(argValue("--gateway-url") || process.env.DEPLOY_GATEWAY_URL || process.env.VITALS_GATEWAY_ORIGIN || "https://octra.live");
const releasePath = resolve(root, argValue("--release") || process.env.DEPLOY_CANDIDATE_RELEASE || "build/mainnet-candidate-site-circle-release.json");
const auditPath = resolve(root, argValue("--audit") || process.env.DEPLOY_CANDIDATE_AUDIT || "app/producer.audit.json");
const outPath = resolve(root, argValue("--out") || process.env.DEPLOY_RELEASE_PLAN_OUT || "build/mainnet-release-plan.json");

const candidateRelease = JSON.parse(await readFile(releasePath, "utf8")) as ReleaseManifest;
const candidateAudit = JSON.parse(await readFile(auditPath, "utf8")) as AuditManifest;

const [versionRead, siteRead, readinessRead, latestRead, historyRead, liveAuditRead] = await Promise.all([
  fetchJson(gatewayUrl, "/api/version"),
  fetchJson(gatewayUrl, "/api/site-integrity"),
  fetchJson(gatewayUrl, "/api/native-readiness"),
  fetchJson(gatewayUrl, "/api/latest"),
  fetchJson(gatewayUrl, "/api/history"),
  fetchJson(gatewayUrl, "/producer.audit.json")
]);

const version = versionRead.body || {};
const site = siteRead.body || {};
const readiness = readinessRead.body || {};
const latest = latestRead.body || {};
const history = historyRead.body || {};
const liveAudit = liveAuditRead.body as AuditManifest | null;
const liveAssetMap = siteExpectedAssetMap(site);
const candidateAssetMap = assetMap(candidateRelease.assets || []);
const assetDiffs = changedAssets(candidateAssetMap, liveAssetMap);
const auditDiffs = changedAuditFiles(candidateAudit, liveAudit);
const producerRuntimeDiffs = auditDiffs.filter((item) => touchesProducerRuntime(item.path));
const programDiffs = auditDiffs.filter((item) => touchesProgram(item.path));
const siteIntegrity = site.site_integrity || {};
const nativeReadiness = readiness.native_readiness || {};
const latestPayload = latest.envelope?.payload || latest.payload || latest;

const liveCommit = typeof version.release_git_commit === "string" ? version.release_git_commit : null;
const liveDirty = version.release_git_dirty === true;
const hostReleaseRequired = liveCommit !== candidateRelease.release_git_commit || liveDirty === true;
const circleAssetPublishRequired = assetDiffs.length > 0
  || siteIntegrity.verification_status !== "verified"
  || siteIntegrity.local_assets_match !== true
  || siteIntegrity.circle_assets_match !== true;
const submitSnapshotRecommended = producerRuntimeDiffs.length > 0;
const runtimeTargetMismatch = version.state_target_mode !== candidateRelease.state_target_mode
  || version.site_circle_id !== candidateRelease.site_circle_id
  || (candidateRelease.state_target_mode === "circle_program" && version.programmed_circle_id !== candidateRelease.programmed_circle_id)
  || (candidateRelease.state_target_mode !== "circle_program" && version.state_program_address !== candidateRelease.state_program_address);
const programUpdateDetected = programDiffs.length > 0;

const blockers: string[] = [];
if (candidateRelease.release_git_dirty) blockers.push("candidate release is dirty");
if (!versionRead.body) blockers.push(`/api/version unavailable: ${versionRead.error || "unknown"}`);
if (!siteRead.body) blockers.push(`/api/site-integrity unavailable: ${siteRead.error || "unknown"}`);
if (runtimeTargetMismatch) blockers.push("candidate release target does not match live runtime target");
if (programUpdateDetected) blockers.push("program or programmed-Circle source changed; use a programmed-Circle deploy/update path, not a patch release");

const recommendedActions: string[] = [];
if (blockers.length === 0) {
  if (hostReleaseRequired || circleAssetPublishRequired || submitSnapshotRecommended) {
    recommendedActions.push("pause_updater_timer");
    if (hostReleaseRequired) recommendedActions.push("push_release");
    if (circleAssetPublishRequired) recommendedActions.push("publish_assets");
    if (hostReleaseRequired && !circleAssetPublishRequired) recommendedActions.push("restart_gateway");
    if (submitSnapshotRecommended) recommendedActions.push("submit_snapshot");
    recommendedActions.push("verify_runtime");
    recommendedActions.push("resume_updater_timer");
  } else {
    recommendedActions.push("none");
  }
}

const plan = {
  schema: "octra-vitals-production-release-plan-v0",
  generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  gateway_url: gatewayUrl,
  local_git_commit: gitText(["rev-parse", "HEAD"]),
  local_git_dirty: (gitText(["status", "--porcelain"]) || "").length > 0,
  status: blockers.length ? "blocked" : "planned",
  blockers,
  candidate: {
    release_git_commit: candidateRelease.release_git_commit,
    release_git_dirty: candidateRelease.release_git_dirty,
    site_circle_id: candidateRelease.site_circle_id,
    state_target_mode: candidateRelease.state_target_mode,
    programmed_circle_id: candidateRelease.programmed_circle_id || null,
    state_program_address: candidateRelease.state_program_address || null,
    assets: candidateRelease.assets?.length || 0
  },
  live: {
    version_status: versionRead.status,
    release_git_commit: liveCommit,
    release_git_dirty: version.release_git_dirty ?? null,
    site_circle_id: version.site_circle_id || null,
    state_target_mode: version.state_target_mode || null,
    programmed_circle_id: version.programmed_circle_id || null,
    state_program_address: version.state_program_address || null,
    latest_status_code: latestRead.status,
    latest_status: latest.status || null,
    latest_source: latest.source || null,
    latest_fresh: latest.fresh ?? null,
    latest_canonical_state_read: latest.authority?.canonical_state_read ?? null,
    latest_snapshot_id: latest.envelope?.snapshot_id || latest.snapshot_id || null,
    latest_health_status: latestPayload.health?.conservation?.status || null,
    site_integrity_status: siteIntegrity.verification_status || null,
    site_local_assets_match: siteIntegrity.local_assets_match ?? null,
    site_circle_assets_match: siteIntegrity.circle_assets_match ?? null,
    native_readiness_status: nativeReadiness.status || readiness.status || null,
    history_status_code: historyRead.status,
    history_rows: history.row_count || history.snapshots?.length || null,
    history_canonical_state_read: history.authority?.canonical_state_read ?? null
  },
  decision: {
    host_release_required: hostReleaseRequired,
    circle_asset_publish_required: circleAssetPublishRequired,
    submit_snapshot_recommended: submitSnapshotRecommended,
    runtime_target_mismatch: runtimeTargetMismatch,
    program_update_detected: programUpdateDetected,
    recommended_actions: recommendedActions
  },
  diffs: {
    assets: assetDiffs,
    audit_files: auditDiffs,
    producer_runtime_files: producerRuntimeDiffs,
    program_files: programDiffs
  }
};

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, stableJson(plan));
console.log(stableJson(plan));
