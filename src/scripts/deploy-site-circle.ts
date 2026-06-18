#!/usr/bin/env node
import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { feeTelemetry, octraRpc } from "../lib/octra-rpc.js";
import { loadWalletFromEnv, publicTransactionJson, signTransaction, transactionHash, type OctraTransaction } from "../lib/octra-transaction.js";
import { runtimeVitalsManifest, stableJson } from "../lib/vitals-manifest.js";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const root = resolve(new URL("../..", import.meta.url).pathname);
const appDir = join(root, "app");
const args = process.argv.slice(2);
const dryRunOnly = args.includes("--dry-run");
const outPath = args.find((arg) => arg !== "--dry-run") || join(root, "build", "site_circle_deploy.json");
const deployEnabled = !dryRunOnly && process.env.VITALS_DEPLOY_SITE_CIRCLE === "1";
const waitForConfirmations = process.env.VITALS_DEPLOY_WAIT !== "0";
const batchAssets = process.env.VITALS_SITE_ASSET_SUBMIT_BATCH === "1";
const sealedMagic = Buffer.from("OCRS1");

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8"
};

function u32be(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value, 0);
  return out;
}

function u64be(value: number): Buffer {
  const out = Buffer.alloc(8);
  const big = BigInt(value);
  out.writeUInt32BE(Number((big >> 32n) & 0xffffffffn), 0);
  out.writeUInt32BE(Number(big & 0xffffffffn), 4);
  return out;
}

function h256Raw(tag: string, parts: Uint8Array[]): Buffer {
  const framed: Uint8Array[] = [Buffer.from(tag), Buffer.from([0])];
  for (const part of parts) framed.push(u32be(part.length), part);
  return createHash("sha256").update(Buffer.concat(framed)).digest();
}

function h256Hex(tag: string, parts: Uint8Array[]): string {
  return h256Raw(tag, parts).toString("hex");
}

function base58Encode(bytes: Buffer): string {
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let encoded = "";
  while (value > 0n) {
    const digit = Number(value % 58n);
    value /= 58n;
    encoded = BASE58_ALPHABET[digit] + encoded;
  }
  for (const byte of bytes) {
    if (byte === 0) encoded = `1${encoded}`;
    else break;
  }
  return encoded;
}

function circleIdOfDeploy(deployer: string, nonce: number, payload: unknown): string {
  const payloadHash = h256Hex("octra:circle_deploy_payload:v1", [Buffer.from(JSON.stringify(payload))]);
  const seed = h256Raw("octra:circle_deploy_id:v1", [
    Buffer.from(deployer),
    u64be(nonce),
    Buffer.from(payloadHash)
  ]);
  const base58 = base58Encode(seed);
  const base58Part = base58.length >= 44
    ? base58.slice(0, 44)
    : base58.length === 0
      ? "1".repeat(44)
      : base58.repeat(Math.ceil((44 - base58.length) / base58.length)).slice(0, 44);
  return `oct${base58Part}`;
}

function circleAssetOuFromB64Length(length: number): string {
  const rawUpperBound = Math.ceil(length / 4) * 3;
  if (rawUpperBound <= 4096) return "5000";
  if (rawUpperBound <= 16384) return "10000";
  if (rawUpperBound <= 32768) return "20000";
  if (rawUpperBound <= 131072) return "40000";
  if (rawUpperBound <= 524288) return "80000";
  if (rawUpperBound <= 2097152) return "160000";
  if (rawUpperBound <= 8388608) return "320000";
  return "640000";
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function padTargetBytes(paddingClass: string): number {
  if (paddingClass === "4k") return 4096;
  if (paddingClass === "16k") return 16384;
  if (paddingClass === "32k") return 32768;
  if (paddingClass === "128k") return 131072;
  return 0;
}

function paddedFrame(plaintext: Buffer, paddingClass: string): Buffer {
  const bare = Buffer.concat([u32be(plaintext.length), plaintext]);
  const target = padTargetBytes(paddingClass);
  if (!target) return bare;
  const aligned = Math.ceil(bare.length / target) * target;
  if (aligned <= bare.length) return bare;
  return Buffer.concat([bare, randomBytes(aligned - bare.length)]);
}

function estimatedSealedAssetB64Length(plaintextLength: number, paddingClass: string): number {
  const target = padTargetBytes(paddingClass);
  const bareLength = 4 + plaintextLength;
  const frameLength = target ? Math.ceil(bareLength / target) * target : bareLength;
  const envelopeLength = sealedMagic.length + 12 + frameLength + 16;
  return Math.ceil(envelopeLength / 3) * 4;
}

function deriveSealedReadKey(circleId: string, keyId: string, passphrase: string): Buffer {
  const salt = Buffer.from(`octra:circle:sealed_read:v1:${circleId}:${keyId}`);
  return pbkdf2Sync(Buffer.from(passphrase), salt, 120000, 32, "sha256");
}

function encryptSealedAsset(circleId: string, keyId: string, passphrase: string, plaintext: Buffer, paddingClass: string) {
  const key = deriveSealedReadKey(circleId, keyId, passphrase);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(paddedFrame(plaintext, paddingClass)), cipher.final(), cipher.getAuthTag()]);
  const envelope = Buffer.concat([sealedMagic, nonce, ciphertext]);
  return {
    ciphertext_b64: envelope.toString("base64"),
    plaintext_hash: sha256Hex(plaintext),
    ciphertext_sha256: `sha256:${sha256Hex(envelope)}`
  };
}

