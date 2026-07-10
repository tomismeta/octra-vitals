import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { canonicalJson, requestHash, responseHash, sha256Tagged } from "./canonical-json.js";
import { octraObservationRpcUrl } from "./octra-rpc.js";
import { decimalToRawString, hexToRawString, sumRaw } from "./units.js";
import { assertObservationTimeSafe, configuredObservationFutureSkewMs } from "./observation-time.js";
import type { EvidenceEntry, EvidenceManifest, JsonRpcRequest, JsonRpcRow, RawEvidenceEntry, SnapshotArtifact, SnapshotEnvelope, SnapshotPayload, SourceRef } from "./types.js";

const DEFAULT_PUBLIC_EVIDENCE_HOSTS = [
  "octra.network",
  "devnet.octrascan.io",
  "relayer-002838819188.octra.network",
  "ethereum.publicnode.com",
  "ethereum-rpc.publicnode.com"
];
const OCTRA_RPC_URLS = sourceUrls(
  process.env.OCTRA_OBSERVATION_RPC_URLS,
  process.env.OCTRA_OBSERVATION_RPC_URL || octraObservationRpcUrl()
);
const RELAYER_URLS = sourceUrls(
  process.env.RELAYER_URLS,
  process.env.RELAYER_URL || "https://relayer-002838819188.octra.network"
);
const ETH_RPC_URLS = sourceUrls(
  process.env.ETH_RPC_URLS,
  process.env.ETH_RPC_URL || "https://ethereum-rpc.publicnode.com"
);
const PARSER_VERSION = "octra-vitals-parser-v0";
const PAYLOAD_SCHEMA_VERSION = process.env.VITALS_PAYLOAD_SCHEMA_VERSION || "octra-vitals-snapshot-v0";
const EVIDENCE_SCHEMA_VERSION = process.env.VITALS_EVIDENCE_SCHEMA_VERSION || "octra-vitals-evidence-v0";
const ENVELOPE_SCHEMA_VERSION = process.env.VITALS_ENVELOPE_SCHEMA_VERSION || "octra-vitals-envelope-v0";
const SNAPSHOT_HASH_DOMAIN = process.env.VITALS_SNAPSHOT_HASH_DOMAIN || "octra-vitals:snapshot:v0";
const EVIDENCE_HASH_DOMAIN = process.env.VITALS_EVIDENCE_HASH_DOMAIN || "octra-vitals:evidence:v0";
const ROUTE_CONFIG = {
  octraVaultAddress: process.env.VITALS_OCTRA_VAULT_ADDRESS || "oct5MrNfjiXFNRDLwsodn8Zm9hDKNGAYt3eQDCQ52bSpCHq",
  octraChainId: positiveIntegerEnv("VITALS_OCTRA_CHAIN_ID", 7777, 4_294_967_295),
  ethereumChainId: positiveIntegerEnv("VITALS_ETHEREUM_CHAIN_ID", 1, 4_294_967_295),
  ethereumWoctAddress: process.env.VITALS_ETHEREUM_WOCT_ADDRESS || "0x4647e1fE715c9e23959022C2416C71867F5a6E80",
  ethereumBridgeAddress: process.env.VITALS_ETHEREUM_BRIDGE_ADDRESS || "0xE7eD69b852fd2a1406080B26A37e8E04e7dA4caE"
};

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function rawBig(value: string | number | bigint | undefined | null): bigint {
  if (value === undefined || value === null || value === "") return 0n;
  return BigInt(String(value));
}

function signedRaw(value: bigint): string {
  return value.toString();
}

function absBig(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function routeId(srcChainId: number, dstChainId: number, asset: string): string {
  return `octra-${srcChainId}:ethereum-${dstChainId}:${asset.toLowerCase()}`;
}

export function conservationHealth(input: {
  maxRaw: string;
  issuedRaw: string;
  encryptedRaw: string;
  burnedRaw: string;
  lockedRaw: string;
  wrappedRaw: string;
  unclaimedRaw: string;
  vaultRaw: string;
  expectedWoctDecimals: number;
  actualWoctDecimals: number;
  octraEpoch: number;
  relayerFinalizedEpoch: number;
  recoveryScannedEpoch: number;
  ethereumBlock: string;
}): NonNullable<SnapshotPayload["health"]> {
  const max = rawBig(input.maxRaw);
  const issued = rawBig(input.issuedRaw);
  const encrypted = rawBig(input.encryptedRaw);
  const burned = rawBig(input.burnedRaw);
  const locked = rawBig(input.lockedRaw);
  const wrapped = rawBig(input.wrappedRaw);
  const unclaimed = rawBig(input.unclaimedRaw);
  const vault = rawBig(input.vaultRaw);
  const capRemaining = max - issued;
  const capBurnMismatch = capRemaining - burned;
  const encryptedMinusIssued = encrypted - issued;
  const bridgeClaimBalance = locked - wrapped - unclaimed;
  const bridgeClaimOverage = wrapped + unclaimed - locked;
  const vaultSurplus = vault - locked;
  const flags: string[] = [];
  if (issued > max) flags.push("issued_exceeds_max");
  if (encrypted > issued) flags.push("encrypted_exceeds_issued");
  if (capBurnMismatch !== 0n) flags.push("cap_remaining_differs_from_burned");
  if (bridgeClaimOverage > 0n) flags.push("bridge_claims_exceed_locked");
  if (vaultSurplus < 0n) flags.push("vault_balance_below_locked");
  if (input.actualWoctDecimals !== input.expectedWoctDecimals) flags.push("woct_decimals_mismatch");
  const redFlags = new Set([
    "issued_exceeds_max",
    "encrypted_exceeds_issued",
    "cap_remaining_differs_from_burned",
    "bridge_claims_exceed_locked",
    "vault_balance_below_locked",
    "woct_decimals_mismatch"
  ]);
  const status = flags.some((flag) => redFlags.has(flag))
    ? "red"
    : flags.length
      ? "yellow"
      : "green";
  const flaggedDeltas: bigint[] = [];
  if (issued > max) flaggedDeltas.push(capRemaining);
  if (encrypted > issued) flaggedDeltas.push(encryptedMinusIssued);
  if (capBurnMismatch !== 0n) flaggedDeltas.push(capBurnMismatch);
  if (bridgeClaimOverage > 0n) flaggedDeltas.push(bridgeClaimOverage);
  if (vaultSurplus < 0n) flaggedDeltas.push(vaultSurplus);
  const largestAbsDelta = flaggedDeltas.reduce((largest, value) => absBig(value) > largest ? absBig(value) : largest, 0n);
  return {
    conservation: {
      status,
      ok: flags.length === 0,
      flags,
      largest_abs_delta_raw: signedRaw(largestAbsDelta),
      required_inputs: {
        burned_rpc: true,
        woct_decimals_verified: input.actualWoctDecimals === input.expectedWoctDecimals
      },
      units: {
        expected_woct_decimals: input.expectedWoctDecimals,
        actual_woct_decimals: input.actualWoctDecimals
      },
      clocks: {
        octra_epoch: input.octraEpoch,
        relayer_finalized_epoch: input.relayerFinalizedEpoch,
        recovery_scanned_epoch: input.recoveryScannedEpoch,
        relayer_lag_epochs: input.octraEpoch - input.relayerFinalizedEpoch,
        recovery_lag_epochs: input.octraEpoch - input.recoveryScannedEpoch,
        ethereum_block: input.ethereumBlock
      },
      deltas: {
        cap_remaining_raw: signedRaw(capRemaining),
        cap_burn_mismatch_raw: signedRaw(capBurnMismatch),
        encrypted_minus_issued_raw: signedRaw(encryptedMinusIssued),
        bridge_residual_raw: signedRaw(bridgeClaimBalance),
        bridge_claim_balance_raw: signedRaw(bridgeClaimBalance),
        bridge_claim_overage_raw: signedRaw(bridgeClaimOverage),
        vault_surplus_raw: signedRaw(vaultSurplus)
      }
    }
  };
}

function jsonRpc(id: string | number, method: string, params: unknown[] = []): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, params };
}

