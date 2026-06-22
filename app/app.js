"use strict";

const DEFAULT_OCTRA_SCAN_ADDRESS = "https://octrascan.io/address.html?addr=";
const DEFAULT_OCTRA_SCAN_TX = "https://octrascan.io/tx.html?hash=";
const ETHERSCAN = "https://etherscan.io";

/* ============================================================================
   EMPTY DATA — non-rendered bootstrap placeholder. The app fails closed if the
   gateway/program snapshot is unavailable; this object only lets functions bind
   before the async load completes.
   ============================================================================ */
const EMPTY_DATA = Object.freeze({
  snapshot: {
    id: "unavailable",
    observed_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    octra_epoch: 0,
    eth_block: 0,
    eth_block_hex: "0x0",
    network: "unknown",
    validator: "pending",
    txid_hi: 0
  },
  supply_raw: {
    max: "0",
    in_circulation: "0",
    public: "0",
    encrypted: "0",
    not_in_circulation: "0",
    confirmed_burned: "0",
    unattributed: "0"
  },
  bridge_raw: {
    vault: "0",
    locked: "0",
    unlocked_cum: "0",
    woct: "0",
    unclaimed: "0",
    unclassified: "0",
    unclassified_signed: "0",
    claim_balance: "0",
    claim_overage: "0",
    vault_surplus: "0",
    gross_locked: "0",
    lock_nonce: 0,
    unlock_count: 0,
    recipients: 0
  },
  clocks: { octra_epoch:0, relayer_finalized:0, recovery_scanned:0, eth_block:0 },
  health: { conservation: { status:"red", ok:false, flags:["unavailable"], deltas:{} } },
  prov: {
    program: "pending",
    program_kind: "circle_program",
    site_circle: "pending",
    vault: "pending",
    woct: "pending",
    ethBridge: "pending",
    burn_tx: null,
    relayer_mode: "unknown",
    quorum: null,
    src_chain: 7777,
    dst_chain: 1
  },
  series: [],
  history_points: 0
});
const COL = { T:0, EPOCH:1, INCIRC:2, ENC:3, LOCKED:4, WOCT:5, UNCLAIMED:6, UNCLASS:7, BURN:8 };
const HISTORY_WINDOWS = Object.freeze({
  "1d": { label: "1d", ms: 24 * 60 * 60 * 1000 },
  "7d": { label: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
  "30d": { label: "30d", ms: 30 * 24 * 60 * 60 * 1000 }
});
const DEFAULT_HISTORY_WINDOW = "1d";
const MAX_HISTORY_POINTS = 30 * 24 * 4 + 8; // 30 days at the current ~15-minute cadence, plus a little drift.

/* ============================================================================
   THE ONE SHARED ACCOUNTING CORE.
   Every displayed number is computed HERE, once, with BigInt. Acts I/II/III all
   read from the returned object — no figure is derived in two places.
   ============================================================================ */
const RAW = 1000000n; // 1 OCT in raw micro-OCT

function unique(values){
  return [...new Set(values.filter(Boolean))];
}

let APP_CONFIG = {};

function isLocalishOrigin(){
  const host = window.location.hostname;
  return !host || host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function isStaticOnlyOrigin(){
  return window.location.protocol === "oct:" || window.location.protocol === "file:";
}

function configuredGatewayOrigin(config=APP_CONFIG){
  const raw = config?.gateway_origin || config?.gateway?.origin || config?.public_gateway_origin;
  if(typeof raw !== "string" || !/^https?:\/\//.test(raw)) return null;
  return raw.replace(/\/+$/, "");
}

function apiHref(path){
  if(window.location.protocol === "oct:" || window.location.protocol === "file:"){
    const gateway = configuredGatewayOrigin();
    if(gateway) return gateway + path;
  }
  return path;
}

function configuredScanBase(kind){
  const key = kind === "tx" ? "octra_scan_tx_url" : "octra_scan_address_url";
  const nested = kind === "tx" ? APP_CONFIG?.explorers?.octra_tx_url : APP_CONFIG?.explorers?.octra_address_url;
  const configured = APP_CONFIG?.[key] || nested;
  if(typeof configured === "string" && /^https?:\/\//.test(configured)) return configured;
  const host = String(location.hostname || "").toLowerCase();
  const origin = String(APP_CONFIG?.gateway_origin || "").toLowerCase();
  const role = String(APP_CONFIG?.gateway_role || "").toLowerCase();
  const devnet = host === "devnet.octra.live" ||
    host === "octra-dev.exe.xyz" ||
    origin.includes("devnet.octra.live") ||
    origin.includes("octra-dev.exe.xyz") ||
    role === "dev" ||
    role === "devnet";
  if(devnet) return kind === "tx" ? "https://devnet.octrascan.io/tx.html?hash=" : "https://devnet.octrascan.io/address.html?addr=";
  return kind === "tx" ? DEFAULT_OCTRA_SCAN_TX : DEFAULT_OCTRA_SCAN_ADDRESS;
}

function octraAddressHref(address){
  return configuredScanBase("address") + encodeURIComponent(address);
}

function octraTxHref(hash){
  return configuredScanBase("tx") + encodeURIComponent(hash);
}

function endpointCandidates(path, staticFallback, opts={}){
  const localish = isLocalishOrigin();
  const gateway = opts.gatewayOrigin || configuredGatewayOrigin();
  const candidates = [path];
  if(gateway && (opts.forceGateway || localish || window.location.protocol === "file:" || window.location.protocol === "oct:")){
    candidates.push(gateway + path);
  }
  if(staticFallback && opts.allowStaticFallback) candidates.push(staticFallback);
  return unique(candidates);
}

async function fetchJson(url){
  const response = await fetch(url, { cache:"no-store" });
  if(!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function fetchFirst(candidates){
  let lastError;
  for(const url of candidates){
    try{
      return { url, body: await fetchJson(url) };
    }catch(error){
      lastError = error;
    }
  }
  throw lastError || new Error("No fetch candidates available");
}

function nativeProgramAddress(config=APP_CONFIG){
  const value = config?.state_program_address || config?.authority?.state_program_address;
  return typeof value === "string" && value && value !== "pending" ? value : null;
}

function nativeProgrammedCircleId(config=APP_CONFIG){
  const value = config?.programmed_circle_id || config?.authority?.programmed_circle_id;
  return typeof value === "string" && value && value !== "pending" ? value : null;
}

function nativeStateTarget(config=APP_CONFIG){
  if((config?.state_target_mode || config?.authority?.state_target_mode) === "circle_program"){
    const circleId = nativeProgrammedCircleId(config);
    if(circleId) return { kind:"circle_program", id:circleId };
  }
  const programAddress = nativeProgramAddress(config);
  return programAddress ? { kind:"state_program", id:programAddress } : null;
}

function isCircleClientOrigin(){
  return window.location.protocol === "oct:" ||
    window.location.pathname.startsWith("/oct/") ||
    (window.location.hostname === "127.0.0.1" && window.location.port === "8420");
}

function unwrapContractResult(value){
  if(value && typeof value === "object" && "result" in value) return unwrapContractResult(value.result);
  return value;
}

async function callNativeProvider(address, method, params=[]){
  const providers = [
    window.octra,
    window.octraClient,
    window.octraBrowser,
    window.octraNative
  ].filter(Boolean);
  const callParams = [address, method, params];
  for(const provider of providers){
    if(typeof provider.contractCall === "function"){
      return unwrapContractResult(await provider.contractCall(address, method, params));
    }
    if(typeof provider.contract_call === "function"){
      return unwrapContractResult(await provider.contract_call(address, method, params));
    }
    if(typeof provider.request === "function"){
      return unwrapContractResult(await provider.request({method:"contract_call", params:callParams}));
    }
    if(typeof provider.rpc === "function"){
      return unwrapContractResult(await provider.rpc("contract_call", callParams));
    }
  }
  throw new Error("no injected Octra contract_call provider");
}

async function callLocalClientRpc(address, method, params=[]){
  if(!isCircleClientOrigin()) throw new Error("not running in the Octra circle client");
  const request = {jsonrpc:"2.0", id:1, method:"contract_call", params:[address, method, params]};
  const routes = ["/api/rpc", "/api/jsonrpc", "/rpc"];
  let lastError;
  for(const route of routes){
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), 600);
    try{
      const response = await fetch(route, {
        method:"POST",
        headers:{"Content-Type":"application/json", Accept:"application/json"},
        body:JSON.stringify(request),
        cache:"no-store",
        signal:controller.signal
      });
      const body = await response.json();
      if(!response.ok || body.error) throw new Error(body.error?.message || `${route} returned ${response.status}`);
      return unwrapContractResult(body);
    }catch(error){
      lastError = error;
    }finally{
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("local Octra RPC bridge unavailable");
}

async function nativeContractCall(address, method, params=[]){
  try{
    return await callNativeProvider(address, method, params);
  }catch(providerError){
    try{
      return await callLocalClientRpc(address, method, params);
    }catch(localError){
      throw providerError || localError;
    }
  }
}

async function nativeCircleProgramCall(circleId, method, params=[]){
  if(window.OctraCircle?.request){
    return unwrapContractResult(await window.OctraCircle.request("program.view", { method, params }));
  }
  if(!isCircleClientOrigin()) throw new Error("not running in the Octra circle client");
  const routes = ["/api/program/view"];
  let lastError;
  for(const route of routes){
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), 800);
    try{
      const response = await fetch(route, {
        method:"POST",
        headers:{"Content-Type":"application/json", Accept:"application/json"},
        body:JSON.stringify({ circle_id:circleId, method, params }),
        cache:"no-store",
        signal:controller.signal
      });
      const body = await response.json();
      if(!response.ok || body.error) throw new Error(body.error?.message || `${route} returned ${response.status}`);
      return unwrapContractResult(body);
    }catch(error){
      lastError = error;
    }finally{
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("local Circle program bridge unavailable");
}

async function nativeStateCall(target, method, params=[]){
  return target.kind === "circle_program"
    ? nativeCircleProgramCall(target.id, method, params)
    : nativeContractCall(target.id, method, params);
}

async function sha256TextHex(text){
  if(!window.crypto?.subtle) throw new Error("WebCrypto SHA-256 is unavailable");
  const bytes = new TextEncoder().encode(text);
  const digest = await window.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte)=>byte.toString(16).padStart(2,"0")).join("");
}

async function sha256TaggedBrowser(tag, text){
  return `sha256:${await sha256TextHex(`${tag}\n${text}`)}`;
}

function requireEqual(label, actual, expected){
  if(actual !== expected) throw new Error(`${label} mismatch`);
}

function canonicalJsonBrowser(value){
  if(value === null) return "null";
  if(Array.isArray(value)) return `[${value.map((item)=>canonicalJsonBrowser(item)).join(",")}]`;
  if(typeof value === "object"){
    const entries = Object.entries(value)
      .filter(([, entryValue])=>entryValue !== undefined)
      .sort(([a], [b])=>a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([key, entryValue])=>`${JSON.stringify(key)}:${canonicalJsonBrowser(entryValue)}`).join(",")}}`;
  }
  if(typeof value === "string") return JSON.stringify(value);
  if(typeof value === "number"){
    if(!Number.isFinite(value)) throw new TypeError("Cannot canonicalize non-finite number");
    return JSON.stringify(value);
  }
  if(typeof value === "boolean") return value ? "true" : "false";
  throw new TypeError(`Cannot canonicalize value of type ${typeof value}`);
}

function requireCanonicalString(label, value){
  if(typeof value !== "string" || !value) throw new Error(`${label} missing`);
  const parsed = JSON.parse(value);
  requireEqual(label, canonicalJsonBrowser(parsed), value);
  return parsed;
}

function latestSummaryFromBody(body){
  return body?.latest_summary || body?.authority?.latest_summary || body?.receipt?.latest_summary_row || null;
}

function latestSummaryHashFromBody(body){
  return body?.latest_summary_hash || body?.authority?.latest_summary_hash || body?.receipt?.expected_hashes?.summary_hash || null;
}

async function verifyLatestResultInBand(latestResult){
  const body = latestResult.body || {};
  const artifact = extractSnapshotArtifact(body);
  const envelope = artifact.envelope || {};
  const authority = body.authority || {};
  if(body.source !== "program" || authority.canonical_state_read !== true){
    throw new Error("latest snapshot is not program-backed canonical state");
  }

  const canonicalPayload = artifact.canonical_payload || body.canonical_payload;
  const canonicalEvidence = artifact.canonical_evidence_manifest || body.canonical_evidence_manifest;
  const canonicalSourceRefs = artifact.canonical_source_refs || body.canonical_source_refs || canonicalJsonBrowser(envelope.source_refs || []);
  const payload = requireCanonicalString("canonical payload", canonicalPayload);
  const evidenceManifest = requireCanonicalString("canonical evidence manifest", canonicalEvidence);
  const sourceRefs = requireCanonicalString("canonical source refs", canonicalSourceRefs);

  if(envelope.payload) requireEqual("envelope payload", canonicalJsonBrowser(envelope.payload), canonicalPayload);
  if(body.payload) requireEqual("response payload", canonicalJsonBrowser(body.payload), canonicalPayload);
  if(artifact.evidence_manifest) requireEqual("evidence manifest", canonicalJsonBrowser(artifact.evidence_manifest), canonicalEvidence);
  if(envelope.source_refs) requireEqual("envelope source refs", canonicalJsonBrowser(envelope.source_refs), canonicalSourceRefs);

  requireEqual("payload hash", await sha256TaggedBrowser("octra-vitals:snapshot:v0", canonicalPayload), envelope.payload_hash);
  requireEqual("evidence hash", await sha256TaggedBrowser("octra-vitals:evidence:v0", canonicalEvidence), envelope.evidence_manifest_hash);
  const sourceRefsHash = await sha256TaggedBrowser("octra-vitals:source-refs:v0", canonicalSourceRefs);
  const expectedSourceRefsHash = body.receipt?.expected_hashes?.source_refs_hash || body.source_refs_hash || authority.source_refs_hash || null;
  if(expectedSourceRefsHash) requireEqual("source refs hash", sourceRefsHash, expectedSourceRefsHash);

  const latestSummary = latestSummaryFromBody(body);
  const latestSummaryHash = latestSummaryHashFromBody(body);
  if(latestSummary || latestSummaryHash){
    if(typeof latestSummary !== "string" || !latestSummary) throw new Error("latest summary missing");
    requireEqual("summary hash", await sha256TaggedBrowser("octra-vitals:summary:v0", latestSummary), latestSummaryHash);
    verifyLatestSummaryRow(latestSummary, body.snapshot_index || authority.snapshot_index || body.receipt?.snapshot_index, envelope.observed_at || evidenceManifest.observed_at, envelope.payload_hash, payload);
  }

  body.authority = {
    ...authority,
    client_verified: true,
    client_verification: {
      payload_hash: envelope.payload_hash,
      evidence_manifest_hash: envelope.evidence_manifest_hash,
      source_refs_hash: sourceRefsHash,
      summary_hash: latestSummaryHash || null,
      source: "browser-in-band"
    }
  };
  body.client_verification = body.authority.client_verification;
  artifact.envelope.payload = payload;
  artifact.evidence_manifest = evidenceManifest;
  artifact.envelope.source_refs = sourceRefs;
  return latestResult;
}

function isNativeVerificationFailure(error){
  const message = String(error?.message || error || "");
  return /mismatch|canonical|hash|summary|field count|length|parse|JSON|epoch/i.test(message);
}

function parseSummaryRow(row){
  if(typeof row !== "string" || row.length !== 208) throw new Error("summary row length mismatch");
  const fields = row.split("|");
  if(fields.length !== 13) throw new Error("summary row field count mismatch");
  return {
    row_version: fields[0],
    snapshot_index: Number(fields[1]),
    observed_at_unix: Number(fields[2]),
    octra_epoch: Number(fields[3]),
    external_block: Number(fields[4]),
    issued_raw: String(BigInt(fields[5])),
    burned_raw: String(BigInt(fields[6])),
    encrypted_raw: String(BigInt(fields[7])),
    total_locked_raw: String(BigInt(fields[8])),
    total_wrapped_raw: String(BigInt(fields[9])),
    total_unclaimed_raw: String(BigInt(fields[10])),
    route_count: Number(fields[11]),
    payload_hash_prefix: fields[12]
  };
}

function verifyLatestSummaryRow(row, snapshotIndex, observedAt, payloadHash, payload){
  const parsed = parseSummaryRow(row);
  const observedUnix = Math.floor(Date.parse(observedAt) / 1000);
  requireEqual("summary snapshot_index", parsed.snapshot_index, Number(snapshotIndex || 0));
  requireEqual("summary observed_at", parsed.observed_at_unix, observedUnix);
  requireEqual("summary octra_epoch", parsed.octra_epoch, Number(payload.octra?.epoch || 0));
  requireEqual("summary issued", parsed.issued_raw, rawText(payload.supply?.issued_oct_raw));
  requireEqual("summary burned", parsed.burned_raw, rawText(payload.supply?.confirmed_burned_oct_raw || payload.supply?.burned_oct_raw));
  requireEqual("summary encrypted", parsed.encrypted_raw, rawText(payload.supply?.encrypted_oct_raw));
  requireEqual("summary locked", parsed.total_locked_raw, rawText(payload.bridge?.total_locked_oct_raw));
  requireEqual("summary wrapped", parsed.total_wrapped_raw, rawText(payload.bridge?.woct_supply_raw));
  requireEqual("summary unclaimed", parsed.total_unclaimed_raw, rawText(payload.bridge?.unclaimed_oct_raw));
  requireEqual("summary payload hash prefix", parsed.payload_hash_prefix, String(payloadHash).replace(/^sha256:/, "").slice(0,24));
}

async function loadNativeProgramLatest(config=APP_CONFIG){
  const target = nativeStateTarget(config);
  if(!target) throw new Error("native state target unavailable for native read");
  const [
    snapshotIndex,
    latestEpoch,
    snapshotId,
    observedAt,
    payloadHash,
    evidenceHash,
    sourceRefsHash,
    canonicalPayload,
    canonicalEvidence,
    canonicalSourceRefs,
    submitter,
    latestSummary,
    latestSummaryHash
  ] = await Promise.all([
    nativeStateCall(target, "get_latest_snapshot_index"),
    nativeStateCall(target, "get_latest_epoch"),
    nativeStateCall(target, "get_latest_snapshot_id"),
    nativeStateCall(target, "get_latest_observed_at"),
    nativeStateCall(target, "get_latest_payload_hash"),
    nativeStateCall(target, "get_latest_evidence_manifest_hash"),
    nativeStateCall(target, "get_latest_source_refs_hash"),
    nativeStateCall(target, "get_latest_snapshot"),
    nativeStateCall(target, "get_latest_evidence_manifest"),
    nativeStateCall(target, "get_latest_source_refs"),
    nativeStateCall(target, "get_latest_submitter"),
    nativeStateCall(target, "get_latest_summary"),
    nativeStateCall(target, "get_latest_summary_hash")
  ]);
  if(!snapshotId || !canonicalPayload || !canonicalEvidence) throw new Error("native state program has no latest snapshot");
  requireEqual("payload hash", await sha256TaggedBrowser("octra-vitals:snapshot:v0", canonicalPayload), payloadHash);
  requireEqual("evidence hash", await sha256TaggedBrowser("octra-vitals:evidence:v0", canonicalEvidence), evidenceHash);
  requireEqual("source refs hash", await sha256TaggedBrowser("octra-vitals:source-refs:v0", canonicalSourceRefs), sourceRefsHash);
  requireEqual("summary hash", await sha256TaggedBrowser("octra-vitals:summary:v0", latestSummary), latestSummaryHash);
  const payload = JSON.parse(canonicalPayload);
  const evidenceManifest = JSON.parse(canonicalEvidence);
  const sourceRefs = JSON.parse(canonicalSourceRefs);
  requireEqual("payload epoch", Number(payload.octra?.epoch || 0), Number(latestEpoch || 0));
  const realObservedAt = observedAt || evidenceManifest.observed_at || String(snapshotId).replace(/^vitals\./, "");
  verifyLatestSummaryRow(latestSummary, snapshotIndex, realObservedAt, payloadHash, payload);
  const fresh = Number.isFinite(Date.parse(realObservedAt)) && Date.now() - Date.parse(realObservedAt) <= 20 * 60_000;
  return {
    url: target.kind === "circle_program" ? "octra-native:circle_program_view" : "octra-native:contract_call",
    body: {
      status: "program",
      source: "program",
      fresh,
      authority: {
        canonical_app: "site-circle",
        canonical_state: target.kind === "circle_program" ? "vitals-circle-program" : "vitals-state-program",
        gateway_role: "none",
        state_target_mode: target.kind,
        state_program_address: target.kind === "state_program" ? target.id : null,
        programmed_circle_id: target.kind === "circle_program" ? target.id : null,
        site_circle_id: config?.site_circle_id || null,
        state_read_from: target.kind === "circle_program" ? "circle-browser-program_view" : "circle-browser-contract_call",
        canonical_state_read: true,
        client_verified: true,
        client_verification: {
          payload_hash: payloadHash,
          evidence_manifest_hash: evidenceHash,
          source_refs_hash: sourceRefsHash,
          summary_hash: latestSummaryHash,
          source: "native-program-read"
        }
      },
      envelope: {
        schema_version: "octra-vitals-envelope-v0",
        snapshot_id: snapshotId,
        observed_at: realObservedAt,
        payload_hash: payloadHash,
        evidence_manifest_hash: evidenceHash,
        canonicalization: "jcs-rfc8785-or-equivalent-v1",
        payload,
        source_refs: sourceRefs,
        submitted_by: submitter || ""
      },
      evidence_manifest: evidenceManifest,
      canonical_source_refs: canonicalSourceRefs,
      canonical_payload: canonicalPayload,
      canonical_evidence_manifest: canonicalEvidence,
      generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
    }
  };
}

async function loadNativeProgramHistory(config=APP_CONFIG){
  const target = nativeStateTarget(config);
  if(!target) throw new Error("native state target unavailable for native history read");
  const [windowText, windowHash, firstIndex, rowCount] = await Promise.all([
    nativeStateCall(target, "get_recent_summary_window"),
    nativeStateCall(target, "get_recent_summary_window_hash"),
    nativeStateCall(target, "get_recent_summary_window_first_index"),
    nativeStateCall(target, "get_recent_summary_window_row_count")
  ]);
  requireEqual("summary window hash", await sha256TaggedBrowser("octra-vitals:summary-window:v0", windowText || ""), windowHash);
  const count = Number(rowCount || 0);
  const first = Number(firstIndex || 0);
  const snapshots = [];
  for(let i=0; i<count; i++){
    const row = parseSummaryRow(String(windowText || "").slice(i * 208, (i + 1) * 208));
    const observed_at = new Date(row.observed_at_unix * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    snapshots.push({
      snapshot_index: row.snapshot_index,
      snapshot_id: `vitals.${observed_at}`,
      observed_at,
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
    });
  }
  return {
    url: target.kind === "circle_program" ? "octra-native:circle_program_view:history" : "octra-native:contract_call:history",
    body: {
      schema: "octra-vitals-snapshot-history-v0",
      generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      first_index: first,
      row_count: count,
      row_len: 208,
      window_hash: windowHash,
      snapshots,
      authority: {
        source: target.kind === "circle_program" ? "vitals_circle_program_history" : "vitals_state_program_history",
        canonical_state_read: true,
        history_discovery: "aml_summary_window",
        state_target_mode: target.kind,
        state_program_address: target.kind === "state_program" ? target.id : null,
        programmed_circle_id: target.kind === "circle_program" ? target.id : null,
        note: target.kind === "circle_program"
          ? "Rows were read directly through the active Circle program view bridge."
          : "Rows were read directly through the Octra circle/native contract_call bridge."
      }
    }
  };
}

async function loadVersionConfig(){
  const version = await fetchFirst(endpointCandidates("/api/version", "./vitals.manifest.json", { allowStaticFallback:true }));
  APP_CONFIG = version.body || {};
  setupEnvironmentBanner(APP_CONFIG);
  return version;
}

function setupEnvironmentBanner(config){
  const banner = document.getElementById("env-banner");
  if(!banner) return;
  const host = String(location.hostname || "").toLowerCase();
  const origin = String(config?.gateway_origin || "").toLowerCase();
  const role = String(config?.gateway_role || "").toLowerCase();
  const stateTarget = String(config?.state_target_mode || "").toLowerCase();
  const devnet = host === "devnet.octra.live" ||
    host === "octra-dev.exe.xyz" ||
    origin.includes("devnet.octra.live") ||
    origin.includes("octra-dev.exe.xyz") ||
    role === "dev" ||
    role === "devnet";
  banner.hidden = !devnet;
  document.body.classList.toggle("is-devnet", devnet);
  if(devnet){
    banner.setAttribute("aria-label", `Devnet environment. State target: ${stateTarget || "devnet"}.`);
  }
}

function rawText(value, fallback="0"){
  if(value === undefined || value === null || value === "") return String(fallback);
  return String(value);
}

function rawBig(value, fallback="0"){
  try{ return BigInt(rawText(value, fallback)); }
  catch{ return BigInt(fallback); }
}

function rawAdd(...values){
  return values.reduce((sum, value)=>sum + rawBig(value), 0n).toString();
}

function rawSub(left, right){
  return (rawBig(left) - rawBig(right)).toString();
}

function rawMaxZero(value){
  const n = rawBig(value);
  return (n < 0n ? 0n : n).toString();
}

function pickRaw(...values){
  for(const value of values){
    if(value !== undefined && value !== null && value !== "") return rawText(value);
  }
  return "0";
}

function pickText(...values){
  for(const value of values){
    if(value !== undefined && value !== null && value !== "" && value !== "pending") return String(value);
  }
  return null;
}

function receiptTxHash(body){
  return pickText(
    body?.receipt?.tx_hash,
    Array.isArray(body?.receipt?.tx_hashes) ? body.receipt.tx_hashes[body.receipt.tx_hashes.length - 1] : null,
    body?.tx_hash,
    Array.isArray(body?.tx_hashes) ? body.tx_hashes[body.tx_hashes.length - 1] : null
  );
}

function parseEthBlock(value){
  if(typeof value === "number" && Number.isFinite(value)) return value;
  if(typeof value === "string" && value.startsWith("0x")) return Number.parseInt(value, 16);
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function shortRef(value, left=10, right=6){
  const text = String(value || "");
  if(text.length <= left + right + 1) return text || "—";
  return `${text.slice(0,left)}…${text.slice(-right)}`;
}

function observedDate(value){
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? new Date(time) : null;
}

function utcClock(value, withSeconds=false){
  const date = observedDate(value);
  if(!date) return "--:-- UTC";
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}${withSeconds?`:${ss}`:""} UTC`;
}

function utcDateTime(value){
  const date = observedDate(value);
  if(!date) return "time unknown";
  const yyyy = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mo}-${dd} ${utcClock(value, true)}`;
}

function browserClock(value, withSeconds=false){
  const date = observedDate(value);
  if(!date) return "--:--";
  const options = {hour:"numeric", minute:"2-digit", timeZoneName:"short"};
  if(withSeconds) options.second = "2-digit";
  return date.toLocaleTimeString(undefined, options);
}

function browserDateTime(value){
  const date = observedDate(value);
  if(!date) return "time unknown";
  return date.toLocaleString(undefined, {
    year:"numeric",
    month:"short",
    day:"numeric",
    hour:"numeric",
    minute:"2-digit",
    second:"2-digit",
    timeZoneName:"short"
  });
}

function browserSnapshotStamp(value){
  const date = observedDate(value);
  if(!date) return "--:--";
  return date.toLocaleString(undefined, {
    month:"short",
    day:"numeric",
    hour:"numeric",
    minute:"2-digit",
    timeZoneName:"short"
  });
}

function relativeAge(value){
  const date = observedDate(value);
  if(!date) return "time unknown";
  const diffMs = Date.now() - date.getTime();
  if(diffMs < 0) return "just now";
  const abs = Math.abs(diffMs);
  const unit = (amount, label)=>`${amount}${label} ago`;
  if(abs < 45_000) return "just now";
  if(abs < 90_000) return unit(1, "m");
  if(abs < 60 * 60_000) return unit(Math.round(abs / 60_000), "m");
  if(abs < 90 * 60_000) return unit(1, "h");
  if(abs < 24 * 60 * 60_000) return unit(Math.round(abs / (60 * 60_000)), "h");
  return unit(Math.round(abs / (24 * 60 * 60_000)), "d");
}

function hashPath(hash){
  const text = String(hash || "").replace(/^sha256:/, "");
  return /^[a-fA-F0-9]{64}$/.test(text) ? text.toLowerCase() : null;
}

function extractSnapshotArtifact(value){
  if(value?.envelope?.payload) return value;
  if(value?.snapshot?.envelope?.payload) return value.snapshot;
  throw new Error("Snapshot response did not include an envelope payload");
}

function sourceRefUrl(refs, id){
  const ref = (refs || []).find((item)=>item?.id === id);
  return ref?.hash ? apiHref(`/api/evidence/raw/${String(ref.hash).replace(/^sha256:/, "")}`) : ref?.url || null;
}

function historyRows(history, currentData){
  const rows = [];
  for(const item of history?.snapshots || []){
    const supply = item?.supply || item?.envelope?.payload?.supply;
    const bridge = item?.bridge || item?.envelope?.payload?.bridge;
    if(!supply || !bridge) continue;
    const issued = pickRaw(supply.issued_oct_raw, supply.in_circulation_oct_raw);
    const encrypted = pickRaw(supply.encrypted_oct_raw);
    const max = pickRaw(supply.max_oct_raw, currentData.supply_raw.max);
    const burnedProvided = supply.confirmed_burned_oct_raw || supply.burned_oct_raw;
    if(!burnedProvided) continue;
    const burned = pickRaw(burnedProvided);
    const locked = pickRaw(bridge.total_locked_oct_raw, bridge.locked_oct_raw);
    const woct = pickRaw(bridge.woct_supply_raw);
    const unclaimed = pickRaw(bridge.unclaimed_oct_raw);
    const unclassified = rawMaxZero(rawSub(rawSub(locked, woct), unclaimed));
    rows.push([
      item.observed_at || item.envelope?.observed_at || item.snapshot_id || currentData.snapshot.observed_at,
      Number(item.octra_epoch || item.envelope?.payload?.octra?.epoch || 0),
      issued,
      encrypted,
      locked,
      woct,
      unclaimed,
      unclassified,
      burned
    ]);
  }

  const latest = [
    currentData.snapshot.observed_at,
    currentData.snapshot.octra_epoch,
    currentData.supply_raw.in_circulation,
    currentData.supply_raw.encrypted,
    currentData.bridge_raw.locked,
    currentData.bridge_raw.woct,
    currentData.bridge_raw.unclaimed,
    currentData.bridge_raw.unclassified,
    currentData.supply_raw.confirmed_burned
  ];
  rows.push(latest);

  const deduped = [...new Map(rows
    .sort((a,b)=>String(a[0]).localeCompare(String(b[0])))
    .map((row)=>[`${row[0]}:${row[2]}:${row[4]}:${row[5]}:${row[6]}`, row])).values()];
  const tail = deduped.slice(-MAX_HISTORY_POINTS);
  return { rows: tail, distinctCount: tail.length };
}

function adaptSnapshot(latestResult, versionResult, historyResult){
  const body = latestResult.body;
  const historyBody = historyResult?.body || {};
  const historyAuthority = historyBody.authority || {};
  const artifact = extractSnapshotArtifact(body);
  const envelope = artifact.envelope;
  const sampleFallback = /(?:^|\/)latest_snapshot\.sample\.json(?:$|[?#])/.test(String(latestResult.url || ""));
  const payload = envelope.payload || body.payload || {};
  const supply = payload.supply || {};
  const bridge = payload.bridge || {};
  const ethereum = payload.ethereum || {};
  const octra = payload.octra || {};
  const relayer = payload.relayer || {};
  const route = Array.isArray(payload.routes) && payload.routes[0] ? payload.routes[0] : {};
  const version = versionResult?.body || {};
  const authority = body.authority || version.authority || {};
  if(sampleFallback || body.source !== "program" || authority.canonical_state_read !== true || authority.client_verified !== true){
    throw new Error("latest snapshot is not canonical AML program state");
  }
  if(body.fresh === false){
    throw new Error("latest AML snapshot is stale");
  }
  const historyCanonical = historyAuthority.canonical_state_read === true;
  const currentStateTargetMode = authority.state_target_mode || version.state_target_mode || body.native_readiness?.state_target_mode || "state_program";
  const programRef = currentStateTargetMode === "circle_program"
    ? pickText(authority.programmed_circle_id, version.programmed_circle_id, body.native_readiness?.state_target_id)
    : pickText(authority.state_program_address, version.state_program_address, body.native_readiness?.state_program_address);

  const max = pickRaw(supply.max_oct_raw);
  const issued = pickRaw(supply.issued_oct_raw, supply.in_circulation_oct_raw);
  const encrypted = pickRaw(supply.encrypted_oct_raw);
  const burnedProvided = supply.confirmed_burned_oct_raw || supply.burned_oct_raw;
  if(!burnedProvided) throw new Error("latest snapshot missing required burned field");
  const publicRaw = rawSub(issued, encrypted);
  const notInCirc = pickRaw(supply.not_in_circulation_oct_raw, rawSub(max, issued), supply.burned_oct_raw);
  const burned = pickRaw(burnedProvided);
  const unattributed = pickRaw(supply.unattributed_oct_raw, rawMaxZero(rawSub(notInCirc, burned)));

  const locked = pickRaw(bridge.total_locked_oct_raw, bridge.locked_oct_raw);
  const unlocked = pickRaw(bridge.total_unlocked_oct_raw, bridge.unlocked_oct_raw);
  const woct = pickRaw(bridge.woct_supply_raw);
  const unclaimed = pickRaw(bridge.unclaimed_oct_raw);
  const claimBalance = rawSub(locked, rawAdd(woct, unclaimed));
  const claimOverage = rawSub(rawAdd(woct, unclaimed), locked);
  const unclassifiedSigned = claimBalance;
  const unclassified = rawMaxZero(claimBalance);
  const vault = pickRaw(bridge.vault_balance_oct_raw);
  const vaultSurplus = rawSub(vault, locked);
  const grossLocked = pickRaw(bridge.gross_locked_oct_raw, rawAdd(locked, unlocked));
  const ethBlock = parseEthBlock(ethereum.block_number);

  const data = {
    snapshot: {
      id: envelope.snapshot_id || "snapshot",
      observed_at: envelope.observed_at || new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      octra_epoch: Number(octra.epoch || 0),
      eth_block: ethBlock,
      eth_block_hex: ethereum.block_number || (ethBlock ? `0x${ethBlock.toString(16)}` : "0x0"),
      network: octra.network_version || "unknown",
      validator: octra.validator || "pending",
      txid_hi: Number(octra.txid_hi || 0)
    },
    supply_raw: {
      max,
      in_circulation: issued,
      public: publicRaw,
      encrypted,
      not_in_circulation: notInCirc,
      confirmed_burned: burned,
      unattributed
    },
    bridge_raw: {
      vault,
      locked,
      unlocked_cum: unlocked,
      woct,
      unclaimed,
      unclassified,
      unclassified_signed: unclassifiedSigned,
      claim_balance: claimBalance,
      claim_overage: claimOverage,
      vault_surplus: vaultSurplus,
      gross_locked: grossLocked,
      lock_nonce: Number(bridge.lock_nonce || 0),
      unlock_count: Number(bridge.unlock_count || 0),
      recipients: Number(bridge.recipient_count || relayer.recipient_count || 0)
    },
    routes: (Array.isArray(payload.routes) ? payload.routes : []).map(r => ({
      dst_chain_id: Number(r.dst_chain_id ?? ethereum.chain_id ?? 1),
      asset: r.asset || "wOCT",
      wrapped_raw: pickRaw(r.wrapped_supply_raw)
    })),
    clocks: {
      octra_epoch: Number(octra.epoch || 0),
      relayer_finalized: Number(relayer.latest_finalized_epoch || relayer.latest_scanned_epoch || octra.epoch || 0),
      recovery_scanned: Number(relayer.latest_scanned_epoch || relayer.latest_finalized_epoch || octra.epoch || 0),
      eth_block: ethBlock
    },
    health: payload.health || {},
    units: payload.units || {},
    prov: {
      program: programRef || "pending",
      program_kind: currentStateTargetMode,
      site_circle: pickText(authority.site_circle_id, version.site_circle_id) || "pending",
      vault: bridge.vault_address || "pending",
      woct: ethereum.woct_address || "pending",
      ethBridge: ethereum.bridge_address || "pending",
      burn_tx: pickText(supply.burn_tx, supply.burn_tx_hash, envelope.burn_tx),
      evidence_hash: envelope.evidence_manifest_hash || null,
      payload_hash: envelope.payload_hash || null,
      receipt_tx: receiptTxHash(body),
      relayer_mode: relayer.mode || "unknown",
      quorum: relayer.quorum || relayer.validator_quorum || null,
      src_chain: route.src_chain_id || relayer.src_chain_id || 7777,
      dst_chain: route.dst_chain_id || relayer.dst_chain_id || ethereum.chain_id || 1,
      route_id: route.route_id || null,
      source_refs: envelope.source_refs || body.source_refs || []
    },
    source: {
      status: sampleFallback ? "sample" : body.status || "program",
      source: sampleFallback ? "sample_fallback" : body.source || body.status || "program",
      latest_url: latestResult.url,
      version_url: versionResult?.url || null,
      history_url: historyResult?.url || null,
      fresh: sampleFallback ? false : body.fresh !== false,
      canonical_state_read: !sampleFallback && authority.canonical_state_read === true && authority.client_verified === true,
      client_verified: !sampleFallback && authority.client_verified === true,
      history_canonical: historyCanonical,
      history_source: historyAuthority.source || null,
      burn_source: supply.confirmed_burned_oct_raw ? "confirmed_burned_oct_raw" : supply.burned_oct_raw ? "burned_oct_raw" : "not_provided"
    }
  };
  const history = historyRows(historyCanonical ? historyBody : null, data);
  data.series = history.rows;
  data.history_points = history.distinctCount;
  return data;
}

async function loadInitialData(){
  const versionPromise = loadVersionConfig().catch((error)=>{
    console.warn("[Octra Vitals] version config unavailable; continuing with same-origin latest", error);
    return null;
  });
  const versionResult = (isStaticOnlyOrigin() || isCircleClientOrigin()) ? await versionPromise : null;
  if(versionResult){
    try{
      const nativeLatest = await loadNativeProgramLatest(versionResult.body || APP_CONFIG);
      return {
        data: adaptSnapshot(nativeLatest, versionResult, null),
        latestResult: nativeLatest,
        versionResult,
        versionPromise
      };
    }catch(error){
      if(isNativeVerificationFailure(error)) throw error;
      console.warn("[Octra Vitals] direct Octra program read unavailable; falling back to gateway", error);
    }
  }
  const latest = await fetchFirst(endpointCandidates("/api/latest", null, {
    gatewayOrigin: configuredGatewayOrigin(versionResult?.body)
  }));
  await verifyLatestResultInBand(latest);
  return {
    data: adaptSnapshot(latest, versionResult, null),
    latestResult: latest,
    versionResult,
    versionPromise
  };
}

async function loadCanonicalHistory(versionResult){
  if(versionResult?.body || APP_CONFIG?.state_program_address){
    try{
      return await loadNativeProgramHistory(versionResult?.body || APP_CONFIG);
    }catch(error){
      console.warn("[Octra Vitals] direct Octra history read unavailable; falling back to gateway", error);
    }
  }
  return fetchFirst(endpointCandidates("/api/history", null, {
    gatewayOrigin: configuredGatewayOrigin(versionResult?.body || APP_CONFIG)
  }));
}

function accounting(d){
  const S = d.supply_raw, B = d.bridge_raw;
  const b = (s)=>BigInt(s);

  // raw BigInts (the canonical values)
  const r = {
    max:        b(S.max),
    inCirc:     b(S.in_circulation),
    public:     b(S.public),
    encrypted:  b(S.encrypted),
    notInCirc:  b(S.not_in_circulation),
    burned:     b(S.confirmed_burned),
    unattributed:b(S.unattributed),

    locked:     b(B.locked),
    woct:       b(B.woct),
    unclaimed:  b(B.unclaimed),
    unclassified:b(B.unclassified),
    unclassifiedSigned:b(B.unclassified_signed ?? B.unclassified),
    claimBalance:b(B.claim_balance ?? rawSub(B.locked, rawAdd(B.woct, B.unclaimed))),
    claimOverage:b(B.claim_overage ?? rawSub(rawAdd(B.woct, B.unclaimed), B.locked)),
    vault:      b(B.vault),
    vaultSurplus:b(B.vault_surplus),
    grossLocked:b(B.gross_locked),
    unlockedCum:b(B.unlocked_cum)
  };

  // signed residuals of the identities that could actually break
  const res = {
    issuance: (r.public + r.encrypted) - r.inCirc,                       // expect 0
    capSplit: (r.inCirc + r.notInCirc) - r.max,                          // expect 0
    custody:  r.claimOverage,                                             // expect <= 0; positive means over-claimed
    custodyIdentity: (r.woct + r.unclaimed + r.unclassified) - r.locked,  // derived residual identity
    vaultDust:(r.vault - r.locked),                                      // expect +vaultSurplus (>0 = over-backed)
    lifetime: (r.grossLocked - r.unlockedCum) - r.locked                 // derived unless upstream gross_locked is independent
  };

  // percentages (round-half-up to dp, BigInt-exact) computed ONCE here
  const pct = {
    circOfCap:    pctR(r.inCirc, r.max, 2),
    nicOfCap:     pctR(r.notInCirc, r.max, 2),
    burnedOfCap:  pctR(r.burned, r.max, 2),
    publicOfCirc: pctR(r.public, r.inCirc, 2),
    encOfCirc:    pctR(r.encrypted, r.inCirc, 2),
    bridgedOfCirc:pctR(r.locked, r.inCirc, 2),
    woctOfLocked: pctR(r.woct, r.locked, 2),
    unclaimedOfLocked: pctR(r.unclaimed, r.locked, 4),
    unclassOfLocked:   pctR(r.unclassified, r.locked, 4),
    lockedOfGross:pctR(r.locked, r.grossLocked, 2),
    pegFull:      pctR(r.woct, r.locked, 4)   // wOCT / locked at 4dp
  };

  return { raw:r, res, pct, snapshot:d.snapshot, clocks:d.clocks, prov:d.prov, source:d.source || {}, health:d.health || {}, units:d.units || {}, chains:(d.routes||[]).map(rt=>({ id:rt.dst_chain_id, asset:rt.asset, wrappedRaw:b(rt.wrapped_raw) })), bridgeMeta:{
    lock_nonce:B.lock_nonce, unlock_count:B.unlock_count, recipients:B.recipients
  }};
}

function healthDeltaBig(health, key, fallback=0n){
  const value = health?.deltas?.[key];
  if(value === undefined || value === null || value === "") return fallback;
  try{ return BigInt(String(value)); }
  catch{ return fallback; }
}

function signedHealthDeltaBig(health, key){
  const value = health?.deltas?.[key];
  if(value === undefined || value === null || value === "") return { ok:false, value:null };
  try{ return { ok:true, value:BigInt(String(value)) }; }
  catch{ return { ok:false, value:null }; }
}

function conservationCrossCheck(health){
  if(!health) return { ok:false, mismatches:["signed health missing"] };
  const checks = [
    ["cap_burn_mismatch_raw", (A.raw.max - A.raw.inCirc) - A.raw.burned],
    ["encrypted_minus_issued_raw", A.raw.encrypted - A.raw.inCirc],
    ["bridge_residual_raw", A.raw.claimBalance],
    ["bridge_claim_overage_raw", A.raw.claimOverage],
    ["vault_surplus_raw", A.raw.vaultSurplus]
  ];
  const mismatches = [];
  for(const [key, expected] of checks){
    const actual = signedHealthDeltaBig(health, key);
    if(!actual.ok || actual.value !== expected) mismatches.push(key);
  }
  return { ok:mismatches.length === 0, mismatches };
}

function healthStatusText(status){
  if(status === "green") return "Checks pass";
  if(status === "yellow") return "Review";
  if(status === "red") return "Alarm";
  return "Unavailable";
}

function snapshotStatusText(){
  const signed = A.health?.conservation || null;
  const cross = conservationCrossCheck(signed);
  const status = !signed ? "red" : cross.ok ? signed.status : "red";
  const proof = A.source?.canonical_state_read && A.source?.client_verified ? "browser-verified program" : "program unavailable";
  const readback = A.source?.fresh === false ? "stale" : "fresh";
  const parts = [healthStatusText(status).toLowerCase(), "signed", readback, proof];
  if(!cross.ok) parts.push("browser arithmetic mismatch");
  return parts.join(" · ");
}

/* ---- BigInt-exact formatting / ratios (the only money + percent functions) ---- */
function fmtOCT(raw, dp=2){                 // raw BigInt|string -> grouped, round-half-up
  raw = typeof raw === "bigint" ? raw : BigInt(raw);
  const neg = raw < 0n; let a = neg ? -raw : raw;
  const pow = 10n ** BigInt(6 - dp);
  let scaled = (a + pow/2n) / pow;          // round half up at dp
  const unit = 10n ** BigInt(dp);
  const whole = scaled / unit, fr = scaled % unit;
  const wstr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fstr = dp>0 ? "." + fr.toString().padStart(dp,"0") : "";
  return (neg?"−":"") + wstr + fstr;
}
function fmtParts(raw, dp=2){               // split integer/decimal for styled spans
  const s = fmtOCT(raw, dp);
  const i = s.indexOf(".");
  return i<0 ? {whole:s, dec:""} : {whole:s.slice(0,i), dec:s.slice(i)};
}
function pctR(part, base, dp=2){            // percent, round-half-up, BigInt-safe -> Number
  part = typeof part==="bigint"?part:BigInt(part);
  base = typeof base==="bigint"?base:BigInt(base);
  if(base===0n) return 0;
  const neg = part<0n; const p = neg?-part:part;
  const scale = 10n ** BigInt(dp+2);
  const num = (p*scale + base/2n) / base;
  return (neg?-1:1) * Number(num) / Math.pow(10,dp);
}
function fmtPct(n, dp=2){ return new Intl.NumberFormat("en-US",{minimumFractionDigits:dp,maximumFractionDigits:dp}).format(n); }
function ratio(numRaw, denRaw){            // geometry only: Number in [0,1]
  if(BigInt(denRaw) === 0n) return 0;
  const q = (BigInt(numRaw)*1000000000n) / BigInt(denRaw);
  return Number(q)/1e9;
}
function octNum(raw){ raw = typeof raw==="bigint"?raw:BigInt(raw); return Number(raw/RAW) + Number(raw%RAW)/1e6; }
function compact(raw, dp=2){               // 622.22M etc. (suffix styled by caller if needed)
  const n = octNum(raw), a = Math.abs(n);
  if(a>=1e9) return (n/1e9).toFixed(dp)+"B";
  if(a>=1e6) return (n/1e6).toFixed(dp)+"M";
  if(a>=1e3) return (n/1e3).toFixed(dp)+"K";
  return fmtOCT(raw,2);
}
function compactParts(raw, dp=2){
  const n = octNum(raw), a = Math.abs(n);
  if(a>=1e9) return {num:(n/1e9).toFixed(dp), sfx:"B"};
  if(a>=1e6) return {num:(n/1e6).toFixed(dp), sfx:"M"};
  if(a>=1e3) return {num:(n/1e3).toFixed(dp), sfx:"K"};
  return {num:fmtOCT(raw,2), sfx:""};
}
function parseRowTime(row){
  const t = Date.parse(row?.[COL.T]);
  return Number.isFinite(t) ? t : null;
}
function availableSeries(){
  return Array.isArray(DATA.series) ? DATA.series : [];
}
function selectedHistoryWindow(){
  return HISTORY_WINDOWS[sparkWindow] || HISTORY_WINDOWS[DEFAULT_HISTORY_WINDOW];
}
function activeSeries(){
  const rows = availableSeries();
  if(rows.length <= 1) return rows;
  const last = parseRowTime(rows[rows.length - 1]);
  const windowCfg = selectedHistoryWindow();
  if(last == null || !windowCfg) return rows;
  const since = last - windowCfg.ms;
  let filtered = rows.filter((row)=>{
    const t = parseRowTime(row);
    return t == null || t >= since;
  });
  if(filtered.length < 2 && rows.length > 1) filtered = rows.slice(-2);
  return filtered;
}
function hasHistoryWindow(rows=activeSeries()){ return rows.length > 1; }
function hasCanonicalHistoryWindow(rows=activeSeries()){ return hasHistoryWindow(rows) && DATA.source?.history_canonical === true; }
function trendPhrase(stableText="stable"){ return hasCanonicalHistoryWindow() ? stableText : "latest snapshot only"; }
function historySpan(rows=activeSeries()){
  if(!hasHistoryWindow(rows)) return "latest only";
  const first = parseRowTime(rows[0]);
  const last = parseRowTime(rows[rows.length - 1]);
  if(!Number.isFinite(first) || !Number.isFinite(last) || last <= first) return "observed window";
  const mins = Math.max(1, Math.round((last - first) / 60000));
  const d = Math.floor(mins / 1440), rem = mins % 1440;
  const h = Math.floor(rem / 60), m = rem % 60;
  if(d && h) return `${d}d ${h}h`;
  if(d) return `${d}d`;
  if(h && m) return `${h}h ${m}m`;
  if(h) return `${h}h`;
  return `${m}m`;
}
function historyWindowStatus(){
  const rows = activeSeries();
  if(!hasCanonicalHistoryWindow(rows)) return "latest snapshot only";
  const first = parseRowTime(rows[0]);
  const last = parseRowTime(rows[rows.length - 1]);
  const cfg = selectedHistoryWindow();
  const span = historySpan(rows);
  if(first == null || last == null || !cfg) return span;
  const actual = Math.max(0, last - first);
  return actual >= cfg.ms * 0.95 ? `${cfg.label} window` : `${span} available`;
}
function syncHistoryWindowControls(){
  document.querySelectorAll("[data-history-window]").forEach((btn)=>{
    btn.setAttribute("aria-pressed", String(btn.dataset.historyWindow === sparkWindow));
  });
  document.querySelectorAll("[data-history-status]").forEach((node)=>{
    node.textContent = historyWindowStatus();
  });
}
function compactDelta(raw){
  raw = typeof raw === "bigint" ? raw : BigInt(raw);
  if(raw === 0n) return "0";
  const sign = raw > 0n ? "+" : "−";
  const abs = raw > 0n ? raw : -raw;
  return sign + compact(abs).replace("K", "k");
}
function deltaRaw(col){
  const rows = activeSeries();
  if(!hasCanonicalHistoryWindow(rows)) return "";
  const span = historySpan(rows);
  const first = BigInt(rows[0][col]);
  const last = BigInt(rows[rows.length - 1][col]);
  const d = last - first;
  return d === 0n ? `no change · ${span}` : `${compactDelta(d)} OCT · ${span}`;
}
function deltaPct(values, dp=4){
  const rows = activeSeries();
  if(!hasCanonicalHistoryWindow(rows) || values.length < 2) return "";
  const span = historySpan(rows);
  const d = values[values.length - 1] - values[0];
  const rounded = Number(d.toFixed(dp));
  return rounded === 0 ? `no visible change · ${span}` : `${rounded > 0 ? "+" : "−"}${Math.abs(rounded).toFixed(dp)} pp · ${span}`;
}

const SVGNS = "http://www.w3.org/2000/svg";
function el(tag, attrs={}, text){ const n=document.createElementNS(SVGNS,tag); for(const k in attrs) n.setAttribute(k,attrs[k]); if(text!=null) n.textContent=text; return n; }
function esc(s){ return String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c])); }

/* compute the core ONCE per loaded snapshot; everything below reads from A */
let DATA = EMPTY_DATA;
let A = accounting(DATA);
let renderReady = false;

/* ============================================================================
   ACT I · CONSERVED-CAP HERO — 1000-square unit chart, two-part (honest).
   Burned is the single out-of-circulation visible category.
   ============================================================================ */
const CHAIN_NAMES = { 1:"ethereum", 11155111:"sepolia", 10:"optimism", 56:"bnb chain", 137:"polygon", 8453:"base", 42161:"arbitrum", 43114:"avalanche" };
function chainLabel(id){ const n=Number(id); return CHAIN_NAMES[n] || (Number.isFinite(n) ? `chain ${n}` : "ethereum"); }
function renderCapGrid(){
  const host = document.getElementById("cap-grid");
  const COLS=50, ROWS=20, N=COLS*ROWS;                 // 1000 cells, 1 cell = 1,000,000 OCT
  const cellRaw = A.raw.max / BigInt(N);               // 1e12 raw
  const nCirc = Number(A.raw.inCirc / cellRaw) + Number(A.raw.inCirc % cellRaw)/Number(cellRaw);
  const nEnc  = Number(A.raw.encrypted / cellRaw) + Number(A.raw.encrypted % cellRaw)/Number(cellRaw);
  const nPub  = nCirc - nEnc;
  const bridged = (A.chains && A.chains.length ? A.chains : [{ id: A.prov && A.prov.dst_chain, wrappedRaw: A.raw.woct }])
    .filter(c => { try { return BigInt(c.wrappedRaw) > 0n; } catch(e){ return false; } });
  const bridgedLabel = bridged.length > 1
    ? bridged.map((b)=>`${chainLabel(b.id)} ${compact(b.wrappedRaw)}`).join(", ")
    : bridged.length === 1
      ? `${compact(bridged[0].wrappedRaw)} wrapped OCT on ${chainLabel(bridged[0].id)}`
      : "no wrapped OCT routes";

  const cell=18, gap=2.6;
  const gw = COLS*cell + (COLS-1)*gap;
  const gh = ROWS*cell + (ROWS-1)*gap;
  const padT=8, legendH=34, LPAD=46;                   // left gutter for the locked/bridged bracket
  const W=gw, H=padT+gh+legendH;
  const SANS="ui-sans-serif,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

  const svg = el("svg",{viewBox:`${-LPAD} 0 ${(W+LPAD).toFixed(1)} ${H}`, role:"img", width:(W+LPAD), height:H,
    "aria-label":`Unit grid of 1,000 squares for the one-billion OCT cap: ${Math.round(nCirc)} in circulation (${fmtPct(A.pct.circOfCap)}%), of which ${Math.round(nEnc)} are encrypted; ${1000-Math.round(nCirc)} burned (${fmtPct(A.pct.burnedOfCap)}%). Brackets in the left margin mark OCT wrapped to destination chains: ${bridgedLabel}.`});

  // a crosshatch (mesh) marks the encrypted slice of the circulating supply
  const defs=el("defs");
  const pc=el("pattern",{id:"px-cross",patternUnits:"userSpaceOnUse",width:4,height:4});
  pc.appendChild(el("rect",{width:4,height:4,fill:"var(--blue)"}));
  pc.appendChild(el("line",{x1:0,y1:4,x2:4,y2:0,stroke:"#fff","stroke-width":0.75,"stroke-opacity":0.9}));
  pc.appendChild(el("line",{x1:0,y1:0,x2:4,y2:4,stroke:"#fff","stroke-width":0.75,"stroke-opacity":0.9}));
  defs.appendChild(pc); svg.appendChild(defs);

  const g = el("g",{transform:`translate(0,${padT})`});
  // fill order: public (solid blue) -> encrypted (crosshatch blue) -> burned (grey).
  for(let i=0;i<N;i++){
    const c=i%COLS, rr=Math.floor(i/COLS);
    const x=c*(cell+gap), y=rr*(cell+gap);
    const inCirc = i < nCirc;
    const isEnc  = i >= nPub && i < nCirc;              // encrypted sits at the end of the blue run
    g.appendChild(el("rect",{x:x.toFixed(2), y:y.toFixed(2), width:cell, height:cell, rx:2.5,
      fill: isEnc ? "url(#px-cross)" : inCirc ? "var(--blue)" : "var(--structural)",
      "fill-opacity": inCirc ? 1 : 0.55}));
  }
  svg.appendChild(g);

  // left-gutter annotation: OCT wrapped onto each destination chain.
  // Pure margin ink — the 1,000 squares stay exactly as they are.
  const brk = el("g");
  let accCells = 0;
  for(const b of bridged){
    const nW = Number(b.wrappedRaw / cellRaw) + Number(b.wrappedRaw % cellRaw)/Number(cellRaw);
    const y0 = padT + Math.min(accCells, N)/COLS*(cell+gap);
    const y1 = padT + Math.min(accCells+nW, N)/COLS*(cell+gap);
    accCells += nW;
    const mid = Math.max((y0+y1)/2, 56);
    brk.appendChild(el("line",{x1:-12,y1:y0.toFixed(2),x2:-12,y2:y1.toFixed(2),stroke:"var(--ink-2)","stroke-width":1.3}));
    brk.appendChild(el("line",{x1:-12,y1:y0.toFixed(2),x2:-5,y2:y0.toFixed(2),stroke:"var(--ink-2)","stroke-width":1.3}));
    brk.appendChild(el("line",{x1:-12,y1:y1.toFixed(2),x2:-5,y2:y1.toFixed(2),stroke:"var(--ink-2)","stroke-width":1.3}));
    brk.appendChild(el("text",{x:-24,y:mid.toFixed(2),"font-family":SANS,"font-size":11,fill:"var(--ink-2)","text-anchor":"middle",transform:`rotate(-90 -24 ${mid.toFixed(2)})`}, `${chainLabel(b.id)} · ${compact(b.wrappedRaw)}`));
  }
  svg.appendChild(brk);

  // texture key
  const key=el("g",{transform:`translate(0,${padT+gh+20})`});
  const item=(x,fill,op,label,strong)=>{
    key.appendChild(el("rect",{x:x,y:-12,width:15,height:15,rx:2.5,fill:fill,"fill-opacity":op,stroke:"var(--rule)","stroke-width":0.8}));
    key.appendChild(el("text",{x:x+22,y:0,"font-family":SANS,"font-size":13,"font-weight":strong?650:400,fill:strong?"var(--ink)":"var(--ink-2)"},label));
  };
  item(0,   "var(--blue)",    1,    "public · in circulation", false);
  item(268, "url(#px-cross)", 1,    "encrypted · FHE",    true);
  item(520, "var(--structural)", 0.55, "burned",          false);

  svg.appendChild(key);
  host.innerHTML=""; host.appendChild(svg);
}

/* ACT I · two headline parts (read from A) */
function renderCapParts(){
  const circ = fmtParts(A.raw.inCirc);
  document.getElementById("cp-circ-pct").textContent = fmtPct(A.pct.circOfCap)+"%";
  document.getElementById("cp-circ-big").innerHTML = `${circ.whole}<span class="dec">${circ.dec}</span><span class="u">OCT</span>`;
  document.getElementById("cp-circ-sub").innerHTML =
    `Public <b>${fmtOCT(A.raw.public)}</b> + encrypted <b>${fmtOCT(A.raw.encrypted)}</b>. ${fmtPct(A.pct.bridgedOfCirc)}% is locked and bridged to Ethereum.`;

  const nic = fmtParts(A.raw.burned);
  document.getElementById("cp-nic-pct").textContent = fmtPct(A.pct.burnedOfCap)+"%";
  document.getElementById("cp-nic-big").innerHTML = `${nic.whole}<span class="dec">${nic.dec}</span><span class="u">OCT</span>`;
  document.getElementById("cp-nic-sub").innerHTML =
    `Cap remainder from the RPC burn field.`;
}

/* ============================================================================
   ACT I · CIRCULATING SPLIT — to-scale bar: public | encrypted (leader-labelled).

   ============================================================================ */
function renderSplit(){
  const host = document.getElementById("fig-split");
  const GX=18;                                  // small gutter: bar fills the width and aligns with the prose
  const barW=520, W=barW+GX*2, barH=100, topRule=46, botLab=88, H=topRule+barH+botLab;
  const sc = (raw)=> ratio(raw, A.raw.inCirc) * barW;

  const svg = el("svg",{viewBox:`0 0 ${W} ${H}`, width:"100%", height:"auto", role:"img",
    "aria-label":`Circulating ${fmtOCT(A.raw.inCirc,0)} OCT splits into public ${fmtOCT(A.raw.public,0)} and encrypted ${fmtOCT(A.raw.encrypted,0)}.`});

  const g = el("g",{transform:`translate(${GX},${topRule})`});
  // top axis
  g.appendChild(el("line",{x1:0,y1:-16,x2:barW,y2:-16,class:"axis"}));
  g.appendChild(el("text",{x:0,y:-26,class:"t-unit","font-size":11},"CIRCULATING SUPPLY · "+fmtOCT(A.raw.inCirc)+" OCT"));

  const segs = [
    {raw:A.raw.public,    fill:"var(--blue)", inv:true,  name:"public", sub:"transparent ledger"},
    {raw:A.raw.encrypted, fill:"var(--blue-line)", inv:false, name:"encrypted", sub:"FHE-encrypted", tiny:true}
  ];
  let x=0; const meta=[];
  segs.forEach(s=>{ const w=sc(s.raw); g.appendChild(el("rect",{x:x.toFixed(2),y:0,width:Math.max(0,w).toFixed(2),height:barH,fill:s.fill})); meta.push({...s,x,w}); x+=w; });
  // hairline divider
  if(meta[1]) g.appendChild(el("line",{x1:meta[1].x.toFixed(2),y1:0,x2:meta[1].x.toFixed(2),y2:barH,stroke:"#fff","stroke-width":1.2}));

  meta.forEach(s=>{
    const cx=s.x+s.w/2;
    if(s.tiny || s.w<150){
      // clamp the label x so its (right-anchored) text never exits the gutter
      const lblX=Math.min(cx, barW+GX-6), anchor=(cx>barW-90)?"end":"middle";
      const ly=barH+34;
      g.appendChild(el("path",{d:`M ${cx.toFixed(2)} ${barH} L ${cx.toFixed(2)} ${ly-14}`,class:"lead"}));
      g.appendChild(el("text",{x:lblX.toFixed(2),y:ly,"text-anchor":anchor,class:"t-name","font-size":13},s.name));
      g.appendChild(el("text",{x:lblX.toFixed(2),y:ly+15,"text-anchor":anchor,class:"t-pct","font-size":11},s.sub));
      const a=el("text",{x:lblX.toFixed(2),y:ly+32,"text-anchor":anchor,class:"t-amt","font-size":13});
      a.appendChild(document.createTextNode(fmtOCT(s.raw)+" · "));
      a.appendChild(el("tspan",{class:"t-pct"}, fmtPct(pctR(s.raw,A.raw.inCirc))+"%"));
      g.appendChild(a);
    } else {
      g.appendChild(el("text",{x:s.x+14,y:barH/2-8,class:s.inv?"t-name-inv":"t-name","font-size":15,"dominant-baseline":"middle"},s.name));
      const a=el("text",{x:s.x+14,y:barH/2+14,class:s.inv?"t-amt-inv":"t-amt","font-size":17,"dominant-baseline":"middle"});
      a.appendChild(document.createTextNode(fmtOCT(s.raw)+" "));
      a.appendChild(el("tspan",{class:s.inv?"t-pct-inv":"t-pct","font-size":12.5}, fmtPct(pctR(s.raw,A.raw.inCirc))+"% of circulating"));
      g.appendChild(a);
    }
  });
  svg.appendChild(g);
  host.innerHTML=""; host.appendChild(svg);
}

/* ============================================================================
   ACT I · CROSS-CHAIN FLOW — hand-computed alluvial across the chain boundary.
   Ribbon thickness == segment share of locked height on BOTH faces -> exits sum
   exactly to the inflow.
   ============================================================================ */
function renderFlow(){
  const host = document.getElementById("fig-flow");
  const H=322;  // viewBox cropped to content (fills the column); top/bottom padding tuned to match the split chart
  const bridgeX=278, barTop=50, barH=84, gap=8, barLen=208;

  // wOCT claims are measured against locked OCT collateral. Both blocks are drawn
  // to one scale; the residual locked collateral is magnified below.
  const resRaw = A.raw.unclaimed + A.raw.unclassified;
  const wL = barLen;
  const wR = barLen * ratio(A.raw.woct, A.raw.locked);
  const lX = bridgeX - gap/2 - wL, cL = lX + wL/2;
  const rX = bridgeX + gap/2,      cR = rX + wR/2;

  const svg = el("svg",{viewBox:`32 0 540 ${H}`, width:"100%", height:"auto", role:"img",
    "aria-label":`${fmtOCT(A.raw.woct,0)} wOCT claims on Ethereum are backed by ${fmtOCT(A.raw.locked,0)} OCT locked on Octra. The remaining locked collateral is shown enlarged below: ${fmtOCT(A.raw.unclaimed,0)} unclaimed and ${fmtOCT(A.raw.unclassified,0)} unclassified.`});

  // textures for the enlarged residual: diagonal hatch = unclaimed, dots = unclassified
  const defs=el("defs");
  const ph=el("pattern",{id:"px-hatch",patternUnits:"userSpaceOnUse",width:7,height:7,patternTransform:"rotate(45)"});
  ph.appendChild(el("rect",{width:7,height:7,fill:"var(--blue-soft)"})); ph.appendChild(el("rect",{width:3,height:7,fill:"var(--blue)"}));
  defs.appendChild(ph);
  const pd=el("pattern",{id:"px-dots",patternUnits:"userSpaceOnUse",width:7,height:7});
  pd.appendChild(el("rect",{width:7,height:7,fill:"var(--paper-2)"})); pd.appendChild(el("circle",{cx:3.5,cy:3.5,r:1.35,fill:"var(--structural)"}));
  defs.appendChild(pd); svg.appendChild(defs);

  const g=el("g");

  // two equal blocks, one per chain, meeting at the bridge
  g.appendChild(el("rect",{x:lX.toFixed(2),y:barTop,width:wL.toFixed(2),height:barH,fill:"var(--blue)",rx:2}));
  g.appendChild(el("rect",{x:rX.toFixed(2),y:barTop,width:wR.toFixed(2),height:barH,fill:"var(--blue)",rx:2}));

  // the bridge divider
  g.appendChild(el("line",{x1:bridgeX,y1:barTop-24,x2:bridgeX,y2:barTop+barH+14,stroke:"var(--blue)","stroke-width":2,"stroke-linecap":"round"}));
  g.appendChild(el("text",{x:bridgeX,y:barTop-30,"text-anchor":"middle",class:"t-unit","font-size":10,fill:"var(--blue)"},"BRIDGE CLAIMS"));

  // chain labels above, amounts below
  g.appendChild(el("text",{x:cL.toFixed(2),y:barTop-12,"text-anchor":"middle",class:"t-name","font-size":13},"Locked on Octra"));
  g.appendChild(el("text",{x:cR.toFixed(2),y:barTop-12,"text-anchor":"middle",class:"t-name","font-size":13},"wOCT on Ethereum"));
  g.appendChild(el("text",{x:cL.toFixed(2),y:barTop+barH+24,"text-anchor":"middle",class:"t-amt","font-size":16}, fmtOCT(A.raw.locked,0)));
  g.appendChild(el("text",{x:cL.toFixed(2),y:barTop+barH+40,"text-anchor":"middle",class:"t-pct","font-size":11},"OCT, locked in the vault"));
  g.appendChild(el("text",{x:cR.toFixed(2),y:barTop+barH+24,"text-anchor":"middle",class:"t-amt","font-size":16}, fmtOCT(A.raw.woct,0)));
  g.appendChild(el("text",{x:cR.toFixed(2),y:barTop+barH+40,"text-anchor":"middle",class:"t-pct","font-size":11}, fmtPct(A.pct.woctOfLocked)+"% of locked claims"));

  // ---- the small residual, enlarged ----
  const dTop=barTop+barH+74, dH=26, dLeft=bridgeX-150, dRight=bridgeX+150, dW=dRight-dLeft;
  const ucW=resRaw === 0n ? 0 : dW*ratio(A.raw.unclaimed,resRaw);
  g.appendChild(el("text",{x:dLeft.toFixed(2),y:dTop-9,class:"t-unit","font-size":10}, `THE ${fmtPct(pctR(resRaw,A.raw.locked,2))}% STILL ON OCTRA, ENLARGED · ${fmtOCT(resRaw,0)} OCT`));
  g.appendChild(el("rect",{x:dLeft.toFixed(2),y:dTop,width:(ucW-1).toFixed(2),height:dH,fill:"url(#px-hatch)",stroke:"var(--blue)","stroke-width":1}));
  g.appendChild(el("rect",{x:(dLeft+ucW+1).toFixed(2),y:dTop,width:(dW-ucW-1).toFixed(2),height:dH,fill:"url(#px-dots)",stroke:"var(--structural)","stroke-width":1}));
  const lab=(x,sw,strk,name,raw,sub)=>{
    g.appendChild(el("rect",{x:x.toFixed(2),y:dTop+dH+11,width:22,height:9,fill:sw,stroke:strk,"stroke-width":1}));
    g.appendChild(el("text",{x:(x+28).toFixed(2),y:dTop+dH+19,class:"t-name","font-size":12},name));
    g.appendChild(el("text",{x:x.toFixed(2),y:dTop+dH+37,class:"t-amt","font-size":13}, fmtOCT(raw)));
    g.appendChild(el("text",{x:x.toFixed(2),y:dTop+dH+53,class:"t-pct","font-size":11}, fmtPct(pctR(raw,A.raw.locked,3),3)+"% of locked"));
    g.appendChild(el("text",{x:x.toFixed(2),y:dTop+dH+68,class:"t-pct","font-size":10.5,fill:"var(--muted)"},sub));
  };
  lab(dLeft,        "url(#px-hatch)", "var(--blue)",  "unclaimed",    A.raw.unclaimed,    "claimable recovery");
  lab(dLeft+ucW+10, "url(#px-dots)",  "var(--structural)", "unclassified", A.raw.unclassified, "remaining collateral");

  svg.appendChild(g);
  host.innerHTML=""; host.appendChild(svg);
}

/* ============================================================================
   SPARKLINES — hand-rolled, word-sized. One renderer, sparkSM(), drives both the
   Act II live-state grid and the Act III ledger through the flow/trend lens: flow
   plots per-interval change, trend self-scales the level; a genuinely-constant
   series renders an honest flat hairline, and the row's own figure carries magnitude.
   ============================================================================ */
function seriesOCT(col){ return activeSeries().map(r=>octNum(BigInt(r[col]))); }
function seriesPctOfCap(col){ return activeSeries().map(r=>pctR(BigInt(r[col]), A.raw.max, 4)); }
function seriesPctOfCirc(col){ return activeSeries().map(r=>pctR(BigInt(r[col]), BigInt(r[COL.INCIRC]), 4)); }
function seriesPegPct(){ return activeSeries().map(r=>pctR(BigInt(r[COL.WOCT]), BigInt(r[COL.LOCKED]), 4)); }
function seriesPublicPctOfCirc(){ return activeSeries().map(r=> pctR(BigInt(r[COL.INCIRC])-BigInt(r[COL.ENC]), BigInt(r[COL.INCIRC]), 4)); }

/* Act II small-multiple sparkline (returns HTML string) */
/* live-state sparkline lens: "flow" = per-interval change (default) · "trend" = level trajectory.
   "absolute" is a wired-but-unexposed hook (zero/reference-based) for a future third tab. */
let sparkMode = (()=>{ try{ const m=localStorage.getItem("octv.sparkMode"); return (m==="trend"||m==="flow"||m==="absolute")?m:"flow"; }catch(e){ return "flow"; } })();
let sparkWindow = (()=>{ try{ const m=localStorage.getItem("octv.sparkWindow"); return HISTORY_WINDOWS[m] ? m : DEFAULT_HISTORY_WINDOW; }catch(e){ return DEFAULT_HISTORY_WINDOW; } })();

function sparkSM(values, opts={}){
  const mode = opts.mode || sparkMode;
  const W=100, H=34, padL=1, padR=4, padT=5, padB=5;
  const innerW=W-padL-padR, innerH=H-padT-padB, n=values.length;
  const x=i=> padL + (n<=1?innerW/2:(i/(n-1))*innerW);
  const midY=padT+innerH/2;
  const wrap = inner => `<span class="spark"><svg class="sl-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(opts.aria||"")}">${inner}</svg></span>`;
  if(!n) return `<span class="spark"></span>`;

  // FLOW — plot the change in each 15-minute interval as zero-baseline bars (up/down by sign).
  // A constant stretch reads as a calm zero-line; one real move reads as one bar. Cannot be
  // flattened by a single dominant step, and the per-card delta label discloses magnitude.
  if(mode==="flow"){
    const d=values.map((v,i)=> i===0?0:v-values[i-1]);
    const maxAbs=Math.max(0,...d.map(Math.abs));
    const zero=`<line class="sl-zero" x1="${padL}" y1="${midY.toFixed(2)}" x2="${(padL+innerW).toFixed(2)}" y2="${midY.toFixed(2)}" vector-effect="non-scaling-stroke"/>`;
    if(!(maxAbs>0)) return wrap(`${zero}<circle class="sl-point flatpt" cx="${(padL+innerW).toFixed(2)}" cy="${midY.toFixed(2)}" r="2.3"/>`);
    const half=innerH/2, step=n>1?innerW/(n-1):innerW, bw=Math.max(0.8,Math.min(step*0.62,3));
    let bars="";
    for(let i=1;i<n;i++){
      const h=(Math.abs(d[i])/maxAbs)*half; if(h<0.02) continue;
      const up=d[i]>=0;
      bars+=`<rect class="sl-bar${up?'':' dn'}" x="${(x(i)-bw/2).toFixed(2)}" y="${(up?midY-h:midY).toFixed(2)}" width="${bw.toFixed(2)}" height="${Math.max(h,0.6).toFixed(2)}"/>`;
    }
    const lh=(Math.abs(d[n-1])/maxAbs)*half, lty=d[n-1]===0?midY:(d[n-1]>0?midY-lh:midY+lh);
    return wrap(`${zero}${bars}<circle class="sl-point" cx="${x(n-1).toFixed(2)}" cy="${lty.toFixed(2)}" r="2"/>`);
  }

  // TREND / ABSOLUTE — level line. Genuinely-constant series render as an honest flat hairline
  // (so sub-rounding jitter is never amplified into a hook). trend self-scales to the window with
  // padding + min/max dots so the magnitude stays legible; absolute (hook) is zero/reference-based.
  const obsMin=Math.min(...values), obsMax=Math.max(...values), range=obsMax-obsMin;
  const lvl=Math.max(Math.abs(obsMax),1e-12);
  if(range/lvl < 1e-7){
    return wrap(`<line class="sl-line flatln" x1="${padL}" y1="${midY.toFixed(2)}" x2="${(padL+innerW).toFixed(2)}" y2="${midY.toFixed(2)}" vector-effect="non-scaling-stroke"/><circle class="sl-point flatpt" cx="${(padL+innerW).toFixed(2)}" cy="${midY.toFixed(2)}" r="2.3"/>`);
  }
  let dMin, dMax;
  if(mode==="absolute"){ dMin=0; dMax=(opts.absMax!==undefined?opts.absMax:obsMax)||1; }
  else { const pad=range*0.14; dMin=obsMin-pad; dMax=obsMax+pad; }
  const span=(dMax-dMin)||1;
  const y=v=> padT + innerH - ((v-dMin)/span)*innerH;
  const dPath=values.map((v,i)=>`${i?"L":"M"}${x(i).toFixed(2)} ${y(v).toFixed(2)}`).join(" ");
  return wrap(`<path class="sl-line" d="${dPath}" vector-effect="non-scaling-stroke"/><circle class="sl-point" cx="${x(n-1).toFixed(2)}" cy="${y(values[n-1]).toFixed(2)}" r="2.3"/>`);
}

function setupSparkMode(){
  // every .spark-mode group (live-state grid + Act III ledger) drives one shared lens, kept in sync
  const opts = document.querySelectorAll("[data-spark-mode]");
  if(!opts.length) return;
  const apply = ()=> opts.forEach(b=>b.setAttribute("aria-pressed", String(b.dataset.sparkMode===sparkMode)));
  opts.forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const m=btn.dataset.sparkMode;
      if(!m || m===sparkMode) return;
      sparkMode=m;
      try{ localStorage.setItem("octv.sparkMode", m); }catch(e){}
      apply();
      if(renderReady) buildState();
      if(verifyRendered) buildLedgerSparks();
    });
  });
  apply();
}

function setupSparkWindow(){
  const opts = document.querySelectorAll("[data-history-window]");
  if(!opts.length) return;
  opts.forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const m = btn.dataset.historyWindow;
      if(!HISTORY_WINDOWS[m] || m === sparkWindow) return;
      sparkWindow = m;
      try{ localStorage.setItem("octv.sparkWindow", m); }catch(e){}
      syncHistoryWindowControls();
      if(renderReady) buildState();
      if(verifyRendered) buildLedgerSparks();
    });
  });
  syncHistoryWindowControls();
}

function setupSparkControls(){
  setupSparkMode();
  setupSparkWindow();
}

/* ============================================================================
   ACT II · READING LINE (four clocks)  — public v0 layout.
   ============================================================================ */
function buildClocks(){
  const c=A.clocks, head=c.octra_epoch;
  const win=Math.max(head-Math.min(c.relayer_finalized,c.recovery_scanned)+4,16);
  const lagPos=e=>Math.max(0,Math.min(100,100-((head-e)/win)*100));
  const ruler=(e,isHead)=>`<div class="lagbar" data-width="${lagPos(e).toFixed(1)}"><i class="${isHead?'head':''}"></i></div>`;
  const items=[
    {k:"Octra epoch",       v:c.octra_epoch.toLocaleString(),       s:"chain head · src 7777",                head:true,  r:ruler(c.octra_epoch,true)},
    {k:"Relayer finalized", v:c.relayer_finalized.toLocaleString(), s:"−"+(head-c.relayer_finalized)+" epochs · quorum 1", head:false, r:ruler(c.relayer_finalized,false)},
    {k:"Recovery scanned",  v:c.recovery_scanned.toLocaleString(),  s:"−"+(head-c.recovery_scanned)+" epochs · re-org guard", head:false, r:ruler(c.recovery_scanned,false)},
    {k:"Ethereum block",    v:c.eth_block.toLocaleString(),         s:A.snapshot.eth_block_hex+" · dst 1",     head:true,  r:""}
  ];
  document.getElementById("clocks").innerHTML = items.map(it=>`
    <div class="clock">
      <div class="k"><span class="dot${it.head?'':' lag'}"></span>${esc(it.k)}</div>
      <div class="v num">${esc(it.v)}</div>
      <div class="s num">${esc(it.s)}</div>
      ${it.r}
    </div>`).join("");
  document.querySelectorAll(".lagbar").forEach((bar)=>{
    const fill = bar.querySelector("i");
    if(fill) fill.style.width = `${bar.getAttribute("data-width") || "0"}%`;
  });
}

/* ============================================================================
   ACT II · SMALL MULTIPLES — eight live-state panels.
   Required set: in-circulation %, burned, encrypted, locked, wOCT,
   wOCT coverage, unclassified, unclaimed.
   ============================================================================ */
function panel(cfg){
  const showFlat = cfg.flat && hasCanonicalHistoryWindow();
  const tag = showFlat ? `<span class="flagtag" title="Stable over the observed window"><span class="ln"></span>flat</span>` : "";
  const right = showFlat ? tag : (cfg.unit?`<span class="unit">${cfg.unit}</span>`:"");
  const delta = cfg.delta ? `<div class="p-delta num">${cfg.delta}</div>` : "";
  return `<article class="panel${showFlat?" flat":""}"${cfg.aria?` aria-label="${esc(cfg.aria)}"`:""}>
    <div class="p-name">${cfg.name}${right?`<span>${right}</span>`:""}</div>
    <div class="p-val num">${cfg.value}</div>
    <div class="p-sub num">${cfg.sub||""}</div>
    <div class="p-spark">${cfg.spark||""}</div>
    ${delta}
    <div class="p-prov"><span class="clk"></span>${cfg.prov}</div>
  </article>`;
}
function buildState(){
  syncHistoryWindowControls();
  const clkO = "Octra epoch "+A.clocks.octra_epoch.toLocaleString();
  const clkRel = "relayer fin "+A.clocks.relayer_finalized.toLocaleString();
  const clkEth = "eth block "+A.snapshot.eth_block.toLocaleString();
  const clkRec = "recovery "+A.clocks.recovery_scanned.toLocaleString();
  const cp = (raw)=>{ const p=compactParts(raw); return p.num+(p.sfx?`<span class="sfx">${p.sfx}</span>`:""); };
  const trend = trendPhrase();

  const panels = [];

  // 1) IN CIRCULATION — % of cap
  panels.push(panel({
    name:"In circulation", unit:"% of cap",
    value: fmtPct(A.pct.circOfCap)+`<span class="sfx">%</span>`,
    sub: compact(A.raw.inCirc)+" OCT",
    spark: sparkSM(seriesPctOfCap(COL.INCIRC), {aria:"In circulation, share of cap over the recent snapshot window."}),
    delta: deltaRaw(COL.INCIRC),
    prov: clkO, aria:"In circulation, share of cap."
  }));
  // 2) BURNED — single out-of-circulation category
  panels.push(panel({
    name:"Burned", unit:"OCT",
    value: fmtPct(A.pct.burnedOfCap)+`<span class="sfx">%</span>`,
    sub: compact(A.raw.burned)+" OCT",
    spark: sparkSM(seriesPctOfCap(COL.BURN), {aria:"Burned supply, share of cap over the recent snapshot window."}),
    delta: deltaRaw(COL.BURN),
    prov: "burn field", aria:"Burned supply."
  }));
  // 3) ENCRYPTED — % of circulating, fixed scale with real AML history
  panels.push(panel({
    name:"Encrypted", unit:"% of circ",
    value: fmtPct(A.pct.encOfCirc)+`<span class="sfx">%</span>`,
    sub: compact(A.raw.encrypted)+" OCT · FHE state",
    spark: sparkSM(seriesPctOfCirc(COL.ENC), {aria:`Encrypted, share of circulating, ${trend}.`}),
    delta: deltaRaw(COL.ENC),
    prov: clkO, aria:`Encrypted, share of circulating, ${trend}.`
  }));
  // 4) LOCKED — OCT level
  panels.push(panel({
    name:"Locked", unit:"OCT · vault",
    value: cp(A.raw.locked),
    sub: "vault holds "+compact(A.raw.vault),
    spark: sparkSM(seriesOCT(COL.LOCKED), {aria:"Locked OCT in vault over the recent snapshot window."}),
    delta: deltaRaw(COL.LOCKED),
    prov: clkRec, aria:"Locked OCT in vault."
  }));
  // 5) wOCT — OCT level (same scale -> sits just under locked)
  panels.push(panel({
    name:"wOCT minted", unit:"OCT · eth",
    value: cp(A.raw.woct),
    sub: "claims backed by locked OCT",
    spark: sparkSM(seriesOCT(COL.WOCT), {aria:"Wrapped OCT on Ethereum over the recent snapshot window."}),
    delta: deltaRaw(COL.WOCT),
    prov: clkEth, aria:"Wrapped OCT on Ethereum."
  }));
  // 6) wOCT COVERAGE — wOCT / locked, honest 0..100
  panels.push(panel({
    name:"wOCT coverage", unit:"wOCT ÷ locked",
    value: fmtPct(A.pct.pegFull)+`<span class="sfx">%</span>`,
    sub: "gap = unclaimed + unclassified",
    spark: sparkSM(seriesPegPct(), {aria:"wOCT coverage, wOCT over locked over the recent snapshot window."}),
    delta: deltaPct(seriesPegPct()),
    prov: clkEth, aria:"wOCT coverage, wOCT over locked."
  }));
  // 7) UNCLASSIFIED — real residual series, fixed to the bridge OCT-level scale
  panels.push(panel({
    name:"Unclassified", unit:"OCT · remaining",
    value: cp(A.raw.unclassified),
    sub: `derived · ${trend}`,
    spark: sparkSM(seriesOCT(COL.UNCLASS), {aria:`Unclassified remaining collateral, ${trend}.`}),
    delta: deltaRaw(COL.UNCLASS),
    prov: clkRec, aria:`Unclassified remaining collateral, ${trend}.`
  }));
  // 8) UNCLAIMED — OCT level (has the one real wiggle)
  panels.push(panel({
    name:"Unclaimed", unit:"OCT · claimable",
    value: cp(A.raw.unclaimed),
    sub: "claimable recovery",
    spark: sparkSM(seriesOCT(COL.UNCLAIMED), {aria:"Relayer-unclaimed OCT over the observed window."}),
    delta: deltaRaw(COL.UNCLAIMED),
    prov: clkRec, aria:"Relayer-unclaimed OCT."
  }));

  document.getElementById("grid-state").innerHTML = panels.join("");
}

/* ============================================================================
   ACT III · LEDGER FIGURES (read from A; styled whole/dec/pct)
   ============================================================================ */
function fillFig(sel, raw, pctLabel, accent){
  const node = document.querySelector(`[data-fig="${sel}"]`);
  if(!node) return;
  const p = fmtParts(raw);
  node.innerHTML = `${p.whole}<span class="dec">${p.dec}</span>` + (pctLabel?`<span class="pct${accent?' accent':''}">${pctLabel}</span>`:"");
}
function buildLedger(){
  fillFig("max",        A.raw.max,        "100.00% of cap");
  fillFig("circ",       A.raw.inCirc,     fmtPct(A.pct.circOfCap)+"% of cap", true);
  fillFig("public",     A.raw.public,     fmtPct(A.pct.publicOfCirc)+"% circ.");
  fillFig("encrypted",  A.raw.encrypted,  fmtPct(A.pct.encOfCirc)+"% circ.");
  fillFig("nic",        A.raw.burned,     fmtPct(A.pct.burnedOfCap)+"% of cap");

  fillFig("locked",     A.raw.locked,     fmtPct(A.pct.lockedOfGross)+"% of gross lock");
  fillFig("woct",       A.raw.woct,       fmtPct(A.pct.woctOfLocked)+"% locked", true);
  fillFig("unclaimed",  A.raw.unclaimed,  fmtPct(A.pct.unclaimedOfLocked,3)+"% locked");
  fillFig("unclassified",A.raw.unclassified, fmtPct(A.pct.unclassOfLocked,3)+"% locked");
  fillFig("locked2",    A.raw.locked,     "= locked", true);
}

/* ledger sparkline wiring */
const LSPARKS = {
  "issued":      {data:()=>seriesOCT(COL.INCIRC), aria:"In circulation over the available snapshot history."},
  "public":      {data:()=>activeSeries().map(r=>octNum(BigInt(r[COL.INCIRC])-BigInt(r[COL.ENC]))), aria:"Public balance, derived as issued minus encrypted, over the available snapshot history."},
  "encrypted":   {data:()=>seriesOCT(COL.ENC), aria:"Encrypted balance over the observed window."},
  "locked":      {data:()=>seriesOCT(COL.LOCKED), aria:"Locked on Octra over the observed window."},
  "woct":        {data:()=>seriesOCT(COL.WOCT), aria:"wOCT minted over the observed window."},
  "unclaimed":   {data:()=>seriesOCT(COL.UNCLAIMED), aria:"Relayer-unclaimed OCT over the observed window."},
  "flat-unclass":{data:()=>seriesOCT(COL.UNCLASS), aria:"Unclassified remaining collateral over the available snapshot history."},
  "flat-cap":    {data:()=>activeSeries().map(()=>1), aria:"Hard cap is flat by definition."},
  "flat-burn":   {data:()=>seriesOCT(COL.BURN), aria:"Burned supply over the available snapshot history."}
};
function buildLedgerSparks(){
  document.querySelectorAll("[data-spark]").forEach(host=>{
    const cfg = LSPARKS[host.getAttribute("data-spark")];
    if(!cfg) return;
    host.innerHTML = sparkSM(cfg.data(), {aria:cfg.aria});  // same flow/trend lens as the live-state grid
  });
}

/* ============================================================================
   ACT III · IDENTITIES + signed residuals (public v0 layout)
   ============================================================================ */
function buildIdentities(){
  document.getElementById("id-issue").innerHTML =
    `public ${fmtOCT(A.raw.public)}<br><span class="op">+</span> encrypted ${fmtOCT(A.raw.encrypted)}<br><span class="op">=</span> in circulation ${fmtOCT(A.raw.inCirc)}`;
  setRes("res-issue", A.res.issuance, "OCT residual");

  document.getElementById("id-lock").innerHTML =
    `wOCT claims ${fmtOCT(A.raw.woct)}<br><span class="op">+</span> relayer-unclaimed ${fmtOCT(A.raw.unclaimed)}<br><span class="op">≤</span> locked collateral ${fmtOCT(A.raw.locked)}<br><span class="op">=</span> remaining collateral ${fmtOCT(A.raw.claimBalance)}`;
  setClaimRes("res-lock");

  document.getElementById("id-vault").innerHTML =
    `vault balance ${fmtOCT(A.raw.vault)}<br><span class="op">−</span> locked ledger ${fmtOCT(A.raw.locked)}<br><span class="op">=</span> backing dust`;
  setRes("res-vault", A.res.vaultDust, "OCT over-backed");
}
function setClaimRes(id){
  const wrap=document.getElementById(id);
  if(A.raw.claimOverage > 0n){
    wrap.innerHTML =
      `<span class="rdot neg"></span>`+
      `<span class="badge b-neg">over-claim</span>`+
      `<span class="amt">${fmtOCT(A.raw.claimOverage)} OCT claims exceed locked collateral</span>`;
    return;
  }
  if(A.raw.claimBalance > 0n){
    wrap.innerHTML =
      `<span class="rdot warn"></span>`+
      `<span class="badge b-warn">residual</span>`+
      `<span class="amt">${fmtOCT(A.raw.claimBalance)} OCT locked collateral remains unclassified</span>`;
    return;
  }
  wrap.innerHTML =
    `<span class="rdot pos"></span>`+
    `<span class="badge b-pos">backed ✓</span>`+
    `<span class="amt">residual 0 OCT</span>`;
}
function setRes(id, residual, unit){
  const wrap=document.getElementById(id);
  const zero=residual===0n, positive=residual>0n;
  let cls,dotCls;
  if(zero){ cls="b-pos"; dotCls="pos"; }
  else if(positive){ cls="b-pos"; dotCls="pos"; }
  else { cls="b-neg"; dotCls="neg"; }
  wrap.innerHTML =
    `<span class="rdot ${dotCls}"></span>`+
    `<span class="badge ${cls}">${zero?"balances ✓":(positive?"surplus":"deficit")}</span>`+
    `<span class="amt">${zero?"residual 0":(fmtOCT(residual)+" "+unit)}</span>`;
}

/* ============================================================================
   META · nav, provenance links, hashes, a11y table
   ============================================================================ */
function buildMeta(){
  const s=A.snapshot, p=A.prov;
  const snapshotHref = p.receipt_tx ? octraTxHref(p.receipt_tx) : apiHref("/api/latest");
  const isSample = A.source?.source === "sample_fallback";
  const freshLabel = isSample ? "Sample snapshot" : A.source?.fresh === false ? "Stale snapshot" : "Snapshot";
  const routeLabel = `Octra ${p.src_chain || "—"} → Ethereum ${p.dst_chain || "—"}`;
  const routeUnit = document.getElementById("bridge-route-unit");
  if(routeUnit) routeUnit.textContent = routeLabel;
  document.querySelectorAll('[data-route="src"]').forEach((node)=>{ node.textContent = p.src_chain || "—"; });
  document.querySelectorAll('[data-route="dst"]').forEach((node)=>{ node.textContent = p.dst_chain || "—"; });
  const navClock = document.getElementById("nav-snapshot");
  document.getElementById("nav-sid").textContent = freshLabel;
  document.getElementById("nav-obs").textContent = browserSnapshotStamp(s.observed_at);
  if(navClock){
    navClock.href = snapshotHref;
    navClock.rel = "noreferrer";
    const title = `${s.id} · ${snapshotStatusText()} · observed ${browserDateTime(s.observed_at)} · ${utcDateTime(s.observed_at)} · ${relativeAge(s.observed_at)}`;
    navClock.title = title;
    navClock.setAttribute("aria-label", `${freshLabel}, ${snapshotStatusText()}, observed ${browserDateTime(s.observed_at)}, snapshot ${s.id}`);
  }

  // Inline ledger refs get short labels; provenance rows below are overwritten with full values.
  const setLink = (key,href,text,title)=> document.querySelectorAll(`[data-link="${key}"]`).forEach(a=>{
    if(href) {
      a.href = href;
      a.rel = "noreferrer";
      a.classList.remove("link-unavailable");
    } else {
      a.removeAttribute("href");
      a.classList.add("link-unavailable");
    }
    if(text !== undefined) a.textContent = text || "—";
    if(title) a.title = title;
  });
  setLink("snapshot", snapshotHref, shortRef(s.id,18,8), s.id);
  setLink("program", p.program !== "pending" ? octraAddressHref(p.program) : null, shortRef(p.program), p.program);
  setLink("siteCircle", p.site_circle !== "pending" ? `oct://${p.site_circle}/index.html` : null, shortRef(p.site_circle), `oct://${p.site_circle}/index.html`);
  setLink("vault", p.vault !== "pending" ? octraAddressHref(p.vault) : null, shortRef(p.vault), p.vault);
  setLink("woct", p.woct !== "pending" ? `${ETHERSCAN}/token/${p.woct}` : null, shortRef(p.woct), p.woct);
  setLink("ethBridge", p.ethBridge !== "pending" ? `${ETHERSCAN}/address/${p.ethBridge}` : null, shortRef(p.ethBridge), p.ethBridge);
  setLink("validator", s.validator !== "pending" ? octraAddressHref(s.validator) : null, shortRef(s.validator), s.validator);

  // each measured ledger figure links to the content-addressed evidence it was read from (verify the number);
  // text is left intact (pass undefined), so only the href is wired. Bridge rows already link their contract address.
  const evRefs = p.source_refs || [];
  setLink("ev-supply", sourceRefUrl(evRefs, "octra.batch"), undefined, "Raw octra_supply batch · content-addressed evidence");
  setLink("ev-unclaimed", sourceRefUrl(evRefs, "relayer.recovery"), undefined, "Raw relayer recovery · content-addressed evidence");

  // hashes
  const T=(id,v)=>{ const e=document.getElementById(id); if(e){ e.textContent=v; e.title=v; } };
  T("pv-status", snapshotStatusText());
  T("pv-snap", s.id);
  T("pv-prog", p.program);
  T("pv-circle", p.site_circle);
  T("pv-vault", p.vault);
  T("pv-woct", p.woct);
  T("pv-ethbridge", p.ethBridge);
  T("pv-validator", s.validator);
  T("pv-relayer", p.relayer_mode+(p.quorum ? " · quorum "+p.quorum : ""));
  const recipients = A.bridgeMeta.recipients ? ` · recipients ${A.bridgeMeta.recipients.toLocaleString()}` : "";
  T("pv-lifetime", `locks ${A.bridgeMeta.lock_nonce.toLocaleString()} · unlocks ${A.bridgeMeta.unlock_count.toLocaleString()}${recipients} · txid_hi ${s.txid_hi.toLocaleString()}`);

  // sr-only data table (full numeric restatement)
  const rows=[
    ["Cap (max)", fmtOCT(A.raw.max,6), "100%"],
    ["In circulation", fmtOCT(A.raw.inCirc,6), fmtPct(A.pct.circOfCap)+"% of cap"],
    ["Public balance (issued − encrypted)", fmtOCT(A.raw.public,6), fmtPct(A.pct.publicOfCirc)+"% of circ"],
    ["Encrypted balance", fmtOCT(A.raw.encrypted,6), fmtPct(A.pct.encOfCirc)+"% of circ"],
    ["Burned", fmtOCT(A.raw.burned,6), fmtPct(A.pct.burnedOfCap)+"% of cap"],
    ["Locked in vault", fmtOCT(A.raw.locked,6), fmtPct(A.pct.bridgedOfCirc)+"% of circ"],
    ["wOCT claims", fmtOCT(A.raw.woct,6), fmtPct(A.pct.woctOfLocked)+"% of locked"],
    ["Relayer-unclaimed", fmtOCT(A.raw.unclaimed,6), fmtPct(A.pct.unclaimedOfLocked,3)+"% of locked"],
    ["Unclassified remaining collateral", fmtOCT(A.raw.unclassified,6), fmtPct(A.pct.unclassOfLocked,3)+"% of locked"],
    ["Vault balance", fmtOCT(A.raw.vault,6), "+"+fmtOCT(A.res.vaultDust,6)+" over locked"]
  ];
  let html="<thead><tr><th>State</th><th>OCT</th><th>Share</th></tr></thead><tbody>";
  rows.forEach(r=> html+=`<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td>${esc(r[2])}</td></tr>`);
  document.getElementById("datatable").innerHTML = html+"</tbody>";

  // verification / external links (explorer, circle, evidence) open in a new tab; in-page (#) anchors stay
  document.querySelectorAll("a[href]").forEach((a)=>{
    if(/^(https?:|oct:|\/api\/)/i.test(a.getAttribute("href") || "")){ a.target = "_blank"; a.rel = "noopener noreferrer"; }
  });
}

/* ============================================================================
   BOOT
   ============================================================================ */
function showUnavailable(error){
  renderReady = false;
  const main = document.querySelector("main") || document.body;
  const panel = document.createElement("section");
  panel.className = "load-error";
  panel.setAttribute("role", "alert");
  panel.innerHTML = `
    <div class="wrap">
      <h2>Latest snapshot unavailable</h2>
      <p>Program-backed snapshot data is unavailable right now. No sample values were rendered.</p>
      <pre>${esc(error?.message || error || "snapshot_unavailable")}</pre>
    </div>`;
  main.prepend(panel);
}

function perfMark(name){
  try{ window.performance?.mark?.(`octra-vitals:${name}`); }catch{}
}

function afterFirstPaint(fn){
  window.requestAnimationFrame(()=>setTimeout(fn, 0));
}

function renderFirstViewport(){
  buildMeta();
  renderCapGrid();
  renderCapParts();
}

function renderSecondaryViews(){
  renderSplit();
  renderFlow();
  buildClocks();
  buildState();
}

let verifyRendered = false;

function renderVerifyViews(){
  buildLedger();
  buildLedgerSparks();
  buildIdentities();
  verifyRendered = true;
}

function setupVerifyLazyRender(){
  const details = document.getElementById("verify-details");
  if(!details) return;
  const renderIfOpen = ()=>{
    if(details.open && !verifyRendered) renderVerifyViews();
  };
  details.addEventListener("toggle", renderIfOpen);
  renderIfOpen();
}

function logIdentityCheck(){
  const ok = A.res.issuance===0n && A.res.capSplit===0n && A.res.custody<=0n
          && A.res.vaultDust===A.raw.vaultSurplus;
  const health = A.health?.conservation;
  console.info("[Octra Vitals] identities — issuance=0:", A.res.issuance===0n,
    "| capSplit=0:", A.res.capSplit===0n,
    "| bridge claims <= locked:", A.res.custody<=0n,
    "| vaultDust =", fmtOCT(A.res.vaultDust)+" OCT (expected +"+fmtOCT(A.raw.vaultSurplus)+", over-backed):", A.res.vaultDust===A.raw.vaultSurplus,
    "| lifetime grossLock−unlocked=locked (derived check):", A.res.lifetime===0n,
    "| signed snapshot health:", health?.status || "not_provided", health?.flags || []);
  if(!ok) console.warn("[Octra Vitals] a snapshot identity did NOT hold — investigate before publishing.");
}

function applyCanonicalHistory(historyResult){
  const historyBody = historyResult?.body || {};
  const historyAuthority = historyBody.authority || {};
  if(historyAuthority.canonical_state_read !== true) return false;
  const history = historyRows(historyBody, DATA);
  DATA = {
    ...DATA,
    series: history.rows,
    history_points: history.distinctCount,
    source: {
      ...DATA.source,
      history_canonical: true,
      history_source: historyAuthority.source || null,
      history_url: historyResult.url || null
    }
  };
  A = accounting(DATA);
  buildState();
  if(verifyRendered) renderVerifyViews();
  return true;
}

async function hydrateHistory(initialLoad){
  let versionResult = initialLoad.versionResult;
  if(!versionResult && (isStaticOnlyOrigin() || isCircleClientOrigin())) versionResult = await initialLoad.versionPromise;
  const historyResult = await loadCanonicalHistory(versionResult);
  if(applyCanonicalHistory(historyResult)){
    perfMark("history_applied");
  }
}

async function boot(){
  try{
    perfMark("boot_start");
    setupEnvironmentBanner(APP_CONFIG);
    const initialLoad = await loadInitialData();
    DATA = initialLoad.data;
    A = accounting(DATA);
    renderReady = true;
    verifyRendered = false;

    renderFirstViewport();
    setupVerifyLazyRender();
    setupSparkControls();
    perfMark("first_viewport_rendered");

    afterFirstPaint(()=>{
      try{
        renderSecondaryViews();
        logIdentityCheck();
        perfMark("secondary_rendered");
      }catch(error){
        console.error(error);
      }
      hydrateHistory(initialLoad).catch((error)=>{
        console.warn("[Octra Vitals] canonical history unavailable; rendering latest-only trend state", error);
      });
    });
  }catch(err){
    console.error(err);
    showUnavailable(err);
    const m=document.createElement("pre");
    m.style.cssText="color:var(--neg);padding:16px;white-space:pre-wrap;font:12px monospace";
    m.textContent="Render error: "+(err&&err.stack||err);
    document.body.appendChild(m);
  }
}

/* redraw the responsive SVGs on resize (debounced) */
let _rt;
window.addEventListener("resize", ()=>{
  clearTimeout(_rt);
  _rt=setTimeout(()=>{
    if(!renderReady) return;
    try{ renderCapGrid(); renderSplit(); renderFlow(); }catch(e){ console.error(e); }
  }, 140);
});

if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
