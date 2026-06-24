import { sha256Hex } from "./canonical-json.js";
import {
  decodeHistoryV1Row,
  encodeHistoryV1Row,
  HISTORY_V1_ROW_LEN,
  type HistoryV1ObservationRow
} from "./aml-history-v1.js";

export const FACT_LEDGER_MANIFEST = "octra-vitals-fact-ledger.v2";
export const FACT_LEDGER_VERSION = "00";
export const FACT_LEDGER_CORE_FAMILY_ID = "0000";
export const FACT_LEDGER_CORE_FAMILY_NAME = "core_accounting";
export const FACT_LEDGER_CORE_SCHEMA_ID = "0000";
export const FACT_LEDGER_CORE_SCHEMA_VERSION = "octra-vitals-core-accounting-v1";
export const FACT_LEDGER_PACKED_METRIC_FAMILY_ID = "0100";
export const FACT_LEDGER_PACKED_METRIC_FAMILY_NAME = "packed_scalar_metrics";
export const FACT_LEDGER_PACKED_METRIC_SCHEMA_ID = "0100";
export const FACT_LEDGER_PACKED_METRIC_SCHEMA_VERSION = "octra-vitals-packed-metrics-v1";
export const FACT_LEDGER_PACKED_METRIC_MAX_SLOTS = 4;
export const FACT_LEDGER_PACKED_METRIC_SLOT_LEN = 42;
export const FACT_LEDGER_FAMILY_DEFINITION_LEN = 702;
export const FACT_LEDGER_FAMILY_STATE_LEN = 338;
export const FACT_LEDGER_CAPSULE_META_LEN = 577;
export const FACT_LEDGER_ROW_HASH_DOMAIN = "octra-vitals:fact-row:v1";
export const FACT_LEDGER_FAMILY_ROOT_DOMAIN = "octra-vitals:fact-family-root:v1";
export const FACT_LEDGER_FAMILY_CAPSULES_ROOT_DOMAIN = "octra-vitals:fact-family-capsules-root:v1";
export const FACT_LEDGER_CAPSULE_BODY_HASH_DOMAIN = "octra-vitals:fact-capsule-body:v1";
export const FACT_LEDGER_CAPSULE_META_HASH_DOMAIN = "octra-vitals:fact-capsule-meta:v1";
export const FACT_LEDGER_CATALOG_ROOT_DOMAIN = "octra-vitals:fact-catalog-root:v1";
export const FACT_LEDGER_FAMILY_SET_HASH_DOMAIN = "octra-vitals:fact-family-set:v1";
export const FACT_LEDGER_EMPTY_TX_INDEX_HASH_HEX = "0".repeat(64);
export const FACT_LEDGER_EMPTY_FAMILY_ID = "9999";
export const FACT_LEDGER_EMPTY_CAPSULE_ID = "none".padEnd(24, "_");

export type FactFamilyKind = "core" | "source_auxiliary" | "diagnostic" | "projection" | "display_auxiliary";
export type FactFamilyCardinality = "one_per_snapshot" | "entity_per_snapshot" | "period_projection";
export type FactFamilyCoverageStatus = "active" | "retired" | "not_captured_before_activation" | "source_unavailable" | "invalid";
export type FactFamilyStatus = "active" | "reserved" | "retired";
export type FactPrimaryKeyType = "snapshot_index" | "snapshot_entity" | "period";
export type FactEntityIdType = "none" | "route_id" | "field_id";
export type FactPeriodType = "none" | "hour" | "day" | "month" | "year";
export type PackedMetricStatus = "captured" | "zero" | "not_captured_before_activation" | "source_unavailable" | "invalid" | "empty";
export type PackedMetricSourceClass = "source" | "derived" | "operator" | "display" | "empty";

export interface FactFamilyDefinition {
  version: string;
  family_id: string;
  family_name: string;
  family_kind: FactFamilyKind;
  family_cardinality: FactFamilyCardinality;
  schema_id: string;
  schema_version: string;
  row_len: number;
  primary_key_type: FactPrimaryKeyType;
  entity_id_type: FactEntityIdType;
  period_type: FactPeriodType;
  max_rows_per_snapshot: number;
  first_snapshot_index: number;
  source_family_ids_hash: string;
  schema_hash: string;
  row_codec_hash: string;
  field_manifest_hash: string;
  unit_scale_hash: string;
  null_semantics_hash: string;
  row_hash_domain_hash: string;
  capsule_hash_domain_hash: string;
  root_hash_domain_hash: string;
  status: FactFamilyStatus;
}

export interface FactFamilyState {
  version: string;
  family_id: string;
  latest_covered_snapshot_index: number;
  latest_capsule_id: string;
  latest_capsule_root: string;
  coverage_status: FactFamilyCoverageStatus;
  successor_family_id: string;
  retired_at_snapshot_index: number;
  capsule_count: number;
  open_capsule_row_count: number;
  open_capsule_start_root: string;
  open_capsule_end_root: string;
  family_root: string;
}

export interface FactCapsuleMeta {
  version: string;
  family_id: string;
  schema_id: string;
  family_cardinality: FactFamilyCardinality;
  sealed: boolean;
  capsule_id: string;
  first_key: string;
  last_key: string;
  row_count: number;
  row_len: number;
  first_observed_unix: number;
  last_observed_unix: number;
  body_hash_hex: string;
  start_root_hex: string;
  end_root_hex: string;
  tx_index_hash_hex: string;
  family_root_before_hex: string;
  family_root_after_hex: string;
  catalog_root_hex: string;
}