function sourceUrls(configured: string | undefined, fallback: string): string[] {
  const urls = (configured || fallback)
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean)
    .map((url) => validateEvidenceSourceUrl(url));
  return Array.from(new Set(urls));
}

function positiveIntegerEnv(name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const configured = process.env[name];
  const parsed = configured !== undefined && configured !== "" ? Number(configured) : fallback;
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`${name} must be a positive integer no greater than ${max}`);
  }
  return parsed;
}

function publicEvidenceHosts(): Set<string> {
  const configured = (process.env.VITALS_PUBLIC_EVIDENCE_HOSTS || "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...DEFAULT_PUBLIC_EVIDENCE_HOSTS, ...configured]);
}

function localEvidenceSourcesAllowed(): boolean {
  return process.env.VITALS_ALLOW_LOCAL_EVIDENCE_SOURCES === "1";
}

function localHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]";
}

export function validateEvidenceSourceUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("evidence source URL is invalid");
  }
  const host = parsed.hostname.toLowerCase();
  const local = localHost(host);
  if (local && !localEvidenceSourcesAllowed()) {
    throw new Error("local evidence source URLs are disabled");
  }
  if (parsed.protocol !== "https:" && !(local && localEvidenceSourcesAllowed())) {
    throw new Error(`evidence source URL must use https: ${host}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("evidence source URL must not contain credentials");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("evidence source URL must not contain query strings or fragments");
  }
  if (!local && !publicEvidenceHosts().has(host)) {
    throw new Error(`evidence source host is not allowlisted for public raw evidence: ${host}`);
  }
  return parsed.toString();
}

function assertJsonRpcResult<T = any>(result: JsonRpcRow | undefined, label: string): T {
  if (!result || result.error) {
    const detail = String(JSON.stringify(result && result.error ? result.error : result) ?? "")
      .replace(/[\x00-\x1f\x7f]/g, " ")
      .slice(0, 240);
    throw new Error(`${label} failed: ${detail}`);
  }
  return result.result as T;
}

function observationProviderMinimum(kind: "OCTRA" | "ETH", available: number): number {
  const name = `VITALS_MIN_${kind}_OBSERVATION_PROVIDERS`;
  const fallback = /^(prod|production)$/i.test(process.env.VITALS_GATEWAY_ROLE || "") ? 2 : 1;
  const value = Number(process.env[name] || process.env.VITALS_MIN_OBSERVATION_PROVIDERS || fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  if (available < value) throw new Error(`${kind} observation requires ${value} configured providers; got ${available}`);
  return value;
}

function requiredSafeInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return parsed;
}

function requiredUnsignedRaw(value: unknown, label: string): string {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text)) throw new Error(`${label} must be unsigned decimal digits`);
  return BigInt(text).toString();
}

function requiredText(value: unknown, label: string, maxLength = 256): string {
  if (typeof value !== "string" || !value || value.length > maxLength || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${label} must be bounded printable text`);
  }
  return value;
}

function parseEthUintHex(hex: string, label: string): bigint {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`${label} returned invalid hex uint: ${hex}`);
  }
  return BigInt(hex || "0x0");
}

