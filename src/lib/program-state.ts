import { canonicalJson, sha256Tagged } from "./canonical-json.js";
import { circleProgramViewAtUrl } from "./circle-program.js";
import { contractCallAtUrl, octraProgramRpcUrls } from "./octra-rpc.js";
import {
  decodeHistoryV1CapsuleMeta,
  decodeHistoryV1Rows,
  historyV1CapsuleBodyHashHex,
  historyV1CapsuleMetaHashHex,
  historyV1EmptyHistoryRootHex,
  historyV1FoldCapsulesRootHex,
  historyV1FoldHistoryRootHex,
  HISTORY_V1_ROW_LEN,
  type HistoryV1ObservationRow
} from "./aml-history-v1.js";
import {
  decodeFactCapsuleMeta,
  factLedgerEraAnchorHashHex,
  factLedgerCapsuleBodyHashHex,
  factLedgerEmptyFamilyCapsulesRootHex,
  factLedgerFoldFamilyCapsulesRootHex,
  factLedgerFoldFamilyRootHex,
  FACT_LEDGER_CORE_FAMILY_ID,
  FACT_LEDGER_CORE_SCHEMA_ID
} from "./aml-fact-ledger.js";
import { assertLatestSummaryMatchesSnapshot, encodeSummaryRow, parseSummaryWindow, summaryHash, summaryWindowHash, SUMMARY_ROW_LEN, type ProgramHistoryEra, type ProgramHistoryWindow, type SummaryRow } from "./summary-window.js";
import type { EvidenceEntry, EvidenceManifest, SnapshotArtifact, SnapshotEnvelope, SnapshotPayload, SourceRef } from "./types.js";

const SNAPSHOT_HASH_DOMAIN = process.env.VITALS_SNAPSHOT_HASH_DOMAIN || "octra-vitals:snapshot:v0";
const EVIDENCE_HASH_DOMAIN = process.env.VITALS_EVIDENCE_HASH_DOMAIN || "octra-vitals:evidence:v0";
const SOURCE_REFS_HASH_DOMAIN = process.env.VITALS_SOURCE_REFS_HASH_DOMAIN || "octra-vitals:source-refs:v0";

interface SnapshotReadback {
  snapshot: SnapshotArtifact;
  snapshot_index: number;
  latest_summary: string;
  latest_summary_hash: string;
  submitter: string;
}

export interface ProgramHistoryReadOptions {
  maxSealedCapsules?: number | null;
}

export function configuredProgramAddress(value = process.env.VITALS_STATE_PROGRAM_ADDRESS): string | null {
  if (!value || value === "pending") return null;
  return value;
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function assertHash(label: string, actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

function sourceRefsFromEvidence(evidence: EvidenceEntry[]): SourceRef[] {
  return evidence.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    method: entry.method,
    url: entry.url,
    hash: entry.response_hash
  }));
}

export function sourceRefsHash(sourceRefs: SourceRef[]): string {
  return sha256Tagged(SOURCE_REFS_HASH_DOMAIN, canonicalJson(sourceRefs));
}

function programRpcUrls(): string[] {
  return octraProgramRpcUrls();
}

function assertSameLatestSnapshot(primary: SnapshotReadback, candidate: SnapshotReadback, url: string): void {
  const fields: Array<[string, unknown, unknown]> = [
    ["snapshot_index", candidate.snapshot_index, primary.snapshot_index],
    ["snapshot_id", candidate.snapshot.envelope.snapshot_id, primary.snapshot.envelope.snapshot_id],
    ["observed_at", candidate.snapshot.envelope.observed_at, primary.snapshot.envelope.observed_at],
    ["payload_hash", candidate.snapshot.envelope.payload_hash, primary.snapshot.envelope.payload_hash],
    ["evidence_manifest_hash", candidate.snapshot.envelope.evidence_manifest_hash, primary.snapshot.envelope.evidence_manifest_hash],
    ["canonical_payload", candidate.snapshot.canonical_payload, primary.snapshot.canonical_payload],
    ["canonical_evidence_manifest", candidate.snapshot.canonical_evidence_manifest, primary.snapshot.canonical_evidence_manifest],
    ["canonical_source_refs", candidate.snapshot.canonical_source_refs, primary.snapshot.canonical_source_refs],
    ["latest_summary", candidate.latest_summary, primary.latest_summary],
    ["latest_summary_hash", candidate.latest_summary_hash, primary.latest_summary_hash],
    ["submitter", candidate.submitter, primary.submitter]
  ];
  for (const [label, actual, expected] of fields) {
    if (actual !== expected) {
      throw new Error(`program RPC mismatch from ${url}: ${label}`);
    }
  }
}

function assertSameHistory(primary: ProgramHistoryWindow, candidate: ProgramHistoryWindow, url: string): void {
  const fields: Array<[string, unknown, unknown]> = [
    ["first_index", candidate.first_index, primary.first_index],
    ["row_count", candidate.row_count, primary.row_count],
    ["row_len", candidate.row_len, primary.row_len],
    ["window_hash", candidate.window_hash, primary.window_hash],
    ["window", candidate.window, primary.window]
  ];
  for (const [label, actual, expected] of fields) {
    if (actual !== expected) {
      throw new Error(`program history RPC mismatch from ${url}: ${label}`);
    }
  }
}

function historyLatestIndex(history: ProgramHistoryWindow): number {
  return history.rows[history.rows.length - 1]?.snapshot_index || 0;
}

function historyFirstIndex(history: ProgramHistoryWindow): number {
  return history.rows[0]?.snapshot_index || history.first_index || 0;
}

function combinedHistoryWindow(eras: ProgramHistoryWindow[], historyDiscovery = "aml_multi_era_fact_family_core_capsules_verified"): ProgramHistoryWindow {
  const nonEmpty = eras.filter((era) => era.row_count > 0 && era.rows.length > 0);
  if (!nonEmpty.length) {
    return {
      first_index: 0,
      row_count: 0,
      row_len: SUMMARY_ROW_LEN,
      window: "",
      window_hash: summaryWindowHash(""),
      rows: [],
      history_discovery: historyDiscovery,
      proof: {
        scope: "unavailable",
        truncated: false,
        families: [],
        capsules: []
      },
      eras: eras.flatMap((era) => era.eras || [])
    };
  }
  const rows: SummaryRow[] = [];
  const windows: string[] = [];
  for (const era of nonEmpty) {
    if (era.row_len !== SUMMARY_ROW_LEN) throw new Error("era history row length mismatch");
    const expectedFirst = rows.length === 0 ? historyFirstIndex(era) : (rows[rows.length - 1]?.snapshot_index || 0) + 1;
    const actualFirst = historyFirstIndex(era);
    if (actualFirst !== expectedFirst) {
      throw new Error(`era history index continuity mismatch: expected ${expectedFirst}, got ${actualFirst}`);
    }
    rows.push(...era.rows);
    windows.push(era.window);
  }
  const window = windows.join("");
  const combined: ProgramHistoryWindow = {
    first_index: rows[0]?.snapshot_index || 0,
    row_count: rows.length,
    row_len: SUMMARY_ROW_LEN,
    window,
    window_hash: summaryWindowHash(window),
    rows,
    history_discovery: historyDiscovery,
    proof: {
      scope: eras.every((era) => era.proof?.scope === "full_chain") ? "full_chain" : "tail_window",
      truncated: eras.some((era) => era.proof?.truncated === true),
      families: eras.flatMap((era) => era.proof?.families || []),
      capsules: eras.flatMap((era) => era.proof?.capsules || [])
    },
    eras: eras.flatMap((era) => era.eras || [])
  };
  const latestEra = eras[eras.length - 1];
  if (latestEra?.history_root) combined.history_root = latestEra.history_root;
  if (latestEra?.capsules_root) combined.capsules_root = latestEra.capsules_root;
  return combined;
}

