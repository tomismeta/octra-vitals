#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { buildLiveSnapshot, writeSnapshotArtifacts } from "../lib/snapshot.js";
import { circleProgramViewAtUrl, configuredProgrammedCircleId } from "../lib/circle-program.js";
import { octraProgramRpcUrl, octraRpc, recommendedOu, contractReceipt } from "../lib/octra-rpc.js";
import { loadOperatorWalletFromEnv, publicTransactionJson, signTransaction, transactionHash, type OctraTransaction, type OperatorWallet } from "../lib/octra-transaction.js";
import {
  FACT_LEDGER_EMPTY_FAMILY_ID,
  FACT_LEDGER_PACKED_METRIC_FAMILY_ID,
  FACT_LEDGER_PACKED_METRIC_SCHEMA_ID,
  FACT_LEDGER_VERSION,
  encodeFactFamilyDefinition,
  encodePackedMetricFactRow,
  factLedgerEmptyFamilyRootHex,
  packedMetricFactFamilyDefinition
} from "../lib/aml-fact-ledger.js";
import { buildRecordSnapshotCall } from "./build-record-snapshot-call.js";
import { submitSnapshotCall, writeJsonAtomic, writeSubmitSnapshotReport } from "./submit-snapshot.js";

const root = resolve(new URL("../..", import.meta.url).pathname);
const outPath = process.env.VITALS_FACT_LEDGER_EXERCISE_OUT || join(root, "build", "fact-ledger-devnet-exercise.json");
const submitEnabled = process.env.VITALS_FACT_LEDGER_EXERCISE_SUBMIT === "1";

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertDevnet(url: string): void {
  if (/devnet/i.test(url) || process.env.VITALS_ALLOW_NON_DEVNET_FACT_LEDGER_EXERCISE === "1") return;
  throw new Error(`refusing fact-ledger exercise on non-devnet RPC ${url}`);
}

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[A-Za-z0-9+/=]{40,}/g, "<redacted>");
}

