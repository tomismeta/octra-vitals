import { sha256Hex } from "./canonical-json.js";
import type { SnapshotArtifact, SnapshotPayload } from "./types.js";

export const HISTORY_V1_SCHEMA_VERSION = "octra-vitals-history-row-v1";
export const HISTORY_V1_ROW_VERSION = "00";
export const HISTORY_V1_SCHEMA_ID = "00";
export const HISTORY_V1_ROW_LEN = 295;
export const HISTORY_V1_CAPSULE_META_LEN = 416;
export const HISTORY_V1_CAPSULE_ROW_LIMIT = 48;
export const HISTORY_V1_ROW_HASH_DOMAIN = "octra-vitals:history-row:v1";
export const HISTORY_V1_ROOT_DOMAIN = "octra-vitals:history-root:v1";
export const HISTORY_V1_CAPSULE_BODY_HASH_DOMAIN = "octra-vitals:capsule-body:v1";
export const HISTORY_V1_CAPSULE_META_HASH_DOMAIN = "octra-vitals:capsule-meta:v1";
export const HISTORY_V1_CAPSULES_ROOT_HASH_DOMAIN = "octra-vitals:capsules-root:v1";
export const EMPTY_TX_INDEX_HASH_HEX = "0".repeat(64);

export interface HistoryV1ObservationRow {
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

export interface HistoryV1CapsuleMeta {
  version: string;
  capsule_family_code: string;
  history_schema_id: string;
  sealed: boolean;
  capsule_id: string;
  first_index: string;
  last_index: string;
  row_count: string;
  row_len: string;
  first_observed_unix: string;
  last_observed_unix: string;
  body_hash_hex: string;
  start_root_hex: string;
  end_root_hex: string;
  tx_index_hash_hex: string;
  capsules_root_before_hex: string;
}

function taggedHashHex(domain: string, value: string): string {
  return sha256Hex(`${domain}\n${value}`);
}

function digits(value: string | number | bigint, width: number, label: string): string {
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new Error(`${label} must be unsigned decimal digits`);
  if (text.length > width) throw new Error(`${label} exceeds ${width} digits`);
  return text.padStart(width, "0");
}

function raw(value: string | undefined, label: string): string {
  if (!value || !/^\d+$/.test(value)) throw new Error(`${label} must be unsigned decimal digits`);
  return String(BigInt(value));
}

function parseUnsignedNumber(value: string | undefined, label: string): number {
  if (!value || !/^\d+$/.test(value)) throw new Error(`${label} must be unsigned decimal digits`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is outside the safe integer range`);
  return parsed;
}

function hex64(value: string, label: string): string {
  const normalized = value.replace(/^sha256:/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} must be 64 hex chars`);
  return normalized;
}

function observedUnix(value: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`invalid observed_at: ${value}`);
  return Math.floor(ms / 1000);
}

