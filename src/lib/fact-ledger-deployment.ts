export interface FactLedgerLatestBundle {
  snapshot_index: number;
  snapshot_id: string;
  payload_hash: string;
  history_row_hash: string;
  history_root: string;
  catalog_root: string;
}

export interface FactLedgerLatestBundleParseOptions {
  allowRootOnly?: boolean;
}

export function parseFactLedgerLatestBundle(value: unknown, options: FactLedgerLatestBundleParseOptions = {}): FactLedgerLatestBundle {
  if (typeof value !== "string") throw new Error("fact-ledger latest bundle must be a string");
  const fields = value.split("|");
  if (fields.length !== 6) throw new Error(`fact-ledger latest bundle had ${fields.length} fields`);
  const [indexText = "", snapshotId = "", payloadHash = "", historyRowHash = "", historyRoot = "", catalogRoot = ""] = fields;
  const snapshotIndex = Number(indexText);
  if (!Number.isSafeInteger(snapshotIndex) || snapshotIndex < 0) throw new Error("fact-ledger latest bundle index is invalid");
  const rootOnlyBundle = snapshotIndex > 0 && snapshotId === "" && payloadHash === "" && historyRowHash === "";
  if (snapshotIndex > 0 && !rootOnlyBundle && !/^vitals\.\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(snapshotId)) {
    throw new Error("fact-ledger latest bundle snapshot id is invalid");
  }
  if (rootOnlyBundle && !options.allowRootOnly) {
    throw new Error("fact-ledger latest bundle snapshot id is invalid");
  }
  for (const [label, hash, tagged] of [
    ["payload hash", payloadHash, true],
    ["history row hash", historyRowHash, false],
    ["history root", historyRoot, false],
    ["catalog root", catalogRoot, false]
  ] as const) {
    if (snapshotIndex === 0 && hash === "") continue;
    if (rootOnlyBundle && (label === "payload hash" || label === "history row hash")) continue;
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

export const SINGLE_MAINNET_PROGRAM_RPC_ACK = "I ACCEPT SINGLE OCTRA PROGRAM RPC FOR MAINNET";

export interface ProgramRpcQuorumPolicy {
  default_minimum: number;
  configured_minimum: number;
  effective_minimum: number;
  single_program_rpc_mainnet_acknowledged: boolean;
}

export function assertProgramRpcQuorumPolicy(options: {
  productionRpc: boolean;
  urlCount: number;
  configuredMinimum?: string | undefined;
  singleProgramRpcMainnetAck?: string | undefined;
  label?: string | undefined;
}): ProgramRpcQuorumPolicy {
  const defaultMinimum = options.productionRpc ? 2 : 1;
  const singleProgramRpcMainnetAcknowledged =
    options.productionRpc &&
    options.urlCount === 1 &&
    options.singleProgramRpcMainnetAck === SINGLE_MAINNET_PROGRAM_RPC_ACK;
  const configuredMinimum = Number(options.configuredMinimum || defaultMinimum);
  if (!Number.isSafeInteger(configuredMinimum) || (!singleProgramRpcMainnetAcknowledged && configuredMinimum < defaultMinimum)) {
    throw new Error(`VITALS_MIN_PROGRAM_RPC_URLS must be at least ${defaultMinimum}`);
  }
  const effectiveMinimum = singleProgramRpcMainnetAcknowledged ? 1 : configuredMinimum;
  if (options.urlCount < effectiveMinimum) {
    throw new Error(`${options.label || "program operation"} requires ${effectiveMinimum} RPC URLs; got ${options.urlCount}`);
  }
  return {
    default_minimum: defaultMinimum,
    configured_minimum: configuredMinimum,
    effective_minimum: effectiveMinimum,
    single_program_rpc_mainnet_acknowledged: singleProgramRpcMainnetAcknowledged
  };
}
