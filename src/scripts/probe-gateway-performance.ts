#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

interface ProbeResult {
  label: string;
  path: string;
  ok: boolean;
  status: number | null;
  elapsed_ms: number;
  body_bytes: number;
  content_type: string | null;
  content_encoding: string | null;
  error: string | null;
}

interface ProbeReport {
  schema: "octra-vitals-gateway-performance-probe-v0";
  generated_at: string;
  base_url: string;
  timeout_ms: number;
  probes: ProbeResult[];
}

function isDirectCli(metaUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(resolve(argvPath));
  } catch {
    return fileURLToPath(metaUrl) === resolve(argvPath);
  }
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
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function requestUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

async function probe(baseUrl: string, label: string, path: string, timeoutMs: number): Promise<ProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(requestUrl(baseUrl, path), {
      headers: {
        Accept: "application/json,text/plain,*/*",
        "Accept-Encoding": "gzip,br",
        "User-Agent": "octra-vitals-performance-probe/v0"
      },
      signal: controller.signal
    });
    const body = await response.arrayBuffer();
    return {
      label,
      path,
      ok: response.ok,
      status: response.status,
      elapsed_ms: Math.round(performance.now() - started),
      body_bytes: body.byteLength,
      content_type: response.headers.get("content-type"),
      content_encoding: response.headers.get("content-encoding"),
      error: response.ok ? null : new TextDecoder().decode(body).slice(0, 240)
    };
  } catch (error) {
    return {
      label,
      path,
      ok: false,
      status: null,
      elapsed_ms: Math.round(performance.now() - started),
      body_bytes: 0,
      content_type: null,
      content_encoding: null,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function probePaths(): Array<{ label: string; path: string }> {
  const windows = (argValue("--windows") || process.env.VITALS_PERF_PROBE_HISTORY_WINDOWS || "1h,1d,7d,30d")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return [
    { label: "health", path: "/health" },
    { label: "latest", path: "/api/latest?compact=1" },
    ...windows.map((window) => ({
      label: `history_${window}`,
      path: `/api/history?window=${encodeURIComponent(window)}&compact=1`
    })),
    { label: "performance", path: "/api/performance?compact=1" }
  ];
}

async function main(): Promise<void> {
  const baseUrl = argValue("--url") || process.env.VITALS_PERF_PROBE_URL || "http://127.0.0.1:4173";
  const outPath = argValue("--out") || process.env.VITALS_PERF_PROBE_OUT || null;
  const timeoutMs = envNumber("VITALS_PERF_PROBE_TIMEOUT_MS", 60_000);
  const probes: ProbeResult[] = [];

  for (const { label, path } of probePaths()) {
    probes.push(await probe(baseUrl, label, path, timeoutMs));
  }

  const report: ProbeReport = {
    schema: "octra-vitals-gateway-performance-probe-v0",
    generated_at: isoNow(),
    base_url: baseUrl,
    timeout_ms: timeoutMs,
    probes
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (outPath) {
    await mkdir(dirname(resolve(outPath)), { recursive: true });
    await writeFile(resolve(outPath), text);
  }
  process.stdout.write(text);
  if (probes.some((result) => !result.ok)) process.exitCode = 1;
}

if (isDirectCli(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
