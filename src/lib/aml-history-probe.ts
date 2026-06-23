import { sha256Hex } from "./canonical-json.js";

export const HISTORY_PROBE_SCHEMA = "octra-vitals-history-probe-v1";
export const HISTORY_ROW_VERSION = "00";
export const HISTORY_SCHEMA_ID = "00";
export const CORE_CAPSULE_FAMILY = "core";
export const HISTORY_ROW_HASH_DOMAIN = "octra-vitals:history-row:v1-probe";
export const HISTORY_ROOT_DOMAIN = "octra-vitals:history-root:v1-probe";
export const CAPSULE_BODY_HASH_DOMAIN = "octra-vitals:capsule-body:v1-probe";
export const CAPSULE_META_HASH_DOMAIN = "octra-vitals:capsule-meta:v1-probe";
export const CAPSULE_TX_INDEX_HASH_DOMAIN = "octra-vitals:capsule-tx-index:v1-probe";
export const CAPSULES_ROOT_HASH_DOMAIN = "octra-vitals:capsules-root:v1-probe";
export const CALENDAR_STAT_NODE_HASH_DOMAIN = "octra-vitals:calendar-stat-node:v1-probe";
export const HISTORY_ROW_LEN = 295;
export const CAPSULE_META_LEN = 346;
export const CALENDAR_STAT_NODE_LEN = 551;
export const TX_HASH_HEX_LEN = 64;

export interface HistoryObservationRow {
  row_version: string;
  snapshot_index: number;
  observed_at_unix: number;
  octra_epoch: number;
  external_block: number;
  max_supply_raw: string;
  issued_raw: string;
  burned_raw: string;
  encrypted_raw: string;
  total_locked_raw: string;
  total_wrapped_raw: string;
  total_unclaimed_raw: string;
  vault_balance_raw: string;
  unit_status: string;
  conservation_status: "G" | "Y" | "R" | "U";
  route_count: number;
  payload_hash_hex: string;
}

export interface CapsuleMeta {
  version: string;
  capsule_family: string;
  history_schema_id: string;
  sealed: boolean;
  capsule_id: string;
  first_index: number;
  last_index: number;
  row_count: number;
  row_len: number;
  first_observed_unix: number;
  last_observed_unix: number;
  body_hash_hex: string;
  start_root_hex: string;
  end_root_hex: string;
  tx_index_hash_hex: string;
}

export interface HistoryCapsule {
  body: string;
  body_hash_hex: string;
  meta: CapsuleMeta;
  meta_row: string;
  meta_hash_hex: string;
  rows: HistoryObservationRow[];
}

export interface CalendarStatNode {
  version: string;
  tier: "H" | "D" | "M" | "Y";
  period_id: string;
  first_index: number;
  last_index: number;
  first_observed_unix: number;
  last_observed_unix: number;
  count: number;
  status: "G" | "Y" | "R" | "U";
  start_root_hex: string;
  end_root_hex: string;
  source_child_count: number;
  first_issued_raw: string;
  last_issued_raw: string;
  min_issued_raw: string;
  max_issued_raw: string;
  first_locked_raw: string;
  last_locked_raw: string;
  min_locked_raw: string;
  max_locked_raw: string;
  first_wrapped_raw: string;
  last_wrapped_raw: string;
  min_wrapped_raw: string;
  max_wrapped_raw: string;
  first_unclaimed_raw: string;
  last_unclaimed_raw: string;
  min_unclaimed_raw: string;
  max_unclaimed_raw: string;
}

export interface ProbeEstimate {
  row_count: number;
  hours_at_15m: number;
  row_len: number;
  body_bytes: number;
  meta_bytes: number;
  tx_index_bytes: number;
  body_with_meta_bytes: number;
  body_meta_tx_index_bytes: number;
  estimated_calendar_stat_bytes: number;
  estimated_append_rewrite_bytes_without_calendar: number;
  estimated_append_rewrite_bytes_with_calendar: number;
}

