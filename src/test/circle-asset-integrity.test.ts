import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { circleResourceKeyOfPath, verifyCircleAssetIntegrity } from "../lib/circle-asset-integrity.js";

test("circleResourceKeyOfPath matches webcli framing", () => {
  assert.equal(
    circleResourceKeyOfPath("oct48TxRTECzSNuhu7uDJ4MRyFkD2W2usyZqf2EbpXwRUeg", "/app.js"),
    "1ddefb439b527896a27a4a0584eeecc3f57b2547778dfed42504a57cff40d80c"
  );
});

test("verifyCircleAssetIntegrity accepts matching resource key and blob hash", () => {
  const circleId = "oct48TxRTECzSNuhu7uDJ4MRyFkD2W2usyZqf2EbpXwRUeg";
  const path = "/index.html";
  const body = Buffer.from("<!doctype html>");
  const report = verifyCircleAssetIntegrity(circleId, path, body, {
    resource_key: circleResourceKeyOfPath(circleId, path),
    blob_hash: createHash("sha256").update(body).digest("hex")
  });

  assert.equal(report.checks_passed, true);
  assert.deepEqual(report.errors, []);
  assert.equal(report.resource_key_matches, true);
  assert.equal(report.blob_hash_matches_body_sha256, true);
});

test("verifyCircleAssetIntegrity reports mismatched Circle metadata", () => {
  const body = Buffer.from("payload");
  const report = verifyCircleAssetIntegrity("oct48TxRTECzSNuhu7uDJ4MRyFkD2W2usyZqf2EbpXwRUeg", "/app.js", body, {
    resource_key: "0".repeat(64),
    blob_hash: "1".repeat(64)
  });

  assert.equal(report.checks_passed, false);
  assert.deepEqual(report.errors, [
    "circle_asset_resource_key_mismatch",
    "circle_asset_blob_hash_mismatch"
  ]);
});
