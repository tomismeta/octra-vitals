#!/usr/bin/env node
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readSnapshotRunRows, summarizeSnapshotRunRows } from "./summarize-snapshot-runs.js";
import { TRAFFIC_SCHEMA_VERSION, type TrafficHourFile, type TrafficMetric } from "../lib/traffic.js";

const execFileAsync = promisify(execFile);
const root = resolve(new URL("../..", import.meta.url).pathname);
type SnapshotRunRow = Awaited<ReturnType<typeof readSnapshotRunRows>>[number];

export interface OperatorSummary {
  generated_at: string;
  periods: OperatorPeriods;
  gateway: GatewaySummary;
  snapshots: SnapshotSummary;
  traffic: OperatorTrafficSummary;
  archive: ArchiveSummary;
  disk: DiskSummary;
}

export interface OperatorPeriods {
  last_hour_start_at: string;
  last_hour_end_at: string;
  last_24h_start_at: string;
  last_24h_end_at: string;
}

export interface GatewaySummary {
  latest_ok: boolean;
  latest_status_code: number | null;
  latest_error: string | null;
  latest_snapshot_id: string | null;
  latest_snapshot_index: string | null;
  latest_observed_at: string | null;
  latest_age_ms: number | null;
  latest_source: string | null;
  latest_fresh: boolean | null;
  readback_matches: boolean | null;
  conservation_status: string | null;
  conservation_flags: string[];
  conservation_largest_abs_delta_raw: string | null;
  native_status: string | null;
  site_integrity_ok: boolean | null;
  site_integrity_status: string | null;
  site_integrity_error_count: number;
}

export interface SnapshotSummary {
  run_count: number;
  confirmed_count: number;
  failed_count: number;
  last_hour: SnapshotPeriodSummary;
  last_24h: SnapshotPeriodSummary;
  latest_status: string | null;
  latest_generated_at: string | null;
  latest_age_ms: number | null;
  latest_snapshot_id: string | null;
  latest_snapshot_index: string | null;
  latest_tx_hash: string | null;
  latest_readback_matches: boolean | null;
  median_cadence_minutes: number | null;
  median_total_ms: number | null;
}

export interface SnapshotPeriodSummary {
  run_count: number;
  confirmed_count: number;
  failed_count: number;
  latest_snapshot_id: string | null;
  latest_snapshot_index: string | null;
  latest_tx_hash: string | null;
}

export interface OperatorTrafficSummary {
  hours: number;
  last_hour: TrafficPeriodSummary;
  last_24h: TrafficPeriodSummary;
  total_requests_24h: number;
  total_unique_daily_hashes_24h: number;
  homepage_requests_24h: number;
  homepage_unique_daily_hashes_24h: number;
  api_latest_requests_24h: number;
  diagnostic_requests_24h: number;
  diagnostic_requests_current_hour: number;
  top_diagnostic_paths_24h: Array<{ path: string; requests: number; unique_clients: number }>;
}

export interface TrafficPeriodSummary {
  requests: number;
  unique_daily_hashes: number;
  homepage_requests: number;
  homepage_unique_daily_hashes: number;
  api_latest_requests: number;
  diagnostic_requests: number;
  top_diagnostic_paths: Array<{ path: string; requests: number; unique_clients: number }>;
}

export interface ArchiveSummary {
  evidence_files: number;
  evidence_bytes: number;
  evidence_files_last_hour: number;
  evidence_bytes_last_hour: number;
  evidence_files_24h: number;
  evidence_bytes_24h: number;
  raw_evidence_files: number;
  raw_evidence_bytes: number;
  raw_evidence_files_last_hour: number;
  raw_evidence_bytes_last_hour: number;
  raw_evidence_files_24h: number;
  raw_evidence_bytes_24h: number;
  raw_evidence_projected_365d_bytes: number;
}

export interface DiskSummary {
  path: string;
  used_percent: number | null;
  available_kb: number | null;
  error: string | null;
}

export interface OperatorAlert {
  id: string;
  severity: "warn" | "critical";
  message: string;
}

export interface AlertThresholds {
  max_snapshot_age_ms: number;
  disk_used_percent: number;
  diagnostic_requests_current_hour: number;
  raw_evidence_projected_disk_percent: number;
}

interface FetchResult {
  status: number | null;
  ok: boolean;
  json: any | null;
  error: string | null;
}

function isDirectCli(metaUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(resolve(argvPath));
  } catch {
    return fileURLToPath(metaUrl) === resolve(argvPath);
  }
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function isoFromMs(value: number): string {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function completePeriods(now = new Date()): OperatorPeriods {
  const lastHourEnd = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours(),
    0,
    0,
    0
  );
  const lastHourStart = lastHourEnd - 60 * 60_000;
  const last24hStart = lastHourEnd - 24 * 60 * 60_000;
  return {
    last_hour_start_at: isoFromMs(lastHourStart),
    last_hour_end_at: isoFromMs(lastHourEnd),
    last_24h_start_at: isoFromMs(last24hStart),
    last_24h_end_at: isoFromMs(lastHourEnd)
  };
}