const ZERO_HASH_HEX = "0".repeat(64);
const CAPSULE_FAMILY_CODES: Record<string, string> = {
  [CORE_CAPSULE_FAMILY]: "0000"
};
const CAPSULE_FAMILY_BY_CODE = Object.fromEntries(
  Object.entries(CAPSULE_FAMILY_CODES).map(([key, value]) => [value, key])
) as Record<string, string | undefined>;

function taggedHashHex(domain: string, value: string): string {
  return sha256Hex(`${domain}\n${value}`);
}

function digits(value: string | number | bigint, width: number, label: string): string {
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new Error(`${label} must be unsigned decimal digits`);
  if (text.length > width) throw new Error(`${label} exceeds ${width} digits`);
  return text.padStart(width, "0");
}

function fixedText(value: string, width: number, label: string): string {
  if (!/^[ -~]+$/.test(value)) throw new Error(`${label} must be printable ASCII`);
  if (value.includes("|")) throw new Error(`${label} must not contain pipe separators`);
  if (value.length > width) throw new Error(`${label} exceeds ${width} chars`);
  return value.padEnd(width, " ");
}

function parseUnsigned(value: string | undefined, label: string): number {
  if (!value || !/^\d+$/.test(value)) throw new Error(`${label} must be unsigned decimal digits`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is outside the safe integer range`);
  return parsed;
}

function parseRaw(value: string | undefined, label: string): string {
  if (!value || !/^\d+$/.test(value)) throw new Error(`${label} must be unsigned decimal digits`);
  return String(BigInt(value));
}

function hex64(value: string, label: string): string {
  const normalized = value.replace(/^sha256:/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} must be 64 hex chars`);
  return normalized;
}

function capsuleFamilyCode(family: string): string {
  const code = CAPSULE_FAMILY_CODES[family];
  if (!code) throw new Error(`unknown capsule family: ${family}`);
  return code;
}

function capsuleFamilyFromCode(code: string): string {
  const family = CAPSULE_FAMILY_BY_CODE[code];
  if (!family) throw new Error(`unknown capsule family code: ${code}`);
  return family;
}

export function emptyHistoryRootHex(): string {
  return taggedHashHex(HISTORY_ROOT_DOMAIN, "");
}

export function emptyCapsulesRootHex(): string {
  return taggedHashHex(CAPSULES_ROOT_HASH_DOMAIN, "");
}

export function foldCapsulesRootHex(
  startRootHex: string,
  capsuleId: string,
  bodyHashHex: string,
  metaHashHex: string,
  endRootHex: string
): string {
  const root = hex64(startRootHex, "capsules_root_hex");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(capsuleId)) throw new Error("capsule_id must be YYYY-MM-DDTHH");
  return taggedHashHex(
    CAPSULES_ROOT_HASH_DOMAIN,
    `${root}\n${capsuleId}\n${hex64(bodyHashHex, "body_hash_hex")}\n${hex64(metaHashHex, "meta_hash_hex")}\n${hex64(endRootHex, "end_root_hex")}`
  );
}

export function foldHistoryRootHex(startRootHex: string, encodedRows: string[]): string {
  let root = hex64(startRootHex, "start_root_hex");
  for (const row of encodedRows) {
    if (row.length !== HISTORY_ROW_LEN) throw new Error("encoded row length mismatch");
    root = taggedHashHex(HISTORY_ROOT_DOMAIN, `${root}\n${historyRowHashHex(row)}`);
  }
  return root;
}

export function historyRowHashHex(encodedRow: string): string {
  if (encodedRow.length !== HISTORY_ROW_LEN) throw new Error("encoded row length mismatch");
  return taggedHashHex(HISTORY_ROW_HASH_DOMAIN, encodedRow);
}

export function capsuleBodyHashHex(body: string): string {
  if (body.length % HISTORY_ROW_LEN !== 0) throw new Error("capsule body length must be row-aligned");
  return taggedHashHex(CAPSULE_BODY_HASH_DOMAIN, body);
}

