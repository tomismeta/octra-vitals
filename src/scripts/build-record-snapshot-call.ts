#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../lib/canonical-json.js";
import { circleProgramViewAtUrl, configuredProgrammedCircleId, stateTargetMode } from "../lib/circle-program.js";
import { contractCallAtUrl, octraProgramRpcUrls } from "../lib/octra-rpc.js";
import { sourceRefsHash, verifySnapshotArtifactHashes } from "../lib/program-state.js";
import { encodeSummaryRow, summaryHash, summaryRowFromSnapshot, SUMMARY_SCHEMA_VERSION } from "../lib/summary-window.js";
import type { SnapshotArtifact } from "../lib/types.js";

export interface RecordSnapshotCall {
  schema: "octra-vitals-record-snapshot-call-v0";
  commit_mode: "v0";
  generated_at: string;
  program_address: string;
  target_kind?: "state_program" | "circle_program";
  circle_id?: string;
  method: "record_snapshot_v0";
  params: unknown[];
  compact_message_bytes: number;
  snapshot_index: number;
  summary: {
    schema_version: string;
    row: string;
    row_hash: string;
  };
  expected_hashes: {
    payload_hash: string;
    evidence_manifest_hash: string;
    source_refs_hash: string;
    summary_hash: string;
  };
  readonly_check: {
    method: string;
    expected_after_submit: string;
  };
}

export interface BuildRecordSnapshotCallOptions {
  compactMaxMessageBytes?: number;
  generatedAt?: string;
  programAddress?: string | null;
  snapshotIndex?: number;
  stateSourceMode?: string;
  submitEnabled?: boolean;
}

const root = resolve(new URL("../..", import.meta.url).pathname);

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function isDirectCli(metaUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(resolve(argvPath));
  } catch {
    return fileURLToPath(metaUrl) === resolve(argvPath);
  }
}

function minProgramRpcUrls(forceMultiRpc: boolean): number {
  const configured = process.env.VITALS_MIN_PROGRAM_RPC_URLS;
  const parsed = configured ? Number(configured) : forceMultiRpc ? 2 : 1;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("VITALS_MIN_PROGRAM_RPC_URLS must be a positive integer");
  }
  return Math.max(forceMultiRpc ? 2 : 1, parsed);
}

async function nextSnapshotIndex(options: BuildRecordSnapshotCallOptions = {}): Promise<number> {
  if (options.snapshotIndex !== undefined) {
    if (!Number.isInteger(options.snapshotIndex) || options.snapshotIndex <= 0) {
      throw new Error("snapshotIndex must be a positive integer");
    }
    return options.snapshotIndex;
  }

  const envValue = process.env.VITALS_NEXT_SNAPSHOT_INDEX;
  if (envValue) {
    const parsed = Number(envValue);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("VITALS_NEXT_SNAPSHOT_INDEX must be a positive integer");
    return parsed;
  }

  const programAddress = options.programAddress ?? process.env.VITALS_STATE_PROGRAM_ADDRESS;
  const targetMode = stateTargetMode();
  const circleId = configuredProgrammedCircleId();
  const requiresProgramCount = options.submitEnabled === true ||
    process.env.VITALS_SUBMIT === "1" ||
    options.stateSourceMode === "program_required" ||
    process.env.VITALS_STATE_SOURCE_MODE === "program_required";
  const urls = octraProgramRpcUrls();
  const minUrls = minProgramRpcUrls(process.env.VITALS_REQUIRE_MULTI_RPC_FOR_SUBMIT === "1");
  if (requiresProgramCount && urls.length < minUrls) {
    throw new Error(`at least ${minUrls} Octra program RPC URL(s) are required to derive the next snapshot index; got ${urls.length}`);
  }

  const assertSameCount = (counts: Array<{ url: string; count: number }>): number => {
    const [primary, ...rest] = counts;
    if (!primary) throw new Error("no Octra program RPC URL configured");
    for (const candidate of rest) {
      if (candidate.count !== primary.count) {
        throw new Error(`program RPC mismatch from ${candidate.url}: get_snapshot_count`);
      }
    }
    return primary.count;
  };

  if (targetMode === "circle_program") {
    if (!circleId) {
      if (requiresProgramCount) {
        throw new Error("VITALS_PROGRAMMED_CIRCLE_ID is required to derive the next snapshot index in circle_program mode");
      }
      return 1;
    }
    const counts = await Promise.all(urls.map(async (url) => ({
      url,
      count: Number(await circleProgramViewAtUrl<number>(url, circleId, "get_snapshot_count") || 0)
    })));
    return assertSameCount(counts) + 1;
  }
  if (!programAddress || programAddress === "pending") {
    if (requiresProgramCount) {
      throw new Error("VITALS_STATE_PROGRAM_ADDRESS is required to derive the next snapshot index");
    }
    return 1;
  }

  const counts = await Promise.all(urls.map(async (url) => ({
    url,
    count: Number(await contractCallAtUrl<number>(url, programAddress, "get_snapshot_count") || 0)
  })));
  return assertSameCount(counts) + 1;
}

