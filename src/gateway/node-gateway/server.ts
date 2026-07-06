#!/usr/bin/env node
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { buildLiveSnapshot, publicSnapshotArtifact, writeSnapshotArtifacts } from "../../lib/snapshot.js";
import { FACT_LEDGER_MANIFEST } from "../../lib/aml-fact-ledger.js";
import { canonicalJson, responseHash, sha256Hex, sha256Tagged } from "../../lib/canonical-json.js";
import { HistoryTailAnchorError, assertHistoryTailWithinLag, configuredStateTarget, readCanonicalHistory as readCanonicalHistoryUncached, type HistoryReadOptions, type HistorySummaryAnchor, type HistoryTailAnchorVerification, type StateTarget } from "../../lib/canonical-history.js";
import { verifyCircleAssetIntegrity } from "../../lib/circle-asset-integrity.js";
import { circleProgramViewAtUrl, configuredProgrammedCircleId, stateTargetMode } from "../../lib/circle-program.js";
import { configuredProgramAddress, readLatestCircleProgramSnapshot, readLatestProgramSnapshot } from "../../lib/program-state.js";
import { circleInfoAtUrl, circleProgramInfoAtUrl, contractCall, contractReceipt, contractSource, octraProgramRpcUrls, octraRpc, octraRpcMetricsSnapshot, vmContract } from "../../lib/octra-rpc.js";
import { configuredTrafficRecorder } from "../../lib/traffic.js";
import { runtimeVitalsManifest, stableJson } from "../../lib/vitals-manifest.js";
import { HISTORY_API_SCHEMA, LEGACY_HISTORY_SCHEMA, emptyHistoryProof, filterHistorySnapshots, historyApiCoverage, historyApiRecommendedCapsuleLimit, parseHistoryApiRequest, verifiedHistoryProof, type HistoryApiRequest } from "../../lib/history-api.js";
import { labHistorySql, labSchema, labStatus, labTables, mirrorLabHistory } from "../../lib/lab-history.js";
import { octraSqliteConfig, octraSqliteReadOnlyQuery, publicLabQueryError } from "../../lib/octra-sqlite-client.js";
import { readSqliteHistoryReplica } from "../../lib/sqlite-history-replica.js";
import { decodeSummaryRow, type ProgramHistoryWindow } from "../../lib/summary-window.js";
import type { ProgramArtifacts, SnapshotArtifact } from "../../lib/types.js";

const root = resolve(new URL("../../..", import.meta.url).pathname);
const appDir = join(root, "app");
const dataDir = resolve(process.env.VITALS_DATA_DIR || join(root, "data"));
const evidenceDir = join(dataDir, "evidence");
const latestPath = join(dataDir, "latest_snapshot.json");
const latestSubmitReceiptPath = join(dataDir, "latest_submit_receipt.json");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4173);
const staleAfterMs = Number(process.env.VITALS_STALE_AFTER_MS || 20 * 60_000);
const latestReadTtlMs = Number(process.env.VITALS_LATEST_READ_TTL_MS || 60_000);
const historyReadTtlMs = Number(process.env.VITALS_HISTORY_READ_TTL_MS || 60 * 60_000);
const historyStaleWhileRefreshMs = Number(process.env.VITALS_HISTORY_STALE_WHILE_REFRESH_MS || 6 * 60 * 60_000);
const historyApiStaleWindows = new Set(
  (process.env.VITALS_HISTORY_API_STALE_WINDOWS || "7d,30d")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);
const historyPrewarmEnabled = process.env.VITALS_HISTORY_PREWARM_ENABLED !== "0";
const historyPrewarmMinIntervalMs = Number(process.env.VITALS_HISTORY_PREWARM_MIN_INTERVAL_MS || 15 * 60_000);
const historyPrewarmWindows = (process.env.VITALS_HISTORY_PREWARM_WINDOWS || "1h,1d,7d,30d")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const historyReplicaMaxLagSnapshots = clampedIntegerEnv("VITALS_HISTORY_REPLICA_MAX_LAG_SNAPSHOTS", 1, 0, 2);
type HistoryReadMode = "replica" | "canonical" | "cache_only";
type HistoryCacheSource = "sqlite" | "aml";
const historyReadMode = ((): HistoryReadMode => {
  const configured = (process.env.VITALS_HISTORY_READ_PATH || process.env.VITALS_HISTORY_READ_MODE || process.env.VITALS_HISTORY_READ_SOURCE || "replica").trim().toLowerCase();
  if (configured === "canonical" || configured === "aml") return "canonical";
  if (configured === "cache_only" || configured === "memory") return "cache_only";
  return "replica";
})();
const sqliteHistoryFallbackToAml = (process.env.VITALS_HISTORY_REPLICA_FALLBACK_TO_CANONICAL || process.env.VITALS_HISTORY_SQLITE_FALLBACK_TO_AML) !== "0";
const responseGzipEnabled = process.env.VITALS_RESPONSE_GZIP_ENABLED !== "0";
const responseGzipMinBytes = Number(process.env.VITALS_RESPONSE_GZIP_MIN_BYTES || 1024);
const labQueryMaxConcurrent = Math.max(1, Number(process.env.VITALS_LAB_QUERY_MAX_CONCURRENT || 2));
const labQueryRateWindowMs = Math.max(1_000, Number(process.env.VITALS_LAB_QUERY_RATE_WINDOW_MS || 60_000));
const labQueryRateMax = Math.max(1, Number(process.env.VITALS_LAB_QUERY_RATE_MAX || 30));
const gatewayRole = process.env.VITALS_GATEWAY_ROLE || "dev";
const exposeErrors = process.env.VITALS_EXPOSE_ERRORS === "1";
const corsAllowOrigin = process.env.VITALS_CORS_ALLOW_ORIGIN || "*";
const allowedHostValues = (process.env.VITALS_ALLOWED_HOSTS || "")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const EVIDENCE_HASH_DOMAIN = process.env.VITALS_EVIDENCE_HASH_DOMAIN || "octra-vitals:evidence:v0";
const SOURCE_REFS_HASH_DOMAIN = process.env.VITALS_SOURCE_REFS_HASH_DOMAIN || "octra-vitals:source-refs:v0";
const labStaticAssets = new Set(["/lab-history.html", "/lab-history.css", "/lab-history.js"]);

type StateSourceMode = "program_required" | "program_preferred" | "bootstrap_live";
type SnapshotSource = "program" | "bootstrap_live" | "sample_fallback";
type StaticAssetSource = "circle_required" | "circle_preferred" | "local";
type CircleMetadata = {
  stable_root: string | null;
  assets_root: string | null;
  code_hash: string | null;
  version: string | null;
  error: string | null;
};
type StaticAssetRead = {
  bytes: Buffer;
  contentType: string;
  source: "circle" | "local";
  sha256: string;
  circleId: string | null;
  circleResourceKey: string | null;
  circleBlobHash: string | null;
  circleStableRoot: string | null;
  circleAssetsRoot: string | null;
  circleIntegrityChecksPassed: boolean | null;
};
type CachedStaticAsset = StaticAssetRead & {
  cachedAt: number;
};
type HistoryCacheEntry = {
  checked_at: number;
  value: ProgramHistoryWindow;
  verified: boolean;
  source: HistoryCacheSource;
  tail_anchor: HistoryTailAnchorVerification | null;
  refresh_started_at: number | null;
  last_refresh_error: string | null;
};
type HistoryApiRead = {
  history: ProgramHistoryWindow;
  cache: {
    status: "miss" | "fresh" | "stale_refreshing";
    checked_at: string | null;
    age_ms: number | null;
    verified: boolean;
    source: HistoryCacheSource | null;
    read_mode: HistoryReadMode;
    refresh_in_flight: boolean;
    last_refresh_error: string | null;
    tail_anchor: HistoryTailAnchorVerification | null;
  };
};

function clampedIntegerEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function stateSourceMode(): StateSourceMode {
  const configured = process.env.VITALS_STATE_SOURCE_MODE;
  if (configured === "program_required" || configured === "program_preferred" || configured === "bootstrap_live") {
    return configured;
  }
  return gatewayRole === "production" || gatewayRole === "prod" ? "program_required" : "bootstrap_live";
}

let latestCache: SnapshotArtifact | null = null;
let latestCacheAt = 0;
let latestCacheSource: SnapshotSource = "sample_fallback";
let latestReadInFlight: Promise<LatestSnapshotResult> | null = null;
let latestError: Error | null = null;
let lastSuccessfulProgramReadAt: string | null = null;
let recentLatestSummaries = new Map<number, HistorySummaryAnchor>();
let historyCache = new Map<string, HistoryCacheEntry>();
let historyReadInFlight = new Map<string, Promise<ProgramHistoryWindow>>();
let historyRefreshInFlight = new Map<string, Promise<ProgramHistoryWindow>>();
let historyError: Error | null = null;
let lastHistoryPrewarmAt = 0;
let historyPrewarmInFlight: Promise<void> | null = null;
let historyMetrics = {
  reads: 0,
  cache_hits: 0,
  stale_hits: 0,
  misses: 0,
  refreshes: 0,
  refresh_errors: 0,
  prewarm_runs: 0,
  prewarm_errors: 0,
  sqlite_prior_anchor_hits: 0,
  sqlite_anchor_mismatches: 0,
  sqlite_lag_fallbacks: 0,
  sqlite_ahead_refreshes: 0
};
let liveVerificationCache: { address: string; checked_at: string; value: Record<string, any> } | null = null;
let circleProgramVerificationCache: { circle_id: string; checked_at: string; value: Record<string, any> } | null = null;
let circleMetadataCache: { circle_id: string; checked_at: number; value: CircleMetadata } | null = null;
let circleMetadataReadInFlight: { circle_id: string; promise: Promise<CircleMetadata> } | null = null;
let activeLabQueries = 0;
const labQueryRates = new Map<string, { startedAt: number; count: number }>();
let siteIntegrityCache: { circle_id: string; checked_at: string; value: Record<string, any> } | null = null;
let siteIntegrityReadInFlight: { circle_id: string; promise: Promise<Record<string, any> | null> } | null = null;
let nativeReceiptProofCache = new Map<string, {
  cachedAt: number;
  value: Record<string, any>;
}>();
let staticAssetCache = new Map<string, CachedStaticAsset>();
const trafficRecorder = configuredTrafficRecorder(dataDir);

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8"
};

function staticAssetSource(): StaticAssetSource {
  const configured = process.env.VITALS_STATIC_ASSET_SOURCE;
  if (configured === "circle_required" || configured === "circle_preferred" || configured === "local") {
    return configured;
  }
  return stateSourceMode() === "program_required" ? "circle_required" : "local";
}

function staticCacheControl(assetPath: string): string {
  if (assetPath === "/latest_snapshot.sample.json") return "public, max-age=60";
  return "no-store";
}

function requestForResponse(res: http.ServerResponse): http.IncomingMessage | null {
  return ((res as any).__octraRequest as http.IncomingMessage | undefined) || null;
}

function requestUrl(req: http.IncomingMessage | null): URL | null {
  if (!req) return null;
  const headerHost = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host;
  try {
    return new URL(req.url || "/", `http://${headerHost || `${host}:${port}`}`);
  } catch {
    return null;
  }
}

function requestAcceptsGzip(req: http.IncomingMessage | null): boolean {
  if (!responseGzipEnabled || !req) return false;
  const value = Array.isArray(req.headers["accept-encoding"])
    ? req.headers["accept-encoding"].join(",")
    : req.headers["accept-encoding"] || "";
  return /\bgzip\b/i.test(value);
}

function textContentType(contentType: string): boolean {
  return /^text\//i.test(contentType) ||
    /(?:json|javascript|xml|manifest\+json|svg\+xml)/i.test(contentType);
}

function shouldCompress(req: http.IncomingMessage | null, contentType: string, bytes: Buffer, headers: Record<string, string | number>): boolean {
  if (!requestAcceptsGzip(req)) return false;
  if (!textContentType(contentType)) return false;
  if (bytes.length < Math.max(0, responseGzipMinBytes)) return false;
  if (headers["Content-Encoding"]) return false;
  return true;
}

function shouldPrettyJson(res: http.ServerResponse): boolean {
  const url = requestUrl(requestForResponse(res));
  if (url?.searchParams.get("pretty") === "1") return true;
  if (url?.searchParams.get("compact") === "1") return false;
  return process.env.VITALS_JSON_PRETTY_DEFAULT !== "0";
}

function writeBufferedResponse(
  res: http.ServerResponse,
  status: number,
  contentType: string,
  bytes: Buffer,
  extraHeaders: Record<string, string | number> = {},
  head = false
): void {
  const req = requestForResponse(res);
  let output = bytes;
  const headers: Record<string, string | number> = {
    "Content-Type": contentType,
    "Content-Length": output.length,
    "X-Content-Type-Options": "nosniff",
    ...corsHeaders(),
    ...extraHeaders
  };
  if (shouldCompress(req, contentType, output, headers)) {
    output = gzipSync(output);
    headers["Content-Encoding"] = "gzip";
    headers["Content-Length"] = output.length;
    headers.Vary = headers.Vary ? `${headers.Vary}, Accept-Encoding` : "Accept-Encoding";
  }
  res.writeHead(status, headers);
  res.end(head ? undefined : output);
}

function json(res: http.ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}, head = false): void {
  const data = `${JSON.stringify(body, null, shouldPrettyJson(res) ? 2 : 0)}\n`;
  writeBufferedResponse(res, status, "application/json; charset=utf-8", Buffer.from(data), {
    "Cache-Control": "no-store",
    ...extraHeaders
  }, head);
}

function notFound(res: http.ServerResponse, head = false): void {
  json(res, 404, { error: "not_found" }, {}, head);
}

function methodNotAllowed(res: http.ServerResponse, head = false): void {
  json(res, 405, { error: "method_not_allowed" }, { Allow: "GET, HEAD, OPTIONS" }, head);
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": corsAllowOrigin,
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}

function options(res: http.ServerResponse): void {
  res.writeHead(204, {
    ...corsHeaders(),
    Allow: "GET, HEAD, OPTIONS",
    "Content-Length": "0",
    "X-Content-Type-Options": "nosniff"
  });
  res.end();
}

async function readRequestJson(req: http.IncomingMessage, maxBytes = 64_000): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error("request_body_too_large");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text) as Record<string, any>;
}

