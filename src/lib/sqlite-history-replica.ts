import { assertHistoryTailMatchesLatest, type HistoryReadOptions, type StateTarget } from "./canonical-history.js";
import { octraSqliteConfig, octraSqliteOpen, rowsAsObjects, sqlString, type OctraSqliteConfig, type OctraSqliteResult } from "./octra-sqlite-client.js";
import { encodeSummaryRow, summaryWindowHash, SUMMARY_ROW_LEN, type ProgramHistoryWindow, type SummaryRow } from "./summary-window.js";
import type { SnapshotArtifact } from "./types.js";

const FACT_LEDGER_ROWS_PER_CAPSULE = 48;
const DEFAULT_SQLITE_HISTORY_PAGE_ROWS = 175;

export interface SqliteHistoryReplicaRead {
  history: ProgramHistoryWindow;
  page_count: number;
  total_row_count: number;
  source_id: string;
  database_uri: string | null;
}

type SqliteOpen = (sql: string) => Promise<OctraSqliteResult>;

function sourceId(target: StateTarget): string {
  if (!target.id) throw new Error(`${target.kind === "circle_program" ? "programmed Circle id" : "state program address"} is required`);
  return `${target.kind}:${target.id}`;
}

function pageRows(): number {
  const configured = Number(process.env.VITALS_HISTORY_REPLICA_PAGE_ROWS || process.env.VITALS_SQLITE_HISTORY_PAGE_ROWS || DEFAULT_SQLITE_HISTORY_PAGE_ROWS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_SQLITE_HISTORY_PAGE_ROWS;
  return Math.max(25, Math.min(175, Math.trunc(configured)));
}

function tailRowLimit(options: HistoryReadOptions): number | null {
  const maxSealedCapsules = options.maxSealedCapsules;
  if (maxSealedCapsules === null || maxSealedCapsules === undefined) return null;
  const capsules = Number(maxSealedCapsules);
  if (!Number.isFinite(capsules) || capsules <= 0) return null;
  return Math.ceil(capsules) * FACT_LEDGER_ROWS_PER_CAPSULE;
}

function numberField(row: Record<string, unknown>, field: string): number {
  const value = Number(row[field] || 0);
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

function stringField(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  return value === null || value === undefined ? "" : String(value);
}

function summaryRowFromSql(row: Record<string, unknown>): SummaryRow {
  return {
    row_version: "00",
    snapshot_index: numberField(row, "snapshot_index"),
    observed_at_unix: numberField(row, "observed_at_unix"),
    octra_epoch: numberField(row, "octra_epoch"),
    external_block: numberField(row, "external_block"),
    issued_raw: stringField(row, "issued_raw"),
    burned_raw: stringField(row, "burned_raw"),
    encrypted_raw: stringField(row, "encrypted_raw"),
    total_locked_raw: stringField(row, "total_locked_raw"),
    total_wrapped_raw: stringField(row, "total_wrapped_raw"),
    total_unclaimed_raw: stringField(row, "total_unclaimed_raw"),
    route_count: Math.max(1, numberField(row, "route_count")),
    payload_hash_prefix: stringField(row, "payload_hash_prefix").toLowerCase()
  };
}

function historyWindowFromRows(rows: SummaryRow[], input: {
  source: string;
  sourceId: string;
  databaseUri: string | null;
  totalRowCount: number;
  selectedFirstIndex: number;
  selectedLatestIndex: number;
  pageCount: number;
}): ProgramHistoryWindow {
  const window = rows.map(encodeSummaryRow).join("");
  return {
    first_index: rows[0]?.snapshot_index || 0,
    row_count: rows.length,
    row_len: SUMMARY_ROW_LEN,
    window,
    window_hash: summaryWindowHash(window),
    rows,
    history_discovery: "sqlite_history_mirror_latest_summary_anchor",
    proof: {
      scope: "latest_row_anchor",
      truncated: rows.length < input.totalRowCount,
      families: [],
      capsules: []
    }
  };
}

async function readMeta(source: string, open: SqliteOpen): Promise<{ firstIndex: number; latestIndex: number; rowCount: number; completeThroughIndex: number }> {
  const meta = rowsAsObjects(await open(`
    select
      min(s.snapshot_index) as first_index,
      max(s.snapshot_index) as latest_index,
      count(*) as row_count,
      coalesce(max(w.last_complete_snapshot_index), 0) as complete_through_index
    from snapshots s
    left join mirror_watermarks w on w.source_id = s.source_id
    where s.source_id = ${sqlString(source)}
  `)).rows[0];
  if (!meta || !numberField(meta, "row_count")) {
    throw new Error("sqlite_history_empty");
  }
  return {
    firstIndex: numberField(meta, "first_index"),
    latestIndex: numberField(meta, "latest_index"),
    rowCount: numberField(meta, "row_count"),
    completeThroughIndex: numberField(meta, "complete_through_index")
  };
}

async function readRows(source: string, first: number, latest: number, open: SqliteOpen, pageSize = pageRows()): Promise<{ rows: SummaryRow[]; pageCount: number }> {
  const rows: SummaryRow[] = [];
  let pageCount = 0;
  for (let start = first; start <= latest; start += pageSize) {
    const end = Math.min(latest, start + pageSize - 1);
    const result = rowsAsObjects(await open(`
      select
        s.snapshot_index,
        s.observed_at_unix,
        s.octra_epoch,
        s.external_block,
        c.issued_raw,
        c.burned_raw,
        c.encrypted_raw,
        c.total_locked_raw,
        c.total_wrapped_raw,
        c.total_unclaimed_raw,
        c.route_count,
        c.payload_hash_prefix
      from snapshots s
      join core_accounting_facts c using(snapshot_index)
      where s.source_id = ${sqlString(source)}
        and s.snapshot_index >= ${start}
        and s.snapshot_index <= ${end}
      order by s.snapshot_index asc
    `));
    rows.push(...result.rows.map(summaryRowFromSql));
    pageCount += 1;
  }
  return { rows, pageCount };
}

export async function readSqliteHistoryReplica(
  target: StateTarget,
  latest: SnapshotArtifact,
  options: HistoryReadOptions = {},
  open: SqliteOpen = octraSqliteOpen,
  config: OctraSqliteConfig = octraSqliteConfig()
): Promise<SqliteHistoryReplicaRead> {
  if (!config.enabled) throw new Error(config.reason || "sqlite_history_replica_unavailable");
  const source = sourceId(target);
  const meta = await readMeta(source, open);
  if (meta.completeThroughIndex > 0 && meta.completeThroughIndex < meta.latestIndex) {
    throw new Error(`sqlite_history_incomplete: complete through ${meta.completeThroughIndex}, latest mirrored row ${meta.latestIndex}`);
  }

  const limit = tailRowLimit(options);
  const selectedFirst = limit ? Math.max(meta.firstIndex, meta.latestIndex - limit + 1) : meta.firstIndex;
  const selectedLatest = meta.latestIndex;
  const { rows, pageCount } = await readRows(source, selectedFirst, selectedLatest, open);
  const expectedRows = selectedLatest >= selectedFirst ? selectedLatest - selectedFirst + 1 : 0;
  if (rows.length !== expectedRows) {
    throw new Error(`sqlite_history_gap: expected ${expectedRows} rows, got ${rows.length}`);
  }
  for (let index = 0; index < rows.length; index += 1) {
    const expectedIndex = selectedFirst + index;
    const actualIndex = rows[index]?.snapshot_index;
    if (actualIndex !== expectedIndex) {
      throw new Error(`sqlite_history_index_gap: expected ${expectedIndex}, got ${actualIndex ?? "missing"}`);
    }
  }

  const history = historyWindowFromRows(rows, {
    source: "octra_sqlite_circle",
    sourceId: source,
    databaseUri: config.databaseUri || config.database,
    totalRowCount: meta.rowCount,
    selectedFirstIndex: selectedFirst,
    selectedLatestIndex: selectedLatest,
    pageCount
  });
  assertHistoryTailMatchesLatest(history, latest);
  return {
    history,
    page_count: pageCount,
    total_row_count: meta.rowCount,
    source_id: source,
    database_uri: config.databaseUri || config.database
  };
}
