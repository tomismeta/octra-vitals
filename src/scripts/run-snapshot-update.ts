#!/usr/bin/env node
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { buildLiveSnapshot, writeSnapshotArtifacts } from "../lib/snapshot.js";
import { buildRecordSnapshotCall, writeRecordSnapshotCall } from "./build-record-snapshot-call.js";
import { submitSnapshotCall, writeJsonAtomic, writeLatestReceipt, writeSubmitSnapshotReport } from "./submit-snapshot.js";

const root = resolve(new URL("../..", import.meta.url).pathname);

interface UpdateLock {
  path: string;
  token: string;
  assertOwned: () => Promise<void>;
  release: () => Promise<void>;
}

interface UpdateLockPayload {
  schema?: string;
  run_id?: string;
  pid?: number;
  started_at?: string;
  token?: string;
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function fileSafe(value: string): string {
  return value.replace(/[:.]/g, "").replace(/[^0-9A-Za-z_-]/g, "-");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectCli(metaUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(resolve(argvPath));
  } catch {
    return fileURLToPath(metaUrl) === resolve(argvPath);
  }
}

function ms(value: number): number {
  return Math.round(value);
}

function envInt(name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const configured = process.env[name];
  const value = configured !== undefined && configured !== "" ? Number(configured) : fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function confirmedAmlWrite(report: Record<string, any>): boolean {
  return report.submit_enabled === true &&
    report.status === "confirmed" &&
    typeof report.tx_hash === "string" &&
    report.tx_hash.length > 0 &&
    report.readback &&
    Number(report.readback.latest_snapshot_index || 0) === Number(report.snapshot_index || 0);
}

async function writePostAmlWriteTrigger(report: Record<string, any>, triggerPath: string | null): Promise<Record<string, unknown>> {
  if (!triggerPath) {
    return { enabled: false, reason: "trigger_path_not_configured" };
  }
  if (!confirmedAmlWrite(report)) {
    return { enabled: true, written: false, reason: "snapshot_write_not_confirmed" };
  }
  const path = resolve(triggerPath);
  const payload = {
    schema: "octra-vitals-post-aml-write-trigger-v0",
    generated_at: isoNow(),
    run_id: report.run_id,
    snapshot_id: report.snapshot_id,
    snapshot_index: report.snapshot_index,
    tx_hash: report.tx_hash,
    status: report.status,
    target_kind: report.target_kind || null,
    target_id: report.target_id || report.program_address || report.circle_id || null
  };
  try {
    await writeJsonAtomic(path, payload);
    return { enabled: true, written: true, path, snapshot_index: report.snapshot_index };
  } catch (error) {
    return { enabled: true, written: false, path, error: errorMessage(error) };
  }
}

interface RetentionResult {
  path: string;
  removed: string[];
  kept: number;
  max_count: number;
  max_age_ms: number;
  error?: string;
}

async function pruneDirectory(options: {
  path: string;
  kind: "directory" | "file";
  maxCount: number;
  maxAgeMs: number;
  preserve?: Set<string>;
}): Promise<RetentionResult> {
  const result: RetentionResult = {
    path: options.path,
    removed: [],
    kept: 0,
    max_count: options.maxCount,
    max_age_ms: options.maxAgeMs
  };
  if (options.maxCount === 0 && options.maxAgeMs === 0) return result;

  let entries;
  try {
    entries = await readdir(options.path, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") return result;
    return { ...result, error: errorMessage(error) };
  }

  const candidates: Array<{ path: string; name: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (options.kind === "directory" && !entry.isDirectory()) continue;
    if (options.kind === "file" && !entry.isFile()) continue;
    const entryPath = resolve(options.path, entry.name);
    if (options.preserve?.has(entryPath)) continue;
    try {
      const info = await stat(entryPath);
      candidates.push({ path: entryPath, name: entry.name, mtimeMs: info.mtimeMs });
    } catch {
      // A concurrent cleanup can remove an entry between readdir and stat.
    }
  }

  const now = Date.now();
  const remove = new Set<string>();
  if (options.maxAgeMs > 0) {
    for (const candidate of candidates) {
      if (now - candidate.mtimeMs > options.maxAgeMs) remove.add(candidate.path);
    }
  }
  if (options.maxCount > 0) {
    const newestFirst = [...candidates].sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const candidate of newestFirst.slice(options.maxCount)) remove.add(candidate.path);
  }

  for (const path of remove) {
    try {
      await rm(path, { recursive: true, force: true });
      result.removed.push(path);
    } catch (error) {
      result.error = result.error ? `${result.error}; ${errorMessage(error)}` : errorMessage(error);
    }
  }
  result.kept = candidates.length - result.removed.length;
  return result;
}

async function applyRetention(dataDir: string, runDir: string, evidenceDir: string): Promise<Record<string, unknown> | null> {
  if (process.env.VITALS_UPDATE_RETENTION_DISABLED === "1") return null;
  const maxRuns = envInt("VITALS_UPDATE_RETENTION_MAX_RUNS", 672);
  const maxRunAgeMs = envInt("VITALS_UPDATE_RETENTION_MAX_AGE_MS", 7 * 24 * 60 * 60_000);
  const maxEvidenceAgeMs = envInt("VITALS_UPDATE_EVIDENCE_RETENTION_MAX_AGE_MS", 365 * 24 * 60 * 60_000);
  const runs = await pruneDirectory({
    path: join(dataDir, "runs"),
    kind: "directory",
    maxCount: maxRuns,
    maxAgeMs: maxRunAgeMs,
    preserve: new Set([resolve(runDir)])
  });
  const evidence = await pruneDirectory({
    path: evidenceDir,
    kind: "file",
    maxCount: 0,
    maxAgeMs: maxEvidenceAgeMs
  });
  const rawEvidence = await pruneDirectory({
    path: join(evidenceDir, "raw"),
    kind: "file",
    maxCount: 0,
    maxAgeMs: maxEvidenceAgeMs
  });
  return {
    schema: "octra-vitals-retention-v0",
    runs,
    evidence,
    raw_evidence: rawEvidence
  };
}

async function timed<T>(timings: Record<string, number>, label: string, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await fn();
  } finally {
    timings[label] = ms(performance.now() - started);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function ageMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return Date.now() - parsed;
}

function pidAlive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

async function readLockPayload(lockPath: string): Promise<UpdateLockPayload | null> {
  try {
    return JSON.parse(await readFile(lockPath, "utf8")) as UpdateLockPayload;
  } catch {
    return null;
  }
}

async function lockFileAgeMs(lockPath: string): Promise<number | null> {
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs;
  } catch {
    return null;
  }
}

export async function acquireLock(lockPath: string, runId: string, staleMs: number): Promise<UpdateLock> {
  await mkdir(dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const body = `${JSON.stringify({
    schema: "octra-vitals-updater-lock-v0",
    run_id: runId,
    pid: process.pid,
    started_at: isoNow(),
    token
  }, null, 2)}\n`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(lockPath, body, { flag: "wx" });
      return {
        path: lockPath,
        token,
        assertOwned: async () => {
          const current = await readLockPayload(lockPath);
          if (current?.token !== token || current?.run_id !== runId) {
            throw new Error(`snapshot updater lock ownership changed at ${lockPath}`);
          }
        },
        release: async () => {
          const current = await readLockPayload(lockPath);
          if (current?.token === token && current?.run_id === runId) {
            await rm(lockPath, { force: true });
          }
        }
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readLockPayload(lockPath);
      const lockAge = ageMs(existing?.started_at) ?? await lockFileAgeMs(lockPath);
      if (staleMs > 0 && lockAge !== null && lockAge > staleMs) {
        if (existing && pidAlive(existing.pid)) {
          throw new Error(`snapshot updater lock is stale but pid ${existing?.pid} is still alive at ${lockPath}${existing?.run_id ? ` by ${existing.run_id}` : ""}`);
        }
        await rm(lockPath, { force: true });
        continue;
      }
      throw new Error(`snapshot updater lock is held at ${lockPath}${existing?.run_id ? ` by ${existing.run_id}` : existing ? "" : " by an unreadable owner"}`);
    }
  }
  throw new Error(`could not acquire snapshot updater lock at ${lockPath}`);
}

async function collectLiveSnapshotWithRetries(attempts: Array<Record<string, unknown>>): Promise<{ snapshot: Awaited<ReturnType<typeof buildLiveSnapshot>>; attempts: Array<Record<string, unknown>> }> {
  const maxAttempts = envInt("VITALS_COLLECT_ATTEMPTS", 3, 1, 10);
  const retryDelayMs = envInt("VITALS_COLLECT_RETRY_DELAY_MS", 15_000, 0, 300_000);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const started = performance.now();
    try {
      const snapshot = await buildLiveSnapshot();
      attempts.push({
        attempt,
        status: "ok",
        duration_ms: ms(performance.now() - started),
        snapshot_id: snapshot.envelope.snapshot_id
      });
      return { snapshot, attempts };
    } catch (error) {
      attempts.push({
        attempt,
        status: "failed",
        duration_ms: ms(performance.now() - started),
        error: errorMessage(error)
      });
      if (attempt >= maxAttempts) {
        throw new Error(`snapshot collection failed after ${maxAttempts} attempt(s): ${attempts.map((entry) => entry.error).filter(Boolean).join(" | ")}`);
      }
      await sleep(retryDelayMs * attempt);
    }
  }
  throw new Error("snapshot collection failed before starting");
}

