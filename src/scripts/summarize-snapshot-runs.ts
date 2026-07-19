#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(new URL("../..", import.meta.url).pathname);

interface SnapshotRunRow {
  generated_at: string;
  started_at: string | null;
  run_id: string;
  status: string;
  operator_address: string | null;
  snapshot_id: string | null;
  snapshot_index: string | null;
  tx_hash: string | null;
  ou: string | null;
  total_ms: number | null;
  collect_ms: number | null;
  submit_ms: number | null;
  record_call_ms: number | null;
  retention_ms: number | null;
  collect_attempts: number;
  failed_collect_attempts: number;
  readback_matches: boolean | null;
  target_kind: string | null;
  commit_mode: string | null;
  error: string | null;
}

interface SnapshotRunSummary {
  schema: "octra-vitals-snapshot-runs-summary-v0";
  generated_at: string;
  data_dir: string;
  runs_dir: string;
  run_count: number;
  status_counts: Record<string, number>;
  latest: SnapshotRunRow | null;
  cadence_minutes: {
    min: number | null;
    median: number | null;
    max: number | null;
  };
  timings_ms: {
    total: TimingSummary;
    collect: TimingSummary;
    submit: TimingSummary;
  };
  rows: SnapshotRunRow[];
}

interface TimingSummary {
  min: number | null;
  median: number | null;
  max: number | null;
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

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1] || null;
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function boolValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function ouValue(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? trimmed : null;
}

function reportOu(report: any): string | null {
  return ouValue(report?.ou) ||
    ouValue(report?.submit_result?.ou_cost) ||
    ouValue(report?.confirmations?.[0]?.transaction?.ou) ||
    ouValue(report?.submissions?.[0]?.submit_result?.ou_cost) ||
    null;
}

function runRow(report: any): SnapshotRunRow {
  const attempts: Array<Record<string, unknown>> = Array.isArray(report?.collect_attempts) ? report.collect_attempts : [];
  return {
    generated_at: textValue(report?.generated_at) || "",
    started_at: textValue(report?.started_at),
    run_id: textValue(report?.run_id) || "",
    status: textValue(report?.status) || "unknown",
    operator_address: textValue(report?.operator_address),
    snapshot_id: textValue(report?.snapshot_id),
    snapshot_index: report?.snapshot_index === undefined || report?.snapshot_index === null ? null : String(report.snapshot_index),
    tx_hash: textValue(report?.tx_hash),
    ou: reportOu(report),
    total_ms: numberValue(report?.timings_ms?.total_ms),
    collect_ms: numberValue(report?.timings_ms?.collect_ms),
    submit_ms: numberValue(report?.timings_ms?.submit_ms),
    record_call_ms: numberValue(report?.timings_ms?.record_call_ms),
    retention_ms: numberValue(report?.timings_ms?.retention_ms),
    collect_attempts: attempts.length,
    failed_collect_attempts: attempts.filter((attempt: Record<string, unknown>) => attempt.status === "failed").length,
    readback_matches: boolValue(report?.readback?.matches_expected),
    target_kind: textValue(report?.target_kind),
    commit_mode: textValue(report?.commit_mode),
    error: textValue(report?.error)
  };
}

function timingSummary(values: Array<number | null>): TimingSummary {
  const numbers = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (!numbers.length) return { min: null, median: null, max: null };
  return {
    min: numbers[0] ?? null,
    median: numbers[Math.floor((numbers.length - 1) / 2)] ?? null,
    max: numbers[numbers.length - 1] ?? null
  };
}

function minutesBetween(a: string, b: string): number | null {
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return Math.round((right - left) / 60_000);
}

export async function readSnapshotRunRows(dataDir: string): Promise<SnapshotRunRow[]> {
  const runsDir = join(dataDir, "runs");
  const dirs = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const rows: SnapshotRunRow[] = [];
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const reportPath = join(runsDir, entry.name, "snapshot_update_report.json");
    try {
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      rows.push(runRow(report));
    } catch {
      // Ignore partially written or pruned run directories.
    }
  }
  return rows.sort((a, b) => a.generated_at.localeCompare(b.generated_at));
}

export function summarizeSnapshotRunRows(dataDir: string, rows: SnapshotRunRow[]): SnapshotRunSummary {
  const statusCounts: Record<string, number> = {};
  for (const row of rows) statusCounts[row.status] = (statusCounts[row.status] || 0) + 1;

  const cadence = rows
    .slice(1)
    .map((row, index) => minutesBetween(rows[index]?.generated_at || "", row.generated_at))
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  const cadenceSummary = cadence.length
    ? {
        min: cadence[0] ?? null,
        median: cadence[Math.floor((cadence.length - 1) / 2)] ?? null,
        max: cadence[cadence.length - 1] ?? null
      }
    : { min: null, median: null, max: null };

  return {
    schema: "octra-vitals-snapshot-runs-summary-v0",
    generated_at: isoNow(),
    data_dir: dataDir,
    runs_dir: join(dataDir, "runs"),
    run_count: rows.length,
    status_counts: statusCounts,
    latest: rows[rows.length - 1] || null,
    cadence_minutes: cadenceSummary,
    timings_ms: {
      total: timingSummary(rows.map((row) => row.total_ms)),
      collect: timingSummary(rows.map((row) => row.collect_ms)),
      submit: timingSummary(rows.map((row) => row.submit_ms))
    },
    rows
  };
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

async function main(): Promise<void> {
  const dataDir = resolve(argValue("--data-dir") || process.env.VITALS_DATA_DIR || "data");
  const limit = Math.max(0, Number(argValue("--limit") || 0));
  const csv = process.argv.includes("--csv");
  const allRows = await readSnapshotRunRows(dataDir);
  const rows = limit > 0 ? allRows.slice(-limit) : allRows;
  const summary = summarizeSnapshotRunRows(dataDir, rows);

  if (csv) {
    const columns = [
      "generated_at",
      "started_at",
      "run_id",
      "status",
      "operator_address",
      "snapshot_id",
      "snapshot_index",
      "tx_hash",
      "ou",
      "total_ms",
      "collect_ms",
      "submit_ms",
      "record_call_ms",
      "retention_ms",
      "collect_attempts",
      "failed_collect_attempts",
      "readback_matches",
      "target_kind",
      "commit_mode",
      "error"
    ];
    console.log(columns.join(","));
    for (const row of summary.rows) {
      console.log(columns.map((column) => csvEscape((row as any)[column])).join(","));
    }
    return;
  }

  console.log(JSON.stringify(summary, null, 2));
}

if (isDirectCli(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
