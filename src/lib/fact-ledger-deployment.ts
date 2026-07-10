export interface FactLedgerLatestBundle {
  snapshot_index: number;
  snapshot_id: string;
  payload_hash: string;
  history_row_hash: string;
  history_root: string;
  catalog_root: string;
}

export function parseFactLedgerLatestBundle(value: unknown): FactLedgerLatestBundle {
  if (typeof value !== "string") throw new Error("fact-ledger latest bundle must be a string");
  const fields = value.split("|");
  if (fields.length !== 6) throw new Error(`fact-ledger latest bundle had ${fields.length} fields`);
  const [indexText = "", snapshotId = "", payloadHash = "", historyRowHash = "", historyRoot = "", catalogRoot = ""] = fields;
  const snapshotIndex = Number(indexText);
  if (!Number.isSafeInteger(snapshotIndex) || snapshotIndex < 0) throw new Error("fact-ledger latest bundle index is invalid");
  if (snapshotIndex > 0 && !/^vitals\.\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(snapshotId)) {
    throw new Error("fact-ledger latest bundle snapshot id is invalid");
  }
  for (const [label, hash, tagged] of [
    ["payload hash", payloadHash, true],
    ["history row hash", historyRowHash, false],
    ["history root", historyRoot, false],
    ["catalog root", catalogRoot, false]
  ] as const) {
    if (snapshotIndex === 0 && hash === "") continue;
    const pattern = tagged ? /^sha256:[0-9a-f]{64}$/ : /^[0-9a-f]{64}$/;
    if (!pattern.test(hash)) throw new Error(`fact-ledger latest bundle ${label} is invalid`);
  }
  return {
    snapshot_index: snapshotIndex,
    snapshot_id: snapshotId,
    payload_hash: payloadHash,
    history_row_hash: historyRowHash,
    history_root: historyRoot,
    catalog_root: catalogRoot
  };
}

export function assertDistinctProductionRoles(deployer: string, operator: string, production: boolean): void {
  if (!production || deployer !== operator) return;
  const expected = `${deployer}:${operator}`;
  if (process.env.VITALS_BREAK_GLASS_ROLE_COLLAPSE_ACK !== expected) {
    throw new Error(`production deployer and operator must be distinct; break glass requires VITALS_BREAK_GLASS_ROLE_COLLAPSE_ACK=${expected}`);
  }
}