export async function buildRecordSnapshotCall(
  snapshot: SnapshotArtifact,
  options: BuildRecordSnapshotCallOptions = {}
): Promise<RecordSnapshotCall> {
  verifySnapshotArtifactHashes(snapshot);

  const envelope = snapshot.envelope;
  const payload = envelope.payload;
  const evidenceManifest = snapshot.evidence_manifest;
  const canonicalPayload = canonicalJson(payload);
  const canonicalEvidenceManifest = canonicalJson(evidenceManifest);
  const canonicalSourceRefs = canonicalJson(envelope.source_refs || []);
  if (snapshot.canonical_payload !== canonicalPayload) {
    throw new Error("snapshot.canonical_payload does not match canonicalJson(envelope.payload)");
  }
  if (snapshot.canonical_evidence_manifest !== canonicalEvidenceManifest) {
    throw new Error("snapshot.canonical_evidence_manifest does not match canonicalJson(evidence_manifest)");
  }
  if (snapshot.canonical_source_refs && snapshot.canonical_source_refs !== canonicalSourceRefs) {
    throw new Error("snapshot.canonical_source_refs does not match canonicalJson(envelope.source_refs)");
  }

  const canonicalPayloadObject = JSON.parse(canonicalPayload) as { octra?: { epoch?: unknown } };
  if (canonicalPayloadObject.octra?.epoch !== payload.octra.epoch) {
    throw new Error("canonical payload epoch does not match envelope payload epoch");
  }

  const refsHash = sourceRefsHash(envelope.source_refs);
  const snapshotIndex = await nextSnapshotIndex(options);
  const summaryRow = encodeSummaryRow(summaryRowFromSnapshot(snapshot, snapshotIndex));
  const latestSummaryHash = summaryHash(summaryRow);

  const params = [
    envelope.snapshot_id,
    envelope.observed_at,
    payload.octra.epoch,
    snapshotIndex,
    payload.schema_version,
    SUMMARY_SCHEMA_VERSION,
    envelope.payload_hash,
    envelope.evidence_manifest_hash,
    refsHash,
    latestSummaryHash,
    canonicalPayload,
    canonicalEvidenceManifest,
    canonicalSourceRefs,
    summaryRow
  ];
  const compactMessageBytes = Buffer.byteLength(JSON.stringify(params));
  const compactMaxMessageBytes = options.compactMaxMessageBytes ??
    Number(process.env.VITALS_COMPACT_SNAPSHOT_MAX_MESSAGE_BYTES || 16_000);
  if (compactMessageBytes > compactMaxMessageBytes) {
    throw new Error(`record_snapshot_v0 call would be ${compactMessageBytes} bytes, above VITALS_COMPACT_SNAPSHOT_MAX_MESSAGE_BYTES=${compactMaxMessageBytes}`);
  }

  const circleId = configuredProgrammedCircleId();
  return {
    schema: "octra-vitals-record-snapshot-call-v0",
    commit_mode: "v0",
    generated_at: options.generatedAt || isoNow(),
    program_address: options.programAddress || process.env.VITALS_STATE_PROGRAM_ADDRESS || circleId || "pending",
    target_kind: stateTargetMode(),
    ...(circleId ? { circle_id: circleId } : {}),
    method: "record_snapshot_v0",
    params,
    compact_message_bytes: compactMessageBytes,
    snapshot_index: snapshotIndex,
    summary: {
      schema_version: SUMMARY_SCHEMA_VERSION,
      row: summaryRow,
      row_hash: latestSummaryHash
    },
    expected_hashes: {
      payload_hash: envelope.payload_hash,
      evidence_manifest_hash: envelope.evidence_manifest_hash,
      source_refs_hash: refsHash,
      summary_hash: latestSummaryHash
    },
    readonly_check: {
      method: "get_latest_payload_hash",
      expected_after_submit: envelope.payload_hash
    }
  };
}

export async function writeRecordSnapshotCall(call: RecordSnapshotCall, outPath: string): Promise<void> {
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(call, null, 2)}\n`);
}

async function main(): Promise<void> {
  const inputPath = process.argv[2] || join(root, "build", "latest_snapshot.json");
  const outPath = process.argv[3] || join(root, "build", "record_snapshot_call.json");
  const snapshot = JSON.parse(await readFile(inputPath, "utf8")) as SnapshotArtifact;
  const call = await buildRecordSnapshotCall(snapshot);
  await writeRecordSnapshotCall(call, outPath);
  console.log(JSON.stringify({
    out: outPath,
    commit_mode: call.commit_mode,
    snapshot_id: call.params[0],
    snapshot_index: call.snapshot_index,
    epoch: call.params[2],
    call_count: 1,
    compact_message_bytes: call.compact_message_bytes,
    ...call.expected_hashes
  }, null, 2));
}

if (isDirectCli(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
