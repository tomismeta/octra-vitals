import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { encodeSummaryRow, summaryRowFromSnapshot } from "../lib/summary-window.js";
import type { SnapshotArtifact } from "../lib/types.js";

await import(new URL("../../app/verifier.js", import.meta.url).href);
const verifier = (globalThis as any).OctraVitalsVerifier;
const snapshot = JSON.parse(await readFile(resolve(new URL("../..", import.meta.url).pathname, "app/latest_snapshot.sample.json"), "utf8")) as SnapshotArtifact;

test("browser verifier checks complete latest semantics and summary fields", () => {
  const summary = encodeSummaryRow(summaryRowFromSnapshot(snapshot, 1));
  const observedMs = Date.parse(snapshot.envelope.observed_at);
  const result = verifier.verifySnapshotSemantics({
    envelope: snapshot.envelope,
    payload: snapshot.envelope.payload,
    evidenceManifest: snapshot.evidence_manifest,
    sourceRefs: snapshot.envelope.source_refs,
    summaryRow: summary,
    snapshotIndex: 1,
    nowMs: observedMs + 1_000,
    staleAfterMs: 20 * 60_000,
    maxFutureSkewMs: 5 * 60_000
  });
  assert.equal(result.fresh, true);

  const wrongBlock = { ...snapshot.envelope.payload, ethereum: { ...snapshot.envelope.payload.ethereum, block_number: "0x1" } };
  assert.throws(() => verifier.verifySnapshotSemantics({
    envelope: snapshot.envelope,
    payload: wrongBlock,
    evidenceManifest: snapshot.evidence_manifest,
    sourceRefs: snapshot.envelope.source_refs,
    summaryRow: summary,
    snapshotIndex: 1,
    nowMs: observedMs
  }), /external_block mismatch/);
});

test("browser verifier rejects malformed rows and future snapshots", () => {
  const summary = encodeSummaryRow(summaryRowFromSnapshot(snapshot, 1));
  assert.throws(() => verifier.parseSummaryRow(`99${summary.slice(2)}`), /version/);
  assert.throws(() => verifier.verifySnapshotSemantics({
    envelope: snapshot.envelope,
    payload: snapshot.envelope.payload,
    evidenceManifest: snapshot.evidence_manifest,
    sourceRefs: snapshot.envelope.source_refs,
    summaryRow: summary,
    snapshotIndex: 1,
    nowMs: Date.parse(snapshot.envelope.observed_at) - 301_000,
    maxFutureSkewMs: 300_000
  }), /future/);
  assert.throws(() => verifier.verifySnapshotSemantics({
    envelope: snapshot.envelope,
    payload: snapshot.envelope.payload,
    evidenceManifest: snapshot.evidence_manifest,
    sourceRefs: snapshot.envelope.source_refs,
    summaryRow: summary,
    snapshotIndex: 1,
    staleAfterMs: Number.NaN
  }), /stale threshold/);
});
