import { encodeSummaryRow, summaryHash, type ProgramHistoryEra, type ProgramHistoryWindow, type SummaryRow } from "./summary-window.js";
import { octraSqliteConfig, octraSqliteOpen, sqlJson, sqlNumber, sqlString, type OctraSqliteQueryResult, type OctraSqliteResult, rowsAsObjects } from "./octra-sqlite-client.js";

export const LAB_HISTORY_SCHEMA = "octra-vitals-lab-history-v0";
export const LAB_HISTORY_TRANSFORM_VERSION = "octra-vitals-lab-history-transform-v0";

export interface LabHistorySource {
  target_kind: "circle_program" | "state_program";
  target_id: string;
}

export interface LabHistoryMirrorSummary {
  schema: typeof LAB_HISTORY_SCHEMA;
  run_id: string;
  mirrored_at: string;
  source_id: string;
  history_model: string;
  first_index: number;
  latest_index: number;
  complete_through_index: number;
  mirrored_latest_index: number;
  row_count: number;
  source_row_count: number;
  pending_row_count: number;
  complete: boolean;
  era_count: number;
  proof_scope: string;
  proof_truncated: boolean;
}

export interface LabHistoryWatermark {
  source_range_first_index: number;
  source_range_latest_index: number;
  last_complete_snapshot_index: number;
}

type LabHistorySqlOpen = (sql: string) => Promise<OctraSqliteResult>;

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function sourceId(source: LabHistorySource): string {
  return `${source.target_kind}:${source.target_id}`;
}

function snapshotId(row: SummaryRow): string {
  return `vitals.${new Date(row.observed_at_unix * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")}`;
}

