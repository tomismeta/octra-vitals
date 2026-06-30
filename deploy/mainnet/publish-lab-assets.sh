#!/usr/bin/env bash
set -euo pipefail

APP_OPERATOR_USER="${APP_OPERATOR_USER:-octra-vitals-operator}"
APP_USER="${APP_USER:-octra-vitals}"
APP_ROOT="${APP_ROOT:-/opt/octra-vitals}"
DATA_DIR="${VITALS_DATA_DIR:-/var/lib/octra-vitals}"
ENV_DIR="${ENV_DIR:-/etc/octra-vitals}"
CURRENT="${APP_ROOT}/current"
CREATE_LAB_SITE_CIRCLE="${VITALS_LAB_SITE_CIRCLE_CREATE:-0}"

if [ "$(id -u)" -ne 0 ]; then
  echo "publish-lab-assets.sh must run as root so operator wallet env can stay root-only" >&2
  exit 1
fi

cd "${CURRENT}"

set -a
[ -r "${ENV_DIR}/gateway.env" ] && . "${ENV_DIR}/gateway.env"
[ -r "${ENV_DIR}/lab-history.env" ] && . "${ENV_DIR}/lab-history.env"
set +a

LAB_CIRCLE_ID="${VITALS_LAB_SITE_CIRCLE_ID:-}"
if [ -z "${LAB_CIRCLE_ID}" ] && [ "${CREATE_LAB_SITE_CIRCLE}" != "1" ] && [ -n "${VITALS_LAB_HISTORY_DATABASE_URI:-}" ]; then
  LAB_CIRCLE_ID="$(node -e '
const uri = process.env.VITALS_LAB_HISTORY_DATABASE_URI || "";
const match = uri.match(/^oct:\/\/[^/]+\/([^/?#]+)/);
if (match) process.stdout.write(match[1]);
')"
fi

if [ -z "${LAB_CIRCLE_ID}" ] && [ "${CREATE_LAB_SITE_CIRCLE}" != "1" ]; then
  echo "VITALS_LAB_SITE_CIRCLE_ID or VITALS_LAB_HISTORY_DATABASE_URI is required" >&2
  exit 1
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

set -a
[ -r "${ENV_DIR}/updater.env" ] && . "${ENV_DIR}/updater.env"
set +a
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

sudo --preserve-env -u "${APP_OPERATOR_USER}" env HOME="${DATA_DIR}" bash --noprofile --norc -lc "
  set -euo pipefail
  cd '${CURRENT}'
  node dist/scripts/deploy-site-circle.js '${DATA_DIR}/lab-site-circle-deploy.json'
"

LAB_CIRCLE_ID="$(node -e '
const fs = require("fs");
const path = process.argv[1];
try {
  const report = JSON.parse(fs.readFileSync(path, "utf8"));
  process.stdout.write(report.circle_id || "");
} catch {}
' "${DATA_DIR}/lab-site-circle-deploy.json")"

if [ -z "${LAB_CIRCLE_ID}" ]; then
  echo "Lab asset deploy report did not contain circle_id" >&2
  exit 1
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
set_env "${ENV_DIR}/lab-history.env" VITALS_LAB_SITE_CIRCLE_ID "${LAB_CIRCLE_ID}" 640 "${APP_USER}"

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
