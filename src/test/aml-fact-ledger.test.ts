import assert from "node:assert/strict";
import test from "node:test";

import {
  FACT_LEDGER_CAPSULE_META_LEN,
  FACT_LEDGER_CORE_FAMILY_ID,
  FACT_LEDGER_CORE_SCHEMA_ID,
  FACT_LEDGER_FAMILY_DEFINITION_LEN,
  FACT_LEDGER_FAMILY_STATE_LEN,
  FACT_LEDGER_PACKED_METRIC_FAMILY_ID,
  FACT_LEDGER_PACKED_METRIC_SCHEMA_ID,
  FACT_LEDGER_VERSION,
  coreFactFamilyDefinition,
  decodeCoreAccountingFactRow,
  decodeFactCapsuleMeta,
  decodeFactFamilyDefinition,
  decodeFactFamilyState,
  decodePackedMetricFactRow,
  encodeCoreAccountingFactRow,
  encodeFactFamilyDefinition,
  encodeFactFamilyState,
  encodePackedMetricFactRow,
  factLedgerEmptyCatalogRootHex,
  factLedgerEmptyFamilyCapsulesRootHex,
  factLedgerEmptyFamilyRootHex,
  factLedgerFamilySetHashHex,
  factLedgerFoldFamilyCapsulesRootHex,
  factLedgerFoldCatalogRootHex,
  factLedgerFoldFamilyRootHex,
  factLedgerRowHashHex,
  makeFactCapsule,
  packedMetricFactFamilyDefinition,
  type FactFamilyState
} from "../lib/aml-fact-ledger.js";
import { encodeHistoryV1Row, HISTORY_V1_ROW_LEN, type HistoryV1ObservationRow } from "../lib/aml-history-v1.js";

function row(index: number, overrides: Partial<HistoryV1ObservationRow> = {}): HistoryV1ObservationRow {
  return {
    row_version: "00",
    snapshot_index: index,
    observed_at_unix: 1780000000 + index * 900,
    octra_epoch: 1000000 + index,
    external_block: 25000000 + index,
    max_supply_raw: "1000000000000000",
    issued_raw: "622000000000000",
    burned_raw: "378000000000000",
    encrypted_raw: "12413100000000",
    total_locked_raw: "201000000000000",
    total_wrapped_raw: "190000000000000",
    total_unclaimed_raw: "10000000000000",
    vault_balance_raw: "201000000000000",
    unit_status: "00",
    conservation_status: "G",
    route_count: 1,
    payload_hash_hex: "a".repeat(64),
    ...overrides
  };
}

test("core family definition is fixed-width, structural, and round-trips", () => {
  const definition = coreFactFamilyDefinition(101);
  const encoded = encodeFactFamilyDefinition(definition);
  const decoded = decodeFactFamilyDefinition(encoded);

  assert.equal(encoded.length, FACT_LEDGER_FAMILY_DEFINITION_LEN);
  assert.equal(decoded.family_id, FACT_LEDGER_CORE_FAMILY_ID);
  assert.equal(decoded.family_name, "core_accounting");
  assert.equal(decoded.family_cardinality, "one_per_snapshot");
  assert.equal(decoded.first_snapshot_index, 101);
  assert.equal(decoded.row_len, HISTORY_V1_ROW_LEN);
});

test("catalog root changes with family definitions", () => {
  const start = factLedgerEmptyCatalogRootHex();
  const core = encodeFactFamilyDefinition(coreFactFamilyDefinition(1));
  const afterCore = factLedgerFoldCatalogRootHex(start, [core]);

  assert.match(start, /^[0-9a-f]{64}$/);
  assert.match(afterCore, /^[0-9a-f]{64}$/);
  assert.notEqual(afterCore, start);
});

test("packed metric family definition is dormant-capable and fixed-width", () => {
  const definition = packedMetricFactFamilyDefinition(10);
  const encoded = encodeFactFamilyDefinition(definition);
  const decoded = decodeFactFamilyDefinition(encoded);

  assert.equal(encoded.length, FACT_LEDGER_FAMILY_DEFINITION_LEN);
  assert.equal(decoded.family_id, FACT_LEDGER_PACKED_METRIC_FAMILY_ID);
  assert.equal(decoded.schema_id, FACT_LEDGER_PACKED_METRIC_SCHEMA_ID);
  assert.equal(decoded.family_cardinality, "one_per_snapshot");
  assert.equal(decoded.status, "reserved");
  assert.equal(decoded.first_snapshot_index, 10);
});

