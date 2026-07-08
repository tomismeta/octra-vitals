import { canonicalJson, sha256Tagged } from "./canonical-json.js";
import { capsuleBaseIdForObservedAt } from "./aml-history-v1.js";
import type { SnapshotArtifact } from "./types.js";

const SOURCE_REFS_HASH_DOMAIN = process.env.VITALS_SOURCE_REFS_HASH_DOMAIN || "octra-vitals:source-refs:v0";

function sourceRefsHashOfSnapshot(snapshot: SnapshotArtifact): string {
  return sha256Tagged(
    SOURCE_REFS_HASH_DOMAIN,
    snapshot.canonical_source_refs || canonicalJson(snapshot.envelope.source_refs || [])
  );
}

export function nativeReceiptSummary(receipt: any): Record<string, any> | null {
  if (!receipt || typeof receipt !== "object") return null;
  return {
    contract: receipt.contract || null,
    method: receipt.method || null,
    success: receipt.success ?? null,
    effort: receipt.effort ?? null,
    epoch: receipt.epoch ?? null,
    ts: receipt.ts ?? null,
    error: receipt.error ?? null,
    events: Array.isArray(receipt.events)
      ? receipt.events.map((event: any) => ({
        contract: event?.contract || null,
        event: event?.event || null,
        values: Array.isArray(event?.values) ? event.values : []
      }))
      : []
  };
}

function expectedMethod(submitReceipt: Record<string, any>): string {
  if (typeof submitReceipt.method === "string" && submitReceipt.method) return submitReceipt.method;
  if (typeof submitReceipt.call?.method === "string" && submitReceipt.call.method) return submitReceipt.call.method;
  switch (submitReceipt.commit_mode) {
    case "fact-v2": return "record_snapshot_fact_v2";
    case "fact-v1": return "record_snapshot_fact_v1";
    case "v1": return "record_snapshot_v1";
    default: return "record_snapshot_v0";
  }
}

function isFactLedgerMethod(method: string): boolean {
  return method === "record_snapshot_fact_v1" || method === "record_snapshot_fact_v2";
}

function isV1LikeMethod(method: string): boolean {
  return method === "record_snapshot_v1" || isFactLedgerMethod(method);
}

export function verifyNativeSnapshotReceipt(
  nativeReceipt: any,
  submitReceipt: Record<string, any>,
  snapshot: SnapshotArtifact
): Record<string, any> {
  const summary = nativeReceiptSummary(nativeReceipt);
  if (!summary) {
    return {
      verified: false,
      receipt: null,
      checks: { receipt_present: false }
    };
  }
  const events = Array.isArray(summary.events) ? summary.events : [];
  const snapshotEvent = events.find((event: any) => event.event === "SnapshotRecorded");
  const values = Array.isArray(snapshotEvent?.values) ? snapshotEvent.values : [];
  const expected = submitReceipt.expected_hashes || submitReceipt.call?.expected_hashes || {};
  const targetId = submitReceipt.target_kind === "circle_program"
    ? submitReceipt.programmed_circle_id || submitReceipt.target_id || submitReceipt.circle_id
    : submitReceipt.program_address || submitReceipt.target_id;
  const expectedSnapshotIndex = submitReceipt.snapshot_index ?? submitReceipt.call?.snapshot_index;
  const method = expectedMethod(submitReceipt);
  const common = {
    receipt_present: true,
    contract_matches: typeof targetId === "string" && targetId.length > 0 && summary.contract === targetId,
    method_matches: summary.method === method,
    success: summary.success === true,
    snapshot_event_present: Boolean(snapshotEvent),
    snapshot_id_matches: values[0] === snapshot.envelope.snapshot_id,
    snapshot_index_matches: expectedSnapshotIndex !== undefined && expectedSnapshotIndex !== null && String(values[1]) === String(expectedSnapshotIndex),
    payload_hash_matches: values[3] === snapshot.envelope.payload_hash
  };

  if (isV1LikeMethod(method)) {
    const observedAt = submitReceipt.observed_at || snapshot.envelope.observed_at;
    const capsuleBaseId = submitReceipt.fact_ledger?.capsule_base_id || submitReceipt.call?.fact_ledger?.capsule_base_id || capsuleBaseIdForObservedAt(observedAt);
    const checks = {
      ...common,
      history_row_hash_matches: typeof expected.history_row_hash === "string" && values[4] === expected.history_row_hash,
      ...(isFactLedgerMethod(method)
        ? {
          observed_at_matches: values[5] === observedAt,
          capsule_id_matches: String(values[6] || "").startsWith(`${capsuleBaseId}.`),
          submitter_present: Boolean(values[7])
        }
        : {})
    };
    return {
      verified: Object.values(checks).every(Boolean),
      receipt: summary,
      checks
    };
  }

  const sourceRefsHash = expected.source_refs_hash || sourceRefsHashOfSnapshot(snapshot);
  const checks = {
    ...common,
    evidence_hash_matches: values[4] === snapshot.envelope.evidence_manifest_hash,
    source_refs_hash_matches: values[5] === sourceRefsHash,
    summary_hash_matches: expected.summary_hash ? values[6] === expected.summary_hash : true
  };
  return {
    verified: Object.values(checks).every(Boolean),
    receipt: summary,
    checks
  };
}