function observedAt(row: SummaryRow): string {
  return new Date(row.observed_at_unix * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function big(value: string): bigint {
  return BigInt(value || "0");
}

function nonnegative(value: bigint): bigint {
  return value < 0n ? 0n : value;
}

function ratioPpm(numerator: bigint, denominator: bigint): string {
  if (denominator <= 0n) return "0";
  return String((numerator * 1_000_000n) / denominator);
}

function eraForRow(eras: ProgramHistoryEra[] | undefined, row: SummaryRow, fallbackTarget: string): ProgramHistoryEra {
  const match = (eras || []).find((era) => (
    row.snapshot_index >= Number(era.first_index || 0) &&
    row.snapshot_index <= Number(era.latest_index || 0)
  ));
  return match || {
    era_id: fallbackTarget,
    era_program: fallbackTarget,
    manifest: null,
    history_model: "unknown",
    first_index: row.snapshot_index,
    latest_index: row.snapshot_index,
    row_count: 1,
    root_hash: null,
    capsules_root: null
  };
}

function latestIndex(history: ProgramHistoryWindow): number {
  return history.rows[history.rows.length - 1]?.snapshot_index || 0;
}

function historyModel(history: ProgramHistoryWindow): string {
  return history.history_discovery || "aml_history_verified";
}

function proofScope(history: ProgramHistoryWindow): string {
  return history.proof?.scope || "unavailable";
}

function proofTruncated(history: ProgramHistoryWindow): boolean {
  return history.proof?.truncated === true;
}

function insertMirrorMeta(): string[] {
  const config = octraSqliteConfig();
  return [
    "delete from mirror_meta where key = 'devnet_only'",
    `insert or replace into mirror_meta(key, value) values ('schema', ${sqlString(LAB_HISTORY_SCHEMA)})`,
    "insert or replace into mirror_meta(key, value) values ('canonical_state_source', 'aml_fact_ledger')",
    "insert or replace into mirror_meta(key, value) values ('mirror_role', 'derived_readback_cache')",
    "insert or replace into mirror_meta(key, value) values ('mirror_canonical', 'false')",
    `insert or replace into mirror_meta(key, value) values ('mirror_network', ${sqlString(config.network)})`,
    `insert or replace into mirror_meta(key, value) values ('mainnet_explicitly_enabled', ${sqlString(config.network === "mainnet" && process.env.VITALS_LAB_HISTORY_ALLOW_MAINNET === "1" ? "true" : "false")})`
  ];
}

function insertEraStatements(history: ProgramHistoryWindow, mirroredAt: string, fallbackTarget: string): string[] {
  return (history.eras || []).map((era) => `insert or replace into aml_eras(
    era_id, circle_id, network_id, manifest, history_model, first_snapshot_index, latest_snapshot_index,
    row_count, predecessor_program, predecessor_final_index, predecessor_final_root, predecessor_anchor_hash,
    boundary_verified, root_hash, catalog_root, core_family_root, core_capsules_root, proof_scope,
    proof_truncated, verified_at
  ) values (
    ${sqlString(era.era_id || era.era_program || fallbackTarget)},
    ${sqlString(era.era_program || fallbackTarget)},
    ${sqlString(era.era_network_id || null)},
    ${sqlString(era.manifest || null)},
    ${sqlString(era.history_model || historyModel(history))},
    ${sqlNumber(era.first_index)},
    ${sqlNumber(era.latest_index)},
    ${sqlNumber(era.row_count)},
    ${sqlString(era.predecessor_program || null)},
    ${sqlNumber(era.predecessor_final_index)},
    ${sqlString(era.predecessor_final_root || null)},
    ${sqlString(era.predecessor_anchor_hash || null)},
    ${era.boundary_verified ? 1 : 0},
    ${sqlString(era.root_hash || history.history_root || null)},
    ${sqlString(null)},
    ${sqlString(history.history_root || null)},
    ${sqlString(era.capsules_root || history.capsules_root || null)},
    ${sqlString(era.proof_scope || proofScope(history))},
    ${era.proof_truncated ? 1 : 0},
    ${sqlString(mirroredAt)}
  )`);
}

function insertFamilyStatements(history: ProgramHistoryWindow): string[] {
  return (history.proof?.families || []).map((family: any) => `insert or replace into fact_families(
    era_id, family_id, schema_id, family_name, status, first_snapshot_index, row_len,
    field_manifest_hash, definition_hash, raw_json
  ) values (
    ${sqlString(family.era_id || "active")},
    ${sqlString(family.family_id || "0000")},
    ${sqlString(family.schema_id || null)},
    ${sqlString(family.family_name || "core accounting")},
    ${sqlString(family.truncated ? "tail_verified" : "mirrored")},
    ${sqlNumber(family.first_snapshot_index)},
    ${sqlNumber(family.row_len || null)},
    ${sqlString(null)},
    ${sqlString(null)},
    ${sqlJson(family)}
  )`);
}

function insertCapsuleStatements(history: ProgramHistoryWindow, mirroredAt: string): string[] {
  return (history.proof?.capsules || []).map((capsule: any) => `insert or replace into fact_capsules(
    era_id, family_id, capsule_id, ordinal, sealed, first_snapshot_index, last_snapshot_index,
    row_count, row_len, body_hash, meta_hash, start_root, end_root, family_root_before,
    family_root_after, proof_scope, verified_at, raw_json
  ) values (
    ${sqlString(capsule.era_id || "active")},
    ${sqlString(capsule.family_id || "0000")},
    ${sqlString(capsule.capsule_id || "")},
    ${sqlNumber(capsule.ordinal)},
    1,
    ${sqlNumber(capsule.first_snapshot_index)},
    ${sqlNumber(capsule.last_snapshot_index)},
    ${sqlNumber(capsule.row_count)},
    ${sqlNumber(capsule.row_len || null)},
    ${sqlString(capsule.body_hash || null)},
    ${sqlString(capsule.meta_hash || null)},
    ${sqlString(capsule.start_root || null)},
    ${sqlString(capsule.end_root || null)},
    ${sqlString(capsule.family_root_before || null)},
    ${sqlString(capsule.root_after || capsule.family_root_after || null)},
    ${sqlString(capsule.proof_scope || proofScope(history))},
    ${sqlString(mirroredAt)},
    ${sqlJson(capsule)}
  )`);
}

function derivedMetricStatements(row: SummaryRow): string[] {
  const issued = big(row.issued_raw);
  const encrypted = big(row.encrypted_raw);
  const locked = big(row.total_locked_raw);
  const wrapped = big(row.total_wrapped_raw);
  const unclaimed = big(row.total_unclaimed_raw);
  const publicBalance = nonnegative(issued - encrypted);
  const bridgeGap = locked - wrapped;
  const unclassified = nonnegative(locked - wrapped - unclaimed);
  const coveragePpm = ratioPpm(wrapped, locked);
  const metrics = [
    ["public_balance_raw", "Public balance", publicBalance.toString(), "micro-OCT", "issued_raw - encrypted_raw"],
    ["bridge_gap_raw", "Bridge gap", bridgeGap.toString(), "micro-OCT", "total_locked_raw - total_wrapped_raw"],
    ["unclassified_raw", "Unclassified collateral", unclassified.toString(), "micro-OCT", "max(total_locked_raw - total_wrapped_raw - total_unclaimed_raw, 0)"],
    ["woct_coverage_ppm", "wOCT coverage", coveragePpm, "ppm", "total_wrapped_raw / total_locked_raw scaled to parts-per-million"]
  ];
  return metrics.map(([key, label, value, unit, derivation]) => `insert or replace into derived_snapshot_metrics(
    snapshot_index, metric_key, metric_label, raw_value, unit, source_class, derivation
  ) values (
    ${sqlNumber(row.snapshot_index)},
    ${sqlString(key)},
    ${sqlString(label)},
    ${sqlString(value)},
    ${sqlString(unit)},
    'derived_from_aml_core_fact',
    ${sqlString(derivation)}
  )`);
}

function rowStatements(history: ProgramHistoryWindow, source: LabHistorySource, runId: string, mirroredAt: string, rows = history.rows): string[] {
  const statements: string[] = [];
  for (const row of rows) {
    const era = eraForRow(history.eras, row, source.target_id);
    const encodedRow = encodeSummaryRow(row);
    const derivedSummaryHash = summaryHash(encodedRow);
    const observed = observedAt(row);
    statements.push(`insert or replace into snapshots(
      snapshot_index, era_id, snapshot_id, source_id, observed_at, observed_at_unix, octra_epoch, external_block,
      program_circle_id, aml_tx_hash, payload_hash_prefix, evidence_manifest_hash, source_refs_hash,
      summary_hash, core_row_hash, capsule_id, family_root_after, conservation_status, unit_status,
      mirrored_at, verified_at, proof_scope, source_class, mirror_run_id
    ) values (
      ${sqlNumber(row.snapshot_index)},
      ${sqlString(era.era_id || source.target_id)},
      ${sqlString(snapshotId(row))},
      ${sqlString(sourceId(source))},
      ${sqlString(observed)},
      ${sqlNumber(row.observed_at_unix)},
      ${sqlNumber(row.octra_epoch)},
      ${sqlNumber(row.external_block)},
      ${source.target_kind === "circle_program" ? sqlString(source.target_id) : "null"},
      null,
      ${sqlString(row.payload_hash_prefix)},
      null,
      null,
      ${sqlString(derivedSummaryHash)},
      null,
      null,
      ${sqlString(history.history_root || null)},
      null,
      null,
      ${sqlString(mirroredAt)},
      ${sqlString(mirroredAt)},
      ${sqlString(proofScope(history))},
      'aml_fact_row',
      ${sqlString(runId)}
    )`);
    statements.push(`insert or replace into core_accounting_facts(
      snapshot_index, max_supply_raw, issued_raw, burned_raw, encrypted_raw, total_locked_raw,
      total_wrapped_raw, total_unclaimed_raw, vault_balance_raw, route_count, payload_hash_prefix, core_row_hash
    ) values (
      ${sqlNumber(row.snapshot_index)},
      null,
      ${sqlString(row.issued_raw)},
      ${sqlString(row.burned_raw)},
      ${sqlString(row.encrypted_raw)},
      ${sqlString(row.total_locked_raw)},
      ${sqlString(row.total_wrapped_raw)},
      ${sqlString(row.total_unclaimed_raw)},
      null,
      ${sqlNumber(row.route_count)},
      ${sqlString(row.payload_hash_prefix)},
      null
    )`);
    statements.push(`insert or replace into snapshot_verifications(
      snapshot_index, verification_type, status, checked_at, source_range, details_json
    ) values (
      ${sqlNumber(row.snapshot_index)},
      'aml_history_readback',
      'verified',
      ${sqlString(mirroredAt)},
      ${sqlString(`${history.first_index}-${latestIndex(history)}`)},
      ${sqlJson({ proof_scope: proofScope(history), history_model: historyModel(history), truncated: proofTruncated(history), summary_hash: derivedSummaryHash })}
    )`);
    statements.push(...derivedMetricStatements(row));
  }
  return statements;
}

function compactStatement(statement: string): string {
  return statement.trim().replace(/\s+/g, " ");
}

function sqlBatch(statements: string[]): string {
  return statements.map((statement) => `${compactStatement(statement)};`).join("\n");
}

interface BuildLabHistoryMirrorOptions {
  rows?: SummaryRow[];
  sourceRows?: SummaryRow[];
  complete?: boolean;
  includeCatalog?: boolean;
  pendingRowCount?: number;
  completeThroughIndex?: number;
  mirroredLatestIndex?: number;
}

interface LabHistoryMirrorPlan {
  sourceRows: SummaryRow[];
  rows: SummaryRow[];
  completeThroughIndex: number;
  mirroredLatestIndex: number;
  complete: boolean;
  pendingRowCount: number;
}

function completionStatements(
  history: ProgramHistoryWindow,
  source: LabHistorySource,
  runId: string,
  now: string,
  rows: SummaryRow[],
  sourceRows: SummaryRow[],
  complete: boolean,
  completeThroughIndex: number,
  mirroredLatestIndex: number
): string[] {
  const firstIndex = sourceRows[0]?.snapshot_index || 0;
  const latest = latestIndex(history);
  const sourceKey = sourceId(source);
  const retentionPolicy = sourceRows.length < history.rows.length
    ? "derived_mirror_of_verified_aml_history_tail"
    : "derived_mirror_of_available_verified_aml_history";
  return [
    `insert or replace into mirror_runs(
      run_id, started_at, finished_at, status, source_first_index, source_latest_index,
      mirrored_through_index, verified_through_index, transform_version, error
    ) values (
      ${sqlString(runId)},
      ${sqlString(now)},
      ${sqlString(now)},
      'ok',
      ${sqlNumber(firstIndex)},
      ${sqlNumber(latest)},
      ${sqlNumber(mirroredLatestIndex)},
      ${sqlNumber(completeThroughIndex)},
      ${sqlString(LAB_HISTORY_TRANSFORM_VERSION)},
      null
    )`,
    `insert or replace into mirror_watermarks(
      source_id, source_range_first_index, source_range_latest_index, verified_range_first_index,
      verified_range_latest_index, last_complete_snapshot_index, latest_verified_root,
      last_aml_readback_verified_at, last_run_id, transform_version, complete, retention_policy
    ) values (
      ${sqlString(sourceKey)},
      ${sqlNumber(firstIndex)},
      ${sqlNumber(latest)},
      ${sqlNumber(firstIndex)},
      ${sqlNumber(completeThroughIndex || null)},
      ${sqlNumber(completeThroughIndex || null)},
      ${sqlString(history.history_root || history.window_hash || null)},
      ${sqlString(now)},
      ${sqlString(runId)},
      ${sqlString(LAB_HISTORY_TRANSFORM_VERSION)},
      ${complete ? 1 : 0},
      ${sqlString(retentionPolicy)}
    )`
  ];
}

async function readWatermark(source: LabHistorySource, open: LabHistorySqlOpen = octraSqliteOpen): Promise<LabHistoryWatermark | null> {
  const result = rowsAsObjects(await open(`
    select
      source_range_first_index,
      source_range_latest_index,
      last_complete_snapshot_index
    from mirror_watermarks
    where source_id = ${sqlString(sourceId(source))}
    limit 1
  `));
  const row = result.rows[0];
  if (!row) return null;
  return {
    source_range_first_index: Number(row.source_range_first_index || 0),
    source_range_latest_index: Number(row.source_range_latest_index || 0),
    last_complete_snapshot_index: Number(row.last_complete_snapshot_index || 0)
  };
}

async function verifyMirrorReadback(
  source: LabHistorySource,
  summary: LabHistoryMirrorSummary,
  rows: SummaryRow[],
  open: LabHistorySqlOpen
): Promise<void> {
  const sourceKey = sourceId(source);
  const watermark = rowsAsObjects(await open(`
    select
      source_range_latest_index,
      last_complete_snapshot_index,
      complete
    from mirror_watermarks
    where source_id = ${sqlString(sourceKey)}
    limit 1
  `)).rows[0];
  const problems: string[] = [];
  if (!watermark) {
    problems.push("watermark_missing");
  } else {
    const sourceLatest = Number(watermark.source_range_latest_index || 0);
    const completeThrough = Number(watermark.last_complete_snapshot_index || 0);
    const complete = Number(watermark.complete || 0) === 1;
    if (sourceLatest !== summary.latest_index) {
      problems.push(`source_latest ${sourceLatest} != ${summary.latest_index}`);
    }
    if (completeThrough !== summary.complete_through_index) {
      problems.push(`complete_through ${completeThrough} != ${summary.complete_through_index}`);
    }
    if (complete !== summary.complete) {
      problems.push(`complete ${complete} != ${summary.complete}`);
    }
  }

  const indices = [...new Set(rows.map((row) => row.snapshot_index))].sort((a, b) => a - b);
  if (indices.length) {
    const rowCheck = rowsAsObjects(await open(`
      select count(*) as row_count
      from snapshots
      where snapshot_index in (${indices.map(sqlNumber).join(", ")})
    `)).rows[0];
    const observedRows = Number(rowCheck?.row_count || 0);
    if (observedRows !== indices.length) {
      problems.push(`mirrored_rows ${observedRows} != ${indices.length}`);
    }
  }

  if (problems.length) {
    throw new Error(`lab mirror readback mismatch: ${problems.join("; ")}`);
  }
}

function buildLabHistoryMirrorStatements(
  history: ProgramHistoryWindow,
  source: LabHistorySource,
  now = isoNow(),
  options: BuildLabHistoryMirrorOptions = {}
): { statements: string[]; summary: LabHistoryMirrorSummary } {
  if (!source.target_id) throw new Error("lab history source target is required");
  const sourceRows = options.sourceRows || history.rows;
  const rows = options.rows || history.rows;
  const complete = options.complete ?? true;
  const includeCatalog = options.includeCatalog ?? true;
  const completeThroughIndex = options.completeThroughIndex ?? (complete ? latestIndex(history) : 0);
  const mirroredLatestIndex = options.mirroredLatestIndex ?? (rows[rows.length - 1]?.snapshot_index || completeThroughIndex);
  const runId = `lab.${now}.${rows.length}.${latestIndex(history)}`;
  const firstIndex = sourceRows[0]?.snapshot_index || 0;
  const latest = latestIndex(history);
  const sourceKey = sourceId(source);
  const statements = [
    ...(includeCatalog ? insertMirrorMeta() : []),
    ...(includeCatalog ? insertEraStatements(history, now, source.target_id) : []),
    ...(includeCatalog ? insertFamilyStatements(history) : []),
    ...(includeCatalog ? insertCapsuleStatements(history, now) : []),
    ...rowStatements(history, source, runId, now, rows),
    ...completionStatements(history, source, runId, now, rows, sourceRows, complete, completeThroughIndex, mirroredLatestIndex)
  ];
  return {
    statements,
    summary: {
      schema: LAB_HISTORY_SCHEMA,
      run_id: runId,
      mirrored_at: now,
      source_id: sourceKey,
      history_model: historyModel(history),
      first_index: firstIndex,
      latest_index: latest,
      complete_through_index: completeThroughIndex,
      mirrored_latest_index: mirroredLatestIndex,
      row_count: rows.length,
      source_row_count: sourceRows.length,
      pending_row_count: options.pendingRowCount ?? 0,
      complete,
      era_count: history.eras?.length || 0,
      proof_scope: proofScope(history),
      proof_truncated: proofTruncated(history)
    }
  };
}

export function buildLabHistoryMirrorSql(history: ProgramHistoryWindow, source: LabHistorySource, now = isoNow()): { sql: string; summary: LabHistoryMirrorSummary } {
  const { statements, summary } = buildLabHistoryMirrorStatements(history, source, now);
  return {
    sql: sqlBatch(statements),
    summary
  };
}

function maxSyncSqlBytes(): number {
  const configured = Number(process.env.VITALS_LAB_HISTORY_SYNC_SQL_MAX_BYTES || 6_000);
  return Number.isFinite(configured) && configured >= 1_000 ? configured : 6_000;
}

function maxSyncRows(): number {
  const configured = Number(process.env.VITALS_LAB_HISTORY_SYNC_MAX_ROWS || 8);
  return Number.isFinite(configured) && configured > 0 ? Math.trunc(configured) : 8;
}

function syncTailRows(): number {
  const configured = Number(process.env.VITALS_LAB_HISTORY_SYNC_TAIL_ROWS || 0);
  return Number.isFinite(configured) && configured > 0 ? Math.trunc(configured) : 0;
}

function readbackRetryAttempts(): number {
  const configured = Number(process.env.VITALS_LAB_HISTORY_READBACK_RETRY_ATTEMPTS || 6);
  return Number.isFinite(configured) && configured > 0 ? Math.trunc(configured) : 6;
}

function readbackRetryDelayMs(): number {
  const configured = Number(process.env.VITALS_LAB_HISTORY_READBACK_RETRY_DELAY_MS || 5_000);
  return Number.isFinite(configured) && configured >= 0 ? Math.trunc(configured) : 5_000;
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyMirrorReadbackWithRetry(
  source: LabHistorySource,
  summary: LabHistoryMirrorSummary,
  rows: SummaryRow[],
  open: LabHistorySqlOpen
): Promise<void> {
  const attempts = readbackRetryAttempts();
  const delayMs = readbackRetryDelayMs();
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await verifyMirrorReadback(source, summary, rows, open);
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      await sleep(delayMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || "lab mirror readback mismatch"));
}

export function planLabHistoryMirrorRows(
  history: ProgramHistoryWindow,
  completeBeforeRun: number,
  maxRows: number,
  tailRows = 0
): LabHistoryMirrorPlan {
  const sourceRows = tailRows > 0 ? history.rows.slice(-tailRows) : history.rows;
  const missingRows = sourceRows.filter((row) => row.snapshot_index > completeBeforeRun);
  const rows = missingRows.slice(0, maxRows).sort((a, b) => a.snapshot_index - b.snapshot_index);
  const completeThroughIndex = contiguousCompleteThrough(sourceRows, completeBeforeRun, rows);
  const mirroredLatestIndex = Math.max(completeBeforeRun, rows[rows.length - 1]?.snapshot_index || 0);
  const complete = sourceRows.length > 0 && completeThroughIndex === latestIndex(history);
  return {
    sourceRows,
    rows,
    completeThroughIndex,
    mirroredLatestIndex,
    complete,
    pendingRowCount: sourceRows.filter((row) => row.snapshot_index > completeThroughIndex).length
  };
}

function statementBatches(statements: string[], maxBytes = maxSyncSqlBytes()): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const statement of statements) {
    const nextBytes = Buffer.byteLength(`${statement};\n`);
    if (current.length && currentBytes + nextBytes > maxBytes) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(statement);
    currentBytes += nextBytes;
  }
  if (current.length) batches.push(current);
  return batches;
}