function withinPeriod(value: string | null, startAt: string, endAt: string): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  return Number.isFinite(parsed) && Number.isFinite(start) && Number.isFinite(end) && parsed >= start && parsed < end;
}

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1] || null;
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function ageMs(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Date.now() - parsed);
}

function shortHash(value: string | null): string {
  if (!value) return "n/a";
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}...${value.slice(-6)}`;
}

function duration(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remain = seconds % 60;
  if (minutes < 60) return remain ? `${minutes}m ${remain}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

function bytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let next = value;
  let unit = 0;
  while (next >= 1024 && unit < units.length - 1) {
    next /= 1024;
    unit += 1;
  }
  const precision = unit <= 1 ? 0 : 1;
  return `${next.toFixed(precision)} ${units[unit] || "B"}`;
}

function h(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function b(value: unknown): string {
  return `<b>${h(value)}</b>`;
}

function c(value: unknown): string {
  return `<code>${h(value)}</code>`;
}

function boolText(value: boolean | null): string {
  return value === null ? "n/a" : String(value);
}

function hourRange(startAt: string, endAt: string): string {
  return `${startAt.slice(11, 16)}-${endAt.slice(11, 16)} UTC`;
}

function shortDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[date.getUTCMonth()] || "UTC";
  const day = String(date.getUTCDate()).padStart(2, "0");
  const time = value.slice(11, 16);
  return `${month} ${day} ${time}`;
}

function periodRange(startAt: string, endAt: string): string {
  if (startAt.slice(0, 10) === endAt.slice(0, 10)) return hourRange(startAt, endAt);
  return `${shortDateTime(startAt)}-${shortDateTime(endAt)} UTC`;
}

function topPaths(rows: Array<{ path: string; requests: number; unique_clients: number }>): string {
  if (!rows.length) return "none";
  return rows
    .slice(0, 3)
    .map((row) => `${c(row.path)} ${h(row.requests)}`)
    .join(", ");
}

function metricRequests(metric: TrafficMetric | undefined): number {
  return metric?.requests || 0;
}

function addMetricClients(metric: TrafficMetric | undefined, clients: Set<string>): void {
  for (const client of Object.keys(metric?.clients || {})) clients.add(client);
}

function sumStatus(metric: TrafficMetric | undefined, predicate: (status: number) => boolean): number {
  let total = 0;
  for (const [status, count] of Object.entries(metric?.statuses || {})) {
    const parsed = Number(status);
    if (Number.isFinite(parsed) && predicate(parsed)) total += count;
  }
  return total;
}

async function readTrafficHours(trafficDir: string): Promise<TrafficHourFile[]> {
  const files = (await readdir(trafficDir).catch(() => []))
    .filter((file) => /^\d{4}-\d{2}-\d{2}T\d{2}\.json$/.test(file))
    .sort();
  const hours: TrafficHourFile[] = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(await readFile(join(trafficDir, file), "utf8")) as TrafficHourFile;
      if (parsed.schema === TRAFFIC_SCHEMA_VERSION) hours.push(parsed);
    } catch {
      // Ignore partially written traffic files.
    }
  }
  return hours;
}

function trafficHoursInPeriod(hours: TrafficHourFile[], startAt: string, endAt: string): TrafficHourFile[] {
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  return hours.filter((hour) => {
    const parsed = Date.parse(hour.hour);
    return Number.isFinite(parsed) && Number.isFinite(start) && Number.isFinite(end) && parsed >= start && parsed < end;
  });
}