async function runSnapshotUpdate(): Promise<Record<string, any>> {
  const startedAt = isoNow();
  const runId = process.env.VITALS_UPDATE_RUN_ID || `snapshot-${fileSafe(startedAt)}-${process.pid}`;
  const dataDir = resolve(process.env.VITALS_UPDATE_DATA_DIR || process.env.VITALS_DATA_DIR || join(root, "data"));
  const runDir = resolve(process.env.VITALS_UPDATE_RUN_DIR || join(dataDir, "runs", runId));
  const lockPath = resolve(process.env.VITALS_UPDATE_LOCK_PATH || join(dataDir, "snapshot-updater.lock"));
  const lockStaleMs = envInt("VITALS_UPDATE_LOCK_STALE_MS", 10 * 60_000, 1, 24 * 60 * 60_000);
  const evidenceDir = resolve(process.env.VITALS_UPDATE_EVIDENCE_DIR || join(dataDir, "evidence"));
  const snapshotPath = join(runDir, "latest_snapshot.json");
  const recordCallPath = join(runDir, "record_snapshot_call.json");
  const submitReportPath = join(runDir, "submit_snapshot.json");
  const pendingSubmissionPath = join(runDir, "pending_submission.json");
  const runReportPath = join(runDir, "snapshot_update_report.json");
  const latestRunReportPath = join(dataDir, "latest_snapshot_update_report.json");
  const labHistoryTriggerPath = process.env.VITALS_LAB_HISTORY_TRIGGER_PATH || join(dataDir, "lab-history-trigger", "latest.json");
  const timings: Record<string, number> = {};
  let collectAttempts: Array<Record<string, unknown>> = [];
  const totalStarted = performance.now();
  const paths = {
    run_dir: runDir,
    snapshot: snapshotPath,
    evidence_dir: evidenceDir,
    record_call: recordCallPath,
    pending_submission: pendingSubmissionPath,
    submit_report: submitReportPath,
    run_report: runReportPath,
    latest_run_report: latestRunReportPath,
    lab_history_trigger: labHistoryTriggerPath,
    lock: lockPath
  };

  const lock = await acquireLock(lockPath, runId, lockStaleMs);
  try {
    await mkdir(runDir, { recursive: true });
    const collection = await timed(timings, "collect_ms", () => collectLiveSnapshotWithRetries(collectAttempts));
    const snapshot = collection.snapshot;
    await timed(timings, "write_snapshot_artifacts_ms", () => writeSnapshotArtifacts(snapshot, snapshotPath, evidenceDir));
    const call = await timed(timings, "record_call_ms", () => buildRecordSnapshotCall(snapshot));
    await timed(timings, "write_record_call_ms", () => writeRecordSnapshotCall(call, recordCallPath));
    await lock.assertOwned();
    const submitReport = await timed(timings, "submit_ms", () => submitSnapshotCall(call, {
      dataDir,
      pendingSubmissionPath,
      writeLatestReceipt: false
    }));
    await lock.assertOwned();
    const report: Record<string, any> = {
      ...submitReport,
      schema: "octra-vitals-snapshot-update-report-v0",
      run_id: runId,
      started_at: startedAt,
      generated_at: isoNow(),
      collect_attempts: collectAttempts,
      paths,
      timings_ms: timings
    };
    report.retention = await timed(timings, "retention_ms", () => applyRetention(dataDir, runDir, evidenceDir));
    report.lab_history_trigger = await timed(timings, "post_aml_write_trigger_ms", () => writePostAmlWriteTrigger(report, labHistoryTriggerPath));
    await lock.assertOwned();
    timings.total_ms = ms(performance.now() - totalStarted);
    report.timings_ms = timings;
    await writeSubmitSnapshotReport(report, submitReportPath);
    await writeJsonAtomic(runReportPath, report);
    await writeJsonAtomic(latestRunReportPath, report);
    if (report.submit_enabled) {
      await writeLatestReceipt(report, { dataDir });
    }
    return report;
  } catch (error) {
    timings.total_ms = ms(performance.now() - totalStarted);
    const failure: Record<string, any> = {
      schema: "octra-vitals-snapshot-update-report-v0",
      status: "failed",
      run_id: runId,
      started_at: startedAt,
      generated_at: isoNow(),
      paths,
      timings_ms: timings,
      collect_attempts: collectAttempts,
      error: errorMessage(error)
    };
    try {
      await mkdir(runDir, { recursive: true });
      failure.retention = await applyRetention(dataDir, runDir, evidenceDir);
      await writeJsonAtomic(runReportPath, failure);
      await writeJsonAtomic(latestRunReportPath, failure);
    } catch {
      // Preserve the original failure path for systemd/journal.
    }
    throw error;
  } finally {
    await lock.release();
  }
}

async function main(): Promise<void> {
  const report = await runSnapshotUpdate();
  console.log(JSON.stringify({
    schema: report.schema,
    status: report.status,
    run_id: report.run_id,
    generated_at: report.generated_at,
    snapshot_id: report.snapshot_id,
    snapshot_index: report.snapshot_index,
    tx_hash: report.tx_hash,
    timings_ms: report.timings_ms,
    paths: report.paths
  }, null, 2));
}

if (isDirectCli(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(errorText(error));
    process.exit(1);
  });
}
