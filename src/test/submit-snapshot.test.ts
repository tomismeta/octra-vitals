import test from "node:test";
import assert from "node:assert/strict";
import {
  assertOperatorSubmitStagingHealthClean,
  operatorSubmitStagingHealthFromBalance
} from "../scripts/submit-snapshot.js";

test("snapshot submit staging guard accepts a clean operator nonce", () => {
  const health = operatorSubmitStagingHealthFromBalance("octOperator", {
    nonce: 102,
    pending_nonce: 102
  });

  assert.equal(health.pending, false);
  assert.equal(health.reason, null);
  assert.equal(health.nonce, 102);
  assert.equal(health.pending_nonce, 102);
  assert.doesNotThrow(() => assertOperatorSubmitStagingHealthClean(health));
});

test("snapshot submit staging guard rejects a dirty operator nonce before signing", () => {
  const health = operatorSubmitStagingHealthFromBalance("octOperator", {
    nonce: 102,
    pending_nonce: 103
  });

  assert.equal(health.pending, true);
  assert.equal(health.reason, "operator_staging_pending");
  assert.throws(
    () => assertOperatorSubmitStagingHealthClean(health),
    /operator_staging_pending: octOperator nonce=102 pending_nonce=103/
  );
});

test("snapshot submit staging guard fails closed when nonce readback is malformed", () => {
  const health = operatorSubmitStagingHealthFromBalance("octOperator", {
    nonce: "not-a-number",
    pending_nonce: 103
  });

  assert.equal(health.pending, true);
  assert.equal(health.reason, "operator_staging_unverified");
  assert.throws(
    () => assertOperatorSubmitStagingHealthClean(health),
    /operator_staging_unverified: octOperator nonce=unknown pending_nonce=unknown/
  );
});
