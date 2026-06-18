const DEFAULT_OCTRA_RPC_URL = "https://octra.network/rpc";
const DEFAULT_OCTRA_DEV_PROGRAM_RPC_URL = "https://devnet.octrascan.io/rpc";

interface OctraRpcOptions {
  url?: string;
  id?: string | number;
  retry?: boolean;
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
  return /aborted|network|fetch failed|timeout|timed out|econnreset|etimedout|eai_again|returned 408|returned 425|returned 429|returned 5\d\d/i.test(message);
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
  const maxAttempts = shouldRetry ? Math.max(1, Number(process.env.OCTRA_RPC_ATTEMPTS || 3)) : 1;
  const retryDelayMs = Math.max(0, Number(process.env.OCTRA_RPC_RETRY_DELAY_MS || 1_500));
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
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
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`${url} returned ${response.status}: ${text.slice(0, 240)}`);
      }
      const body = JSON.parse(text);
      if (body.error) {
        throw new Error(`${method} failed: ${body.error.message || JSON.stringify(body.error)}`);
      }
      return body.result;
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !retryableError(error)) {
        throw error;
      }
      await sleep(retryDelayMs * attempt);
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
