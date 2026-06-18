#!/usr/bin/env bash
set -euo pipefail

GATEWAY_URL="${DEPLOY_GATEWAY_URL:-${VITALS_GATEWAY_ORIGIN:-https://octra.live}}"
CANDIDATE_RELEASE="${DEPLOY_CANDIDATE_RELEASE:-build/mainnet-candidate-site-circle-release.json}"
PLAN_OUT="${DEPLOY_RELEASE_PLAN_OUT:-build/mainnet-release-plan.json}"
LIVE_ENV="$(mktemp)"

cleanup() {
  rm -f "${LIVE_ENV}"
}
trap cleanup EXIT

npm run build >/dev/null

node - <<'NODE' "${GATEWAY_URL}" "${LIVE_ENV}"
const fs = require("fs");
const [gatewayUrlRaw, outPath] = process.argv.slice(2);
const gatewayUrl = String(gatewayUrlRaw || "https://octra.live").replace(/\/+$/, "");

function quote(value) {
  return `'${String(value ?? "").replace(/'/g, `'\\''`)}'`;
}

(async () => {
  const response = await fetch(`${gatewayUrl}/api/version`, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`/api/version returned ${response.status}`);
  }
  const version = await response.json();
  const lines = [
    ["VITALS_GATEWAY_ORIGIN", gatewayUrl],
    ["VITALS_SITE_CIRCLE_ID", version.site_circle_id],
    ["VITALS_STATE_TARGET_MODE", version.state_target_mode],
    ["VITALS_PROGRAMMED_CIRCLE_ID", version.programmed_circle_id],
    ["VITALS_STATE_PROGRAM_ADDRESS", version.state_program_address],
    ["VITALS_RELEASE_GIT_COMMIT", require("child_process").execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()],
    ["VITALS_RELEASE_GIT_DIRTY", require("child_process").execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() ? "1" : "0"]
  ]
    .filter(([, value]) => value !== undefined && value !== null && value !== "pending")
    .map(([name, value]) => `export ${name}=${quote(value)}`);
  fs.writeFileSync(outPath, `${lines.join("\n")}\n`);
})().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
NODE

set -a
. "${LIVE_ENV}"
set +a

node dist/scripts/build-producer-audit-manifest.js >/dev/null
node dist/scripts/build-site-circle-release.js "${CANDIDATE_RELEASE}" >/dev/null
node dist/scripts/plan-production-release.js \
  --gateway-url "${GATEWAY_URL}" \
  --release "${CANDIDATE_RELEASE}" \
  --out "${PLAN_OUT}"
