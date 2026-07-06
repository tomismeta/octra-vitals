import assert from "node:assert/strict";
import test from "node:test";

import { type HistorySummaryAnchor } from "../lib/canonical-history.js";
import { readSqliteHistoryReplica } from "../lib/sqlite-history-replica.js";
import { encodeSummaryRow, type SummaryRow } from "../lib/summary-window.js";
import type { OctraSqliteResult } from "../lib/octra-sqlite-client.js";
import type { SnapshotArtifact } from "../lib/types.js";

function row(index: number): SummaryRow {
  return {
    row_version: "00",
    snapshot_index: index,
    observed_at_unix: 1_800_000_000 + (index * 900),
    octra_epoch: 1_000 + index,
    external_block: 25_000_000 + index,
    issued_raw: String(623_000_000_000_000n + BigInt(index)),
    burned_raw: String(377_000_000_000_000n - BigInt(index)),
    encrypted_raw: "12413100000000",
    total_locked_raw: String(201_000_000_000_000n + BigInt(index)),
    total_wrapped_raw: String(190_000_000_000_000n + BigInt(index)),
    total_unclaimed_raw: String(10_000_000_000_000n + BigInt(index)),
    route_count: 1,
    payload_hash_prefix: String(index).padStart(24, "a").slice(-24)
  };
}

function sqliteResult(columns: string[], rows: unknown[][]): OctraSqliteResult {
  return {
    columns,
    rows,
    row_count: rows.length,
    ok: true
  };
}

function latestFor(rowValue: SummaryRow): SnapshotArtifact {
  return {
    snapshot_index: rowValue.snapshot_index,
    latest_summary: encodeSummaryRow(rowValue)
  } as unknown as SnapshotArtifact;
}

function remembered(rowValue: SummaryRow): Map<number, HistorySummaryAnchor> {
  return new Map([
    [
      rowValue.snapshot_index,
      {
        latest_summary: encodeSummaryRow(rowValue),
        observed_at_unix: rowValue.observed_at_unix,
        checked_at_ms: Date.now()
      }
    ]
  ]);
}

