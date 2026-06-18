import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  decodeSummaryRow,
  encodeSummaryRow,
  parseSummaryWindow,
  rollSummaryWindow,
  summaryHash,
  summaryRowFromSnapshot,
  summaryWindowHash,
  SUMMARY_HASH_DOMAIN,
  SUMMARY_ROW_LEN,
  SUMMARY_ROW_VERSION,
  SUMMARY_WINDOW_HASH_DOMAIN,
  SUMMARY_WINDOW_ROWS,
  type SummaryRow
} from "../lib/summary-window.js";
import type { SnapshotArtifact } from "../lib/types.js";

function row(index: number, overrides: Partial<SummaryRow> = {}): SummaryRow {
  return {
    row_version: SUMMARY_ROW_VERSION,
    snapshot_index: index,
    observed_at_unix: 1780810346 + index,
    octra_epoch: 1042000 + index,
    external_block: 25266511 + index,
    issued_raw: "622215150306816",
    burned_raw: "377784849693184",
    encrypted_raw: "12413100000000",
    total_locked_raw: "190812959049874",
    total_wrapped_raw: "190314381881115",
    total_unclaimed_raw: "371566348509",
    route_count: 1,
    payload_hash_prefix: "0123456789abcdef01234567",
    ...overrides
  };
}

test("summary row fixed-width pack and unpack round trip", () => {
  const encoded = encodeSummaryRow(row(1, {
    issued_raw: "99999999999999999999",
    burned_raw: "99999999999999999999",
    encrypted_raw: "99999999999999999999",
    total_locked_raw: "99999999999999999999",
    total_wrapped_raw: "99999999999999999999",
    total_unclaimed_raw: "99999999999999999999",
    route_count: 9999
  }));

  assert.equal(encoded.length, SUMMARY_ROW_LEN);
  const decoded = decodeSummaryRow(encoded);
  assert.equal(decoded.snapshot_index, 1);
  assert.equal(decoded.total_wrapped_raw, "99999999999999999999");
  assert.equal(decoded.payload_hash_prefix, "0123456789abcdef01234567");
});

test("summary hashes use pinned domains", () => {
  const encoded = encodeSummaryRow(row(7));
  assert.equal(SUMMARY_HASH_DOMAIN, "octra-vitals:summary:v0");
  assert.equal(SUMMARY_WINDOW_HASH_DOMAIN, "octra-vitals:summary-window:v0");
  assert.match(summaryHash(encoded), /^sha256:[0-9a-f]{64}$/);
  assert.match(summaryWindowHash(encoded), /^sha256:[0-9a-f]{64}$/);
});

test("summary window rolls across the retention boundary", () => {
  let window = parseSummaryWindow("", 0, 0);
  for (let index = 1; index <= SUMMARY_WINDOW_ROWS + 1; index += 1) {
    window = rollSummaryWindow(
      window.window,
      window.row_count,
      window.first_index,
      index,
      encodeSummaryRow(row(index))
    );
  }

  assert.equal(window.row_count, SUMMARY_WINDOW_ROWS);
  assert.equal(window.first_index, 2);
  assert.equal(window.rows[0]?.snapshot_index, 2);
  assert.equal(window.rows[window.rows.length - 1]?.snapshot_index, SUMMARY_WINDOW_ROWS + 1);
  assert.equal(parseSummaryWindow(window.window, window.first_index, window.row_count, window.window_hash).rows.length, SUMMARY_WINDOW_ROWS);
});

test("summary window rejects malformed numeric fields", () => {
  const encoded = encodeSummaryRow(row(1));
  const malformed = `${encoded.slice(0, 3)}x${encoded.slice(4)}`;
  assert.throws(() => decodeSummaryRow(malformed), /snapshot_index must be unsigned decimal digits/);
});

test("summary window rejects sequence drift", () => {
  const window = encodeSummaryRow(row(1)) + encodeSummaryRow(row(3));
  assert.throws(() => parseSummaryWindow(window, 1, 2, summaryWindowHash(window)), /summary row index drift/);
});

test("summary row v0 rejects multiple top-level routes", async () => {
  const snapshot = JSON.parse(await readFile("app/latest_snapshot.sample.json", "utf8")) as SnapshotArtifact;
  const route = snapshot.envelope.payload.routes?.[0];
  if (!route) throw new Error("sample snapshot is missing its bridge route");
  snapshot.envelope.payload.routes = [route, { ...route, route_id: `${route.route_id}:copy` }];

  assert.throws(
    () => summaryRowFromSnapshot(snapshot, 1),
    /requires exactly one OCT-denominated route/
  );
});