function gatewayOriginHost(): string | null {
  const origin = process.env.VITALS_GATEWAY_ORIGIN;
  if (!origin) return null;
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function localRequestHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function configuredAllowedHosts(): Set<string> {
  const hosts = new Set(allowedHostValues);
  const originHost = gatewayOriginHost();
  if (originHost) {
    hosts.add(originHost);
    if (!originHost.startsWith("www.")) hosts.add(`www.${originHost}`);
  }
  return hosts;
}

function parseHostHeader(headerHost: string | undefined): { hostname: string; port: string } | null {
  if (!headerHost) return null;
  try {
    const parsed = new URL(`http://${headerHost}`);
    return {
      hostname: parsed.hostname.toLowerCase(),
      port: parsed.port
    };
  } catch {
    return null;
  }
}

function hostAllowed(headerHost: string | undefined): boolean {
  const parsed = parseHostHeader(headerHost);
  if (!parsed) return true;
  if (localRequestHost(parsed.hostname)) return true;
  const hosts = configuredAllowedHosts();
  if (hosts.size === 0) return true;
  if (!hosts.has(parsed.hostname)) return false;
  return parsed.port === "" || parsed.port === "80" || parsed.port === "443";
}

function misdirectedRequest(res: http.ServerResponse, head = false): void {
  json(res, 421, { error: "misdirected_request" }, {}, head);
}

function isFresh(snapshot: SnapshotArtifact): boolean {
  const observed = Date.parse(snapshot.envelope.observed_at);
  return Number.isFinite(observed) && Date.now() - observed <= staleAfterMs;
}

async function loadBaseManifest() {
  const manifest = JSON.parse(await readFile(join(appDir, "vitals.manifest.json"), "utf8"));
  const programArtifacts = await loadProgramArtifacts("program-fact-ledger", "octra-vitals-program-circle-artifacts-v0");
  const circleProgramArtifactDir = programmedCircleArtifactDir();
  const circleProgramArtifacts = await loadProgramArtifacts(circleProgramArtifactDir, "octra-vitals-program-circle-artifacts-v0");
  const certificate = programArtifacts.formal_certificate || {};
  const verification = programArtifacts.formal_verification || {};
  const circleCertificate = circleProgramArtifacts.formal_certificate || {};
  const circleVerification = circleProgramArtifacts.formal_verification || {};
  const factLedgerProgram = circleProgramArtifactDir === "program-fact-ledger" || process.env.VITALS_RECORD_SNAPSHOT_VERSION === "fact-v1" || process.env.VITALS_RECORD_SNAPSHOT_VERSION === "fact-v2";
  return {
    ...manifest,
    gateway_origin: chooseValue(process.env.VITALS_GATEWAY_ORIGIN, manifest.gateway_origin),
    octra_scan_address_url: chooseValue(process.env.VITALS_OCTRA_SCAN_ADDRESS_URL, process.env.OCTRA_SCAN_ADDRESS_URL, manifest.octra_scan_address_url),
    octra_scan_tx_url: chooseValue(process.env.VITALS_OCTRA_SCAN_TX_URL, process.env.OCTRA_SCAN_TX_URL, manifest.octra_scan_tx_url),
    site_circle_id: chooseValue(process.env.VITALS_SITE_CIRCLE_ID, manifest.site_circle_id),
    programmed_circle_id: chooseValue(process.env.VITALS_PROGRAMMED_CIRCLE_ID, manifest.programmed_circle_id),
    state_program_address: stateTargetMode() === "circle_program" ? null : chooseValue(process.env.VITALS_STATE_PROGRAM_ADDRESS, manifest.state_program_address),
    state_program_source_hash: chooseValue(process.env.VITALS_STATE_PROGRAM_SOURCE_HASH, manifest.state_program_source_hash, prefixHash(certificate.source_hash)),
    state_program_bytecode_hash: chooseValue(process.env.VITALS_STATE_PROGRAM_BYTECODE_HASH, manifest.state_program_bytecode_hash, prefixHash(certificate.bytecode_hash)),
    state_program_verification_hash: chooseValue(process.env.VITALS_STATE_PROGRAM_VERIFICATION_HASH, manifest.state_program_verification_hash, prefixHash(certificate.verification_hash)),
    state_program_verification_safety: chooseValue(process.env.VITALS_STATE_PROGRAM_VERIFICATION_SAFETY, manifest.state_program_verification_safety, verification.safety),
    state_program_verification_verified: Boolean(verification.verified),
    state_program_compiler: certificate.compiler || null,
    state_program_compiler_version: certificate.compiler_version || null,
    programmed_circle_program: chooseValue(process.env.VITALS_PROGRAMMED_CIRCLE_PROGRAM, manifest.programmed_circle_program),
    programmed_circle_artifact_dir: circleProgramArtifactDir,
    record_snapshot_version: chooseValue(process.env.VITALS_RECORD_SNAPSHOT_VERSION, manifest.record_snapshot_version),
    programmed_circle_source_hash: chooseValue(
      factLedgerProgram ? process.env.VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_SOURCE_HASH : null,
      process.env.VITALS_PROGRAMMED_CIRCLE_SOURCE_HASH,
      manifest.programmed_circle_source_hash,
      prefixHash(circleCertificate.source_hash)
    ),
    programmed_circle_bytecode_hash: chooseValue(
      factLedgerProgram ? process.env.VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_BYTECODE_HASH : null,
      process.env.VITALS_PROGRAMMED_CIRCLE_BYTECODE_HASH,
      manifest.programmed_circle_bytecode_hash,
      prefixHash(circleCertificate.bytecode_hash)
    ),
    programmed_circle_verification_hash: chooseValue(
      factLedgerProgram ? process.env.VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_VERIFICATION_HASH : null,
      process.env.VITALS_PROGRAMMED_CIRCLE_VERIFICATION_HASH,
      manifest.programmed_circle_verification_hash,
      prefixHash(circleCertificate.verification_hash)
    ),
    programmed_circle_verification_safety: chooseValue(process.env.VITALS_PROGRAMMED_CIRCLE_VERIFICATION_SAFETY, manifest.programmed_circle_verification_safety, circleVerification.safety),
    programmed_circle_verification_verified: circleVerification.verified === true,
    programmed_circle_compiler: circleCertificate.compiler || null,
    programmed_circle_compiler_version: circleCertificate.compiler_version || null,
    gateway_version: process.env.VITALS_APP_VERSION || manifest.app_version,
    gateway_role: gatewayRole,
    state_source_mode: stateSourceMode(),
    state_target_mode: stateTargetMode()
  };
}

async function loadManifest() {
  const enriched = await loadBaseManifest();
  const [liveProgramVerification, circleProgramVerification, siteIntegrity] = await Promise.all([
    loadLiveProgramVerification(enriched),
    loadCircleProgramVerification(enriched),
    loadSiteIntegrity(enriched)
  ]);
  const historyIntegrity = await loadHistoryIntegrity(enriched);
  return {
    ...enriched,
    live_program_verification: liveProgramVerification,
    circle_program_verification: circleProgramVerification,
    site_integrity: siteIntegrity,
    history_integrity: historyIntegrity
  };
}

function chooseValue(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (value && value !== "pending") return value;
  }
  return "pending";
}

