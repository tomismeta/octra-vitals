import assert from "node:assert/strict";
import test from "node:test";
import { assertObservationTimeSafe, observationTimeMs } from "../lib/observation-time.js";

test("observation timestamps require real whole-second UTC dates", () => {
  assert.equal(observationTimeMs("2026-07-10T12:34:56Z"), Date.UTC(2026, 6, 10, 12, 34, 56));
  assert.throws(() => observationTimeMs("2026-02-31T12:00:00Z"), /real UTC/);
  assert.throws(() => observationTimeMs("2026-07-10T12:34:56.123Z"), /whole-second/);
});

test("observation timestamps cannot move backward or too far into the future", () => {
  const now = Date.parse("2026-07-10T12:00:00Z");
  assert.doesNotThrow(() => assertObservationTimeSafe("2026-07-10T12:00:05Z", {
    nowMs: now,
    maxFutureSkewMs: 10_000,
    previousObservedAt: "2026-07-10T11:59:59Z"
  }));
  assert.throws(() => assertObservationTimeSafe("2026-07-10T12:00:11Z", { nowMs: now, maxFutureSkewMs: 10_000 }), /future/);
  assert.throws(() => assertObservationTimeSafe("2026-07-10T11:59:59Z", { nowMs: now, previousObservedAt: "2026-07-10T11:59:59Z" }), /strictly advance/);
});