function summaryRowFromHistoryV1Row(row: HistoryV1ObservationRow): SummaryRow {
  return {
    row_version: "00",
    snapshot_index: row.snapshot_index,
    observed_at_unix: row.observed_at_unix,
    octra_epoch: row.octra_epoch,
    external_block: row.external_block,
    issued_raw: row.issued_raw,
    burned_raw: row.burned_raw,
    encrypted_raw: row.encrypted_raw,
    total_locked_raw: row.total_locked_raw,
    total_wrapped_raw: row.total_wrapped_raw,
    total_unclaimed_raw: row.total_unclaimed_raw,
    route_count: row.route_count,
    payload_hash_prefix: row.payload_hash_hex.slice(0, 24)
  };
}

function programHistoryWindowFromHistoryV1Body(body: string, historyDiscovery = "aml_history_v1_capsule"): ProgramHistoryWindow {
  const historyRows = decodeHistoryV1Rows(body);
  const rows = historyRows.map(summaryRowFromHistoryV1Row);
  const window = rows.map(encodeSummaryRow).join("");
  const firstIndex = rows[0]?.snapshot_index || 0;
  const windowHash = summaryWindowHash(window);
  return {
    first_index: firstIndex,
    row_count: rows.length,
    row_len: SUMMARY_ROW_LEN,
    window,
    window_hash: windowHash,
    rows,
    history_discovery: historyDiscovery
  };
}

function verifiedHistoryWindowFromHistoryV1(input: {
  sealedCapsule?: { id: string; body: string; meta: string; rootAfter: string } | null;
  openBody: string;
  openRowCount: number;
  openEndRoot: string;
  historyRoot: string;
  capsulesRoot?: string | null;
  capsuleCount?: number;
}): ProgramHistoryWindow {
  const bodies: string[] = [];
  let openStartRoot = historyV1EmptyHistoryRootHex();

  if (input.sealedCapsule?.id) {
    const capsule = input.sealedCapsule;
    if (!capsule.body || !capsule.meta || !capsule.rootAfter) {
      throw new Error("history v1 sealed capsule readback is incomplete");
    }
    const meta = decodeHistoryV1CapsuleMeta(capsule.meta);
    if (meta.capsule_id !== capsule.id) {
      throw new Error(`history v1 capsule id mismatch: expected ${capsule.id}, got ${meta.capsule_id}`);
    }
    if (capsule.body.length !== Number(meta.row_count) * HISTORY_V1_ROW_LEN) {
      throw new Error("history v1 capsule body length does not match metadata row count");
    }
    const rows = splitHistoryRows(capsule.body);
    const bodyHash = historyV1CapsuleBodyHashHex(capsule.body);
    if (bodyHash !== meta.body_hash_hex) {
      throw new Error("history v1 capsule body hash mismatch");
    }
    const metaHash = historyV1CapsuleMetaHashHex(capsule.meta);
    const endRoot = historyV1FoldHistoryRootHex(meta.start_root_hex, rows);
    if (endRoot !== meta.end_root_hex) {
      throw new Error("history v1 capsule end root mismatch");
    }
    const rootAfter = historyV1FoldCapsulesRootHex(meta.capsules_root_before_hex, meta.capsule_id, bodyHash, metaHash, endRoot);
    if (rootAfter !== capsule.rootAfter) {
      throw new Error("history v1 capsule root-after mismatch");
    }
    if (input.capsulesRoot && rootAfter !== input.capsulesRoot && Number(input.capsuleCount || 0) <= 1) {
      throw new Error("history v1 capsules root mismatch");
    }
    openStartRoot = meta.end_root_hex;
    bodies.push(capsule.body);
  } else if (Number(input.capsuleCount || 0) > 0) {
    throw new Error("history v1 sealed capsule count is nonzero but latest capsule is unavailable");
  }

  if (Number(input.openRowCount || 0) > 0) {
    if (input.openBody.length !== Number(input.openRowCount || 0) * HISTORY_V1_ROW_LEN) {
      throw new Error("history v1 open capsule body length does not match row count");
    }
    const rows = splitHistoryRows(input.openBody);
    const endRoot = historyV1FoldHistoryRootHex(openStartRoot, rows);
    if (endRoot !== input.openEndRoot) {
      throw new Error("history v1 open capsule end root mismatch");
    }
    if (input.historyRoot !== input.openEndRoot) {
      throw new Error("history v1 history root does not match open capsule end root");
    }
    bodies.push(input.openBody);
  } else if (input.historyRoot !== openStartRoot) {
    throw new Error("history v1 history root does not match latest sealed capsule root");
  }

  const window = programHistoryWindowFromHistoryV1Body(bodies.join(""), "aml_history_v1_capsule_tail_verified");
  window.history_root = input.historyRoot;
  window.capsules_root = input.capsulesRoot || null;
  window.proof = {
    scope: Number(input.capsuleCount || 0) <= 1 ? "full_chain" : "tail_window",
    truncated: Number(input.capsuleCount || 0) > 1,
    sealed_capsule_start_ordinal: Number(input.capsuleCount || 0) > 0 ? Math.max(0, Number(input.capsuleCount || 0) - 1) : 0,
    sealed_capsule_total_count: Number(input.capsuleCount || 0),
    sealed_capsule_verified_count: input.sealedCapsule?.id ? 1 : 0,
    capsule_limit: 1,
    families: [],
    capsules: input.sealedCapsule?.id ? [{
      family_id: "history_v1",
      capsule_id: input.sealedCapsule.id,
      proof_scope: Number(input.capsuleCount || 0) <= 1 ? "full_chain" : "tail_window",
      root_after: input.sealedCapsule.rootAfter
    }] : []
  };
  return window;
}

function isFactLedgerManifest(manifest: string): boolean {
  if (manifest === "octra-vitals-fact-ledger.v2") return true;
  return manifest === "octra-vitals-fact-ledger.v1";
}

