import { configuredProgrammedCircleId, stateTargetMode, type StateTargetMode } from "./circle-program.js";
import { configuredProgramAddress, readCircleProgramSummaryHistory, readLatestCircleProgramSnapshot, readLatestProgramSnapshot, readProgramSummaryHistory } from "./program-state.js";
import type { ProgramHistoryWindow } from "./summary-window.js";
import type { SnapshotArtifact } from "./types.js";

export interface StateTarget {
  kind: StateTargetMode;
  id: string | null;
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

export async function readCanonicalHistory(target: StateTarget): Promise<ProgramHistoryWindow> {
  if (!target.id) {
    throw new Error(`${target.kind === "circle_program" ? "programmed Circle id" : "state program address"} is required`);
  }
  return target.kind === "circle_program"
    ? readCircleProgramSummaryHistory(target.id)
    : readProgramSummaryHistory(target.id);
}

export function assertHistoryTailMatchesLatest(history: ProgramHistoryWindow, latest: SnapshotArtifact): void {
  const latestSummary = (latest as any).latest_summary;
  const latestIndex = Number((latest as any).snapshot_index || 0);
  if (typeof latestSummary !== "string" || !latestSummary) {
    throw new Error("latest summary unavailable for history verification");
  }
  if (history.row_count <= 0 || history.rows.length <= 0) {
    throw new Error("canonical history window is empty while latest snapshot is available");
  }
  if (!history.window.endsWith(latestSummary)) {
    throw new Error("canonical history tail does not match latest summary row");
  }
  const tail = history.rows[history.rows.length - 1];
  if (!tail || tail.snapshot_index !== latestIndex) {
    throw new Error(`canonical history tail index mismatch: expected ${latestIndex}, got ${tail?.snapshot_index ?? "missing"}`);
  }
}

export async function readVerifiedCanonicalHistory(target: StateTarget): Promise<ProgramHistoryWindow> {
  if (!target.id) {
    throw new Error(`${target.kind === "circle_program" ? "programmed Circle id" : "state program address"} is required`);
  }
  const latest = target.kind === "circle_program"
    ? await readLatestCircleProgramSnapshot(target.id)
    : await readLatestProgramSnapshot(target.id);
  const history = await readCanonicalHistory(target);
  assertHistoryTailMatchesLatest(history, latest);
  return history;
}