export function parseErc20Decimals(hex: string): number {
  const value = parseEthUintHex(hex, "ERC-20 decimals");
  if (value < 0n || value > 255n) throw new Error(`ERC-20 decimals out of range: ${value.toString()}`);
  return Number(value);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url: string, options: RequestInit = {}, attempts = 2): Promise<string> {
  const timeoutMs = positiveIntegerEnv("VITALS_FETCH_TIMEOUT_MS", 15_000, 300_000);
  const maxBytes = positiveIntegerEnv("VITALS_RAW_EVIDENCE_MAX_BODY_BYTES", 5_000_000, 64 * 1024 * 1024);
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new Error("source fetch attempts must be an integer from 1 to 10");
  }
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const text = await responseTextWithLimit(response, maxBytes, url);
      if (!response.ok) {
        throw new Error(`${url} returned ${response.status}: ${text.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 240)}`);
      }
      return text;
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= attempts) break;
      await sleep(400 * (attempt + 1));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function responseTextWithLimit(response: Response, maxBytes: number, url: string): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error(`${url} returned ${contentLength} bytes, above VITALS_RAW_EVIDENCE_MAX_BODY_BYTES=${maxBytes}`);
  }
  if (!response.body) {
    const text = await response.text();
    const bytes = Buffer.byteLength(text);
    if (bytes > maxBytes) {
      throw new Error(`${url} returned ${bytes} bytes, above VITALS_RAW_EVIDENCE_MAX_BODY_BYTES=${maxBytes}`);
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`${url} returned more than VITALS_RAW_EVIDENCE_MAX_BODY_BYTES=${maxBytes}`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function fetchTextFromAny(
  urls: string[],
  options: RequestInit = {},
  label = "source fetch"
): Promise<{ url: string; responseText: string }> {
  const attempts = positiveIntegerEnv("VITALS_SOURCE_FETCH_ATTEMPTS", 2, 10);
  const errors: string[] = [];
  for (const url of urls) {
    try {
      return {
        url,
        responseText: await fetchText(url, options, attempts)
      };
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`${label} failed across ${urls.length} provider(s): ${errors.join(" | ")}`);
}

interface EvidenceEntryInput {
  id: string;
  kind: string;
  url: string;
  method: string;
  request?: unknown;
  responseText: string;
  observedAt: string;
  epoch?: number | string | null;
  blockNumber?: string | null;
}

function evidenceEntry({ id, kind, url, method, request, responseText, observedAt, epoch, blockNumber }: EvidenceEntryInput): EvidenceEntry {
  return {
    id,
    kind,
    url,
    method,
    request_hash: request ? requestHash(request) : null,
    response_hash: responseHash(responseText),
    observed_at: observedAt,
    epoch: epoch ?? null,
    block_number: blockNumber ?? null,
    parser_version: PARSER_VERSION
  };
}

function rawEvidence(entry: EvidenceEntry, body: string, request?: unknown, contentType = "application/json"): RawEvidenceEntry {
  return {
    id: entry.id,
    kind: entry.kind,
    url: entry.url,
    method: entry.method,
    request_hash: entry.request_hash,
    response_hash: entry.response_hash,
    request,
    body,
    content_type: contentType,
    observed_at: entry.observed_at,
    epoch: entry.epoch,
    block_number: entry.block_number
  };
}

interface OctraStatus {
  epoch: number;
  state_root: string;
  txid_hi: string;
  network_version: string;
  validator: string;
  timestamp: string | number;
}

function validatedOctraStatus(value: OctraStatus, label: string): OctraStatus {
  return {
    epoch: requiredSafeInteger(value?.epoch, `${label}.epoch`),
    state_root: requiredText(value?.state_root, `${label}.state_root`),
    txid_hi: requiredText(value?.txid_hi, `${label}.txid_hi`),
    network_version: requiredText(value?.network_version, `${label}.network_version`),
    validator: requiredText(value?.validator, `${label}.validator`),
    timestamp: typeof value?.timestamp === "number"
      ? requiredSafeInteger(value.timestamp, `${label}.timestamp`)
      : requiredText(value?.timestamp, `${label}.timestamp`)
  };
}

function octraCriticalView(byId: Record<string, JsonRpcRow>, status: OctraStatus): Record<string, unknown> {
  const supply = assertJsonRpcResult<any>(byId.supply, "octra_supply");
  const vault = assertJsonRpcResult<any>(byId.vault, "octra_balance");
  const locked = assertJsonRpcResult<any>(byId.locked, "octra_contractStorage total_locked");
  const unlocked = assertJsonRpcResult<any>(byId.unlocked, "octra_contractStorage total_unlocked");
  const locks = assertJsonRpcResult<any>(byId.locks, "octra_contractStorage lock_nonce");
  const unlocks = assertJsonRpcResult<any>(byId.unlocks, "octra_contractStorage unlock_count");
  return {
    status,
    supply: {
      max_supply_raw: requiredUnsignedRaw(supply.max_supply_raw, "octra_supply.max_supply_raw"),
      total_supply_raw: requiredUnsignedRaw(supply.total_supply_raw, "octra_supply.total_supply_raw"),
      encrypted_supply_raw: requiredUnsignedRaw(supply.encrypted_supply_raw, "octra_supply.encrypted_supply_raw"),
      burned: supply.burned === undefined ? null : String(supply.burned),
      burned_raw: supply.burned_raw === undefined ? null : requiredUnsignedRaw(supply.burned_raw, "octra_supply.burned_raw")
    },
    vault_balance_raw: requiredUnsignedRaw(vault.balance_raw, "octra_balance.balance_raw"),
    total_locked: requiredUnsignedRaw(locked.value, "total_locked.value"),
    total_unlocked: requiredUnsignedRaw(unlocked.value, "total_unlocked.value"),
    lock_nonce: requiredUnsignedRaw(locks.value, "lock_nonce.value"),
    unlock_count: requiredUnsignedRaw(unlocks.value, "unlock_count.value")
  };
}

async function fetchOctraBatchFromUrl(url: string, observedAt: string): Promise<{
  byId: Record<string, JsonRpcRow>;
  status: OctraStatus;
  critical: Record<string, unknown>;
  evidence: EvidenceEntry[];
  rawEvidence: RawEvidenceEntry[];
}> {
  const request = [
    jsonRpc("status", "node_status"),
    jsonRpc("supply", "octra_supply"),
    jsonRpc("vault", "octra_balance", [ROUTE_CONFIG.octraVaultAddress]),
    jsonRpc("locked", "octra_contractStorage", [ROUTE_CONFIG.octraVaultAddress, "total_locked"]),
    jsonRpc("unlocked", "octra_contractStorage", [ROUTE_CONFIG.octraVaultAddress, "total_unlocked"]),
    jsonRpc("locks", "octra_contractStorage", [ROUTE_CONFIG.octraVaultAddress, "lock_nonce"]),
    jsonRpc("unlocks", "octra_contractStorage", [ROUTE_CONFIG.octraVaultAddress, "unlock_count"])
  ];
  const responseText = await fetchText(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "octra-vitals/v0"
    },
    body: JSON.stringify(request)
  }, positiveIntegerEnv("VITALS_SOURCE_FETCH_ATTEMPTS", 2, 10));
  const rows = JSON.parse(responseText) as JsonRpcRow[];
  if (!Array.isArray(rows)) throw new Error("Octra batch response must be an array");
  const byId = Object.fromEntries(rows.map((row) => [String(row.id), row]));
  const status = validatedOctraStatus(assertJsonRpcResult<OctraStatus>(byId.status, "node_status"), "node_status");
  const fenceRequest = jsonRpc("status_after", "node_status");
  const fenceText = await fetchText(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "octra-vitals/v0" },
    body: JSON.stringify(fenceRequest)
  }, positiveIntegerEnv("VITALS_SOURCE_FETCH_ATTEMPTS", 2, 10));
  const statusAfter = validatedOctraStatus(
    assertJsonRpcResult<OctraStatus>(JSON.parse(fenceText) as JsonRpcRow, "node_status fence"),
    "node_status_after"
  );
  if (statusAfter.epoch !== status.epoch || statusAfter.state_root !== status.state_root || statusAfter.txid_hi !== status.txid_hi) {
    throw new Error(`Octra state advanced during fenced observation from ${url}`);
  }
  const batchEvidence = evidenceEntry({
    id: "octra.batch",
    kind: "octra_rpc",
    url,
    method: "batch:node_status,octra_supply,octra_balance,octra_contractStorage",
    request,
    responseText,
    observedAt,
    epoch: status.epoch
  });
  const fenceEvidence = evidenceEntry({
    id: "octra.status_after",
    kind: "octra_rpc",
    url,
    method: "node_status:fence_after",
    request: fenceRequest,
    responseText: fenceText,
    observedAt,
    epoch: statusAfter.epoch
  });
  return {
    byId,
    status,
    critical: octraCriticalView(byId, status),
    evidence: [batchEvidence, fenceEvidence],
    rawEvidence: [rawEvidence(batchEvidence, responseText, request), rawEvidence(fenceEvidence, fenceText, fenceRequest)]
  };
}

