import { octraProgramRpcUrls, octraRpc } from "./octra-rpc.js";

export type StateTargetMode = "state_program" | "circle_program";

export function stateTargetMode(value = process.env.VITALS_STATE_TARGET_MODE): StateTargetMode {
  return value === "circle_program" ? "circle_program" : "state_program";
}

export function configuredProgrammedCircleId(value = process.env.VITALS_PROGRAMMED_CIRCLE_ID): string | null {
  if (!value || value === "pending") return null;
  return value;
}

export function circleViewCaller(): string | null {
  return process.env.VITALS_CIRCLE_VIEW_CALLER_ADDRESS ||
    process.env.VITALS_OPERATOR_ADDRESS ||
    process.env.VITALS_DEPLOYER_ADDRESS ||
    null;
}

function positiveIntEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name] || fallback);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeIntEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name] || fallback);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

const circleViewMaxConcurrent = positiveIntEnv("VITALS_CIRCLE_VIEW_MAX_CONCURRENT", 3);
const circleViewMinStartGapMs = nonNegativeIntEnv("VITALS_CIRCLE_VIEW_MIN_START_GAP_MS", 75);
let activeCircleViews = 0;
let nextCircleViewStartAt = 0;
const circleViewQueue: Array<() => void> = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function releaseCircleViewSlot(): void {
  activeCircleViews = Math.max(0, activeCircleViews - 1);
  const next = circleViewQueue.shift();
  if (next) next();
}

async function acquireCircleViewSlot(): Promise<void> {
  if (activeCircleViews >= circleViewMaxConcurrent) {
    await new Promise<void>((resolve) => circleViewQueue.push(resolve));
  }
  activeCircleViews += 1;
  const now = Date.now();
  const waitMs = Math.max(0, nextCircleViewStartAt - now);
  nextCircleViewStartAt = Math.max(now, nextCircleViewStartAt) + circleViewMinStartGapMs;
  if (waitMs > 0) await sleep(waitMs);
}

async function withCircleViewSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquireCircleViewSlot();
  try {
    return await fn();
  } finally {
    releaseCircleViewSlot();
  }
}

export async function circleProgramView<T = any>(
  circleId: string,
  method: string,
  params: unknown[] = [],
  caller = circleViewCaller()
): Promise<T> {
  const url = octraProgramRpcUrls()[0];
  if (!url) throw new Error("no Octra program RPC URL configured");
  return circleProgramViewAtUrl<T>(url, circleId, method, params, caller);
}

export async function circleProgramViewAtUrl<T = any>(
  url: string,
  circleId: string,
  method: string,
  params: unknown[] = [],
  caller = circleViewCaller()
): Promise<T> {
  if (!caller) throw new Error("VITALS_CIRCLE_VIEW_CALLER_ADDRESS or VITALS_OPERATOR_ADDRESS is required for circle program views");
  const result = await withCircleViewSlot(() => octraRpc<any>("octra_circleView", [circleId, method, params, caller, false], { url }));
  if (result && typeof result === "object" && "result" in result) return result.result as T;
  return result as T;
}
