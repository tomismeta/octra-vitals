import { configuredProgrammedCircleId, stateTargetMode, type StateTargetMode } from "./circle-program.js";
import { configuredProgramAddress, readCircleProgramSummaryHistory, readLatestCircleProgramSnapshot, readLatestProgramSnapshot, readProgramSummaryHistory, type ProgramHistoryReadOptions } from "./program-state.js";
import { decodeSummaryRow, SUMMARY_ROW_LEN, type ProgramHistoryWindow } from "./summary-window.js";
import type { SnapshotArtifact } from "./types.js";

export interface StateTarget {
  kind: StateTargetMode;
  id: string | null;
}

export type HistoryReadOptions = ProgramHistoryReadOptions;

export type HistoryTailAnchorSource = "current_latest" | "remembered_latest_summary";

export interface HistorySummaryAnchor {
  latest_summary: string;
  observed_at_unix: number | null;
  checked_at_ms?: number | null;
}

export interface HistoryTailAnchorVerification {
  latest_index: number;
  tail_index: number;
  anchor_index: number;
  anchor_source: HistoryTailAnchorSource;
  lag_snapshots: number;
  lag_seconds: number | null;
}

export interface HistoryTailAnchorOptions {
  maxLagSnapshots?: number;
  rememberedSummaries?: ReadonlyMap<number, HistorySummaryAnchor>;
}

export class HistoryTailAnchorError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HistoryTailAnchorError";
    this.code = code;
  }
}

export function chooseConfiguredValue(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (value && value !== "pending") return value;
  }
  return "pending";
}

export function configuredStateTarget(manifest: Record<string, any> = {}): StateTarget {
  const kind = stateTargetMode();
  if (kind === "circle_program") {
    return {
      kind,
      id: configuredProgrammedCircleId(chooseConfiguredValue(process.env.VITALS_PROGRAMMED_CIRCLE_ID, manifest.programmed_circle_id))
    };
  }
  return {
    kind,
    id: configuredProgramAddress(chooseConfiguredValue(process.env.VITALS_STATE_PROGRAM_ADDRESS, manifest.state_program_address))
  };
}

export async function readCanonicalHistory(target: StateTarget, options: HistoryReadOptions = {}): Promise<ProgramHistoryWindow> {
  if (!target.id) {
    throw new Error(`${target.kind === "circle_program" ? "programmed Circle id" : "state program address"} is required`);
  }
  return target.kind === "circle_program"
    ? readCircleProgramSummaryHistory(target.id, options)
    : readProgramSummaryHistory(target.id, options);
}

export function assertHistoryTailMatchesLatest(history: ProgramHistoryWindow, latest: SnapshotArtifact): void {
  assertHistoryTailWithinLag(history, latest, { maxLagSnapshots: 0 });
}

export function assertHistoryTailWithinLag(
  history: ProgramHistoryWindow,
  latest: SnapshotArtifact,
  options: HistoryTailAnchorOptions = {}
): HistoryTailAnchorVerification {
  const latestSummary = (latest as any).latest_summary;
  const latestIndex = Number((latest as any).snapshot_index || 0);
  if (typeof latestSummary !== "string" || !latestSummary) {
    throw new HistoryTailAnchorError("latest_summary_unavailable", "latest summary unavailable for history verification");
  }
  if (!Number.isFinite(latestIndex) || latestIndex <= 0) {
    throw new HistoryTailAnchorError("latest_index_unavailable", "latest snapshot index unavailable for history verification");
  }
  if (history.row_count <= 0 || history.rows.length <= 0) {
    throw new HistoryTailAnchorError("history_empty", "canonical history window is empty while latest snapshot is available");
  }
  const tail = history.rows[history.rows.length - 1];
  if (!tail) {
    throw new HistoryTailAnchorError("history_tail_missing", "canonical history tail row is missing");
  }
  const maxLag = Math.max(0, Math.min(2, Math.trunc(Number(options.maxLagSnapshots ?? 0) || 0)));
  const lagSnapshots = latestIndex - tail.snapshot_index;
  if (lagSnapshots < 0) {
    throw new HistoryTailAnchorError(
      "history_tail_ahead",
      `canonical history tail is ahead of latest summary: tail ${tail.snapshot_index}, latest ${latestIndex}`
    );
  }
  if (lagSnapshots > maxLag) {
    throw new HistoryTailAnchorError(
      "history_tail_lag_exceeds_max",
      `canonical history tail lag ${lagSnapshots} exceeds max ${maxLag}`
    );
  }

  const anchorSummary = lagSnapshots === 0
    ? latestSummary
    : options.rememberedSummaries?.get(tail.snapshot_index)?.latest_summary;
  if (typeof anchorSummary !== "string" || !anchorSummary) {
    throw new HistoryTailAnchorError(
      "remembered_summary_unavailable",
      `remembered latest summary unavailable for history tail ${tail.snapshot_index}`
    );
  }
  const tailSummary = history.window.slice(-SUMMARY_ROW_LEN);
  if (tailSummary !== anchorSummary) {
    const source = lagSnapshots === 0 ? "latest" : "remembered latest";
    throw new HistoryTailAnchorError(
      "history_tail_summary_mismatch",
      `canonical history tail does not match ${source} summary row`
    );
  }

  let lagSeconds: number | null = null;
  try {
    const latestRow = decodeSummaryRow(latestSummary);
    lagSeconds = Math.max(0, latestRow.observed_at_unix - tail.observed_at_unix);
  } catch {
    lagSeconds = null;
  }

  return {
    latest_index: latestIndex,
    tail_index: tail.snapshot_index,
    anchor_index: tail.snapshot_index,
    anchor_source: lagSnapshots === 0 ? "current_latest" : "remembered_latest_summary",
    lag_snapshots: lagSnapshots,
    lag_seconds: lagSeconds
  };
}

export async function readVerifiedCanonicalHistory(target: StateTarget, options: HistoryReadOptions = {}): Promise<ProgramHistoryWindow> {
  if (!target.id) {
    throw new Error(`${target.kind === "circle_program" ? "programmed Circle id" : "state program address"} is required`);
  }
  const latest = target.kind === "circle_program"
    ? await readLatestCircleProgramSnapshot(target.id)
    : await readLatestProgramSnapshot(target.id);
  const history = await readCanonicalHistory(target, options);
  assertHistoryTailMatchesLatest(history, latest);
  return history;
}
