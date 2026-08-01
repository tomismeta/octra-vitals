import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { loadHistorySummaryAnchors, rememberHistorySummaryAnchor, writeHistorySummaryAnchors } from "../lib/history-summary-anchors.js";
import { encodeSummaryRow, type SummaryRow } from "../lib/summary-window.js";

function summaryRow(index: number): SummaryRow {
  return {
    row_version: "00",
    snapshot_index: index,
    observed_at_unix: 1_800_000_000 + index,
    octra_epoch: 1_000 + index,
    external_block: 25_000_000 + index,
    issued_raw: "623000000000000",
    burned_raw: "377000000000000",
    encrypted_raw: "12413100000000",
    total_locked_raw: "201000000000000",
    total_wrapped_raw: "190000000000000",
    total_unclaimed_raw: "10000000000000",
    route_count: 1,
    payload_hash_prefix: String(index).padStart(24, "a").slice(-24)
  };
}

test("history summary anchors persist only the most recent public summary rows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vitals-anchors-"));
  try {
    const path = join(dir, "anchors.json");
    const anchors = new Map();
    for (let index = 1; index <= 10; index += 1) {
      assert.equal(rememberHistorySummaryAnchor(anchors, {
        snapshot_index: index,
        latest_summary: encodeSummaryRow(summaryRow(index))
      }, 8, 1234 + index), true);
    }

    await writeHistorySummaryAnchors(path, anchors);
    const loaded = await loadHistorySummaryAnchors(path, 8);

    assert.deepEqual([...loaded.keys()], [3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(loaded.get(10)?.observed_at_unix, 1_800_000_010);
    assert.equal(loaded.get(10)?.checked_at_ms, 1244);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
