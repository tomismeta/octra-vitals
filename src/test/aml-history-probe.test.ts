import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProbeEstimates,
  CALENDAR_STAT_NODE_LEN,
  CAPSULE_META_LEN,
  calendarStatNodeHashHex,
  capsuleIdForUnix,
  decodeCapsuleMeta,
  decodeHistoryRow,
  encodeCalendarStatNode,
  emptyHistoryRootHex,
  encodeHistoryRow,
  HISTORY_ROW_LEN,
  makeCapsule,
  makeTxIndex,
  syntheticCalendarStatNode,
  syntheticHistoryRow,
  syntheticTxHash
} from "../lib/aml-history-probe.js";

test("history observation row is fixed-width and round trips conservation inputs", () => {
  const encoded = encodeHistoryRow(syntheticHistoryRow(7, {
    max_supply_raw: "1000000000000000",
    vault_balance_raw: "201384879191180",
    unit_status: "00",
    conservation_status: "G"
  }));

  assert.equal(encoded.length, HISTORY_ROW_LEN);
  const decoded = decodeHistoryRow(encoded);
  assert.equal(decoded.snapshot_index, 7);
  assert.equal(decoded.max_supply_raw, "1000000000000000");
  assert.equal(decoded.vault_balance_raw, "201384879191180");
  assert.equal(decoded.unit_status, "00");
  assert.equal(decoded.conservation_status, "G");
});

test("history row requires a full payload hash commitment", () => {
  assert.throws(
    () => encodeHistoryRow(syntheticHistoryRow(1, { payload_hash_hex: "0123456789abcdef01234567" })),
    /payload_hash_hex must be 64 hex chars/
  );
});

test("capsule ids use deterministic 12h UTC halves", () => {
  assert.equal(capsuleIdForUnix(Date.UTC(2026, 5, 22, 0, 15, 0) / 1000), "2026-06-22T00");
  assert.equal(capsuleIdForUnix(Date.UTC(2026, 5, 22, 12, 0, 0) / 1000), "2026-06-22T12");
  assert.equal(capsuleIdForUnix(Date.UTC(2026, 5, 22, 23, 59, 59) / 1000), "2026-06-22T12");
});

test("capsule metadata is fixed-width and commits to body roots", () => {
  const rows = [syntheticHistoryRow(1), syntheticHistoryRow(2), syntheticHistoryRow(3)];
  const capsule = makeCapsule(rows);

  assert.equal(capsule.body.length, rows.length * HISTORY_ROW_LEN);
  assert.equal(capsule.meta_row.length, CAPSULE_META_LEN);
  assert.equal(capsule.meta.start_root_hex, emptyHistoryRootHex());
  assert.match(capsule.body_hash_hex, /^[0-9a-f]{64}$/);
  assert.match(capsule.meta.end_root_hex, /^[0-9a-f]{64}$/);

  const decodedMeta = decodeCapsuleMeta(capsule.meta_row);
  assert.equal(decodedMeta.row_count, 3);
  assert.equal(decodedMeta.first_index, 1);
  assert.equal(decodedMeta.last_index, 3);
  assert.equal(decodedMeta.body_hash_hex, capsule.body_hash_hex);
});

test("transaction lookup index is aligned and optional", () => {
  const rows = [syntheticHistoryRow(1), syntheticHistoryRow(2)];
  const txIndex = makeTxIndex(rows.map((row) => syntheticTxHash(row.snapshot_index)));
  const capsule = makeCapsule(rows, { txIndex });

  assert.equal(txIndex.length, 2 * 64);
  assert.notEqual(capsule.meta.tx_index_hash_hex, "0".repeat(64));
});

test("calendar stat node is fixed-width and hashable", () => {
  const first = syntheticHistoryRow(1);
  const last = syntheticHistoryRow(48, {
    issued_raw: "622000000047000",
    total_locked_raw: "200000000047000",
    total_wrapped_raw: "190000000047000",
    total_unclaimed_raw: "10000000047000"
  });
  const node = syntheticCalendarStatNode("D", "2026-06-07", first, last, {
    endRootHex: "1".repeat(64),
    count: 48,
    sourceChildCount: 2
  });
  const encoded = encodeCalendarStatNode(node);

  assert.equal(encoded.length, CALENDAR_STAT_NODE_LEN);
  assert.match(calendarStatNodeHashHex(encoded), /^[0-9a-f]{64}$/);
});

test("probe estimates bracket below and above the current 48-row window", () => {
  const estimates = buildProbeEstimates();
  assert.deepEqual(estimates.map((estimate) => estimate.row_count), [12, 24, 48, 96, 192, 384]);
  const estimate48 = estimates.find((estimate) => estimate.row_count === 48);
  assert.ok(estimate48);
  assert.equal(estimate48.body_bytes, 48 * HISTORY_ROW_LEN);
  assert.equal(estimate48.tx_index_bytes, 48 * 64);
  assert.equal(estimate48.estimated_calendar_stat_bytes, CALENDAR_STAT_NODE_LEN * 4);
  assert.ok(estimate48.estimated_append_rewrite_bytes_with_calendar > estimate48.estimated_append_rewrite_bytes_without_calendar);
});
