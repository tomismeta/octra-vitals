import assert from "node:assert/strict";
import test from "node:test";
import type http from "node:http";

import { hostAllowed, trustedClientKey } from "../lib/gateway-policy.js";

function req(headers: Record<string, string>, remoteAddress = "10.0.0.5"): http.IncomingMessage {
  return {
    headers,
    socket: { remoteAddress }
  } as unknown as http.IncomingMessage;
}

test("host policy requires parseable Host when allowlist is active", () => {
  assert.equal(hostAllowed(undefined, { allowedHosts: ["octra.live"], servicePort: 8000 }), false);
  assert.equal(hostAllowed("octra.live", { allowedHosts: ["octra.live"], servicePort: 8000 }), true);
  assert.equal(hostAllowed("octra.live:8000", { allowedHosts: ["octra.live"], servicePort: 8000 }), true);
  assert.equal(hostAllowed("octra.live:9999", { allowedHosts: ["octra.live"], servicePort: 8000 }), false);
  assert.equal(hostAllowed("localhost:9999", { allowedHosts: ["octra.live"], servicePort: 8000 }), true);
});

test("host policy allows explicit host-port allowlist entries", () => {
  assert.equal(hostAllowed("octra.live:9443", { allowedHosts: ["octra.live:9443"], servicePort: 8000 }), true);
  assert.equal(hostAllowed("octra.live:9444", { allowedHosts: ["octra.live:9443"], servicePort: 8000 }), false);
});

test("lab client key ignores spoofed proxy headers unless trusted", () => {
  const incoming = req({ "x-forwarded-for": "198.51.100.10" }, "10.0.0.5");

  assert.equal(trustedClientKey(incoming, false), "10.0.0.5");
  assert.equal(trustedClientKey(incoming, true), "198.51.100.10");
});
