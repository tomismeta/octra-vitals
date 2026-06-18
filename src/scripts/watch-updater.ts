#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type WatchStatus = "ok" | "recovered" | "failed";

interface Check {
  name: string;
  ok: boolean;
  detail?: Record<string, unknown>;
}

const root = resolve(new URL("../..", import.meta.url).pathname);
const timerUnit = process.env.VITALS_WATCH_UPDATER_TIMER || "octra-vitals-updater.timer";
const updaterService = process.env.VITALS_WATCH_UPDATER_SERVICE || "octra-vitals-updater.service";
const gatewayService = process.env.VITALS_WATCH_GATEWAY_SERVICE || "octra-vitals-gateway.service";
const gatewayUrl = process.env.VITALS_WATCH_GATEWAY_URL || "http://127.0.0.1:4173";
const dataDir = resolve(process.env.VITALS_WATCH_DATA_DIR || process.env.VITALS_DATA_DIR || join(root, "data"));
const receiptPath = process.env.VITALS_WATCH_RECEIPT_PATH || join(dataDir, "latest_submit_receipt.json");
const latestRunReportPath = process.env.VITALS_WATCH_RUN_REPORT_PATH || join(dataDir, "latest_snapshot_update_report.json");
const reportPath = process.env.VITALS_WATCH_REPORT_PATH || join(dataDir, "watchdog", "latest_updater_watchdog.json");
const maxReceiptAgeMs = Number(process.env.VITALS_WATCH_MAX_RECEIPT_AGE_MS || 45 * 60_000);
const requestTimeoutMs = Number(process.env.VITALS_WATCH_REQUEST_TIMEOUT_MS || 30_000);
const recoveryWaitMs = Number(process.env.VITALS_WATCH_RECOVERY_WAIT_MS || 20_000);
const recoveryEnabled = process.env.VITALS_WATCH_RECOVERY_ENABLED !== "0";

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function ageMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return Date.now() - parsed;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function systemctl(args: string[]): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  try {
    const result = await execFileAsync("systemctl", args, { timeout: 30_000 });
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), ok: true };
  } catch (error: any) {
    return {
      stdout: String(error?.stdout || "").trim(),
      stderr: String(error?.stderr || error?.message || "").trim(),
      ok: false
    };
  }
}

async function unitIsActive(unit: string): Promise<boolean> {
  const result = await systemctl(["is-active", unit]);
  return result.ok && result.stdout === "active";
}

async function ensureTimerActive(actions: string[], checks: Check[]): Promise<boolean> {
  const active = await unitIsActive(timerUnit);
  checks.push({ name: "updater_timer_active", ok: active, detail: { unit: timerUnit } });
  if (active) return true;
  if (!recoveryEnabled) {
    checks.push({ name: "updater_timer_recovery_disabled", ok: false, detail: { unit: timerUnit } });
    return false;
  }

  actions.push(`reset-failed ${timerUnit}`);
  await systemctl(["reset-failed", timerUnit]);
  actions.push(`enable --now ${timerUnit}`);
  await systemctl(["enable", "--now", timerUnit]);
  const recovered = await unitIsActive(timerUnit);
  checks.push({ name: "updater_timer_recovered", ok: recovered, detail: { unit: timerUnit } });
  return recovered;
}

async function readJson(path: string): Promise<any | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function receiptCheck(checks: Check[]): Promise<{ ok: boolean; receipt: any | null; latestRunReport: any | null; stale: boolean; lastRunFailed: boolean }> {
  const receipt = await readJson(receiptPath);
  const latestRunReport = await readJson(latestRunReportPath);
  const generatedAge = ageMs(receipt?.generated_at);
  const lastRunAge = ageMs(latestRunReport?.generated_at);
  const readbackMatches = receipt?.readback?.matches_expected === true;
  const ok = Boolean(receipt && generatedAge !== null && generatedAge <= maxReceiptAgeMs && readbackMatches);
  const stale = !receipt || generatedAge === null || generatedAge > maxReceiptAgeMs;
  const lastRunFailed = latestRunReport?.status === "failed";
  checks.push({
    name: "latest_submit_receipt_fresh",
    ok,
    detail: {
      path: receiptPath,
      generated_at: receipt?.generated_at || null,
      age_ms: generatedAge,
      max_age_ms: maxReceiptAgeMs,
      readback_matches: readbackMatches,
      snapshot_id: receipt?.snapshot_id || null,
      tx_hash: receipt?.tx_hash || null,
      run_id: receipt?.run_id || latestRunReport?.run_id || null,
      last_run_status: latestRunReport?.status || null,
      last_run_generated_at: latestRunReport?.generated_at || null,
      last_run_age_ms: lastRunAge,
      last_run_timings_ms: latestRunReport?.timings_ms || null
    }
  });
  if (lastRunFailed) {
    checks.push({
      name: "latest_updater_run_succeeded",
      ok: false,
      detail: {
        path: latestRunReportPath,
        run_id: latestRunReport?.run_id || null,
        generated_at: latestRunReport?.generated_at || null,
        age_ms: lastRunAge,
        error: latestRunReport?.error || null,
        collect_attempts: latestRunReport?.collect_attempts || null
      }
    });
  }
  return { ok, receipt, latestRunReport, stale, lastRunFailed };
}