function factLedgerHistoryCapsuleLimit(options: ProgramHistoryReadOptions = {}): number {
  const configured = Number(process.env.VITALS_FACT_LEDGER_HISTORY_CAPSULE_LIMIT || 64);
  const configuredLimit = Number.isInteger(configured) && configured > 0 ? Math.min(configured, 256) : 64;
  const requested = Number(options.maxSealedCapsules || 0);
  if (!Number.isInteger(requested) || requested < 1) return configuredLimit;
  return Math.min(configuredLimit, requested);
}

function splitHistoryRows(body: string): string[] {
  if (body.length % HISTORY_V1_ROW_LEN !== 0) throw new Error("history body is not row aligned");
  const rows: string[] = [];
  for (let offset = 0; offset < body.length; offset += HISTORY_V1_ROW_LEN) {
    rows.push(body.slice(offset, offset + HISTORY_V1_ROW_LEN));
  }
  return rows;
}

function hexRootOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/^sha256:/, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(text) ? text : null;
}

function verifiedHistoryWindowFromFactLedger(input: {
  manifest?: string | null;
  catalogRoot: string;
  familyRoot: string;
  familyCapsulesRoot?: string | null;
  sealedCapsules: Array<{ id: string; body: string; meta: string; rootAfter: string }>;
  sealedCapsuleStartOrdinal?: number;
  sealedCapsuleTotalCount?: number;
  openBody: string;
  openRowCount: number;
  openStartRoot: string;
  openEndRoot: string;
  capsuleLimit?: number;
}): ProgramHistoryWindow {
  const bodies: string[] = [];
  const manifest = input.manifest || "octra-vitals-fact-ledger.v2";
  const sealedCapsuleStartOrdinal = Number(input.sealedCapsuleStartOrdinal || 0);
  const sealedCapsuleTotalCount = Number(input.sealedCapsuleTotalCount ?? input.sealedCapsules.length);
  const fullSealedChainRead = sealedCapsuleStartOrdinal === 0 && input.sealedCapsules.length === sealedCapsuleTotalCount;
  let previousRoot: string | null = null;
  const expectedCapsulesRoot = hexRootOrNull(input.familyCapsulesRoot);
  let previousCapsulesRoot: string | null = sealedCapsuleStartOrdinal === 0
    ? factLedgerEmptyFamilyCapsulesRootHex(FACT_LEDGER_CORE_FAMILY_ID, FACT_LEDGER_CORE_SCHEMA_ID, manifest)
    : null;
  for (const capsule of input.sealedCapsules) {
    if (!capsule.id || !capsule.body || !capsule.meta || !capsule.rootAfter) {
      throw new Error("fact capsule readback is incomplete");
    }
    const meta = decodeFactCapsuleMeta(capsule.meta);
    if (meta.family_id !== FACT_LEDGER_CORE_FAMILY_ID || meta.schema_id !== FACT_LEDGER_CORE_SCHEMA_ID) {
      throw new Error("fact capsule metadata is not for the core family");
    }
    if (meta.capsule_id !== capsule.id) {
      throw new Error(`fact capsule id mismatch: expected ${capsule.id}, got ${meta.capsule_id}`);
    }
    if (previousCapsulesRoot && meta.family_root_before_hex !== previousCapsulesRoot) {
      throw new Error("fact capsule family capsules root continuity mismatch");
    }
    if (capsule.body.length !== meta.row_count * HISTORY_V1_ROW_LEN) {
      throw new Error("fact capsule body length does not match metadata row count");
    }
    const bodyHash = factLedgerCapsuleBodyHashHex(FACT_LEDGER_CORE_FAMILY_ID, FACT_LEDGER_CORE_SCHEMA_ID, capsule.body, HISTORY_V1_ROW_LEN, manifest);
    if (bodyHash !== meta.body_hash_hex) {
      throw new Error("fact capsule body hash mismatch");
    }
    const rows = splitHistoryRows(capsule.body);
    const endRoot = factLedgerFoldFamilyRootHex(FACT_LEDGER_CORE_FAMILY_ID, FACT_LEDGER_CORE_SCHEMA_ID, meta.start_root_hex, rows, manifest);
    if (endRoot !== meta.end_root_hex) {
      throw new Error("fact capsule end root mismatch");
    }
    const familyCapsulesRootAfter = factLedgerFoldFamilyCapsulesRootHex({
      familyId: FACT_LEDGER_CORE_FAMILY_ID,
      schemaId: FACT_LEDGER_CORE_SCHEMA_ID,
      startRootHex: meta.family_root_before_hex,
      capsuleId: capsule.id,
      bodyHashHex: meta.body_hash_hex,
      rowRootAfterHex: meta.end_root_hex,
      manifest
    });
    if (meta.family_root_after_hex !== familyCapsulesRootAfter) {
      throw new Error("fact capsule family capsules root mismatch");
    }
    if (meta.end_root_hex !== capsule.rootAfter) {
      throw new Error("fact capsule root-after mismatch");
    }
    if (previousRoot && meta.start_root_hex !== previousRoot) {
      throw new Error("fact capsule root continuity mismatch");
    }
    previousRoot = meta.end_root_hex;
    previousCapsulesRoot = meta.family_root_after_hex;
    bodies.push(capsule.body);
  }

  if (
    expectedCapsulesRoot &&
    previousCapsulesRoot &&
    fullSealedChainRead &&
    expectedCapsulesRoot !== previousCapsulesRoot
  ) {
    throw new Error("fact family capsules root does not match latest sealed capsule chain root");
  }

  if (Number(input.openRowCount || 0) > 0) {
    if (input.openBody.length !== Number(input.openRowCount || 0) * HISTORY_V1_ROW_LEN) {
      throw new Error("fact open capsule body length does not match row count");
    }
    const rows = splitHistoryRows(input.openBody);
    const endRoot = factLedgerFoldFamilyRootHex(FACT_LEDGER_CORE_FAMILY_ID, FACT_LEDGER_CORE_SCHEMA_ID, input.openStartRoot, rows, manifest);
    if (endRoot !== input.openEndRoot) {
      throw new Error("fact open capsule end root mismatch");
    }
    if (previousRoot && input.openStartRoot !== previousRoot) {
      throw new Error("fact open capsule root continuity mismatch");
    }
    if (input.familyRoot !== input.openEndRoot) {
      throw new Error("fact family root does not match open capsule end root");
    }
    bodies.push(input.openBody);
  } else if (previousRoot && input.familyRoot !== previousRoot) {
    throw new Error("fact family root does not match latest sealed capsule root");
  }

  const proofScope = fullSealedChainRead ? "full_chain" : "tail_window";
  const window = programHistoryWindowFromHistoryV1Body(
    bodies.join(""),
    fullSealedChainRead ? "aml_fact_family_core_capsules_verified" : "aml_fact_family_core_capsules_tail_verified"
  );
  window.history_root = input.familyRoot;
  window.capsules_root = input.familyCapsulesRoot || null;
  window.proof = {
    scope: proofScope,
    truncated: !fullSealedChainRead,
    sealed_capsule_start_ordinal: sealedCapsuleStartOrdinal,
    sealed_capsule_total_count: sealedCapsuleTotalCount,
    sealed_capsule_verified_count: input.sealedCapsules.length,
    capsule_limit: input.capsuleLimit || factLedgerHistoryCapsuleLimit(),
    families: [{
      family_id: FACT_LEDGER_CORE_FAMILY_ID,
      schema_id: FACT_LEDGER_CORE_SCHEMA_ID,
      manifest,
      family_root: input.familyRoot,
      capsules_root: input.familyCapsulesRoot || null,
      open_capsule_row_count: Number(input.openRowCount || 0),
      proof_scope: proofScope,
      truncated: !fullSealedChainRead
    }],
    capsules: input.sealedCapsules.map((capsule, index) => ({
      family_id: FACT_LEDGER_CORE_FAMILY_ID,
      capsule_id: capsule.id,
      ordinal: sealedCapsuleStartOrdinal + index,
      proof_scope: proofScope,
      root_after: capsule.rootAfter
    }))
  };
  return window;
}