export interface PackedMetricSlot {
  metric_id: string;
  unit_id: string;
  status: PackedMetricStatus;
  source_class: PackedMetricSourceClass;
  value_raw: string | number | bigint;
}

export interface PackedMetricFactRow {
  row_version: string;
  snapshot_index: number;
  observed_at_unix: number;
  family_id: string;
  schema_id: string;
  slots: PackedMetricSlot[];
  payload_hash_hex: string;
}

const FAMILY_KIND_CODES: Record<FactFamilyKind, string> = {
  core: "00",
  source_auxiliary: "01",
  diagnostic: "02",
  projection: "03",
  display_auxiliary: "04"
};

const FAMILY_KIND_BY_CODE = Object.fromEntries(Object.entries(FAMILY_KIND_CODES).map(([key, value]) => [value, key])) as Record<string, FactFamilyKind | undefined>;

const CARDINALITY_CODES: Record<FactFamilyCardinality, string> = {
  one_per_snapshot: "00",
  entity_per_snapshot: "01",
  period_projection: "02"
};

const CARDINALITY_BY_CODE = Object.fromEntries(Object.entries(CARDINALITY_CODES).map(([key, value]) => [value, key])) as Record<string, FactFamilyCardinality | undefined>;

const COVERAGE_STATUS_CODES: Record<FactFamilyCoverageStatus, string> = {
  active: "00",
  retired: "01",
  not_captured_before_activation: "02",
  source_unavailable: "03",
  invalid: "04"
};

const COVERAGE_STATUS_BY_CODE = Object.fromEntries(Object.entries(COVERAGE_STATUS_CODES).map(([key, value]) => [value, key])) as Record<string, FactFamilyCoverageStatus | undefined>;

const FAMILY_STATUS_CODES: Record<FactFamilyStatus, string> = {
  active: "00",
  reserved: "01",
  retired: "02"
};

const FAMILY_STATUS_BY_CODE = Object.fromEntries(Object.entries(FAMILY_STATUS_CODES).map(([key, value]) => [value, key])) as Record<string, FactFamilyStatus | undefined>;

const PRIMARY_KEY_CODES: Record<FactPrimaryKeyType, string> = {
  snapshot_index: "00",
  snapshot_entity: "01",
  period: "02"
};

const PRIMARY_KEY_BY_CODE = Object.fromEntries(Object.entries(PRIMARY_KEY_CODES).map(([key, value]) => [value, key])) as Record<string, FactPrimaryKeyType | undefined>;

const ENTITY_ID_CODES: Record<FactEntityIdType, string> = {
  none: "00",
  route_id: "01",
  field_id: "02"
};

const ENTITY_ID_BY_CODE = Object.fromEntries(Object.entries(ENTITY_ID_CODES).map(([key, value]) => [value, key])) as Record<string, FactEntityIdType | undefined>;

const PERIOD_CODES: Record<FactPeriodType, string> = {
  none: "00",
  hour: "01",
  day: "02",
  month: "03",
  year: "04"
};

const PERIOD_BY_CODE = Object.fromEntries(Object.entries(PERIOD_CODES).map(([key, value]) => [value, key])) as Record<string, FactPeriodType | undefined>;

const PACKED_METRIC_STATUS_CODES: Record<PackedMetricStatus, string> = {
  captured: "00",
  zero: "01",
  not_captured_before_activation: "02",
  source_unavailable: "03",
  invalid: "04",
  empty: "99"
};

const PACKED_METRIC_STATUS_BY_CODE = Object.fromEntries(Object.entries(PACKED_METRIC_STATUS_CODES).map(([key, value]) => [value, key])) as Record<string, PackedMetricStatus | undefined>;

const PACKED_METRIC_SOURCE_CLASS_CODES: Record<PackedMetricSourceClass, string> = {
  source: "00",
  derived: "01",
  operator: "02",
  display: "03",
  empty: "99"
};

const PACKED_METRIC_SOURCE_CLASS_BY_CODE = Object.fromEntries(Object.entries(PACKED_METRIC_SOURCE_CLASS_CODES).map(([key, value]) => [value, key])) as Record<string, PackedMetricSourceClass | undefined>;

function taggedHashHex(domain: string, value: string): string {
  return sha256Hex(`${domain}\n${value}`);
}

function digits(value: string | number | bigint, width: number, label: string): string {
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new Error(`${label} must be unsigned decimal digits`);
  if (text.length > width) throw new Error(`${label} exceeds ${width} digits`);
  return text.padStart(width, "0");
}

function parseDigits(value: string | undefined, width: number, label: string): number {
  if (!value || !new RegExp(`^\\d{${width}}$`).test(value)) throw new Error(`${label} must be ${width} decimal digits`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is outside the safe integer range`);
  return parsed;
}

function fixedText(value: string, width: number, label: string): string {
  if (!/^[ -~]*$/.test(value)) throw new Error(`${label} must be printable ASCII`);
  if (value.includes("|")) throw new Error(`${label} must not contain pipe separators`);
  if (value.length > width) throw new Error(`${label} exceeds ${width} chars`);
  return value.padEnd(width, " ");
}

function parseFixedText(value: string | undefined, width: number, label: string): string {
  if (value === undefined || value.length !== width) throw new Error(`${label} must be ${width} chars`);
  return value.replace(/ +$/g, "");
}

function hex64(value: string, label: string): string {
  const normalized = value.replace(/^sha256:/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} must be 64 hex chars`);
  return normalized;
}

