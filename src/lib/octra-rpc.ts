const DEFAULT_OCTRA_RPC_URL = "https://octra.network/rpc";
const DEFAULT_OCTRA_DEV_PROGRAM_RPC_URL = "https://devnet.octrascan.io/rpc";

interface OctraRpcOptions {
  url?: string;
  id?: string | number;
  retry?: boolean;
}

type RpcMethodMetrics = {
  calls: number;
  attempts: number;
  successes: number;
  failures: number;
  retries: number;
};

const rpcMaxConcurrent = Math.max(1, Number(process.env.OCTRA_RPC_MAX_CONCURRENT || 6));
const rpcMinStartGapMs = Math.max(0, Number(process.env.OCTRA_RPC_MIN_START_GAP_MS || 50));
let rpcActive = 0;
let rpcLastStartAt = 0;
const rpcQueue: Array<() => void> = [];
const rpcMetrics = {
  calls: 0,
  attempts: 0,
  successes: 0,
  failures: 0,
  retries: 0,
  throttled_starts: 0,
  max_concurrent_observed: 0,
  by_method: new Map<string, RpcMethodMetrics>()
};

function methodMetrics(method: string): RpcMethodMetrics {
  let value = rpcMetrics.by_method.get(method);
  if (!value) {
    value = { calls: 0, attempts: 0, successes: 0, failures: 0, retries: 0 };
    rpcMetrics.by_method.set(method, value);
  }
  return value;
}

function pumpRpcQueue(): void {
  while (rpcActive < rpcMaxConcurrent && rpcQueue.length) {
    const next = rpcQueue.shift();
    if (next) next();
  }
}

async function acquireRpcSlot(): Promise<void> {
  if (rpcActive >= rpcMaxConcurrent) {
    rpcMetrics.throttled_starts += 1;
    await new Promise<void>((resolve) => rpcQueue.push(resolve));
  }
  rpcActive += 1;
  rpcMetrics.max_concurrent_observed = Math.max(rpcMetrics.max_concurrent_observed, rpcActive);
  const waitMs = Math.max(0, rpcMinStartGapMs - (Date.now() - rpcLastStartAt));
  if (waitMs > 0) {
    rpcMetrics.throttled_starts += 1;
    await sleep(waitMs);
  }
  rpcLastStartAt = Date.now();
}

function releaseRpcSlot(): void {
  rpcActive = Math.max(0, rpcActive - 1);
  pumpRpcQueue();
}

async function withRpcSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquireRpcSlot();
  try {
    return await fn();
  } finally {
    releaseRpcSlot();
  }
}

export function octraRpcMetricsSnapshot(): Record<string, unknown> {
  return {
    max_concurrent: rpcMaxConcurrent,
    min_start_gap_ms: rpcMinStartGapMs,
    active: rpcActive,
    queued: rpcQueue.length,
    calls: rpcMetrics.calls,
    attempts: rpcMetrics.attempts,
    successes: rpcMetrics.successes,
    failures: rpcMetrics.failures,
    retries: rpcMetrics.retries,
    throttled_starts: rpcMetrics.throttled_starts,
    max_concurrent_observed: rpcMetrics.max_concurrent_observed,
    by_method: Object.fromEntries([...rpcMetrics.by_method.entries()].map(([method, value]) => [method, { ...value }]))
  };
}

export function octraProgramRpcUrl(): string {
  return octraProgramRpcUrls()[0] || DEFAULT_OCTRA_RPC_URL;
}

export function octraProgramRpcUrls(): string[] {
  const configured = process.env.OCTRA_PROGRAM_RPC_URLS || process.env.OCTRA_PROGRAM_RPC_URL;
  const urls = configured
    ? configured.split(",").map((url) => url.trim()).filter(Boolean)
    : [];
  if (urls.length) return Array.from(new Set(urls));
  return [
    process.env.OCTRA_TX_RPC_URL ||
    process.env.OCTRA_RPC_URL ||
    (process.env.VITALS_GATEWAY_ROLE === "production" || process.env.VITALS_GATEWAY_ROLE === "prod"
      ? DEFAULT_OCTRA_RPC_URL
      : DEFAULT_OCTRA_DEV_PROGRAM_RPC_URL)
  ];
}