async function readLatestProgramSnapshotFromUrl(programAddress: string, url: string): Promise<SnapshotReadback> {
  const [snapshotIndex, latestEpoch, snapshotId, observedAtStored, payloadHash, evidenceManifestHash, sourceRefsHashStored, canonicalPayload, canonicalEvidenceManifest, canonicalSourceRefs, submitter, latestSummary, latestSummaryHash] = await Promise.all([
    contractCallAtUrl<number>(url, programAddress, "get_latest_snapshot_index"),
    contractCallAtUrl<number>(url, programAddress, "get_latest_epoch"),
    contractCallAtUrl<string>(url, programAddress, "get_latest_snapshot_id"),
    contractCallAtUrl<string>(url, programAddress, "get_latest_observed_at").catch(() => ""),
    contractCallAtUrl<string>(url, programAddress, "get_latest_payload_hash"),
    contractCallAtUrl<string>(url, programAddress, "get_latest_evidence_manifest_hash"),
    contractCallAtUrl<string>(url, programAddress, "get_latest_source_refs_hash"),
    contractCallAtUrl<string>(url, programAddress, "get_latest_snapshot"),
    contractCallAtUrl<string>(url, programAddress, "get_latest_evidence_manifest"),
    contractCallAtUrl<string>(url, programAddress, "get_latest_source_refs"),
    contractCallAtUrl<string>(url, programAddress, "get_latest_submitter").catch(() => ""),
    contractCallAtUrl<string>(url, programAddress, "get_latest_summary"),
    contractCallAtUrl<string>(url, programAddress, "get_latest_summary_hash")
  ]);

  if (!snapshotId || !canonicalPayload || !canonicalEvidenceManifest) {
    throw new Error("Vitals State Program has no recorded snapshot yet");
  }

  const computedPayloadHash = sha256Tagged(SNAPSHOT_HASH_DOMAIN, canonicalPayload);
  const computedEvidenceHash = sha256Tagged(EVIDENCE_HASH_DOMAIN, canonicalEvidenceManifest);
  assertHash("payload hash", computedPayloadHash, payloadHash);
  assertHash("evidence manifest hash", computedEvidenceHash, evidenceManifestHash);

  const payload = JSON.parse(canonicalPayload) as SnapshotPayload;
  const evidenceManifest = JSON.parse(canonicalEvidenceManifest) as EvidenceManifest;
  if (canonicalJson(payload) !== canonicalPayload) {
    throw new Error("latest payload is not canonical JSON");
  }
  if (canonicalJson(evidenceManifest) !== canonicalEvidenceManifest) {
    throw new Error("latest evidence manifest is not canonical JSON");
  }
  if (Number(payload.octra?.epoch || 0) !== Number(latestEpoch || 0)) {
    throw new Error(`latest epoch mismatch: AML has ${latestEpoch}, payload has ${payload.octra?.epoch}`);
  }
  const sourceRefs = canonicalSourceRefs
    ? JSON.parse(canonicalSourceRefs) as SourceRef[]
    : sourceRefsFromEvidence(evidenceManifest.entries || []);
  if (canonicalSourceRefs && canonicalJson(sourceRefs) !== canonicalSourceRefs) {
    throw new Error("latest source refs are not canonical JSON");
  }
  assertHash("source refs hash", sourceRefsHash(sourceRefs), sourceRefsHashStored);
  assertHash("summary hash", summaryHash(latestSummary), latestSummaryHash);
  const observedAt = observedAtStored || evidenceManifest.observed_at || snapshotId.replace(/^vitals\./, "");

  const envelope: SnapshotEnvelope = {
    schema_version: "octra-vitals-envelope-v0",
    snapshot_id: snapshotId,
    observed_at: observedAt,
    payload_hash: payloadHash,
    evidence_manifest_hash: evidenceManifestHash,
    canonicalization: "jcs-rfc8785-or-equivalent-v1",
    payload,
    source_refs: sourceRefs,
    submitted_by: submitter || process.env.VITALS_OPERATOR_ADDRESS || ""
  };

  const snapshot: SnapshotArtifact = {
    envelope,
    evidence_manifest: evidenceManifest,
    canonical_source_refs: canonicalSourceRefs || canonicalJson(sourceRefs),
    canonical_payload: canonicalPayload,
    canonical_evidence_manifest: canonicalEvidenceManifest,
    generated_at: isoNow()
  };
  assertLatestSummaryMatchesSnapshot(snapshot, Number(snapshotIndex || 0), latestSummary);
  return {
    snapshot,
    snapshot_index: Number(snapshotIndex || 0),
    latest_summary: latestSummary,
    latest_summary_hash: latestSummaryHash,
    submitter: submitter || ""
  };
}

export async function readLatestProgramSnapshot(programAddress: string): Promise<SnapshotArtifact> {
  const urls = programRpcUrls();
  const [primaryUrl, ...otherUrls] = urls;
  if (!primaryUrl) throw new Error("no Octra program RPC URL configured");
  const primary = await readLatestProgramSnapshotFromUrl(programAddress, primaryUrl);
  (primary.snapshot as any).snapshot_index = primary.snapshot_index;
  (primary.snapshot as any).latest_summary = primary.latest_summary;
  (primary.snapshot as any).latest_summary_hash = primary.latest_summary_hash;
  if (!otherUrls.length) return primary.snapshot;
  const candidates = await Promise.all(otherUrls.map(async (url) => ({
    url,
    readback: await readLatestProgramSnapshotFromUrl(programAddress, url)
  })));
  for (const candidate of candidates) {
    assertSameLatestSnapshot(primary, candidate.readback, candidate.url);
  }
  return primary.snapshot;
}

