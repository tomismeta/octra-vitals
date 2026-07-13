import assert from "node:assert/strict";
import test from "node:test";
import { buildLiveSnapshot } from "../lib/snapshot.js";

function rpc(id: string | number, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200, headers: { "content-type": "application/json" } });
}

test("live snapshot collection fences Octra and Ethereum source state", async () => {
  const originalFetch = globalThis.fetch;
  const status = {
    epoch: 100,
    state_root: "state-root-100",
    txid_hi: "123",
    network_version: "testnet",
    validator: "oct11111111111111111111111111111111111111111111",
    timestamp: 1783700000.504342
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/recovery.json")) {
      return new Response(JSON.stringify({ latest_scanned_epoch: 99, updated_at: 1783700000, by_recipient: { octRecipient: [{ amount_raw: "10" }] } }));
    }
    const body = JSON.parse(String(init?.body || "{}"));
    if (Array.isArray(body)) {
      return new Response(JSON.stringify([
        { jsonrpc: "2.0", id: "status", result: status },
        { jsonrpc: "2.0", id: "supply", result: { max_supply_raw: "100", total_supply_raw: "80", encrypted_supply_raw: "5", burned_raw: "20" } },
        { jsonrpc: "2.0", id: "vault", result: { balance_raw: "50" } },
        { jsonrpc: "2.0", id: "locked", result: { value: "50" } },
        { jsonrpc: "2.0", id: "unlocked", result: { value: "3" } },
        { jsonrpc: "2.0", id: "locks", result: { value: "7" } },
        { jsonrpc: "2.0", id: "unlocks", result: { value: "2" } }
      ]));
    }
    if (body.method === "node_status") return rpc(body.id, status);
    if (body.method === "bridgeStatus") {
      return rpc(body.id, {
        latest_finalized_epoch: 99,
        mode: "quorum",
        bridge_vault_addr: "oct5MrNfjiXFNRDLwsodn8Zm9hDKNGAYt3eQDCQ52bSpCHq",
        src_chain_id: 7777,
        dst_chain_id: 1
      });
    }
    if (body.method === "eth_getBlockByNumber") {
      return rpc(body.id, { number: "0x10", hash: `0x${"a".repeat(64)}` });
    }
    if (body.method === "eth_call") {
      return rpc(body.id, body.params?.[0]?.data === "0x313ce567" ? "0x6" : "0x28");
    }
    throw new Error(`unexpected test request ${url}: ${JSON.stringify(body)}`);
  }) as typeof fetch;

  try {
    const observedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const snapshot = await buildLiveSnapshot({ observedAt });
    assert.equal(snapshot.envelope.payload.octra.epoch, 100);
    assert.equal(snapshot.envelope.payload.octra.timestamp, "1783700000.504342");
    assert.equal(snapshot.envelope.payload.ethereum?.block_hash, `0x${"a".repeat(64)}`);
    assert.equal(snapshot.envelope.payload.bridge.woct_supply_raw, "40");
    assert.ok(snapshot.evidence_manifest.entries.some((entry) => entry.id === "octra.status_after"));
    assert.ok(snapshot.evidence_manifest.entries.some((entry) => entry.id === "ethereum.block_after"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