async function nextNonce(address: string): Promise<number> {
  const balance = await octraRpc<any>("octra_balance", [address]);
  const nonce = Number(balance?.pending_nonce ?? balance?.nonce ?? 0);
  if (!Number.isInteger(nonce) || nonce < 0) throw new Error(`invalid nonce response for ${address}`);
  return nonce + 1;
}

async function submitCall(wallet: NonNullable<ReturnType<typeof loadWalletFromEnv>>, tx: OctraTransaction) {
  const { txJson, txHash } = signedSubmission(wallet, tx);
  const submitResult = await octraRpc<any>("octra_submit", [txJson]);
  return {
    tx_hash: submitResult?.tx_hash || submitResult?.hash || txHash,
    submit_result: submitResult
  };
}

function signedSubmission(wallet: NonNullable<ReturnType<typeof loadWalletFromEnv>>, tx: OctraTransaction) {
  const signed = signTransaction(tx, wallet);
  const txJson = publicTransactionJson(signed);
  return {
    txJson,
    txHash: transactionHash(signed)
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function txStatus(tx: any): string {
  return String(tx?.status || tx?.transaction?.status || "");
}

function txError(tx: any): unknown {
  return tx?.error || tx?.receipt?.error || tx?.reject_reason || tx?.reject_type || null;
}

function txSummary(tx: any): Record<string, unknown> | null {
  if (!tx || typeof tx !== "object") return null;
  const summary: Record<string, unknown> = {};
  for (const key of ["hash", "status", "op_type", "from", "to_", "nonce", "epoch", "amount_raw", "ou", "reject_type", "reject_reason"]) {
    if (key in tx) summary[key] = tx[key];
  }
  const error = txError(tx);
  if (error) summary.error = error;
  return summary;
}

async function pollTx(hash: string, attempts = 45): Promise<any> {
  let latest: any = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(2000);
    try {
      latest = await octraRpc<any>("octra_transaction", [hash]);
      const status = txStatus(latest);
      if (status === "confirmed" || status === "rejected") return latest;
    } catch {
      // The tx may not be queryable immediately after submission.
    }
  }
  return latest || await octraRpc<any>("octra_transaction", [hash]);
}

async function requireConfirmed(hash: string, label: string): Promise<any> {
  if (!waitForConfirmations) return null;
  const tx = await pollTx(hash);
  if (txStatus(tx) !== "confirmed") {
    throw new Error(`${label} did not confirm: ${JSON.stringify(txSummary(tx) || tx)}`);
  }
  return tx;
}

async function writeReport(report: unknown): Promise<void> {
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, stableJson(report));
  console.log(stableJson({
    schema: (report as any).schema,
    status: (report as any).status,
    deploy_enabled: (report as any).deploy_enabled,
    circle_id: (report as any).circle_id,
    entry_uri: (report as any).entry_uri,
    deploy_tx_hash: (report as any).deploy_tx_hash,
    asset_tx_hashes: (report as any).asset_tx_hashes,
    assets: (report as any).assets?.length,
    report_path: outPath
  }));
}