async function readLatestCircleProgramSnapshotFromUrl(circleId: string, url: string): Promise<SnapshotReadback> {
  const [snapshotIndex, latestEpoch, snapshotId, observedAtStored, payloadHash, evidenceManifestHash, sourceRefsHashStored, canonicalPayload, canonicalEvidenceManifest, canonicalSourceRefs, submitter, latestSummary, latestSummaryHash] = await Promise.all([
    circleProgramViewAtUrl<number>(url, circleId, "get_latest_snapshot_index"),
    circleProgramViewAtUrl<number>(url, circleId, "get_latest_epoch"),
    circleProgramViewAtUrl<string>(url, circleId, "get_latest_snapshot_id"),
    circleProgramViewAtUrl<string>(url, circleId, "get_latest_observed_at").catch(() => ""),
    circleProgramViewAtUrl<string>(url, circleId, "get_latest_payload_hash"),
    circleProgramViewAtUrl<string>(url, circleId, "get_latest_evidence_manifest_hash"),
    circleProgramViewAtUrl<string>(url, circleId, "get_latest_source_refs_hash"),
    circleProgramViewAtUrl<string>(url, circleId, "get_latest_snapshot"),
    circleProgramViewAtUrl<string>(url, circleId, "get_latest_evidence_manifest"),
    circleProgramViewAtUrl<string>(url, circleId, "get_latest_source_refs"),
    circleProgramViewAtUrl<string>(url, circleId, "get_latest_submitter").catch(() => ""),
    circleProgramViewAtUrl<string>(url, circleId, "get_latest_summary"),
    circleProgramViewAtUrl<string>(url, circleId, "get_latest_summary_hash")
  ]);

  if (!canonicalPayload || !canonicalEvidenceManifest) {
    throw new Error("Vitals Circle Program has no recorded snapshot yet");
  }

  const computedPayloadHash = sha256Tagged(SNAPSHOT_HASH_DOMAIN, canonicalPayload);
  const computedEvidenceHash = sha256Tagged(EVIDENCE_HASH_DOMAIN, canonicalEvidenceManifest);
  assertHash("payload hash", computedPayloadHash, payloadHash);
  assertHash("evidence manifest hash", computedEvidenceHash, evidenceManifestHash);

  const payload = JSON.parse(canonicalPayload) as SnapshotPayload;
  const evidenceManifest = JSON.parse(canonicalEvidenceManifest) as EvidenceManifest;
  if (canonicalJson(payload) !== canonicalPayload) {
    throw new Error("latest payload is not canonical JSON");
  }
  if (canonicalJson(evidenceManifest) !== canonicalEvidenceManifest) {
    throw new Error("latest evidence manifest is not canonical JSON");
  }
  if (Number(payload.octra?.epoch || 0) !== Number(latestEpoch || 0)) {
    throw new Error(`latest epoch mismatch: AML has ${latestEpoch}, payload has ${payload.octra?.epoch}`);
  }
  const sourceRefs = canonicalSourceRefs
    ? JSON.parse(canonicalSourceRefs) as SourceRef[]
    : sourceRefsFromEvidence(evidenceManifest.entries || []);
  if (canonicalSourceRefs && canonicalJson(sourceRefs) !== canonicalSourceRefs) {
    throw new Error("latest source refs are not canonical JSON");
  }
  assertHash("source refs hash", sourceRefsHash(sourceRefs), sourceRefsHashStored);
  assertHash("summary hash", summaryHash(latestSummary), latestSummaryHash);
  const observedAt = observedAtStored || evidenceManifest.observed_at || snapshotId.replace(/^vitals\./, "");
  const resolvedSnapshotId = snapshotId || (observedAt ? `vitals.${observedAt}` : "");
  if (!resolvedSnapshotId || !observedAt) {
    throw new Error("Vitals Circle Program latest snapshot timestamp is unavailable");
  }

  const envelope: SnapshotEnvelope = {
    schema_version: "octra-vitals-envelope-v0",
    snapshot_id: resolvedSnapshotId,
    observed_at: observedAt,
    payload_hash: payloadHash,
    evidence_manifest_hash: evidenceManifestHash,
    canonicalization: "jcs-rfc8785-or-equivalent-v1",
    payload,
    source_refs: sourceRefs,
    submitted_by: submitter || process.env.VITALS_OPERATOR_ADDRESS || ""
  };

  const snapshot: SnapshotArtifact = {
    envelope,
    evidence_manifest: evidenceManifest,
    canonical_source_refs: canonicalSourceRefs || canonicalJson(sourceRefs),
    canonical_payload: canonicalPayload,
    canonical_evidence_manifest: canonicalEvidenceManifest,
    generated_at: isoNow()
  };
  assertLatestSummaryMatchesSnapshot(snapshot, Number(snapshotIndex || 0), latestSummary);
  return {
    snapshot,
    snapshot_index: Number(snapshotIndex || 0),
    latest_summary: latestSummary,
    latest_summary_hash: latestSummaryHash,
    submitter: submitter || ""
  };
}

export async function readLatestCircleProgramSnapshot(circleId: string): Promise<SnapshotArtifact> {
  const urls = programRpcUrls();
  const [primaryUrl, ...otherUrls] = urls;
  if (!primaryUrl) throw new Error("no Octra program RPC URL configured");
  const primary = await readLatestCircleProgramSnapshotFromUrl(circleId, primaryUrl);
  (primary.snapshot as any).snapshot_index = primary.snapshot_index;
  (primary.snapshot as any).latest_summary = primary.latest_summary;
  (primary.snapshot as any).latest_summary_hash = primary.latest_summary_hash;
  if (!otherUrls.length) return primary.snapshot;
  const candidates = await Promise.all(otherUrls.map(async (url) => ({
    url,
    readback: await readLatestCircleProgramSnapshotFromUrl(circleId, url)
  })));
  for (const candidate of candidates) {
    assertSameLatestSnapshot(primary, candidate.readback, candidate.url);
  }
  return primary.snapshot;
}

async function readProgramSummaryHistoryFromUrlV0(programAddress: string, url: string): Promise<ProgramHistoryWindow> {
  const [window, windowHash, firstIndex, rowCount] = await Promise.all([
    contractCallAtUrl<string>(url, programAddress, "get_recent_summary_window"),
    contractCallAtUrl<string>(url, programAddress, "get_recent_summary_window_hash"),
    contractCallAtUrl<number>(url, programAddress, "get_recent_summary_window_first_index"),
    contractCallAtUrl<number>(url, programAddress, "get_recent_summary_window_row_count")
  ]);
  return parseSummaryWindow(window || "", Number(firstIndex || 0), Number(rowCount || 0), windowHash);
}

