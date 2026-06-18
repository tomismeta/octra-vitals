#!/usr/bin/env node
import { buildLiveSnapshot, writeSnapshotArtifacts } from "../lib/snapshot.js";
import { join } from "node:path";

function errorText(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error);
}

function argValue(name: string, fallback: string): string {
  const idx = process.argv.indexOf(name);
  return idx === -1 ? fallback : process.argv[idx + 1] || fallback;
}

const outPath = argValue("--out", "build/latest_snapshot.json");
const defaultEvidenceDir = process.env.VITALS_DATA_DIR ? join(process.env.VITALS_DATA_DIR, "evidence") : "data/evidence";
const evidenceDir = argValue("--evidence-dir", defaultEvidenceDir);

try {
  const snapshot = await buildLiveSnapshot();
  await writeSnapshotArtifacts(snapshot, outPath, evidenceDir);
  console.log(JSON.stringify({
    out: outPath,
    snapshot_id: snapshot.envelope.snapshot_id,
    payload_hash: snapshot.envelope.payload_hash,
    evidence_manifest_hash: snapshot.envelope.evidence_manifest_hash
  }, null, 2));
} catch (error) {
  console.error(errorText(error));
  process.exit(1);
}