function aggregateTrafficPeriod(hours: TrafficHourFile[]): TrafficPeriodSummary {
  const totalClients = new Set<string>();
  const homepageClients = new Set<string>();
  const diagnosticPathMap = new Map<string, { requests: number; clients: Set<string> }>();
  let totalRequests = 0;
  let homepageRequests = 0;
  let apiLatestRequests = 0;
  let diagnosticRequests = 0;

  for (const hour of hours) {
    totalRequests += metricRequests(hour.totals);
    addMetricClients(hour.totals, totalClients);
    homepageRequests += metricRequests(hour.routes["/"]);
    addMetricClients(hour.routes["/"], homepageClients);
    apiLatestRequests += metricRequests(hour.routes["/api/latest"]);
    for (const [path, metric] of Object.entries(hour.diagnostic_paths || {})) {
      diagnosticRequests += metric.requests;
      const existing = diagnosticPathMap.get(path) || { requests: 0, clients: new Set<string>() };
      existing.requests += metric.requests;
      addMetricClients(metric, existing.clients);
      diagnosticPathMap.set(path, existing);
    }
    if (hour.diagnostic_path_overflow) {
      diagnosticRequests += hour.diagnostic_path_overflow.requests;
      const existing = diagnosticPathMap.get("__overflow__") || { requests: 0, clients: new Set<string>() };
      existing.requests += hour.diagnostic_path_overflow.requests;
      addMetricClients(hour.diagnostic_path_overflow, existing.clients);
      diagnosticPathMap.set("__overflow__", existing);
    }
  }

  const topDiagnosticPaths = [...diagnosticPathMap.entries()]
    .map(([path, value]) => ({ path, requests: value.requests, unique_clients: value.clients.size }))
    .sort((a, b) => b.requests - a.requests || a.path.localeCompare(b.path))
    .slice(0, 5);

  return {
    requests: totalRequests,
    unique_daily_hashes: totalClients.size,
    homepage_requests: homepageRequests,
    homepage_unique_daily_hashes: homepageClients.size,
    api_latest_requests: apiLatestRequests,
    diagnostic_requests: diagnosticRequests,
    top_diagnostic_paths: topDiagnosticPaths
  };
}

async function summarizeTraffic(dataDir: string, periods: OperatorPeriods): Promise<OperatorTrafficSummary> {
  const trafficDir = resolve(process.env.VITALS_NOTIFY_TRAFFIC_DIR || process.env.VITALS_TRAFFIC_DIR || join(dataDir, "traffic"));
  const hours = await readTrafficHours(trafficDir);
  const lastHour = aggregateTrafficPeriod(trafficHoursInPeriod(hours, periods.last_hour_start_at, periods.last_hour_end_at));
  const last24h = aggregateTrafficPeriod(trafficHoursInPeriod(hours, periods.last_24h_start_at, periods.last_24h_end_at));

  return {
    hours: trafficHoursInPeriod(hours, periods.last_24h_start_at, periods.last_24h_end_at).length,
    last_hour: lastHour,
    last_24h: last24h,
    total_requests_24h: last24h.requests,
    total_unique_daily_hashes_24h: last24h.unique_daily_hashes,
    homepage_requests_24h: last24h.homepage_requests,
    homepage_unique_daily_hashes_24h: last24h.homepage_unique_daily_hashes,
    api_latest_requests_24h: last24h.api_latest_requests,
    diagnostic_requests_24h: last24h.diagnostic_requests,
    diagnostic_requests_current_hour: lastHour.diagnostic_requests,
    top_diagnostic_paths_24h: last24h.top_diagnostic_paths
  };
}

function summarizeSnapshotPeriod(rows: SnapshotRunRow[], startAt: string, endAt: string): SnapshotPeriodSummary {
  const periodRows = rows.filter((row) => withinPeriod(row.generated_at, startAt, endAt));
  const latest = periodRows[periodRows.length - 1] || null;
  return {
    run_count: periodRows.length,
    confirmed_count: periodRows.filter((row) => row.status === "confirmed").length,
    failed_count: periodRows.filter((row) => row.status === "failed").length,
    latest_snapshot_id: latest?.snapshot_id || null,
    latest_snapshot_index: latest?.snapshot_index || null,
    latest_tx_hash: latest?.tx_hash || null
  };
}

async function summarizeSnapshots(dataDir: string, periods: OperatorPeriods): Promise<SnapshotSummary> {
  const rows = await readSnapshotRunRows(dataDir);
  const summary = summarizeSnapshotRunRows(dataDir, rows);
  const latest = summary.latest;
  return {
    run_count: summary.run_count,
    confirmed_count: summary.status_counts.confirmed || 0,
    failed_count: summary.status_counts.failed || 0,
    last_hour: summarizeSnapshotPeriod(rows, periods.last_hour_start_at, periods.last_hour_end_at),
    last_24h: summarizeSnapshotPeriod(rows, periods.last_24h_start_at, periods.last_24h_end_at),
    latest_status: latest?.status || null,
    latest_generated_at: latest?.generated_at || null,
    latest_age_ms: ageMs(latest?.generated_at || null),
    latest_snapshot_id: latest?.snapshot_id || null,
    latest_snapshot_index: latest?.snapshot_index || null,
    latest_tx_hash: latest?.tx_hash || null,
    latest_readback_matches: latest?.readback_matches ?? null,
    median_cadence_minutes: summary.cadence_minutes.median,
    median_total_ms: summary.timings_ms.total.median
  };
}