export function capsuleMetaHashHex(metaRow: string): string {
  if (metaRow.length !== CAPSULE_META_LEN) throw new Error("capsule meta length mismatch");
  return taggedHashHex(CAPSULE_META_HASH_DOMAIN, metaRow);
}

export function capsuleTxIndexHashHex(txIndex: string): string {
  if (txIndex.length % TX_HASH_HEX_LEN !== 0) throw new Error("tx index must be fixed-width tx hashes");
  if (txIndex.length > 0 && !/^[0-9a-f]+$/.test(txIndex)) throw new Error("tx index must be lowercase hex");
  return taggedHashHex(CAPSULE_TX_INDEX_HASH_DOMAIN, txIndex);
}

export function calendarStatNodeHashHex(nodeRow: string): string {
  if (nodeRow.length !== CALENDAR_STAT_NODE_LEN) throw new Error("calendar stat node length mismatch");
  return taggedHashHex(CALENDAR_STAT_NODE_HASH_DOMAIN, nodeRow);
}

export function capsuleIdForUnix(unixSeconds: number, capsuleHours = 12): string {
  if (!Number.isSafeInteger(unixSeconds) || unixSeconds < 0) throw new Error("unixSeconds must be a non-negative safe integer");
  if (capsuleHours !== 12 && capsuleHours !== 24) throw new Error("capsuleHours must be 12 or 24 for this probe");
  const date = new Date(unixSeconds * 1000);
  const day = date.toISOString().slice(0, 10);
  const hour = date.getUTCHours();
  const boundary = capsuleHours === 24 ? "00" : hour < 12 ? "00" : "12";
  return `${day}T${boundary}`;
}

export function encodeCalendarStatNode(node: CalendarStatNode): string {
  if (node.version !== HISTORY_ROW_VERSION) throw new Error(`unsupported calendar node version ${node.version}`);
  if (!/^[HDMY]$/.test(node.tier)) throw new Error("calendar tier must be H, D, M, or Y");
  if (!/^[GYRU]$/.test(node.status)) throw new Error("calendar status must be G, Y, R, or U");
  if (node.count < 0 || node.last_index - node.first_index + 1 < 0) throw new Error("calendar index span must be non-negative");
  const fields = [
    node.version,
    node.tier,
    fixedText(node.period_id, 16, "period_id"),
    digits(node.first_index, 10, "first_index"),
    digits(node.last_index, 10, "last_index"),
    digits(node.first_observed_unix, 12, "first_observed_unix"),
    digits(node.last_observed_unix, 12, "last_observed_unix"),
    digits(node.count, 6, "count"),
    node.status,
    hex64(node.start_root_hex, "start_root_hex"),
    hex64(node.end_root_hex, "end_root_hex"),
    digits(node.source_child_count, 6, "source_child_count"),
    digits(node.first_issued_raw, 20, "first_issued_raw"),
    digits(node.last_issued_raw, 20, "last_issued_raw"),
    digits(node.min_issued_raw, 20, "min_issued_raw"),
    digits(node.max_issued_raw, 20, "max_issued_raw"),
    digits(node.first_locked_raw, 20, "first_locked_raw"),
    digits(node.last_locked_raw, 20, "last_locked_raw"),
    digits(node.min_locked_raw, 20, "min_locked_raw"),
    digits(node.max_locked_raw, 20, "max_locked_raw"),
    digits(node.first_wrapped_raw, 20, "first_wrapped_raw"),
    digits(node.last_wrapped_raw, 20, "last_wrapped_raw"),
    digits(node.min_wrapped_raw, 20, "min_wrapped_raw"),
    digits(node.max_wrapped_raw, 20, "max_wrapped_raw"),
    digits(node.first_unclaimed_raw, 20, "first_unclaimed_raw"),
    digits(node.last_unclaimed_raw, 20, "last_unclaimed_raw"),
    digits(node.min_unclaimed_raw, 20, "min_unclaimed_raw"),
    digits(node.max_unclaimed_raw, 20, "max_unclaimed_raw")
  ];
  const encoded = fields.join("|");
  if (encoded.length !== CALENDAR_STAT_NODE_LEN) {
    throw new Error(`calendar stat node length ${encoded.length} did not match ${CALENDAR_STAT_NODE_LEN}`);
  }
  return encoded;
}

