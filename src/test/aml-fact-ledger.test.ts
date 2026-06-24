import assert from "node:assert/strict";
import test from "node:test";

import {
  FACT_LEDGER_CAPSULE_META_LEN,
  FACT_LEDGER_CORE_FAMILY_ID,
  FACT_LEDGER_CORE_SCHEMA_ID,
  FACT_LEDGER_FAMILY_DEFINITION_LEN,
  FACT_LEDGER_FAMILY_STATE_LEN,
  FACT_LEDGER_VERSION,
  coreFactFamilyDefinition,
  decodeCoreAccountingFactRow,
  decodeFactCapsuleMeta,
  decodeFactFamilyDefinition,
  decodeFactFamilyState,
  encodeCoreAccountingFactRow,
  encodeFactFamilyDefinition,
  encodeFactFamilyState,
  factLedgerEmptyCatalogRootHex,
  factLedgerEmptyFamilyRootHex,
  factLedgerFamilySetHashHex,
  factLedgerFoldCatalogRootHex,
  factLedgerFoldFamilyRootHex,
  factLedgerRowHashHex,
  makeFactCapsule,
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
    familyRootBeforeHex: startRoot,
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
