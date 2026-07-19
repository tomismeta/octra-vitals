#!/usr/bin/env bash
set -euo pipefail

APP_OWNER_USER="${APP_OWNER_USER:-octra-vitals-owner}"
APP_USER="${APP_USER:-octra-vitals}"
APP_ROOT="${APP_ROOT:-/opt/octra-vitals}"
OWNER_DIR="${VITALS_OWNER_DATA_DIR:-/var/lib/octra-vitals-owner}"
ENV_DIR="${ENV_DIR:-/etc/octra-vitals}"
CURRENT="${APP_ROOT}/current"
UPDATER_TIMER="${UPDATER_TIMER:-octra-vitals-updater.timer}"
UPDATER_SERVICE="${UPDATER_SERVICE:-octra-vitals-updater.service}"
RESTORE_UPDATER_TIMER=0
SITE_DEPLOY_ENV=""

if [ "$(id -u)" -ne 0 ]; then
  echo "publish-programmed-site-assets.sh must run as root so updater.env can stay root-only" >&2
  exit 1
fi
if ! id "${APP_OWNER_USER}" >/dev/null 2>&1; then
  echo "missing cold-owner user: ${APP_OWNER_USER}; run bootstrap-host.sh first" >&2
  exit 1
fi

restore_updater_timer() {
  rm -f "${SITE_DEPLOY_ENV:-}"
  if [ "${RESTORE_UPDATER_TIMER}" = "1" ]; then
    systemctl start "${UPDATER_TIMER}" || true
  fi
}
trap restore_updater_timer EXIT

cd "${CURRENT}"
. deploy/lib/env-file.sh

load_env_file_data "${ENV_DIR}/gateway.env"

if [ -z "${VITALS_RELEASE_GIT_COMMIT:-}" ] && [ -r build/site-circle-release.json ]; then
  VITALS_RELEASE_GIT_COMMIT="$(node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync("build/site-circle-release.json","utf8")); process.stdout.write(r.release_git_commit || "")')"
  export VITALS_RELEASE_GIT_COMMIT
fi
if [ -z "${VITALS_RELEASE_GIT_DIRTY:-}" ] && [ -r build/site-circle-release.json ]; then
  VITALS_RELEASE_GIT_DIRTY="$(node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync("build/site-circle-release.json","utf8")); process.stdout.write(r.release_git_dirty ? "1" : "0")')"
  export VITALS_RELEASE_GIT_DIRTY
fi

npm run producer:audit:dist
node dist/scripts/build-site-circle-release.js

load_env_file_data "${ENV_DIR}/updater.env"
load_env_file_data "${ENV_DIR}/owner.env"
unset VITALS_OPERATOR_PRIVATE_KEY_B64 OCTRA_PRIVATE_KEY_B64
export VITALS_SITE_CIRCLE_ID="${VITALS_PROGRAMMED_CIRCLE_ID}"
export VITALS_DEPLOY_SITE_CIRCLE=1

if [ "${VITALS_PAUSE_UPDATER_TIMER_DURING_ASSET_PUBLISH:-1}" = "1" ] && systemctl is-active --quiet "${UPDATER_TIMER}"; then
  RESTORE_UPDATER_TIMER=1
  systemctl stop "${UPDATER_TIMER}"
fi
while systemctl is-active --quiet "${UPDATER_SERVICE}"; do
  sleep 2
done

SITE_DEPLOY_ENV="$(mktemp)"
write_selected_env_file "${SITE_DEPLOY_ENV}" \
  OCTRA_PROGRAM_RPC_URL OCTRA_PROGRAM_RPC_URLS OCTRA_TX_RPC_URL OCTRA_RPC_URL \
  OCTRA_RPC_TIMEOUT_MS OCTRA_RPC_ATTEMPTS OCTRA_RPC_RETRY_DELAY_MS \
  OCTRA_RPC_MAX_CONCURRENT OCTRA_RPC_MIN_START_GAP_MS OCTRA_RPC_MAX_QUEUE \
  OCTRA_RPC_QUEUE_WAIT_MS OCTRA_RPC_MAX_RESPONSE_BYTES \
  VITALS_GATEWAY_ROLE VITALS_DEPLOYER_ADDRESS VITALS_DEPLOYER_PRIVATE_KEY_B64 \
  VITALS_DEPLOY_SITE_CIRCLE VITALS_DEPLOY_SITE_CIRCLE_ALLOW_MAINNET VITALS_DEPLOY_WAIT VITALS_PROGRAMMED_CIRCLE_ID \
  VITALS_SITE_CIRCLE_ID VITALS_SITE_RELEASE_KIND VITALS_SITE_RELEASE_PATH \
  VITALS_SITE_ASSET_DIFF_CONCURRENCY VITALS_SITE_ASSET_FORCE_PATHS \
  VITALS_SITE_ASSET_OU VITALS_SITE_ASSET_SUBMIT_BATCH VITALS_SITE_ASSET_UPLOAD_MODE \
  VITALS_SITE_CIRCLE_PASSPHRASE VITALS_STATE_TARGET_MODE VITALS_STATE_PROGRAM_ADDRESS \
  VITALS_PROGRAMMED_CIRCLE_PROGRAM VITALS_PROGRAMMED_CIRCLE_ARTIFACT_DIR \
  VITALS_RECORD_SNAPSHOT_VERSION VITALS_APP_VERSION VITALS_GATEWAY_ORIGIN \
  VITALS_OCTRA_SCAN_ADDRESS_URL VITALS_OCTRA_SCAN_TX_URL OCTRA_SCAN_ADDRESS_URL OCTRA_SCAN_TX_URL \
  VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_SOURCE_HASH VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_BYTECODE_HASH \
  VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_VERIFICATION_HASH VITALS_PROGRAMMED_CIRCLE_SOURCE_HASH \
  VITALS_PROGRAMMED_CIRCLE_BYTECODE_HASH VITALS_PROGRAMMED_CIRCLE_VERIFICATION_HASH