export function syntheticCalendarStatNode(
  tier: CalendarStatNode["tier"],
  periodId: string,
  firstRow: HistoryObservationRow,
  lastRow: HistoryObservationRow,
  options: {
    startRootHex?: string;
    endRootHex?: string;
    count?: number;
    sourceChildCount?: number;
  } = {}
): CalendarStatNode {
  const rows = [firstRow, lastRow];
  const rawValues = (field: "issued_raw" | "total_locked_raw" | "total_wrapped_raw" | "total_unclaimed_raw") =>
    rows.map((row) => BigInt(row[field]));
  const minRaw = (field: "issued_raw" | "total_locked_raw" | "total_wrapped_raw" | "total_unclaimed_raw") =>
    rawValues(field).reduce((a, b) => (a < b ? a : b)).toString();
  const maxRaw = (field: "issued_raw" | "total_locked_raw" | "total_wrapped_raw" | "total_unclaimed_raw") =>
    rawValues(field).reduce((a, b) => (a > b ? a : b)).toString();
  return {
    version: HISTORY_ROW_VERSION,
    tier,
    period_id: periodId,
    first_index: firstRow.snapshot_index,
    last_index: lastRow.snapshot_index,
    first_observed_unix: firstRow.observed_at_unix,
    last_observed_unix: lastRow.observed_at_unix,
    count: options.count ?? lastRow.snapshot_index - firstRow.snapshot_index + 1,
    status: firstRow.conservation_status === lastRow.conservation_status ? firstRow.conservation_status : "Y",
    start_root_hex: options.startRootHex || emptyHistoryRootHex(),
    end_root_hex: options.endRootHex || emptyHistoryRootHex(),
    source_child_count: options.sourceChildCount ?? 1,
    first_issued_raw: firstRow.issued_raw,
    last_issued_raw: lastRow.issued_raw,
    min_issued_raw: minRaw("issued_raw"),
    max_issued_raw: maxRaw("issued_raw"),
    first_locked_raw: firstRow.total_locked_raw,
    last_locked_raw: lastRow.total_locked_raw,
    min_locked_raw: minRaw("total_locked_raw"),
    max_locked_raw: maxRaw("total_locked_raw"),
    first_wrapped_raw: firstRow.total_wrapped_raw,
    last_wrapped_raw: lastRow.total_wrapped_raw,
    min_wrapped_raw: minRaw("total_wrapped_raw"),
    max_wrapped_raw: maxRaw("total_wrapped_raw"),
    first_unclaimed_raw: firstRow.total_unclaimed_raw,
    last_unclaimed_raw: lastRow.total_unclaimed_raw,
    min_unclaimed_raw: minRaw("total_unclaimed_raw"),
    max_unclaimed_raw: maxRaw("total_unclaimed_raw")
  };
}

export function syntheticHistoryRow(index: number, overrides: Partial<HistoryObservationRow> = {}): HistoryObservationRow {
  const payloadHashHex = sha256Hex(`probe-payload-${index}`);
  return {
    row_version: HISTORY_ROW_VERSION,
    snapshot_index: index,
    observed_at_unix: 1780819200 + index * 900,
    octra_epoch: 1_000_000 + index,
    external_block: 25_000_000 + index,
    max_supply_raw: "1000000000000000",
    issued_raw: "622000000000000",
    burned_raw: "378000000000000",
    encrypted_raw: "12413100000000",
    total_locked_raw: "200000000000000",
    total_wrapped_raw: "190000000000000",
    total_unclaimed_raw: "10000000000000",
    vault_balance_raw: "200000000000000",
    unit_status: "00",
    conservation_status: "G",
    route_count: 1,
    payload_hash_hex: payloadHashHex,
    ...overrides
  };
}

