#!/usr/bin/env node
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { configuredStateTarget, readVerifiedCanonicalHistory } from "../lib/canonical-history.js";
import { mirrorLabHistory } from "../lib/lab-history.js";
import { octraSqliteConfig } from "../lib/octra-sqlite-client.js";
import { writeJsonAtomic } from "./submit-snapshot.js";

const root = resolve(new URL("../..", import.meta.url).pathname);

interface MirrorLock {
  path: string;
  release: () => Promise<void>;
}

interface MirrorLockPayload {
  run_id?: string;
  pid?: number;
  created_at?: string;
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function fileSafe(value: string): string {
  return value.replace(/[:.]/g, "").replace(/[^0-9A-Za-z_-]/g, "-");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseLockPayload(text: string): MirrorLockPayload | null {
  try {
    const parsed = JSON.parse(text) as MirrorLockPayload;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function processIsRunning(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    return false;
  }
}

export async function acquireLock(lockPath: string, runId: string, staleMs: number): Promise<MirrorLock | null> {
  const payload = JSON.stringify({ run_id: runId, pid: process.pid, created_at: isoNow() }, null, 2);
  try {
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, `${payload}\n`, { flag: "wx" });
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
    let stale = false;
    try {
      const existing = parseLockPayload(await readFile(lockPath, "utf8"));
      if (existing?.pid && !processIsRunning(existing.pid)) stale = true;
      const info = await stat(lockPath);
      stale = stale || Date.now() - info.mtimeMs > staleMs;
    } catch {
      stale = true;
    }
    if (!stale) return null;
    const reclaimedPath = `${lockPath}.reclaimed.${fileSafe(runId)}`;
    try {
      await rename(lockPath, reclaimedPath);
    } catch (reclaimError: any) {
      if (reclaimError?.code === "ENOENT" || reclaimError?.code === "EEXIST") return null;
      throw reclaimError;
    }
    try {
      await writeFile(lockPath, `${payload}\n`, { flag: "wx" });
    } catch (writeError: any) {
      if (writeError?.code === "EEXIST") return null;
      throw writeError;
    } finally {
      await rm(reclaimedPath, { force: true });
    }
  }
  return {
    path: lockPath,
    release: async () => {
      try {
        const text = await readFile(lockPath, "utf8");
        if (text.includes(runId)) await unlink(lockPath);
      } catch {
        // Already gone or replaced by a later run.
      }
    }
  };
}

async function pruneRunDirs(path: string, maxCount: number, maxAgeMs: number, preserve: string): Promise<Record<string, unknown>> {
  const result = { path, removed: [] as string[], kept: 0, max_count: maxCount, max_age_ms: maxAgeMs };
  if (maxCount === 0 && maxAgeMs === 0) return result;
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") return result;
    return { ...result, error: errorMessage(error) };
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entryPath = resolve(path, entry.name);
    if (entryPath === preserve) continue;
    try {
      const info = await stat(entryPath);
      candidates.push({ path: entryPath, mtimeMs: info.mtimeMs });
    } catch {
      // Concurrent cleanup can win the race.
    }
  }
  const now = Date.now();
  const remove = new Set<string>();
  if (maxAgeMs > 0) {
    for (const candidate of candidates) {
      if (now - candidate.mtimeMs > maxAgeMs) remove.add(candidate.path);
    }
  }
  if (maxCount > 0) {
    const newestFirst = [...candidates].sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const candidate of newestFirst.slice(maxCount)) remove.add(candidate.path);
  }
  for (const pathToRemove of remove) {
    try {
      await rm(pathToRemove, { recursive: true, force: true });
      result.removed.push(pathToRemove);
    } catch {
      // Retention should not decide mirror health.
    }
  }
  result.kept = candidates.length - result.removed.length;
  return result;
}

async function timed<T>(timings: Record<string, number>, label: string, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await fn();
  } finally {
    timings[label] = ms(performance.now() - started);
  }
}

