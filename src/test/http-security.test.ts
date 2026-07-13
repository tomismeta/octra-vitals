import assert from "node:assert/strict";
import test from "node:test";
import { browserPostOriginAllowed, jsonContentType } from "../lib/http-security.js";

test("Lab POST content type accepts JSON only", () => {
  assert.equal(jsonContentType("application/json"), true);
  assert.equal(jsonContentType("application/json; charset=utf-8"), true);
  assert.equal(jsonContentType("text/plain"), false);
  assert.equal(jsonContentType(null), false);
});

test("Lab browser POST origin is exact when configured", () => {
  assert.equal(browserPostOriginAllowed({ origin: null, requestHost: "octra.live", allowedOrigins: ["https://octra.live"] }), true);
  assert.equal(browserPostOriginAllowed({ origin: "https://octra.live", requestHost: "octra.live", allowedOrigins: ["https://octra.live"] }), true);
  assert.equal(browserPostOriginAllowed({ origin: "http://octra.live", requestHost: "octra.live", allowedOrigins: ["https://octra.live"] }), false);
  assert.equal(browserPostOriginAllowed({ origin: "https://attacker.example", requestHost: "octra.live", allowedOrigins: ["https://octra.live"] }), false);
  assert.equal(browserPostOriginAllowed({ origin: "https://octra.live", requestHost: "octra.live", allowedOrigins: [], requireConfiguredOrigins: true }), false);
});
