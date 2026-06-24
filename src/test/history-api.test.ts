import assert from "node:assert/strict";
import test from "node:test";

import {
  emptyHistoryProof,
  filterHistorySnapshots,
  historyApiCoverage,
  parseHistoryApiRequest,
  verifiedHistoryProof,
  type NormalizedHistorySnapshot
} from "../lib/history-api.js";

function snapshots(count: number): NormalizedHistorySnapshot[] {
  const start = Date.parse("2026-06-01T00:00:00Z");
  return Array.from({ length: count }, (_, index) => ({
    snapshot_index: index + 1,
    snapshot_id: `vitals.${new Date(start + index * 15 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")}`,
    observed_at: new Date(start + index * 15 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    supply: {
      issued_oct_raw: "1",
      burned_oct_raw: "1",
      encrypted_oct_raw: "0"
    },
    bridge: {
      total_locked_oct_raw: "1",
      woct_supply_raw: "1",
      unclaimed_oct_raw: "0"
    }
  }));
}

test("history API parser accepts known windows and range fields", () => {
  const request = parseHistoryApiRequest(new URLSearchParams("window=7d&from_index=2&to_index=10&from=2026-06-01T00:00:00Z"));

  assert.equal(request.window, "7d");
  assert.equal(request.from_index, 2);
  assert.equal(request.to_index, 10);
  assert.equal(request.from, "2026-06-01T00:00:00Z");
  assert.equal(request.to, null);
});

test("history API parser ignores malformed bounds instead of throwing", () => {
  const request = parseHistoryApiRequest(new URLSearchParams("window=all&from_index=-1&to=lol"));

  assert.equal(request.window, null);
  assert.equal(request.from_index, null);
  assert.equal(request.to, null);
  assert.equal(request.valid, false);
  assert.deepEqual(request.errors, ["invalid_window", "invalid_from_index", "invalid_to"]);
});

test("history API window filtering keeps normalized snapshots intact", () => {
  const rows = snapshots(9 * 24 * 4);
  const request = parseHistoryApiRequest(new URLSearchParams("window=7d"));
  const filtered = filterHistorySnapshots(rows, request);
  const coverage = historyApiCoverage(rows, filtered, request);

  assert.equal(filtered[0]?.snapshot_index, 192);
  assert.equal(filtered[filtered.length - 1]?.snapshot_index, rows.length);
  assert.equal(coverage.status, "complete");
  assert.equal(coverage.requested_window, "7d");
  assert.equal(coverage.points, 7 * 24 * 4 + 1);
});

test("history API marks coverage partial when available rows are shorter than requested window", () => {
  const rows = snapshots(12);
  const request = parseHistoryApiRequest(new URLSearchParams("window=1d"));
  const filtered = filterHistorySnapshots(rows, request);
  const coverage = historyApiCoverage(rows, filtered, request);

  assert.equal(filtered.length, 12);
  assert.equal(coverage.status, "partial");
  assert.match(coverage.note || "", /shorter than the requested window/);
});

test("history API index ranges are inclusive", () => {
  const rows = snapshots(10);
  const request = parseHistoryApiRequest(new URLSearchParams("from_index=3&to_index=5"));
  const filtered = filterHistorySnapshots(rows, request);
  const coverage = historyApiCoverage(rows, filtered, request);

  assert.deepEqual(filtered.map((row) => row.snapshot_index), [3, 4, 5]);
  assert.equal(coverage.first_index, 3);
  assert.equal(coverage.latest_index, 5);
});

test("history API invalid ranges do not return a broad history response", () => {
  const rows = snapshots(10);
  const request = parseHistoryApiRequest(new URLSearchParams("from_index=8&to_index=3"));
  const filtered = filterHistorySnapshots(rows, request);
  const coverage = historyApiCoverage(rows, filtered, request);

  assert.deepEqual(filtered, []);
  assert.equal(coverage.status, "invalid_request");
  assert.match(coverage.note || "", /from_index_after_to_index/);
});

test("empty history proof does not overclaim fact-family verification", () => {
  assert.equal(emptyHistoryProof("aml_summary_window", true).proof_status, "summary_window_verified");
  assert.equal(emptyHistoryProof("aml_fact_family_core_capsules", true).proof_status, "summary_window_verified");
  assert.equal(emptyHistoryProof("aml_fact_family_core_capsules_verified", true).proof_status, "fact_family_verified");
  assert.equal(emptyHistoryProof("unavailable", false).proof_status, "unavailable");
});

test("verified history proof carries era boundary evidence", () => {
  const proof = verifiedHistoryProof("aml_multi_era_fact_family_core_capsules_verified", true, [
    { era_id: "old", latest_index: 23 },
    { era_id: "new", predecessor_final_index: 23, boundary_verified: true }
  ]);

  assert.equal(proof.proof_status, "fact_family_verified");
  assert.equal(proof.eras.length, 2);
  assert.deepEqual(proof.eras[1], { era_id: "new", predecessor_final_index: 23, boundary_verified: true });
});