export function encodeHistoryRow(row: HistoryObservationRow): string {
  if (row.row_version !== HISTORY_ROW_VERSION) throw new Error(`unsupported row_version ${row.row_version}`);
  if (!/^\d{2}$/.test(row.unit_status)) throw new Error("unit_status must be 2 decimal digits");
  if (!/^[GYRU]$/.test(row.conservation_status)) throw new Error("conservation_status must be G, Y, R, or U");
  const fields = [
    row.row_version,
    digits(row.snapshot_index, 10, "snapshot_index"),
    digits(row.observed_at_unix, 12, "observed_at_unix"),
    digits(row.octra_epoch, 12, "octra_epoch"),
    digits(row.external_block, 12, "external_block"),
    digits(row.max_supply_raw, 20, "max_supply_raw"),
    digits(row.issued_raw, 20, "issued_raw"),
    digits(row.burned_raw, 20, "burned_raw"),
    digits(row.encrypted_raw, 20, "encrypted_raw"),
    digits(row.total_locked_raw, 20, "total_locked_raw"),
    digits(row.total_wrapped_raw, 20, "total_wrapped_raw"),
    digits(row.total_unclaimed_raw, 20, "total_unclaimed_raw"),
    digits(row.vault_balance_raw, 20, "vault_balance_raw"),
    row.unit_status,
    row.conservation_status,
    digits(row.route_count, 4, "route_count"),
    hex64(row.payload_hash_hex, "payload_hash_hex")
  ];
  const encoded = fields.join("|");
  if (encoded.length !== HISTORY_ROW_LEN) {
    throw new Error(`history row length ${encoded.length} did not match ${HISTORY_ROW_LEN}`);
  }
  return encoded;
}

export function decodeHistoryRow(encoded: string): HistoryObservationRow {
  if (encoded.length !== HISTORY_ROW_LEN) {
    throw new Error(`history row length ${encoded.length} did not match ${HISTORY_ROW_LEN}`);
  }
  const fields = encoded.split("|");
  if (fields.length !== 17) throw new Error(`history row had ${fields.length} fields`);
  const [
    rowVersion,
    index,
    observed,
    epoch,
    block,
    maxSupply,
    issued,
    burned,
    encrypted,
    locked,
    wrapped,
    unclaimed,
    vault,
    unitStatus,
    conservation,
    routes,
    payloadHashHex
  ] = fields;
  if (rowVersion !== HISTORY_ROW_VERSION) throw new Error(`unsupported row version ${rowVersion}`);
  if (!unitStatus || !/^\d{2}$/.test(unitStatus)) throw new Error("invalid unit status");
  if (conservation !== "G" && conservation !== "Y" && conservation !== "R" && conservation !== "U") {
    throw new Error("invalid conservation status");
  }
  return {
    row_version: rowVersion,
    snapshot_index: parseUnsigned(index, "snapshot_index"),
    observed_at_unix: parseUnsigned(observed, "observed_at_unix"),
    octra_epoch: parseUnsigned(epoch, "octra_epoch"),
    external_block: parseUnsigned(block, "external_block"),
    max_supply_raw: parseRaw(maxSupply, "max_supply_raw"),
    issued_raw: parseRaw(issued, "issued_raw"),
    burned_raw: parseRaw(burned, "burned_raw"),
    encrypted_raw: parseRaw(encrypted, "encrypted_raw"),
    total_locked_raw: parseRaw(locked, "total_locked_raw"),
    total_wrapped_raw: parseRaw(wrapped, "total_wrapped_raw"),
    total_unclaimed_raw: parseRaw(unclaimed, "total_unclaimed_raw"),
    vault_balance_raw: parseRaw(vault, "vault_balance_raw"),
    unit_status: unitStatus,
    conservation_status: conservation,
    route_count: parseUnsigned(routes, "route_count"),
    payload_hash_hex: hex64(payloadHashHex || "", "payload_hash_hex")
  };
}