test("core fact row is byte-compatible with proven history v1 rows", () => {
  const model = row(7);
  const encoded = encodeCoreAccountingFactRow(model);

  assert.equal(encoded, encodeHistoryV1Row(model));
  assert.equal(encoded.length, HISTORY_V1_ROW_LEN);
  assert.equal(decodeCoreAccountingFactRow(encoded).snapshot_index, 7);
});

test("fact row hash domain separates family and schema", () => {
  const encoded = encodeCoreAccountingFactRow(row(1));
  const coreHash = factLedgerRowHashHex(FACT_LEDGER_CORE_FAMILY_ID, FACT_LEDGER_CORE_SCHEMA_ID, encoded);
  const auxiliaryHash = factLedgerRowHashHex("0001", FACT_LEDGER_CORE_SCHEMA_ID, encoded);

  assert.match(coreHash, /^[0-9a-f]{64}$/);
  assert.match(auxiliaryHash, /^[0-9a-f]{64}$/);
  assert.notEqual(coreHash, auxiliaryHash);
});

test("packed metric fact rows keep payload hash position and round-trip active slots", () => {
  const encoded = encodePackedMetricFactRow({
    row_version: FACT_LEDGER_VERSION,
    snapshot_index: 12,
    observed_at_unix: 1782216900,
    family_id: FACT_LEDGER_PACKED_METRIC_FAMILY_ID,
    schema_id: FACT_LEDGER_PACKED_METRIC_SCHEMA_ID,
    slots: [
      {
        metric_id: "0001",
        unit_id: "0001",
        status: "captured",
        source_class: "source",
        value_raw: "123456789"
      },
      {
        metric_id: "0002",
        unit_id: "0001",
        status: "captured",
        source_class: "derived",
        value_raw: "-42"
      }
    ],
    payload_hash_hex: "b".repeat(64)
  });
  const decoded = decodePackedMetricFactRow(encoded);

  assert.equal(encoded.length, HISTORY_V1_ROW_LEN);
  assert.equal(encoded.slice(27, 31), FACT_LEDGER_PACKED_METRIC_FAMILY_ID);
  assert.equal(encoded.slice(32, 36), FACT_LEDGER_PACKED_METRIC_SCHEMA_ID);
  assert.equal(encoded.slice(231), "b".repeat(64));
  assert.equal(factLedgerRowHashHex(FACT_LEDGER_PACKED_METRIC_FAMILY_ID, FACT_LEDGER_PACKED_METRIC_SCHEMA_ID, encoded).length, 64);
  assert.equal(decoded.snapshot_index, 12);
  assert.equal(decoded.slots.length, 2);
  assert.equal(decoded.slots[0]?.metric_id, "0001");
  assert.equal(decoded.slots[0]?.value_raw, "123456789");
  assert.equal(decoded.slots[1]?.source_class, "derived");
  assert.equal(decoded.slots[1]?.value_raw, "-42");
});

test("family state is fixed-width and keeps coverage separate from definition", () => {
  const emptyRoot = factLedgerEmptyFamilyRootHex(FACT_LEDGER_CORE_FAMILY_ID, FACT_LEDGER_CORE_SCHEMA_ID);
  const state: FactFamilyState = {
    version: FACT_LEDGER_VERSION,
    family_id: FACT_LEDGER_CORE_FAMILY_ID,
    latest_covered_snapshot_index: 0,
    latest_capsule_id: "",
    latest_capsule_root: emptyRoot,
    coverage_status: "active",
    successor_family_id: "9999",
    retired_at_snapshot_index: 0,
    capsule_count: 0,
    open_capsule_row_count: 0,
    open_capsule_start_root: emptyRoot,
    open_capsule_end_root: emptyRoot,
    family_root: emptyRoot
  };
  const encoded = encodeFactFamilyState(state);
  const decoded = decodeFactFamilyState(encoded);

  assert.equal(encoded.length, FACT_LEDGER_FAMILY_STATE_LEN);
  assert.equal(decoded.coverage_status, "active");
  assert.equal(decoded.family_root, emptyRoot);
});