const [circleConfig, siteManifest, vitalsManifest] = await Promise.all([
  readFile(join(root, "circle.json"), "utf8").then((text) => JSON.parse(text)),
  readFile(join(appDir, "manifest.json"), "utf8").then((text) => JSON.parse(text)),
  readFile(join(appDir, "vitals.manifest.json"), "utf8").then((text) => JSON.parse(text)).catch(() => ({}))
]);

const wallet = loadWalletFromEnv({
  privateKeyEnv: ["VITALS_DEPLOYER_PRIVATE_KEY_B64", "VITALS_OPERATOR_PRIVATE_KEY_B64", "OCTRA_PRIVATE_KEY_B64"],
  addressEnv: ["VITALS_DEPLOYER_ADDRESS", "VITALS_OPERATOR_ADDRESS"],
  label: "site circle deployer"
});
const deployerAddress = wallet?.address || process.env.VITALS_DEPLOYER_ADDRESS || process.env.VITALS_OPERATOR_ADDRESS || null;
const configuredCircleId = [process.env.VITALS_SITE_CIRCLE_ID, vitalsManifest.site_circle_id]
  .find((value) => typeof value === "string" && value.length > 0 && value !== "pending") || null;
const assetMode = String(circleConfig.assets?.mode || siteManifest.mode || "plain");
const sealedAssets = assetMode === "sealed" || payloadMode(siteManifest.mode) === "sealed_read";
const sealedKeyId = String(circleConfig.assets?.key_id || "octra-vitals-site");
const sealedPaddingClass = String(circleConfig.assets?.padding_class || "4k");
const sealedMetadataMode = String(circleConfig.assets?.metadata_mode || "reveal");
const sealedPassphrase = process.env.VITALS_SITE_CIRCLE_PASSPHRASE || "";
const assetOuOverride = process.env.VITALS_SITE_ASSET_OU || circleConfig.assets?.ou || null;
const missing = [
  deployerAddress ? null : "VITALS_DEPLOYER_ADDRESS or VITALS_OPERATOR_ADDRESS",
  deployEnabled && !wallet ? "VITALS_DEPLOYER_PRIVATE_KEY_B64 or VITALS_OPERATOR_PRIVATE_KEY_B64" : null,
  deployEnabled && sealedAssets && !sealedPassphrase ? "VITALS_SITE_CIRCLE_PASSPHRASE" : null
].filter((value): value is string => Boolean(value));

const deploy = circleConfig.deploy || {};
const limits = deploy.limits || {};
const circleIdPayload = {
  runtime: circleConfig.runtime || "octb",
  privacy_class: deploy.privacy_class || "public",
  browser_mode: deploy.browser_mode || "gateway_allowed",
  resource_mode: deploy.resource_mode || "public_resources",
  code_b64: typeof deploy.code_b64 === "string" ? deploy.code_b64 : null,
  policy_hash: typeof deploy.policy_hash === "string" ? deploy.policy_hash : null,
  members_root: typeof deploy.members_root === "string" ? deploy.members_root : null,
  export_policy: typeof deploy.export_policy === "string" ? deploy.export_policy : null,
  limits: {
    max_stable_bytes: String(limits.max_stable_bytes || "33554432"),
    max_assets_bytes: String(limits.max_assets_bytes || "33554432"),
    max_inline_value: String(limits.max_inline_value || "65536"),
    max_wasm_bytes: String(limits.max_wasm_bytes || "33554432")
  }
};
const deployPayload = {
  runtime: circleIdPayload.runtime,
  privacy_class: circleIdPayload.privacy_class,
  browser_mode: circleIdPayload.browser_mode,
  resource_mode: circleIdPayload.resource_mode,
  limits: circleIdPayload.limits,
  ...(circleIdPayload.code_b64 ? { code_b64: circleIdPayload.code_b64 } : {}),
  ...(circleIdPayload.policy_hash ? { policy_hash: circleIdPayload.policy_hash } : {}),
  ...(circleIdPayload.members_root ? { members_root: circleIdPayload.members_root } : {}),
  ...(circleIdPayload.export_policy ? { export_policy: circleIdPayload.export_policy } : {})
};