async function startUpdater(actions: string[], checks: Check[]): Promise<void> {
  if (!recoveryEnabled) {
    checks.push({ name: "updater_service_recovery_disabled", ok: false, detail: { unit: updaterService } });
    return;
  }
  if (await unitIsActive(updaterService)) {
    checks.push({ name: "updater_service_already_running", ok: true, detail: { unit: updaterService } });
    return;
  }
  actions.push(`start ${updaterService}`);
  const result = await systemctl(["start", updaterService]);
  checks.push({
    name: "updater_service_started",
    ok: result.ok,
    detail: { unit: updaterService, stdout: result.stdout || null, stderr: result.stderr || null }
  });
  await sleep(recoveryWaitMs);
}

async function fetchJson(url: string): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "octra-vitals-watchdog/v0" },
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${url} returned ${response.status}: ${text.slice(0, 240)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

async function gatewayCheck(checks: Check[]): Promise<boolean> {
  try {
    const latest = await fetchJson(`${gatewayUrl.replace(/\/$/, "")}/api/latest`);
    const expectedHash = latest?.receipt?.expected_hashes?.payload_hash;
    const envelopeHash = latest?.envelope?.payload_hash;
    const readbackMatches = latest?.receipt?.readback?.matches_expected === true;
    const latestStatusOk = latest?.status === "native" || latest?.status === "program";
    const ok = latestStatusOk &&
      latest?.source === "program" &&
      latest?.fresh === true &&
      readbackMatches &&
      Boolean(expectedHash && envelopeHash && expectedHash === envelopeHash);
    checks.push({
      name: "gateway_latest_native_fresh",
      ok,
      detail: {
        url: `${gatewayUrl}/api/latest`,
        status: latest?.status || null,
        source: latest?.source || null,
        fresh: latest?.fresh ?? null,
        snapshot_id: latest?.envelope?.snapshot_id || latest?.receipt?.snapshot_id || null,
        payload_hash: envelopeHash || null,
        receipt_hash: expectedHash || null,
        readback_matches: readbackMatches
      }
    });
    return ok;
  } catch (error: any) {
    checks.push({
      name: "gateway_latest_native_fresh",
      ok: false,
      detail: { url: `${gatewayUrl}/api/latest`, error: String(error?.message || error) }
    });
    return false;
  }
}

async function nativeReadinessCheck(checks: Check[]): Promise<boolean> {
  try {
    const readiness = await fetchJson(`${gatewayUrl.replace(/\/$/, "")}/api/native-readiness`);
    const value = readiness?.native_readiness || readiness;
    const ok = value?.status === "native_ready";
    checks.push({
      name: "native_readiness",
      ok,
      detail: {
        url: `${gatewayUrl}/api/native-readiness`,
        status: value?.status || null,
        site_circle_assets_verified: value?.site_circle_assets_verified ?? null,
        live_source_hash_matches: value?.live_source_hash_matches ?? null,
        live_bytecode_hash_matches: value?.live_bytecode_hash_matches ?? null
      }
    });
    return ok;
  } catch (error: any) {
    checks.push({
      name: "native_readiness",
      ok: false,
      detail: { url: `${gatewayUrl}/api/native-readiness`, error: String(error?.message || error) }
    });
    return false;
  }
}

async function restartGateway(actions: string[], checks: Check[]): Promise<void> {
  if (!recoveryEnabled) {
    checks.push({ name: "gateway_restart_disabled", ok: false, detail: { unit: gatewayService } });
    return;
  }
  actions.push(`restart ${gatewayService}`);
  const result = await systemctl(["restart", gatewayService]);
  checks.push({
    name: "gateway_restarted",
    ok: result.ok,
    detail: { unit: gatewayService, stdout: result.stdout || null, stderr: result.stderr || null }
  });
  await sleep(5_000);
}

async function writeReport(report: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

const checks: Check[] = [];
const actions: string[] = [];
const startedAt = isoNow();

let timerActive = await ensureTimerActive(actions, checks);
let receipt = await receiptCheck(checks);
if (receipt.lastRunFailed || (!receipt.ok && receipt.stale)) {
  await startUpdater(actions, checks);
  receipt = await receiptCheck(checks);
}

let gatewayOk = await gatewayCheck(checks);
let readinessOk = await nativeReadinessCheck(checks);
if (!gatewayOk) {
  await restartGateway(actions, checks);
  gatewayOk = await gatewayCheck(checks);
  readinessOk = await nativeReadinessCheck(checks);
}

timerActive = await unitIsActive(timerUnit);
if (actions.length > 0) {
  checks.push({ name: "final_updater_timer_active", ok: timerActive, detail: { unit: timerUnit } });
  receipt = await receiptCheck(checks);
}

const finalOk = timerActive && receipt.ok && gatewayOk && readinessOk;
const status: WatchStatus = finalOk ? (actions.length ? "recovered" : "ok") : "failed";
const report = {
  schema: "octra-vitals-updater-watchdog-v0",
  status,
  generated_at: isoNow(),
  started_at: startedAt,
  timer_unit: timerUnit,
  updater_service: updaterService,
  gateway_service: gatewayService,
  gateway_url: gatewayUrl,
  receipt_path: receiptPath,
  latest_run_report_path: latestRunReportPath,
  recovery_enabled: recoveryEnabled,
  actions,
  checks
};

await writeReport(report);
console.log(JSON.stringify(report, null, 2));

if (status === "failed") {
  process.exitCode = 1;
}
