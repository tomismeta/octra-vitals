#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { canonicalJson, sha256Tagged } from "../lib/canonical-json.js";
import { circleProgramViewAtUrl, configuredProgrammedCircleId } from "../lib/circle-program.js";
import {
  decodeHistoryV1CapsuleMeta,
  historyV1CapsuleBodyHashHex,
  historyV1CapsuleMetaHashHex,
  historyV1FoldCapsulesRootHex,
  historyV1FoldHistoryRootHex,
  HISTORY_V1_ROW_LEN
} from "../lib/aml-history-v1.js";
import { octraProgramRpcUrl } from "../lib/octra-rpc.js";
import type { SnapshotArtifact, SnapshotPayload } from "../lib/types.js";
import { buildRecordSnapshotCall, type RecordSnapshotCallV1 } from "./build-record-snapshot-call.js";
import { submitSnapshotCall } from "./submit-snapshot.js";

const root = resolve(new URL("../..", import.meta.url).pathname);
const outPath = process.env.VITALS_PROGRAM_V1_BOUNDARY_REHEARSAL_REPORT ||
  join(root, "reports", `program-v1-boundary-rehearsal-${new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[:]/g, "")}.json`);

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertDevnetRpc(url: string): void {
  if (!/devnet/i.test(url)) throw new Error(`refusing boundary rehearsal against non-devnet RPC URL: ${url}`);
}

function observedUnix(value: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`invalid observed_at: ${value}`);
  return Math.floor(ms / 1000);
}

function snapshotAt(base: SnapshotArtifact, observedAt: string, epoch: number): SnapshotArtifact {
  const payload = structuredClone(base.envelope.payload) as SnapshotPayload;
  payload.schema_version = "octra-vitals-snapshot-v0";
  payload.octra = {
    ...payload.octra,
    epoch,
    timestamp: String(observedUnix(observedAt))
  };
  const routeTemplate = Array.isArray(payload.routes) && payload.routes.length > 0 ? payload.routes[0] : {};
  payload.routes = [{
    ...routeTemplate,
    route_id: "octra-7777-ethereum-1",
    src_chain: "octra",
    src_chain_id: 7777,
    dst_chain: "ethereum",
    dst_chain_id: 1,
    asset: "OCT",
    vault_address: payload.bridge.vault_address,
    wrapped_address: payload.ethereum?.woct_address || "",
    bridge_address: payload.ethereum?.bridge_address || "",
    locked_raw: payload.bridge.total_locked_oct_raw,
    wrapped_supply_raw: payload.bridge.woct_supply_raw,
    unclaimed_raw: payload.bridge.unclaimed_oct_raw,
    source_ref_ids: []
  }];
  const evidenceManifest = {
    ...structuredClone(base.evidence_manifest as unknown as Record<string, unknown>),
    observed_at: observedAt
  };
  const sourceRefs = structuredClone(base.envelope.source_refs || []);
  const canonicalPayload = canonicalJson(payload);
  const canonicalEvidenceManifest = canonicalJson(evidenceManifest);
  const canonicalSourceRefs = canonicalJson(sourceRefs);
  return {
    ...base,
    envelope: {
      ...base.envelope,
      snapshot_id: `vitals.${observedAt}`,
      observed_at: observedAt,
      payload_hash: sha256Tagged("octra-vitals:snapshot:v0", canonicalPayload),
      evidence_manifest_hash: sha256Tagged("octra-vitals:evidence:v0", canonicalEvidenceManifest),
      payload,
      source_refs: sourceRefs
    },
    evidence_manifest: evidenceManifest as SnapshotArtifact["evidence_manifest"],
    canonical_payload: canonicalPayload,
    canonical_evidence_manifest: canonicalEvidenceManifest,
    canonical_source_refs: canonicalSourceRefs,
    generated_at: observedAt
  };
}

function splitRows(body: string): string[] {
  if (body.length % HISTORY_V1_ROW_LEN !== 0) throw new Error("capsule body is not row aligned");
  const rows: string[] = [];
  for (let offset = 0; offset < body.length; offset += HISTORY_V1_ROW_LEN) {
    rows.push(body.slice(offset, offset + HISTORY_V1_ROW_LEN));
  }
  return rows;
}

async function writeReport(report: unknown): Promise<void> {
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, stableJson(report));
  console.log(stableJson({
    schema: (report as any).schema,
    status: (report as any).status,
    circle_id: (report as any).circle_id,
    sealed_capsule_id: (report as any).sealed_capsule?.capsule_id,
    open_capsule_id: (report as any).open_capsule?.capsule_id,
    report_path: outPath
  }));
}

const rpcUrl = octraProgramRpcUrl();
assertDevnetRpc(rpcUrl);
const circleId = configuredProgrammedCircleId();
if (!circleId) throw new Error("VITALS_PROGRAMMED_CIRCLE_ID is required");
const baseSnapshotPath = process.env.VITALS_PROGRAM_V1_BOUNDARY_BASE_SNAPSHOT || join(root, "build", "latest_snapshot.json");
const base = JSON.parse(await readFile(baseSnapshotPath, "utf8")) as SnapshotArtifact;
const baseEpoch = Number(base.envelope.payload.octra.epoch || 1000000);
const first = snapshotAt(base, "2026-06-23T11:45:00Z", baseEpoch + 1);
const second = snapshotAt(base, "2026-06-23T12:15:00Z", baseEpoch + 2);