function code4(value: string, label: string): string {
  if (!/^\d{4}$/.test(value)) throw new Error(`${label} must be 4 decimal digits`);
  return value;
}

function code2(value: string, label: string): string {
  if (!/^\d{2}$/.test(value)) throw new Error(`${label} must be 2 decimal digits`);
  return value;
}

function signedDigits(value: string | number | bigint, width: number, label: string): string {
  const text = String(value);
  if (!/^-?\d+$/.test(text)) throw new Error(`${label} must be signed decimal digits`);
  const negative = text.startsWith("-");
  const magnitude = negative ? text.slice(1) : text;
  const normalizedMagnitude = magnitude.replace(/^0+(?=\d)/, "");
  if (normalizedMagnitude.length > width - 1) throw new Error(`${label} exceeds ${width - 1} digits`);
  return `${negative ? "-" : "+"}${normalizedMagnitude.padStart(width - 1, "0")}`;
}

function parseSignedDigits(value: string | undefined, width: number, label: string): string {
  if (!value || !new RegExp(`^[+-]\\d{${width - 1}}$`).test(value)) throw new Error(`${label} must be signed ${width}-char decimal`);
  const sign = value[0] === "-" ? "-" : "";
  const magnitude = value.slice(1).replace(/^0+(?=\d)/, "");
  return magnitude === "0" ? "0" : `${sign}${magnitude}`;
}

function encodeCode<T extends string>(map: Record<T, string>, value: T, label: string): string {
  const code = map[value];
  if (!code) throw new Error(`unsupported ${label}: ${value}`);
  return code;
}

function decodeCode<T extends string>(map: Record<string, T | undefined>, code: string | undefined, label: string): T {
  if (!code) throw new Error(`${label} code missing`);
  const value = map[code];
  if (!value) throw new Error(`unsupported ${label} code ${code}`);
  return value;
}

export function factLedgerEmptyFamilyRootHex(familyId: string, schemaId: string): string {
  return taggedHashHex(FACT_LEDGER_FAMILY_ROOT_DOMAIN, `${FACT_LEDGER_MANIFEST}\n${code4(familyId, "family_id")}\n${code4(schemaId, "schema_id")}`);
}

export function factLedgerEmptyFamilyCapsulesRootHex(familyId: string, schemaId: string): string {
  return taggedHashHex(FACT_LEDGER_FAMILY_CAPSULES_ROOT_DOMAIN, `${FACT_LEDGER_MANIFEST}\n${code4(familyId, "family_id")}\n${code4(schemaId, "schema_id")}`);
}

export function factLedgerEmptyCatalogRootHex(): string {
  return taggedHashHex(FACT_LEDGER_CATALOG_ROOT_DOMAIN, "");
}

export function factLedgerFamilyDefinitionHashHex(definitionRow: string): string {
  if (definitionRow.length !== FACT_LEDGER_FAMILY_DEFINITION_LEN) throw new Error("family definition length mismatch");
  return taggedHashHex(FACT_LEDGER_CATALOG_ROOT_DOMAIN, definitionRow);
}

export function factLedgerFoldCatalogRootHex(startRootHex: string, definitionRows: string[]): string {
  let root = hex64(startRootHex, "catalog_root_hex");
  for (const row of definitionRows) {
    root = taggedHashHex(FACT_LEDGER_CATALOG_ROOT_DOMAIN, `${root}\n${factLedgerFamilyDefinitionHashHex(row)}`);
  }
  return root;
}

function defaultOnePerSnapshotKey(encodedRow: string): string {
  if (encodedRow.length < 13) throw new Error("encoded row is too short to carry a snapshot key");
  return encodedRow.slice(3, 13);
}

export function factLedgerRowHashHex(familyId: string, schemaId: string, encodedRow: string, rowKey = defaultOnePerSnapshotKey(encodedRow)): string {
  code4(familyId, "family_id");
  code4(schemaId, "schema_id");
  return taggedHashHex(FACT_LEDGER_ROW_HASH_DOMAIN, `${FACT_LEDGER_MANIFEST}\n${familyId}\n${schemaId}\n${fixedText(rowKey, 20, "row_key")}\n${encodedRow}`);
}

export function factLedgerFoldFamilyRootHex(familyId: string, schemaId: string, startRootHex: string, encodedRows: string[]): string {
  let root = hex64(startRootHex, "start_root_hex");
  for (const row of encodedRows) {
    root = taggedHashHex(FACT_LEDGER_FAMILY_ROOT_DOMAIN, `${FACT_LEDGER_MANIFEST}\n${familyId}\n${schemaId}\n${root}\n${factLedgerRowHashHex(familyId, schemaId, row)}`);
  }
  return root;
}

export function factLedgerFoldFamilyCapsulesRootHex(input: {
  familyId: string;
  schemaId: string;
  startRootHex: string;
  capsuleId: string;
  bodyHashHex: string;
  rowRootAfterHex: string;
}): string {
  const familyId = code4(input.familyId, "family_id");
  const schemaId = code4(input.schemaId, "schema_id");
  return taggedHashHex(
    FACT_LEDGER_FAMILY_CAPSULES_ROOT_DOMAIN,
    [
      FACT_LEDGER_MANIFEST,
      familyId,
      schemaId,
      hex64(input.startRootHex, "start_root_hex"),
      fixedText(input.capsuleId, 24, "capsule_id").trimEnd(),
      hex64(input.bodyHashHex, "body_hash_hex"),
      hex64(input.rowRootAfterHex, "row_root_after_hex")
    ].join("\n")
  );
}

