import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { decodeSummaryRow } from "./summary-window.js";
import type { HistorySummaryAnchor } from "./canonical-history.js";

const SCHEMA = "octra-vitals:history-summary-anchors:v0";

interface AnchorFile {
  schema?: unknown;
  updated_at?: unknown;
  entries?: unknown;
}

interface AnchorFileEntry {
  snapshot_index?: unknown;
  latest_summary?: unknown;
  observed_at_unix?: unknown;
  checked_at_ms?: unknown;
}

export function rememberHistorySummaryAnchor(
  anchors: Map<number, HistorySummaryAnchor>,
  snapshot: unknown,
  limit = 8,
  nowMs = Date.now()
): boolean {
  const record = snapshot as Record<string, unknown> | null | undefined;
  const index = Number(record?.snapshot_index || 0);
  const latestSummary = record?.latest_summary;
  if (!Number.isSafeInteger(index) || index <= 0 || typeof latestSummary !== "string" || !latestSummary) {
    return false;
  }
  let observedAtUnix: number | null = null;
  try {
    observedAtUnix = decodeSummaryRow(latestSummary).observed_at_unix;
  } catch {
    observedAtUnix = null;
  }
  anchors.set(index, {
    latest_summary: latestSummary,
    observed_at_unix: observedAtUnix,
    checked_at_ms: nowMs
  });
  trimHistorySummaryAnchors(anchors, limit);
  return true;
}

export async function loadHistorySummaryAnchors(path: string, limit = 8): Promise<Map<number, HistorySummaryAnchor>> {
  let parsed: AnchorFile;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as AnchorFile;
  } catch {
    return new Map();
  }
  if (parsed.schema !== SCHEMA || !Array.isArray(parsed.entries)) return new Map();
  const anchors = new Map<number, HistorySummaryAnchor>();
  for (const raw of parsed.entries) {
    const entry = raw as AnchorFileEntry;
    const index = Number(entry.snapshot_index || 0);
    const latestSummary = entry.latest_summary;
    if (!Number.isSafeInteger(index) || index <= 0 || typeof latestSummary !== "string" || !latestSummary) continue;
    const observedAtUnix = typeof entry.observed_at_unix === "number" && Number.isFinite(entry.observed_at_unix)
      ? entry.observed_at_unix
      : null;
    const checkedAtMs = typeof entry.checked_at_ms === "number" && Number.isFinite(entry.checked_at_ms)
      ? entry.checked_at_ms
      : null;
    anchors.set(index, {
      latest_summary: latestSummary,
      observed_at_unix: observedAtUnix,
      checked_at_ms: checkedAtMs
    });
  }
  trimHistorySummaryAnchors(anchors, limit);
  return anchors;
}

export async function writeHistorySummaryAnchors(path: string, anchors: ReadonlyMap<number, HistorySummaryAnchor>): Promise<void> {
  const entries = [...anchors.entries()]
    .sort(([a], [b]) => a - b)
    .map(([snapshot_index, anchor]) => ({
      snapshot_index,
      latest_summary: anchor.latest_summary,
      observed_at_unix: anchor.observed_at_unix,
      checked_at_ms: anchor.checked_at_ms ?? null
    }));
  const payload = {
    schema: SCHEMA,
    updated_at: new Date().toISOString(),
    entries
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o750 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o640 });
  await rename(tmp, path);
}

export function mergeHistorySummaryAnchors(
  target: Map<number, HistorySummaryAnchor>,
  loaded: ReadonlyMap<number, HistorySummaryAnchor>,
  limit = 8
): void {
  for (const [index, anchor] of loaded.entries()) {
    if (!target.has(index)) target.set(index, anchor);
  }
  trimHistorySummaryAnchors(target, limit);
}

function trimHistorySummaryAnchors(anchors: Map<number, HistorySummaryAnchor>, limit: number): void {
  const safeLimit = Math.max(1, Math.trunc(limit));
  const ordered = [...anchors.entries()].sort(([a], [b]) => a - b);
  anchors.clear();
  for (const [index, anchor] of ordered.slice(-safeLimit)) {
    anchors.set(index, anchor);
  }
}
