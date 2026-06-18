import { sha256Tagged } from "./canonical-json.js";
import type { SnapshotArtifact, SnapshotPayload } from "./types.js";

export const SUMMARY_ROW_VERSION = "00";
export const SUMMARY_SCHEMA_VERSION = "octra-vitals-summary-row-v0";
export const SUMMARY_HASH_DOMAIN = "octra-vitals:summary:v0";
export const SUMMARY_WINDOW_HASH_DOMAIN = "octra-vitals:summary-window:v0";
export const SUMMARY_ROW_LEN = 208;
export const SUMMARY_WINDOW_ROWS = 48;
export const SUMMARY_WINDOW_BYTES = SUMMARY_ROW_LEN * SUMMARY_WINDOW_ROWS;
export const PAYLOAD_HASH_PREFIX_LEN = 24;

export interface SummaryRow {
  row_version: string;
  snapshot_index: number;
  observed_at_unix: number;
  octra_epoch: number;
  external_block: number;
  issued_raw: string;
  burned_raw: string;
  encrypted_raw: string;
  total_locked_raw: string;
  total_wrapped_raw: string;
  total_unclaimed_raw: string;
  route_count: number;
  payload_hash_prefix: string;
}

export interface ProgramHistoryWindow {
  first_index: number;
  row_count: number;
  row_len: number;
  window: string;
  window_hash: string;
  rows: SummaryRow[];
}

function digits(value: string | number | bigint, width: number, label: string): string {
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new Error(`${label} must be unsigned decimal digits`);
  if (text.length > width) throw new Error(`${label} exceeds ${width} digits`);
  return text.padStart(width, "0");
}

