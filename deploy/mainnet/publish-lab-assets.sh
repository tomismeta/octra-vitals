#!/usr/bin/env bash
set -euo pipefail

APP_OWNER_USER="${APP_OWNER_USER:-octra-vitals-owner}"
APP_USER="${APP_USER:-octra-vitals}"
APP_ROOT="${APP_ROOT:-/opt/octra-vitals}"
OWNER_DIR="${VITALS_OWNER_DATA_DIR:-/var/lib/octra-vitals-owner}"
ENV_DIR="${ENV_DIR:-/etc/octra-vitals}"
CURRENT="${APP_ROOT}/current"
CREATE_LAB_SITE_CIRCLE="${VITALS_LAB_SITE_CIRCLE_CREATE:-0}"
SITE_DEPLOY_ENV=""

if [ "$(id -u)" -ne 0 ]; then
  echo "publish-lab-assets.sh must run as root so operator wallet env can stay root-only" >&2
  exit 1
fi
if ! id "${APP_OWNER_USER}" >/dev/null 2>&1; then
  echo "missing cold-owner user: ${APP_OWNER_USER}; run bootstrap-host.sh first" >&2
  exit 1
fi

cleanup() {
  rm -f "${SITE_DEPLOY_ENV:-}"
}
trap cleanup EXIT

cd "${CURRENT}"
. deploy/lib/env-file.sh

load_env_file_data "${ENV_DIR}/gateway.env" optional
load_env_file_data "${ENV_DIR}/lab-history.env" optional

LAB_CIRCLE_ID="${VITALS_LAB_SITE_CIRCLE_ID:-}"

if [ -z "${LAB_CIRCLE_ID}" ] && [ "${CREATE_LAB_SITE_CIRCLE}" != "1" ]; then
  echo "VITALS_LAB_SITE_CIRCLE_ID is required unless VITALS_LAB_SITE_CIRCLE_CREATE=1" >&2
  exit 1
fi

if [ -n "${LAB_CIRCLE_ID}" ] && [ -n "${VITALS_LAB_HISTORY_DATABASE_URI:-}" ]; then
  DB_CIRCLE_ID="$(node -e '