function fakeOpen(rows: SummaryRow[]): (sql: string) => Promise<OctraSqliteResult> {
  return async (sql: string) => {
    if (/min\(s\.snapshot_index\)/i.test(sql)) {
      return sqliteResult(
        ["first_index", "latest_index", "row_count", "complete_through_index"],
        [[rows[0]?.snapshot_index || 0, rows[rows.length - 1]?.snapshot_index || 0, rows.length, rows[rows.length - 1]?.snapshot_index || 0]]
      );
    }
    if (/from snapshots s\s+join core_accounting_facts/i.test(sql)) {
      const start = Number(sql.match(/s\.snapshot_index\s+>=\s+(\d+)/i)?.[1] || 0);
      const end = Number(sql.match(/s\.snapshot_index\s+<=\s+(\d+)/i)?.[1] || 0);
      const selected = rows.filter((entry) => entry.snapshot_index >= start && entry.snapshot_index <= end);
      return sqliteResult(
        [
          "snapshot_index",
          "observed_at_unix",
          "octra_epoch",
          "external_block",
          "issued_raw",
          "burned_raw",
          "encrypted_raw",
          "total_locked_raw",
          "total_wrapped_raw",
          "total_unclaimed_raw",
          "route_count",
          "payload_hash_prefix"
        ],
        selected.map((entry) => [
          entry.snapshot_index,
          entry.observed_at_unix,
          entry.octra_epoch,
          entry.external_block,
          entry.issued_raw,
          entry.burned_raw,
          entry.encrypted_raw,
          entry.total_locked_raw,
          entry.total_wrapped_raw,
          entry.total_unclaimed_raw,
          entry.route_count,
          entry.payload_hash_prefix
        ])
      );
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
}

test("SQLite history replica rebuilds a paged tail and verifies it against latest AML summary", async () => {
  const rows = Array.from({ length: 60 }, (_, offset) => row(offset + 1));
  const previousPageRows = process.env.VITALS_HISTORY_REPLICA_PAGE_ROWS;
  process.env.VITALS_HISTORY_REPLICA_PAGE_ROWS = "25";
  let result: Awaited<ReturnType<typeof readSqliteHistoryReplica>>;
  try {
    result = await readSqliteHistoryReplica(
      { kind: "circle_program", id: "octProgram" },
      latestFor(rows[59]!),
      { maxSealedCapsules: 1 },
      fakeOpen(rows),
      {
        enabled: true,
        reason: null,
        bin: "octra-sqlite",
        configPath: null,
        database: "oct://devnet/octDb",
        databaseUri: "oct://devnet/octDb",
        network: "devnet"
      }
    );
  } finally {
    if (previousPageRows === undefined) delete process.env.VITALS_HISTORY_REPLICA_PAGE_ROWS;
    else process.env.VITALS_HISTORY_REPLICA_PAGE_ROWS = previousPageRows;
  }

  assert.equal(result.history.row_count, 48);
  assert.equal(result.history.first_index, 13);
  assert.equal(result.history.rows[result.history.rows.length - 1]?.snapshot_index, 60);
  assert.equal(result.page_count, 2);
  assert.equal(result.history.history_discovery, "sqlite_history_mirror_latest_summary_anchor");
  assert.equal(result.history.proof?.scope, "latest_row_anchor");
  assert.equal(result.history.proof?.truncated, true);
});

test("SQLite history replica rejects a mirror that does not tail-match latest AML", async () => {
  const rows = Array.from({ length: 60 }, (_, offset) => row(offset + 1));
  await assert.rejects(
    readSqliteHistoryReplica(
      { kind: "circle_program", id: "octProgram" },
      latestFor(row(61)),
      { maxSealedCapsules: 1 },
      fakeOpen(rows),
      {
        enabled: true,
        reason: null,
        bin: "octra-sqlite",
        configPath: null,
        database: "oct://devnet/octDb",
        databaseUri: "oct://devnet/octDb",
        network: "devnet"
      }
    ),
    /canonical history tail lag 1 exceeds max 0/
  );
});

test("SQLite history replica accepts a one-snapshot lag when the tail matches a remembered AML summary", async () => {
  const rows = Array.from({ length: 60 }, (_, offset) => row(offset + 1));
  const result = await readSqliteHistoryReplica(
    { kind: "circle_program", id: "octProgram" },
    latestFor(row(61)),
    { maxSealedCapsules: 1 },
    fakeOpen(rows),
    {
      enabled: true,
      reason: null,
      bin: "octra-sqlite",
      configPath: null,
      database: "oct://devnet/octDb",
      databaseUri: "oct://devnet/octDb",
      network: "devnet"
    },
    {
      maxLagSnapshots: 1,
      rememberedSummaries: remembered(rows[59]!)
    }
  );

  assert.equal(result.history.rows[result.history.rows.length - 1]?.snapshot_index, 60);
  assert.equal(result.tail_anchor.latest_index, 61);
  assert.equal(result.tail_anchor.tail_index, 60);
  assert.equal(result.tail_anchor.lag_snapshots, 1);
  assert.equal(result.tail_anchor.lag_seconds, 900);
  assert.equal(result.tail_anchor.anchor_source, "remembered_latest_summary");
});

test("SQLite history replica rejects a one-snapshot lag after restart when no remembered AML summary exists", async () => {
  const rows = Array.from({ length: 60 }, (_, offset) => row(offset + 1));
  await assert.rejects(
    readSqliteHistoryReplica(
      { kind: "circle_program", id: "octProgram" },
      latestFor(row(61)),
      { maxSealedCapsules: 1 },
      fakeOpen(rows),
      {
        enabled: true,
        reason: null,
        bin: "octra-sqlite",
        configPath: null,
        database: "oct://devnet/octDb",
        databaseUri: "oct://devnet/octDb",
        network: "devnet"
      },
      { maxLagSnapshots: 1, rememberedSummaries: new Map() }
    ),
    /remembered latest summary unavailable/
  );
});

test("SQLite history replica rejects a forged lagged tail even inside the one-snapshot window", async () => {
  const rows = Array.from({ length: 60 }, (_, offset) => row(offset + 1));
  const forged = {
    ...rows[59]!,
    issued_raw: String(BigInt(rows[59]!.issued_raw) + 1n)
  };
  await assert.rejects(
    readSqliteHistoryReplica(
      { kind: "circle_program", id: "octProgram" },
      latestFor(row(61)),
      { maxSealedCapsules: 1 },
      fakeOpen(rows),
      {
        enabled: true,
        reason: null,
        bin: "octra-sqlite",
        configPath: null,
        database: "oct://devnet/octDb",
        databaseUri: "oct://devnet/octDb",
        network: "devnet"
      },
      {
        maxLagSnapshots: 1,
        rememberedSummaries: remembered(forged)
      }
    ),
    /canonical history tail does not match remembered latest summary row/
  );
});