const firstCall = await buildRecordSnapshotCall(first, { recordVersion: "v1", snapshotIndex: 1, submitEnabled: true });
if (firstCall.commit_mode !== "v1") throw new Error("boundary rehearsal expected a v1 first call");
const firstSubmit = await submitSnapshotCall(firstCall, {
  submitEnabled: true,
  waitForConfirmations: true,
  writeLatestReceipt: false
});

const secondCall = await buildRecordSnapshotCall(second, { recordVersion: "v1", snapshotIndex: 2, submitEnabled: true });
if (secondCall.commit_mode !== "v1") throw new Error("boundary rehearsal expected a v1 second call");
const secondCallV1 = secondCall as RecordSnapshotCallV1;
const secondSubmit = await submitSnapshotCall(secondCall, {
  submitEnabled: true,
  waitForConfirmations: true,
  writeLatestReceipt: false
});

const [
  snapshotCount,
  capsuleCount,
  latestCapsuleId,
  latestCapsuleBody,
  latestCapsuleMeta,
  latestCapsuleRootAfter,
  capsulesRoot,
  openCapsuleId,
  openCapsuleBody,
  openCapsuleRowCount,
  historyRoot,
  openCapsuleEndRoot
] = await Promise.all([
  circleProgramViewAtUrl<number>(rpcUrl, circleId, "get_snapshot_count"),
  circleProgramViewAtUrl<number>(rpcUrl, circleId, "get_capsule_count"),
  circleProgramViewAtUrl<string>(rpcUrl, circleId, "get_latest_capsule_id"),
  circleProgramViewAtUrl<string>(rpcUrl, circleId, "get_history_capsule_body", ["2026-06-23T00.0000"]),
  circleProgramViewAtUrl<string>(rpcUrl, circleId, "get_history_capsule_meta", ["2026-06-23T00.0000"]),
  circleProgramViewAtUrl<string>(rpcUrl, circleId, "get_latest_capsule_root_after"),
  circleProgramViewAtUrl<string>(rpcUrl, circleId, "get_capsules_root"),
  circleProgramViewAtUrl<string>(rpcUrl, circleId, "get_open_capsule_id"),
  circleProgramViewAtUrl<string>(rpcUrl, circleId, "get_open_capsule_body"),
  circleProgramViewAtUrl<number>(rpcUrl, circleId, "get_open_capsule_row_count"),
  circleProgramViewAtUrl<string>(rpcUrl, circleId, "get_history_root"),
  circleProgramViewAtUrl<string>(rpcUrl, circleId, "get_open_capsule_end_root")
]);

const meta = decodeHistoryV1CapsuleMeta(latestCapsuleMeta);
const sealedRows = splitRows(latestCapsuleBody);
const bodyHash = historyV1CapsuleBodyHashHex(latestCapsuleBody);
const metaHash = historyV1CapsuleMetaHashHex(latestCapsuleMeta);
const endRoot = historyV1FoldHistoryRootHex(meta.start_root_hex, sealedRows);
const rootAfter = historyV1FoldCapsulesRootHex(meta.capsules_root_before_hex, meta.capsule_id, bodyHash, metaHash, endRoot);

const checks = {
  snapshot_count_is_2: Number(snapshotCount) === 2,
  capsule_count_is_1: Number(capsuleCount) === 1,
  latest_capsule_id_is_first_half: latestCapsuleId === "2026-06-23T00.0000",
  sealed_row_count_is_1: meta.row_count === "000001",
  sealed_body_is_one_row: latestCapsuleBody.length === HISTORY_V1_ROW_LEN,
  sealed_body_hash_matches: bodyHash === meta.body_hash_hex,
  sealed_end_root_matches: endRoot === meta.end_root_hex,
  sealed_root_after_matches: rootAfter === latestCapsuleRootAfter,
  capsules_root_matches_latest: capsulesRoot === latestCapsuleRootAfter,
  open_capsule_id_is_second_half: openCapsuleId === "2026-06-23T12.0000",
  open_capsule_row_count_is_1: Number(openCapsuleRowCount) === 1,
  open_body_contains_second_row: openCapsuleBody === secondCallV1.history.row,
  history_root_tracks_open_end: historyRoot === openCapsuleEndRoot
};
const passed = Object.values(checks).every(Boolean);
if (!passed) {
  await writeReport({
    schema: "octra-vitals-program-v1-boundary-rehearsal-v0",
    status: "failed",
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    rpc_url: rpcUrl,
    circle_id: circleId,
    checks
  });
  throw new Error(`boundary rehearsal failed: ${JSON.stringify(checks)}`);
}

await writeReport({
  schema: "octra-vitals-program-v1-boundary-rehearsal-v0",
  status: "passed",
  generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  rpc_url: rpcUrl,
  circle_id: circleId,
  snapshots: [
    { snapshot_id: first.envelope.snapshot_id, tx_hash: firstSubmit.tx_hash, readback: firstSubmit.readback },
    { snapshot_id: second.envelope.snapshot_id, tx_hash: secondSubmit.tx_hash, readback: secondSubmit.readback }
  ],
  sealed_capsule: {
    capsule_id: meta.capsule_id,
    row_count: meta.row_count,
    body_bytes: latestCapsuleBody.length,
    body_hash_hex: bodyHash,
    meta_hash_hex: metaHash,
    end_root_hex: endRoot,
    root_after_hex: rootAfter
  },
  open_capsule: {
    capsule_id: openCapsuleId,
    row_count: Number(openCapsuleRowCount),
    body_bytes: openCapsuleBody.length,
    end_root_hex: openCapsuleEndRoot
  },
  checks
});
