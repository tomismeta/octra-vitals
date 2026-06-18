#!/usr/bin/env node
import { readLatestProgramSnapshot } from "../lib/program-state.js";

const programAddress = process.env.VITALS_STATE_PROGRAM_ADDRESS || process.argv[2];
if (!programAddress || programAddress === "pending") {
  throw new Error("VITALS_STATE_PROGRAM_ADDRESS or argv[2] is required");
}

const snapshot = await readLatestProgramSnapshot(programAddress);
console.log(JSON.stringify({
  schema: "octra-vitals-program-read-report-v0",
  program_address: programAddress,
  snapshot_id: snapshot.envelope.snapshot_id,
  observed_at: snapshot.envelope.observed_at,
  epoch: snapshot.envelope.payload.octra.epoch,
  payload_hash: snapshot.envelope.payload_hash,
  evidence_manifest_hash: snapshot.envelope.evidence_manifest_hash,
  source_refs: snapshot.envelope.source_refs.length
}, null, 2));