async function countFiles(dir: string, period?: { startAt: string; endAt: string }): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let totalBytes = 0;
  const start = period ? Date.parse(period.startAt) : null;
  const end = period ? Date.parse(period.endAt) : null;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      const info = await stat(join(dir, entry.name));
      if (start !== null && end !== null && Number.isFinite(start) && Number.isFinite(end)) {
        if (info.mtimeMs < start || info.mtimeMs >= end) continue;
      }
      files += 1;
      totalBytes += info.size;
    } catch {
      // Ignore files removed during pruning.
    }
  }
  return { files, bytes: totalBytes };
}

async function summarizeArchive(dataDir: string, periods: OperatorPeriods): Promise<ArchiveSummary> {
  const evidenceDir = resolve(process.env.VITALS_NOTIFY_EVIDENCE_DIR || join(dataDir, "evidence"));
  const evidence = await countFiles(evidenceDir);
  const evidenceLastHour = await countFiles(evidenceDir, { startAt: periods.last_hour_start_at, endAt: periods.last_hour_end_at });
  const evidence24h = await countFiles(evidenceDir, { startAt: periods.last_24h_start_at, endAt: periods.last_24h_end_at });
  const rawEvidence = await countFiles(join(evidenceDir, "raw"));
  const rawEvidenceLastHour = await countFiles(join(evidenceDir, "raw"), { startAt: periods.last_hour_start_at, endAt: periods.last_hour_end_at });
  const rawEvidence24h = await countFiles(join(evidenceDir, "raw"), { startAt: periods.last_24h_start_at, endAt: periods.last_24h_end_at });
  return {
    evidence_files: evidence.files,
    evidence_bytes: evidence.bytes,
    evidence_files_last_hour: evidenceLastHour.files,
    evidence_bytes_last_hour: evidenceLastHour.bytes,
    evidence_files_24h: evidence24h.files,
    evidence_bytes_24h: evidence24h.bytes,
    raw_evidence_files: rawEvidence.files,
    raw_evidence_bytes: rawEvidence.bytes,
    raw_evidence_files_last_hour: rawEvidenceLastHour.files,
    raw_evidence_bytes_last_hour: rawEvidenceLastHour.bytes,
    raw_evidence_files_24h: rawEvidence24h.files,
    raw_evidence_bytes_24h: rawEvidence24h.bytes,
    raw_evidence_projected_365d_bytes: rawEvidence24h.bytes * 365
  };
}