export function factLedgerCapsuleBodyHashHex(familyId: string, schemaId: string, body: string, rowLen: number): string {
  code4(familyId, "family_id");
  code4(schemaId, "schema_id");
  if (!Number.isSafeInteger(rowLen) || rowLen <= 0) throw new Error("rowLen must be positive");
  if (body.length % rowLen !== 0) throw new Error("capsule body must be row aligned");
  return taggedHashHex(FACT_LEDGER_CAPSULE_BODY_HASH_DOMAIN, `${FACT_LEDGER_MANIFEST}\n${familyId}\n${schemaId}\n${body}`);
}

export function factLedgerCapsuleMetaHashHex(metaRow: string): string {
  if (metaRow.length !== FACT_LEDGER_CAPSULE_META_LEN) throw new Error("fact capsule meta length mismatch");
  return taggedHashHex(FACT_LEDGER_CAPSULE_META_HASH_DOMAIN, metaRow);
}

export function factLedgerFamilySetHashHex(capsuleId: string, familyRoots: Array<{ family_id: string; root_hex: string }>): string {
  const normalized = familyRoots
    .map((item) => ({ family_id: code4(item.family_id, "family_id"), root_hex: hex64(item.root_hex, "root_hex") }))
    .sort((a, b) => a.family_id.localeCompare(b.family_id));
  const text = [fixedText(capsuleId, 24, "capsule_id"), ...normalized.map((item) => `${item.family_id}:${item.root_hex}`)].join("\n");
  return taggedHashHex(FACT_LEDGER_FAMILY_SET_HASH_DOMAIN, text);
}

export function coreFactFamilyDefinition(firstSnapshotIndex = 1): FactFamilyDefinition {
  return {
    version: FACT_LEDGER_VERSION,
    family_id: FACT_LEDGER_CORE_FAMILY_ID,
    family_name: FACT_LEDGER_CORE_FAMILY_NAME,
    family_kind: "core",
    family_cardinality: "one_per_snapshot",
    schema_id: FACT_LEDGER_CORE_SCHEMA_ID,
    schema_version: FACT_LEDGER_CORE_SCHEMA_VERSION,
    row_len: HISTORY_V1_ROW_LEN,
    primary_key_type: "snapshot_index",
    entity_id_type: "none",
    period_type: "none",
    max_rows_per_snapshot: 1,
    first_snapshot_index: firstSnapshotIndex,
    source_family_ids_hash: sha256Hex("[]"),
    schema_hash: sha256Hex("octra-vitals-core-accounting-v1"),
    row_codec_hash: sha256Hex("history-v1-row-295-byte-compatible"),
    field_manifest_hash: sha256Hex("core_accounting:issued,burned,encrypted,locked,wrapped,unclaimed,vault,health"),
    unit_scale_hash: sha256Hex("oct:6|woct:6"),
    null_semantics_hash: sha256Hex("zero:not-captured:source-unavailable:invalid"),
    row_hash_domain_hash: sha256Hex(FACT_LEDGER_ROW_HASH_DOMAIN),
    capsule_hash_domain_hash: sha256Hex(FACT_LEDGER_CAPSULE_BODY_HASH_DOMAIN),
    root_hash_domain_hash: sha256Hex(FACT_LEDGER_FAMILY_ROOT_DOMAIN),
    status: "active"
  };
}

export function packedMetricFactFamilyDefinition(firstSnapshotIndex = 1): FactFamilyDefinition {
  return {
    version: FACT_LEDGER_VERSION,
    family_id: FACT_LEDGER_PACKED_METRIC_FAMILY_ID,
    family_name: FACT_LEDGER_PACKED_METRIC_FAMILY_NAME,
    family_kind: "source_auxiliary",
    family_cardinality: "one_per_snapshot",
    schema_id: FACT_LEDGER_PACKED_METRIC_SCHEMA_ID,
    schema_version: FACT_LEDGER_PACKED_METRIC_SCHEMA_VERSION,
    row_len: HISTORY_V1_ROW_LEN,
    primary_key_type: "snapshot_index",
    entity_id_type: "field_id",
    period_type: "none",
    max_rows_per_snapshot: 1,
    first_snapshot_index: firstSnapshotIndex,
    source_family_ids_hash: sha256Hex(JSON.stringify([FACT_LEDGER_CORE_FAMILY_ID])),
    schema_hash: sha256Hex(FACT_LEDGER_PACKED_METRIC_SCHEMA_VERSION),
    row_codec_hash: sha256Hex("packed-scalar-metric-row-295-byte-compatible"),
    field_manifest_hash: sha256Hex("slots[4]:metric_id,unit_id,status,source_class,value_raw,payload_hash"),
    unit_scale_hash: sha256Hex("registry-bound"),
    null_semantics_hash: sha256Hex("empty:not-captured-before-activation:source-unavailable:invalid"),
    row_hash_domain_hash: sha256Hex(FACT_LEDGER_ROW_HASH_DOMAIN),
    capsule_hash_domain_hash: sha256Hex(FACT_LEDGER_CAPSULE_BODY_HASH_DOMAIN),
    root_hash_domain_hash: sha256Hex(FACT_LEDGER_FAMILY_ROOT_DOMAIN),
    status: "reserved"
  };
}