async function readProgramSummaryHistoryFromUrlV1(programAddress: string, url: string): Promise<ProgramHistoryWindow> {
  const [historyRoot, capsulesRoot, capsuleCount, openBody, openRowCount, openEndRoot, latestCapsuleId] = await Promise.all([
    contractCallAtUrl<string>(url, programAddress, "get_history_root"),
    contractCallAtUrl<string>(url, programAddress, "get_capsules_root").catch(() => null),
    contractCallAtUrl<number>(url, programAddress, "get_capsule_count").catch(() => 0),
    contractCallAtUrl<string>(url, programAddress, "get_open_capsule_body"),
    contractCallAtUrl<number>(url, programAddress, "get_open_capsule_row_count"),
    contractCallAtUrl<string>(url, programAddress, "get_open_capsule_end_root"),
    contractCallAtUrl<string>(url, programAddress, "get_latest_capsule_id").catch(() => "")
  ]);
  const sealedCapsule = latestCapsuleId
    ? {
      id: latestCapsuleId,
      body: await contractCallAtUrl<string>(url, programAddress, "get_history_capsule_body", [latestCapsuleId]),
      meta: await contractCallAtUrl<string>(url, programAddress, "get_history_capsule_meta", [latestCapsuleId]),
      rootAfter: await contractCallAtUrl<string>(url, programAddress, "get_history_capsule_root_after", [latestCapsuleId])
    }
    : null;
  return verifiedHistoryWindowFromHistoryV1({
    sealedCapsule,
    openBody,
    openRowCount: Number(openRowCount || 0),
    openEndRoot,
    historyRoot,
    capsulesRoot,
    capsuleCount: Number(capsuleCount || 0)
  });
}

async function readProgramSummaryHistoryFromUrlFactLedger(programAddress: string, url: string, options: ProgramHistoryReadOptions = {}): Promise<ProgramHistoryWindow> {
  const [catalogRoot, familyRoot, openBody, openRowCount, openStartRoot, openEndRoot, capsuleCount] = await Promise.all([
    contractCallAtUrl<string>(url, programAddress, "get_catalog_root"),
    contractCallAtUrl<string>(url, programAddress, "get_family_root", ["0000"]),
    contractCallAtUrl<string>(url, programAddress, "get_family_open_capsule_body", ["0000"]),
    contractCallAtUrl<number>(url, programAddress, "get_family_open_capsule_row_count", ["0000"]),
    contractCallAtUrl<string>(url, programAddress, "get_family_open_capsule_start_root", ["0000"]),
    contractCallAtUrl<string>(url, programAddress, "get_family_open_capsule_end_root", ["0000"]),
    contractCallAtUrl<number>(url, programAddress, "get_family_capsule_count", ["0000"]).catch(() => 0)
  ]);
  const sealedCount = Number(capsuleCount || 0);
  const sealedCapsules: Array<{ id: string; body: string; meta: string; rootAfter: string }> = [];
  const limit = factLedgerHistoryCapsuleLimit(options);
  if (sealedCount > 0) {
    const start = Math.max(0, sealedCount - limit);
    const capsuleIds = await Promise.all(Array.from({ length: sealedCount - start }, (_, index) => (
      contractCallAtUrl<string>(url, programAddress, "get_family_capsule_id_at", ["0000", start + index])
    )));
    const readCapsules = await Promise.all(capsuleIds.filter(Boolean).map(async (capsuleId) => ({
      id: capsuleId,
      body: await contractCallAtUrl<string>(url, programAddress, "get_family_capsule_body", ["0000", capsuleId]),
      meta: await contractCallAtUrl<string>(url, programAddress, "get_family_capsule_meta", ["0000", capsuleId]),
      rootAfter: await contractCallAtUrl<string>(url, programAddress, "get_family_capsule_root_after", ["0000", capsuleId])
    })));
    sealedCapsules.push(...readCapsules);
  }
  return verifiedHistoryWindowFromFactLedger({
    manifest: "octra-vitals-fact-ledger.v2",
    catalogRoot,
    familyRoot,
    sealedCapsules,
    openBody,
    openRowCount: Number(openRowCount || 0),
    openStartRoot,
    openEndRoot,
    capsuleLimit: limit
  });
}

async function readProgramSummaryHistoryFromUrl(programAddress: string, url: string, options: ProgramHistoryReadOptions = {}): Promise<ProgramHistoryWindow> {
  try {
    return await readProgramSummaryHistoryFromUrlV0(programAddress, url);
  } catch (error) {
    const manifest = await contractCallAtUrl<string>(url, programAddress, "manifest").catch(() => "");
    if (manifest === "vitals-circle-state.v1") return readProgramSummaryHistoryFromUrlV1(programAddress, url);
    if (isFactLedgerManifest(manifest)) return readProgramSummaryHistoryFromUrlFactLedger(programAddress, url, options);
    throw error;
  }
}

async function readCircleProgramSummaryHistoryFromUrlV0(circleId: string, url: string): Promise<ProgramHistoryWindow> {
  const [window, windowHash, firstIndex, rowCount] = await Promise.all([
    circleProgramViewAtUrl<string>(url, circleId, "get_recent_summary_window"),
    circleProgramViewAtUrl<string>(url, circleId, "get_recent_summary_window_hash"),
    circleProgramViewAtUrl<number>(url, circleId, "get_recent_summary_window_first_index"),
    circleProgramViewAtUrl<number>(url, circleId, "get_recent_summary_window_row_count")
  ]);
  return parseSummaryWindow(window || "", Number(firstIndex || 0), Number(rowCount || 0), windowHash);
}