async function summarizeDisk(path: string): Promise<DiskSummary> {
  try {
    const result = await execFileAsync("df", ["-Pk", path], { timeout: 10_000 });
    const lines = result.stdout.trim().split(/\n/);
    const row = lines[1]?.trim().split(/\s+/);
    if (!row || row.length < 5) throw new Error(`unexpected df output for ${path}`);
    const availableKb = Number(row[3]);
    const usedPercent = Number(row[4]?.replace(/%$/, ""));
    return {
      path,
      used_percent: Number.isFinite(usedPercent) ? usedPercent : null,
      available_kb: Number.isFinite(availableKb) ? availableKb : null,
      error: null
    };
  } catch (error) {
    return {
      path,
      used_percent: null,
      available_kb: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function fetchJson(url: string, timeoutMs: number): Promise<FetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "octra-vitals-operator-notify/v0" },
      signal: controller.signal
    });
    const body = await response.text();
    let parsed: any = null;
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch {
      parsed = null;
    }
    return {
      status: response.status,
      ok: response.ok,
      json: parsed,
      error: response.ok ? null : `${url} returned ${response.status}: ${body.slice(0, 200)}`
    };
  } catch (error) {
    return {
      status: null,
      ok: false,
      json: null,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function summarizeGateway(gatewayUrl: string): Promise<GatewaySummary> {
  const base = gatewayUrl.replace(/\/$/, "");
  const timeoutMs = envNumber("VITALS_NOTIFY_REQUEST_TIMEOUT_MS", 30_000);
  const [latest, integrity] = await Promise.all([
    fetchJson(`${base}/api/latest`, timeoutMs),
    fetchJson(`${base}/api/site-integrity`, timeoutMs)
  ]);
  const readiness = await fetchJson(`${base}/api/native-readiness`, timeoutMs);
  const latestJson = latest.json || {};
  const envelope = latestJson.envelope || {};
  const conservation = envelope?.payload?.health?.conservation || latestJson.payload?.health?.conservation || latestJson.health?.conservation || {};
  const receipt = latestJson.receipt || {};
  const observedAt = text(envelope.observed_at) || text(latestJson.observed_at);
  const readbackMatches = bool(receipt?.readback?.matches_expected);
  const latestSource = text(latestJson.source);
  const latestFresh = bool(latestJson.fresh);
  const latestOk = latest.ok &&
    latestJson.status === "program" &&
    latestSource === "program" &&
    latestFresh === true;
  const nativeStatus = text(readiness.json?.native_readiness?.status) || text(readiness.json?.status);
  const site = integrity.json?.site_integrity || {};
  const siteStatus = text(site.verification_status) || inferSiteIntegrityStatus(site);
  const siteIntegrityOk = typeof site.local_assets_match === "boolean" || typeof site.circle_assets_match === "boolean"
    ? site.local_assets_match === true && site.circle_assets_match === true
    : null;

  return {
    latest_ok: latestOk,
    latest_status_code: latest.status,
    latest_error: latest.error,
    latest_snapshot_id: text(envelope.snapshot_id) || text(latestJson.snapshot_id) || text(receipt.snapshot_id),
    latest_snapshot_index: receipt.snapshot_index === undefined || receipt.snapshot_index === null ? null : String(receipt.snapshot_index),
    latest_observed_at: observedAt,
    latest_age_ms: ageMs(observedAt),
    latest_source: latestSource,
    latest_fresh: latestFresh,
    readback_matches: readbackMatches,
    conservation_status: text(conservation.status),
    conservation_flags: Array.isArray(conservation.flags) ? conservation.flags.map((flag: unknown) => String(flag)) : [],
    conservation_largest_abs_delta_raw: text(conservation.largest_abs_delta_raw),
    native_status: nativeStatus,
    site_integrity_ok: siteIntegrityOk,
    site_integrity_status: siteStatus,
    site_integrity_error_count: Number.isFinite(Number(site.circle_error_count)) ? Number(site.circle_error_count) : 0
  };
}

function inferSiteIntegrityStatus(site: any): string | null {
  if (!site || typeof site !== "object") return null;
  if (site.local_assets_match === true && site.circle_assets_match === true) return "verified";
  const assets = Array.isArray(site.assets) ? site.assets : [];
  const hasCircleError = assets.some((asset: any) => asset?.circle_error);
  const hasCircleMismatch = assets.some((asset: any) => asset?.circle_sha256 && asset?.circle_matches !== true);
  if (hasCircleError && !hasCircleMismatch) return "circle_unavailable";
  if (site.local_assets_match === false || site.circle_assets_match === false) return "mismatch";
  return null;
}

function isSoftNativeReadinessWarning(summary: OperatorSummary): boolean {
  return summary.gateway.native_status === "program_pending_verification" &&
    summary.gateway.latest_ok === true &&
    summary.gateway.readback_matches === true &&
    summary.gateway.conservation_status === "green" &&
    summary.gateway.site_integrity_ok === true &&
    summary.gateway.site_integrity_status === "verified" &&
    summary.snapshots.latest_status === "confirmed" &&
    summary.snapshots.latest_readback_matches === true;
}

export function detectOperatorAlerts(summary: OperatorSummary, thresholds: AlertThresholds): OperatorAlert[] {
  const alerts: OperatorAlert[] = [];
  if (!summary.gateway.latest_ok) {
    alerts.push({
      id: "gateway_latest",
      severity: "critical",
      message: `/api/latest is not serving fresh program-backed data${summary.gateway.latest_error ? ` (${summary.gateway.latest_error})` : ""}`
    });
  }
  if (summary.gateway.readback_matches === false) {
    alerts.push({
      id: "gateway_latest_readback",
      severity: "critical",
      message: "latest gateway receipt readback does not match expected values"
    });
  }
  if (summary.gateway.latest_ok && !summary.gateway.conservation_status) {
    alerts.push({
      id: "conservation_unavailable",
      severity: "critical",
      message: "latest snapshot does not expose signed conservation status"
    });
  } else if (summary.gateway.conservation_status === "red") {
    alerts.push({
      id: "conservation_red",
      severity: "critical",
      message: `signed conservation status is red${summary.gateway.conservation_flags.length ? ` (${summary.gateway.conservation_flags.join(", ")})` : ""}`
    });
  } else if (summary.gateway.conservation_status === "yellow") {
    alerts.push({
      id: "conservation_yellow",
      severity: "warn",
      message: `signed conservation status is yellow${summary.gateway.conservation_flags.length ? ` (${summary.gateway.conservation_flags.join(", ")})` : ""}`
    });
  }
  if (summary.gateway.latest_age_ms !== null && summary.gateway.latest_age_ms > thresholds.max_snapshot_age_ms) {
    alerts.push({
      id: "snapshot_stale_gateway",
      severity: "critical",
      message: `latest gateway snapshot is ${duration(summary.gateway.latest_age_ms)} old`
    });
  }
  if (summary.snapshots.run_count === 0) {
    alerts.push({ id: "snapshot_no_runs", severity: "critical", message: "no snapshot run reports are available" });
  } else if (summary.snapshots.latest_status !== "confirmed" || summary.snapshots.latest_readback_matches !== true) {
    alerts.push({
      id: "snapshot_latest_run",
      severity: "critical",
      message: `latest updater run status is ${summary.snapshots.latest_status || "unknown"}; readback=${String(summary.snapshots.latest_readback_matches)}`
    });
  }
  if (summary.snapshots.latest_age_ms !== null && summary.snapshots.latest_age_ms > thresholds.max_snapshot_age_ms) {
    alerts.push({
      id: "snapshot_stale_run",
      severity: "critical",
      message: `latest updater run report is ${duration(summary.snapshots.latest_age_ms)} old`
    });
  }
  if (
    summary.gateway.native_status &&
    summary.gateway.native_status !== "native_ready" &&
    summary.gateway.site_integrity_status !== "circle_unavailable" &&
    !isSoftNativeReadinessWarning(summary)
  ) {
    alerts.push({
      id: "native_readiness",
      severity: "warn",
      message: `native readiness is ${summary.gateway.native_status}`
    });
  }
  if (summary.gateway.site_integrity_status === "circle_unavailable") {
    alerts.push({
      id: "site_integrity_unavailable",
      severity: "warn",
      message: `site integrity proof is temporarily unavailable from Circle RPC (${summary.gateway.site_integrity_error_count} asset read error${summary.gateway.site_integrity_error_count === 1 ? "" : "s"})`
    });
  } else if (summary.gateway.site_integrity_ok === false) {
    alerts.push({ id: "site_integrity", severity: "critical", message: "site integrity is not verified" });
  }
  if (summary.disk.used_percent !== null && summary.disk.used_percent >= thresholds.disk_used_percent) {
    alerts.push({
      id: "disk_usage",
      severity: "warn",
      message: `disk usage is ${summary.disk.used_percent}% on ${summary.disk.path}`
    });
  }
  if (summary.disk.available_kb !== null) {
    const availableBytes = summary.disk.available_kb * 1024;
    const projectedPercentOfFree = availableBytes > 0
      ? (summary.archive.raw_evidence_projected_365d_bytes / availableBytes) * 100
      : 0;
    if (projectedPercentOfFree >= thresholds.raw_evidence_projected_disk_percent) {
      alerts.push({
        id: "raw_evidence_growth",
        severity: "warn",
        message: `raw evidence 365d projection is ${bytes(summary.archive.raw_evidence_projected_365d_bytes)} (${Math.round(projectedPercentOfFree)}% of current free disk)`
      });
    }
  }
  if (summary.traffic.diagnostic_requests_current_hour >= thresholds.diagnostic_requests_current_hour) {
    alerts.push({
      id: "diagnostic_noise",
      severity: "warn",
      message: `${summary.traffic.diagnostic_requests_current_hour} diagnostic/probe responses in the current traffic hour`
    });
  }
  return alerts;
}

export function formatOperatorDigest(summary: OperatorSummary, alerts: OperatorAlert[]): string {
  const alertLabel = alerts.length ? `${alerts.length} alert${alerts.length === 1 ? "" : "s"}` : "OK";
  const cadence = summary.snapshots.median_cadence_minutes === null ? "n/a" : `${summary.snapshots.median_cadence_minutes}m`;
  const disk = summary.disk.used_percent === null
    ? `unknown${summary.disk.error ? ` (${summary.disk.error})` : ""}`
    : `${summary.disk.used_percent}% used, ${summary.disk.available_kb === null ? "n/a" : bytes(summary.disk.available_kb * 1024)} free`;
  const lastHour = summary.traffic.last_hour;
  const last24h = summary.traffic.last_24h;
  const snapshotHour = summary.snapshots.last_hour;
  const snapshot24h = summary.snapshots.last_24h;

  return [
    `${b("Octra Vitals digest")} ${c(alertLabel)}`,
    `${c(summary.generated_at)}`,
    "",
    `${b("Last hour")} ${c(periodRange(summary.periods.last_hour_start_at, summary.periods.last_hour_end_at))}`,
    `Snapshots: ${b(snapshotHour.confirmed_count)} confirmed, ${b(snapshotHour.failed_count)} failed, ${snapshotHour.run_count} runs`,
    `Web: ${b(lastHour.requests)} req, ${b(lastHour.unique_daily_hashes)} unique daily hashes`,
    `Home: ${lastHour.homepage_requests} req, ${lastHour.homepage_unique_daily_hashes} unique | API latest: ${lastHour.api_latest_requests}`,
    `Noise: ${lastHour.diagnostic_requests} diagnostic | top: ${topPaths(lastHour.top_diagnostic_paths)}`,
    `Raw evidence: +${summary.archive.raw_evidence_files_last_hour} files (${bytes(summary.archive.raw_evidence_bytes_last_hour)})`,
    "",
    `${b("24h topline")} ${c(periodRange(summary.periods.last_24h_start_at, summary.periods.last_24h_end_at))}`,
    `Snapshots: ${snapshot24h.confirmed_count} confirmed, ${snapshot24h.failed_count} failed, ${snapshot24h.run_count} runs`,
    `Web: ${last24h.requests} req, ${last24h.unique_daily_hashes} unique daily hashes`,
    `Home: ${last24h.homepage_requests} req, ${last24h.homepage_unique_daily_hashes} unique | API latest: ${last24h.api_latest_requests}`,
    `Noise: ${last24h.diagnostic_requests} diagnostic | top: ${topPaths(last24h.top_diagnostic_paths)}`,
    "",
    `${b("Latest")}`,
    `${c(summary.gateway.latest_snapshot_id || "n/a")} (#${h(summary.gateway.latest_snapshot_index || summary.snapshots.latest_snapshot_index || "n/a")})`,
    `Age: ${duration(summary.gateway.latest_age_ms)} | source=${h(summary.gateway.latest_source || "n/a")} | readback=${h(boolText(summary.gateway.readback_matches))}`,
    `Conservation: ${c(summary.gateway.conservation_status || "n/a")}${summary.gateway.conservation_flags.length ? ` | ${h(summary.gateway.conservation_flags.join(", "))}` : ""}`,
    `Tx: ${c(shortHash(summary.snapshots.latest_tx_hash))}`,
    "",
    `${b("System")}`,
    `Native: ${c(summary.gateway.native_status || "n/a")} | site integrity=${c(summary.gateway.site_integrity_status || boolText(summary.gateway.site_integrity_ok))}`,
    `Archive: ${summary.archive.raw_evidence_files} raw files (${bytes(summary.archive.raw_evidence_bytes)}), ${summary.archive.raw_evidence_files_24h} in 24h, 365d pace ${bytes(summary.archive.raw_evidence_projected_365d_bytes)}`,
    `Cadence: ${cadence} median | run: ${duration(summary.snapshots.median_total_ms)}`,
    `Disk: ${h(disk)}`,
    ...(alerts.length ? ["", `${b("Alerts")}`, ...alerts.map((alert) => `${c(alert.severity)} ${h(alert.message)}`)] : [])
  ].join("\n");
}

export function formatOperatorAlerts(summary: OperatorSummary, alerts: OperatorAlert[]): string {
  return [
    `${b("Octra Vitals alert")} ${c(`${alerts.length} active`)}`,
    `${c(summary.generated_at)}`,
    "",
    ...alerts.map((alert) => `${c(alert.severity)} ${h(alert.message)}`),
    "",
    `${b("Latest")}`,
    `${c(summary.gateway.latest_snapshot_id || "n/a")} (#${h(summary.gateway.latest_snapshot_index || summary.snapshots.latest_snapshot_index || "n/a")})`,
    `Age: ${duration(summary.gateway.latest_age_ms)} | source=${h(summary.gateway.latest_source || "n/a")} | readback=${h(boolText(summary.gateway.readback_matches))}`,
    `Conservation: ${c(summary.gateway.conservation_status || "n/a")}${summary.gateway.conservation_flags.length ? ` | ${h(summary.gateway.conservation_flags.join(", "))}` : ""}`,
    `Native: ${c(summary.gateway.native_status || "n/a")} | site integrity=${c(summary.gateway.site_integrity_status || boolText(summary.gateway.site_integrity_ok))}`
  ].join("\n");
}

async function collectOperatorSummary(): Promise<OperatorSummary> {
  const dataDir = resolve(process.env.VITALS_NOTIFY_DATA_DIR || process.env.VITALS_DATA_DIR || join(root, "data"));
  const gatewayUrl = process.env.VITALS_NOTIFY_GATEWAY_URL || "http://127.0.0.1:4173";
  const periods = completePeriods();
  const [gateway, snapshots, traffic, archive, disk] = await Promise.all([
    summarizeGateway(gatewayUrl),
    summarizeSnapshots(dataDir, periods),
    summarizeTraffic(dataDir, periods),
    summarizeArchive(dataDir, periods),
    summarizeDisk(dataDir)
  ]);
  return {
    generated_at: isoNow(),
    periods,
    gateway,
    snapshots,
    traffic,
    archive,
    disk
  };
}

function alertThresholds(): AlertThresholds {
  return {
    max_snapshot_age_ms: envNumber("VITALS_NOTIFY_ALERT_MAX_SNAPSHOT_AGE_MS", 45 * 60_000),
    disk_used_percent: envNumber("VITALS_NOTIFY_ALERT_DISK_PCT", 75),
    diagnostic_requests_current_hour: envNumber("VITALS_NOTIFY_ALERT_DIAGNOSTIC_REQUESTS_PER_HOUR", 300),
    raw_evidence_projected_disk_percent: envNumber("VITALS_NOTIFY_ALERT_RAW_EVIDENCE_365D_FREE_DISK_PCT", 60)
  };
}

async function sendTelegram(textBody: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), envNumber("VITALS_NOTIFY_TELEGRAM_TIMEOUT_MS", 10_000));
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: controller.signal,
    body: JSON.stringify({
      chat_id: chatId,
      text: textBody,
      parse_mode: "HTML",
      disable_web_page_preview: true
    })
  }).finally(() => clearTimeout(timeout));
  const body = await response.text();
  if (!response.ok) throw new Error(`telegram sendMessage returned ${response.status}: ${body.slice(0, 240)}`);
}