export function encodeFactFamilyDefinition(definition: FactFamilyDefinition): string {
  if (definition.version !== FACT_LEDGER_VERSION) throw new Error(`unsupported fact ledger version ${definition.version}`);
  const encoded = [
    definition.version,
    code4(definition.family_id, "family_id"),
    fixedText(definition.family_name, 32, "family_name"),
    encodeCode(FAMILY_KIND_CODES, definition.family_kind, "family_kind"),
    encodeCode(CARDINALITY_CODES, definition.family_cardinality, "family_cardinality"),
    code4(definition.schema_id, "schema_id"),
    fixedText(definition.schema_version, 32, "schema_version"),
    digits(definition.row_len, 4, "row_len"),
    encodeCode(PRIMARY_KEY_CODES, definition.primary_key_type, "primary_key_type"),
    encodeCode(ENTITY_ID_CODES, definition.entity_id_type, "entity_id_type"),
    encodeCode(PERIOD_CODES, definition.period_type, "period_type"),
    digits(definition.max_rows_per_snapshot, 4, "max_rows_per_snapshot"),
    digits(definition.first_snapshot_index, 10, "first_snapshot_index"),
    hex64(definition.source_family_ids_hash, "source_family_ids_hash"),
    hex64(definition.schema_hash, "schema_hash"),
    hex64(definition.row_codec_hash, "row_codec_hash"),
    hex64(definition.field_manifest_hash, "field_manifest_hash"),
    hex64(definition.unit_scale_hash, "unit_scale_hash"),
    hex64(definition.null_semantics_hash, "null_semantics_hash"),
    hex64(definition.row_hash_domain_hash, "row_hash_domain_hash"),
    hex64(definition.capsule_hash_domain_hash, "capsule_hash_domain_hash"),
    hex64(definition.root_hash_domain_hash, "root_hash_domain_hash"),
    encodeCode(FAMILY_STATUS_CODES, definition.status, "status")
  ].join("|");
  if (encoded.length !== FACT_LEDGER_FAMILY_DEFINITION_LEN) {
    throw new Error(`family definition length ${encoded.length} did not match ${FACT_LEDGER_FAMILY_DEFINITION_LEN}`);
  }
  return encoded;
}

export function decodeFactFamilyDefinition(encoded: string): FactFamilyDefinition {
  if (encoded.length !== FACT_LEDGER_FAMILY_DEFINITION_LEN) {
    throw new Error(`family definition length ${encoded.length} did not match ${FACT_LEDGER_FAMILY_DEFINITION_LEN}`);
  }
  const fields = encoded.split("|");
  if (fields.length !== 23) throw new Error(`family definition had ${fields.length} fields`);
  const [
    version = "",
    familyId = "",
    familyName = "",
    familyKind = "",
    cardinality = "",
    schemaId = "",
    schemaVersion = "",
    rowLen = "",
    primaryKey = "",
    entityId = "",
    period = "",
    maxRowsPerSnapshot = "",
    firstSnapshotIndex = "",
    sourceFamilyIdsHash = "",
    schemaHash = "",
    rowCodecHash = "",
    fieldManifestHash = "",
    unitScaleHash = "",
    nullSemanticsHash = "",
    rowHashDomainHash = "",
    capsuleHashDomainHash = "",
    rootHashDomainHash = "",
    status = ""
  ] = fields;
  if (version !== FACT_LEDGER_VERSION) throw new Error(`unsupported fact ledger version ${version}`);
  return {
    version,
    family_id: code4(familyId, "family_id"),
    family_name: parseFixedText(familyName, 32, "family_name"),
    family_kind: decodeCode(FAMILY_KIND_BY_CODE, familyKind, "family_kind"),
    family_cardinality: decodeCode(CARDINALITY_BY_CODE, cardinality, "family_cardinality"),
    schema_id: code4(schemaId, "schema_id"),
    schema_version: parseFixedText(schemaVersion, 32, "schema_version"),
    row_len: parseDigits(rowLen, 4, "row_len"),
    primary_key_type: decodeCode(PRIMARY_KEY_BY_CODE, primaryKey, "primary_key_type"),
    entity_id_type: decodeCode(ENTITY_ID_BY_CODE, entityId, "entity_id_type"),
    period_type: decodeCode(PERIOD_BY_CODE, period, "period_type"),
    max_rows_per_snapshot: parseDigits(maxRowsPerSnapshot, 4, "max_rows_per_snapshot"),
    first_snapshot_index: parseDigits(firstSnapshotIndex, 10, "first_snapshot_index"),
    source_family_ids_hash: hex64(sourceFamilyIdsHash, "source_family_ids_hash"),
    schema_hash: hex64(schemaHash, "schema_hash"),
    row_codec_hash: hex64(rowCodecHash, "row_codec_hash"),
    field_manifest_hash: hex64(fieldManifestHash, "field_manifest_hash"),
    unit_scale_hash: hex64(unitScaleHash, "unit_scale_hash"),
    null_semantics_hash: hex64(nullSemanticsHash, "null_semantics_hash"),
    row_hash_domain_hash: hex64(rowHashDomainHash, "row_hash_domain_hash"),
    capsule_hash_domain_hash: hex64(capsuleHashDomainHash, "capsule_hash_domain_hash"),
    root_hash_domain_hash: hex64(rootHashDomainHash, "root_hash_domain_hash"),
    status: decodeCode(FAMILY_STATUS_BY_CODE, status, "status")
  };
}