async function readCircleProgramSummaryHistoryFromUrlV1(circleId: string, url: string): Promise<ProgramHistoryWindow> {
  const [manifest, predecessorProgram, historyRoot, capsulesRoot, capsuleCount, openBody, openRowCount, openEndRoot, latestCapsuleId] = await Promise.all([
    circleProgramViewAtUrl<string>(url, circleId, "manifest").catch(() => "vitals-circle-state.v1"),
    circleProgramViewAtUrl<string>(url, circleId, "get_predecessor_program").catch(() => ""),
    circleProgramViewAtUrl<string>(url, circleId, "get_history_root"),
    circleProgramViewAtUrl<string>(url, circleId, "get_capsules_root").catch(() => null),
    circleProgramViewAtUrl<number>(url, circleId, "get_capsule_count").catch(() => 0),
    circleProgramViewAtUrl<string>(url, circleId, "get_open_capsule_body"),
    circleProgramViewAtUrl<number>(url, circleId, "get_open_capsule_row_count"),
    circleProgramViewAtUrl<string>(url, circleId, "get_open_capsule_end_root"),
    circleProgramViewAtUrl<string>(url, circleId, "get_latest_capsule_id").catch(() => "")
  ]);
  const sealedCapsule = latestCapsuleId
    ? {
      id: latestCapsuleId,
      body: await circleProgramViewAtUrl<string>(url, circleId, "get_history_capsule_body", [latestCapsuleId]),
      meta: await circleProgramViewAtUrl<string>(url, circleId, "get_history_capsule_meta", [latestCapsuleId]),
      rootAfter: await circleProgramViewAtUrl<string>(url, circleId, "get_history_capsule_root_after", [latestCapsuleId])
    }
    : null;
  const history = verifiedHistoryWindowFromHistoryV1({
    sealedCapsule,
    openBody,
    openRowCount: Number(openRowCount || 0),
    openEndRoot,
    historyRoot,
    capsulesRoot,
    capsuleCount: Number(capsuleCount || 0)
  });
  const era: ProgramHistoryEra = {
    era_id: circleId,
    era_program: circleId,
    manifest: manifest || "vitals-circle-state.v1",
    history_model: history.history_discovery || "aml_history_v1_capsule_tail_verified",
    first_index: historyFirstIndex(history),
    latest_index: historyLatestIndex(history),
    row_count: history.row_count,
    root_hash: history.history_root || null,
    capsules_root: history.capsules_root || null,
    predecessor_program: predecessorProgram || null
  };
  if (history.proof?.scope) era.proof_scope = history.proof.scope;
  if (history.proof?.truncated !== undefined) era.proof_truncated = history.proof.truncated;
  history.eras = [era];
  return history;
}

async function readCircleProgramSummaryHistoryFromUrlFactLedger(circleId: string, url: string, options: ProgramHistoryReadOptions = {}): Promise<ProgramHistoryWindow> {
  const [manifest, eraProgram, eraNetworkId, predecessorProgram, predecessorFinalRoot, predecessorFinalIndex, predecessorAnchorHash, eraFirstSnapshotIndex, catalogRoot, familyRoot, familyCapsulesRoot, openBody, openRowCount, openStartRoot, openEndRoot, capsuleCount] = await Promise.all([
    circleProgramViewAtUrl<string>(url, circleId, "manifest").catch(() => ""),
    circleProgramViewAtUrl<string>(url, circleId, "get_era_program").catch(() => circleId),
    circleProgramViewAtUrl<string>(url, circleId, "get_era_network_id").catch(() => ""),
    circleProgramViewAtUrl<string>(url, circleId, "get_predecessor_program").catch(() => ""),
    circleProgramViewAtUrl<string>(url, circleId, "get_predecessor_final_root").catch(() => ""),
    circleProgramViewAtUrl<number>(url, circleId, "get_predecessor_final_index").catch(() => 0),
    circleProgramViewAtUrl<string>(url, circleId, "get_predecessor_anchor_hash").catch(() => ""),
    circleProgramViewAtUrl<number>(url, circleId, "get_era_first_snapshot_index").catch(() => 0),
    circleProgramViewAtUrl<string>(url, circleId, "get_catalog_root"),
    circleProgramViewAtUrl<string>(url, circleId, "get_family_root", ["0000"]),
    circleProgramViewAtUrl<string>(url, circleId, "get_family_capsules_root", ["0000"]).catch(() => null),
    circleProgramViewAtUrl<string>(url, circleId, "get_family_open_capsule_body", ["0000"]),
    circleProgramViewAtUrl<number>(url, circleId, "get_family_open_capsule_row_count", ["0000"]),
    circleProgramViewAtUrl<string>(url, circleId, "get_family_open_capsule_start_root", ["0000"]),
    circleProgramViewAtUrl<string>(url, circleId, "get_family_open_capsule_end_root", ["0000"]),
    circleProgramViewAtUrl<number>(url, circleId, "get_family_capsule_count", ["0000"]).catch(() => 0)
  ]);
  const sealedCount = Number(capsuleCount || 0);
  const sealedCapsules: Array<{ id: string; body: string; meta: string; rootAfter: string }> = [];
  const limit = factLedgerHistoryCapsuleLimit(options);
  if (sealedCount > 0) {
    const start = Math.max(0, sealedCount - limit);
    const capsuleIds = await Promise.all(Array.from({ length: sealedCount - start }, (_, index) => (
      circleProgramViewAtUrl<string>(url, circleId, "get_family_capsule_id_at", ["0000", start + index])
    )));
    const readCapsules = await Promise.all(capsuleIds.filter(Boolean).map(async (capsuleId) => ({
      id: capsuleId,
      body: await circleProgramViewAtUrl<string>(url, circleId, "get_family_capsule_body", ["0000", capsuleId]),
      meta: await circleProgramViewAtUrl<string>(url, circleId, "get_family_capsule_meta", ["0000", capsuleId]),
      rootAfter: await circleProgramViewAtUrl<string>(url, circleId, "get_family_capsule_root_after", ["0000", capsuleId])
    })));
    sealedCapsules.push(...readCapsules);
  }
  const history = verifiedHistoryWindowFromFactLedger({
    manifest,
    catalogRoot,
    familyRoot,
    familyCapsulesRoot,
    sealedCapsules,
    sealedCapsuleStartOrdinal: Math.max(0, sealedCount - limit),
    sealedCapsuleTotalCount: sealedCount,
    openBody,
    openRowCount: Number(openRowCount || 0),
    openStartRoot,
    openEndRoot,
    capsuleLimit: limit
  });
  const era: ProgramHistoryEra = {
    era_id: circleId,
    era_program: eraProgram || circleId,
    era_network_id: eraNetworkId || null,
    manifest: manifest || null,
    history_model: history.history_discovery || "aml_fact_family_core_capsules_verified",
    first_index: historyFirstIndex(history),
    latest_index: historyLatestIndex(history),
    row_count: history.row_count,
    root_hash: history.history_root || null,
    capsules_root: history.capsules_root || null,
    predecessor_program: predecessorProgram || null,
    predecessor_final_root: predecessorFinalRoot || null,
    predecessor_final_index: Number(predecessorFinalIndex || 0),
    predecessor_anchor_hash: predecessorAnchorHash || null,
    era_first_snapshot_index: Number(eraFirstSnapshotIndex || 0)
  };
  if (history.proof?.scope) era.proof_scope = history.proof.scope;
  if (history.proof?.truncated !== undefined) era.proof_truncated = history.proof.truncated;
  history.eras = [era];
  return history;
}

async function readCircleProgramSummaryHistoryFromUrl(circleId: string, url: string, options: ProgramHistoryReadOptions = {}): Promise<ProgramHistoryWindow> {
  try {
    return await readCircleProgramSummaryHistoryFromUrlV0(circleId, url);
  } catch (error) {
    const manifest = await circleProgramViewAtUrl<string>(url, circleId, "manifest").catch(() => "");
    if (manifest === "vitals-circle-state.v1") return readCircleProgramSummaryHistoryFromUrlV1(circleId, url);
    if (isFactLedgerManifest(manifest)) return readCircleProgramSummaryHistoryFromUrlFactLedger(circleId, url, options);
    throw error;
  }
}