function circleIdFromOctUri(uri: string | null | undefined): string | null {
  const match = uri?.match(/^oct:\/\/[^/]+\/([^/?#]+)/);
  return match?.[1] || null;
}

function prefixHash(value: unknown): string {
  if (!value) return "pending";
  const text = String(value);
  return text.startsWith("sha256:") ? text : `sha256:${text}`;
}

function normalizeHash(value: unknown): string | null {
  if (!value) return null;
  const text = String(value);
  return text.startsWith("sha256:") ? text : `sha256:${text}`;
}

function hashMatches(actual: unknown, expected: unknown): boolean {
  const left = normalizeHash(actual);
  const right = normalizeHash(expected);
  return Boolean(left && right && left === right);
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const configured = process.env[name];
  const parsed = configured ? Number(configured) : fallback;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function nativeBool(value: unknown): boolean {
  return value === true || value === "true";
}

function extractContractSource(value: any): string | null {
  if (!value || typeof value !== "object") return null;
  for (const key of ["source", "aml_source", "contract_source", "code"]) {
    if (typeof value[key] === "string" && value[key].length > 0) return value[key];
  }
  return null;
}

function extractBytecodeHash(value: any): string | null {
  if (!value || typeof value !== "object") return null;
  for (const key of ["bytecode_hash", "code_hash", "hash"]) {
    if (value[key]) return normalizeHash(value[key]);
  }
  if (value.contract && typeof value.contract === "object") {
    return extractBytecodeHash(value.contract);
  }
  return null;
}

function extractFormalVerification(value: any): Record<string, any> | null {
  if (!value || typeof value !== "object") return null;
  for (const key of ["formal_verification", "verification", "safety_report"]) {
    if (value[key] && typeof value[key] === "object") return value[key];
  }
  if (value.contract_verify_result && typeof value.contract_verify_result === "object") {
    return extractFormalVerification(value.contract_verify_result);
  }
  return null;
}

function extractFormalCertificate(value: any): Record<string, any> | null {
  if (!value || typeof value !== "object") return null;
  for (const key of ["formal_certificate", "certificate", "bytecode_certificate"]) {
    if (value[key] && typeof value[key] === "object") return value[key];
  }
  if (value.contract_verify_result && typeof value.contract_verify_result === "object") {
    return extractFormalCertificate(value.contract_verify_result);
  }
  return null;
}

async function loadLiveProgramVerification(manifest: Record<string, any>): Promise<Record<string, any> | null> {
  const address = configuredProgramAddress(manifest.state_program_address);
  if (!address) return null;
  const cacheMs = Number(process.env.VITALS_PROGRAM_VERIFICATION_CACHE_MS || 5 * 60_000);
  if (liveVerificationCache?.address === address && Date.now() - Date.parse(liveVerificationCache.checked_at) < cacheMs) {
    return liveVerificationCache.value;
  }

  const checkedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const [sourceResult, vmResult, successorProgramResult, successorSetResult] = await Promise.allSettled([
    contractSource(address),
    vmContract(address),
    contractCall<string>(address, "get_successor_program"),
    contractCall<boolean>(address, "is_successor_set")
  ]);
  const sourceBody = sourceResult.status === "fulfilled" ? sourceResult.value : null;
  const vmBody = vmResult.status === "fulfilled" ? vmResult.value : null;
  const sourceText = extractContractSource(sourceBody);
  const sourceHash = sourceText ? `sha256:${sha256Hex(sourceText)}` : null;
  const bytecodeHash = extractBytecodeHash(vmBody);
  const verification = extractFormalVerification(sourceBody);
  const certificate = extractFormalCertificate(sourceBody);
  const certificateSourceMatches = hashMatches(certificate?.source_hash, manifest.state_program_source_hash);
  const certificateBytecodeMatches = hashMatches(certificate?.bytecode_hash, manifest.state_program_bytecode_hash);
  const certificateVerificationMatches = hashMatches(certificate?.verification_hash, manifest.state_program_verification_hash);
  const value = {
    checked_at: checkedAt,
    address,
    source_available: Boolean(sourceText),
    source_hash: sourceHash,
    source_hash_matches: sourceHash ? hashMatches(sourceHash, manifest.state_program_source_hash) : false,
    bytecode_hash: bytecodeHash,
    bytecode_hash_matches: bytecodeHash ? hashMatches(bytecodeHash, manifest.state_program_bytecode_hash) : false,
    formal_verification_available: Boolean(verification),
    formal_verification_verified: verification?.verified === true,
    formal_verification_safe: verification?.safety === "safe",
    formal_verification_errors: typeof verification?.errors === "number" ? verification.errors : null,
    formal_verification_warnings: typeof verification?.warnings === "number" ? verification.warnings : null,
    formal_certificate_available: Boolean(certificate),
    formal_certificate_matches: certificateSourceMatches && certificateBytecodeMatches && certificateVerificationMatches,
    formal_certificate_source_matches: certificateSourceMatches,
    formal_certificate_bytecode_matches: certificateBytecodeMatches,
    formal_certificate_verification_matches: certificateVerificationMatches,
    successor_program: successorProgramResult.status === "fulfilled" ? successorProgramResult.value : null,
    successor_set: successorSetResult.status === "fulfilled" ? Boolean(successorSetResult.value) : null,
    successor_error: successorProgramResult.status === "rejected" || successorSetResult.status === "rejected"
      ? String((successorProgramResult as PromiseRejectedResult).reason?.message || (successorSetResult as PromiseRejectedResult).reason?.message || "successor_unavailable")
      : null,
    contract_source_error: sourceResult.status === "rejected" ? String(sourceResult.reason?.message || sourceResult.reason) : null,
    vm_contract_error: vmResult.status === "rejected" ? String(vmResult.reason?.message || vmResult.reason) : null
  };
  liveVerificationCache = { address, checked_at: checkedAt, value };
  return value;
}

const requiredCircleProgramMethodsFactV1 = [
  "manifest",
  "is_initialized",
  "get_owner",
  "get_operator",
  "is_paused",
  "get_successor_program",
  "is_successor_set",
  "get_era_program",
  "get_era_network_id",
  "get_predecessor_program",
  "get_predecessor_final_root",
  "get_predecessor_final_index",
  "get_predecessor_anchor_hash",
  "get_era_first_snapshot_index",
  "get_snapshot_count",
  "get_latest_snapshot_index",
  "get_latest_snapshot_id",
  "get_latest_observed_at",
  "get_latest_epoch",
  "get_latest_payload_hash",
  "get_latest_evidence_manifest_hash",
  "get_latest_source_refs_hash",
  "get_latest_summary_hash",
  "get_latest_history_row_hash",
  "get_latest_snapshot",
  "get_latest_evidence_manifest",
  "get_latest_source_refs",
  "get_latest_summary",
  "get_latest_history_row",
  "get_catalog_root",
  "get_family_count",
  "get_family_id_at",
  "get_family_definition",
  "get_family_root",
  "get_family_capsules_root",
  "get_family_latest_index",
  "get_family_capsule_count",
  "get_family_latest_capsule_id",
  "get_family_capsule_id_at",
  "get_family_open_capsule_id",
  "get_family_open_capsule_body",
  "get_family_open_capsule_row_count",
  "get_family_open_capsule_start_root",
  "get_family_open_capsule_end_root",
  "get_family_capsule_body",
  "get_family_capsule_meta",
  "get_family_capsule_root_after",
  "get_capsules_root",
  "get_latest_bundle",
  "record_snapshot_fact_v1",
  "record_snapshot_fact_v2"
];

function programmedCircleArtifactDir(): string {
  const configured = process.env.VITALS_PROGRAMMED_CIRCLE_ARTIFACT_DIR;
  if (configured && !configured.includes("..") && !configured.includes("/") && !configured.includes("\\")) return configured;
  return "program-fact-ledger";
}

function methodNames(programInfo: any): string[] {
  if (!programInfo || typeof programInfo !== "object" || !Array.isArray(programInfo.methods)) return [];
  return programInfo.methods
    .map((method: any) => typeof method?.name === "string" ? method.name : null)
    .filter((method: string | null): method is string => Boolean(method));
}

function stableProgramInfo(programInfo: any): Record<string, unknown> | null {
  if (!programInfo || typeof programInfo !== "object") return null;
  return {
    has_program: programInfo.has_program === true,
    runtime: programInfo.runtime || null,
    version: programInfo.version || null,
    owner: programInfo.owner || null,
    code_hash: normalizeHash(programInfo.code_hash),
    methods: methodNames(programInfo).sort()
  };
}

function stableCircleInfo(circleInfo: any): Record<string, unknown> | null {
  if (!circleInfo || typeof circleInfo !== "object") return null;
  return {
    runtime: circleInfo.runtime || null,
    version: circleInfo.version || null,
    owner: circleInfo.owner || null,
    stable_root: circleInfo.stable_root || null,
    assets_root: circleInfo.assets_root || null,
    browser_mode: circleInfo.browser_mode || null,
    resource_mode: circleInfo.resource_mode || null,
    privacy_class: circleInfo.privacy_class || null
  };
}

async function loadProgrammedCircleDeployReport(): Promise<Record<string, any> | null> {
  return await readJsonIfExists<Record<string, any>>(join(dataDir, "programmed-circle-deploy.json")) ||
    await readJsonIfExists<Record<string, any>>(join(root, "build", "programmed-circle-deploy.json"));
}

async function loadCircleProgramVerification(manifest: Record<string, any>): Promise<Record<string, any> | null> {
  const target = configuredStateTarget(manifest);
  if (target.kind !== "circle_program" || !target.id) return null;
  const circleId = target.id;
  const cacheMs = Number(process.env.VITALS_CIRCLE_PROGRAM_VERIFICATION_CACHE_MS || 5 * 60_000);
  if (circleProgramVerificationCache?.circle_id === circleId && Date.now() - Date.parse(circleProgramVerificationCache.checked_at) < cacheMs) {
    return circleProgramVerificationCache.value;
  }

  const checkedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const artifactDir = programmedCircleArtifactDir();
  const expectedAmlManifest = FACT_LEDGER_MANIFEST;
  const requiredMethods = requiredCircleProgramMethodsFactV1;
  const sourceResult = await readFile(join(root, artifactDir, "main.aml"), "utf8").then(
    (source) => ({ source, source_hash: `sha256:${sha256Hex(source)}` }),
    () => null
  );
  const localArtifacts = await loadProgramArtifacts(artifactDir, "octra-vitals-program-circle-artifacts-v0");
  const compileArtifact = await readJsonIfExists<Record<string, any>>(join(root, "build", artifactDir, "compile.json"));
  const localVerification = localArtifacts.formal_verification || compileArtifact?.verification || {};
  const localCertificate = localArtifacts.formal_certificate || compileArtifact?.certificate || {};
  const deployReport = await loadProgrammedCircleDeployReport();
  const expectedBytecodeHash = normalizeHash(process.env.VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_BYTECODE_HASH || localCertificate.bytecode_hash || compileArtifact?.bytecode_hash || process.env.VITALS_PROGRAMMED_CIRCLE_BYTECODE_HASH || manifest.programmed_circle_bytecode_hash);
  const expectedSourceHash = normalizeHash(process.env.VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_SOURCE_HASH || sourceResult?.source_hash || localCertificate.source_hash || compileArtifact?.source_hash || process.env.VITALS_PROGRAMMED_CIRCLE_SOURCE_HASH || manifest.programmed_circle_source_hash);
  const expectedVerificationHash = normalizeHash(process.env.VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_VERIFICATION_HASH || localCertificate.verification_hash || compileArtifact?.verification_hash || process.env.VITALS_PROGRAMMED_CIRCLE_VERIFICATION_HASH || manifest.programmed_circle_verification_hash);
  const expectedOwner = chooseValue(process.env.VITALS_CIRCLE_OWNER_ADDRESS, process.env.VITALS_DEPLOYER_ADDRESS, manifest.programmed_circle_owner_address, deployReport?.deployer_address);
  const expectedOperator = chooseValue(process.env.VITALS_CIRCLE_OPERATOR_ADDRESS, process.env.VITALS_OPERATOR_ADDRESS, manifest.programmed_circle_operator_address, deployReport?.operator_address);
  const configuredMinProgramRpcUrls = positiveIntegerEnv("VITALS_MIN_PROGRAM_RPC_URLS", 1);
  const minProgramRpcUrls = Math.max(1, configuredMinProgramRpcUrls);
  const localFormalVerified =
    localVerification?.verified === true &&
    localVerification?.safety === "safe" &&
    localVerification?.errors === 0 &&
    localVerification?.warnings === 0;
  const localCertificateMatches =
    hashMatches(localCertificate.source_hash, sourceResult?.source_hash) &&
    hashMatches(localCertificate.bytecode_hash, expectedBytecodeHash) &&
    (!expectedVerificationHash || hashMatches(localCertificate.verification_hash, expectedVerificationHash));
  const readFromUrl = async (url: string) => {
    const [programInfoResult, circleInfoResult, manifestResult, initializedResult, ownerResult, operatorResult, successorSetResult, successorResult] = await Promise.allSettled([
      circleProgramInfoAtUrl(url, circleId),
      circleInfoAtUrl(url, circleId),
      circleProgramViewAtUrl<string>(url, circleId, "manifest"),
      circleProgramViewAtUrl<unknown>(url, circleId, "is_initialized"),
      circleProgramViewAtUrl<string>(url, circleId, "get_owner"),
      circleProgramViewAtUrl<string>(url, circleId, "get_operator"),
      circleProgramViewAtUrl<unknown>(url, circleId, "is_successor_set"),
      circleProgramViewAtUrl<string>(url, circleId, "get_successor_program")
    ]);
    return { url, programInfoResult, circleInfoResult, manifestResult, initializedResult, ownerResult, operatorResult, successorSetResult, successorResult };
  };
  const urls = octraProgramRpcUrls();
  const [primaryUrl, ...otherUrls] = urls;
  if (!primaryUrl) throw new Error("no Octra program RPC URL configured");
  const primaryRead = await readFromUrl(primaryUrl);
  const otherReads = await Promise.all(otherUrls.map(readFromUrl));
  const { programInfoResult, circleInfoResult, manifestResult, initializedResult, ownerResult, operatorResult, successorSetResult, successorResult } = primaryRead;
  const program = programInfoResult.status === "fulfilled" ? programInfoResult.value : null;
  const circle = circleInfoResult.status === "fulfilled" ? circleInfoResult.value : null;
  const rpcMismatchReasons: string[] = [];
  const primaryCompare = {
    program: stableJson(stableProgramInfo(program)),
    circle: stableJson(stableCircleInfo(circle)),
    manifest: manifestResult.status === "fulfilled" ? String(manifestResult.value) : "error",
    initialized: initializedResult.status === "fulfilled" ? String(nativeBool(initializedResult.value)) : "error",
    owner: ownerResult.status === "fulfilled" ? String(ownerResult.value) : "error",
    operator: operatorResult.status === "fulfilled" ? String(operatorResult.value) : "error",
    successor_set: successorSetResult.status === "fulfilled" ? String(nativeBool(successorSetResult.value)) : "error",
    successor_program: successorResult.status === "fulfilled" ? String(successorResult.value) : "error"
  };
  for (const read of otherReads) {
    const compare = {
      program: stableJson(stableProgramInfo(read.programInfoResult.status === "fulfilled" ? read.programInfoResult.value : null)),
      circle: stableJson(stableCircleInfo(read.circleInfoResult.status === "fulfilled" ? read.circleInfoResult.value : null)),
      manifest: read.manifestResult.status === "fulfilled" ? String(read.manifestResult.value) : "error",
      initialized: read.initializedResult.status === "fulfilled" ? String(nativeBool(read.initializedResult.value)) : "error",
      owner: read.ownerResult.status === "fulfilled" ? String(read.ownerResult.value) : "error",
      operator: read.operatorResult.status === "fulfilled" ? String(read.operatorResult.value) : "error",
      successor_set: read.successorSetResult.status === "fulfilled" ? String(nativeBool(read.successorSetResult.value)) : "error",
      successor_program: read.successorResult.status === "fulfilled" ? String(read.successorResult.value) : "error"
    };
    for (const key of Object.keys(primaryCompare) as Array<keyof typeof primaryCompare>) {
      if (compare[key] !== primaryCompare[key]) rpcMismatchReasons.push(`${read.url}:${key}`);
    }
  }
  const rpcAgreement = rpcMismatchReasons.length === 0;
  const methods = methodNames(program);
  const missingMethods = requiredMethods.filter((method) => !methods.includes(method));
  const codeHash = normalizeHash(program?.code_hash);
  const codeHashMatches = expectedBytecodeHash ? hashMatches(codeHash, expectedBytecodeHash) : null;
  const sourceHashMatches = expectedSourceHash && sourceResult?.source_hash ? hashMatches(sourceResult.source_hash, expectedSourceHash) : null;
  const owner = ownerResult.status === "fulfilled" ? String(ownerResult.value) : null;
  const operator = operatorResult.status === "fulfilled" ? String(operatorResult.value) : null;
  const ownerMatches = expectedOwner !== "pending" && owner ? owner === expectedOwner : null;
  const operatorMatches = expectedOperator !== "pending" && operator ? operator === expectedOperator : null;
  const rpcUrlCountOk = urls.length >= minProgramRpcUrls;
  const value = {
    checked_at: checkedAt,
    circle_id: circleId,
    artifact_dir: artifactDir,
    program_info_available: Boolean(program),
    circle_info_available: Boolean(circle),
    has_program: program?.has_program === true,
    runtime: program?.runtime || circle?.runtime || null,
    version: program?.version || circle?.version || null,
    metadata_owner: program?.owner || circle?.owner || null,
    code_hash: codeHash,
    expected_bytecode_hash: expectedBytecodeHash,
    code_hash_matches: codeHashMatches,
    rpc_urls_checked: urls.length,
    rpc_urls_minimum: minProgramRpcUrls,
    rpc_urls_minimum_met: rpcUrlCountOk,
    rpc_agreement: rpcAgreement,
    rpc_mismatches: rpcMismatchReasons,
    source_hash: sourceResult?.source_hash || null,
    expected_source_hash: expectedSourceHash,
    source_hash_matches: sourceHashMatches,
    expected_owner: expectedOwner === "pending" ? null : expectedOwner,
    owner,
    owner_matches: ownerMatches,
    expected_operator: expectedOperator === "pending" ? null : expectedOperator,
    operator,
    operator_matches: operatorMatches,
    local_formal_verification_available: Boolean(localVerification && Object.keys(localVerification).length),
    local_formal_verification_verified: localVerification?.verified === true,
    local_formal_verification_safe: localVerification?.safety === "safe",
    local_formal_verification_errors: typeof localVerification?.errors === "number" ? localVerification.errors : null,
    local_formal_verification_warnings: typeof localVerification?.warnings === "number" ? localVerification.warnings : null,
    local_formal_verification_passes: localFormalVerified,
    local_formal_certificate_available: Boolean(localCertificate && Object.keys(localCertificate).length),
    local_formal_certificate_matches: localCertificateMatches,
    local_formal_certificate_source_matches: hashMatches(localCertificate.source_hash, sourceResult?.source_hash),
    local_formal_certificate_bytecode_matches: hashMatches(localCertificate.bytecode_hash, expectedBytecodeHash),
    local_formal_certificate_verification_matches: expectedVerificationHash ? hashMatches(localCertificate.verification_hash, expectedVerificationHash) : null,
    methods,
    required_methods: requiredMethods,
    missing_methods: missingMethods,
    required_methods_present: missingMethods.length === 0,
    circle_roots: {
      stable_root: circle?.stable_root || null,
      assets_root: circle?.assets_root || null
    },
    browser_mode: circle?.browser_mode || null,
    resource_mode: circle?.resource_mode || null,
    privacy_class: circle?.privacy_class || null,
    limits: circle?.limits || null,
    aml_manifest: manifestResult.status === "fulfilled" ? manifestResult.value : null,
    initialized: initializedResult.status === "fulfilled" ? nativeBool(initializedResult.value) : null,
    successor_set: successorSetResult.status === "fulfilled" ? nativeBool(successorSetResult.value) : null,
    successor_program: successorResult.status === "fulfilled" ? successorResult.value : null,
    verified: Boolean(
      program &&
      circle &&
      program?.has_program === true &&
      (program?.runtime || circle?.runtime) === "octb" &&
      (circle?.browser_mode === "gateway_allowed" || circle?.browser_mode === "native_allowed") &&
      circle?.resource_mode === "public_resources" &&
      missingMethods.length === 0 &&
      codeHashMatches === true &&
      sourceHashMatches === true &&
      ownerMatches === true &&
      operatorMatches === true &&
      localFormalVerified &&
      localCertificateMatches &&
      rpcAgreement &&
      rpcUrlCountOk &&
      (initializedResult.status === "fulfilled" && nativeBool(initializedResult.value)) &&
      (manifestResult.status === "fulfilled" && manifestResult.value === expectedAmlManifest)
    ),
    errors: {
      program_info: programInfoResult.status === "rejected" ? String(programInfoResult.reason?.message || programInfoResult.reason) : null,
      circle_info: circleInfoResult.status === "rejected" ? String(circleInfoResult.reason?.message || circleInfoResult.reason) : null,
      manifest: manifestResult.status === "rejected" ? String(manifestResult.reason?.message || manifestResult.reason) : null,
      initialized: initializedResult.status === "rejected" ? String(initializedResult.reason?.message || initializedResult.reason) : null,
      owner: ownerResult.status === "rejected" ? String(ownerResult.reason?.message || ownerResult.reason) : null,
      operator: operatorResult.status === "rejected" ? String(operatorResult.reason?.message || operatorResult.reason) : null,
      successor: successorResult.status === "rejected" || successorSetResult.status === "rejected"
        ? String((successorResult as PromiseRejectedResult).reason?.message || (successorSetResult as PromiseRejectedResult).reason?.message || "successor_unavailable")
        : null,
      rpc_agreement: rpcAgreement ? null : rpcMismatchReasons.join(", ")
    }
  };
  circleProgramVerificationCache = { circle_id: circleId, checked_at: checkedAt, value };
  return value;
}

function extractCircleAssetBytes(value: any): Buffer | null {
  if (!value || typeof value !== "object") return null;
  if (typeof value.body_b64 === "string") return Buffer.from(value.body_b64, "base64");
  if (typeof value.body === "string") return Buffer.from(value.body);
  if (typeof value.content_b64 === "string") return Buffer.from(value.content_b64, "base64");
  return null;
}

function circleMetadataFromInfo(info: any, error: string | null = null): CircleMetadata {
  const stableRoot = typeof info?.stable_root === "string" && info.stable_root.length > 0 ? info.stable_root : null;
  const assetsRoot = typeof info?.assets_root === "string" && info.assets_root.length > 0 ? info.assets_root : null;
  const codeHash = typeof info?.code_hash === "string" && info.code_hash.length > 0 ? info.code_hash : null;
  const version = info?.version === undefined || info?.version === null ? null : String(info.version);
  return {
    stable_root: stableRoot,
    assets_root: assetsRoot,
    code_hash: codeHash,
    version,
    error
  };
}

async function loadCircleMetadata(circleId: string): Promise<CircleMetadata> {
  const cacheMs = Number(process.env.VITALS_CIRCLE_METADATA_CACHE_MS || 60_000);
  if (circleMetadataCache?.circle_id === circleId && Date.now() - circleMetadataCache.checked_at < cacheMs) {
    return circleMetadataCache.value;
  }
  if (circleMetadataReadInFlight?.circle_id === circleId) return circleMetadataReadInFlight.promise;

  const promise = (async () => {
    try {
      const info = await octraRpc<any>("circle_info", [circleId]);
      const value = circleMetadataFromInfo(info);
      circleMetadataCache = { circle_id: circleId, checked_at: Date.now(), value };
      return value;
    } catch (error) {
      const value = circleMetadataFromInfo(null, error instanceof Error ? error.message : String(error));
      circleMetadataCache = { circle_id: circleId, checked_at: Date.now(), value };
      return value;
    }
  })().finally(() => {
    if (circleMetadataReadInFlight?.promise === promise) circleMetadataReadInFlight = null;
  });
  circleMetadataReadInFlight = { circle_id: circleId, promise };
  return promise;
}

async function loadCircleMetadataForStaticHeaders(circleId: string): Promise<CircleMetadata> {
  const timeoutMs = Number(process.env.VITALS_CIRCLE_METADATA_HEADER_TIMEOUT_MS || 350);
  const fallback = circleMetadataFromInfo(null, timeoutMs <= 0 ? "circle_info_deferred" : "circle_info_header_timeout");
  const read = loadCircleMetadata(circleId);
  if (timeoutMs <= 0) return fallback;
  return Promise.race([
    read,
    new Promise<CircleMetadata>((resolve) => setTimeout(() => resolve(fallback), timeoutMs))
  ]);
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item !== undefined) results[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}

function assetVerificationStatus(assetResults: Array<Record<string, any>>, releaseCoverageExact: boolean): Record<string, any> {
  const localMismatchAssets = assetResults
    .filter((asset) => asset.local_matches !== true)
    .map((asset) => asset.path);
  const circleErrorAssets = assetResults
    .filter((asset) => asset.circle_error)
    .map((asset) => ({
      path: asset.path,
      error: asset.circle_error
    }));
  const circleMismatchAssets = assetResults
    .filter((asset) => asset.circle_sha256 && asset.circle_matches !== true)
    .map((asset) => ({
      path: asset.path,
      expected_sha256: asset.expected_sha256,
      circle_sha256: asset.circle_sha256,
      circle_resource_key: asset.circle_resource_key ?? null,
      expected_resource_key: asset.expected_resource_key ?? null,
      circle_blob_hash: asset.circle_blob_hash ?? null,
      circle_consistency_errors: asset.circle_consistency_errors ?? []
    }));
  const localAssetsMatch = releaseCoverageExact && assetResults.length > 0 && localMismatchAssets.length === 0;
  const circleAssetsMatch = releaseCoverageExact && assetResults.length > 0 && assetResults.every((asset) => asset.circle_matches);
  const transientErrorsOnly = circleErrorAssets.length > 0 && circleMismatchAssets.length === 0;
  const verificationStatus =
    localAssetsMatch && circleAssetsMatch ? "verified" :
    transientErrorsOnly ? "circle_unavailable" :
    "mismatch";
  return {
    local_assets_match: localAssetsMatch,
    circle_assets_match: circleAssetsMatch,
    verification_status: verificationStatus,
    circle_error_count: circleErrorAssets.length,
    circle_error_assets: circleErrorAssets,
    circle_mismatch_assets: circleMismatchAssets,
    local_mismatch_assets: localMismatchAssets
  };
}

async function loadSiteIntegrity(manifest: Record<string, any>): Promise<Record<string, any> | null> {
  const circleId = chooseValue(process.env.VITALS_SITE_CIRCLE_ID, manifest.site_circle_id);
  if (!circleId || circleId === "pending") return null;
  const cacheMs = Number(process.env.VITALS_SITE_INTEGRITY_CACHE_MS || 60 * 60_000);
  const failureCacheMs = Number(process.env.VITALS_SITE_INTEGRITY_FAILURE_CACHE_MS || 5 * 60_000);
  const cachedTtl = siteIntegrityCache?.value?.circle_assets_match === true ? cacheMs : failureCacheMs;
  if (siteIntegrityCache?.circle_id === circleId && Date.now() - Date.parse(siteIntegrityCache.checked_at) < cachedTtl) {
    return siteIntegrityCache.value;
  }
  if (siteIntegrityReadInFlight?.circle_id === circleId) return siteIntegrityReadInFlight.promise;

  const promise = computeSiteIntegrity(circleId).finally(() => {
    if (siteIntegrityReadInFlight?.promise === promise) siteIntegrityReadInFlight = null;
  });
  siteIntegrityReadInFlight = { circle_id: circleId, promise };
  return promise;
}

async function computeSiteIntegrity(circleId: string): Promise<Record<string, any> | null> {
  const checkedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const circleMetadata = await loadCircleMetadata(circleId);
  const release = await readJsonIfExists<Record<string, any>>(join(root, "build", "site-circle-release.json"));
  const releaseAssets = Array.isArray(release?.assets) ? release.assets as Array<Record<string, any>> : [];
  const releaseByPath = new Map<string, Record<string, any>>();
  for (const asset of releaseAssets) {
    if (typeof asset.path === "string" && asset.path.startsWith("/")) releaseByPath.set(asset.path, asset);
  }
  const siteManifest = await loadSiteManifest();
  const manifestPaths = [...siteManifest.assets].sort();
  const releasePaths = [...releaseByPath.keys()].sort();
  const missingReleaseAssets = manifestPaths.filter((path) => !releaseByPath.has(path));
  const extraReleaseAssets = releasePaths.filter((path) => !siteManifest.assets.has(path));
  const releaseCoverageExact = Boolean(release) && missingReleaseAssets.length === 0 && extraReleaseAssets.length === 0;
  const circleAssetConcurrency = Math.max(1, Math.min(8, Number(process.env.VITALS_SITE_INTEGRITY_CIRCLE_ASSET_CONCURRENCY || 3)));
  const assetResults = await mapWithConcurrency(manifestPaths, circleAssetConcurrency, async (path) => {
    const asset = releaseByPath.get(path);
    const expected = normalizeHash(asset?.sha256);
    let localHash: string | null = null;
    let localMatches = false;
    try {
      const bytes = await readLocalAssetBytes(path);
      localHash = `sha256:${sha256Hex(bytes)}`;
      localMatches = hashMatches(localHash, expected);
    } catch {
      localHash = null;
    }

    let circleHash: string | null = null;
    let circleMatches = false;
    let circleError: string | null = null;
    let expectedResourceKey: string | null = null;
    let circleResourceKey: string | null = null;
    let circleResourceKeyMatches: boolean | null = null;
    let circleBlobHash: string | null = null;
    let circleBlobHashMatchesBody: boolean | null = null;
    let circleConsistencyChecksPassed: boolean | null = null;
    let circleConsistencyErrors: string[] = [];
    if (!expected) {
      circleError = "release_manifest_missing_pinned_hash";
    } else {
      try {
        const circleAsset = await octraRpc<any>("circle_asset", [circleId, path]);
        const bytes = extractCircleAssetBytes(circleAsset);
        if (!bytes) throw new Error("circle_asset did not return bytes");
        const integrity = verifyCircleAssetIntegrity(circleId, path, bytes, circleAsset || {});
        expectedResourceKey = integrity.expected_resource_key;
        circleResourceKey = integrity.resource_key;
        circleResourceKeyMatches = integrity.resource_key_matches;
        circleBlobHash = integrity.blob_hash;
        circleBlobHashMatchesBody = integrity.blob_hash_matches_body_sha256;
        circleConsistencyChecksPassed = integrity.checks_passed;
        circleConsistencyErrors = integrity.errors;
        circleHash = `sha256:${sha256Hex(bytes)}`;
        circleMatches = hashMatches(circleHash, expected) && integrity.checks_passed;
      } catch (error) {
        circleError = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      path,
      expected_sha256: expected,
      local_sha256: localHash,
      local_matches: localMatches,
      circle_sha256: circleHash,
      expected_resource_key: expectedResourceKey,
      circle_resource_key: circleResourceKey,
      circle_resource_key_matches: circleResourceKeyMatches,
      circle_blob_hash: circleBlobHash,
      circle_blob_hash_matches_body: circleBlobHashMatchesBody,
      circle_consistency_checks_passed: circleConsistencyChecksPassed,
      circle_consistency_errors: circleConsistencyErrors,
      circle_matches: circleMatches,
      circle_error: circleError
    };
  });
  const verification = assetVerificationStatus(assetResults, releaseCoverageExact);

  const value = {
    checked_at: checkedAt,
    circle_id: circleId,
    circle_stable_root: circleMetadata.stable_root,
    circle_assets_root: circleMetadata.assets_root,
    circle_code_hash: circleMetadata.code_hash,
    circle_version: circleMetadata.version,
    circle_info_error: circleMetadata.error,
    consensus_proof: null,
    consensus_proof_status: "not_exposed_by_rpc",
    release_manifest_present: Boolean(release),
    release_manifest_covers_site_manifest: releaseCoverageExact,
    missing_release_assets: missingReleaseAssets,
    extra_release_assets: extraReleaseAssets,
    local_assets_match: verification.local_assets_match,
    circle_assets_match: verification.circle_assets_match,
    verification_status: verification.verification_status,
    circle_error_count: verification.circle_error_count,
    circle_error_assets: verification.circle_error_assets,
    circle_mismatch_assets: verification.circle_mismatch_assets,
    local_mismatch_assets: verification.local_mismatch_assets,
    assets: assetResults
  };
  siteIntegrityCache = { circle_id: circleId, checked_at: checkedAt, value };
  return value;
}

async function readLocalAssetBytes(assetPath: string): Promise<Buffer> {
  if (assetPath === "/vitals.manifest.json") {
    const manifest = JSON.parse(await readFile(join(appDir, "vitals.manifest.json"), "utf8"));
    return Buffer.from(stableJson(runtimeVitalsManifest(manifest)));
  }
  return readFile(join(appDir, assetPath.replace(/^\//, "")));
}

function targetCacheKey(target: StateTarget): string {
  return `${target.kind}:${target.id || "pending"}`;
}

function historyReadCacheKey(target: StateTarget, options: HistoryReadOptions = {}): string {
  const capsuleLimit = options.maxSealedCapsules === null || options.maxSealedCapsules === undefined
    ? "default"
    : String(options.maxSealedCapsules);
  return `${targetCacheKey(target)}:capsules=${capsuleLimit}`;
}

function historyReadOptionsForRequest(request: HistoryApiRequest): HistoryReadOptions {
  const maxSealedCapsules = historyApiRecommendedCapsuleLimit(request);
  return maxSealedCapsules === null ? {} : { maxSealedCapsules };
}

function isoFromMs(value: number | null): string | null {
  return value ? new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z") : null;
}

function historyCacheAgeMs(entry: HistoryCacheEntry | undefined): number | null {
  return entry ? Date.now() - entry.checked_at : null;
}

function historyCacheDiagnostic(cacheKey: string, entry: HistoryCacheEntry | undefined, status: HistoryApiRead["cache"]["status"]): HistoryApiRead["cache"] {
  return {
    status,
    checked_at: isoFromMs(entry?.checked_at || null),
    age_ms: historyCacheAgeMs(entry),
    verified: entry?.verified === true,
    source: entry?.source || null,
    read_mode: historyReadMode,
    refresh_in_flight: historyRefreshInFlight.has(cacheKey) || historyReadInFlight.has(cacheKey),
    last_refresh_error: entry?.last_refresh_error || null,
    tail_anchor: entry?.tail_anchor || null
  };
}

function historyBackingPath(source: HistoryCacheSource | null): "canonical_state" | "sqlite_history_mirror" | "unavailable" {
  if (source === "aml") return "canonical_state";
  if (source === "sqlite") return "sqlite_history_mirror";
  return "unavailable";
}

function configuredHistoryReadPath(): "canonical_state" | "sqlite_history_mirror" | "gateway_cache_only" {
  if (historyReadMode === "canonical") return "canonical_state";
  if (historyReadMode === "cache_only") return "gateway_cache_only";
  return "sqlite_history_mirror";
}

function historyVerificationLevel(source: HistoryCacheSource | null, history: ProgramHistoryWindow | null | undefined, anchor: HistoryTailAnchorVerification | null | undefined): string {
  const scope = history?.proof?.scope || "unavailable";
  if (source === "sqlite" && anchor?.anchor_source === "remembered_latest_summary") return "sqlite_prior_summary_anchor_verified";
  if (source === "sqlite") return "sqlite_latest_summary_anchor_verified";
  if (source === "aml" && scope === "full_chain") return "aml_full_chain_verified";
  if (source === "aml" && scope === "tail_window") return "aml_tail_window_verified";
  if (source === "aml" && scope === "summary_window") return "aml_summary_window_verified";
  if (source === "aml" && scope === "latest_row_anchor") return "aml_latest_summary_anchor_verified";
  return "unavailable";
}

function publicHistoryRead(cache: HistoryApiRead["cache"], history: ProgramHistoryWindow): Record<string, unknown> {
  const backingPath = historyBackingPath(cache.source);
  const anchor = cache.tail_anchor;
  return {
    read_result: cache.status === "fresh" ? "served_from_cache" : cache.status === "stale_refreshing" ? "served_stale_revalidating" : "refreshed",
    serving_path: cache.status === "miss" ? backingPath : "gateway_cache",
    backing_path: backingPath,
    configured_read_path: configuredHistoryReadPath(),
    checked_at: cache.checked_at,
    age_ms: cache.age_ms,
    usable_for_display: cache.verified === true && backingPath !== "unavailable",
    verification_level: historyVerificationLevel(cache.source, history, anchor),
    canonical_latest_index: anchor?.latest_index ?? null,
    history_tail_index: anchor?.tail_index ?? null,
    replica_lag_snapshots: cache.source === "sqlite" ? anchor?.lag_snapshots ?? null : null,
    replica_lag_seconds: cache.source === "sqlite" ? anchor?.lag_seconds ?? null : null,
    anchor_source: anchor?.anchor_source ?? null,
    anchor_index: anchor?.anchor_index ?? null,
    max_replica_lag_snapshots: cache.source === "sqlite" ? historyReplicaMaxLagSnapshots : 0,
    latest_cache_ttl_ms: latestReadTtlMs
  };
}

function snapshotIndex(snapshot: SnapshotArtifact | null | undefined): number | null {
  const index = Number((snapshot as any)?.snapshot_index || 0);
  return Number.isFinite(index) && index > 0 ? index : null;
}

function rememberLatestSummary(snapshot: SnapshotArtifact | null | undefined): void {
  const index = snapshotIndex(snapshot);
  const latestSummary = (snapshot as any)?.latest_summary;
  if (!index || typeof latestSummary !== "string" || !latestSummary) return;
  const observedAtUnix = (() => {
    try {
      return decodeSummaryRow(latestSummary).observed_at_unix;
    } catch {
      return null;
    }
  })();
  recentLatestSummaries.set(index, {
    latest_summary: latestSummary,
    observed_at_unix: observedAtUnix,
    checked_at_ms: Date.now()
  });
  while (recentLatestSummaries.size > 8) {
    const oldest = recentLatestSummaries.keys().next().value;
    if (oldest === undefined) break;
    recentLatestSummaries.delete(oldest);
  }
}

function historyTailAnchorOptions(source: HistoryCacheSource): { maxLagSnapshots: number; rememberedSummaries: ReadonlyMap<number, HistorySummaryAnchor> } {
  return {
    maxLagSnapshots: source === "sqlite" ? historyReplicaMaxLagSnapshots : 0,
    rememberedSummaries: recentLatestSummaries
  };
}

function verifyHistoryTailForSource(history: ProgramHistoryWindow, latest: SnapshotArtifact, source: HistoryCacheSource): HistoryTailAnchorVerification {
  return assertHistoryTailWithinLag(history, latest, historyTailAnchorOptions(source));
}

async function cachedHistoryTailMatchesLatest(entry: HistoryCacheEntry | undefined): Promise<boolean> {
  if (!entry?.value) return false;
  const latestResult = await getLatestSnapshot();
  if (latestResult.source !== "program" || !latestResult.snapshot) return true;
  try {
    entry.tail_anchor = verifyHistoryTailForSource(entry.value, latestResult.snapshot, entry.source);
    return true;
  } catch {
    return false;
  }
}

function historyStaleAllowed(request: HistoryApiRequest): boolean {
  return Boolean(request.window && historyApiStaleWindows.has(request.window));
}

function markHistoryRefreshStarted(cacheKey: string): void {
  const entry = historyCache.get(cacheKey);
  if (entry) {
    entry.refresh_started_at = Date.now();
    historyCache.set(cacheKey, entry);
  }
}

function markHistoryRefreshError(cacheKey: string, error: unknown): void {
  const entry = historyCache.get(cacheKey);
  if (entry) {
    entry.last_refresh_error = error instanceof Error ? error.message : String(error);
    entry.refresh_started_at = null;
    historyCache.set(cacheKey, entry);
  }
}

async function readCanonicalHistory(target: StateTarget, bypassCache = false, options: HistoryReadOptions = {}): Promise<ProgramHistoryWindow> {
  const cacheKey = historyReadCacheKey(target, options);
  const cached = historyCache.get(cacheKey);
  if (
    !bypassCache &&
    cached &&
    cached.source === "aml" &&
    historyReadTtlMs > 0 &&
    Date.now() - cached.checked_at <= historyReadTtlMs
  ) {
    return cached.value;
  }
  const inFlight = historyReadInFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }
  if (!target.id) throw new Error(`${target.kind === "circle_program" ? "programmed Circle id" : "state program address"} is required`);
  const promise = readCanonicalHistoryUncached(target, options)
    .then((value) => {
      historyCache.set(cacheKey, {
        checked_at: Date.now(),
        value,
        verified: false,
        source: "aml",
        tail_anchor: null,
        refresh_started_at: null,
        last_refresh_error: null
      });
      while (historyCache.size > 8) {
        const oldest = historyCache.keys().next().value;
        if (!oldest) break;
        historyCache.delete(oldest);
      }
      historyError = null;
      return value;
    })
    .finally(() => {
      if (historyReadInFlight.get(cacheKey) === promise) historyReadInFlight.delete(cacheKey);
    });
  historyReadInFlight.set(cacheKey, promise);
  return promise;
}

async function latestSnapshotForHistory(target: StateTarget, latestResult?: LatestSnapshotResult): Promise<SnapshotArtifact> {
  const resolved = latestResult || await getLatestSnapshot();
  if (resolved.source === "program" && resolved.snapshot) {
    rememberLatestSummary(resolved.snapshot);
    return resolved.snapshot;
  }
  const snapshot = target.kind === "circle_program"
    ? await readLatestCircleProgramSnapshot(target.id!)
    : await readLatestProgramSnapshot(target.id!);
  rememberLatestSummary(snapshot);
  return snapshot;
}

async function forceLatestSnapshotForHistory(target: StateTarget): Promise<SnapshotArtifact> {
  const result = await readLatestSnapshotLive();
  return latestSnapshotForHistory(target, result);
}

function recordSqliteAnchorFailure(error: unknown): void {
  if (!(error instanceof HistoryTailAnchorError)) return;
  if (error.code === "history_tail_summary_mismatch") historyMetrics.sqlite_anchor_mismatches += 1;
  if (error.code === "remembered_summary_unavailable" || error.code === "history_tail_lag_exceeds_max") {
    historyMetrics.sqlite_lag_fallbacks += 1;
  }
}

async function readHistorySource(target: StateTarget, latest: SnapshotArtifact, options: HistoryReadOptions = {}): Promise<{ history: ProgramHistoryWindow; source: HistoryCacheSource; tail_anchor: HistoryTailAnchorVerification; latest: SnapshotArtifact }> {
  if (historyReadMode === "canonical") {
    const history = await readCanonicalHistory(target, true, options);
    try {
      return {
        history,
        source: "aml",
        tail_anchor: verifyHistoryTailForSource(history, latest, "aml"),
        latest
      };
    } catch (error) {
      if (!(error instanceof HistoryTailAnchorError) || error.code !== "history_tail_ahead") throw error;
      const freshLatest = await forceLatestSnapshotForHistory(target);
      return {
        history,
        source: "aml",
        tail_anchor: verifyHistoryTailForSource(history, freshLatest, "aml"),
        latest: freshLatest
      };
    }
  }

  if (historyReadMode === "cache_only") {
    throw new Error("history_cache_only_unavailable");
  }

  try {
    const replica = await readSqliteHistoryReplica(
      target,
      latest,
      options,
      undefined,
      undefined,
      historyTailAnchorOptions("sqlite")
    );
    if (replica.tail_anchor.anchor_source === "remembered_latest_summary") historyMetrics.sqlite_prior_anchor_hits += 1;
    return {
      history: replica.history,
      source: "sqlite",
      tail_anchor: replica.tail_anchor,
      latest
    };
  } catch (error) {
    let latestForFallback = latest;
    let sqliteError = error;
    if (error instanceof HistoryTailAnchorError && error.code === "history_tail_ahead") {
      historyMetrics.sqlite_ahead_refreshes += 1;
      latestForFallback = await forceLatestSnapshotForHistory(target);
      try {
        const replica = await readSqliteHistoryReplica(
          target,
          latestForFallback,
          options,
          undefined,
          undefined,
          historyTailAnchorOptions("sqlite")
        );
        if (replica.tail_anchor.anchor_source === "remembered_latest_summary") historyMetrics.sqlite_prior_anchor_hits += 1;
        return {
          history: replica.history,
          source: "sqlite",
          tail_anchor: replica.tail_anchor,
          latest: latestForFallback
        };
      } catch (retryError) {
        sqliteError = retryError;
      }
    }
    recordSqliteAnchorFailure(sqliteError);
    if (!sqliteHistoryFallbackToAml) throw sqliteError;
    const history = await readCanonicalHistory(target, true, options);
    try {
      return {
        history,
        source: "aml",
        tail_anchor: verifyHistoryTailForSource(history, latestForFallback, "aml"),
        latest: latestForFallback
      };
    } catch (fallbackError) {
      if (!(fallbackError instanceof HistoryTailAnchorError) || fallbackError.code !== "history_tail_ahead") throw fallbackError;
      const freshLatest = await forceLatestSnapshotForHistory(target);
      return {
        history,
        source: "aml",
        tail_anchor: verifyHistoryTailForSource(history, freshLatest, "aml"),
        latest: freshLatest
      };
    }
  }
}

async function refreshVerifiedHistoryCache(target: StateTarget, options: HistoryReadOptions = {}): Promise<ProgramHistoryWindow> {
  const cacheKey = historyReadCacheKey(target, options);
  const inFlight = historyRefreshInFlight.get(cacheKey);
  if (inFlight) return inFlight;
  const promise = (async () => {
    markHistoryRefreshStarted(cacheKey);
    historyMetrics.refreshes += 1;
    try {
      const latestResult = await getLatestSnapshot();
      const latest = await latestSnapshotForHistory(target, latestResult);
      const { history, source, tail_anchor } = await readHistorySource(target, latest, options);
      historyCache.set(cacheKey, {
        checked_at: Date.now(),
        value: history,
        verified: true,
        source,
        tail_anchor,
        refresh_started_at: null,
        last_refresh_error: null
      });
      while (historyCache.size > 8) {
        const oldest = historyCache.keys().next().value;
        if (!oldest) break;
        historyCache.delete(oldest);
      }
      return history;
    } catch (error) {
      historyMetrics.refresh_errors += 1;
      markHistoryRefreshError(cacheKey, error);
      throw error;
    } finally {
      historyRefreshInFlight.delete(cacheKey);
    }
  })();
  historyRefreshInFlight.set(cacheKey, promise);
  return promise;
}

async function readVerifiedCanonicalHistory(target: StateTarget, options: HistoryReadOptions = {}): Promise<ProgramHistoryWindow> {
  if (!target.id) throw new Error(`${target.kind === "circle_program" ? "programmed Circle id" : "state program address"} is required`);
  const latestResultPromise = getLatestSnapshot();
  const history = await readCanonicalHistory(target, false, options);
  const latestResult = await latestResultPromise;
  const latest = latestResult.source === "program" && latestResult.snapshot
    ? latestResult.snapshot
    : target.kind === "circle_program"
      ? await readLatestCircleProgramSnapshot(target.id)
      : await readLatestProgramSnapshot(target.id);
  rememberLatestSummary(latest);
  try {
    const tailAnchor = assertHistoryTailWithinLag(history, latest, { maxLagSnapshots: 0 });
    const cacheKey = historyReadCacheKey(target, options);
    const entry = historyCache.get(cacheKey);
    if (entry?.source === "aml") {
      entry.verified = true;
      entry.tail_anchor = tailAnchor;
      entry.last_refresh_error = null;
      historyCache.set(cacheKey, entry);
    }
    return history;
  } catch (error) {
    const refreshed = await readCanonicalHistory(target, true, options);
    const tailAnchor = assertHistoryTailWithinLag(refreshed, latest, { maxLagSnapshots: 0 });
    const cacheKey = historyReadCacheKey(target, options);
    const entry = historyCache.get(cacheKey);
    if (entry?.source === "aml") {
      entry.verified = true;
      entry.tail_anchor = tailAnchor;
      entry.last_refresh_error = null;
      historyCache.set(cacheKey, entry);
    }
    return refreshed;
  }
}

async function readHistoryForApi(target: StateTarget, request: HistoryApiRequest): Promise<HistoryApiRead> {
  if (!target.id) throw new Error(`${target.kind === "circle_program" ? "programmed Circle id" : "state program address"} is required`);
  const options = historyReadOptionsForRequest(request);
  const cacheKey = historyReadCacheKey(target, options);
  const cached = historyCache.get(cacheKey);
  const age = historyCacheAgeMs(cached);
  historyMetrics.reads += 1;

  const cachedTailMatchesLatest = cached?.verified ? await cachedHistoryTailMatchesLatest(cached) : false;

  if (cached && cached.verified && cachedTailMatchesLatest && age !== null && age <= historyReadTtlMs) {
    historyMetrics.cache_hits += 1;
    return { history: cached.value, cache: historyCacheDiagnostic(cacheKey, cached, "fresh") };
  }

  if (
    cached &&
    cached.verified &&
    cachedTailMatchesLatest &&
    historyStaleAllowed(request) &&
    age !== null &&
    age <= historyReadTtlMs + Math.max(0, historyStaleWhileRefreshMs)
  ) {
    historyMetrics.stale_hits += 1;
    if (!historyRefreshInFlight.has(cacheKey)) {
      refreshVerifiedHistoryCache(target, options).catch((error) => {
        historyError = error instanceof Error ? error : new Error(String(error));
      });
    }
    return { history: cached.value, cache: historyCacheDiagnostic(cacheKey, cached, "stale_refreshing") };
  }

  historyMetrics.misses += 1;
  if (historyReadMode === "cache_only") {
    markHistoryRefreshError(cacheKey, new Error("history_cache_only_unavailable"));
    throw new Error("history_cache_only_unavailable");
  }
  const history = await refreshVerifiedHistoryCache(target, options);
  const entry = historyCache.get(cacheKey);
  return { history, cache: historyCacheDiagnostic(cacheKey, entry, "miss") };
}

function scheduleHistoryPrewarm(target: StateTarget): void {
  if (!historyPrewarmEnabled || !target.id) return;
  if (historyPrewarmInFlight) return;
  if (Date.now() - lastHistoryPrewarmAt < historyPrewarmMinIntervalMs) return;
  lastHistoryPrewarmAt = Date.now();
  historyMetrics.prewarm_runs += 1;
  historyPrewarmInFlight = (async () => {
    for (const windowName of historyPrewarmWindows) {
      const request = parseHistoryApiRequest(new URLSearchParams(`window=${encodeURIComponent(windowName)}`));
      if (!request.valid || !request.window) continue;
      const options = historyReadOptionsForRequest(request);
      const cacheKey = historyReadCacheKey(target, options);
      const entry = historyCache.get(cacheKey);
      const age = historyCacheAgeMs(entry);
      if (entry?.verified && age !== null && age <= historyReadTtlMs) continue;
      await refreshVerifiedHistoryCache(target, options);
    }
  })().catch((error) => {
    historyMetrics.prewarm_errors += 1;
    historyError = error instanceof Error ? error : new Error(String(error));
  }).finally(() => {
    historyPrewarmInFlight = null;
  });
}

async function resolvedStateTarget(): Promise<StateTarget> {
  const manifest = await readJsonIfExists<Record<string, any>>(join(appDir, "vitals.manifest.json"));
  return configuredStateTarget(manifest || {});
}

async function loadHistoryIntegrity(manifest: Record<string, any>): Promise<Record<string, any> | null> {
  const target = configuredStateTarget(manifest);
  if (!target.id) return null;
  try {
    const integrityCapsuleLimit = Math.max(1, Number(process.env.VITALS_HISTORY_INTEGRITY_CAPSULE_LIMIT || 3));
    const history = await readVerifiedCanonicalHistory(target, { maxSealedCapsules: integrityCapsuleLimit });
    return {
      checked_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      canonical_state_read: true,
      source: target.kind === "circle_program" ? "vitals_circle_program_history" : "vitals_state_program_history",
      history_discovery: history.history_discovery || "aml_summary_window",
      state_target_mode: target.kind,
      state_target_id: target.id,
      row_count: history.row_count,
      first_index: history.first_index,
      latest_index: history.rows[history.rows.length - 1]?.snapshot_index || 0,
      row_len: history.row_len,
      window_hash: history.window_hash,
      era_count: history.eras?.length || 0,
      eras: history.eras || [],
      proof: history.proof || null,
      capsule_limit: integrityCapsuleLimit
    };
  } catch (error) {
    historyError = error instanceof Error ? error : new Error(String(error));
    return {
      checked_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      canonical_state_read: false,
      source: "unavailable",
      error: publicError(historyError, "history_unavailable")
    };
  }
}

async function loadSiteManifest(): Promise<{ entry: string; assets: Set<string> }> {
  const manifest = await readJsonIfExists<{ entry?: unknown; assets?: unknown[] }>(join(appDir, "manifest.json"));
  const entry = typeof manifest?.entry === "string" && manifest.entry.startsWith("/") ? manifest.entry : "/index.html";
  const assets = new Set<string>();
  if (Array.isArray(manifest?.assets)) {
    for (const asset of manifest.assets) {
      if (typeof asset === "string" && asset.startsWith("/") && !asset.includes("..") && !asset.includes("\\")) {
        assets.add(asset);
      }
    }
  }
  assets.add(entry);
  return { entry, assets };
}

async function loadReleaseAssets(releasePath = join(root, "build", "site-circle-release.json")): Promise<Map<string, Record<string, any>>> {
  const release = await readJsonIfExists<Record<string, any>>(releasePath);
  const assets = new Map<string, Record<string, any>>();
  if (!Array.isArray(release?.assets)) return assets;
  for (const asset of release.assets as Array<Record<string, any>>) {
    if (typeof asset.path === "string" && asset.path.startsWith("/")) {
      assets.set(asset.path, asset);
    }
  }
  return assets;
}

function normalizeAssetPath(pathname: string, entry: string): string | null {
  const assetPath = pathname === "/" ? entry : pathname;
  if (!assetPath.startsWith("/") || assetPath.includes("..") || assetPath.includes("\\")) return null;
  return assetPath;
}

async function configuredSiteCircleId(): Promise<string | null> {
  const manifest = await readJsonIfExists<Record<string, any>>(join(appDir, "vitals.manifest.json"));
  const circleId = chooseValue(process.env.VITALS_SITE_CIRCLE_ID, manifest?.site_circle_id);
  return circleId && circleId !== "pending" ? circleId : null;
}

function configuredLabSiteCircleId(): string | null {
  const config = octraSqliteConfig();
  const circleId = chooseValue(
    process.env.VITALS_LAB_SITE_CIRCLE_ID,
    circleIdFromOctUri(config.databaseUri),
    circleIdFromOctUri(config.database)
  );
  return circleId && circleId !== "pending" ? circleId : null;
}

function releaseContentType(assetPath: string, releaseAsset: Record<string, any> | undefined): string {
  if (typeof releaseAsset?.content_type === "string" && releaseAsset.content_type.length > 0) {
    return releaseAsset.content_type;
  }
  return contentTypes[extname(assetPath)] || "application/octet-stream";
}

async function readLocalStaticAsset(assetPath: string, releaseAsset: Record<string, any> | undefined) {
  const bytes = await readLocalAssetBytes(assetPath);
  const actual = `sha256:${sha256Hex(bytes)}`;
  const expected = normalizeHash(releaseAsset?.sha256);
  if (expected && !hashMatches(actual, expected)) {
    throw new Error(`local asset hash mismatch for ${assetPath}`);
  }
  return {
    bytes,
    contentType: releaseContentType(assetPath, releaseAsset),
    source: "local" as const,
    sha256: actual,
    circleId: null,
    circleResourceKey: null,
    circleBlobHash: null,
    circleStableRoot: null,
    circleAssetsRoot: null,
    circleIntegrityChecksPassed: null
  };
}

async function readCircleStaticAsset(assetPath: string, circleId: string, releaseAsset: Record<string, any> | undefined) {
  const cacheMs = Number(process.env.VITALS_STATIC_ASSET_CACHE_MS || 60_000);
  const expected = normalizeHash(releaseAsset?.sha256);
  if (!expected) throw new Error(`release manifest missing pinned hash for ${assetPath}`);
  const cacheKey = `${circleId}:${assetPath}:${expected || "unverified"}`;
  const cached = staticAssetCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < cacheMs) return cached;

  const circleMetadataRead = loadCircleMetadataForStaticHeaders(circleId);
  const circleAsset = await octraRpc<any>("circle_asset", [circleId, assetPath]);
  const bytes = extractCircleAssetBytes(circleAsset);
  if (!bytes) throw new Error(`circle asset ${assetPath} did not return bytes`);
  const integrity = verifyCircleAssetIntegrity(circleId, assetPath, bytes, circleAsset || {});
  if (!integrity.checks_passed) {
    throw new Error(`circle asset metadata mismatch for ${assetPath}: ${integrity.errors.join(", ")}`);
  }
  const actual = `sha256:${sha256Hex(bytes)}`;
  if (expected && !hashMatches(actual, expected)) {
    throw new Error(`circle asset hash mismatch for ${assetPath}`);
  }
  const circleMetadata = await circleMetadataRead;
  const value = {
    bytes,
    contentType: releaseContentType(assetPath, releaseAsset),
    source: "circle" as const,
    sha256: actual,
    circleId,
    circleResourceKey: integrity.resource_key,
    circleBlobHash: integrity.blob_hash,
    circleStableRoot: circleMetadata.stable_root,
    circleAssetsRoot: circleMetadata.assets_root,
    circleIntegrityChecksPassed: integrity.checks_passed,
    cachedAt: Date.now()
  };
  staticAssetCache.set(cacheKey, value);
  if (staticAssetCache.size > 64) staticAssetCache = new Map([...staticAssetCache].slice(-32));
  return value;
}

async function readJsonIfExists<T = any>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function loadProgramArtifacts(
  programDirName = "program-fact-ledger",
  schema: ProgramArtifacts["schema"] = "octra-vitals-program-circle-artifacts-v0"
): Promise<ProgramArtifacts> {
  const programDir = join(root, programDirName);
  const [source, abi, formalVerification, formalCertificate, lowered] = await Promise.all([
    readTextIfExists(join(programDir, "main.aml")),
    readJsonIfExists(join(programDir, "abi.json")),
    readJsonIfExists(join(programDir, "formal_verification.json")),
    readJsonIfExists(join(programDir, "formal_certificate.json")),
    readTextIfExists(join(programDir, "lowered.oasm"))
  ]);
  return {
    schema,
    source,
    abi,
    formal_verification: formalVerification,
    formal_certificate: formalCertificate,
    lowered_oasm: lowered
  };
}

async function readFallbackSnapshot(): Promise<SnapshotArtifact> {
  try {
    const text = await readFile(latestPath, "utf8");
    return JSON.parse(text) as SnapshotArtifact;
  } catch {
    const text = await readFile(join(appDir, "latest_snapshot.sample.json"), "utf8");
    return JSON.parse(text) as SnapshotArtifact;
  }
}

async function readSubmitReceipt(snapshot: SnapshotArtifact): Promise<Record<string, any> | null> {
  const receipt = await readJsonIfExists<Record<string, any>>(latestSubmitReceiptPath);
  if (!receipt) return null;
  const expected = receipt.expected_hashes || {};
  if (expected.payload_hash && expected.payload_hash !== snapshot.envelope.payload_hash) return null;
  if (receipt.snapshot_id && receipt.snapshot_id !== snapshot.envelope.snapshot_id) return null;
  if (process.env.VITALS_ENRICH_NATIVE_RECEIPT === "0") return receipt;
  return enrichSubmitReceiptWithNativeProof(receipt, snapshot);
}

function sourceRefsHashOfSnapshot(snapshot: SnapshotArtifact): string {
  return sha256Tagged(
    SOURCE_REFS_HASH_DOMAIN,
    snapshot.canonical_source_refs || canonicalJson(snapshot.envelope.source_refs || [])
  );
}

function nativeReceiptSummary(receipt: any): Record<string, any> | null {
  if (!receipt || typeof receipt !== "object") return null;
  return {
    contract: receipt.contract || null,
    method: receipt.method || null,
    success: receipt.success ?? null,
    effort: receipt.effort ?? null,
    epoch: receipt.epoch ?? null,
    ts: receipt.ts ?? null,
    error: receipt.error ?? null,
    events: Array.isArray(receipt.events)
      ? receipt.events.map((event: any) => ({
        contract: event?.contract || null,
        event: event?.event || null,
        values: Array.isArray(event?.values) ? event.values : []
      }))
      : []
  };
}

function verifyNativeSnapshotReceipt(
  nativeReceipt: any,
  submitReceipt: Record<string, any>,
  snapshot: SnapshotArtifact
): Record<string, any> {
  const summary = nativeReceiptSummary(nativeReceipt);
  if (!summary) {
    return {
      verified: false,
      receipt: null,
      checks: { receipt_present: false }
    };
  }
  const events = Array.isArray(summary.events) ? summary.events : [];
  const snapshotEvent = events.find((event: any) => event.event === "SnapshotRecorded");
  const values = Array.isArray(snapshotEvent?.values) ? snapshotEvent.values : [];
  const expected = submitReceipt.expected_hashes || {};
  const targetId = submitReceipt.target_kind === "circle_program"
    ? submitReceipt.programmed_circle_id
    : submitReceipt.program_address;
  const sourceRefsHash = expected.source_refs_hash || sourceRefsHashOfSnapshot(snapshot);
  const checks = {
    receipt_present: true,
    contract_matches: targetId ? summary.contract === targetId : true,
    method_matches: summary.method === "record_snapshot_v0",
    success: summary.success === true,
    snapshot_event_present: Boolean(snapshotEvent),
    snapshot_id_matches: values[0] === snapshot.envelope.snapshot_id,
    snapshot_index_matches: submitReceipt.snapshot_index ? String(values[1]) === String(submitReceipt.snapshot_index) : true,
    payload_hash_matches: values[3] === snapshot.envelope.payload_hash,
    evidence_hash_matches: values[4] === snapshot.envelope.evidence_manifest_hash,
    source_refs_hash_matches: values[5] === sourceRefsHash,
    summary_hash_matches: expected.summary_hash ? values[6] === expected.summary_hash : true
  };
  return {
    verified: Object.values(checks).every(Boolean),
    receipt: summary,
    checks
  };
}

async function enrichSubmitReceiptWithNativeProof(
  receipt: Record<string, any>,
  snapshot: SnapshotArtifact
): Promise<Record<string, any>> {
  const existingNativeReceipts = Array.isArray(receipt.native_receipts) ? receipt.native_receipts : [];
  const existingVerified = existingNativeReceipts.find((entry: any) => entry?.receipt?.verified_against_call === true);
  if (existingVerified) {
    return {
      ...receipt,
      native_proof: {
        source: "latest_submit_receipt",
        checked_at: receipt.generated_at || null,
        tx_hash: existingVerified.tx_hash || receipt.tx_hash || null,
        verified: true,
        receipt: existingVerified.receipt
      }
    };
  }

  const txHash = receipt.tx_hash || (Array.isArray(receipt.tx_hashes) ? receipt.tx_hashes[receipt.tx_hashes.length - 1] : null);
  if (!txHash) return receipt;
  const cacheMs = Number(process.env.VITALS_NATIVE_RECEIPT_CACHE_MS || 5 * 60_000);
  const cacheKey = String(txHash);
  const cached = nativeReceiptProofCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < cacheMs) {
    return {
      ...receipt,
      native_proof: cached.value
    };
  }
  const checkedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  try {
    const nativeReceipt = await contractReceipt(cacheKey);
    const proof = verifyNativeSnapshotReceipt(nativeReceipt, receipt, snapshot);
    const nativeProof = {
      source: "contract_receipt",
      checked_at: checkedAt,
      tx_hash: txHash,
      ...proof
    };
    nativeReceiptProofCache.set(cacheKey, { cachedAt: Date.now(), value: nativeProof });
    if (nativeReceiptProofCache.size > 64) nativeReceiptProofCache = new Map([...nativeReceiptProofCache].slice(-32));
    return {
      ...receipt,
      native_proof: nativeProof
    };
  } catch (error) {
    const nativeProof = {
      source: "contract_receipt",
      checked_at: checkedAt,
      tx_hash: txHash,
      verified: false,
      error: publicError(error instanceof Error ? error : new Error(String(error)), "native_receipt_unavailable")
    };
    nativeReceiptProofCache.set(cacheKey, { cachedAt: Date.now(), value: nativeProof });
    if (nativeReceiptProofCache.size > 64) nativeReceiptProofCache = new Map([...nativeReceiptProofCache].slice(-32));
    return {
      ...receipt,
      native_proof: nativeProof
    };
  }
}

function publicSnapshot(snapshot: SnapshotArtifact): SnapshotArtifact {
  return publicSnapshotArtifact(snapshot);
}

interface LatestSnapshotResult {
  snapshot: SnapshotArtifact | null;
  source: SnapshotSource | "none";
  error: Error | null;
}

function authority(source: SnapshotSource | "none", manifest: Record<string, any> = {}) {
  const target = configuredStateTarget(manifest);
  const programAddress = configuredProgramAddress(manifest.state_program_address);
  const programmedCircleId = configuredProgrammedCircleId(chooseValue(process.env.VITALS_PROGRAMMED_CIRCLE_ID, manifest.programmed_circle_id));
  const siteCircleId = chooseValue(process.env.VITALS_SITE_CIRCLE_ID, manifest.site_circle_id);
  const nativeState = source === "program";
  return {
    canonical_app: "site-circle",
    canonical_state: target.kind === "circle_program" ? "vitals-circle-program" : "vitals-state-program",
    gateway_role: "https-transport-adapter",
    source_mode: stateSourceMode(),
    state_target_mode: target.kind,
    site_circle_id: siteCircleId,
    state_program_address: target.kind === "circle_program" ? null : programAddress || "pending",
    programmed_circle_id: programmedCircleId || "pending",
    state_read_from: nativeState
      ? target.kind === "circle_program" ? "vitals-circle-program" : "vitals-state-program"
      : source === "bootstrap_live" ? "gateway-bootstrap-observer" : source === "sample_fallback" ? "sample-fallback" : "unavailable",
    canonical_state_read: nativeState
  };
}

function publicError(error: Error | null, fallback: string): string {
  if (exposeErrors && error) return error.message;
  return fallback;
}

async function readLatestSnapshotLive(): Promise<LatestSnapshotResult> {
  const mode = stateSourceMode();
  const target = await resolvedStateTarget();
  if (target.id) {
    try {
      const snapshot = target.kind === "circle_program"
        ? await readLatestCircleProgramSnapshot(target.id)
        : await readLatestProgramSnapshot(target.id);
      await writeSnapshotArtifacts(snapshot, latestPath, evidenceDir);
      latestCache = snapshot;
      latestCacheAt = Date.now();
      latestCacheSource = "program";
      rememberLatestSummary(snapshot);
      latestError = null;
      lastSuccessfulProgramReadAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      return { snapshot, source: "program", error: null };
    } catch (error) {
      latestError = error instanceof Error ? error : new Error(String(error));
      if (mode === "program_required") {
        return { snapshot: null, source: "none", error: latestError };
      }
    }
  } else if (mode === "program_required") {
    latestError = new Error(`${target.kind === "circle_program" ? "Vitals programmed Circle id" : "Vitals State Program address"} is required in program_required mode`);
    return { snapshot: null, source: "none", error: latestError };
  }

  try {
    const snapshot = await buildLiveSnapshot();
    await writeSnapshotArtifacts(snapshot, latestPath, evidenceDir);
    latestCache = snapshot;
    latestCacheAt = Date.now();
    latestCacheSource = "bootstrap_live";
    latestError = null;
    return { snapshot, source: "bootstrap_live", error: null };
  } catch (error) {
    latestError = error instanceof Error ? error : new Error(String(error));
    const snapshot = await readFallbackSnapshot();
    latestCache = snapshot;
    latestCacheAt = Date.now();
    latestCacheSource = "sample_fallback";
    return { snapshot, source: "sample_fallback", error: latestError };
  }
}

async function getLatestSnapshot(): Promise<LatestSnapshotResult> {
  if (
    latestCache &&
    latestCacheSource === "program" &&
    latestReadTtlMs > 0 &&
    Date.now() - latestCacheAt <= latestReadTtlMs &&
    isFresh(latestCache)
  ) {
    rememberLatestSummary(latestCache);
    return { snapshot: latestCache, source: latestCacheSource, error: latestError };
  }
  if (latestReadInFlight) return latestReadInFlight;
  latestReadInFlight = readLatestSnapshotLive().finally(() => {
    latestReadInFlight = null;
  });
  return latestReadInFlight;
}

async function serveLatest(res: http.ServerResponse, head = false): Promise<void> {
  const [{ snapshot, source, error }, manifest] = await Promise.all([
    getLatestSnapshot(),
    loadBaseManifest()
  ]);
  const resolvedSource = source;
  if (!snapshot) {
    return json(res, 503, {
      status: "unavailable",
      source: resolvedSource,
      fresh: false,
      stale_after_ms: staleAfterMs,
      last_successful_program_read_at: lastSuccessfulProgramReadAt,
      error: publicError(error, "snapshot_unavailable"),
      authority: authority("none", manifest),
      latest_readiness: {
        status: "unavailable",
        canonical_state_read: false
      },
      native_readiness: null
    }, {}, head);
  }
  const fresh = isFresh(snapshot);
  if (!fresh) {
    return json(res, 503, {
      status: "stale",
      source: resolvedSource,
      fresh: false,
      stale_after_ms: staleAfterMs,
      snapshot_id: snapshot.envelope.snapshot_id,
      observed_at: snapshot.envelope.observed_at,
      payload_hash: snapshot.envelope.payload_hash,
      evidence_manifest_hash: snapshot.envelope.evidence_manifest_hash,
      last_successful_program_read_at: lastSuccessfulProgramReadAt,
      error: "snapshot_stale",
      authority: authority("none", manifest),
      latest_readiness: {
        status: "stale",
        canonical_state_read: false,
        freshness_checked_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
      },
      native_readiness: null
    }, {}, head);
  }
  const receipt = await readSubmitReceipt(snapshot);
  const safeSnapshot = publicSnapshot(snapshot);
  if (resolvedSource === "program") {
    scheduleHistoryPrewarm(configuredStateTarget(manifest));
  }
  const status =
    resolvedSource === "program" ? "program" :
    resolvedSource === "bootstrap_live" ? "bootstrap" :
    resolvedSource === "sample_fallback" ? "sample" :
    "unavailable";
  json(res, 200, {
    status,
    source: resolvedSource,
    fresh,
    stale_after_ms: staleAfterMs,
    last_successful_program_read_at: lastSuccessfulProgramReadAt,
    error: error ? publicError(error, "snapshot_warning") : null,
    authority: authority(resolvedSource, manifest),
    latest_readiness: {
      status: resolvedSource === "program" && fresh ? "program_latest_ready" : status,
      canonical_state_read: resolvedSource === "program",
      freshness_checked_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
    },
    native_readiness: null,
    ...safeSnapshot,
    source_refs_hash: sourceRefsHashOfSnapshot(safeSnapshot),
    payload: safeSnapshot.envelope.payload,
    source_refs: safeSnapshot.envelope.source_refs,
    receipt
  }, {}, head);
}

async function serveVersion(res: http.ServerResponse, head = false): Promise<void> {
  const manifest = await loadBaseManifest();
  const release = await readJsonIfExists<Record<string, any>>(join(root, "build", "site-circle-release.json"));
  json(res, 200, {
    ...manifest,
    release_git_commit: release?.release_git_commit || null,
    release_git_dirty: release?.release_git_dirty ?? null,
    release_generated_at: release?.generated_at || null,
    latest_snapshot_id: latestCache?.envelope?.snapshot_id || null,
    latest_payload_hash: latestCache?.envelope?.payload_hash || null,
    latest_evidence_manifest_hash: latestCache?.envelope?.evidence_manifest_hash || null,
    latest_snapshot_cache: {
      available: Boolean(latestCache),
      source: latestCache ? latestCacheSource : null,
      checked_at: latestCacheAt ? new Date(latestCacheAt).toISOString().replace(/\.\d{3}Z$/, "Z") : null,
      snapshot_id: latestCache?.envelope?.snapshot_id || null,
      payload_hash: latestCache?.envelope?.payload_hash || null
    },
    transport: "https-gateway",
    canonical_app: "site-circle",
    canonical_state: stateTargetMode() === "circle_program" ? "vitals-circle-program" : "vitals-state-program",
    authority: authority("none", manifest),
    native_readiness: null
  }, {}, head);
}

function historyCacheSnapshot(): Array<Record<string, unknown>> {
  return [...historyCache.entries()].map(([key, entry]) => ({
    key,
    checked_at: isoFromMs(entry.checked_at),
    age_ms: historyCacheAgeMs(entry),
    verified: entry.verified,
    source: entry.source,
    row_count: entry.value.row_count,
    first_index: entry.value.first_index,
    latest_index: entry.value.rows[entry.value.rows.length - 1]?.snapshot_index || 0,
    history_model: entry.value.history_discovery || null,
    proof_scope: entry.value.proof?.scope || null,
    proof_truncated: entry.value.proof?.truncated ?? null,
    refresh_in_flight: historyRefreshInFlight.has(key) || historyReadInFlight.has(key),
    last_refresh_error: entry.last_refresh_error
  }));
}

async function servePerformance(res: http.ServerResponse, head = false): Promise<void> {
  if (process.env.VITALS_EXPOSE_PERFORMANCE !== "1") return notFound(res, head);
  const manifest = await loadBaseManifest();
  json(res, 200, {
    schema: "octra-vitals-performance-v0",
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    gateway: {
      role: gatewayRole,
      uptime_seconds: Math.round(process.uptime()),
      memory: process.memoryUsage(),
      latest_cache: {
        available: Boolean(latestCache),
        source: latestCache ? latestCacheSource : null,
        checked_at: isoFromMs(latestCacheAt || null),
        age_ms: latestCacheAt ? Date.now() - latestCacheAt : null,
        snapshot_id: latestCache?.envelope?.snapshot_id || null
      },
      latest_error: latestError?.message || null,
      history_error: historyError?.message || null
    },
    history_cache: {
      read_mode: historyReadMode,
      sqlite_fallback_to_aml: sqliteHistoryFallbackToAml,
      sqlite_max_lag_snapshots: historyReplicaMaxLagSnapshots,
      remembered_latest_summary_count: recentLatestSummaries.size,
      ttl_ms: historyReadTtlMs,
      stale_while_refresh_ms: historyStaleWhileRefreshMs,
      stale_windows: [...historyApiStaleWindows],
      prewarm_enabled: historyPrewarmEnabled,
      prewarm_windows: historyPrewarmWindows,
      prewarm_in_flight: Boolean(historyPrewarmInFlight),
      metrics: historyMetrics,
      entries: historyCacheSnapshot()
    },
    static_asset_cache: {
      entries: staticAssetCache.size
    },
    rpc: octraRpcMetricsSnapshot(),
    authority: authority("none", manifest)
  }, {}, head);
}

function nativeReadiness(manifest: Record<string, any>) {
  const target = configuredStateTarget(manifest);
  const siteCircleConfigured = Boolean(manifest.site_circle_id && manifest.site_circle_id !== "pending");
  const stateProgramConfigured = Boolean(manifest.state_program_address && manifest.state_program_address !== "pending");
  const programmedCircleConfigured = Boolean(target.kind === "circle_program" && target.id);
  const stateTargetConfigured = target.kind === "circle_program" ? programmedCircleConfigured : stateProgramConfigured;
  const verified = manifest.state_program_verification_verified === true;
  const safe = manifest.state_program_verification_safety === "safe";
  const live = manifest.live_program_verification || {};
  const circleProgram = manifest.circle_program_verification || {};
  const site = manifest.site_integrity || {};
  const history = manifest.history_integrity || {};
  const liveSourceVerified = live.source_available === true && live.source_hash_matches === true;
  const liveBytecodeVerified = live.bytecode_hash_matches === true;
  const liveFormalVerified =
    live.formal_verification_available === true &&
    live.formal_verification_verified === true &&
    live.formal_verification_safe === true &&
    live.formal_verification_errors === 0 &&
    live.formal_verification_warnings === 0;
  const liveCertificateVerified =
    live.formal_certificate_available === true &&
    live.formal_certificate_matches === true;
  const localSiteVerified = site.local_assets_match === true;
  const circleSiteVerified = site.circle_assets_match === true;
  const historyVerified = history.canonical_state_read === true;
  const circleProgramVerified = circleProgram.verified === true;
  const mode = stateSourceMode();
  const stateImplementationVerified = target.kind === "circle_program"
    ? circleProgramVerified
    : verified && safe && liveSourceVerified && liveBytecodeVerified && liveFormalVerified && liveCertificateVerified;
  return {
    status: siteCircleConfigured && localSiteVerified && circleSiteVerified && stateTargetConfigured && stateImplementationVerified && historyVerified && mode === "program_required" ? "native_ready" : "program_pending_verification",
    site_circle_configured: siteCircleConfigured,
    site_release_local_verified: localSiteVerified,
    site_circle_assets_verified: circleSiteVerified,
    state_program_configured: stateProgramConfigured,
    programmed_circle_configured: programmedCircleConfigured,
    state_target_mode: target.kind,
    state_target_id: target.id || null,
    formal_verification_safe: safe,
    formal_verification_verified: verified,
    live_source_available: live.source_available === true,
    live_source_hash_matches: liveSourceVerified,
    live_bytecode_hash_matches: liveBytecodeVerified,
    live_formal_verification_verified: liveFormalVerified,
    live_formal_certificate_matches: liveCertificateVerified,
    circle_program_verified: circleProgramVerified,
    circle_program_checked_at: circleProgram.checked_at || null,
    circle_program_code_hash: circleProgram.code_hash || null,
    circle_program_expected_bytecode_hash: circleProgram.expected_bytecode_hash || null,
    circle_program_code_hash_matches: circleProgram.code_hash_matches ?? null,
    circle_program_source_hash_matches: circleProgram.source_hash_matches ?? null,
    circle_program_expected_owner: circleProgram.expected_owner || null,
    circle_program_owner: circleProgram.owner || null,
    circle_program_owner_matches: circleProgram.owner_matches ?? null,
    circle_program_expected_operator: circleProgram.expected_operator || null,
    circle_program_operator: circleProgram.operator || null,
    circle_program_operator_matches: circleProgram.operator_matches ?? null,
    circle_program_local_formal_verification_passes: circleProgram.local_formal_verification_passes ?? null,
    circle_program_local_formal_verification_verified: circleProgram.local_formal_verification_verified ?? null,
    circle_program_local_formal_verification_safe: circleProgram.local_formal_verification_safe ?? null,
    circle_program_local_formal_verification_errors: circleProgram.local_formal_verification_errors ?? null,
    circle_program_local_formal_verification_warnings: circleProgram.local_formal_verification_warnings ?? null,
    circle_program_local_formal_certificate_matches: circleProgram.local_formal_certificate_matches ?? null,
    circle_program_rpc_agreement: circleProgram.rpc_agreement ?? null,
    circle_program_rpc_urls_checked: circleProgram.rpc_urls_checked ?? null,
    circle_program_rpc_urls_minimum: circleProgram.rpc_urls_minimum ?? null,
    circle_program_rpc_urls_minimum_met: circleProgram.rpc_urls_minimum_met ?? null,
    circle_program_rpc_mismatches: circleProgram.rpc_mismatches || [],
    circle_program_required_methods_present: circleProgram.required_methods_present ?? null,
    circle_program_missing_methods: circleProgram.missing_methods || [],
    circle_program_initialized: circleProgram.initialized ?? null,
    circle_program_browser_mode: circleProgram.browser_mode || null,
    circle_program_resource_mode: circleProgram.resource_mode || null,
    live_program_checked_at: live.checked_at || null,
    live_program_errors: {
      contract_source: live.contract_source_error || null,
      vm_contract: live.vm_contract_error || null
    },
    circle_program_errors: circleProgram.errors || null,
    canonical_history_readable: historyVerified,
      history_rows: history.row_count || 0,
      history_window_hash: history.window_hash || null,
      history_proof_scope: history.proof?.scope || null,
      history_proof_truncated: history.proof?.truncated ?? null,
      history_sealed_capsule_total_count: history.proof?.sealed_capsule_total_count ?? null,
      history_sealed_capsule_verified_count: history.proof?.sealed_capsule_verified_count ?? null,
      history_capsule_limit: history.proof?.capsule_limit ?? null,
    successor_set: live.successor_set ?? null,
    successor_program: live.successor_program || null,
    state_source_mode: mode,
    production_requires_program_state: mode === "program_required"
  };
}

function authorityForReadiness(readiness: ReturnType<typeof nativeReadiness>, manifest: Record<string, any>) {
  return authority(readiness.status === "native_ready" ? "program" : "none", manifest);
}

async function serveNativeReadiness(res: http.ServerResponse, head = false): Promise<void> {
  const manifest = await loadManifest();
  const readiness = nativeReadiness(manifest);
  json(res, 200, {
    schema: "octra-vitals-native-readiness-v0",
    authority: authorityForReadiness(readiness, manifest),
    native_readiness: readiness
  }, {}, head);
}

async function serveSiteIntegrity(res: http.ServerResponse, head = false): Promise<void> {
  const manifest = await loadBaseManifest();
  const siteIntegrity = await loadSiteIntegrity(manifest);
  json(res, 200, {
    schema: "octra-vitals-site-integrity-v0",
    site_integrity: siteIntegrity
  }, {}, head);
}

async function serveHistory(res: http.ServerResponse, url: URL, head = false): Promise<void> {
  const manifest = await loadBaseManifest();
  const target = configuredStateTarget(manifest);
  const historyRequest = parseHistoryApiRequest(url.searchParams);
  if (!target.id) {
    const coverage = historyApiCoverage([], [], historyRequest);
    return json(res, 200, {
      schema: LEGACY_HISTORY_SCHEMA,
      api_schema: HISTORY_API_SCHEMA,
      history_model: "unavailable",
      generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      request: historyRequest,
      coverage,
      proof: emptyHistoryProof("unavailable", false),
      snapshots: [],
      authority: {
        source: "unavailable",
        canonical_state_read: false,
        state_target_mode: target.kind,
        reason: target.kind === "circle_program" ? "programmed_circle_unconfigured" : "state_program_unconfigured"
      }
    }, {}, head);
  }
  try {
    const { history, cache } = await readHistoryForApi(target, historyRequest);
    const allSnapshots = history.rows.map((row) => ({
      snapshot_index: row.snapshot_index,
      snapshot_id: `vitals.${new Date(row.observed_at_unix * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")}`,
      observed_at: new Date(row.observed_at_unix * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      octra_epoch: row.octra_epoch,
      external_block: row.external_block,
      payload_hash_prefix: row.payload_hash_prefix,
      route_count: row.route_count,
      supply: {
        issued_oct_raw: row.issued_raw,
        burned_oct_raw: row.burned_raw,
        confirmed_burned_oct_raw: row.burned_raw,
        encrypted_oct_raw: row.encrypted_raw
      },
      bridge: {
        total_locked_oct_raw: row.total_locked_raw,
        woct_supply_raw: row.total_wrapped_raw,
        unclaimed_oct_raw: row.total_unclaimed_raw
      }
    }));
    const snapshots = filterHistorySnapshots(allSnapshots, historyRequest);
    const coverage = historyApiCoverage(allSnapshots, snapshots, historyRequest);
    const historyModel = history.history_discovery || "aml_summary_window";
    const proofHints: Parameters<typeof verifiedHistoryProof>[5] = {};
    if (history.proof?.scope) proofHints.proof_scope = history.proof.scope;
    if (history.proof?.truncated !== undefined) proofHints.truncated = history.proof.truncated;
    if (history.proof?.sealed_capsule_start_ordinal !== undefined) proofHints.sealed_capsule_start_ordinal = history.proof.sealed_capsule_start_ordinal;
    if (history.proof?.sealed_capsule_total_count !== undefined) proofHints.sealed_capsule_total_count = history.proof.sealed_capsule_total_count;
    if (history.proof?.sealed_capsule_verified_count !== undefined) proofHints.sealed_capsule_verified_count = history.proof.sealed_capsule_verified_count;
    if (history.proof?.capsule_limit !== undefined) proofHints.capsule_limit = history.proof.capsule_limit;
    const isCanonicalHistoryRead = cache.source === "aml";
    const historyRead = publicHistoryRead(cache, history);
    return json(res, 200, {
      schema: LEGACY_HISTORY_SCHEMA,
      api_schema: HISTORY_API_SCHEMA,
      history_model: historyModel,
      generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      request: historyRequest,
      first_index: history.first_index,
      row_count: snapshots.length,
      available_row_count: history.row_count,
      row_len: history.row_len,
      window_hash: history.window_hash,
      coverage,
      proof: verifiedHistoryProof(historyModel, true, history.eras || [], history.proof?.families || [], history.proof?.capsules || [], proofHints),
      snapshots,
      authority: {
        canonical_authority: "aml_fact_ledger",
        source: isCanonicalHistoryRead
          ? target.kind === "circle_program" ? "vitals_circle_program_history" : "vitals_state_program_history"
          : "sqlite_history_mirror",
        canonical_state_read: isCanonicalHistoryRead,
        history_read: historyRead,
        history_discovery: historyModel,
        state_target_mode: target.kind,
        state_target_id: target.id,
        state_program_address: target.kind === "state_program" ? target.id : configuredProgramAddress(manifest.state_program_address),
        programmed_circle_id: target.kind === "circle_program" ? target.id : null,
        note: isCanonicalHistoryRead
          ? "Rows are compact AML summary commitments; latest row is verified against the latest payload by the gateway."
          : "Rows are served from the derived SQLite history mirror and the latest row is anchored to the AML latest summary; AML remains canonical."
      }
    }, {}, head);
  } catch (error) {
    historyError = error instanceof Error ? error : new Error(String(error));
    const coverage = historyApiCoverage([], [], historyRequest);
    return json(res, 200, {
      schema: LEGACY_HISTORY_SCHEMA,
      api_schema: HISTORY_API_SCHEMA,
      history_model: "unavailable",
      generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      request: historyRequest,
      coverage,
      proof: emptyHistoryProof("unavailable", false),
      snapshots: [],
      authority: {
        canonical_authority: "aml_fact_ledger",
        source: "unavailable",
        canonical_state_read: false,
        history_read: {
          read_result: "unavailable",
          serving_path: "unavailable",
          backing_path: "unavailable",
          configured_read_path: configuredHistoryReadPath(),
          checked_at: null,
          age_ms: null,
          usable_for_display: false,
          verification_level: "unavailable"
        },
        state_target_mode: target.kind,
        state_target_id: target.id,
        state_program_address: target.kind === "state_program" ? target.id : configuredProgramAddress(manifest.state_program_address),
        programmed_circle_id: target.kind === "circle_program" ? target.id : null,
        error: publicError(historyError, "history_unavailable")
      }
    }, {}, head);
  }
}

function labHistoryAuthority(config = octraSqliteConfig()): Record<string, any> {
  return {
    canonical_state: "aml_fact_ledger",
    lab_database_role: "derived_query_mirror",
    lab_database_canonical: false,
    lab_database_enabled: config.enabled,
    lab_database_reason: config.reason,
    lab_database_network: config.network,
    lab_database: config.database,
    lab_database_uri: config.databaseUri,
    lab_read_token_required: false,
    lab_admin_sync_token_required: true,
    lab_admin_sync_token_configured: Boolean(labWriteToken())
  };
}

function labWriteToken(): string | null {
  const token = process.env.VITALS_LAB_HISTORY_WRITE_TOKEN?.trim();
  return token && token.length >= 16 ? token : null;
}

function labHeaderValue(req: http.IncomingMessage, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] || null;
  return value || null;
}

function labWriteAuthorized(req: http.IncomingMessage): boolean {
  const token = labWriteToken();
  if (!token) return false;
  const bearer = labHeaderValue(req, "authorization")?.replace(/^Bearer\s+/i, "");
  const candidate = labHeaderValue(req, "x-octra-lab-token") || bearer;
  if (!candidate) return false;
  const expected = Buffer.from(token);
  const received = Buffer.from(candidate.trim());
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function labWriteRequired(res: http.ServerResponse, head = false): void {
  return json(res, 403, {
    error: "lab_write_token_required",
    message: "Lab admin sync requires the host-local lab token."
  }, {}, head);
}

function labQueryClientKey(req: http.IncomingMessage): string {
  const forwarded = labHeaderValue(req, "x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.socket.remoteAddress || "unknown";
}

function labQueryRateAllowed(req: http.IncomingMessage): boolean {
  const now = Date.now();
  const key = labQueryClientKey(req);
  for (const [client, bucket] of labQueryRates.entries()) {
    if (now - bucket.startedAt > labQueryRateWindowMs * 2) labQueryRates.delete(client);
  }
  const bucket = labQueryRates.get(key);
  if (!bucket || now - bucket.startedAt >= labQueryRateWindowMs) {
    labQueryRates.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (bucket.count >= labQueryRateMax) return false;
  bucket.count += 1;
  return true;
}

function acquireLabQuerySlot(): boolean {
  if (activeLabQueries >= labQueryMaxConcurrent) return false;
  activeLabQueries += 1;
  return true;
}

function releaseLabQuerySlot(): void {
  activeLabQueries = Math.max(0, activeLabQueries - 1);
}

async function serveLabApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL, head = false): Promise<void> {
  const config = octraSqliteConfig();
  if (!config.enabled) return notFound(res, head);
  if (url.pathname === "/api/lab/status" && (req.method === "GET" || head)) {
    let database: Record<string, any> | null = null;
    try {
      database = await labStatus();
    } catch (error) {
      database = {
        error: publicError(error instanceof Error ? error : new Error(String(error)), "lab_status_unavailable")
      };
    }
    return json(res, 200, {
      schema: "octra-vitals-lab-status-v0",
      generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      authority: labHistoryAuthority(config),
      database
    }, {}, head);
  }
  if (url.pathname === "/api/lab/tables" && (req.method === "GET" || head)) {
    return json(res, 200, {
      schema: "octra-vitals-lab-tables-v0",
      authority: labHistoryAuthority(config),
      result: await labTables()
    }, {}, head);
  }
  if (url.pathname === "/api/lab/schema" && (req.method === "GET" || head)) {
    return json(res, 200, {
      schema: "octra-vitals-lab-schema-v0",
      authority: labHistoryAuthority(config),
      result: await labSchema()
    }, {}, head);
  }
  if (url.pathname === "/api/lab/history" && (req.method === "GET" || head)) {
    return json(res, 200, {
      schema: "octra-vitals-lab-history-query-v0",
      authority: labHistoryAuthority(config),
      result: await octraSqliteReadOnlyQuery(labHistorySql(url.searchParams.get("window")), url.searchParams.get("limit") || 500)
    }, {}, head);
  }
  if (url.pathname === "/api/lab/query" && req.method === "POST") {
    if (!labQueryRateAllowed(req)) {
      return json(res, 429, {
        error: "lab_query_rate_limited",
        message: "Too many Lab queries. Wait a moment and retry."
      }, { "Retry-After": String(Math.ceil(labQueryRateWindowMs / 1000)) }, head);
    }
    if (!acquireLabQuerySlot()) {
      return json(res, 503, {
        error: "lab_query_busy",
        message: "Lab query capacity is busy. Retry shortly."
      }, {}, head);
    }
    let body: Record<string, any>;
    try {
      body = await readRequestJson(req);
    } catch {
      releaseLabQuerySlot();
      return json(res, 400, {
        error: "invalid_json_body",
        message: "Expected a JSON body with sql and optional limit."
      }, {}, head);
    }
    try {
      return json(res, 200, {
        schema: "octra-vitals-lab-query-v0",
        authority: labHistoryAuthority(config),
        result: await octraSqliteReadOnlyQuery(String(body.sql || ""), body.limit)
      });
    } catch (error) {
      const guardError = publicLabQueryError(error);
      if (guardError) return json(res, 400, guardError, {}, head);
      return json(res, 400, {
        error: "lab_query_result_too_large_or_unsupported",
        message: publicError(
          error instanceof Error ? error : new Error(String(error)),
          "Result is too large for one Circle read, or the query is unsupported. Lower the limit or select fewer columns."
        )
      }, {}, head);
    } finally {
      releaseLabQuerySlot();
    }
  }
  if (url.pathname === "/api/lab/mirror/sync" && req.method === "POST") {
    if (!labWriteAuthorized(req)) return labWriteRequired(res, head);
    const manifest = await loadBaseManifest();
    const target = configuredStateTarget(manifest);
    if (!target.id) {
      return json(res, 503, {
        error: "canonical_state_target_unconfigured",
        authority: labHistoryAuthority(config)
      });
    }
    try {
      const history = await readVerifiedCanonicalHistory(target);
      const mirror = await mirrorLabHistory(history, {
        target_kind: target.kind,
        target_id: target.id
      });
      return json(res, 200, {
        schema: "octra-vitals-lab-sync-v0",
        authority: {
          ...labHistoryAuthority(config),
          state_target_mode: target.kind,
          state_target_id: target.id,
          canonical_history_readback_verified: true
        },
        mirror
      });
    } catch (error) {
      return json(res, 502, {
        error: "lab_sync_failed",
        message: publicError(error instanceof Error ? error : new Error(String(error)), "lab_sync_failed"),
        authority: labHistoryAuthority(config)
      }, {}, head);
    }
  }
  return methodNotAllowed(res, head);
}

async function serveProgramArtifacts(res: http.ServerResponse, head = false): Promise<void> {
  if (process.env.VITALS_EXPOSE_PROGRAM_ARTIFACTS !== "1") return notFound(res, head);
  const artifacts = await loadProgramArtifacts("program-fact-ledger", "octra-vitals-program-circle-artifacts-v0");
  json(res, 200, artifacts, {}, head);
}

async function readJsonEvidenceText(file: string, maxFileBytes?: number): Promise<{ text: string; compressed: boolean; stored_bytes: number }> {
  try {
    const info = await stat(file);
    if (maxFileBytes !== undefined && info.size > maxFileBytes) {
      const error = new Error("raw_evidence_too_large");
      (error as any).stored_bytes = info.size;
      throw error;
    }
    return { text: await readFile(file, "utf8"), compressed: false, stored_bytes: info.size };
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  const gzFile = `${file}.gz`;
  const info = await stat(gzFile);
  if (maxFileBytes !== undefined && info.size > maxFileBytes) {
    const error = new Error("raw_evidence_too_large");
    (error as any).stored_bytes = info.size;
    throw error;
  }
  const bytes = await readFile(gzFile);
  return { text: gunzipSync(bytes).toString("utf8"), compressed: true, stored_bytes: info.size };
}

function rawEvidenceView(raw: any): Record<string, unknown> {
  const { body, schema: _schema, ...rest } = raw;
  let bodyJson: unknown;
  try {
    bodyJson = JSON.parse(body);
  } catch {
    bodyJson = null;
  }
  return {
    schema: "octra-vitals-raw-evidence-view-v0",
    ...rest,
    body_sha256: raw.response_hash,
    body_json: bodyJson
  };
}

async function serveEvidence(res: http.ServerResponse, url: URL, head = false): Promise<void> {
  const pathname = url.pathname;
  const immutableJsonHeaders = {
    "Cache-Control": "public, max-age=3600, immutable"
  };
  const rawMatch = pathname.match(/^\/api\/evidence\/raw\/([a-fA-F0-9]{64})$/);
  if (rawMatch) {
    const rawHash = rawMatch[1];
    if (!rawHash) return notFound(res);
    const expected = `sha256:${rawHash.toLowerCase()}`;
    const file = join(evidenceDir, "raw", `${rawHash.toLowerCase()}.json`);
    try {
      const maxFileBytes = positiveIntegerEnv("VITALS_RAW_EVIDENCE_MAX_FILE_BYTES", 6_000_000);
      const { text, compressed, stored_bytes } = await readJsonEvidenceText(file, maxFileBytes);
      const parsed = JSON.parse(text);
      if (parsed.response_hash !== expected || typeof parsed.body !== "string" || responseHash(parsed.body) !== expected) {
        throw new Error("raw evidence hash mismatch");
      }
      const rawWrapperRequested = url.searchParams.get("raw") === "1";
      if (!rawWrapperRequested) {
        return json(res, 200, {
          ...rawEvidenceView(parsed),
          storage: { compressed, stored_bytes }
        }, immutableJsonHeaders, head);
      }
      if (url.searchParams.get("exact") !== "1") {
        return json(res, 200, parsed, immutableJsonHeaders, head);
      }
      writeBufferedResponse(res, 200, "application/json; charset=utf-8", Buffer.from(text), immutableJsonHeaders, head);
    } catch (error: any) {
      if (error?.message === "raw_evidence_too_large") {
        return json(res, 413, {
          error: "raw_evidence_too_large",
          max_bytes: positiveIntegerEnv("VITALS_RAW_EVIDENCE_MAX_FILE_BYTES", 6_000_000),
          stored_bytes: error?.stored_bytes ?? null
        }, {}, head);
      }
      notFound(res);
    }
    return;
  }
  const match = pathname.match(/^\/api\/evidence\/([a-fA-F0-9]{64})$/);
  if (!match) return notFound(res);
  const evidenceHash = match[1];
  if (!evidenceHash) return notFound(res);
  const expected = `sha256:${evidenceHash.toLowerCase()}`;
  const file = join(evidenceDir, `${evidenceHash.toLowerCase()}.json`);
  try {
    const { text } = await readJsonEvidenceText(file);
    const parsed = JSON.parse(text);
    if (sha256Tagged(EVIDENCE_HASH_DOMAIN, canonicalJson(parsed)) !== expected) {
      throw new Error("evidence manifest hash mismatch");
    }
    if (url.searchParams.get("exact") !== "1") {
      return json(res, 200, parsed, immutableJsonHeaders, head);
    }
    writeBufferedResponse(res, 200, "application/json; charset=utf-8", Buffer.from(text), immutableJsonHeaders, head);
  } catch {
    notFound(res);
  }
}

function writeStaticAssetResponse(
  res: http.ServerResponse,
  assetPath: string,
  asset: Awaited<ReturnType<typeof readLocalStaticAsset>> | Awaited<ReturnType<typeof readCircleStaticAsset>>,
  head = false
): void {
  const headers: Record<string, string | number> = {
    "Cache-Control": staticCacheControl(assetPath),
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Octra-Asset-Source": asset.source,
    "X-Octra-Asset-SHA256": asset.sha256
  };
  if (asset.circleId) headers["X-Octra-Circle-ID"] = asset.circleId;
  if (asset.circleResourceKey) headers["X-Octra-Circle-Resource-Key"] = asset.circleResourceKey;
  if (asset.circleBlobHash) headers["X-Octra-Circle-Blob-Hash"] = asset.circleBlobHash;
  if (asset.circleStableRoot) headers["X-Octra-Circle-Stable-Root"] = asset.circleStableRoot;
  if (asset.circleAssetsRoot) headers["X-Octra-Circle-Assets-Root"] = asset.circleAssetsRoot;
  if (asset.circleIntegrityChecksPassed !== null) {
    headers["X-Octra-Circle-Consistency"] = asset.circleIntegrityChecksPassed ? "verified" : "failed";
  }
  writeBufferedResponse(res, 200, asset.contentType, asset.bytes, headers, head);
}

async function serveLabStatic(res: http.ServerResponse, pathname: string, head = false): Promise<void> {
  const config = octraSqliteConfig();
  if (!config.enabled) return notFound(res, head);
  const assetPath = pathname === "/lab/history" || pathname === "/lab/history/" ? "/lab-history.html" : pathname;
  if (!labStaticAssets.has(assetPath)) return notFound(res, head);
  const releaseAssets = await loadReleaseAssets(join(root, "build", "lab-site-circle-release.json"));
  const releaseAsset = releaseAssets.get(assetPath);
  if (!releaseAsset || !normalizeHash(releaseAsset.sha256)) {
    return json(res, 503, {
      error: "lab_pinned_asset_hash_missing",
      path: assetPath
    }, {}, head);
  }
  const circleId = configuredLabSiteCircleId();
  if (!circleId) {
    return json(res, 503, { error: "lab_circle_unavailable" }, {}, head);
  }
  try {
    const asset = await readCircleStaticAsset(assetPath, circleId, releaseAsset);
    return writeStaticAssetResponse(res, assetPath, asset, head);
  } catch (error) {
    return json(res, 502, {
      error: "lab_circle_asset_unavailable",
      path: assetPath,
      message: publicError(error instanceof Error ? error : new Error(String(error)), "lab_circle_asset_unavailable")
    }, {}, head);
  }
}

async function serveStatic(res: http.ServerResponse, pathname: string, head = false): Promise<void> {
  const siteManifest = await loadSiteManifest();
  const assetPath = normalizeAssetPath(pathname, siteManifest.entry);
  if (!assetPath || !siteManifest.assets.has(assetPath)) return notFound(res, head);

  const releaseAssets = await loadReleaseAssets();
  const releaseAsset = releaseAssets.get(assetPath);
  const sourceMode = staticAssetSource();
  let asset: Awaited<ReturnType<typeof readLocalStaticAsset>> | Awaited<ReturnType<typeof readCircleStaticAsset>>;

  if (sourceMode === "local") {
    asset = await readLocalStaticAsset(assetPath, releaseAsset);
  } else {
    if (!releaseAsset || !normalizeHash(releaseAsset.sha256)) {
      if (sourceMode === "circle_required") {
        return json(res, 503, {
          error: "pinned_asset_hash_missing",
          path: assetPath
        }, {}, head);
      }
      asset = await readLocalStaticAsset(assetPath, releaseAsset);
    } else {
      const circleId = await configuredSiteCircleId();
      if (!circleId) {
        if (sourceMode === "circle_required") {
          return json(res, 503, { error: "site_circle_unavailable" }, {}, head);
        }
        asset = await readLocalStaticAsset(assetPath, releaseAsset);
      } else {
        try {
          asset = await readCircleStaticAsset(assetPath, circleId, releaseAsset);
        } catch (error) {
          if (sourceMode === "circle_required") {
            return json(res, 502, {
              error: "circle_asset_unavailable",
              path: assetPath,
              message: publicError(error instanceof Error ? error : new Error(String(error)), "circle_asset_unavailable")
            }, {}, head);
          }
          asset = await readLocalStaticAsset(assetPath, releaseAsset);
        }
      }
    }
  }

  return writeStaticAssetResponse(res, assetPath, asset, head);
}

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method === "OPTIONS") return options(res);
  const head = req.method === "HEAD";
  const headerHost = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host;
  if (!hostAllowed(headerHost)) return misdirectedRequest(res, head);
  const url = new URL(req.url || "/", `http://${headerHost || `${host}:${port}`}`);
  if (url.pathname.startsWith("/api/lab/")) return serveLabApi(req, res, url, head);
  if (req.method !== "GET" && !head) return methodNotAllowed(res);
  if (url.pathname === "/api/latest") return serveLatest(res, head);
  if (url.pathname === "/api/version" || url.pathname === "/version") return serveVersion(res, head);
  if (url.pathname === "/api/performance") return servePerformance(res, head);
  if (url.pathname === "/api/native-readiness") return serveNativeReadiness(res, head);
  if (url.pathname === "/api/site-integrity") return serveSiteIntegrity(res, head);
  if (url.pathname === "/api/history") return serveHistory(res, url, head);
  if (url.pathname === "/api/program/artifacts") return serveProgramArtifacts(res, head);
  if (url.pathname === "/health") return json(res, 200, { ok: true, service: "octra-vitals-gateway" }, {}, head);
  if (url.pathname.startsWith("/api/evidence/")) return serveEvidence(res, url, head);
  if (url.pathname === "/lab/history" || url.pathname === "/lab/history/") return serveLabStatic(res, url.pathname, head);
  if (url.pathname.startsWith("/lab-history.")) {
    return serveLabStatic(res, url.pathname, head);
  }
  return serveStatic(res, url.pathname, head);
}

await mkdir(evidenceDir, { recursive: true });

const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
  const startedAtNs = process.hrtime.bigint();
  (res as any).__octraRequest = req;
  if (trafficRecorder) {
    res.once("finish", () => trafficRecorder.record(req, res, startedAtNs));
  }
  route(req, res).catch((error) => {
    console.error(error);
    if (res.headersSent) {
      res.end();
      return;
    }
    json(res, 500, { error: "internal_error", message: exposeErrors && error instanceof Error ? error.message : "request_failed" });
  });
});

if (trafficRecorder) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      trafficRecorder.flush()
        .catch((error) => console.warn("traffic aggregate final flush failed", error instanceof Error ? error.message : String(error)))
        .finally(() => process.kill(process.pid, signal));
    });
  }
}

server.listen(port, host, () => {
  console.log(`Octra Vitals gateway listening on http://${host}:${port}`);
});
