import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canonicalJson, sha256Tagged } from "../lib/canonical-json.js";
import { sourceRefsHash, verifySnapshotArtifactHashes } from "../lib/program-state.js";
import type { SnapshotArtifact, SnapshotPayload } from "../lib/types.js";

const SNAPSHOT_TAG = "octra-vitals:snapshot:v0";
const EVIDENCE_TAG = "octra-vitals:evidence:v0";
const SOURCE_REFS_TAG = "octra-vitals:source-refs:v0";

async function loadSampleSnapshot(): Promise<SnapshotArtifact> {
  return JSON.parse(await readFile("app/latest_snapshot.sample.json", "utf8")) as SnapshotArtifact;
}

test("canonicalJson sorts object keys and omits undefined values", () => {
  const value = {
    z: 1,
    omitted: undefined,
    nested: { beta: 2, alpha: "1" },
    arr: [3, { b: false, a: true }]
  };

  assert.equal(canonicalJson(value), '{"arr":[3,{"a":true,"b":false}],"nested":{"alpha":"1","beta":2},"z":1}');
});

test("sample snapshot canonical payload, evidence, and source refs round trip", async () => {
  const snapshot = await loadSampleSnapshot();
  const canonicalSourceRefs = snapshot.canonical_source_refs;
  if (!canonicalSourceRefs) throw new Error("sample snapshot is missing canonical_source_refs");

  assert.equal(canonicalJson(snapshot.envelope.payload), snapshot.canonical_payload);
  assert.equal(canonicalJson(snapshot.evidence_manifest), snapshot.canonical_evidence_manifest);
  assert.equal(canonicalJson(snapshot.envelope.source_refs), canonicalSourceRefs);

  assert.equal(sha256Tagged(SNAPSHOT_TAG, snapshot.canonical_payload), snapshot.envelope.payload_hash);
  assert.equal(sha256Tagged(EVIDENCE_TAG, snapshot.canonical_evidence_manifest), snapshot.envelope.evidence_manifest_hash);
  assert.equal(sourceRefsHash(snapshot.envelope.source_refs), sha256Tagged(SOURCE_REFS_TAG, canonicalSourceRefs));
});

test("snapshot hash verification rejects non-canonical program strings", async () => {
  const snapshot = await loadSampleSnapshot();
  const nonCanonical = JSON.stringify(snapshot.envelope.payload, null, 2);
  const tampered = structuredClone(snapshot);
  tampered.canonical_payload = nonCanonical;
  tampered.envelope.payload_hash = sha256Tagged(SNAPSHOT_TAG, nonCanonical);

  assert.throws(
    () => verifySnapshotArtifactHashes(tampered),
    /canonical payload does not match canonicalJson/
  );
});

test("snapshot payload shape keeps AML bridge-prefix compatibility", async () => {
  const snapshot = await loadSampleSnapshot();

  assert.match(snapshot.canonical_payload, /^\{"bridge":/);
  assert.match(snapshot.canonical_evidence_manifest, /^\{"entries":/);

  const withRecoveryHealth = structuredClone(snapshot.envelope.payload) as SnapshotPayload & {
    relayer: SnapshotPayload["relayer"] & {
      recovery_health: {
        outstanding_raw: string;
        top_claim_count: number;
      };
    };
  };
  withRecoveryHealth.relayer.recovery_health = {
    outstanding_raw: snapshot.envelope.payload.bridge.unclaimed_oct_raw,
    top_claim_count: 10
  };

  assert.match(canonicalJson(withRecoveryHealth), /^\{"bridge":/);

  const withTopLevelBeforeBridge = {
    attestation: { note: "this would sort before bridge" },
    ...snapshot.envelope.payload
  };

  assert.equal(canonicalJson(withTopLevelBeforeBridge).startsWith('{"bridge":'), false);
});
