#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../lib/canonical-json.js";
import { circleProgramViewAtUrl, configuredProgrammedCircleId, stateTargetMode } from "../lib/circle-program.js";
import { contractCallAtUrl, octraProgramRpcUrls } from "../lib/octra-rpc.js";
import {
  encodeHistoryV1Row,
  historyV1RowFromSnapshot,
  historyV1RowHashHex,
  HISTORY_V1_SCHEMA_VERSION
} from "../lib/aml-history-v1.js";
import {
  FACT_LEDGER_CORE_FAMILY_ID,
  FACT_LEDGER_CORE_SCHEMA_ID,
  FACT_LEDGER_CORE_SCHEMA_VERSION,
  FACT_LEDGER_MANIFEST,
  factLedgerRowHashHex
} from "../lib/aml-fact-ledger.js";
import { sourceRefsHash, verifySnapshotArtifactHashes } from "../lib/program-state.js";
import { encodeSummaryRow, summaryHash, summaryRowFromSnapshot, SUMMARY_SCHEMA_VERSION } from "../lib/summary-window.js";
import type { SnapshotArtifact } from "../lib/types.js";

export interface RecordSnapshotCallV0 {
  schema: "octra-vitals-record-snapshot-call-v0";
  commit_mode: "v0";
  generated_at: string;
  program_address: string;
  target_kind?: "state_program" | "circle_program";
  circle_id?: string;
  method: "record_snapshot_v0";
  params: unknown[];
  compact_message_bytes: number;
  size_headroom?: Record<string, unknown>;
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

export interface RecordSnapshotCallV1 {
  schema: "octra-vitals-record-snapshot-call-v1";
  commit_mode: "v1";
  generated_at: string;
  program_address: string;
  target_kind?: "state_program" | "circle_program";
  circle_id?: string;
  method: "record_snapshot_v1";
  params: unknown[];
  compact_message_bytes: number;
  size_headroom?: Record<string, unknown>;
  snapshot_index: number;
  summary: {
    schema_version: string;
    row: string;
    row_hash: string;
  };
  history: {
    schema_version: string;
    row: string;
    row_hash: string;
  };
  expected_hashes: {
    payload_hash: string;
    evidence_manifest_hash: string;
    source_refs_hash: string;
    summary_hash: string;
    history_row_hash: string;
  };
  readonly_check: {
    method: string;
    expected_after_submit: string;
  };
}

export interface RecordSnapshotCallFactV1 {
  schema: "octra-vitals-record-snapshot-call-fact-v1";
  commit_mode: "fact-v1";
  generated_at: string;
  program_address: string;
  target_kind?: "state_program" | "circle_program";
  circle_id?: string;
  method: "record_snapshot_fact_v1";
  snapshot_id: string;
  observed_at: string;
  params: unknown[];
  compact_message_bytes: number;
  size_headroom?: Record<string, unknown>;
  snapshot_index: number;
  fact_ledger: {
    manifest: string;
    core_family_id: string;
    core_schema_id: string;
    core_schema_version: string;
    capsule_base_id: string;
  };
  summary: {
    schema_version: string;
    row: string;
    row_hash: string;
  };
  history: {
    schema_version: string;
    row: string;
    row_hash: string;
  };
  expected_hashes: {
    payload_hash: string;
    evidence_manifest_hash: string;
    source_refs_hash: string;
    summary_hash: string;
    history_row_hash: string;
  };
  readonly_check: {
    method: string;
    expected_after_submit: string;
  };
}

export interface RecordSnapshotCallFactV2 extends Omit<RecordSnapshotCallFactV1, "schema" | "commit_mode" | "method" | "fact_ledger"> {
  schema: "octra-vitals-record-snapshot-call-fact-v2";
  commit_mode: "fact-v2";
  method: "record_snapshot_fact_v2";
  fact_ledger: RecordSnapshotCallFactV1["fact_ledger"] & {
    aux_count: number;
    max_aux_rows: number;
  };
  metric_facts: {
    aux_count: number;
    rows: string[];
  };
}

export type RecordSnapshotCallFact = RecordSnapshotCallFactV1 | RecordSnapshotCallFactV2;

export type RecordSnapshotCall = RecordSnapshotCallV0 | RecordSnapshotCallV1 | RecordSnapshotCallFact;
export type RecordSnapshotVersion = "v0" | "v1" | "fact-v1" | "fact-v2";

export interface BuildRecordSnapshotCallOptions {
  compactMaxMessageBytes?: number;
  generatedAt?: string;
  programAddress?: string | null;
  snapshotIndex?: number;
  stateSourceMode?: string;
  submitEnabled?: boolean;
  recordVersion?: RecordSnapshotVersion;
  auxRows?: string[];
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

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function warnIfLow(label: string, used: number, limit: number, warnings: string[]): void {
  if (limit <= 0) return;
  const remaining = limit - used;
  if (remaining < 0) {
    warnings.push(`${label}_over_limit`);
  } else if (remaining / limit <= 0.15) {
    warnings.push(`${label}_within_15pct_limit`);
  }
}

function buildSizeHeadroom(input: {
  canonicalPayload: string;
  canonicalEvidenceManifest: string;
  canonicalSourceRefs: string;
  summaryRow: string;
  historyRow?: string;
  params: unknown[];
  compactMessageBytes: number;
  compactMaxMessageBytes: number;
}): Record<string, unknown> {
  const payloadBytes = byteLength(input.canonicalPayload);
  const evidenceBytes = byteLength(input.canonicalEvidenceManifest);
  const sourceRefsBytes = byteLength(input.canonicalSourceRefs);
  const summaryRowBytes = byteLength(input.summaryRow);
  const historyRowBytes = input.historyRow ? byteLength(input.historyRow) : null;
  const paramsJsonBytes = byteLength(JSON.stringify(input.params));
  const payloadLimit = Number(process.env.VITALS_AML_MAX_PAYLOAD_BYTES || 12_000);
  const evidenceLimit = Number(process.env.VITALS_AML_MAX_EVIDENCE_BYTES || 8_000);
  const sourceRefsLimit = Number(process.env.VITALS_AML_MAX_SOURCE_REFS_BYTES || 4_096);
  const capsuleRowLimit = Number(process.env.VITALS_FACT_LEDGER_CAPSULE_ROW_LIMIT || 48);
  const warnings: string[] = [];
  warnIfLow("payload", payloadBytes, payloadLimit, warnings);
  warnIfLow("evidence_manifest", evidenceBytes, evidenceLimit, warnings);
  warnIfLow("source_refs", sourceRefsBytes, sourceRefsLimit, warnings);
  warnIfLow("record_call", input.compactMessageBytes, input.compactMaxMessageBytes, warnings);
  return {
    schema: "octra-vitals-size-headroom-v0",
    bytes: {
      canonical_payload: payloadBytes,
      canonical_evidence_manifest: evidenceBytes,
      canonical_source_refs: sourceRefsBytes,
      summary_row: summaryRowBytes,
      history_row: historyRowBytes,
      record_call_params_json: paramsJsonBytes,
      compact_message: input.compactMessageBytes
    },
    limits: {
      canonical_payload: payloadLimit,
      canonical_evidence_manifest: evidenceLimit,
      canonical_source_refs: sourceRefsLimit,
      compact_message: input.compactMaxMessageBytes,
      fact_capsule_row_limit: capsuleRowLimit,
      fact_capsule_body_bytes: historyRowBytes ? capsuleRowLimit * historyRowBytes : null
    },
    remaining_bytes: {
      canonical_payload: payloadLimit - payloadBytes,
      canonical_evidence_manifest: evidenceLimit - evidenceBytes,
      canonical_source_refs: sourceRefsLimit - sourceRefsBytes,
      compact_message: input.compactMaxMessageBytes - input.compactMessageBytes
    },
    warnings
  };
}

function recordSnapshotVersion(options: BuildRecordSnapshotCallOptions): RecordSnapshotVersion {
  const value = options.recordVersion || process.env.VITALS_RECORD_SNAPSHOT_VERSION || "v0";
  if (value !== "v0" && value !== "v1" && value !== "fact-v1" && value !== "fact-v2") {
    throw new Error("VITALS_RECORD_SNAPSHOT_VERSION must be v0, v1, fact-v1, or fact-v2");
  }
  return value;
}

function factLedgerCapsuleBaseId(observedAt: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):\d{2}:\d{2}Z$/.exec(observedAt);
  if (!match) throw new Error(`invalid snapshot observed_at for fact-ledger capsule: ${observedAt}`);
  const hour = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`invalid snapshot observed_at hour for fact-ledger capsule: ${observedAt}`);
  }
  return `${match[1]}T${hour < 12 ? "00" : "12"}`;
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
  const version = recordSnapshotVersion(options);

  if (version === "v1" || version === "fact-v1" || version === "fact-v2") {
    const historyRowModel = historyV1RowFromSnapshot(snapshot, snapshotIndex);
    const historyRow = encodeHistoryV1Row(historyRowModel);
    if (version === "fact-v1" || version === "fact-v2") {
      const historyRowHash = factLedgerRowHashHex(FACT_LEDGER_CORE_FAMILY_ID, FACT_LEDGER_CORE_SCHEMA_ID, historyRow);
      const capsuleBaseId = factLedgerCapsuleBaseId(envelope.observed_at);
      const requestedAuxRows = options.auxRows || [];
      if (requestedAuxRows.length > 4) throw new Error("fact-v2 supports at most 4 aux rows per snapshot");
      if (requestedAuxRows.some((row) => typeof row !== "string" || row.length === 0)) {
        throw new Error("auxRows must contain non-empty encoded fact rows");
      }
      if (requestedAuxRows.length > 0 && version !== "fact-v2") {
        throw new Error("auxRows are only supported for record_snapshot_fact_v2");
      }
      const auxRows = [
        ...requestedAuxRows,
        ...Array.from({ length: 4 - requestedAuxRows.length }, () => "")
      ];
      const auxCount = requestedAuxRows.length;
      const params = [
        canonicalPayload,
        canonicalEvidenceManifest,
        canonicalSourceRefs,
        summaryRow,
        historyRow,
        envelope.observed_at,
        capsuleBaseId,
        payload.octra.epoch,
        snapshotIndex,
        ...(version === "fact-v2" ? [auxCount, ...auxRows] : [])
      ];
      const compactMessageBytes = Buffer.byteLength(JSON.stringify(params));
      const compactMaxMessageBytes = options.compactMaxMessageBytes ??
        Number(process.env.VITALS_COMPACT_SNAPSHOT_MAX_MESSAGE_BYTES || 22_000);
      if (compactMessageBytes > compactMaxMessageBytes) {
        throw new Error(`record_snapshot_${version} call would be ${compactMessageBytes} bytes, above VITALS_COMPACT_SNAPSHOT_MAX_MESSAGE_BYTES=${compactMaxMessageBytes}`);
      }
      const sizeHeadroom = buildSizeHeadroom({
        canonicalPayload,
        canonicalEvidenceManifest,
        canonicalSourceRefs,
        summaryRow,
        historyRow,
        params,
        compactMessageBytes,
        compactMaxMessageBytes
      });

      const circleId = configuredProgrammedCircleId();
      if (version === "fact-v2") {
        return {
          schema: "octra-vitals-record-snapshot-call-fact-v2",
          commit_mode: "fact-v2",
          generated_at: options.generatedAt || isoNow(),
          program_address: options.programAddress || process.env.VITALS_STATE_PROGRAM_ADDRESS || circleId || "pending",
          target_kind: stateTargetMode(),
          ...(circleId ? { circle_id: circleId } : {}),
          method: "record_snapshot_fact_v2",
          snapshot_id: envelope.snapshot_id,
          observed_at: envelope.observed_at,
          params,
          compact_message_bytes: compactMessageBytes,
          size_headroom: sizeHeadroom,
          snapshot_index: snapshotIndex,
          fact_ledger: {
            manifest: FACT_LEDGER_MANIFEST,
            core_family_id: FACT_LEDGER_CORE_FAMILY_ID,
            core_schema_id: FACT_LEDGER_CORE_SCHEMA_ID,
            core_schema_version: FACT_LEDGER_CORE_SCHEMA_VERSION,
            capsule_base_id: capsuleBaseId,
            aux_count: auxCount,
            max_aux_rows: auxRows.length
          },
          metric_facts: {
            aux_count: auxCount,
            rows: auxRows
          },
          summary: {
            schema_version: SUMMARY_SCHEMA_VERSION,
            row: summaryRow,
            row_hash: latestSummaryHash
          },
          history: {
            schema_version: FACT_LEDGER_CORE_SCHEMA_VERSION,
            row: historyRow,
            row_hash: historyRowHash
          },
          expected_hashes: {
            payload_hash: envelope.payload_hash,
            evidence_manifest_hash: envelope.evidence_manifest_hash,
            source_refs_hash: refsHash,
            summary_hash: latestSummaryHash,
            history_row_hash: historyRowHash
          },
          readonly_check: {
            method: "get_latest_history_row_hash",
            expected_after_submit: historyRowHash
          }
        };
      }
      return {
        schema: "octra-vitals-record-snapshot-call-fact-v1",
        commit_mode: "fact-v1",
        generated_at: options.generatedAt || isoNow(),
        program_address: options.programAddress || process.env.VITALS_STATE_PROGRAM_ADDRESS || circleId || "pending",
        target_kind: stateTargetMode(),
        ...(circleId ? { circle_id: circleId } : {}),
        method: "record_snapshot_fact_v1",
        snapshot_id: envelope.snapshot_id,
        observed_at: envelope.observed_at,
        params,
        compact_message_bytes: compactMessageBytes,
        size_headroom: sizeHeadroom,
        snapshot_index: snapshotIndex,
        fact_ledger: {
          manifest: FACT_LEDGER_MANIFEST,
          core_family_id: FACT_LEDGER_CORE_FAMILY_ID,
          core_schema_id: FACT_LEDGER_CORE_SCHEMA_ID,
          core_schema_version: FACT_LEDGER_CORE_SCHEMA_VERSION,
          capsule_base_id: capsuleBaseId
        },
        summary: {
          schema_version: SUMMARY_SCHEMA_VERSION,
          row: summaryRow,
          row_hash: latestSummaryHash
        },
        history: {
          schema_version: FACT_LEDGER_CORE_SCHEMA_VERSION,
          row: historyRow,
          row_hash: historyRowHash
        },
        expected_hashes: {
          payload_hash: envelope.payload_hash,
          evidence_manifest_hash: envelope.evidence_manifest_hash,
          source_refs_hash: refsHash,
          summary_hash: latestSummaryHash,
          history_row_hash: historyRowHash
        },
        readonly_check: {
          method: "get_latest_history_row_hash",
          expected_after_submit: historyRowHash
        }
      };
    }
    const legacyHistoryRowHash = historyV1RowHashHex(historyRow);
    const params = [
      envelope.snapshot_id,
      envelope.observed_at,
      historyRowModel.observed_at_unix,
      payload.octra.epoch,
      snapshotIndex,
      payload.schema_version,
      SUMMARY_SCHEMA_VERSION,
      HISTORY_V1_SCHEMA_VERSION,
      envelope.payload_hash,
      envelope.evidence_manifest_hash,
      refsHash,
      latestSummaryHash,
      canonicalPayload,
      canonicalEvidenceManifest,
      canonicalSourceRefs,
      summaryRow,
      historyRow
    ];
    const compactMessageBytes = Buffer.byteLength(JSON.stringify(params));
    const compactMaxMessageBytes = options.compactMaxMessageBytes ??
      Number(process.env.VITALS_COMPACT_SNAPSHOT_MAX_MESSAGE_BYTES || 20_000);
    if (compactMessageBytes > compactMaxMessageBytes) {
      throw new Error(`record_snapshot_v1 call would be ${compactMessageBytes} bytes, above VITALS_COMPACT_SNAPSHOT_MAX_MESSAGE_BYTES=${compactMaxMessageBytes}`);
    }
    const sizeHeadroom = buildSizeHeadroom({
      canonicalPayload,
      canonicalEvidenceManifest,
      canonicalSourceRefs,
      summaryRow,
      historyRow,
      params,
      compactMessageBytes,
      compactMaxMessageBytes
    });

    const circleId = configuredProgrammedCircleId();
    return {
      schema: "octra-vitals-record-snapshot-call-v1",
      commit_mode: "v1",
      generated_at: options.generatedAt || isoNow(),
      program_address: options.programAddress || process.env.VITALS_STATE_PROGRAM_ADDRESS || circleId || "pending",
      target_kind: stateTargetMode(),
      ...(circleId ? { circle_id: circleId } : {}),
      method: "record_snapshot_v1",
      params,
      compact_message_bytes: compactMessageBytes,
      size_headroom: sizeHeadroom,
      snapshot_index: snapshotIndex,
      summary: {
        schema_version: SUMMARY_SCHEMA_VERSION,
        row: summaryRow,
        row_hash: latestSummaryHash
      },
      history: {
        schema_version: HISTORY_V1_SCHEMA_VERSION,
        row: historyRow,
        row_hash: legacyHistoryRowHash
      },
      expected_hashes: {
        payload_hash: envelope.payload_hash,
        evidence_manifest_hash: envelope.evidence_manifest_hash,
        source_refs_hash: refsHash,
        summary_hash: latestSummaryHash,
        history_row_hash: legacyHistoryRowHash
      },
      readonly_check: {
        method: "get_latest_history_row_hash",
        expected_after_submit: legacyHistoryRowHash
      }
    };
  }

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
  const sizeHeadroom = buildSizeHeadroom({
    canonicalPayload,
    canonicalEvidenceManifest,
    canonicalSourceRefs,
    summaryRow,
    params,
    compactMessageBytes,
    compactMaxMessageBytes
  });

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
    size_headroom: sizeHeadroom,
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
  const epoch = call.commit_mode === "v0" ? call.params[2] : call.commit_mode === "v1" ? call.params[3] : call.params[7];
  const snapshotId = "snapshot_id" in call ? call.snapshot_id : call.params[0];
  await writeRecordSnapshotCall(call, outPath);
  console.log(JSON.stringify({
    out: outPath,
    commit_mode: call.commit_mode,
    snapshot_id: snapshotId,
    snapshot_index: call.snapshot_index,
    epoch,
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