test("fact capsule metadata is fixed-width and verifies a core row body", () => {
  const rows = [1, 2, 3].map((index) => encodeCoreAccountingFactRow(row(index)));
  const body = rows.join("");
  const startRoot = factLedgerEmptyFamilyRootHex(FACT_LEDGER_CORE_FAMILY_ID, FACT_LEDGER_CORE_SCHEMA_ID);
  const capsulesStartRoot = factLedgerEmptyFamilyCapsulesRootHex(FACT_LEDGER_CORE_FAMILY_ID, FACT_LEDGER_CORE_SCHEMA_ID);
  const catalogRoot = factLedgerFoldCatalogRootHex(factLedgerEmptyCatalogRootHex(), [
    encodeFactFamilyDefinition(coreFactFamilyDefinition(1))
  ]);
  const capsule = makeFactCapsule({
    familyId: FACT_LEDGER_CORE_FAMILY_ID,
    schemaId: FACT_LEDGER_CORE_SCHEMA_ID,
    cardinality: "one_per_snapshot",
    capsuleId: "2026-06-23T00.0000",
    body,
    rowLen: HISTORY_V1_ROW_LEN,
    startRootHex: startRoot,
    familyRootBeforeHex: capsulesStartRoot,
    catalogRootHex: catalogRoot
  });
  const decoded = decodeFactCapsuleMeta(capsule.meta_row);

  assert.equal(capsule.meta_row.length, FACT_LEDGER_CAPSULE_META_LEN);
  assert.equal(decoded.family_id, FACT_LEDGER_CORE_FAMILY_ID);
  assert.equal(decoded.schema_id, FACT_LEDGER_CORE_SCHEMA_ID);
  assert.equal(decoded.row_count, 3);
  assert.equal(decoded.first_key, "0000000001");
  assert.equal(decoded.last_key, "0000000003");
  assert.equal(decoded.end_root_hex, factLedgerFoldFamilyRootHex(FACT_LEDGER_CORE_FAMILY_ID, FACT_LEDGER_CORE_SCHEMA_ID, startRoot, rows));
  assert.notEqual(decoded.family_root_before_hex, decoded.start_root_hex);
  assert.equal(decoded.family_root_after_hex, factLedgerFoldFamilyCapsulesRootHex({
    familyId: FACT_LEDGER_CORE_FAMILY_ID,
    schemaId: FACT_LEDGER_CORE_SCHEMA_ID,
    startRootHex: capsulesStartRoot,
    capsuleId: "2026-06-23T00.0000",
    bodyHashHex: decoded.body_hash_hex,
    rowRootAfterHex: decoded.end_root_hex
  }));
});

test("family set hash is deterministic regardless of caller ordering", () => {
  const first = factLedgerFamilySetHashHex("2026-06-23T00.0000", [
    { family_id: "0002", root_hex: "b".repeat(64) },
    { family_id: "0000", root_hex: "a".repeat(64) }
  ]);
  const second = factLedgerFamilySetHashHex("2026-06-23T00.0000", [
    { family_id: "0000", root_hex: "a".repeat(64) },
    { family_id: "0002", root_hex: "b".repeat(64) }
  ]);

  assert.equal(first, second);
});

test("non-core fact capsules must provide explicit key bounds", () => {
  assert.throws(
    () => makeFactCapsule({
      familyId: "0001",
      schemaId: "0000",
      cardinality: "entity_per_snapshot",
      capsuleId: "2026-06-23T00.0000",
      body: encodeCoreAccountingFactRow(row(1)),
      rowLen: HISTORY_V1_ROW_LEN,
      startRootHex: factLedgerEmptyFamilyRootHex("0001", "0000"),
      familyRootBeforeHex: factLedgerEmptyFamilyRootHex("0001", "0000"),
      catalogRootHex: factLedgerEmptyCatalogRootHex()
    }),
    /explicit key and observed bounds/
  );
});