function meaningfulPredecessor(era: ProgramHistoryEra | undefined, circleId: string): boolean {
  if (!era?.predecessor_program || era.predecessor_program === circleId) return false;
  if (!Number.isSafeInteger(Number(era.predecessor_final_index || 0)) || Number(era.predecessor_final_index || 0) <= 0) return false;
  if (!era.predecessor_final_root || !/^[0-9a-f]{64}$/i.test(era.predecessor_final_root)) return false;
  if (!era.predecessor_anchor_hash || !/^[0-9a-f]{64}$/i.test(era.predecessor_anchor_hash)) return false;
  return true;
}

async function readCircleProgramSummaryHistoryFromUrlStitched(circleId: string, url: string, options: ProgramHistoryReadOptions = {}, seen = new Set<string>()): Promise<ProgramHistoryWindow> {
  if (seen.has(circleId)) throw new Error(`cycle in history era predecessor chain at ${circleId}`);
  if (seen.size >= Number(process.env.VITALS_HISTORY_ERA_LIMIT || 8)) throw new Error("history era predecessor chain exceeds configured limit");
  const nextSeen = new Set(seen);
  nextSeen.add(circleId);
  const current = await readCircleProgramSummaryHistoryFromUrl(circleId, url, options);
  const currentEra = current.eras?.[0];
  if (!meaningfulPredecessor(currentEra, circleId)) return current;

  const predecessorId = currentEra?.predecessor_program || "";
  const predecessorFinalIndex = Number(currentEra?.predecessor_final_index || 0);
  const eraFirstIndex = Number(currentEra?.era_first_snapshot_index || 0);
  const currentFirstIndex = historyFirstIndex(current);
  if (current.proof?.truncated || (currentFirstIndex && eraFirstIndex && currentFirstIndex !== eraFirstIndex)) {
    return current;
  }
  const predecessor = await readCircleProgramSummaryHistoryFromUrlStitched(predecessorId, url, options, nextSeen);
  const predecessorLatestIndex = historyLatestIndex(predecessor);
  if (predecessorLatestIndex !== predecessorFinalIndex) {
    throw new Error(`predecessor era latest index mismatch: expected ${predecessorFinalIndex}, got ${predecessorLatestIndex}`);
  }
  const predecessorRoot = predecessor.history_root || "";
  if (predecessorRoot !== currentEra?.predecessor_final_root) {
    throw new Error("predecessor era final root mismatch");
  }
  if (eraFirstIndex !== predecessorFinalIndex + 1) {
    throw new Error(`era first index mismatch: expected ${predecessorFinalIndex + 1}, got ${eraFirstIndex}`);
  }
  if (currentFirstIndex && currentFirstIndex !== eraFirstIndex) {
    throw new Error(`current era first row mismatch: expected ${eraFirstIndex}, got ${currentFirstIndex}`);
  }
  const currentNetwork = String(currentEra?.era_network_id || "");
  if (!currentNetwork) throw new Error("current era network id missing for anchor verification");
  const realExpectedAnchor = factLedgerEraAnchorHashHex({
    networkId: currentNetwork,
    predecessorProgram: predecessorId,
    predecessorFinalRoot: currentEra?.predecessor_final_root || "",
    predecessorFinalIndex,
    eraProgram: currentEra?.era_program || circleId,
    eraFirstSnapshotIndex: eraFirstIndex,
    familyId: FACT_LEDGER_CORE_FAMILY_ID
  });
  if (realExpectedAnchor !== currentEra?.predecessor_anchor_hash) {
    throw new Error("predecessor era anchor hash mismatch");
  }
  currentEra.predecessor_anchor_verified = true;
  currentEra.boundary_verified = true;
  const combined = combinedHistoryWindow([predecessor, current]);
  combined.history_discovery = "aml_multi_era_fact_family_core_capsules_verified";
  return combined;
}

export async function readCircleProgramSummaryHistory(circleId: string, options: ProgramHistoryReadOptions = {}): Promise<ProgramHistoryWindow> {
  const urls = programRpcUrls();
  const [primaryUrl, ...otherUrls] = urls;
  if (!primaryUrl) throw new Error("no Octra program RPC URL configured");
  const primary = await readCircleProgramSummaryHistoryFromUrlStitched(circleId, primaryUrl, options);
  if (!otherUrls.length) return primary;
  const candidates = await Promise.all(otherUrls.map(async (url) => ({
    url,
    history: await readCircleProgramSummaryHistoryFromUrlStitched(circleId, url, options)
  })));
  for (const candidate of candidates) {
    assertSameHistory(primary, candidate.history, candidate.url);
  }
  return primary;
}

export async function readProgramSummaryHistory(programAddress: string, options: ProgramHistoryReadOptions = {}): Promise<ProgramHistoryWindow> {
  const urls = programRpcUrls();
  const [primaryUrl, ...otherUrls] = urls;
  if (!primaryUrl) throw new Error("no Octra program RPC URL configured");
  const primary = await readProgramSummaryHistoryFromUrl(programAddress, primaryUrl, options);
  if (!otherUrls.length) return primary;
  const candidates = await Promise.all(otherUrls.map(async (url) => ({
    url,
    history: await readProgramSummaryHistoryFromUrl(programAddress, url, options)
  })));
  for (const candidate of candidates) {
    assertSameHistory(primary, candidate.history, candidate.url);
  }
  return primary;
}

export function verifySnapshotArtifactHashes(snapshot: SnapshotArtifact): void {
  const canonicalPayload = snapshot.canonical_payload || canonicalJson(snapshot.envelope.payload);
  const canonicalEvidenceManifest = snapshot.canonical_evidence_manifest || canonicalJson(snapshot.evidence_manifest);
  if (canonicalJson(snapshot.envelope.payload) !== canonicalPayload) {
    throw new Error("snapshot canonical payload does not match canonicalJson(envelope.payload)");
  }
  if (canonicalJson(snapshot.evidence_manifest) !== canonicalEvidenceManifest) {
    throw new Error("snapshot canonical evidence manifest does not match canonicalJson(evidence_manifest)");
  }
  assertHash("payload hash", sha256Tagged(SNAPSHOT_HASH_DOMAIN, canonicalPayload), snapshot.envelope.payload_hash);
  assertHash("evidence manifest hash", sha256Tagged(EVIDENCE_HASH_DOMAIN, canonicalEvidenceManifest), snapshot.envelope.evidence_manifest_hash);
  if (snapshot.canonical_source_refs && snapshot.envelope.source_refs) {
    assertHash("source refs hash", sha256Tagged(SOURCE_REFS_HASH_DOMAIN, snapshot.canonical_source_refs), sourceRefsHash(snapshot.envelope.source_refs));
  }
}
