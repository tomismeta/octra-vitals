import assert from "node:assert/strict";
import test from "node:test";

import { validateEvidenceSourceUrl } from "../lib/snapshot.js";

test("raw evidence source URLs allow known public hosts", () => {
  assert.equal(
    validateEvidenceSourceUrl("https://octra.network/rpc"),
    "https://octra.network/rpc"
  );
  assert.equal(
    validateEvidenceSourceUrl("https://relayer-002838819188.octra.network"),
    "https://relayer-002838819188.octra.network/"
  );
  assert.equal(
    validateEvidenceSourceUrl("https://ethereum-rpc.publicnode.com"),
    "https://ethereum-rpc.publicnode.com/"
  );
});

test("raw evidence source URLs reject accidental secret-bearing URLs", () => {
  assert.throws(
    () => validateEvidenceSourceUrl("https://user:pass@octra.network/rpc"),
    /must not contain credentials/
  );
  assert.throws(
    () => validateEvidenceSourceUrl("https://octra.network/rpc?api_key=secret"),
    /must not contain query strings/
  );
  assert.throws(
    () => validateEvidenceSourceUrl("https://octra.network/rpc#fragment"),
    /must not contain query strings/
  );
});

test("raw evidence source URLs reject non-public hosts by default", () => {
  assert.throws(
    () => validateEvidenceSourceUrl("http://127.0.0.1:8545"),
    /local evidence source URLs are disabled/
  );
  assert.throws(
    () => validateEvidenceSourceUrl("https://localhost:8545"),
    /local evidence source URLs are disabled/
  );
  assert.throws(
    () => validateEvidenceSourceUrl("https://metadata.google.internal/computeMetadata/v1"),
    /not allowlisted/
  );
});

test("raw evidence source URL validation does not echo secret-bearing URLs", () => {
  assert.throws(
    () => validateEvidenceSourceUrl("https://user:pass@octra.network/rpc?api_key=secret"),
    (error) => error instanceof Error &&
      /must not contain credentials/.test(error.message) &&
      !error.message.includes("secret") &&
      !error.message.includes("user:pass")
  );
});

test("raw evidence source URL allowlist is explicit", () => {
  const previous = process.env.VITALS_PUBLIC_EVIDENCE_HOSTS;
  try {
    process.env.VITALS_PUBLIC_EVIDENCE_HOSTS = "rpc.example.org";
    assert.equal(
      validateEvidenceSourceUrl("https://rpc.example.org"),
      "https://rpc.example.org/"
    );
  } finally {
    if (previous === undefined) delete process.env.VITALS_PUBLIC_EVIDENCE_HOSTS;
    else process.env.VITALS_PUBLIC_EVIDENCE_HOSTS = previous;
  }
});