async function fetchOctraBatch(observedAt: string): Promise<{
  byId: Record<string, JsonRpcRow>;
  status: OctraStatus;
  evidence: EvidenceEntry[];
  rawEvidence: RawEvidenceEntry[];
}> {
  const minimum = observationProviderMinimum("OCTRA", OCTRA_RPC_URLS.length);
  const settled = await Promise.allSettled(OCTRA_RPC_URLS.map((url) => fetchOctraBatchFromUrl(url, observedAt)));
  const successful = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  if (successful.length < minimum) {
    const errors = settled.flatMap((result, index) => result.status === "rejected"
      ? [`${OCTRA_RPC_URLS[index]}: ${String(result.reason?.message || result.reason)}`]
      : []);
    throw new Error(`Octra observation quorum failed: ${successful.length}/${minimum}; ${errors.join(" | ")}`);
  }
  const primary = successful[0];
  if (!primary) throw new Error("Octra observation returned no successful provider");
  for (const candidate of successful.slice(1)) {
    if (canonicalJson(candidate.critical) !== canonicalJson(primary.critical)) {
      throw new Error("Octra observation providers disagreed on fenced critical state");
    }
  }
  const normalized = successful.map((value, providerIndex) => {
    const suffix = providerIndex === 0 ? "" : `.provider_${providerIndex + 1}`;
    return {
      ...value,
      evidence: value.evidence.map((entry) => ({ ...entry, id: `${entry.id}${suffix}` })),
      rawEvidence: value.rawEvidence.map((entry) => ({ ...entry, id: `${entry.id}${suffix}` }))
    };
  });
  return {
    byId: primary.byId,
    status: primary.status,
    evidence: normalized.flatMap((value) => value.evidence),
    rawEvidence: normalized.flatMap((value) => value.rawEvidence)
  };
}

interface RelayerBridgeStatus {
  latest_finalized_epoch: number;
  mode: string;
  bridge_vault_addr?: string;
  src_chain_id?: number;
  dst_chain_id?: number;
  src_bridge_id?: string;
  dst_bridge_id?: string;
  token_id?: string;
  validator_set_hash?: string;
}

async function fetchRelayerBridgeStatus(observedAt: string): Promise<{ result: RelayerBridgeStatus; evidence: EvidenceEntry; request: JsonRpcRequest; responseText: string }> {
  const request = jsonRpc(1, "bridgeStatus");
  const { url, responseText } = await fetchTextFromAny(RELAYER_URLS, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "octra-vitals/v0"
    },
    body: JSON.stringify(request)
  }, "relayer bridgeStatus");
  const result = assertJsonRpcResult<RelayerBridgeStatus>(JSON.parse(responseText) as JsonRpcRow, "relayer bridgeStatus");
  result.latest_finalized_epoch = requiredSafeInteger(result.latest_finalized_epoch, "relayer.latest_finalized_epoch");
  result.mode = requiredText(result.mode, "relayer.mode", 64);
  if (result.src_chain_id !== undefined) result.src_chain_id = requiredSafeInteger(result.src_chain_id, "relayer.src_chain_id");
  if (result.dst_chain_id !== undefined) result.dst_chain_id = requiredSafeInteger(result.dst_chain_id, "relayer.dst_chain_id");
  for (const field of ["bridge_vault_addr", "src_bridge_id", "dst_bridge_id", "token_id", "validator_set_hash"] as const) {
    if (result[field] !== undefined) result[field] = requiredText(result[field], `relayer.${field}`);
  }
  const evidence = evidenceEntry({
    id: "relayer.bridge_status",
    kind: "relayer_json_rpc",
    url,
    method: "bridgeStatus",
    request,
    responseText,
    observedAt,
    epoch: result.latest_finalized_epoch
  });
  return { result, evidence, request, responseText };
}

function assertRouteMetadata(result: RelayerBridgeStatus): void {
  if (result.bridge_vault_addr && result.bridge_vault_addr !== ROUTE_CONFIG.octraVaultAddress) {
    throw new Error(`relayer bridge_vault_addr drift: expected ${ROUTE_CONFIG.octraVaultAddress}, got ${result.bridge_vault_addr}`);
  }
  if (result.src_chain_id !== undefined && result.src_chain_id !== ROUTE_CONFIG.octraChainId) {
    throw new Error(`relayer src_chain_id drift: expected ${ROUTE_CONFIG.octraChainId}, got ${result.src_chain_id}`);
  }
  if (result.dst_chain_id !== undefined && result.dst_chain_id !== ROUTE_CONFIG.ethereumChainId) {
    throw new Error(`relayer dst_chain_id drift: expected ${ROUTE_CONFIG.ethereumChainId}, got ${result.dst_chain_id}`);
  }
}

interface RelayerRecoveryEntry {
  amount_raw: string;
}

interface RelayerRecovery {
  by_recipient?: Record<string, RelayerRecoveryEntry[]>;
  latest_scanned_epoch: number;
  updated_at: number | string | null;
}

async function fetchRelayerRecovery(observedAt: string): Promise<{ result: RelayerRecovery; unclaimedOctRaw: string; evidence: EvidenceEntry; request: null; responseText: string }> {
  const urls = RELAYER_URLS.map((url) => `${url.replace(/\/$/, "")}/recovery.json`);
  const { url, responseText } = await fetchTextFromAny(urls, {
    headers: {
      Accept: "application/json",
      "User-Agent": "octra-vitals/v0"
    }
  }, "relayer recovery");
  const result = JSON.parse(responseText) as RelayerRecovery;
  result.latest_scanned_epoch = requiredSafeInteger(result.latest_scanned_epoch, "recovery.latest_scanned_epoch");
  if (result.updated_at !== null && result.updated_at !== undefined) {
    result.updated_at = typeof result.updated_at === "number"
      ? requiredSafeInteger(result.updated_at, "recovery.updated_at")
      : requiredText(result.updated_at, "recovery.updated_at", 64);
  }
  if (result.by_recipient !== undefined && (!result.by_recipient || typeof result.by_recipient !== "object" || Array.isArray(result.by_recipient))) {
    throw new Error("recovery.by_recipient must be an object");
  }
  const amounts: string[] = [];
  for (const [recipient, entries] of Object.entries(result.by_recipient || {})) {
    requiredText(recipient, "recovery recipient", 128);
    if (!Array.isArray(entries)) throw new Error(`relayer recovery entry list for ${recipient} is not an array`);
    for (const [index, entry] of entries.entries()) {
      const amount = entry?.amount_raw;
      if (typeof amount !== "string" || !/^\d+$/.test(amount)) {
        throw new Error(`relayer recovery amount_raw missing or invalid at ${recipient}[${index}]`);
      }
      amounts.push(amount);
    }
  }
  const evidence = evidenceEntry({
    id: "relayer.recovery",
    kind: "https_json",
    url,
    method: "GET",
    responseText,
    observedAt,
    epoch: result.latest_scanned_epoch
  });
  return { result, unclaimedOctRaw: sumRaw(amounts), evidence, request: null, responseText };
}

async function fetchEthereumWoctFromUrl(ethRpcUrl: string, observedAt: string): Promise<{ blockNumber: string; blockHash: string; woctSupplyRaw: string; woctDecimals: number; evidence: EvidenceEntry[]; rawEvidence: RawEvidenceEntry[]; responseText: string }> {
  const blockDetailRequest = jsonRpc("block", "eth_getBlockByNumber", ["latest", false]);
  const blockDetailText = await fetchText(ethRpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "octra-vitals/v0" },
    body: JSON.stringify(blockDetailRequest)
  });
  const block = assertJsonRpcResult<{ hash: string; number: string }>(JSON.parse(blockDetailText) as JsonRpcRow, "eth_getBlockByNumber");
  if (!/^0x[0-9a-f]+$/i.test(block.number || "")) throw new Error("Ethereum block number is invalid");
  if (!/^0x[0-9a-f]{64}$/i.test(block.hash || "")) throw new Error("Ethereum block hash is invalid");
  const blockNumber = block.number.toLowerCase();
  const blockHash = block.hash.toLowerCase();
  const blockSelector = { blockHash, requireCanonical: true };

  const callAtBlock = async (id: string, data: string, label: string): Promise<{ request: JsonRpcRequest; text: string; result: string }> => {
    const call = { to: ROUTE_CONFIG.ethereumWoctAddress, data };
    let request = jsonRpc(id, "eth_call", [call, blockSelector]);
    let text = await fetchText(ethRpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "octra-vitals/v0" },
      body: JSON.stringify(request)
    });
    let row = JSON.parse(text) as JsonRpcRow;
    if (row.error) {
      request = jsonRpc(id, "eth_call", [call, blockNumber]);
      text = await fetchText(ethRpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "octra-vitals/v0" },
        body: JSON.stringify(request)
      });
      row = JSON.parse(text) as JsonRpcRow;
    }
    return { request, text, result: assertJsonRpcResult<string>(row, label) };
  };
  const [totalSupplyCall, decimalsCall] = await Promise.all([
    callAtBlock("woct_supply", "0x18160ddd", "wOCT totalSupply"),
    callAtBlock("woct_decimals", "0x313ce567", "wOCT decimals")
  ]);
  const totalSupplyRequest = totalSupplyCall.request;
  const totalSupplyText = totalSupplyCall.text;
  const totalSupplyHex = totalSupplyCall.result;
  const decimalsRequest = decimalsCall.request;
  const decimalsText = decimalsCall.text;
  const decimalsHex = decimalsCall.result;
  const woctDecimals = parseErc20Decimals(decimalsHex);

  const blockFenceRequest = jsonRpc("block_after", "eth_getBlockByNumber", [blockNumber, false]);
  const blockFenceText = await fetchText(ethRpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "octra-vitals/v0" },
    body: JSON.stringify(blockFenceRequest)
  });
  const blockAfter = assertJsonRpcResult<{ hash: string; number: string }>(JSON.parse(blockFenceText) as JsonRpcRow, "eth_getBlockByNumber fence");
  if (String(blockAfter.number || "").toLowerCase() !== blockNumber || String(blockAfter.hash || "").toLowerCase() !== blockHash) {
    throw new Error(`Ethereum block changed during fenced observation from ${ethRpcUrl}`);
  }

  const blockEvidence = evidenceEntry({
    id: "ethereum.block",
    kind: "ethereum_rpc",
    url: ethRpcUrl,
    method: "eth_getBlockByNumber:latest",
    request: blockDetailRequest,
    responseText: blockDetailText,
    observedAt,
    blockNumber
  });
  const totalSupplyEvidence = evidenceEntry({
    id: "ethereum.woct_total_supply",
    kind: "ethereum_rpc",
    url: ethRpcUrl,
    method: "eth_call",
    request: totalSupplyRequest,
    responseText: totalSupplyText,
    observedAt,
    blockNumber
  });
  const decimalsEvidence = evidenceEntry({
    id: "ethereum.woct_decimals",
    kind: "ethereum_rpc",
    url: ethRpcUrl,
    method: "eth_call",
    request: decimalsRequest,
    responseText: decimalsText,
    observedAt,
    blockNumber
  });
  const blockFenceEvidence = evidenceEntry({
    id: "ethereum.block_after",
    kind: "ethereum_rpc",
    url: ethRpcUrl,
    method: "eth_getBlockByNumber:fence_after",
    request: blockFenceRequest,
    responseText: blockFenceText,
    observedAt,
    blockNumber
  });
  const evidence = [blockEvidence, totalSupplyEvidence, decimalsEvidence, blockFenceEvidence];

  return {
    blockNumber,
    blockHash,
    woctSupplyRaw: hexToRawString(totalSupplyHex),
    woctDecimals,
    evidence,
    rawEvidence: [
      rawEvidence(blockEvidence, blockDetailText, blockDetailRequest),
      rawEvidence(totalSupplyEvidence, totalSupplyText, totalSupplyRequest),
      rawEvidence(decimalsEvidence, decimalsText, decimalsRequest),
      rawEvidence(blockFenceEvidence, blockFenceText, blockFenceRequest)
    ],
    responseText: totalSupplyText
  };
}

async function fetchEthereumWoct(observedAt: string): Promise<{ blockNumber: string; blockHash: string; woctSupplyRaw: string; woctDecimals: number; evidence: EvidenceEntry[]; rawEvidence: RawEvidenceEntry[]; responseText: string }> {
  const minimum = observationProviderMinimum("ETH", ETH_RPC_URLS.length);
  const settled = await Promise.allSettled(ETH_RPC_URLS.map((url) => fetchEthereumWoctFromUrl(url, observedAt)));
  const successful = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  if (successful.length < minimum) {
    const errors = settled.flatMap((result, index) => result.status === "rejected"
      ? [`${ETH_RPC_URLS[index]}: ${String(result.reason?.message || result.reason)}`]
      : []);
    throw new Error(`Ethereum observation quorum failed: ${successful.length}/${minimum}; ${errors.join(" | ")}`);
  }
  const primary = successful[0];
  if (!primary) throw new Error("Ethereum observation returned no successful provider");
  for (const candidate of successful.slice(1)) {
    if (
      candidate.blockNumber !== primary.blockNumber ||
      candidate.blockHash !== primary.blockHash ||
      candidate.woctSupplyRaw !== primary.woctSupplyRaw ||
      candidate.woctDecimals !== primary.woctDecimals
    ) throw new Error("Ethereum observation providers disagreed on pinned wOCT state");
  }
  const normalized = successful.map((value, providerIndex) => {
    const suffix = providerIndex === 0 ? "" : `.provider_${providerIndex + 1}`;
    return {
      ...value,
      evidence: value.evidence.map((entry) => ({ ...entry, id: `${entry.id}${suffix}` })),
      rawEvidence: value.rawEvidence.map((entry) => ({ ...entry, id: `${entry.id}${suffix}` }))
    };
  });
  return {
    ...primary,
    evidence: normalized.flatMap((value) => value.evidence),
    rawEvidence: normalized.flatMap((value) => value.rawEvidence)
  };
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

interface BuildLiveSnapshotOptions {
  observedAt?: string;
}

export async function buildLiveSnapshot(options: BuildLiveSnapshotOptions = {}): Promise<SnapshotArtifact> {
  const observedAt = options.observedAt || isoNow();
  assertObservationTimeSafe(observedAt, { maxFutureSkewMs: configuredObservationFutureSkewMs() });
  const [octra, bridgeStatus, recovery, ethereum] = await Promise.all([
    fetchOctraBatch(observedAt),
    fetchRelayerBridgeStatus(observedAt),
    fetchRelayerRecovery(observedAt),
    fetchEthereumWoct(observedAt)
  ]);

  const byId = octra.byId;
  const status = octra.status;
  assertRouteMetadata(bridgeStatus.result);
  const supply = assertJsonRpcResult<{ max_supply_raw: string; total_supply_raw: string; encrypted_supply_raw: string; burned?: string; burned_raw?: string }>(byId.supply, "octra_supply");
  const vault = assertJsonRpcResult<{ balance_raw: string }>(byId.vault, "octra_balance");
  const locked = assertJsonRpcResult<{ value: string }>(byId.locked, "octra_contractStorage total_locked");
  const unlocked = assertJsonRpcResult<{ value: string }>(byId.unlocked, "octra_contractStorage total_unlocked");
  const locks = assertJsonRpcResult<{ value: string }>(byId.locks, "octra_contractStorage lock_nonce");
  const unlocks = assertJsonRpcResult<{ value: string }>(byId.unlocks, "octra_contractStorage unlock_count");
  const relayerMeta: SnapshotPayload["relayer"] = {
    latest_finalized_epoch: bridgeStatus.result.latest_finalized_epoch,
    latest_scanned_epoch: recovery.result.latest_scanned_epoch,
    recovery_updated_at: recovery.result.updated_at,
    mode: bridgeStatus.result.mode
  };
  if (bridgeStatus.result.src_chain_id !== undefined) relayerMeta.src_chain_id = bridgeStatus.result.src_chain_id;
  if (bridgeStatus.result.dst_chain_id !== undefined) relayerMeta.dst_chain_id = bridgeStatus.result.dst_chain_id;
  if (bridgeStatus.result.src_bridge_id) relayerMeta.src_bridge_id = bridgeStatus.result.src_bridge_id;
  if (bridgeStatus.result.dst_bridge_id) relayerMeta.dst_bridge_id = bridgeStatus.result.dst_bridge_id;
  if (bridgeStatus.result.token_id) relayerMeta.token_id = bridgeStatus.result.token_id;
  if (bridgeStatus.result.validator_set_hash) relayerMeta.validator_set_hash = bridgeStatus.result.validator_set_hash;
  const hasBurnedDecimal = supply.burned !== undefined && supply.burned !== null && String(supply.burned).trim() !== "";
  const hasBurnedRaw = supply.burned_raw !== undefined && supply.burned_raw !== null && String(supply.burned_raw).trim() !== "";
  if (!hasBurnedDecimal && !hasBurnedRaw) {
    throw new Error("octra_supply did not return required burned field");
  }
  const burnedRaw = hasBurnedRaw
    ? String(BigInt(String(supply.burned_raw).trim()))
    : decimalToRawString(String(supply.burned));
  const expectedBurnedRaw = (BigInt(supply.max_supply_raw) - BigInt(supply.total_supply_raw)).toString();
  if (burnedRaw !== expectedBurnedRaw) {
    throw new Error(`octra_supply burned unit mismatch: parsed ${burnedRaw}, expected ${expectedBurnedRaw}`);
  }
  const expectedWoctDecimals = Number(process.env.VITALS_EXPECTED_WOCT_DECIMALS || 6);
  if (!Number.isInteger(expectedWoctDecimals) || expectedWoctDecimals < 0 || expectedWoctDecimals > 255) {
    throw new Error(`invalid VITALS_EXPECTED_WOCT_DECIMALS: ${process.env.VITALS_EXPECTED_WOCT_DECIMALS}`);
  }
  if (ethereum.woctDecimals !== expectedWoctDecimals) {
    throw new Error(`wOCT decimals mismatch: expected ${expectedWoctDecimals}, got ${ethereum.woctDecimals}`);
  }
  const srcChainId = bridgeStatus.result.src_chain_id || ROUTE_CONFIG.octraChainId;
  const dstChainId = bridgeStatus.result.dst_chain_id || ROUTE_CONFIG.ethereumChainId;

  const payload: SnapshotPayload = {
    schema_version: PAYLOAD_SCHEMA_VERSION,
    units: {
      oct_decimals: 6,
      woct_decimals: ethereum.woctDecimals
    },
    octra: {
      epoch: status.epoch,
      state_root: status.state_root,
      txid_hi: status.txid_hi,
      network_version: status.network_version,
      validator: status.validator,
      timestamp: String(status.timestamp)
    },
    supply: {
      max_oct_raw: supply.max_supply_raw,
      issued_oct_raw: supply.total_supply_raw,
      encrypted_oct_raw: supply.encrypted_supply_raw,
      burned_oct_raw: burnedRaw,
      confirmed_burned_oct_raw: burnedRaw
    },
    bridge: {
      vault_address: bridgeStatus.result.bridge_vault_addr || ROUTE_CONFIG.octraVaultAddress,
      vault_balance_oct_raw: vault.balance_raw,
      total_locked_oct_raw: locked.value,
      total_unlocked_oct_raw: unlocked.value,
      lock_nonce: locks.value,
      unlock_count: unlocks.value,
      woct_supply_raw: ethereum.woctSupplyRaw,
      unclaimed_oct_raw: recovery.unclaimedOctRaw
    },
    ethereum: {
      chain_id: ROUTE_CONFIG.ethereumChainId,
      block_number: ethereum.blockNumber,
      block_hash: ethereum.blockHash,
      woct_address: ROUTE_CONFIG.ethereumWoctAddress,
      bridge_address: ROUTE_CONFIG.ethereumBridgeAddress
    },
    relayer: relayerMeta,
    routes: [
      {
        route_id: routeId(srcChainId, dstChainId, "woct"),
        src_chain: "octra",
        src_chain_id: srcChainId,
        dst_chain: "ethereum",
        dst_chain_id: dstChainId,
        asset: "wOCT",
        vault_address: bridgeStatus.result.bridge_vault_addr || ROUTE_CONFIG.octraVaultAddress,
        wrapped_address: ROUTE_CONFIG.ethereumWoctAddress,
        bridge_address: ROUTE_CONFIG.ethereumBridgeAddress,
        locked_raw: locked.value,
        wrapped_supply_raw: ethereum.woctSupplyRaw,
        unclaimed_raw: recovery.unclaimedOctRaw,
        source_ref_ids: [
          ...octra.evidence.map((entry) => entry.id),
          "relayer.bridge_status",
          "relayer.recovery",
          ...ethereum.evidence.map((entry) => entry.id)
        ]
      }
    ],
    health: conservationHealth({
      maxRaw: supply.max_supply_raw,
      issuedRaw: supply.total_supply_raw,
      encryptedRaw: supply.encrypted_supply_raw,
      burnedRaw,
      lockedRaw: locked.value,
      wrappedRaw: ethereum.woctSupplyRaw,
      unclaimedRaw: recovery.unclaimedOctRaw,
      vaultRaw: vault.balance_raw,
      expectedWoctDecimals,
      actualWoctDecimals: ethereum.woctDecimals,
      octraEpoch: status.epoch,
      relayerFinalizedEpoch: bridgeStatus.result.latest_finalized_epoch,
      recoveryScannedEpoch: recovery.result.latest_scanned_epoch,
      ethereumBlock: ethereum.blockNumber
    })
  };

  const evidence: EvidenceEntry[] = [
    ...octra.evidence,
    bridgeStatus.evidence,
    recovery.evidence,
    ...ethereum.evidence
  ];
  const rawEvidenceEntries: RawEvidenceEntry[] = [
    ...octra.rawEvidence,
    rawEvidence(bridgeStatus.evidence, bridgeStatus.responseText, bridgeStatus.request),
    rawEvidence(recovery.evidence, recovery.responseText, recovery.request),
    ...ethereum.rawEvidence
  ];
  const evidenceManifest: EvidenceManifest = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    observed_at: observedAt,
    parser_version: PARSER_VERSION,
    entries: evidence
  };
  const canonicalPayload = canonicalJson(payload);
  const canonicalEvidenceManifest = canonicalJson(evidenceManifest);
  const payloadHash = sha256Tagged(SNAPSHOT_HASH_DOMAIN, canonicalPayload);
  const evidenceManifestHash = sha256Tagged(EVIDENCE_HASH_DOMAIN, canonicalEvidenceManifest);

  const envelope: SnapshotEnvelope = {
    schema_version: ENVELOPE_SCHEMA_VERSION,
    snapshot_id: `vitals.${observedAt}`,
    observed_at: observedAt,
    payload_hash: payloadHash,
    evidence_manifest_hash: evidenceManifestHash,
    canonicalization: "jcs-rfc8785-or-equivalent-v1",
    payload,
    source_refs: sourceRefsFromEvidence(evidence),
    submitted_by: process.env.VITALS_OPERATOR_ADDRESS || ""
  };
  const canonicalSourceRefs = canonicalJson(envelope.source_refs);

  return {
    envelope,
    evidence_manifest: evidenceManifest,
    canonical_source_refs: canonicalSourceRefs,
    canonical_payload: canonicalPayload,
    canonical_evidence_manifest: canonicalEvidenceManifest,
    generated_at: isoNow(),
    raw_evidence: rawEvidenceEntries
  };
}

export async function writeSnapshotArtifacts(snapshot: SnapshotArtifact, outPath: string, evidenceDir?: string): Promise<void> {
  await mkdir(dirname(outPath), { recursive: true });
  const outputSnapshot = outPath.endsWith("app/latest_snapshot.sample.json") ? publicSnapshotArtifact(snapshot) : snapshot;
  await writeFileAtomic(outPath, `${JSON.stringify(outputSnapshot, null, 2)}\n`);
  if (evidenceDir) {
    await mkdir(evidenceDir, { recursive: true });
    await chmod(evidenceDir, 0o750).catch(() => undefined);
    const hash = snapshot.envelope.evidence_manifest_hash.replace(/^sha256:/, "");
    await writeFileAtomic(join(evidenceDir, `${hash}.json`), `${JSON.stringify(snapshot.evidence_manifest, null, 2)}\n`);
    if (snapshot.raw_evidence?.length) {
      const rawDir = join(evidenceDir, "raw");
      await mkdir(rawDir, { recursive: true });
      await chmod(rawDir, 0o750).catch(() => undefined);
      for (const raw of snapshot.raw_evidence) {
        const rawHash = raw.response_hash.replace(/^sha256:/, "").toLowerCase();
        await writeRawEvidenceAtomic(join(rawDir, `${rawHash}.json`), `${JSON.stringify({
          schema: "octra-vitals-raw-evidence-v0",
          ...raw
        }, null, 2)}\n`);
      }
    }
  }
}

async function writeFileAtomic(path: string, text: string): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(tmp, text, { mode: 0o640 });
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

async function writeRawEvidenceAtomic(path: string, text: string): Promise<void> {
  if (process.env.VITALS_RAW_EVIDENCE_COMPRESS === "0") {
    await writeFileAtomic(path, text);
    return;
  }
  const gzPath = `${path}.gz`;
  const tmp = join(dirname(gzPath), `.${basename(gzPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(tmp, gzipSync(Buffer.from(text)), { mode: 0o640 });
    await rename(tmp, gzPath);
    await unlink(path).catch(() => undefined);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

export function publicSnapshotArtifact(snapshot: SnapshotArtifact): SnapshotArtifact {
  const { raw_evidence: _rawEvidence, ...publicSnapshot } = snapshot;
  return publicSnapshot;
}
