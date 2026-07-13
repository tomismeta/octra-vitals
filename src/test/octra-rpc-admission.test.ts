import assert from "node:assert/strict";
import test from "node:test";
import {
  isExplicitDevelopmentRpcUrl,
  parseRpcIntegerSetting,
  rpcUrlLabel,
  RpcAdmissionController,
  readResponseTextWithLimit
} from "../lib/octra-rpc.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("RPC admission transfers permits without exceeding concurrency", async () => {
  const admission = new RpcAdmissionController(2, 0, 20, 1_000);
  let active = 0;
  let maximum = 0;
  await Promise.all(Array.from({ length: 12 }, () => admission.run(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  })));
  assert.equal(maximum, 2);
  assert.equal(admission.snapshot().max_concurrent_observed, 2);
  assert.equal(admission.snapshot().active, 0);
});

test("RPC admission rejects a full queue and times out bounded waits", async () => {
  const admission = new RpcAdmissionController(1, 0, 1, 25);
  const hold = deferred();
  const first = admission.run(() => hold.promise);
  await new Promise((resolve) => setImmediate(resolve));
  const queued = admission.run(async () => undefined);
  await assert.rejects(admission.run(async () => undefined), /queue is full/);
  await assert.rejects(queued, /Timed out waiting/);
  hold.resolve();
  await first;
  assert.equal(admission.snapshot().rejected, 1);
  assert.equal(admission.snapshot().timed_out, 1);
});

test("RPC response reader enforces declared and streamed byte limits", async () => {
  await assert.rejects(
    readResponseTextWithLimit(new Response("abcdef", { headers: { "content-length": "6" } }), 5),
    /exceeds 5 bytes/
  );
  assert.equal(await readResponseTextWithLimit(new Response("abc"), 3), "abc");
});

test("development RPC intent is derived from the URL host only", () => {
  assert.equal(isExplicitDevelopmentRpcUrl("https://devnet.octrascan.io/rpc"), true);
  assert.equal(isExplicitDevelopmentRpcUrl("http://127.0.0.1:8080/rpc"), true);
  assert.equal(isExplicitDevelopmentRpcUrl("http://[::1]:8080/rpc"), true);
  assert.equal(isExplicitDevelopmentRpcUrl("https://octra.network/rpc?network=devnet"), false);
  assert.equal(isExplicitDevelopmentRpcUrl("https://octra.network/devnet/rpc"), false);
  assert.equal(isExplicitDevelopmentRpcUrl("https://localhost.example/rpc"), false);
});

test("RPC labels do not disclose credentials, paths, or query tokens", () => {
  assert.equal(rpcUrlLabel("https://user:secret@rpc.example/v1/project-key?token=hidden"), "https://rpc.example");
  assert.equal(rpcUrlLabel("not a url"), "configured-rpc");
});

test("RPC resource settings reject malformed and excessive values", () => {
  assert.equal(parseRpcIntegerSetting(undefined, 6, "TEST", 1, 10), 6);
  assert.equal(parseRpcIntegerSetting("0", 6, "TEST", 0, 10), 0);
  assert.throws(() => parseRpcIntegerSetting("NaN", 6, "TEST", 1, 10), /integer from 1 to 10/);
  assert.throws(() => parseRpcIntegerSetting("11", 6, "TEST", 1, 10), /integer from 1 to 10/);
});