export function encodeCapsuleMeta(meta: CapsuleMeta): string {
  if (meta.version !== HISTORY_ROW_VERSION) throw new Error(`unsupported meta version ${meta.version}`);
  if (!/^\d{2}$/.test(meta.history_schema_id)) throw new Error("history_schema_id must be 2 decimal digits");
  if (meta.row_len !== HISTORY_ROW_LEN) throw new Error("row_len must match HISTORY_ROW_LEN");
  if (meta.row_count < 0 || meta.last_index - meta.first_index + 1 !== meta.row_count) throw new Error("capsule index span must match row_count");
  if (!/^\d{4}-\d{2}-\d{2}T(00|12)$/.test(meta.capsule_id)) throw new Error("capsule_id must be a 12h UTC id");
  const fields = [
    meta.version,
    capsuleFamilyCode(meta.capsule_family),
    meta.history_schema_id,
    meta.sealed ? "1" : "0",
    meta.capsule_id,
    digits(meta.first_index, 10, "first_index"),
    digits(meta.last_index, 10, "last_index"),
    digits(meta.row_count, 6, "row_count"),
    digits(meta.row_len, 4, "row_len"),
    digits(meta.first_observed_unix, 12, "first_observed_unix"),
    digits(meta.last_observed_unix, 12, "last_observed_unix"),
    hex64(meta.body_hash_hex, "body_hash_hex"),
    hex64(meta.start_root_hex, "start_root_hex"),
    hex64(meta.end_root_hex, "end_root_hex"),
    hex64(meta.tx_index_hash_hex, "tx_index_hash_hex")
  ];
  const encoded = fields.join("|");
  if (encoded.length !== CAPSULE_META_LEN) {
    throw new Error(`capsule meta length ${encoded.length} did not match ${CAPSULE_META_LEN}`);
  }
  return encoded;
}

export function decodeCapsuleMeta(encoded: string): CapsuleMeta {
  if (encoded.length !== CAPSULE_META_LEN) {
    throw new Error(`capsule meta length ${encoded.length} did not match ${CAPSULE_META_LEN}`);
  }
  const fields = encoded.split("|");
  if (fields.length !== 15) throw new Error(`capsule meta had ${fields.length} fields`);
  const [
    version,
    familyCode,
    schemaId,
    sealed,
    capsuleId,
    firstIndex,
    lastIndex,
    rowCount,
    rowLen,
    firstObserved,
    lastObserved,
    bodyHash,
    startRoot,
    endRoot,
    txIndexHash
  ] = fields;
  if (version !== HISTORY_ROW_VERSION) throw new Error(`unsupported meta version ${version}`);
  if (sealed !== "0" && sealed !== "1") throw new Error("sealed must be 0 or 1");
  const decodedRowCount = parseUnsigned(rowCount, "row_count");
  return {
    version,
    capsule_family: capsuleFamilyFromCode(familyCode || ""),
    history_schema_id: schemaId || "",
    sealed: sealed === "1",
    capsule_id: capsuleId || "",
    first_index: parseUnsigned(firstIndex, "first_index"),
    last_index: parseUnsigned(lastIndex, "last_index"),
    row_count: decodedRowCount,
    row_len: parseUnsigned(rowLen, "row_len"),
    first_observed_unix: parseUnsigned(firstObserved, "first_observed_unix"),
    last_observed_unix: parseUnsigned(lastObserved, "last_observed_unix"),
    body_hash_hex: hex64(bodyHash || "", "body_hash_hex"),
    start_root_hex: hex64(startRoot || "", "start_root_hex"),
    end_root_hex: hex64(endRoot || "", "end_root_hex"),
    tx_index_hash_hex: hex64(txIndexHash || "", "tx_index_hash_hex")
  };
}