async function resolveChatId(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
  const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
  const body = await response.text();
  if (!response.ok) throw new Error(`telegram getUpdates returned ${response.status}: ${body.slice(0, 240)}`);
  const parsed = JSON.parse(body);
  const chats = new Map<string, string>();
  for (const update of Array.isArray(parsed?.result) ? parsed.result : []) {
    const chat = update?.message?.chat || update?.channel_post?.chat || update?.my_chat_member?.chat;
    if (!chat?.id) continue;
    const label = [chat.type, chat.username ? `@${chat.username}` : null, chat.title || chat.first_name || null].filter(Boolean).join(" ");
    chats.set(String(chat.id), label || "chat");
  }
  if (!chats.size) {
    console.log("No Telegram chats found. Send a message to the bot, then run this again.");
    return;
  }
  for (const [id, label] of chats) console.log(`${id}\t${label}`);
}

async function readAlertState(path: string): Promise<{ fingerprint: string | null; sent_at: string | null } | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function writeAlertState(path: string, fingerprint: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o750 });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify({
    schema: "octra-vitals-operator-alert-state-v0",
    fingerprint,
    sent_at: isoNow()
  }, null, 2)}\n`, { mode: 0o640 });
  await rename(tmp, path);
  await chmod(path, 0o640).catch(() => undefined);
}

function alertFingerprint(alerts: OperatorAlert[]): string {
  return alerts
    .map((alert) => `${alert.id}:${alert.severity}:${alert.message}`)
    .sort()
    .join("|");
}

async function pendingAlertFingerprint(alerts: OperatorAlert[], statePath: string, cooldownMs: number): Promise<string | null> {
  if (!alerts.length) return null;
  const fingerprint = alertFingerprint(alerts);
  const state = await readAlertState(statePath);
  const sentAt = state?.sent_at ? Date.parse(state.sent_at) : NaN;
  if (state?.fingerprint === fingerprint && Number.isFinite(sentAt) && Date.now() - sentAt < cooldownMs) return null;
  return fingerprint;
}

async function main(): Promise<void> {
  const mode =
    process.argv.includes("--test") ? "test" :
    process.argv.includes("--alerts") ? "alerts" :
    process.argv.includes("--resolve-chat-id") ? "resolve-chat-id" :
    "digest";
  const stdoutOnly = process.argv.includes("--stdout");
  if (mode === "resolve-chat-id") {
    await resolveChatId();
    return;
  }
  const summary = mode === "test" ? null : await collectOperatorSummary();
  const alerts = summary ? detectOperatorAlerts(summary, alertThresholds()) : [];
  const message =
    mode === "test" ? `Octra Vitals Telegram test - ${isoNow()}` :
    mode === "alerts" ? formatOperatorAlerts(summary as OperatorSummary, alerts) :
    formatOperatorDigest(summary as OperatorSummary, alerts);

  let alertFingerprintToPersist: string | null = null;
  if (mode === "alerts") {
    const dataDir = resolve(process.env.VITALS_NOTIFY_DATA_DIR || process.env.VITALS_DATA_DIR || join(root, "data"));
    const statePath = resolve(process.env.VITALS_NOTIFY_ALERT_STATE_PATH || join(dataDir, "notify", "alert-state.json"));
    const cooldownMs = envNumber("VITALS_NOTIFY_ALERT_COOLDOWN_MS", 30 * 60_000);
    alertFingerprintToPersist = await pendingAlertFingerprint(alerts, statePath, cooldownMs);
    if (!alertFingerprintToPersist) {
      if (stdoutOnly) console.log("no alert sent");
      return;
    }
  }

  if (stdoutOnly) {
    console.log(message);
    return;
  }
  await sendTelegram(message);
  if (mode === "alerts" && alertFingerprintToPersist) {
    const dataDir = resolve(process.env.VITALS_NOTIFY_DATA_DIR || process.env.VITALS_DATA_DIR || join(root, "data"));
    const statePath = resolve(process.env.VITALS_NOTIFY_ALERT_STATE_PATH || join(dataDir, "notify", "alert-state.json"));
    await writeAlertState(statePath, alertFingerprintToPersist);
  }
  console.log(mode === "test" ? "sent telegram test" : `sent telegram ${mode}`);
}

if (isDirectCli(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
