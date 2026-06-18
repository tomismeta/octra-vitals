import { createHash } from "node:crypto";

const CIRCLE_RESOURCE_KEY_PATH_TAG = "octra:circle_resource_key:v1";

function u32be(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value, 0);
  return out;
}

function h256Hex(tag: string, parts: Buffer[]): string {
  const framed: Buffer[] = [Buffer.from(tag, "utf8"), Buffer.from([0])];
  for (const part of parts) framed.push(u32be(part.length), part);
  return createHash("sha256").update(Buffer.concat(framed)).digest("hex");
}

function normalizeHexHash(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase().replace(/^sha256:/, "");
  return /^[0-9a-f]{64}$/.test(text) ? text : null;
}

export interface CircleAssetIntegrityReport {
  expected_resource_key: string;
  resource_key: string | null;
  resource_key_matches: boolean;
  blob_hash: string | null;
  body_sha256: string;
  blob_hash_matches_body_sha256: boolean;
  checks_passed: boolean;
  errors: string[];
}

export function circleResourceKeyOfPath(circleId: string, canonicalPath: string): string {
  return h256Hex(CIRCLE_RESOURCE_KEY_PATH_TAG, [
    Buffer.from(circleId, "utf8"),
    Buffer.from(canonicalPath, "utf8")
  ]);
}

export function verifyCircleAssetIntegrity(
  circleId: string,
  canonicalPath: string,
  body: Buffer,
  circleAsset: Record<string, unknown>
): CircleAssetIntegrityReport {
  const expectedResourceKey = circleResourceKeyOfPath(circleId, canonicalPath);
  const resourceKey = typeof circleAsset.resource_key === "string" ? circleAsset.resource_key.trim().toLowerCase() : null;
  const blobHash = normalizeHexHash(circleAsset.blob_hash);
  const bodySha256 = createHash("sha256").update(body).digest("hex");
  const errors: string[] = [];

  if (!resourceKey) {
    errors.push("circle_asset_resource_key_missing");
  } else if (resourceKey !== expectedResourceKey) {
    errors.push("circle_asset_resource_key_mismatch");
  }

  if (!blobHash) {
    errors.push("circle_asset_blob_hash_missing");
  } else if (blobHash !== bodySha256) {
    errors.push("circle_asset_blob_hash_mismatch");
  }

  return {
    expected_resource_key: expectedResourceKey,
    resource_key: resourceKey,
    resource_key_matches: resourceKey === expectedResourceKey,
    blob_hash: blobHash,
    body_sha256: bodySha256,
    blob_hash_matches_body_sha256: blobHash === bodySha256,
    checks_passed: errors.length === 0,
    errors
  };
}
