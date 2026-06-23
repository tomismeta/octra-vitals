#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { sha256Hex } from "../lib/canonical-json.js";

const root = resolve(new URL("../..", import.meta.url).pathname);
const outPath = process.argv[2] || join(root, "app", "producer.audit.json");

const auditedFiles = [
  "README.md",
  "package.json",
  "tsconfig.json",
  "circle.json",
  "src/scripts/run-snapshot-update.ts",
  "src/scripts/build-snapshot.ts",
  "src/scripts/build-record-snapshot-call.ts",
  "src/scripts/submit-snapshot.ts",
  "src/scripts/watch-updater.ts",
  "src/scripts/summarize-traffic.ts",
  "src/scripts/summarize-snapshot-runs.ts",
  "src/scripts/build-site-circle-release.ts",
  "src/scripts/deploy-site-circle.ts",
  "src/scripts/plan-production-release.ts",
  "src/scripts/compile-programmed-circle.ts",
  "src/scripts/verify-programmed-circle-artifacts.ts",
  "src/scripts/deploy-programmed-circle.ts",
  "src/lib/snapshot.ts",
  "src/lib/program-state.ts",
  "src/lib/circle-program.ts",
  "src/lib/vitals-manifest.ts",
  "src/lib/traffic.ts",
  "src/lib/summary-window.ts",
  "src/lib/octra-rpc.ts",
  "src/lib/octra-transaction.ts",
  "src/lib/canonical-json.ts",
  "src/lib/units.ts",
  "src/lib/types.ts",
  "src/gateway/node-gateway/server.ts",
  "program/main.aml",
  "program/storage.md",
  "program-circle/main.aml",
  "program-circle/abi.json",
  "program-circle/formal_certificate.json",
  "program-circle/formal_verification.json",
  "program-circle/lowered.oasm",
  "program-v1/main.aml",
  "program-v1/abi.json",
  "program-v1/formal_certificate.json",
  "program-v1/formal_verification.json",
  "program-v1/lowered.oasm",
  "src/lib/aml-history-v1.ts",
  "src/scripts/deploy-program-v1-devnet.ts",
  "src/scripts/rehearse-program-v1-boundary-devnet.ts",
  "src/scripts/rehearse-program-v1-overflow-devnet.ts",
  "deploy/mainnet/bootstrap-host.sh",
  "deploy/mainnet/push-release.sh",
  "deploy/mainnet/plan-release.sh",
  "deploy/mainnet/deploy-programmed-circle.sh",
  "deploy/mainnet/configure-programmed-circle.sh",
  "deploy/mainnet/publish-programmed-site-assets.sh",
  "deploy/mainnet/submit-one-snapshot.sh",
  "deploy/mainnet/verify-runtime.sh",
  "deploy/mainnet/enable-timers.sh",
  "deploy/mainnet/github-dispatch.sh",
  "deploy/systemd/octra-vitals-gateway.service",
  "deploy/systemd/octra-vitals-updater.service",
  "deploy/systemd/octra-vitals-updater.timer",
  "deploy/systemd/octra-vitals-watchdog.service",
  "deploy/systemd/octra-vitals-watchdog.timer",
  "docs/architecture.md",
  "docs/schema.md",
  "docs/ops.md",
  "docs/adr-0001-programmed-site-circle.md",
  "docs/mainnet-deployment.md"
];

const files = await Promise.all(auditedFiles.map(async (path) => {
  const content = await readFile(join(root, path), "utf8");
  return {
    path,
    bytes: Buffer.byteLength(content),
    sha256: `sha256:${sha256Hex(content)}`
  };
}));

const aggregateInput = files.map((file) => `${file.path}\0${file.sha256}\0${file.bytes}`).join("\n");
const manifest = {
  schema: "octra-vitals-producer-audit-v0",
  purpose: "Static Circle audit manifest for the off-chain producer, thin gateway, programmed Site Circle state, and deployment automation used to observe RPC sources and commit canonical Vitals snapshots.",
  determinism: "source-derived; no wall-clock fields",
  content_policy: "hashes_only",
  execution_model: {
    collector_runs_in_site_circle: false,
    collector_runs_on_octra_aml: false,
    reason: "The collector requires outbound Octra/Ethereum/relayer RPC reads and scheduled execution. The Vitals State Program verifies and stores canonical commitments; it does not perform outbound oracle work.",
    canonical_state: "Programmed Site Circle AML state, or standalone Vitals State Program for devnet dogfood",
    canonical_app: "Site Circle",
    producer_role: "auditable off-chain scheduler"
  },
  files,
  aggregate_sha256: `sha256:${sha256Hex(aggregateInput)}`
};

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({
  out: outPath,
  schema: manifest.schema,
  files: files.length,
  aggregate_sha256: manifest.aggregate_sha256
}, null, 2));
