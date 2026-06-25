export const HISTORY_API_SCHEMA = "octra-vitals-history-api-v1";
export const LEGACY_HISTORY_SCHEMA = "octra-vitals-snapshot-history-v0";

export type HistoryWindowName = "1d" | "7d" | "30d";
export type HistoryCoverageStatus = "complete" | "partial" | "empty" | "invalid_request";

export interface HistoryApiRequest {
  window: HistoryWindowName | null;
  from_index: number | null;
  to_index: number | null;
  from: string | null;
  to: string | null;
  valid: boolean;
  errors: string[];
}

export interface HistoryApiCoverage {
  status: HistoryCoverageStatus;
  requested_window: HistoryWindowName | null;
  requested_from_index: number | null;
  requested_to_index: number | null;
  from_observed_at: string | null;
  to_observed_at: string | null;
  first_index: number | null;
  latest_index: number | null;
  points: number;
  note?: string;
}

export interface HistoryApiProof {
  history_model: string;
  proof_status: "fact_family_verified" | "summary_window_verified" | "unavailable";
  proof_scope: "full_chain" | "tail_window" | "summary_window" | "unavailable";
  truncated: boolean;
  sealed_capsule_start_ordinal?: number;
  sealed_capsule_total_count?: number;
  sealed_capsule_verified_count?: number;
  capsule_limit?: number;
  eras: unknown[];
  families: unknown[];
  capsules: unknown[];
}

export interface NormalizedHistorySnapshot {
  snapshot_index?: number;
  snapshot_id?: string;
  observed_at?: string;
  octra_epoch?: number;
  external_block?: number;
  payload_hash_prefix?: string;
  route_count?: number;
  supply?: Record<string, unknown>;
  bridge?: Record<string, unknown>;
  [key: string]: unknown;
}

const WINDOW_MS: Record<HistoryWindowName, number> = {
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000
};