export function encodeFactFamilyState(state: FactFamilyState): string {
  if (state.version !== FACT_LEDGER_VERSION) throw new Error(`unsupported fact ledger version ${state.version}`);
  const encoded = [
    state.version,
    code4(state.family_id, "family_id"),
    digits(state.latest_covered_snapshot_index, 10, "latest_covered_snapshot_index"),
    fixedText(state.latest_capsule_id, 24, "latest_capsule_id"),
    hex64(state.latest_capsule_root, "latest_capsule_root"),
    encodeCode(COVERAGE_STATUS_CODES, state.coverage_status, "coverage_status"),
    code4(state.successor_family_id, "successor_family_id"),
    digits(state.retired_at_snapshot_index, 10, "retired_at_snapshot_index"),
    digits(state.capsule_count, 8, "capsule_count"),
    digits(state.open_capsule_row_count, 6, "open_capsule_row_count"),
    hex64(state.open_capsule_start_root, "open_capsule_start_root"),
    hex64(state.open_capsule_end_root, "open_capsule_end_root"),
    hex64(state.family_root, "family_root")
  ].join("|");
  if (encoded.length !== FACT_LEDGER_FAMILY_STATE_LEN) {
    throw new Error(`family state length ${encoded.length} did not match ${FACT_LEDGER_FAMILY_STATE_LEN}`);
  }
  return encoded;
}

export function decodeFactFamilyState(encoded: string): FactFamilyState {
  if (encoded.length !== FACT_LEDGER_FAMILY_STATE_LEN) {
    throw new Error(`family state length ${encoded.length} did not match ${FACT_LEDGER_FAMILY_STATE_LEN}`);
  }
  const fields = encoded.split("|");
  if (fields.length !== 13) throw new Error(`family state had ${fields.length} fields`);
  const [
    version = "",
    familyId = "",
    latestCovered = "",
    latestCapsuleId = "",
    latestCapsuleRoot = "",
    coverageStatus = "",
    successorFamilyId = "",
    retiredAt = "",
    capsuleCount = "",
    openRowCount = "",
    openStartRoot = "",
    openEndRoot = "",
    familyRoot = ""
  ] = fields;
  if (version !== FACT_LEDGER_VERSION) throw new Error(`unsupported fact ledger version ${version}`);
  return {
    version,
    family_id: code4(familyId, "family_id"),
    latest_covered_snapshot_index: parseDigits(latestCovered, 10, "latest_covered_snapshot_index"),
    latest_capsule_id: parseFixedText(latestCapsuleId, 24, "latest_capsule_id"),
    latest_capsule_root: hex64(latestCapsuleRoot, "latest_capsule_root"),
    coverage_status: decodeCode(COVERAGE_STATUS_BY_CODE, coverageStatus, "coverage_status"),
    successor_family_id: code4(successorFamilyId, "successor_family_id"),
    retired_at_snapshot_index: parseDigits(retiredAt, 10, "retired_at_snapshot_index"),
    capsule_count: parseDigits(capsuleCount, 8, "capsule_count"),
    open_capsule_row_count: parseDigits(openRowCount, 6, "open_capsule_row_count"),
    open_capsule_start_root: hex64(openStartRoot, "open_capsule_start_root"),
    open_capsule_end_root: hex64(openEndRoot, "open_capsule_end_root"),
    family_root: hex64(familyRoot, "family_root")
  };
}

export function encodeFactCapsuleMeta(meta: FactCapsuleMeta): string {
  if (meta.version !== FACT_LEDGER_VERSION) throw new Error(`unsupported fact ledger version ${meta.version}`);
  const encoded = [
    meta.version,
    code4(meta.family_id, "family_id"),
    code4(meta.schema_id, "schema_id"),
    encodeCode(CARDINALITY_CODES, meta.family_cardinality, "family_cardinality"),
    meta.sealed ? "1" : "0",
    fixedText(meta.capsule_id, 24, "capsule_id"),
    fixedText(meta.first_key, 20, "first_key"),
    fixedText(meta.last_key, 20, "last_key"),
    digits(meta.row_count, 6, "row_count"),
    digits(meta.row_len, 4, "row_len"),
    digits(meta.first_observed_unix, 12, "first_observed_unix"),
    digits(meta.last_observed_unix, 12, "last_observed_unix"),
    hex64(meta.body_hash_hex, "body_hash_hex"),
    hex64(meta.start_root_hex, "start_root_hex"),
    hex64(meta.end_root_hex, "end_root_hex"),
    hex64(meta.tx_index_hash_hex, "tx_index_hash_hex"),
    hex64(meta.family_root_before_hex, "family_root_before_hex"),
    hex64(meta.family_root_after_hex, "family_root_after_hex"),
    hex64(meta.catalog_root_hex, "catalog_root_hex")
  ].join("|");
  if (encoded.length !== FACT_LEDGER_CAPSULE_META_LEN) {
    throw new Error(`fact capsule meta length ${encoded.length} did not match ${FACT_LEDGER_CAPSULE_META_LEN}`);
  }
  return encoded;
}

