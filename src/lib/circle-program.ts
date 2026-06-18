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
  const result = await octraRpc<any>("octra_circleView", [circleId, method, params, caller, false], { url });
  if (result && typeof result === "object" && "result" in result) return result.result as T;
  return result as T;
}