function parsePositiveInteger(value: string | null): number | null {
  if (!value) return null;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function validIso(value: string | null): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function observedMs(snapshot: NormalizedHistorySnapshot): number | null {
  const value = snapshot.observed_at || snapshot.snapshot_id;
  if (!value) return null;
  const text = String(value).replace(/^vitals\./, "");
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

function snapshotIndex(snapshot: NormalizedHistorySnapshot): number | null {
  const value = Number(snapshot.snapshot_index || 0);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function parseHistoryApiRequest(searchParams: URLSearchParams): HistoryApiRequest {
  const rawWindow = searchParams.get("window");
  const errors: string[] = [];
  const window = rawWindow === null || rawWindow === "" ? null : rawWindow === "1d" || rawWindow === "7d" || rawWindow === "30d" ? rawWindow : null;
  if (rawWindow && !window) errors.push("invalid_window");
  const fromIndex = parsePositiveInteger(searchParams.get("from_index"));
  const toIndex = parsePositiveInteger(searchParams.get("to_index"));
  if (searchParams.get("from_index") && fromIndex === null) errors.push("invalid_from_index");
  if (searchParams.get("to_index") && toIndex === null) errors.push("invalid_to_index");
  const from = validIso(searchParams.get("from"));
  const to = validIso(searchParams.get("to"));
  if (searchParams.get("from") && from === null) errors.push("invalid_from");
  if (searchParams.get("to") && to === null) errors.push("invalid_to");
  if (fromIndex !== null && toIndex !== null && fromIndex > toIndex) errors.push("from_index_after_to_index");
  if (from && to && Date.parse(from) > Date.parse(to)) errors.push("from_after_to");
  return {
    window,
    from_index: fromIndex,
    to_index: toIndex,
    from,
    to,
    valid: errors.length === 0,
    errors
  };
}

export function filterHistorySnapshots<T extends NormalizedHistorySnapshot>(snapshots: T[], request: HistoryApiRequest): T[] {
  if (!request.valid) return [];
  if (!snapshots.length) return [];
  let filtered = snapshots.slice();
  const latestMs = observedMs(filtered[filtered.length - 1] || {});

  if (request.window && latestMs !== null) {
    const since = latestMs - WINDOW_MS[request.window];
    filtered = filtered.filter((snapshot) => {
      const ms = observedMs(snapshot);
      return ms === null || ms >= since;
    });
  }
  if (request.from) {
    const fromMs = Date.parse(request.from);
    filtered = filtered.filter((snapshot) => {
      const ms = observedMs(snapshot);
      return ms === null || ms >= fromMs;
    });
  }
  if (request.to) {
    const toMs = Date.parse(request.to);
    filtered = filtered.filter((snapshot) => {
      const ms = observedMs(snapshot);
      return ms === null || ms <= toMs;
    });
  }
  if (request.from_index !== null) {
    filtered = filtered.filter((snapshot) => {
      const index = snapshotIndex(snapshot);
      return index === null || index >= request.from_index!;
    });
  }
  if (request.to_index !== null) {
    filtered = filtered.filter((snapshot) => {
      const index = snapshotIndex(snapshot);
      return index === null || index <= request.to_index!;
    });
  }
  return filtered;
}

export function historyApiCoverage(snapshots: NormalizedHistorySnapshot[], filtered: NormalizedHistorySnapshot[], request: HistoryApiRequest): HistoryApiCoverage {
  const first = filtered[0] || null;
  const latest = filtered[filtered.length - 1] || null;
  const firstMs = first ? observedMs(first) : null;
  const latestMs = latest ? observedMs(latest) : null;
  const firstIndex = first ? snapshotIndex(first) : null;
  const latestIndex = latest ? snapshotIndex(latest) : null;
  let status: HistoryCoverageStatus = filtered.length > 0 ? "complete" : "empty";
  let note: string | undefined;

  if (request.window && snapshots.length > 0 && filtered.length > 0) {
    const allFirstMs = observedMs(snapshots[0] || {});
    const allLatestMs = observedMs(snapshots[snapshots.length - 1] || {});
    if (allFirstMs !== null && allLatestMs !== null && allLatestMs - allFirstMs < WINDOW_MS[request.window]) {
      status = "partial";
      note = "available canonical history is shorter than the requested window";
    }
  }
  if (!request.valid) {
    status = "invalid_request";
    note = request.errors.join(",");
  } else if (request.from_index !== null && snapshots.length > 0) {
    const allFirstIndex = snapshotIndex(snapshots[0] || {});
    if (allFirstIndex !== null && request.from_index < allFirstIndex) {
      status = filtered.length > 0 ? "partial" : "empty";
      note = "requested index range begins before available canonical history";
    }
  } else if (request.from && snapshots.length > 0) {
    const allFirstMs = observedMs(snapshots[0] || {});
    if (allFirstMs !== null && Date.parse(request.from) < allFirstMs) {
      status = filtered.length > 0 ? "partial" : "empty";
      note = "requested time range begins before available canonical history";
    }
  }

  const coverage: HistoryApiCoverage = {
    status,
    requested_window: request.window,
    requested_from_index: request.from_index,
    requested_to_index: request.to_index,
    from_observed_at: firstMs === null ? null : new Date(firstMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
    to_observed_at: latestMs === null ? null : new Date(latestMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
    first_index: firstIndex,
    latest_index: latestIndex,
    points: filtered.length
  };
  if (note) coverage.note = note;
  return coverage;
}

export function emptyHistoryProof(historyModel: string, verified: boolean): HistoryApiProof {
  return verifiedHistoryProof(historyModel, verified, []);
}

export function verifiedHistoryProof(
  historyModel: string,
  verified: boolean,
  eras: unknown[] = [],
  families: unknown[] = [],
  capsules: unknown[] = [],
  proof: Partial<Pick<
    HistoryApiProof,
    "proof_scope" | "truncated" | "sealed_capsule_start_ordinal" | "sealed_capsule_total_count" | "sealed_capsule_verified_count" | "capsule_limit"
  >> = {}
): HistoryApiProof {
  const factFamilyVerified = verified && historyModel.includes("fact_family") && historyModel.includes("verified");
  const proofScope = proof.proof_scope ||
    (factFamilyVerified
      ? historyModel.includes("tail") ? "tail_window" : "full_chain"
      : verified ? "summary_window" : "unavailable");
  const out: HistoryApiProof = {
    history_model: historyModel,
    proof_status: factFamilyVerified ? "fact_family_verified" : verified ? "summary_window_verified" : "unavailable",
    proof_scope: proofScope,
    truncated: proof.truncated ?? proofScope === "tail_window",
    eras,
    families,
    capsules
  };
  if (proof.sealed_capsule_start_ordinal !== undefined) out.sealed_capsule_start_ordinal = proof.sealed_capsule_start_ordinal;
  if (proof.sealed_capsule_total_count !== undefined) out.sealed_capsule_total_count = proof.sealed_capsule_total_count;
  if (proof.sealed_capsule_verified_count !== undefined) out.sealed_capsule_verified_count = proof.sealed_capsule_verified_count;
  if (proof.capsule_limit !== undefined) out.capsule_limit = proof.capsule_limit;
  return out;
}