export function octraObservationRpcUrl(): string {
  return process.env.OCTRA_OBSERVATION_RPC_URL ||
    process.env.OCTRA_RPC_URL ||
    DEFAULT_OCTRA_RPC_URL;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retrySafeOctraMethod(method: string): boolean {
  return !new Set([
    "octra_submit",
    "octra_submitBatch",
    "contract_verify",
    "contract_saveAbi"
  ]).has(method);
}

function retryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /aborted|network|fetch failed|timeout|timed out|econnreset|etimedout|eai_again|returned 408|returned 425|returned 429|returned 5\d\d|non-json|temporarily unavailable|rate limit|too many requests/i.test(message);
}

function retryableHttpStatus(status: number): boolean {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

function retryableRpcError(error: any): boolean {
  const code = Number(error?.code);
  const message = String(error?.message || JSON.stringify(error || "")).toLowerCase();
  return code === 429 ||
    code === -32029 ||
    message.includes("too many requests") ||
    message.includes("rate limit") ||
    message.includes("temporarily unavailable");
}

function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.min(Math.max(0, dateMs - Date.now()), 30_000);
  return null;
}

function retryDelay(attempt: number, retryAfter: number | null): number {
  if (retryAfter !== null) return retryAfter;
  const baseMs = Math.max(0, Number(process.env.OCTRA_RPC_RETRY_DELAY_MS || 1_000));
  const jitterMs = Math.floor(Math.random() * Math.max(1, baseMs / 3));
  return Math.min(10_000, baseMs * 2 ** Math.max(0, attempt - 1) + jitterMs);
}

