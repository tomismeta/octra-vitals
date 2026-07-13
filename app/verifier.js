(function attachOctraVitalsVerifier(root){
  "use strict";

  function requireEqual(label, actual, expected){
    if(actual !== expected) throw new Error(`${label} mismatch`);
  }

  function safeUnsigned(value, label){
    if(typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`${label} must be unsigned decimal digits`);
    return String(BigInt(value));
  }

  function safeNumber(value, label){
    if(typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`${label} must be unsigned decimal digits`);
    const parsed = Number(value);
    if(!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is outside the safe integer range`);
    return parsed;
  }

  function canonicalJson(value){
    if(value === null) return "null";
    if(Array.isArray(value)) return `[${value.map((item)=>canonicalJson(item)).join(",")}]`;
    if(typeof value === "object"){
      const entries = Object.entries(value)
        .filter(([, entryValue])=>entryValue !== undefined)
        .sort(([a], [b])=>a < b ? -1 : a > b ? 1 : 0);
      return `{${entries.map(([key, entryValue])=>`${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(",")}}`;
    }
    if(typeof value === "string") return JSON.stringify(value);
    if(typeof value === "number"){
      if(!Number.isFinite(value)) throw new TypeError("Cannot canonicalize non-finite number");
      return JSON.stringify(value);
    }
    if(typeof value === "boolean") return value ? "true" : "false";
    throw new TypeError(`Cannot canonicalize value of type ${typeof value}`);
  }

  function canonicalUtcSecond(value, label="observed_at"){
    if(typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)){
      throw new Error(`${label} must be a whole-second UTC timestamp`);
    }
    const parsed = Date.parse(value);
    if(!Number.isFinite(parsed) || new Date(parsed).toISOString().replace(".000Z", "Z") !== value){
      throw new Error(`${label} is not a real UTC timestamp`);
    }
    return parsed;
  }

  function nonNegativeSafeInteger(value, label){
    if(!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
    return value;
  }

  function parseSummaryRow(row){
    if(typeof row !== "string" || row.length !== 208) throw new Error("summary row length mismatch");
    const fields = row.split("|");
    if(fields.length !== 13) throw new Error("summary row field count mismatch");
    if(fields[0] !== "00") throw new Error("summary row version mismatch");
    const widths = [10, 12, 12, 12, 20, 20, 20, 20, 20, 20, 4];
    for(let index=0; index<widths.length; index++){
      if(!new RegExp(`^\\d{${widths[index]}}$`).test(fields[index + 1] || "")) throw new Error(`summary field ${index + 1} width mismatch`);
    }
    if(!/^[0-9a-f]{24}$/.test(fields[12] || "")) throw new Error("summary payload hash prefix is invalid");
    return {
      row_version: fields[0],
      snapshot_index: safeNumber(fields[1], "summary snapshot_index"),
      observed_at_unix: safeNumber(fields[2], "summary observed_at_unix"),
      octra_epoch: safeNumber(fields[3], "summary octra_epoch"),
      external_block: safeNumber(fields[4], "summary external_block"),
      issued_raw: safeUnsigned(fields[5], "summary issued_raw"),
      burned_raw: safeUnsigned(fields[6], "summary burned_raw"),
      encrypted_raw: safeUnsigned(fields[7], "summary encrypted_raw"),
      total_locked_raw: safeUnsigned(fields[8], "summary total_locked_raw"),
      total_wrapped_raw: safeUnsigned(fields[9], "summary total_wrapped_raw"),
      total_unclaimed_raw: safeUnsigned(fields[10], "summary total_unclaimed_raw"),
      route_count: safeNumber(fields[11], "summary route_count"),
      payload_hash_prefix: fields[12]
    };
  }

  function blockNumber(value){
    const parsed = typeof value === "string" && /^0x[0-9a-f]+$/i.test(value)
      ? Number.parseInt(value, 16)
      : Number(value);
    if(!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("payload external block is invalid");
    return parsed;
  }

  function verifySnapshotSemantics(input){
    const envelope = input.envelope || {};
    const payload = input.payload || {};
    const evidence = input.evidenceManifest || {};
    const sourceRefs = input.sourceRefs;
    const observedMs = canonicalUtcSecond(envelope.observed_at);
    requireEqual("snapshot id", envelope.snapshot_id, `vitals.${envelope.observed_at}`);
    requireEqual("evidence observed_at", evidence.observed_at, envelope.observed_at);
    if(!Array.isArray(sourceRefs) || sourceRefs.length < 1) throw new Error("source refs are missing");
    if(!Array.isArray(evidence.entries) || evidence.entries.length !== sourceRefs.length) throw new Error("evidence/source ref cardinality mismatch");
    const ids = new Set();
    for(const [index, ref] of sourceRefs.entries()){
      if(!ref || typeof ref !== "object" || typeof ref.id !== "string" || !ref.id || ids.has(ref.id)) throw new Error(`source ref ${index} id is invalid`);
      if(!/^sha256:[0-9a-f]{64}$/.test(ref.hash || "")) throw new Error(`source ref ${index} hash is invalid`);
      const entry = evidence.entries[index];
      requireEqual(`source ref ${index} id`, ref.id, entry?.id);
      requireEqual(`source ref ${index} kind`, ref.kind, entry?.kind);
      requireEqual(`source ref ${index} method`, ref.method, entry?.method);
      requireEqual(`source ref ${index} url`, ref.url, entry?.url);
      requireEqual(`source ref ${index} response hash`, ref.hash, entry?.response_hash);
      ids.add(ref.id);
    }
    if(!Number.isSafeInteger(Number(payload.octra?.epoch)) || Number(payload.octra.epoch) < 0) throw new Error("payload epoch is invalid");
    if(!Array.isArray(payload.routes) || payload.routes.length < 1) throw new Error("payload routes are missing");
    const nowMs = nonNegativeSafeInteger(input.nowMs === undefined ? Date.now() : input.nowMs, "verification clock");
    const maxFutureSkewMs = nonNegativeSafeInteger(input.maxFutureSkewMs === undefined ? 300000 : input.maxFutureSkewMs, "future skew");
    const staleAfterMs = nonNegativeSafeInteger(input.staleAfterMs === undefined ? 1200000 : input.staleAfterMs, "stale threshold");
    if(observedMs > nowMs + maxFutureSkewMs) throw new Error("snapshot observation is in the future");

    if(input.summaryRow){
      const summary = parseSummaryRow(input.summaryRow);
      requireEqual("summary snapshot_index", summary.snapshot_index, Number(input.snapshotIndex));
      requireEqual("summary observed_at", summary.observed_at_unix, Math.floor(observedMs / 1000));
      requireEqual("summary octra_epoch", summary.octra_epoch, Number(payload.octra.epoch));
      requireEqual("summary external_block", summary.external_block, blockNumber(payload.ethereum?.block_number));
      requireEqual("summary issued", summary.issued_raw, safeUnsigned(payload.supply?.issued_oct_raw, "payload issued"));
      requireEqual("summary burned", summary.burned_raw, safeUnsigned(payload.supply?.confirmed_burned_oct_raw || payload.supply?.burned_oct_raw, "payload burned"));
      requireEqual("summary encrypted", summary.encrypted_raw, safeUnsigned(payload.supply?.encrypted_oct_raw, "payload encrypted"));
      requireEqual("summary locked", summary.total_locked_raw, safeUnsigned(payload.bridge?.total_locked_oct_raw, "payload locked"));
      requireEqual("summary wrapped", summary.total_wrapped_raw, safeUnsigned(payload.bridge?.woct_supply_raw, "payload wrapped"));
      requireEqual("summary unclaimed", summary.total_unclaimed_raw, safeUnsigned(payload.bridge?.unclaimed_oct_raw, "payload unclaimed"));
      requireEqual("summary route_count", summary.route_count, payload.routes.length);
      requireEqual("summary payload hash prefix", summary.payload_hash_prefix, String(envelope.payload_hash).replace(/^sha256:/, "").slice(0, 24));
    }
    return {
      observed_at_ms: observedMs,
      age_ms: nowMs - observedMs,
      fresh: nowMs - observedMs <= staleAfterMs
    };
  }

  root.OctraVitalsVerifier = Object.freeze({ canonicalJson, canonicalUtcSecond, parseSummaryRow, verifySnapshotSemantics });
})(globalThis);