function parseUnsignedNumber(value: string | undefined, label: string): number {
  if (!value || !/^\d+$/.test(value)) throw new Error(`${label} must be unsigned decimal digits`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is outside the safe integer range`);
  return parsed;
}

function parseRaw(value: string | undefined, label: string): string {
  if (!value || !/^\d+$/.test(value)) throw new Error(`${label} must be unsigned decimal digits`);
  return String(BigInt(value));
}

function hashPrefix(hash: string): string {
  const hex = hash.replace(/^sha256:/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`invalid payload hash: ${hash}`);
  return hex.slice(0, PAYLOAD_HASH_PREFIX_LEN);
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

function assertOctDenominatedRoutes(payload: SnapshotPayload): void {
  if (!Array.isArray(payload.routes) || payload.routes.length !== 1) {
    throw new Error("summary row v0 requires exactly one OCT-denominated route");
  }
  for (const route of payload.routes) {
    const asset = String(route.asset || "").toLowerCase();
    if (asset !== "oct" && asset !== "woct") {
      throw new Error(`summary row only supports OCT-denominated routes; got ${route.asset || "unknown"}`);
    }
    if (route.locked_raw !== payload.bridge.total_locked_oct_raw) {
      throw new Error("summary route locked_raw does not match top-level bridge total_locked_oct_raw");
    }
    if (route.wrapped_supply_raw !== payload.bridge.woct_supply_raw) {
      throw new Error("summary route wrapped_supply_raw does not match top-level bridge woct_supply_raw");
    }
    if (route.unclaimed_raw !== payload.bridge.unclaimed_oct_raw) {
      throw new Error("summary route unclaimed_raw does not match top-level bridge unclaimed_oct_raw");
    }
  }
}

export function summaryRowFromSnapshot(snapshot: SnapshotArtifact, snapshotIndex: number): SummaryRow {
  const payload = snapshot.envelope.payload;
  assertOctDenominatedRoutes(payload);
  return {
    row_version: SUMMARY_ROW_VERSION,
    snapshot_index: snapshotIndex,
    observed_at_unix: observedUnix(snapshot.envelope.observed_at),
    octra_epoch: Number(payload.octra.epoch || 0),
    external_block: blockNumber(payload.ethereum?.block_number),
    issued_raw: payload.supply.issued_oct_raw,
    burned_raw: payload.supply.confirmed_burned_oct_raw || payload.supply.burned_oct_raw,
    encrypted_raw: payload.supply.encrypted_oct_raw,
    total_locked_raw: payload.bridge.total_locked_oct_raw,
    total_wrapped_raw: payload.bridge.woct_supply_raw,
    total_unclaimed_raw: payload.bridge.unclaimed_oct_raw,
    route_count: routeCount(payload),
    payload_hash_prefix: hashPrefix(snapshot.envelope.payload_hash)
  };
}

export function encodeSummaryRow(row: SummaryRow): string {
  if (!/^\d{2}$/.test(row.row_version)) throw new Error("row_version must be 2 decimal digits");
  const fields = [
    row.row_version,
    digits(row.snapshot_index, 10, "snapshot_index"),
    digits(row.observed_at_unix, 12, "observed_at_unix"),
    digits(row.octra_epoch, 12, "octra_epoch"),
    digits(row.external_block, 12, "external_block"),
    digits(row.issued_raw, 20, "issued_raw"),
    digits(row.burned_raw, 20, "burned_raw"),
    digits(row.encrypted_raw, 20, "encrypted_raw"),
    digits(row.total_locked_raw, 20, "total_locked_raw"),
    digits(row.total_wrapped_raw, 20, "total_wrapped_raw"),
    digits(row.total_unclaimed_raw, 20, "total_unclaimed_raw"),
    digits(row.route_count, 4, "route_count"),
    row.payload_hash_prefix.toLowerCase()
  ];
  const prefix = fields[12] || "";
  if (!/^[0-9a-f]{24}$/.test(prefix)) throw new Error("payload_hash_prefix must be 24 hex chars");
  const encoded = fields.join("|");
  if (encoded.length !== SUMMARY_ROW_LEN) {
    throw new Error(`summary row length ${encoded.length} did not match ${SUMMARY_ROW_LEN}`);
  }
  return encoded;
}

export function decodeSummaryRow(encoded: string): SummaryRow {
  if (encoded.length !== SUMMARY_ROW_LEN) {
    throw new Error(`summary row length ${encoded.length} did not match ${SUMMARY_ROW_LEN}`);
  }
  const fields = encoded.split("|");
  if (fields.length !== 13) throw new Error(`summary row had ${fields.length} fields`);
  const [rowVersion, index, observed, epoch, block, issued, burned, encrypted, locked, wrapped, unclaimed, routes, prefix] = fields;
  if (rowVersion !== SUMMARY_ROW_VERSION) throw new Error(`unsupported summary row version ${rowVersion}`);
  if (!prefix || !/^[0-9a-f]{24}$/.test(prefix)) throw new Error("invalid payload hash prefix");
  return {
    row_version: rowVersion,
    snapshot_index: parseUnsignedNumber(index, "snapshot_index"),
    observed_at_unix: parseUnsignedNumber(observed, "observed_at_unix"),
    octra_epoch: parseUnsignedNumber(epoch, "octra_epoch"),
    external_block: parseUnsignedNumber(block, "external_block"),
    issued_raw: parseRaw(issued, "issued_raw"),
    burned_raw: parseRaw(burned, "burned_raw"),
    encrypted_raw: parseRaw(encrypted, "encrypted_raw"),
    total_locked_raw: parseRaw(locked, "total_locked_raw"),
    total_wrapped_raw: parseRaw(wrapped, "total_wrapped_raw"),
    total_unclaimed_raw: parseRaw(unclaimed, "total_unclaimed_raw"),
    route_count: parseUnsignedNumber(routes, "route_count"),
    payload_hash_prefix: prefix
  };
}

export function summaryHash(encodedRow: string): string {
  return sha256Tagged(SUMMARY_HASH_DOMAIN, encodedRow);
}

export function summaryWindowHash(window: string): string {
  return sha256Tagged(SUMMARY_WINDOW_HASH_DOMAIN, window);
}

export function rollSummaryWindow(window: string, rowCount: number, firstIndex: number, nextIndex: number, encodedRow: string): ProgramHistoryWindow {
  if (encodedRow.length !== SUMMARY_ROW_LEN) throw new Error("encoded row length mismatch");
  if (window.length !== rowCount * SUMMARY_ROW_LEN) throw new Error("window length does not match row_count");
  let nextWindow: string;
  let nextRowCount: number;
  let nextFirstIndex: number;
  if (rowCount < SUMMARY_WINDOW_ROWS) {
    nextWindow = window + encodedRow;
    nextRowCount = rowCount + 1;
    nextFirstIndex = rowCount === 0 ? nextIndex : firstIndex;
  } else {
    nextWindow = window.slice(SUMMARY_ROW_LEN) + encodedRow;
    nextRowCount = SUMMARY_WINDOW_ROWS;
    nextFirstIndex = nextIndex - SUMMARY_WINDOW_ROWS + 1;
  }
  return parseSummaryWindow(nextWindow, nextFirstIndex, nextRowCount);
}

export function parseSummaryWindow(window: string, firstIndex: number, rowCount: number, expectedHash?: string): ProgramHistoryWindow {
  if (rowCount < 0 || rowCount > SUMMARY_WINDOW_ROWS) throw new Error("invalid summary row_count");
  if (window.length !== rowCount * SUMMARY_ROW_LEN) throw new Error("summary window length does not match row_count");
  if (window.length > SUMMARY_WINDOW_BYTES) throw new Error("summary window exceeds max bytes");
  const actualHash = summaryWindowHash(window);
  if (expectedHash && actualHash !== expectedHash) {
    throw new Error(`summary window hash mismatch: expected ${expectedHash}, got ${actualHash}`);
  }
  const rows: SummaryRow[] = [];
  for (let offset = 0; offset < window.length; offset += SUMMARY_ROW_LEN) {
    const row = decodeSummaryRow(window.slice(offset, offset + SUMMARY_ROW_LEN));
    const expectedIndex = firstIndex + rows.length;
    if (row.snapshot_index !== expectedIndex) {
      throw new Error(`summary row index drift: expected ${expectedIndex}, got ${row.snapshot_index}`);
    }
    rows.push(row);
  }
  return {
    first_index: rowCount === 0 ? 0 : firstIndex,
    row_count: rowCount,
    row_len: SUMMARY_ROW_LEN,
    window,
    window_hash: actualHash,
    rows
  };
}

export function assertLatestSummaryMatchesSnapshot(snapshot: SnapshotArtifact, snapshotIndex: number, encodedRow: string): void {
  const expected = encodeSummaryRow(summaryRowFromSnapshot(snapshot, snapshotIndex));
  if (expected !== encodedRow) {
    throw new Error("latest summary row does not match latest payload");
  }
}
