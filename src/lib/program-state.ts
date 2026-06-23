import { canonicalJson, sha256Tagged } from "./canonical-json.js";
import { circleProgramViewAtUrl } from "./circle-program.js";
import { contractCallAtUrl, octraProgramRpcUrls } from "./octra-rpc.js";
import { decodeHistoryV1Rows, type HistoryV1ObservationRow } from "./aml-history-v1.js";
import { assertLatestSummaryMatchesSnapshot, encodeSummaryRow, parseSummaryWindow, summaryHash, summaryWindowHash, SUMMARY_ROW_LEN, type ProgramHistoryWindow, type SummaryRow } from "./summary-window.js";
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

function programHistoryWindowFromHistoryV1Body(body: string): ProgramHistoryWindow {
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
    history_discovery: "aml_history_v1_capsule"
  };
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

  if (!snapshotId || !canonicalPayload || !canonicalEvidenceManifest) {
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
  const [openBody, openRowCount, latestCapsuleId] = await Promise.all([
    contractCallAtUrl<string>(url, programAddress, "get_open_capsule_body"),
    contractCallAtUrl<number>(url, programAddress, "get_open_capsule_row_count"),
    contractCallAtUrl<string>(url, programAddress, "get_latest_capsule_id").catch(() => "")
  ]);
  if (Number(openRowCount || 0) > 0 && openBody) {
    return programHistoryWindowFromHistoryV1Body(openBody);
  }
  if (latestCapsuleId) {
    const latestBody = await contractCallAtUrl<string>(url, programAddress, "get_history_capsule_body", [latestCapsuleId]);
    if (latestBody) return programHistoryWindowFromHistoryV1Body(latestBody);
  }
  return programHistoryWindowFromHistoryV1Body("");
}

async function readProgramSummaryHistoryFromUrl(programAddress: string, url: string): Promise<ProgramHistoryWindow> {
  try {
    return await readProgramSummaryHistoryFromUrlV0(programAddress, url);
  } catch (error) {
    const manifest = await contractCallAtUrl<string>(url, programAddress, "manifest").catch(() => "");
    if (manifest === "vitals-circle-state.v1") return readProgramSummaryHistoryFromUrlV1(programAddress, url);
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
  const [openBody, openRowCount, latestCapsuleId] = await Promise.all([
    circleProgramViewAtUrl<string>(url, circleId, "get_open_capsule_body"),
    circleProgramViewAtUrl<number>(url, circleId, "get_open_capsule_row_count"),
    circleProgramViewAtUrl<string>(url, circleId, "get_latest_capsule_id").catch(() => "")
  ]);
  if (Number(openRowCount || 0) > 0 && openBody) {
    return programHistoryWindowFromHistoryV1Body(openBody);
  }
  if (latestCapsuleId) {
    const latestBody = await circleProgramViewAtUrl<string>(url, circleId, "get_history_capsule_body", [latestCapsuleId]);
    if (latestBody) return programHistoryWindowFromHistoryV1Body(latestBody);
  }
  return programHistoryWindowFromHistoryV1Body("");
}

async function readCircleProgramSummaryHistoryFromUrl(circleId: string, url: string): Promise<ProgramHistoryWindow> {
  try {
    return await readCircleProgramSummaryHistoryFromUrlV0(circleId, url);
  } catch (error) {
    const manifest = await circleProgramViewAtUrl<string>(url, circleId, "manifest").catch(() => "");
    if (manifest === "vitals-circle-state.v1") return readCircleProgramSummaryHistoryFromUrlV1(circleId, url);
    throw error;
  }
}

export async function readCircleProgramSummaryHistory(circleId: string): Promise<ProgramHistoryWindow> {
  const urls = programRpcUrls();
  const [primaryUrl, ...otherUrls] = urls;
  if (!primaryUrl) throw new Error("no Octra program RPC URL configured");
  const primary = await readCircleProgramSummaryHistoryFromUrl(circleId, primaryUrl);
  if (!otherUrls.length) return primary;
  const candidates = await Promise.all(otherUrls.map(async (url) => ({
    url,
    history: await readCircleProgramSummaryHistoryFromUrl(circleId, url)
  })));
  for (const candidate of candidates) {
    assertSameHistory(primary, candidate.history, candidate.url);
  }
  return primary;
}

export async function readProgramSummaryHistory(programAddress: string): Promise<ProgramHistoryWindow> {
  const urls = programRpcUrls();
  const [primaryUrl, ...otherUrls] = urls;
  if (!primaryUrl) throw new Error("no Octra program RPC URL configured");
  const primary = await readProgramSummaryHistoryFromUrl(programAddress, primaryUrl);
  if (!otherUrls.length) return primary;
  const candidates = await Promise.all(otherUrls.map(async (url) => ({
    url,
    history: await readProgramSummaryHistoryFromUrl(programAddress, url)
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