export function makeCapsule(
  rows: HistoryObservationRow[],
  options: {
    capsuleId?: string;
    startRootHex?: string;
    sealed?: boolean;
    txIndex?: string;
  } = {}
): HistoryCapsule {
  if (rows.length === 0) throw new Error("capsule requires at least one row");
  const encodedRows = rows.map((row) => encodeHistoryRow(row));
  const firstIndex = rows[0]?.snapshot_index;
  const lastIndex = rows[rows.length - 1]?.snapshot_index;
  if (firstIndex === undefined || lastIndex === undefined) throw new Error("capsule row indexes missing");
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row) throw new Error("capsule row missing");
    const expectedIndex = firstIndex + index;
    if (row.snapshot_index !== expectedIndex) {
      throw new Error(`capsule row index drift: expected ${expectedIndex}, got ${row.snapshot_index}`);
    }
  }
  const body = encodedRows.join("");
  const startRootHex = options.startRootHex ? hex64(options.startRootHex, "startRootHex") : emptyHistoryRootHex();
  const endRootHex = foldHistoryRootHex(startRootHex, encodedRows);
  const txIndex = options.txIndex ?? "";
  const txIndexHashHex = txIndex.length > 0 ? capsuleTxIndexHashHex(txIndex) : ZERO_HASH_HEX;
  const firstRow = rows[0];
  const lastRow = rows[rows.length - 1];
  if (!firstRow || !lastRow) throw new Error("capsule rows missing");
  const meta: CapsuleMeta = {
    version: HISTORY_ROW_VERSION,
    capsule_family: CORE_CAPSULE_FAMILY,
    history_schema_id: HISTORY_SCHEMA_ID,
    sealed: options.sealed ?? true,
    capsule_id: options.capsuleId || capsuleIdForUnix(firstRow.observed_at_unix),
    first_index: firstIndex,
    last_index: lastIndex,
    row_count: rows.length,
    row_len: HISTORY_ROW_LEN,
    first_observed_unix: firstRow.observed_at_unix,
    last_observed_unix: lastRow.observed_at_unix,
    body_hash_hex: capsuleBodyHashHex(body),
    start_root_hex: startRootHex,
    end_root_hex: endRootHex,
    tx_index_hash_hex: txIndexHashHex
  };
  const metaRow = encodeCapsuleMeta(meta);
  return {
    body,
    body_hash_hex: meta.body_hash_hex,
    meta,
    meta_row: metaRow,
    meta_hash_hex: capsuleMetaHashHex(metaRow),
    rows
  };
}

export function makeTxIndex(txHashes: string[]): string {
  return txHashes.map((hash) => hex64(hash, "tx_hash")).join("");
}

export function syntheticTxHash(index: number): string {
  return sha256Hex(`probe-tx-${index}`);
}

export function estimateProbe(rowCount: number, includeCalendar = true, includeTxIndex = true): ProbeEstimate {
  if (!Number.isInteger(rowCount) || rowCount <= 0) throw new Error("rowCount must be a positive integer");
  const bodyBytes = rowCount * HISTORY_ROW_LEN;
  const metaBytes = CAPSULE_META_LEN;
  const txIndexBytes = includeTxIndex ? rowCount * TX_HASH_HEX_LEN : 0;
  const estimatedCalendarStatBytes = includeCalendar ? CALENDAR_STAT_NODE_LEN * 4 : 0;
  return {
    row_count: rowCount,
    hours_at_15m: rowCount / 4,
    row_len: HISTORY_ROW_LEN,
    body_bytes: bodyBytes,
    meta_bytes: metaBytes,
    tx_index_bytes: txIndexBytes,
    body_with_meta_bytes: bodyBytes + metaBytes,
    body_meta_tx_index_bytes: bodyBytes + metaBytes + txIndexBytes,
    estimated_calendar_stat_bytes: estimatedCalendarStatBytes,
    estimated_append_rewrite_bytes_without_calendar: bodyBytes + metaBytes,
    estimated_append_rewrite_bytes_with_calendar: bodyBytes + metaBytes + estimatedCalendarStatBytes
  };
}

export function buildProbeEstimates(rowCounts = [12, 24, 48, 96, 192, 384]): ProbeEstimate[] {
  return rowCounts.map((rowCount) => estimateProbe(rowCount));
}