let nonce = deployerAddress ? await nextNonce(deployerAddress) : 0;
const deployNeeded = !configuredCircleId;
const circleId = configuredCircleId || (deployerAddress ? circleIdOfDeploy(deployerAddress, nonce, circleIdPayload) : "pending");
const assets = await Promise.all((siteManifest.assets || []).map(async (assetPath: string) => {
  const filePath = join(appDir, assetPath.replace(/^\//, ""));
  const bytes = assetPath === "/vitals.manifest.json"
    ? Buffer.from(stableJson(runtimeVitalsManifest(vitalsManifest, {
      siteCircleId: circleId,
      programmedCircleId: process.env.VITALS_PROGRAMMED_CIRCLE_ID || vitalsManifest.programmed_circle_id
    })))
    : await readFile(filePath);
  const fileInfo = await stat(filePath);
  const bodyB64 = bytes.toString("base64");
  const sealed = sealedAssets && circleId !== "pending" && sealedPassphrase
    ? encryptSealedAsset(circleId, sealedKeyId, sealedPassphrase, bytes, sealedPaddingClass)
    : null;
  const wireB64Length = sealed?.ciphertext_b64.length ||
    (sealedAssets ? estimatedSealedAssetB64Length(bytes.length, sealedPaddingClass) : bodyB64.length);
  return {
    path: assetPath,
    file: `app${assetPath}`,
    content_type: contentTypes[extname(assetPath)] || "application/octet-stream",
    bytes: assetPath === "/vitals.manifest.json" ? bytes.length : fileInfo.size,
    sha256: `sha256:${sha256Hex(bytes)}`,
    body_b64: bodyB64,
    sealed,
    ou: assetOuOverride ? String(assetOuOverride) : circleAssetOuFromB64Length(wireB64Length)
  };
}));
const [deployFee, assetFee, encryptedAssetFee] = await Promise.all([
  feeTelemetry("deploy_circle"),
  feeTelemetry("circle_asset_put"),
  feeTelemetry("circle_asset_put_encrypted")
]);
const nativeWriteTelemetry = {
  deploy_circle: deployFee,
  circle_asset_put: assetFee,
  circle_asset_put_encrypted: encryptedAssetFee
};

if (!deployEnabled) {
  await writeReport({
    schema: "octra-vitals-site-circle-deploy-report-v0",
    status: "dry_run",
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    deploy_enabled: false,
    deployer_address: deployerAddress || "pending",
    circle_id: circleId,
    entry_uri: circleId === "pending" ? "pending" : `oct://${circleId}${siteManifest.entry || "/index.html"}`,
    deploy_action: deployNeeded ? "create" : "update_existing",
    asset_submission_mode: batchAssets ? "batch" : "single",
    circle_id_payload: circleIdPayload,
    deploy_payload: deployPayload,
    fee_telemetry: nativeWriteTelemetry,
    asset_mode: sealedAssets ? "sealed" : "plain",
    sealed_asset_profile: sealedAssets ? {
      key_id: sealedKeyId,
      padding_class: sealedPaddingClass,
      metadata_mode: sealedMetadataMode
    } : null,
    next_nonce: nonce || null,
    missing_requirements: missing,
    assets: assets.map(({ body_b64, sealed, ...asset }) => ({
      ...asset,
      plaintext_hash: sealed?.plaintext_hash ? `sha256:${sealed.plaintext_hash}` : asset.sha256,
      ciphertext_sha256: sealed?.ciphertext_sha256 || null
    })),
    next_step: "set VITALS_DEPLOY_SITE_CIRCLE=1 with deployer wallet env to deploy the Site Circle and upload assets"
  });
} else {
  if (!wallet) throw new Error("site circle deployer wallet is required when VITALS_DEPLOY_SITE_CIRCLE=1");
  if (missing.length) throw new Error(`missing requirements: ${missing.join(", ")}`);
  let deploySubmission: Awaited<ReturnType<typeof submitCall>> | null = null;
  let deployConfirmation: any = null;
  if (deployNeeded) {
    const deployTx: OctraTransaction = {
      from: wallet.address,
      to_: circleId,
      amount: "0",
      nonce,
      ou: String(deploy.ou || "200000"),
      timestamp: Date.now() / 1000,
      op_type: "deploy_circle",
      message: JSON.stringify(deployPayload)
    };
    deploySubmission = await submitCall(wallet, deployTx);
    deployConfirmation = await requireConfirmed(deploySubmission.tx_hash, "Site Circle deploy");
    nonce += 1;
  }

  const assetTxs = assets.map((asset) => {
    const encryptedAsset = sealedAssets && asset.sealed;
    if (sealedAssets && !encryptedAsset) throw new Error(`sealed asset package missing for ${asset.path}`);
    const tx: OctraTransaction = {
      from: wallet.address,
      to_: circleId,
      amount: "0",
      nonce,
      ou: asset.ou,
      timestamp: Date.now() / 1000,
      op_type: encryptedAsset ? "circle_asset_put_encrypted" : "circle_asset_put",
      encrypted_data: encryptedAsset ? encryptedAsset.ciphertext_b64 : asset.body_b64,
      message: JSON.stringify(encryptedAsset ? {
        path: asset.path,
        content_type: asset.content_type,
        encoding: "identity",
        key_id: sealedKeyId,
        plaintext_hash: encryptedAsset.plaintext_hash,
        padding_class: sealedPaddingClass,
        metadata_mode: sealedMetadataMode
      } : {
        path: asset.path,
        content_type: asset.content_type,
        encoding: "identity"
      })
    };
    const signed = signedSubmission(wallet, tx);
    const prepared = {
      path: asset.path,
      nonce,
      ou: asset.ou,
      op_type: tx.op_type,
      tx_hash: signed.txHash,
      tx_json: signed.txJson
    };
    nonce += 1;
    return prepared;
  });

  const assetSubmissions = [];
  if (batchAssets && assetTxs.length > 0) {
    const batchSubmitResult = await octraRpc<any>("octra_submitBatch", [assetTxs.map((asset) => asset.tx_json)]);
    const results = Array.isArray(batchSubmitResult?.results) ? batchSubmitResult.results : [];
    for (const [index, asset] of assetTxs.entries()) {
      const confirmation = await requireConfirmed(asset.tx_hash, `asset upload ${asset.path}`);
      assetSubmissions.push({
        path: asset.path,
        nonce: asset.nonce,
        ou: asset.ou,
        op_type: asset.op_type,
        tx_hash: asset.tx_hash,
        submit_result: results[index] || batchSubmitResult,
        batch_result_index: index,
        tx: txSummary(confirmation)
      });
    }
  } else {
    for (const asset of assetTxs) {
      const submitResult = await octraRpc<any>("octra_submit", [asset.tx_json]);
      const txHash = submitResult?.tx_hash || submitResult?.hash || asset.tx_hash;
      const confirmation = await requireConfirmed(txHash, `asset upload ${asset.path}`);
      assetSubmissions.push({
        path: asset.path,
        nonce: asset.nonce,
        ou: asset.ou,
        op_type: asset.op_type,
        tx_hash: txHash,
        submit_result: submitResult,
        tx: txSummary(confirmation)
      });
    }
  }

  await writeReport({
    schema: "octra-vitals-site-circle-deploy-report-v0",
    status: "submitted",
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    deploy_enabled: true,
    deployer_address: wallet.address,
    circle_id: circleId,
    entry_uri: `oct://${circleId}${siteManifest.entry || "/index.html"}`,
    deploy_action: deployNeeded ? "create" : "update_existing",
    asset_submission_mode: batchAssets ? "batch" : "single",
    circle_id_payload: circleIdPayload,
    deploy_payload: deployPayload,
    fee_telemetry: nativeWriteTelemetry,
    asset_mode: sealedAssets ? "sealed" : "plain",
    sealed_asset_profile: sealedAssets ? {
      key_id: sealedKeyId,
      padding_class: sealedPaddingClass,
      metadata_mode: sealedMetadataMode
    } : null,
    deploy_tx_hash: deploySubmission?.tx_hash || null,
    deploy_submit_result: deploySubmission?.submit_result || null,
    deploy_tx: txSummary(deployConfirmation),
    asset_tx_hashes: assetSubmissions.map((submission) => submission.tx_hash),
    asset_submissions: assetSubmissions,
    assets: assets.map(({ body_b64, sealed, ...asset }) => ({
      ...asset,
      plaintext_hash: sealed?.plaintext_hash ? `sha256:${sealed.plaintext_hash}` : asset.sha256,
      ciphertext_sha256: sealed?.ciphertext_sha256 || null
    })),
    next_step: "after confirmations, set VITALS_SITE_CIRCLE_ID to circle_id and verify circle_info plus entry asset reads"
  });
}

function payloadMode(mode: unknown): string {
  return typeof mode === "string" ? mode : "";
}
