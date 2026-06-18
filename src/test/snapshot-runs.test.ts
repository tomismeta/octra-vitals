import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readSnapshotRunRows, summarizeSnapshotRunRows } from "../scripts/summarize-snapshot-runs.js";

async function writeReport(dataDir: string, runId: string, report: Record<string, unknown>): Promise<void> {
  const dir = join(dataDir, "runs", runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "snapshot_update_report.json"), `${JSON.stringify({ run_id: runId, ...report }, null, 2)}\n`);
}

test("snapshot run summary reports cadence, status counts, and timings", async () => {
  const dataDir = await mkdtempCompat();
  try {
    await writeReport(dataDir, "snapshot-a", {
      status: "confirmed",
      started_at: "2026-06-16T18:00:00Z",
      generated_at: "2026-06-16T18:00:10Z",
      snapshot_id: "vitals.2026-06-16T18:00:00Z",
      snapshot_index: "1",
      tx_hash: "abc",
      target_kind: "circle_program",
      commit_mode: "submit",
      collect_attempts: [{ status: "ok" }],
      readback: { matches_expected: true },
      timings_ms: { total_ms: 10000, collect_ms: 1000, submit_ms: 8000, record_call_ms: 100, retention_ms: 10 }
    });
    await writeReport(dataDir, "snapshot-b", {
      status: "failed",
      started_at: "2026-06-16T18:16:00Z",
      generated_at: "2026-06-16T18:16:10Z",
      collect_attempts: [{ status: "failed" }, { status: "failed" }],
      timings_ms: { total_ms: 2000, collect_ms: 1900 },
      error: "source fetch failed"
    });

    const rows = await readSnapshotRunRows(dataDir);
    const summary = summarizeSnapshotRunRows(dataDir, rows);

    assert.equal(summary.run_count, 2);
    assert.deepEqual(summary.status_counts, { confirmed: 1, failed: 1 });
    assert.equal(summary.cadence_minutes.min, 16);
    assert.equal(summary.timings_ms.total.max, 10000);
    assert.equal(summary.latest?.run_id, "snapshot-b");
    assert.equal(summary.latest?.failed_collect_attempts, 2);
    assert.equal(summary.rows[0]?.readback_matches, true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

async function mkdtempCompat(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), "octra-vitals-runs-"));
}