export async function octraRpc<T = any>(method: string, params: unknown[] = [], options: OctraRpcOptions = {}): Promise<T> {
  const url = options.url || octraProgramRpcUrl();
  const timeoutMs = Number(process.env.OCTRA_RPC_TIMEOUT_MS || 15_000);
  const request = {
    jsonrpc: "2.0",
    id: options.id || 1,
    method,
    params
  };
  const shouldRetry = options.retry ?? retrySafeOctraMethod(method);
  const maxAttempts = shouldRetry ? Math.max(1, Number(process.env.OCTRA_RPC_ATTEMPTS || 5)) : 1;
  let lastError: unknown = null;
  const perMethod = methodMetrics(method);
  rpcMetrics.calls += 1;
  perMethod.calls += 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      rpcMetrics.attempts += 1;
      perMethod.attempts += 1;
      if (attempt > 1) {
        rpcMetrics.retries += 1;
        perMethod.retries += 1;
      }
      const response = await withRpcSlot(() => fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "octra-vitals/v0"
        },
        body: JSON.stringify(request),
        signal: controller.signal
      }));
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`${url} returned ${response.status}: ${text.slice(0, 240)}`);
        lastError = error;
        if (attempt < maxAttempts && retryableHttpStatus(response.status)) {
          await sleep(retryDelay(attempt, retryAfterMs(response.headers.get("retry-after"))));
          continue;
        }
        throw error;
      }
      let body: any;
      try {
        body = JSON.parse(text);
      } catch (error) {
        const wrapped = new Error(`${url} returned non-JSON ${method} response: ${text.slice(0, 240)}`);
        lastError = wrapped;
        if (attempt < maxAttempts && retryableError(wrapped)) {
          await sleep(retryDelay(attempt, null));
          continue;
        }
        throw wrapped;
      }
      if (body.error) {
        const error = new Error(`${method} failed: ${body.error.message || JSON.stringify(body.error)}`);
        lastError = error;
        if (attempt < maxAttempts && retryableRpcError(body.error)) {
          await sleep(retryDelay(attempt, null));
          continue;
        }
        throw error;
      }
      rpcMetrics.successes += 1;
      perMethod.successes += 1;
      return body.result;
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !retryableError(error)) {
        rpcMetrics.failures += 1;
        perMethod.failures += 1;
        throw error;
      }
      await sleep(retryDelay(attempt, null));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function contractCall<T = any>(
  address: string,
  method: string,
  params: unknown[] = [],
  caller?: string
): Promise<T> {
  const urls = octraProgramRpcUrls();
  let lastError: unknown = null;
  for (const url of urls) {
    try {
      return await contractCallAtUrl<T>(url, address, method, params, caller);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function contractCallAtUrl<T = any>(
  url: string,
  address: string,
  method: string,
  params: unknown[] = [],
  caller?: string
): Promise<T> {
  const callParams = caller ? [address, method, params, caller] : [address, method, params];
  const result = await octraRpc<any>("contract_call", callParams, { url });
  if (result && typeof result === "object" && "result" in result) {
    return result.result as T;
  }
  return result as T;
}

export async function contractSource(address: string): Promise<any> {
  return octraRpc<any>("contract_source", [address], { url: octraProgramRpcUrl() });
}

export async function vmContract(address: string): Promise<any> {
  return octraRpc<any>("vm_contract", [address], { url: octraProgramRpcUrl() });
}

export async function contractReceipt(txHash: string): Promise<any> {
  return octraRpc<any>("contract_receipt", [txHash], { url: octraProgramRpcUrl() });
}

export async function stagingStats(): Promise<any> {
  return octraRpc<any>("staging_stats", [], { url: octraProgramRpcUrl() });
}

export async function stagingEstimateOu(): Promise<any> {
  return octraRpc<any>("staging_estimateOu", [], { url: octraProgramRpcUrl() });
}

export async function circleInfo(circleId: string): Promise<any> {
  return circleInfoAtUrl(octraProgramRpcUrl(), circleId);
}

export async function circleInfoAtUrl(url: string, circleId: string): Promise<any> {
  return octraRpc<any>("circle_info", [circleId], { url });
}

export async function circleProgramInfo(circleId: string): Promise<any> {
  return circleProgramInfoAtUrl(octraProgramRpcUrl(), circleId);
}

export async function circleProgramInfoAtUrl(url: string, circleId: string): Promise<any> {
  return octraRpc<any>("octra_circleProgramInfo", [circleId], { url });
}

export async function recommendedOu(opType: string, fallback: string): Promise<string> {
  try {
    const result = await octraRpc<any>("octra_recommendedFee", [opType]);
    const candidates = [
      result?.recommended_ou,
      result?.recommended,
      result?.fast_ou,
      result?.fast,
      result?.base_ou,
      result?.base,
      result?.minimum_ou,
      result?.minimum
    ];
    const value = candidates.find((candidate) => candidate !== undefined && candidate !== null && String(candidate).length > 0);
    return value ? String(value) : fallback;
  } catch {
    return fallback;
  }
}

export async function feeTelemetry(opType: string): Promise<Record<string, unknown>> {
  const [recommended, staging, estimate] = await Promise.allSettled([
    octraRpc<any>("octra_recommendedFee", [opType]),
    stagingStats(),
    stagingEstimateOu()
  ]);
  return {
    op_type: opType,
    recommended_fee: recommended.status === "fulfilled" ? recommended.value : null,
    staging_stats: staging.status === "fulfilled" ? staging.value : null,
    staging_estimate_ou: estimate.status === "fulfilled" ? estimate.value : null,
    errors: {
      recommended_fee: recommended.status === "rejected" ? String(recommended.reason?.message || recommended.reason) : null,
      staging_stats: staging.status === "rejected" ? String(staging.reason?.message || staging.reason) : null,
      staging_estimate_ou: estimate.status === "rejected" ? String(estimate.reason?.message || estimate.reason) : null
    }
  };
}