const uri = process.env.VITALS_LAB_HISTORY_DATABASE_URI || "";
const match = uri.match(/^oct:\/\/[^/]+\/([^/?#]+)/);
if (match) process.stdout.write(match[1]);
')"
  if [ -n "${DB_CIRCLE_ID}" ] && [ "${LAB_CIRCLE_ID}" = "${DB_CIRCLE_ID}" ]; then
    echo "VITALS_LAB_SITE_CIRCLE_ID must be a public Lab Web Circle distinct from the sealed Lab DB Circle" >&2
    exit 1
  fi
fi

export VITALS_SITE_RELEASE_KIND=lab
export VITALS_SITE_RELEASE_PATH=build/lab-site-circle-release.json
export VITALS_LAB_SITE_CIRCLE_CREATE="${CREATE_LAB_SITE_CIRCLE}"
if [ -n "${LAB_CIRCLE_ID}" ]; then
  export VITALS_LAB_SITE_CIRCLE_ID="${LAB_CIRCLE_ID}"
  export VITALS_SITE_CIRCLE_ID="${LAB_CIRCLE_ID}"
else
  unset VITALS_LAB_SITE_CIRCLE_ID
  unset VITALS_SITE_CIRCLE_ID
fi
export VITALS_SITE_ASSET_UPLOAD_MODE="${VITALS_SITE_ASSET_UPLOAD_MODE:-changed}"

npm run build
node dist/scripts/build-site-circle-release.js --lab

load_env_file_data "${ENV_DIR}/updater.env" optional
load_env_file_data "${ENV_DIR}/owner.env"
unset VITALS_OPERATOR_PRIVATE_KEY_B64 OCTRA_PRIVATE_KEY_B64
export VITALS_SITE_RELEASE_KIND=lab
export VITALS_SITE_RELEASE_PATH=build/lab-site-circle-release.json
export VITALS_LAB_SITE_CIRCLE_CREATE="${CREATE_LAB_SITE_CIRCLE}"
if [ -n "${LAB_CIRCLE_ID}" ]; then
  export VITALS_LAB_SITE_CIRCLE_ID="${LAB_CIRCLE_ID}"
  export VITALS_SITE_CIRCLE_ID="${LAB_CIRCLE_ID}"
else
  unset VITALS_LAB_SITE_CIRCLE_ID
  unset VITALS_SITE_CIRCLE_ID
fi
export VITALS_DEPLOY_SITE_CIRCLE=1

SITE_DEPLOY_ENV="$(mktemp)"
write_selected_env_file "${SITE_DEPLOY_ENV}" \
  OCTRA_PROGRAM_RPC_URL OCTRA_PROGRAM_RPC_URLS OCTRA_TX_RPC_URL OCTRA_RPC_URL \
  OCTRA_RPC_TIMEOUT_MS OCTRA_RPC_ATTEMPTS OCTRA_RPC_RETRY_DELAY_MS \
  OCTRA_RPC_MAX_CONCURRENT OCTRA_RPC_MIN_START_GAP_MS OCTRA_RPC_MAX_QUEUE \
  OCTRA_RPC_QUEUE_WAIT_MS OCTRA_RPC_MAX_RESPONSE_BYTES \
  VITALS_GATEWAY_ROLE VITALS_DEPLOYER_ADDRESS VITALS_DEPLOYER_PRIVATE_KEY_B64 \
  VITALS_DEPLOY_SITE_CIRCLE VITALS_DEPLOY_SITE_CIRCLE_ALLOW_MAINNET VITALS_DEPLOY_WAIT VITALS_PROGRAMMED_CIRCLE_ID \
  VITALS_SITE_CIRCLE_ID VITALS_LAB_SITE_CIRCLE_ID VITALS_SITE_RELEASE_KIND \
  VITALS_SITE_RELEASE_PATH VITALS_LAB_SITE_CIRCLE_CREATE VITALS_SITE_ASSET_DIFF_CONCURRENCY \
  VITALS_SITE_ASSET_FORCE_PATHS VITALS_SITE_ASSET_OU VITALS_SITE_ASSET_SUBMIT_BATCH \
  VITALS_SITE_ASSET_UPLOAD_MODE VITALS_SITE_CIRCLE_PASSPHRASE VITALS_STATE_TARGET_MODE \
  VITALS_STATE_PROGRAM_ADDRESS VITALS_PROGRAMMED_CIRCLE_PROGRAM VITALS_PROGRAMMED_CIRCLE_ARTIFACT_DIR \
  VITALS_RECORD_SNAPSHOT_VERSION VITALS_APP_VERSION VITALS_GATEWAY_ORIGIN \
  VITALS_OCTRA_SCAN_ADDRESS_URL VITALS_OCTRA_SCAN_TX_URL OCTRA_SCAN_ADDRESS_URL OCTRA_SCAN_TX_URL \
  VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_SOURCE_HASH VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_BYTECODE_HASH \
  VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_VERIFICATION_HASH VITALS_PROGRAMMED_CIRCLE_SOURCE_HASH \
  VITALS_PROGRAMMED_CIRCLE_BYTECODE_HASH VITALS_PROGRAMMED_CIRCLE_VERIFICATION_HASH

sudo -u "${APP_OWNER_USER}" env -i \
  PATH="/usr/local/bin:/usr/bin:/bin" \
  HOME="${OWNER_DIR}" \
  bash --noprofile --norc -c '
  set -euo pipefail
  cd "$1"
  . deploy/lib/env-file.sh
  load_env_file_data /dev/stdin
  umask 077
  node dist/scripts/deploy-site-circle.js "$2"
' bash "${CURRENT}" "${OWNER_DIR}/lab-site-circle-deploy.json" < "${SITE_DEPLOY_ENV}"

LAB_CIRCLE_ID="$(node -e '
const fs = require("fs");
const path = process.argv[1];
try {
  const report = JSON.parse(fs.readFileSync(path, "utf8"));
  process.stdout.write(report.circle_id || "");
} catch {}
' "${OWNER_DIR}/lab-site-circle-deploy.json")"

if [ -z "${LAB_CIRCLE_ID}" ]; then
  echo "Lab asset deploy report did not contain circle_id" >&2
  exit 1
fi

if [ -n "${VITALS_LAB_HISTORY_DATABASE_URI:-}" ]; then
  DB_CIRCLE_ID="$(node -e '
const uri = process.env.VITALS_LAB_HISTORY_DATABASE_URI || "";
const match = uri.match(/^oct:\/\/[^/]+\/([^/?#]+)/);
if (match) process.stdout.write(match[1]);
')"
  if [ -n "${DB_CIRCLE_ID}" ] && [ "${LAB_CIRCLE_ID}" = "${DB_CIRCLE_ID}" ]; then
    echo "Lab asset deploy resolved to the sealed Lab DB Circle; refusing mixed boundary" >&2
    exit 1
  fi
fi

set_env() {
  file="$1"
  key="$2"
  value="$3"
  mode="${4:-640}"
  group="${5:-octra-vitals}"
  tmp="$(mktemp)"
  sudo touch "${file}"
  sudo grep -v -E "^${key}=" "${file}" > "${tmp}" || true
  printf '%s=%s\n' "${key}" "${value}" >> "${tmp}"
  sudo install -m "${mode}" -o root -g "${group}" "${tmp}" "${file}"
  rm -f "${tmp}"
}

set_env "${ENV_DIR}/gateway.env" VITALS_LAB_SITE_CIRCLE_ID "${LAB_CIRCLE_ID}" 640 "${APP_USER}"
set_env "${ENV_DIR}/lab-history.env" VITALS_LAB_SITE_CIRCLE_ID "${LAB_CIRCLE_ID}" 600 root

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

node - <<'NODE' "${BASE}" "${LAB_CIRCLE_ID}"
const http = require("http");

const base = new URL(process.argv[2]);
const expectedCircle = process.argv[3];
const paths = ["/lab/history", "/lab-history.css", "/lab-history.js"];

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: base.hostname, port: base.port, path, headers: { Accept: "*/*" } }, (res) => {
      let bytes = 0;
      res.on("data", (chunk) => { bytes += chunk.length; });
      res.on("end", () => resolve({
        path,
        status: res.statusCode,
        source: res.headers["x-octra-asset-source"] || null,
        circle: res.headers["x-octra-circle-id"] || null,
        sha256: res.headers["x-octra-asset-sha256"] || null,
        bytes
      }));
    });
    req.setTimeout(30_000, () => req.destroy(new Error(`timeout verifying ${path}`)));
    req.on("error", reject);
  });
}

(async () => {
  const results = [];
  for (const path of paths) results.push(await get(path));
  const failures = results.filter((item) =>
    item.status !== 200 ||
    item.source !== "circle" ||
    item.circle !== expectedCircle ||
    !item.sha256 ||
    item.bytes <= 0
  );
  console.log(JSON.stringify({ lab_circle_id: expectedCircle, assets: results }, null, 2));
  if (failures.length) {
    console.error(JSON.stringify({ failures }, null, 2));
    process.exit(1);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE
