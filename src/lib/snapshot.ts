import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { canonicalJson, requestHash, responseHash, sha256Tagged } from "./canonical-json.js";
import { octraObservationRpcUrl } from "./octra-rpc.js";
import { decimalToRawString, hexToRawString, sumRaw } from "./units.js";
import type { EvidenceEntry, EvidenceManifest, JsonRpcRequest, JsonRpcRow, RawEvidenceEntry, SnapshotArtifact, SnapshotEnvelope, SnapshotPayload, SourceRef } from "./types.js";

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
  octraChainId: Number(process.env.VITALS_OCTRA_CHAIN_ID || 7777),
  ethereumChainId: Number(process.env.VITALS_ETHEREUM_CHAIN_ID || 1),
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
    .filter(Boolean);
  return Array.from(new Set(urls));
}

function assertJsonRpcResult<T = any>(result: JsonRpcRow | undefined, label: string): T {
  if (!result || result.error) {
    throw new Error(`${label} failed: ${JSON.stringify(result && result.error ? result.error : result)}`);
  }
  return result.result as T;
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
  const timeoutMs = Number(process.env.VITALS_FETCH_TIMEOUT_MS || 15_000);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`${url} returned ${response.status}: ${text.slice(0, 240)}`);
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

async function fetchTextFromAny(
  urls: string[],
  options: RequestInit = {},
  label = "source fetch"
): Promise<{ url: string; responseText: string }> {
  const attempts = Number(process.env.VITALS_SOURCE_FETCH_ATTEMPTS || 2);
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

async function fetchOctraBatch(observedAt: string): Promise<{ byId: Record<string, JsonRpcRow>; status: OctraStatus; evidence: EvidenceEntry; request: JsonRpcRequest[]; responseText: string }> {
  const request = [
    jsonRpc("status", "node_status"),
    jsonRpc("supply", "octra_supply"),
    jsonRpc("vault", "octra_balance", [ROUTE_CONFIG.octraVaultAddress]),
    jsonRpc("locked", "octra_contractStorage", [ROUTE_CONFIG.octraVaultAddress, "total_locked"]),
    jsonRpc("unlocked", "octra_contractStorage", [ROUTE_CONFIG.octraVaultAddress, "total_unlocked"]),
    jsonRpc("locks", "octra_contractStorage", [ROUTE_CONFIG.octraVaultAddress, "lock_nonce"]),
    jsonRpc("unlocks", "octra_contractStorage", [ROUTE_CONFIG.octraVaultAddress, "unlock_count"])
  ];
  const { url, responseText } = await fetchTextFromAny(OCTRA_RPC_URLS, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "octra-vitals/v0"
    },
    body: JSON.stringify(request)
  }, "octra observation batch");
  const rows = JSON.parse(responseText) as JsonRpcRow[];
  const byId = Object.fromEntries(rows.map((row) => [String(row.id), row]));
  const status = assertJsonRpcResult<OctraStatus>(byId.status, "node_status");
  const evidence = evidenceEntry({
    id: "octra.batch",
    kind: "octra_rpc",
    url,
    method: "batch:node_status,octra_supply,octra_balance,octra_contractStorage",
    request,
    responseText,
    observedAt,
    epoch: status.epoch
  });
  return { byId, status, evidence, request, responseText };
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
  const amounts: string[] = [];
  for (const [recipient, entries] of Object.entries(result.by_recipient || {})) {
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
  if (!block.number) throw new Error("eth_getBlockByNumber latest did not return a block number");
  const blockNumber = block.number;

  const totalSupplyRequest = jsonRpc("woct_supply", "eth_call", [
    {
      to: ROUTE_CONFIG.ethereumWoctAddress,
      data: "0x18160ddd"
    },
    blockNumber
  ]);
  const totalSupplyText = await fetchText(ethRpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "octra-vitals/v0" },
    body: JSON.stringify(totalSupplyRequest)
  });
  const totalSupplyHex = assertJsonRpcResult<string>(JSON.parse(totalSupplyText) as JsonRpcRow, "wOCT totalSupply");
  const decimalsRequest = jsonRpc("woct_decimals", "eth_call", [
    {
      to: ROUTE_CONFIG.ethereumWoctAddress,
      data: "0x313ce567"
    },
    blockNumber
  ]);
  const decimalsText = await fetchText(ethRpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "octra-vitals/v0" },
    body: JSON.stringify(decimalsRequest)
  });
  const decimalsHex = assertJsonRpcResult<string>(JSON.parse(decimalsText) as JsonRpcRow, "wOCT decimals");
  const woctDecimals = parseErc20Decimals(decimalsHex);

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
  const evidence = [blockEvidence, totalSupplyEvidence, decimalsEvidence];

  return {
    blockNumber,
    blockHash: block.hash,
    woctSupplyRaw: hexToRawString(totalSupplyHex),
    woctDecimals,
    evidence,
    rawEvidence: [
      rawEvidence(blockEvidence, blockDetailText, blockDetailRequest),
      rawEvidence(totalSupplyEvidence, totalSupplyText, totalSupplyRequest),
      rawEvidence(decimalsEvidence, decimalsText, decimalsRequest)
    ],
    responseText: totalSupplyText
  };
}

async function fetchEthereumWoct(observedAt: string): Promise<{ blockNumber: string; blockHash: string; woctSupplyRaw: string; woctDecimals: number; evidence: EvidenceEntry[]; rawEvidence: RawEvidenceEntry[]; responseText: string }> {
  const errors: string[] = [];
  for (const url of ETH_RPC_URLS) {
    try {
      return await fetchEthereumWoctFromUrl(url, observedAt);
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`ethereum wOCT collection failed across ${ETH_RPC_URLS.length} provider(s): ${errors.join(" | ")}`);
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
        source_ref_ids: ["octra.batch", "relayer.bridge_status", "relayer.recovery", "ethereum.block", "ethereum.woct_total_supply", "ethereum.woct_decimals"]
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
    octra.evidence,
    bridgeStatus.evidence,
    recovery.evidence,
    ...ethereum.evidence
  ];
  const rawEvidenceEntries: RawEvidenceEntry[] = [
    rawEvidence(octra.evidence, octra.responseText, octra.request),
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
    const hash = snapshot.envelope.evidence_manifest_hash.replace(/^sha256:/, "");
    await writeFileAtomic(join(evidenceDir, `${hash}.json`), `${JSON.stringify(snapshot.evidence_manifest, null, 2)}\n`);
    if (snapshot.raw_evidence?.length) {
      const rawDir = join(evidenceDir, "raw");
      await mkdir(rawDir, { recursive: true });
      for (const raw of snapshot.raw_evidence) {
        const rawHash = raw.response_hash.replace(/^sha256:/, "").toLowerCase();
        await writeFileAtomic(join(rawDir, `${rawHash}.json`), `${JSON.stringify({
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
    await writeFile(tmp, text, { mode: 0o660 });
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

export function publicSnapshotArtifact(snapshot: SnapshotArtifact): SnapshotArtifact {
  const { raw_evidence: _rawEvidence, ...publicSnapshot } = snapshot;
  return publicSnapshot;
}
