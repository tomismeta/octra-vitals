import assert from "node:assert/strict";
import test from "node:test";

import { conservationHealth, parseErc20Decimals } from "../lib/snapshot.js";

const base = {
  maxRaw: "1000000000000000",
  issuedRaw: "622000000000000",
  encryptedRaw: "12413100000000",
  burnedRaw: "378000000000000",
  lockedRaw: "190000000000000",
  wrappedRaw: "189500000000000",
  unclaimedRaw: "500000000000",
  vaultRaw: "190000100000000",
  expectedWoctDecimals: 6,
  actualWoctDecimals: 6,
  octraEpoch: 100,
  relayerFinalizedEpoch: 98,
  recoveryScannedEpoch: 97,
  ethereumBlock: "0x123"
};

test("conservation health is green when strict supply and bridge identities hold", () => {
  const health = conservationHealth(base).conservation;

  assert.equal(health.status, "green");
  assert.equal(health.ok, true);
  assert.deepEqual(health.flags, []);
  assert.equal(health.deltas.bridge_residual_raw, "0");
  assert.equal(health.largest_abs_delta_raw, "0");
  assert.equal(health.required_inputs?.burned_rpc, true);
  assert.equal(health.required_inputs?.woct_decimals_verified, true);
});

test("conservation health reports positive bridge residual without warning", () => {
  const health = conservationHealth({
    ...base,
    wrappedRaw: "189400000000000"
  }).conservation;

  assert.equal(health.status, "green");
  assert.equal(health.ok, true);
  assert.deepEqual(health.flags, []);
  assert.equal(health.deltas.bridge_residual_raw, "100000000000");
  assert.equal(health.largest_abs_delta_raw, "0");
});

test("conservation health is red on bridge overclaim", () => {
  const health = conservationHealth({
    ...base,
    wrappedRaw: "189500000000001"
  }).conservation;

  assert.equal(health.status, "red");
  assert.equal(health.flags.includes("bridge_claims_exceed_locked"), true);
  assert.equal(health.deltas.bridge_claim_overage_raw, "1");
});

test("conservation health is red on burned/cap mismatch", () => {
  const health = conservationHealth({
    ...base,
    burnedRaw: "377999999999999"
  }).conservation;

  assert.equal(health.status, "red");
  assert.equal(health.flags.includes("cap_remaining_differs_from_burned"), true);
  assert.equal(health.deltas.cap_burn_mismatch_raw, "1");
});

test("conservation health is red on wOCT decimals mismatch", () => {
  const health = conservationHealth({
    ...base,
    actualWoctDecimals: 18
  }).conservation;

  assert.equal(health.status, "red");
  assert.equal(health.flags.includes("woct_decimals_mismatch"), true);
  assert.equal(health.required_inputs?.woct_decimals_verified, false);
});

test("parseErc20Decimals decodes Ethereum uint responses", () => {
  assert.equal(parseErc20Decimals("0x0000000000000000000000000000000000000000000000000000000000000006"), 6);
  assert.equal(parseErc20Decimals("0x12"), 18);
  assert.throws(() => parseErc20Decimals("0x0100"), /out of range/);
  assert.throws(() => parseErc20Decimals("not-hex"), /invalid hex/);
});