export function decodeFactCapsuleMeta(encoded: string): FactCapsuleMeta {
  if (encoded.length !== FACT_LEDGER_CAPSULE_META_LEN) {
    throw new Error(`fact capsule meta length ${encoded.length} did not match ${FACT_LEDGER_CAPSULE_META_LEN}`);
  }
  const fields = encoded.split("|");
  if (fields.length !== 19) throw new Error(`fact capsule meta had ${fields.length} fields`);
  const [
    version = "",
    familyId = "",
    schemaId = "",
    cardinality = "",
    sealed = "",
    capsuleId = "",
    firstKey = "",
    lastKey = "",
    rowCount = "",
    rowLen = "",
    firstObservedUnix = "",
    lastObservedUnix = "",
    bodyHashHex = "",
    startRootHex = "",
    endRootHex = "",
    txIndexHashHex = "",
    familyRootBeforeHex = "",
    familyRootAfterHex = "",
    catalogRootHex = ""
  ] = fields;
  if (version !== FACT_LEDGER_VERSION) throw new Error(`unsupported fact ledger version ${version}`);
  if (sealed !== "1" && sealed !== "0") throw new Error("sealed flag must be 0 or 1");
  return {
    version,
    family_id: code4(familyId, "family_id"),
    schema_id: code4(schemaId, "schema_id"),
    family_cardinality: decodeCode(CARDINALITY_BY_CODE, cardinality, "family_cardinality"),
    sealed: sealed === "1",
    capsule_id: parseFixedText(capsuleId, 24, "capsule_id"),
    first_key: parseFixedText(firstKey, 20, "first_key"),
    last_key: parseFixedText(lastKey, 20, "last_key"),
    row_count: parseDigits(rowCount, 6, "row_count"),
    row_len: parseDigits(rowLen, 4, "row_len"),
    first_observed_unix: parseDigits(firstObservedUnix, 12, "first_observed_unix"),
    last_observed_unix: parseDigits(lastObservedUnix, 12, "last_observed_unix"),
    body_hash_hex: hex64(bodyHashHex, "body_hash_hex"),
    start_root_hex: hex64(startRootHex, "start_root_hex"),
    end_root_hex: hex64(endRootHex, "end_root_hex"),
    tx_index_hash_hex: hex64(txIndexHashHex, "tx_index_hash_hex"),
    family_root_before_hex: hex64(familyRootBeforeHex, "family_root_before_hex"),
    family_root_after_hex: hex64(familyRootAfterHex, "family_root_after_hex"),
    catalog_root_hex: hex64(catalogRootHex, "catalog_root_hex")
  };
}

export function encodeCoreAccountingFactRow(row: HistoryV1ObservationRow): string {
  return encodeHistoryV1Row(row);
}

export function decodeCoreAccountingFactRow(encoded: string): HistoryV1ObservationRow {
  return decodeHistoryV1Row(encoded);
}

function emptyPackedMetricSlot(): string {
  return `${FACT_LEDGER_EMPTY_FAMILY_ID}0000${PACKED_METRIC_STATUS_CODES.empty}${PACKED_METRIC_SOURCE_CLASS_CODES.empty}${signedDigits(0, 30, "empty_value_raw")}`;
}

function encodePackedMetricSlot(slot: PackedMetricSlot): string {
  const encoded = [
    code4(slot.metric_id, "metric_id"),
    code4(slot.unit_id, "unit_id"),
    encodeCode(PACKED_METRIC_STATUS_CODES, slot.status, "metric_status"),
    encodeCode(PACKED_METRIC_SOURCE_CLASS_CODES, slot.source_class, "metric_source_class"),
    signedDigits(slot.value_raw, 30, "value_raw")
  ].join("");
  if (encoded.length !== FACT_LEDGER_PACKED_METRIC_SLOT_LEN) {
    throw new Error(`packed metric slot length ${encoded.length} did not match ${FACT_LEDGER_PACKED_METRIC_SLOT_LEN}`);
  }
  return encoded;
}

function decodePackedMetricSlot(encoded: string): PackedMetricSlot {
  if (encoded.length !== FACT_LEDGER_PACKED_METRIC_SLOT_LEN) throw new Error("packed metric slot length mismatch");
  return {
    metric_id: code4(encoded.slice(0, 4), "metric_id"),
    unit_id: code4(encoded.slice(4, 8), "unit_id"),
    status: decodeCode(PACKED_METRIC_STATUS_BY_CODE, encoded.slice(8, 10), "metric_status"),
    source_class: decodeCode(PACKED_METRIC_SOURCE_CLASS_BY_CODE, encoded.slice(10, 12), "metric_source_class"),
    value_raw: parseSignedDigits(encoded.slice(12, 42), 30, "value_raw")
  };
}

export function encodePackedMetricFactRow(row: PackedMetricFactRow): string {
  if (row.row_version !== FACT_LEDGER_VERSION) throw new Error(`unsupported packed metric row version ${row.row_version}`);
  if (row.slots.length > FACT_LEDGER_PACKED_METRIC_MAX_SLOTS) {
    throw new Error(`packed metric row supports at most ${FACT_LEDGER_PACKED_METRIC_MAX_SLOTS} slots`);
  }
  const slotText = [
    ...row.slots.map((slot) => encodePackedMetricSlot(slot)),
    ...Array.from({ length: FACT_LEDGER_PACKED_METRIC_MAX_SLOTS - row.slots.length }, () => emptyPackedMetricSlot())
  ].join("");
  const encoded = [
    row.row_version,
    digits(row.snapshot_index, 10, "snapshot_index"),
    digits(row.observed_at_unix, 12, "observed_at_unix"),
    code4(row.family_id, "family_id"),
    code4(row.schema_id, "schema_id"),
    digits(row.slots.length, 2, "slot_count"),
    slotText,
    fixedText("", 21, "reserved"),
    hex64(row.payload_hash_hex, "payload_hash_hex")
  ].join("|");
  if (encoded.length !== HISTORY_V1_ROW_LEN) {
    throw new Error(`packed metric fact row length ${encoded.length} did not match ${HISTORY_V1_ROW_LEN}`);
  }
  return encoded;
}

