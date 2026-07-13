import { octraProgramRpcUrls, octraRpc, RpcAdmissionController } from "./octra-rpc.js";

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
  const configured = process.env[name];
  const parsed = configured !== undefined && configured !== "" ? Number(configured) : fallback;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function nonNegativeIntEnv(name: string, fallback: number): number {
  const configured = process.env[name];
  const parsed = configured !== undefined && configured !== "" ? Number(configured) : fallback;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

const circleViewMaxConcurrent = positiveIntEnv("VITALS_CIRCLE_VIEW_MAX_CONCURRENT", 4);
const circleViewMinStartGapMs = nonNegativeIntEnv("VITALS_CIRCLE_VIEW_MIN_START_GAP_MS", 50);
const circleViewAdmission = new RpcAdmissionController(
  circleViewMaxConcurrent,
  circleViewMinStartGapMs,
  nonNegativeIntEnv("VITALS_CIRCLE_VIEW_MAX_QUEUE", 128),
  positiveIntEnv("VITALS_CIRCLE_VIEW_QUEUE_WAIT_MS", 15_000)
);

async function withCircleViewSlot<T>(fn: () => Promise<T>): Promise<T> {
  return circleViewAdmission.run(fn);
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