async function nextNonce(address: string): Promise<number> {
  const balance = await octraRpc<any>("octra_balance", [address]);
  const nonce = Number(balance?.pending_nonce ?? balance?.nonce ?? 0);
  if (!Number.isInteger(nonce) || nonce < 0) throw new Error(`invalid nonce response for ${address}`);
  return nonce + 1;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function txStatus(tx: any): string {
  return String(tx?.status || tx?.transaction?.status || "");
}

async function requireConfirmed(hash: string, label: string): Promise<any> {
  let latest: any = null;
  for (let attempt = 0; attempt < 45; attempt += 1) {
    await sleep(2000);
    try {
      latest = await octraRpc<any>("octra_transaction", [hash]);
      const status = txStatus(latest);
      if (status === "confirmed") return latest;
      if (status === "rejected") break;
    } catch {
      // Newly submitted transactions can take a moment to show up.
    }
  }
  throw new Error(`${label} did not confirm: ${stableJson(latest)}`);
}

async function submitCircleCall(input: {
  wallet: OperatorWallet;
  circleId: string;
  method: string;
  params: unknown[];
  nonce: number;
  ou: string;
  label: string;
}): Promise<Record<string, unknown>> {
  const tx: OctraTransaction = {
    from: input.wallet.address,
    to_: input.circleId,
    amount: "0",
    nonce: input.nonce,
    ou: input.ou,
    timestamp: Date.now() / 1000,
    op_type: "circle_call",
    encrypted_data: input.method,
    message: JSON.stringify(input.params)
  };
  const signed = signTransaction(tx, input.wallet);
  const submitResult = await octraRpc<any>("octra_submit", [publicTransactionJson(signed)]);
  const txHash = submitResult?.tx_hash || submitResult?.hash || transactionHash(signed);
  const confirmation = await requireConfirmed(txHash, input.label);
  const receipt = await contractReceipt(txHash).catch((error) => ({ error: publicError(error) }));
  return {
    method: input.method,
    tx_hash: txHash,
    nonce: input.nonce,
    ou: input.ou,
    status: txStatus(confirmation),
    receipt
  };
}

async function familyExists(rpcUrl: string, circleId: string, familyId: string, caller: string): Promise<boolean> {
  try {
    const definition = await circleProgramViewAtUrl<string>(rpcUrl, circleId, "get_family_definition", [familyId], caller);
    return Boolean(definition && !definition.startsWith(FACT_LEDGER_EMPTY_FAMILY_ID));
  } catch {
    return false;
  }
}

async function authNegativeProbe(rpcUrl: string, circleId: string, owner: string, operator: string): Promise<Record<string, unknown>> {
  const configured = process.env.VITALS_FACT_LEDGER_NEGATIVE_CALLER || "oct2kdhscpSp7SE84fNfDYhkwDgcjuAXoLvCuGfT9MAPUDn";
  const wrongCaller = configured === owner || configured === operator
    ? "oct3biwr26gwcgxM1TkHSxMN74KHQgJqry331CmpAuNzq6R"
    : configured;
  try {
    await circleProgramViewAtUrl(rpcUrl, circleId, "set_paused", [true], wrongCaller);
    return {
      ok: false,
      wrong_caller: wrongCaller,
      error: "set_paused unexpectedly succeeded for a non-owner caller"
    };
  } catch (error) {
    return {
      ok: /not owner|permission|unauthorized|failed|revert/i.test(publicError(error)),
      wrong_caller: wrongCaller,
      rejection: publicError(error)
    };
  }
}

const rpcUrl = octraProgramRpcUrl();
assertDevnet(rpcUrl);
const circleId = configuredProgrammedCircleId();
if (!circleId) throw new Error("VITALS_PROGRAMMED_CIRCLE_ID is required");
const wallet = loadOperatorWalletFromEnv();
const caller = wallet?.address || process.env.VITALS_OPERATOR_ADDRESS || process.env.VITALS_CIRCLE_VIEW_CALLER_ADDRESS;
if (!caller) throw new Error("VITALS_OPERATOR_ADDRESS or VITALS_CIRCLE_VIEW_CALLER_ADDRESS is required");

await mkdir(dirname(outPath), { recursive: true });

const [manifest, owner, operator, snapshotCountBefore, familyCountBefore, maxAux, capsuleLimit] = await Promise.all([
  circleProgramViewAtUrl<string>(rpcUrl, circleId, "manifest", [], caller),
  circleProgramViewAtUrl<string>(rpcUrl, circleId, "get_owner", [], caller),
  circleProgramViewAtUrl<string>(rpcUrl, circleId, "get_operator", [], caller),
  circleProgramViewAtUrl<number>(rpcUrl, circleId, "get_snapshot_count", [], caller),
  circleProgramViewAtUrl<number>(rpcUrl, circleId, "get_family_count", [], caller),
  circleProgramViewAtUrl<number>(rpcUrl, circleId, "get_max_aux_fact_rows_per_snapshot", [], caller),
  circleProgramViewAtUrl<number>(rpcUrl, circleId, "get_capsule_row_limit", [], caller)
]);

const authNegative = await authNegativeProbe(rpcUrl, circleId, owner, operator);
if (authNegative.ok !== true) {
  throw new Error(`auth negative probe failed: ${stableJson(authNegative)}`);
}

let nonce = wallet ? await nextNonce(wallet.address) : 0;
const callOu = process.env.VITALS_CALL_OU || await recommendedOu("circle_call", "1000");
const packedMetricRegisteredBefore = await familyExists(rpcUrl, circleId, FACT_LEDGER_PACKED_METRIC_FAMILY_ID, caller);
let registerFamily: Record<string, unknown> | null = null;

if (!packedMetricRegisteredBefore) {
  if (!submitEnabled) {
    registerFamily = {
      status: "dry_run",
      reason: "packed metric family is not registered; set VITALS_FACT_LEDGER_EXERCISE_SUBMIT=1 to register it"
    };
  } else {
    if (!wallet) throw new Error("operator wallet is required to register packed metric family");
    const nextSnapshotIndex = Number(snapshotCountBefore || 0) + 1;
    const definition = encodeFactFamilyDefinition({
      ...packedMetricFactFamilyDefinition(nextSnapshotIndex),
      status: "active"
    });
    const emptyRoot = factLedgerEmptyFamilyRootHex(FACT_LEDGER_PACKED_METRIC_FAMILY_ID, FACT_LEDGER_PACKED_METRIC_SCHEMA_ID, manifest);
    registerFamily = await submitCircleCall({
      wallet,
      circleId,
      method: "register_fact_family",
      params: [FACT_LEDGER_PACKED_METRIC_FAMILY_ID, definition, emptyRoot],
      nonce,
      ou: callOu,
      label: "register packed metric fact family"
    });
    nonce += 1;
  }
}

const snapshot = await buildLiveSnapshot();
const evidenceDir = process.env.VITALS_DATA_DIR ? join(process.env.VITALS_DATA_DIR, "evidence") : join(root, "data", "evidence");
const latestSnapshotOut = process.env.VITALS_FACT_LEDGER_EXERCISE_SNAPSHOT_OUT || join(root, "build", "fact-ledger-devnet-exercise-snapshot.json");
await writeSnapshotArtifacts(snapshot, latestSnapshotOut, evidenceDir);
const observedAtUnix = Math.floor(Date.parse(snapshot.envelope.observed_at) / 1000);
const payloadHashHex = snapshot.envelope.payload_hash.replace(/^sha256:/, "");
const auxRow = encodePackedMetricFactRow({
  row_version: FACT_LEDGER_VERSION,
  snapshot_index: Number(snapshotCountBefore || 0) + 1,
  observed_at_unix: observedAtUnix,
  family_id: FACT_LEDGER_PACKED_METRIC_FAMILY_ID,
  schema_id: FACT_LEDGER_PACKED_METRIC_SCHEMA_ID,
  slots: [{
    metric_id: "9001",
    unit_id: "0001",
    status: "captured",
    source_class: "derived",
    value_raw: snapshot.envelope.payload.routes?.length || 0
  }],
  payload_hash_hex: payloadHashHex
});
const call = await buildRecordSnapshotCall(snapshot, {
  recordVersion: "fact-v2",
  submitEnabled,
  auxRows: [auxRow]
});
if (call.schema !== "octra-vitals-record-snapshot-call-fact-v2") {
  throw new Error(`expected fact-v2 record call, got ${call.schema}`);
}

let submitSnapshot: Record<string, unknown> | null = null;
if (submitEnabled) {
  submitSnapshot = await submitSnapshotCall(call, {
    outPath,
    writeLatestReceipt: true
  });
  await writeSubmitSnapshotReport(submitSnapshot, process.env.VITALS_FACT_LEDGER_EXERCISE_SUBMIT_OUT || join(root, "build", "fact-ledger-devnet-exercise-submit.json"));
} else {
  submitSnapshot = {
    status: "dry_run",
    reason: "set VITALS_FACT_LEDGER_EXERCISE_SUBMIT=1 to submit the aux fact snapshot",
    snapshot_index: call.snapshot_index,
    aux_count: call.fact_ledger.aux_count
  };
}

const packedMetricRegisteredAfter = await familyExists(rpcUrl, circleId, FACT_LEDGER_PACKED_METRIC_FAMILY_ID, caller);
const [snapshotCountAfter, familyCountAfter, packedOpenRows, packedCapsuleCount, packedRoot, packedCapsulesRoot, coreOpenRows, coreCapsuleCount] = await Promise.all([
  circleProgramViewAtUrl<number>(rpcUrl, circleId, "get_snapshot_count", [], caller),
  circleProgramViewAtUrl<number>(rpcUrl, circleId, "get_family_count", [], caller),
  packedMetricRegisteredAfter
    ? circleProgramViewAtUrl<number>(rpcUrl, circleId, "get_family_open_capsule_row_count", [FACT_LEDGER_PACKED_METRIC_FAMILY_ID], caller)
    : Promise.resolve(0),
  packedMetricRegisteredAfter
    ? circleProgramViewAtUrl<number>(rpcUrl, circleId, "get_family_capsule_count", [FACT_LEDGER_PACKED_METRIC_FAMILY_ID], caller)
    : Promise.resolve(0),
  packedMetricRegisteredAfter
    ? circleProgramViewAtUrl<string>(rpcUrl, circleId, "get_family_root", [FACT_LEDGER_PACKED_METRIC_FAMILY_ID], caller)
    : Promise.resolve(null),
  packedMetricRegisteredAfter
    ? circleProgramViewAtUrl<string>(rpcUrl, circleId, "get_family_capsules_root", [FACT_LEDGER_PACKED_METRIC_FAMILY_ID], caller)
    : Promise.resolve(null),
  circleProgramViewAtUrl<number>(rpcUrl, circleId, "get_family_open_capsule_row_count", ["0000"], caller),
  circleProgramViewAtUrl<number>(rpcUrl, circleId, "get_family_capsule_count", ["0000"], caller)
]);

const report = {
  schema: "octra-vitals-fact-ledger-devnet-exercise-v0",
  generated_at: isoNow(),
  rpc_url: rpcUrl,
  circle_id: circleId,
  manifest,
  submit_enabled: submitEnabled,
  owner,
  operator,
  caller,
  auth_negative: authNegative,
  before: {
    snapshot_count: Number(snapshotCountBefore || 0),
    family_count: Number(familyCountBefore || 0),
    packed_metric_registered: packedMetricRegisteredBefore,
    max_aux_fact_rows_per_snapshot: Number(maxAux || 0),
    capsule_row_limit: Number(capsuleLimit || 0)
  },
  register_family: registerFamily,
  aux_fact: {
    family_id: FACT_LEDGER_PACKED_METRIC_FAMILY_ID,
    schema_id: FACT_LEDGER_PACKED_METRIC_SCHEMA_ID,
    aux_count: call.fact_ledger.aux_count,
    row_len: auxRow.length,
    metric_slots: 1
  },
  snapshot: {
    snapshot_id: snapshot.envelope.snapshot_id,
    observed_at: snapshot.envelope.observed_at,
    payload_hash: snapshot.envelope.payload_hash,
    snapshot_index: call.snapshot_index
  },
  submit_snapshot: submitSnapshot,
  after: {
    snapshot_count: Number(snapshotCountAfter || 0),
    family_count: Number(familyCountAfter || 0),
    packed_metric_registered: packedMetricRegisteredAfter,
    packed_metric_open_rows: Number(packedOpenRows || 0),
    packed_metric_capsule_count: Number(packedCapsuleCount || 0),
    packed_metric_root: packedRoot,
    packed_metric_capsules_root: packedCapsulesRoot,
    core_open_rows: Number(coreOpenRows || 0),
    core_capsule_count: Number(coreCapsuleCount || 0)
  }
};

await writeJsonAtomic(outPath, report);
console.log(stableJson({
  schema: report.schema,
  submit_enabled: submitEnabled,
  circle_id: circleId,
  snapshot_index: call.snapshot_index,
  auth_negative_ok: authNegative.ok === true,
  packed_metric_open_rows: report.after.packed_metric_open_rows,
  snapshot_status: (submitSnapshot as any)?.status || null,
  report_path: outPath
}));
