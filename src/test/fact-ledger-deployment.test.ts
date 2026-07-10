import assert from "node:assert/strict";
import test from "node:test";
import { assertDistinctProductionRoles, parseFactLedgerLatestBundle } from "../lib/fact-ledger-deployment.js";

test("fact-ledger latest bundle parsing is strict", () => {
  const value = `12|vitals.2026-07-10T12:00:00Z|sha256:${"a".repeat(64)}|${"b".repeat(64)}|${"c".repeat(64)}|${"d".repeat(64)}`;
  const parsed = parseFactLedgerLatestBundle(value);
  assert.equal(parsed.snapshot_index, 12);
  assert.equal(parsed.history_root, "c".repeat(64));
  assert.throws(() => parseFactLedgerLatestBundle(value.replace(/^12\|/, "bad|")), /index/);
});

test("production owner/operator collapse requires an exact break-glass acknowledgement", () => {
  const old = process.env.VITALS_BREAK_GLASS_ROLE_COLLAPSE_ACK;
  delete process.env.VITALS_BREAK_GLASS_ROLE_COLLAPSE_ACK;
  try {
    assert.throws(() => assertDistinctProductionRoles("oct-owner", "oct-owner", true), /must be distinct/);
    process.env.VITALS_BREAK_GLASS_ROLE_COLLAPSE_ACK = "oct-owner:oct-owner";
    assert.doesNotThrow(() => assertDistinctProductionRoles("oct-owner", "oct-owner", true));
    assert.doesNotThrow(() => assertDistinctProductionRoles("oct-owner", "oct-operator", true));
  } finally {
    if (old === undefined) delete process.env.VITALS_BREAK_GLASS_ROLE_COLLAPSE_ACK;
    else process.env.VITALS_BREAK_GLASS_ROLE_COLLAPSE_ACK = old;
  }
});
