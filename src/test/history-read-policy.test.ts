import assert from "node:assert/strict";
import test from "node:test";

import { HistoryTailAnchorError } from "../lib/canonical-history.js";
import { sqliteHistoryFallbackDecision } from "../lib/history-read-policy.js";

test("SQLite history falls back to AML only when the mirror is unavailable", () => {
  assert.deepEqual(sqliteHistoryFallbackDecision(new Error("sqlite_history_replica_unavailable")).allowed, true);
  assert.deepEqual(sqliteHistoryFallbackDecision(new Error("HTTP 429 Too Many Requests")).allowed, true);
  assert.deepEqual(sqliteHistoryFallbackDecision(new Error("octra_sqlite_failed: ETIMEDOUT")).allowed, true);
  assert.deepEqual(sqliteHistoryFallbackDecision(new Error("octra_circleViewAuth failed: wasm export trapped: all fuel consumed")).allowed, true);
});

test("SQLite history does not fall back when the mirror is reachable but untrusted", () => {
  assert.deepEqual(sqliteHistoryFallbackDecision(new HistoryTailAnchorError(
    "history_tail_summary_mismatch",
    "canonical history tail does not match remembered latest summary row"
  )).allowed, false);
  assert.deepEqual(sqliteHistoryFallbackDecision(new Error("sqlite_history_gap: expected 48 rows, got 47")).allowed, false);
  assert.deepEqual(sqliteHistoryFallbackDecision(new Error("sqlite_history_incomplete: complete through 100, latest mirrored row 101")).allowed, false);
  assert.deepEqual(sqliteHistoryFallbackDecision(new Error("octra_sqlite_not_ok: {\"error\":\"too_many_rows\"}")).allowed, false);
});
