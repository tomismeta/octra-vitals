const DEFAULT_OCTRA_RPC_URL = "https://octra.network/rpc";
const DEFAULT_OCTRA_DEV_PROGRAM_RPC_URL = "https://devnet.octrascan.io/rpc";

interface OctraRpcOptions {
  url?: string;
  id?: string | number;
  retry?: boolean;
}

type RpcQueueEntry = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  settled: boolean;
};

export type RpcAdmissionMetrics = {
  active: number;
  queued: number;
  rejected: number;
  timed_out: number;
  throttled_starts: number;
  max_concurrent_observed: number;
};

export class RpcAdmissionController {
  private active = 0;
  private nextStartAt = 0;
  private readonly queue: RpcQueueEntry[] = [];
  private rejected = 0;
  private timedOut = 0;
  private throttledStarts = 0;
  private maxConcurrentObserved = 0;

  constructor(
    private readonly maxConcurrent: number,
    private readonly minStartGapMs: number,
    private readonly maxQueue: number,
    private readonly queueWaitMs: number
  ) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new Error("RPC max concurrency must be positive");
    if (!Number.isSafeInteger(minStartGapMs) || minStartGapMs < 0) throw new Error("RPC start gap must be non-negative");
    if (!Number.isSafeInteger(maxQueue) || maxQueue < 0) throw new Error("RPC max queue must be non-negative");
    if (!Number.isSafeInteger(queueWaitMs) || queueWaitMs < 1) throw new Error("RPC queue wait must be positive");
  }

  private async waitForReservedStart(): Promise<void> {
    const now = Date.now();
    const reservedStart = Math.max(now, this.nextStartAt);
    this.nextStartAt = reservedStart + this.minStartGapMs;
    const waitMs = reservedStart - now;
    if (waitMs > 0) {
      this.throttledStarts += 1;
      await sleep(waitMs);
    }
  }

  async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      this.maxConcurrentObserved = Math.max(this.maxConcurrentObserved, this.active);
      await this.waitForReservedStart();
      return;
    }

    if (this.queue.length >= this.maxQueue) {
      this.rejected += 1;
      throw new Error("Octra RPC queue is full");
    }

    this.throttledStarts += 1;
    await new Promise<void>((resolve, reject) => {
      const entry: RpcQueueEntry = {
        resolve,
        reject,
        settled: false,
        timer: setTimeout(() => {
          if (entry.settled) return;
          entry.settled = true;
          const index = this.queue.indexOf(entry);
          if (index >= 0) this.queue.splice(index, 1);
          this.timedOut += 1;
          reject(new Error("Timed out waiting for an Octra RPC slot"));
        }, this.queueWaitMs)
      };
      this.queue.push(entry);
    });
    await this.waitForReservedStart();
  }

  release(): void {
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next || next.settled) continue;
      next.settled = true;
      clearTimeout(next.timer);
      // The active permit is transferred directly to the queued caller.
      next.resolve();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  snapshot(): RpcAdmissionMetrics {
    return {
      active: this.active,
      queued: this.queue.length,
      rejected: this.rejected,
      timed_out: this.timedOut,
      throttled_starts: this.throttledStarts,
      max_concurrent_observed: this.maxConcurrentObserved
    };
  }
}

type RpcMethodMetrics = {
  calls: number;
  attempts: number;
  successes: number;
  failures: number;
  retries: number;
};

