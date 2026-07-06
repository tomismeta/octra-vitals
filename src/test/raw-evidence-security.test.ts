import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateEvidenceSourceUrl, writeSnapshotArtifacts } from "../lib/snapshot.js";

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
  assert.equal(
    validateEvidenceSourceUrl("https://ethereum.publicnode.com"),
    "https://ethereum.publicnode.com/"
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

test("snapshot artifact writer compresses raw evidence by default", async () => {
  const dir = await mkdtemp(join(tmpdir(), `octra-vitals-raw-evidence-${process.pid}-`));
  const evidenceDir = join(dir, "evidence");
  const evidenceHash = "a".repeat(64);
  const rawHash = "b".repeat(64);
  const snapshot: any = {
    envelope: {
      evidence_manifest_hash: `sha256:${evidenceHash}`
    },
    evidence_manifest: {
      schema_version: "test",
      entries: []
    },
    canonical_payload: "{}",
    canonical_evidence_manifest: "{}",
    generated_at: "2026-06-16T21:00:00Z",
    raw_evidence: [{
      id: "supply",
      response_hash: `sha256:${rawHash}`,
      body: "{\"ok\":true}",
      content_type: "application/json",
      observed_at: "2026-06-16T21:00:00Z"
    }]
  };

  try {
    await writeSnapshotArtifacts(snapshot, join(dir, "snapshot.json"), evidenceDir);
    await assert.rejects(() => stat(join(evidenceDir, "raw", `${rawHash}.json`)), /ENOENT/);
    const compressed = await readFile(join(evidenceDir, "raw", `${rawHash}.json.gz`));
    const parsed = JSON.parse(gunzipSync(compressed).toString("utf8"));
    assert.equal(parsed.id, "supply");
    assert.equal(parsed.body, "{\"ok\":true}");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