export function decodePackedMetricFactRow(encoded: string): PackedMetricFactRow {
  if (encoded.length !== HISTORY_V1_ROW_LEN) throw new Error(`packed metric fact row length ${encoded.length} did not match ${HISTORY_V1_ROW_LEN}`);
  const slotCount = parseDigits(encoded.slice(37, 39), 2, "slot_count");
  if (slotCount > FACT_LEDGER_PACKED_METRIC_MAX_SLOTS) throw new Error("slot_count exceeds packed metric slot capacity");
  const slots: PackedMetricSlot[] = [];
  const slotText = encoded.slice(40, 40 + FACT_LEDGER_PACKED_METRIC_SLOT_LEN * FACT_LEDGER_PACKED_METRIC_MAX_SLOTS);
  for (let index = 0; index < slotCount; index += 1) {
    const start = index * FACT_LEDGER_PACKED_METRIC_SLOT_LEN;
    slots.push(decodePackedMetricSlot(slotText.slice(start, start + FACT_LEDGER_PACKED_METRIC_SLOT_LEN)));
  }
  return {
    row_version: encoded.slice(0, 2),
    snapshot_index: parseDigits(encoded.slice(3, 13), 10, "snapshot_index"),
    observed_at_unix: parseDigits(encoded.slice(14, 26), 12, "observed_at_unix"),
    family_id: code4(encoded.slice(27, 31), "family_id"),
    schema_id: code4(encoded.slice(32, 36), "schema_id"),
    slots,
    payload_hash_hex: hex64(encoded.slice(231, 295), "payload_hash_hex")
  };
}

export function makeFactCapsule(input: {
  familyId: string;
  schemaId: string;
  cardinality: FactFamilyCardinality;
  capsuleId: string;
  body: string;
  rowLen: number;
  startRootHex: string;
  familyRootBeforeHex: string;
  catalogRootHex: string;
  txIndexHashHex?: string;
  firstKey?: string;
  lastKey?: string;
  firstObservedUnix?: number;
  lastObservedUnix?: number;
}): {
  body: string;
  body_hash_hex: string;
  meta: FactCapsuleMeta;
  meta_row: string;
  meta_hash_hex: string;
  end_root_hex: string;
  family_root_after_hex: string;
} {
  code4(input.familyId, "familyId");
  code4(input.schemaId, "schemaId");
  if (!Number.isSafeInteger(input.rowLen) || input.rowLen <= 0) throw new Error("rowLen must be positive");
  if (input.body.length % input.rowLen !== 0) throw new Error("capsule body must be row aligned");
  const rowCount = input.body.length / input.rowLen;
  if (rowCount < 1) throw new Error("capsule body must contain at least one row");
  const rows: string[] = [];
  for (let offset = 0; offset < input.body.length; offset += input.rowLen) {
    rows.push(input.body.slice(offset, offset + input.rowLen));
  }
  const firstRow = rows[0];
  const lastRow = rows[rows.length - 1];
  if (!firstRow || !lastRow) throw new Error("capsule rows missing");
  const canInferCoreShape = input.cardinality === "one_per_snapshot" && input.rowLen >= HISTORY_V1_ROW_LEN;
  if ((!input.firstKey || !input.lastKey || input.firstObservedUnix === undefined || input.lastObservedUnix === undefined) && !canInferCoreShape) {
    throw new Error("non-core-shaped fact capsules require explicit key and observed bounds");
  }
  const firstKey = input.firstKey || firstRow.slice(3, 13);
  const lastKey = input.lastKey || lastRow.slice(3, 13);
  const firstObservedUnix = input.firstObservedUnix ?? Number(firstRow.slice(14, 26));
  const lastObservedUnix = input.lastObservedUnix ?? Number(lastRow.slice(14, 26));
  const bodyHashHex = factLedgerCapsuleBodyHashHex(input.familyId, input.schemaId, input.body, input.rowLen);
  const endRootHex = factLedgerFoldFamilyRootHex(input.familyId, input.schemaId, input.startRootHex, rows);
  const familyRootAfterHex = factLedgerFoldFamilyCapsulesRootHex({
    familyId: input.familyId,
    schemaId: input.schemaId,
    startRootHex: input.familyRootBeforeHex,
    capsuleId: input.capsuleId,
    bodyHashHex,
    rowRootAfterHex: endRootHex
  });
  const meta: FactCapsuleMeta = {
    version: FACT_LEDGER_VERSION,
    family_id: input.familyId,
    schema_id: input.schemaId,
    family_cardinality: input.cardinality,
    sealed: true,
    capsule_id: input.capsuleId,
    first_key: firstKey,
    last_key: lastKey,
    row_count: rowCount,
    row_len: input.rowLen,
    first_observed_unix: firstObservedUnix,
    last_observed_unix: lastObservedUnix,
    body_hash_hex: bodyHashHex,
    start_root_hex: input.startRootHex,
    end_root_hex: endRootHex,
    tx_index_hash_hex: input.txIndexHashHex || FACT_LEDGER_EMPTY_TX_INDEX_HASH_HEX,
    family_root_before_hex: input.familyRootBeforeHex,
    family_root_after_hex: familyRootAfterHex,
    catalog_root_hex: input.catalogRootHex
  };
  const metaRow = encodeFactCapsuleMeta(meta);
  const metaHashHex = factLedgerCapsuleMetaHashHex(metaRow);
  return {
    body: input.body,
    body_hash_hex: bodyHashHex,
    meta,
    meta_row: metaRow,
    meta_hash_hex: metaHashHex,
    end_root_hex: endRootHex,
    family_root_after_hex: familyRootAfterHex
  };
}