export function parseRpcIntegerSetting(
  configured: string | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number
): number {
  const parsed = configured !== undefined && configured !== "" ? Number(configured) : fallback;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

const rpcMaxConcurrent = parseRpcIntegerSetting(process.env.OCTRA_RPC_MAX_CONCURRENT, 6, "OCTRA_RPC_MAX_CONCURRENT", 1, 256);
const rpcMinStartGapMs = parseRpcIntegerSetting(process.env.OCTRA_RPC_MIN_START_GAP_MS, 50, "OCTRA_RPC_MIN_START_GAP_MS", 0, 60_000);
const rpcMaxQueue = parseRpcIntegerSetting(process.env.OCTRA_RPC_MAX_QUEUE, 128, "OCTRA_RPC_MAX_QUEUE", 0, 100_000);
const rpcQueueWaitMs = parseRpcIntegerSetting(process.env.OCTRA_RPC_QUEUE_WAIT_MS, 15_000, "OCTRA_RPC_QUEUE_WAIT_MS", 1, 300_000);
const rpcMaxResponseBytes = parseRpcIntegerSetting(
  process.env.OCTRA_RPC_MAX_RESPONSE_BYTES,
  8 * 1024 * 1024,
  "OCTRA_RPC_MAX_RESPONSE_BYTES",
  1,
  64 * 1024 * 1024
);
const rpcTimeoutMs = parseRpcIntegerSetting(process.env.OCTRA_RPC_TIMEOUT_MS, 15_000, "OCTRA_RPC_TIMEOUT_MS", 1, 300_000);
const rpcAttempts = parseRpcIntegerSetting(process.env.OCTRA_RPC_ATTEMPTS, 5, "OCTRA_RPC_ATTEMPTS", 1, 10);
const rpcRetryDelayMs = parseRpcIntegerSetting(process.env.OCTRA_RPC_RETRY_DELAY_MS, 1_000, "OCTRA_RPC_RETRY_DELAY_MS", 0, 30_000);
const rpcAdmission = new RpcAdmissionController(rpcMaxConcurrent, rpcMinStartGapMs, rpcMaxQueue, rpcQueueWaitMs);
const rpcMetrics = {
  calls: 0,
  attempts: 0,
  successes: 0,
  failures: 0,
  retries: 0,
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

async function withRpcSlot<T>(fn: () => Promise<T>): Promise<T> {
  return rpcAdmission.run(fn);
}

export async function readResponseTextWithLimit(response: Response, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Response byte limit must be positive");
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Octra RPC response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Octra RPC response exceeds ${maxBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

export function octraRpcMetricsSnapshot(): Record<string, unknown> {
  const admission = rpcAdmission.snapshot();
  return {
    max_concurrent: rpcMaxConcurrent,
    min_start_gap_ms: rpcMinStartGapMs,
    max_queue: rpcMaxQueue,
    queue_wait_ms: rpcQueueWaitMs,
    max_response_bytes: rpcMaxResponseBytes,
    active: admission.active,
    queued: admission.queued,
    calls: rpcMetrics.calls,
    attempts: rpcMetrics.attempts,
    successes: rpcMetrics.successes,
    failures: rpcMetrics.failures,
    retries: rpcMetrics.retries,
    rejected: admission.rejected,
    timed_out: admission.timed_out,
    throttled_starts: admission.throttled_starts,
    max_concurrent_observed: admission.max_concurrent_observed,
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

export function isExplicitDevelopmentRpcUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(hostname)) return hostname.split(".").every((part) => Number(part) <= 255);
  return /(?:^|[.-])devnet(?:[.-]|$)/.test(hostname);
}

export function rpcUrlLabel(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "configured-rpc";
  }
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

function safeRpcText(value: unknown): string {
  return String(value ?? "").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 240);
}

function rpcErrorSummary(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    return safeRpcText((error as { message?: unknown }).message);
  }
  try {
    return safeRpcText(JSON.stringify(error ?? ""));
  } catch {
    return "unprintable RPC error";
  }
}

function retryableRpcError(error: any): boolean {
  const code = Number(error?.code);
  const message = rpcErrorSummary(error).toLowerCase();
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
  const baseMs = rpcRetryDelayMs;
  const jitterMs = Math.floor(Math.random() * Math.max(1, baseMs / 3));
  return Math.min(10_000, baseMs * 2 ** Math.max(0, attempt - 1) + jitterMs);
}

export async function octraRpc<T = any>(method: string, params: unknown[] = [], options: OctraRpcOptions = {}): Promise<T> {
  const url = options.url || octraProgramRpcUrl();
  const request = {
    jsonrpc: "2.0",
    id: options.id ?? 1,
    method,
    params
  };
  const shouldRetry = options.retry ?? retrySafeOctraMethod(method);
  const maxAttempts = shouldRetry ? rpcAttempts : 1;
  let lastError: unknown = null;
  const perMethod = methodMetrics(method);
  rpcMetrics.calls += 1;
  perMethod.calls += 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), rpcTimeoutMs);
    try {
      rpcMetrics.attempts += 1;
      perMethod.attempts += 1;
      if (attempt > 1) {
        rpcMetrics.retries += 1;
        perMethod.retries += 1;
      }
      const { response, text } = await withRpcSlot(async () => {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": "octra-vitals/v0"
          },
          body: JSON.stringify(request),
          signal: controller.signal
        });
        const text = await readResponseTextWithLimit(response, rpcMaxResponseBytes);
        return { response, text };
      });
      if (!response.ok) {
        const error = new Error(`${rpcUrlLabel(url)} returned ${response.status}: ${safeRpcText(text)}`);
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
        const wrapped = new Error(`${rpcUrlLabel(url)} returned non-JSON ${method} response: ${safeRpcText(text)}`);
        lastError = wrapped;
        if (attempt < maxAttempts && retryableError(wrapped)) {
          await sleep(retryDelay(attempt, null));
          continue;
        }
        throw wrapped;
      }
      if (body.error) {
        const error = new Error(`${method} failed: ${rpcErrorSummary(body.error)}`);
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
