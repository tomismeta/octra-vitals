#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { TRAFFIC_SCHEMA_VERSION, type TrafficHourFile, type TrafficMetric } from "../lib/traffic.js";

const dataDir = resolve(process.env.VITALS_DATA_DIR || "data");
const trafficDir = resolve(process.env.VITALS_NOTIFY_TRAFFIC_DIR || process.env.VITALS_TRAFFIC_DIR || join(dataDir, "traffic"));
const csv = process.argv.includes("--csv");
const diagnosticPaths = process.argv.includes("--diagnostic-paths");

interface RouteSummary {
  hour: string;
  route: string;
  requests: number;
  unique_clients: number;
  bytes: number;
  avg_duration_ms: number;
  statuses: Record<string, number>;
  methods: Record<string, number>;
  latency_ms: Record<string, number>;
  client_sources: Record<string, number>;
}

interface DiagnosticPathSummary {
  hour: string;
  path: string;
  requests: number;
  unique_clients: number;
  avg_duration_ms: number;
  statuses: Record<string, number>;
  methods: Record<string, number>;
  client_sources: Record<string, number>;
}

function uniqueClients(metric: TrafficMetric): number {
  return Object.keys(metric.clients || {}).length;
}

function avgDuration(metric: TrafficMetric): number {
  if (!metric.requests) return 0;
  return Math.round(metric.duration_ms / metric.requests);
}

function routeSummary(hour: string, route: string, metric: TrafficMetric): RouteSummary {
  return {
    hour,
    route,
    requests: metric.requests,
    unique_clients: uniqueClients(metric),
    bytes: metric.bytes,
    avg_duration_ms: avgDuration(metric),
    statuses: metric.statuses,
    methods: metric.methods,
    latency_ms: metric.latency_ms,
    client_sources: metric.client_sources
  };
}

function diagnosticPathSummary(hour: string, path: string, metric: TrafficMetric): DiagnosticPathSummary {
  return {
    hour,
    path,
    requests: metric.requests,
    unique_clients: uniqueClients(metric),
    avg_duration_ms: avgDuration(metric),
    statuses: metric.statuses,
    methods: metric.methods,
    client_sources: metric.client_sources
  };
}

function csvEscape(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

const files = (await readdir(trafficDir).catch(() => []))
  .filter((file) => /^\d{4}-\d{2}-\d{2}T\d{2}\.json$/.test(file))
  .sort();

const hours: TrafficHourFile[] = [];
for (const file of files) {
  const parsed = JSON.parse(await readFile(join(trafficDir, file), "utf8")) as TrafficHourFile;
  if (parsed.schema === TRAFFIC_SCHEMA_VERSION) hours.push(parsed);
}

const rows: RouteSummary[] = [];
const diagnosticRows: DiagnosticPathSummary[] = [];
for (const hour of hours) {
  rows.push(routeSummary(hour.hour, "_total", hour.totals));
  for (const [route, metric] of Object.entries(hour.routes).sort(([a], [b]) => a.localeCompare(b))) {
    rows.push(routeSummary(hour.hour, route, metric));
  }
  for (const [path, metric] of Object.entries(hour.diagnostic_paths || {}).sort(([a], [b]) => a.localeCompare(b))) {
    diagnosticRows.push(diagnosticPathSummary(hour.hour, path, metric));
  }
  if (hour.diagnostic_path_overflow) {
    diagnosticRows.push(diagnosticPathSummary(hour.hour, "__overflow__", hour.diagnostic_path_overflow));
  }
}

if (csv) {
  const columns = diagnosticPaths
    ? [
        "hour",
        "path",
        "requests",
        "unique_clients",
        "avg_duration_ms",
        "statuses",
        "methods",
        "client_sources"
      ]
    : [
        "hour",
        "route",
        "requests",
        "unique_clients",
        "bytes",
        "avg_duration_ms",
        "statuses",
        "methods",
        "latency_ms",
        "client_sources"
      ];
  console.log(columns.join(","));
  for (const row of diagnosticPaths ? diagnosticRows : rows) {
    console.log(columns.map((column) => csvEscape((row as any)[column])).join(","));
  }
} else {
  console.log(JSON.stringify({
    schema: "octra-vitals-traffic-summary-v0",
    generated_at: new Date().toISOString(),
    traffic_dir: trafficDir,
    hours: hours.length,
    rows,
    diagnostic_paths: diagnosticRows
  }, null, 2));
}