async function readManifest(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function runLabHistoryMirror(): Promise<Record<string, any>> {
  const startedAt = isoNow();
  const runId = process.env.VITALS_LAB_HISTORY_RUN_ID || `lab-history-${fileSafe(startedAt)}-${process.pid}`;
  const dataDir = resolve(process.env.VITALS_LAB_HISTORY_DATA_DIR || process.env.VITALS_DATA_DIR || join(root, "data"));
  const runsDir = resolve(process.env.VITALS_LAB_HISTORY_RUNS_DIR || join(dataDir, "lab-history-runs"));
  const runDir = resolve(process.env.VITALS_LAB_HISTORY_RUN_DIR || join(runsDir, runId));
  const lockPath = resolve(process.env.VITALS_LAB_HISTORY_LOCK_PATH || join(dataDir, "lab-history-mirror.lock"));
  const lockStaleMs = Number(process.env.VITALS_LAB_HISTORY_LOCK_STALE_MS || 10 * 60_000);
  const manifestPath = resolve(process.env.VITALS_LAB_HISTORY_MANIFEST_PATH || join(root, "app", "vitals.manifest.json"));
  const runReportPath = join(runDir, "lab_history_mirror_report.json");
  const latestReportPath = resolve(process.env.VITALS_LAB_HISTORY_REPORT_PATH || join(dataDir, "latest_lab_history_mirror_report.json"));
  const startDelayMs = Number(process.env.VITALS_LAB_HISTORY_START_DELAY_MS || 0);
  const timings: Record<string, number> = {};
  const totalStarted = performance.now();
  const paths = {
    run_dir: runDir,
    run_report: runReportPath,
    latest_run_report: latestReportPath,
    lock: lockPath,
    manifest: manifestPath
  };

  if (startDelayMs > 0) {
    await timed(timings, "start_delay_ms", () => sleep(startDelayMs));
  }

  const lock = await acquireLock(lockPath, runId, lockStaleMs);
  if (!lock) {
    const report = {
      schema: "octra-vitals-lab-history-mirror-report-v0",
      status: "skipped",
      reason: "mirror_already_running",
      run_id: runId,
      started_at: startedAt,
      generated_at: isoNow(),
      paths,
      timings_ms: { total_ms: 0 }
    };
    await writeJsonAtomic(latestReportPath, report);
    return report;
  }

  try {
    await mkdir(runDir, { recursive: true });
    const config = octraSqliteConfig();
    if (!config.enabled) {
      const report = {
        schema: "octra-vitals-lab-history-mirror-report-v0",
        status: "skipped",
        reason: config.reason || "lab_history_unavailable",
        run_id: runId,
        started_at: startedAt,
        generated_at: isoNow(),
        lab_database_network: config.network,
        lab_database: config.database,
        paths,
        timings_ms: { total_ms: ms(performance.now() - totalStarted) }
      };
      await writeJsonAtomic(runReportPath, report);
      await writeJsonAtomic(latestReportPath, report);
      return report;
    }

    const manifest = await timed(timings, "manifest_read_ms", () => readManifest(manifestPath));
    const target = configuredStateTarget(manifest);
    if (!target.id) throw new Error(`${target.kind === "circle_program" ? "programmed Circle id" : "state program address"} is required`);
    const targetId = target.id;
    const history = await timed(timings, "verified_history_read_ms", () => readVerifiedCanonicalHistory(target));
    const mirror = await timed(timings, "lab_mirror_ms", () => mirrorLabHistory(history, {
      target_kind: target.kind,
      target_id: targetId
    }));
    const retention = await timed(timings, "retention_ms", () => pruneRunDirs(
      runsDir,
      Number(process.env.VITALS_LAB_HISTORY_RETENTION_MAX_RUNS || 672),
      Number(process.env.VITALS_LAB_HISTORY_RETENTION_MAX_AGE_MS || 7 * 24 * 60 * 60_000),
      runDir
    ));
    timings.total_ms = ms(performance.now() - totalStarted);
    const report = {
      schema: "octra-vitals-lab-history-mirror-report-v0",
      status: "ok",
      run_id: runId,
      started_at: startedAt,
      generated_at: isoNow(),
      lab_database_network: config.network,
      lab_database: config.database,
      state_target_mode: target.kind,
      state_target_id: targetId,
      source_history: {
        first_index: history.first_index,
        row_count: history.row_count,
        latest_index: history.rows[history.rows.length - 1]?.snapshot_index || 0,
        history_model: history.history_discovery || null,
        proof_scope: history.proof?.scope || null,
        proof_truncated: history.proof?.truncated ?? null
      },
      mirror,
      retention,
      paths,
      timings_ms: timings
    };
    await writeJsonAtomic(runReportPath, report);
    await writeJsonAtomic(latestReportPath, report);
    return report;
  } catch (error) {
    timings.total_ms = ms(performance.now() - totalStarted);
    const failure = {
      schema: "octra-vitals-lab-history-mirror-report-v0",
      status: "failed",
      run_id: runId,
      started_at: startedAt,
      generated_at: isoNow(),
      error: errorMessage(error),
      paths,
      timings_ms: timings
    };
    await mkdir(runDir, { recursive: true }).catch(() => undefined);
    await writeJsonAtomic(runReportPath, failure).catch(() => undefined);
    await writeJsonAtomic(latestReportPath, failure).catch(() => undefined);
    throw error;
  } finally {
    await lock.release();
  }
}

async function main(): Promise<void> {
  const report = await runLabHistoryMirror();
  console.log(JSON.stringify({
    schema: report.schema,
    status: report.status,
    reason: report.reason || null,
    run_id: report.run_id,
    generated_at: report.generated_at,
    lab_database_network: report.lab_database_network || null,
    lab_database: report.lab_database || null,
    state_target_mode: report.state_target_mode || null,
    state_target_id: report.state_target_id || null,
    mirror: report.mirror || null,
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