export async function mirrorLabHistory(history: ProgramHistoryWindow, source: LabHistorySource, open: LabHistorySqlOpen = octraSqliteOpen): Promise<LabHistoryMirrorSummary> {
  const watermark = await readWatermark(source, open);
  const completeBeforeRun = watermark?.last_complete_snapshot_index || 0;
  const plan = planLabHistoryMirrorRows(history, completeBeforeRun, maxSyncRows(), syncTailRows());
  const includeCatalog = completeBeforeRun === 0;
  const { statements, summary } = buildLabHistoryMirrorStatements(history, source, isoNow(), {
    rows: plan.rows,
    sourceRows: plan.sourceRows,
    complete: plan.complete,
    includeCatalog,
    pendingRowCount: plan.pendingRowCount,
    completeThroughIndex: plan.completeThroughIndex,
    mirroredLatestIndex: plan.mirroredLatestIndex
  });
  if (!includeCatalog && plan.rows.length === 0 && plan.pendingRowCount === 0) {
    return summary;
  }
  for (const batch of statementBatches(statements)) {
    try {
      await open(sqlBatch(batch));
    } catch (error) {
      const first = compactStatement(batch[0] || "").slice(0, 120);
      const bytes = Buffer.byteLength(sqlBatch(batch));
      throw new Error(`lab mirror batch failed (${batch.length} statements, ${bytes} bytes, first: ${first}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await verifyMirrorReadbackWithRetry(source, summary, plan.rows, open);
  return summary;
}

function contiguousCompleteThrough(sourceRows: SummaryRow[], completeBeforeRun: number, rowsWritten: SummaryRow[]): number {
  let through = 0;
  const written = new Set(rowsWritten.map((row) => row.snapshot_index));
  for (const row of sourceRows) {
    if (row.snapshot_index <= completeBeforeRun || written.has(row.snapshot_index)) {
      through = row.snapshot_index;
      continue;
    }
    break;
  }
  return through;
}

export async function labTables(): Promise<OctraSqliteQueryResult> {
  return rowsAsObjects(await octraSqliteOpen("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name"));
}

export async function labSchema(): Promise<OctraSqliteQueryResult> {
  return rowsAsObjects(await octraSqliteOpen("select type, name, sql from sqlite_master where name not like 'sqlite_%' order by type, name"));
}

export async function labStatus(): Promise<OctraSqliteQueryResult> {
  return rowsAsObjects(await octraSqliteOpen(`
    select
      'watermark' as section,
      source_id as name,
      last_complete_snapshot_index as complete_through_index,
      null as mirrored_latest_index,
      source_range_latest_index as source_latest_index,
      complete as complete,
      last_aml_readback_verified_at as observed_at
    from mirror_watermarks
    union all
    select
      'run' as section,
      run_id as name,
      verified_through_index as complete_through_index,
      mirrored_through_index as mirrored_latest_index,
      source_latest_index as source_latest_index,
      null as complete,
      finished_at as observed_at
    from mirror_runs
    order by observed_at desc
    limit 20
  `));
}

export function labHistorySql(window: string | null): string {
  const hours = window === "1h" ? 1 : window === "7d" ? 24 * 7 : window === "30d" ? 24 * 30 : 24;
  return `
    select
      s.snapshot_index,
      s.snapshot_id,
      c.issued_raw,
      c.burned_raw,
      c.encrypted_raw,
      c.total_locked_raw,
      c.total_wrapped_raw,
      c.total_unclaimed_raw,
      d.raw_value as unclassified_raw
    from snapshots s
    join core_accounting_facts c using(snapshot_index)
    left join derived_snapshot_metrics d on d.snapshot_index = s.snapshot_index and d.metric_key = 'unclassified_raw'
    where s.observed_at_unix >= (
      select max(observed_at_unix) - ${hours * 60 * 60} from snapshots
    )
    order by s.snapshot_index asc
  `;
}