function blockNumber(value: string | number | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  if (!value) return 0;
  const parsed = value.startsWith("0x") ? Number.parseInt(value, 16) : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function routeCount(payload: SnapshotPayload): number {
  return Array.isArray(payload.routes) ? payload.routes.length : 1;
}

function conservationStatus(payload: SnapshotPayload): HistoryV1ObservationRow["conservation_status"] {
  const status = payload.health?.conservation?.status;
  if (status === "green") return "G";
  if (status === "yellow") return "Y";
  if (status === "red") return "R";
  return "U";
}

function unitStatus(payload: SnapshotPayload): string {
  return payload.units.oct_decimals === 6 && payload.units.woct_decimals === 6 ? "00" : "01";
}

export function historyV1EmptyHistoryRootHex(): string {
  return taggedHashHex(HISTORY_V1_ROOT_DOMAIN, "");
}

export function historyV1EmptyCapsulesRootHex(): string {
  return taggedHashHex(HISTORY_V1_CAPSULES_ROOT_HASH_DOMAIN, "");
}

export function historyV1RowHashHex(encodedRow: string): string {
  if (encodedRow.length !== HISTORY_V1_ROW_LEN) throw new Error("history v1 row length mismatch");
  return taggedHashHex(HISTORY_V1_ROW_HASH_DOMAIN, encodedRow);
}

export function historyV1FoldHistoryRootHex(startRootHex: string, encodedRows: string[]): string {
  let rootHex = hex64(startRootHex, "start_root_hex");
  for (const row of encodedRows) {
    rootHex = taggedHashHex(HISTORY_V1_ROOT_DOMAIN, `${rootHex}\n${historyV1RowHashHex(row)}`);
  }
  return rootHex;
}

export function historyV1CapsuleBodyHashHex(body: string): string {
  if (body.length % HISTORY_V1_ROW_LEN !== 0) throw new Error("capsule body must be row aligned");
  return taggedHashHex(HISTORY_V1_CAPSULE_BODY_HASH_DOMAIN, body);
}

export function historyV1CapsuleMetaHashHex(metaRow: string): string {
  if (metaRow.length !== HISTORY_V1_CAPSULE_META_LEN) throw new Error("capsule meta length mismatch");
  return taggedHashHex(HISTORY_V1_CAPSULE_META_HASH_DOMAIN, metaRow);
}

export function historyV1FoldCapsulesRootHex(
  capsulesRootBeforeHex: string,
  capsuleId: string,
  bodyHashHex: string,
  metaHashHex: string,
  endRootHex: string
): string {
  return taggedHashHex(
    HISTORY_V1_CAPSULES_ROOT_HASH_DOMAIN,
    `${hex64(capsulesRootBeforeHex, "capsules_root_before_hex")}\n${capsuleId}\n${hex64(bodyHashHex, "body_hash_hex")}\n${hex64(metaHashHex, "meta_hash_hex")}\n${hex64(endRootHex, "end_root_hex")}`
  );
}

export function capsuleIdForObservedAt(observedAt: string, segment = 0): string {
  const date = new Date(observedAt);
  if (!Number.isFinite(date.getTime())) throw new Error(`invalid observed_at: ${observedAt}`);
  if (!Number.isSafeInteger(segment) || segment < 0 || segment > 9999) throw new Error("capsule segment must be 0..9999");
  const day = date.toISOString().slice(0, 10);
  const boundary = date.getUTCHours() < 12 ? "00" : "12";
  return `${day}T${boundary}.${String(segment).padStart(4, "0")}`;
}

export function capsuleBaseIdForObservedAt(observedAt: string): string {
  return capsuleIdForObservedAt(observedAt).slice(0, 13);
}

export function historyV1RowFromSnapshot(snapshot: SnapshotArtifact, snapshotIndex: number): HistoryV1ObservationRow {
  const payload = snapshot.envelope.payload;
  return {
    row_version: HISTORY_V1_ROW_VERSION,
    snapshot_index: snapshotIndex,
    observed_at_unix: observedUnix(snapshot.envelope.observed_at),
    octra_epoch: Number(payload.octra.epoch || 0),
    external_block: blockNumber(payload.ethereum?.block_number),
    max_supply_raw: raw(payload.supply.max_oct_raw, "max_oct_raw"),
    issued_raw: raw(payload.supply.issued_oct_raw, "issued_oct_raw"),
    burned_raw: raw(payload.supply.confirmed_burned_oct_raw || payload.supply.burned_oct_raw, "burned_oct_raw"),
    encrypted_raw: raw(payload.supply.encrypted_oct_raw, "encrypted_oct_raw"),
    total_locked_raw: raw(payload.bridge.total_locked_oct_raw, "total_locked_oct_raw"),
    total_wrapped_raw: raw(payload.bridge.woct_supply_raw, "woct_supply_raw"),
    total_unclaimed_raw: raw(payload.bridge.unclaimed_oct_raw, "unclaimed_oct_raw"),
    vault_balance_raw: raw(payload.bridge.vault_balance_oct_raw, "vault_balance_oct_raw"),
    unit_status: unitStatus(payload),
    conservation_status: conservationStatus(payload),
    route_count: routeCount(payload),
    payload_hash_hex: hex64(snapshot.envelope.payload_hash, "payload_hash")
  };
}

export function encodeHistoryV1Row(row: HistoryV1ObservationRow): string {
  if (row.row_version !== HISTORY_V1_ROW_VERSION) throw new Error(`unsupported history v1 row version ${row.row_version}`);
  if (!/^\d{2}$/.test(row.unit_status)) throw new Error("unit_status must be 2 decimal digits");
  if (!/^[GYRU]$/.test(row.conservation_status)) throw new Error("conservation_status must be G, Y, R, or U");
  const encoded = [
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
  ].join("|");
  if (encoded.length !== HISTORY_V1_ROW_LEN) {
    throw new Error(`history v1 row length ${encoded.length} did not match ${HISTORY_V1_ROW_LEN}`);
  }
  return encoded;
}

export function decodeHistoryV1Row(encoded: string): HistoryV1ObservationRow {
  if (encoded.length !== HISTORY_V1_ROW_LEN) {
    throw new Error(`history v1 row length ${encoded.length} did not match ${HISTORY_V1_ROW_LEN}`);
  }
  const fields = encoded.split("|");
  if (fields.length !== 17) throw new Error(`history v1 row had ${fields.length} fields`);
  const [
    rowVersion,
    snapshotIndex,
    observedAtUnix,
    octraEpoch,
    externalBlock,
    maxSupply,
    issued,
    burned,
    encrypted,
    locked,
    wrapped,
    unclaimed,
    vaultBalance,
    unitStatus,
    conservation,
    routeCountValue,
    payloadHash
  ] = fields;
  if (rowVersion !== HISTORY_V1_ROW_VERSION) throw new Error(`unsupported history v1 row version ${rowVersion}`);
  if (!unitStatus || !/^\d{2}$/.test(unitStatus)) throw new Error("unit_status must be 2 decimal digits");
  if (conservation !== "G" && conservation !== "Y" && conservation !== "R" && conservation !== "U") {
    throw new Error("conservation_status must be G, Y, R, or U");
  }
  return {
    row_version: rowVersion,
    snapshot_index: parseUnsignedNumber(snapshotIndex, "snapshot_index"),
    observed_at_unix: parseUnsignedNumber(observedAtUnix, "observed_at_unix"),
    octra_epoch: parseUnsignedNumber(octraEpoch, "octra_epoch"),
    external_block: parseUnsignedNumber(externalBlock, "external_block"),
    max_supply_raw: raw(maxSupply, "max_supply_raw"),
    issued_raw: raw(issued, "issued_raw"),
    burned_raw: raw(burned, "burned_raw"),
    encrypted_raw: raw(encrypted, "encrypted_raw"),
    total_locked_raw: raw(locked, "total_locked_raw"),
    total_wrapped_raw: raw(wrapped, "total_wrapped_raw"),
    total_unclaimed_raw: raw(unclaimed, "total_unclaimed_raw"),
    vault_balance_raw: raw(vaultBalance, "vault_balance_raw"),
    unit_status: unitStatus,
    conservation_status: conservation,
    route_count: parseUnsignedNumber(routeCountValue, "route_count"),
    payload_hash_hex: hex64(payloadHash || "", "payload_hash_hex")
  };
}

export function decodeHistoryV1Rows(body: string): HistoryV1ObservationRow[] {
  if (body.length % HISTORY_V1_ROW_LEN !== 0) throw new Error("history v1 body is not row aligned");
  const rows: HistoryV1ObservationRow[] = [];
  for (let offset = 0; offset < body.length; offset += HISTORY_V1_ROW_LEN) {
    rows.push(decodeHistoryV1Row(body.slice(offset, offset + HISTORY_V1_ROW_LEN)));
  }
  return rows;
}

export function encodeHistoryV1CapsuleMeta(meta: HistoryV1CapsuleMeta): string {
  const encoded = [
    meta.version,
    meta.capsule_family_code,
    meta.history_schema_id,
    meta.sealed ? "1" : "0",
    meta.capsule_id,
    meta.first_index,
    meta.last_index,
    meta.row_count,
    meta.row_len,
    meta.first_observed_unix,
    meta.last_observed_unix,
    hex64(meta.body_hash_hex, "body_hash_hex"),
    hex64(meta.start_root_hex, "start_root_hex"),
    hex64(meta.end_root_hex, "end_root_hex"),
    hex64(meta.tx_index_hash_hex, "tx_index_hash_hex"),
    hex64(meta.capsules_root_before_hex, "capsules_root_before_hex")
  ].join("|");
  if (encoded.length !== HISTORY_V1_CAPSULE_META_LEN) {
    throw new Error(`history v1 capsule meta length ${encoded.length} did not match ${HISTORY_V1_CAPSULE_META_LEN}`);
  }
  return encoded;
}

export function decodeHistoryV1CapsuleMeta(encoded: string): HistoryV1CapsuleMeta {
  if (encoded.length !== HISTORY_V1_CAPSULE_META_LEN) {
    throw new Error(`history v1 capsule meta length ${encoded.length} did not match ${HISTORY_V1_CAPSULE_META_LEN}`);
  }
  const fields = encoded.split("|");
  if (fields.length !== 16) throw new Error(`history v1 capsule meta had ${fields.length} fields`);
  const [
    version = "",
    capsuleFamilyCode = "",
    historySchemaId = "",
    sealed = "",
    capsuleId = "",
    firstIndex = "",
    lastIndex = "",
    rowCount = "",
    rowLen = "",
    firstObservedUnix = "",
    lastObservedUnix = "",
    bodyHashHex = "",
    startRootHex = "",
    endRootHex = "",
    txIndexHashHex = "",
    capsulesRootBeforeHex = ""
  ] = fields;
  if (version !== HISTORY_V1_ROW_VERSION) throw new Error(`unsupported capsule meta version ${version}`);
  if (!capsuleFamilyCode || !/^\d{4}$/.test(capsuleFamilyCode)) throw new Error("capsule_family_code must be 4 decimal digits");
  if (historySchemaId !== HISTORY_V1_SCHEMA_ID) throw new Error(`unsupported history schema id ${historySchemaId}`);
  if (sealed !== "1" && sealed !== "0") throw new Error("sealed flag must be 0 or 1");
  if (!capsuleId || !/^\d{4}-\d{2}-\d{2}T(00|12)\.\d{4}$/.test(capsuleId)) throw new Error("capsule_id is malformed");
  for (const [label, value, width] of [
    ["first_index", firstIndex, 10],
    ["last_index", lastIndex, 10],
    ["row_count", rowCount, 6],
    ["row_len", rowLen, 4],
    ["first_observed_unix", firstObservedUnix, 12],
    ["last_observed_unix", lastObservedUnix, 12]
  ] as const) {
    if (!value || !new RegExp(`^\\d{${width}}$`).test(value)) throw new Error(`${label} must be ${width} decimal digits`);
  }
  if (Number(rowLen) !== HISTORY_V1_ROW_LEN) throw new Error(`capsule meta row_len must be ${HISTORY_V1_ROW_LEN}`);
  return {
    version,
    capsule_family_code: capsuleFamilyCode,
    history_schema_id: historySchemaId,
    sealed: sealed === "1",
    capsule_id: capsuleId,
    first_index: firstIndex,
    last_index: lastIndex,
    row_count: rowCount,
    row_len: rowLen,
    first_observed_unix: firstObservedUnix,
    last_observed_unix: lastObservedUnix,
    body_hash_hex: hex64(bodyHashHex || "", "body_hash_hex"),
    start_root_hex: hex64(startRootHex || "", "start_root_hex"),
    end_root_hex: hex64(endRootHex || "", "end_root_hex"),
    tx_index_hash_hex: hex64(txIndexHashHex || "", "tx_index_hash_hex"),
    capsules_root_before_hex: hex64(capsulesRootBeforeHex || "", "capsules_root_before_hex")
  };
}

export function historyV1CapsuleMetaFromBody(input: {
  capsuleId: string;
  body: string;
  startRootHex: string;
  capsulesRootBeforeHex: string;
}): { meta: HistoryV1CapsuleMeta; meta_row: string; body_hash_hex: string; meta_hash_hex: string; end_root_hex: string; root_after_hex: string } {
  if (input.body.length % HISTORY_V1_ROW_LEN !== 0) throw new Error("capsule body must be row aligned");
  const rowCount = input.body.length / HISTORY_V1_ROW_LEN;
  if (rowCount < 1) throw new Error("capsule body must contain at least one row");
  if (rowCount > HISTORY_V1_CAPSULE_ROW_LIMIT) throw new Error(`capsule body exceeds ${HISTORY_V1_CAPSULE_ROW_LIMIT} rows`);
  const firstRow = input.body.slice(0, HISTORY_V1_ROW_LEN);
  const lastRow = input.body.slice(input.body.length - HISTORY_V1_ROW_LEN);
  const bodyHashHex = historyV1CapsuleBodyHashHex(input.body);
  const encodedRows: string[] = [];
  for (let offset = 0; offset < input.body.length; offset += HISTORY_V1_ROW_LEN) {
    encodedRows.push(input.body.slice(offset, offset + HISTORY_V1_ROW_LEN));
  }
  const endRootHex = historyV1FoldHistoryRootHex(input.startRootHex, encodedRows);
  const meta: HistoryV1CapsuleMeta = {
    version: HISTORY_V1_ROW_VERSION,
    capsule_family_code: "0000",
    history_schema_id: HISTORY_V1_SCHEMA_ID,
    sealed: true,
    capsule_id: input.capsuleId,
    first_index: firstRow.slice(3, 13),
    last_index: lastRow.slice(3, 13),
    row_count: digits(rowCount, 6, "row_count"),
    row_len: "0295",
    first_observed_unix: firstRow.slice(14, 26),
    last_observed_unix: lastRow.slice(14, 26),
    body_hash_hex: bodyHashHex,
    start_root_hex: input.startRootHex,
    end_root_hex: endRootHex,
    tx_index_hash_hex: EMPTY_TX_INDEX_HASH_HEX,
    capsules_root_before_hex: input.capsulesRootBeforeHex
  };
  const metaRow = encodeHistoryV1CapsuleMeta(meta);
  const metaHashHex = historyV1CapsuleMetaHashHex(metaRow);
  const rootAfterHex = historyV1FoldCapsulesRootHex(input.capsulesRootBeforeHex, input.capsuleId, bodyHashHex, metaHashHex, endRootHex);
  return { meta, meta_row: metaRow, body_hash_hex: bodyHashHex, meta_hash_hex: metaHashHex, end_root_hex: endRootHex, root_after_hex: rootAfterHex };
}