chown "${APP_OWNER_USER}:${APP_OWNER_USER}" "${SITE_DEPLOY_ENV}"
chmod 600 "${SITE_DEPLOY_ENV}"

sudo -u "${APP_OWNER_USER}" env -i \
  PATH="/usr/local/bin:/usr/bin:/bin" \
  HOME="${OWNER_DIR}" \
  bash --noprofile --norc -c '
  set -euo pipefail
  cd "$1"
  . deploy/lib/env-file.sh
  load_env_file_data "$3"
  umask 077
  node dist/scripts/deploy-site-circle.js "$2"
' bash "${CURRENT}" "${OWNER_DIR}/site-circle-deploy.json" "${SITE_DEPLOY_ENV}"

DATA_DIR="${VITALS_DATA_DIR:-/var/lib/octra-vitals}"
install -d -m 750 -o root -g "${APP_USER}" "${DATA_DIR}/deployment-runs"
node dist/scripts/archive-deploy-spend-report.js \
  --kind site_assets \
  --report "${OWNER_DIR}/site-circle-deploy.json" \
  --out-dir "${DATA_DIR}/deployment-runs" || echo "warning: deployment spend archival failed" >&2
chgrp -R "${APP_USER}" "${DATA_DIR}/deployment-runs" || true
chmod -R g+rX "${DATA_DIR}/deployment-runs" || true

sudo systemctl restart octra-vitals-gateway.service
PORT="$(sudo grep -E '^PORT=' "${ENV_DIR}/gateway.env" | tail -n1 | cut -d= -f2- || true)"
PORT="${PORT:-4173}"
BASE="http://127.0.0.1:${PORT}"
for _ in $(seq 1 20); do
  if curl -fsS "${BASE}/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done
[ "${ready:-0}" = "1" ] || {
  echo "gateway did not become healthy after restart" >&2
  exit 1
}
node - <<'NODE' "${BASE}"
const fs = require("fs");
const http = require("http");

const base = new URL(process.argv[2]);
const release = JSON.parse(fs.readFileSync("build/site-circle-release.json", "utf8"));
const assets = Array.from(new Set((Array.isArray(release.assets) ? release.assets : [])
  .map((asset) => asset && asset.path)
  .filter((path) => typeof path === "string" && path.startsWith("/"))));

function getAsset(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: base.hostname, port: base.port, path, headers: { Accept: "*/*" } }, (res) => {
      let bytes = 0;
      res.on("data", (chunk) => { bytes += chunk.length; });
      res.on("end", () => {
        resolve({
          path,
          status: res.statusCode,
          source: res.headers["x-octra-asset-source"] || null,
          sha256: res.headers["x-octra-asset-sha256"] || null,
          bytes
        });
      });
    });
    req.setTimeout(30_000, () => req.destroy(new Error(`timeout warming ${path}`)));
    req.on("error", reject);
  });
}

(async () => {
  const warmed = [];
  for (const path of assets) {
    warmed.push(await getAsset(path));
  }
  const failures = warmed.filter((item) => item.status !== 200 || item.source !== "circle" || !item.sha256 || item.bytes <= 0);
  const sourceCounts = warmed.reduce((counts, item) => {
    const source = item.source || "missing";
    counts[source] = (counts[source] || 0) + 1;
    return counts;
  }, {});
  console.log(JSON.stringify({
    schema: "octra-vitals-static-asset-warm-report-v0",
    gateway: base.toString().replace(/\/$/, ""),
    warmed: warmed.length,
    source_counts: sourceCounts,
    failures
  }, null, 2));
  if (failures.length) process.exit(2);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE
sudo systemctl is-active octra-vitals-gateway.service
