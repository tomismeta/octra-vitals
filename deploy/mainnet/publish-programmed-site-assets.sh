#!/usr/bin/env bash
set -euo pipefail

APP_USER="${APP_USER:-octra-vitals}"
APP_OPERATOR_USER="${APP_OPERATOR_USER:-octra-vitals-operator}"
APP_ROOT="${APP_ROOT:-/opt/octra-vitals}"
DATA_DIR="${VITALS_DATA_DIR:-/var/lib/octra-vitals}"
ENV_DIR="${ENV_DIR:-/etc/octra-vitals}"
CURRENT="${APP_ROOT}/current"
UPDATER_TIMER="${UPDATER_TIMER:-octra-vitals-updater.timer}"
UPDATER_SERVICE="${UPDATER_SERVICE:-octra-vitals-updater.service}"
RESTORE_UPDATER_TIMER=0

if [ "$(id -u)" -ne 0 ]; then
  echo "publish-programmed-site-assets.sh must run as root so updater.env can stay root-only" >&2
  exit 1
fi

restore_updater_timer() {
  if [ "${RESTORE_UPDATER_TIMER}" = "1" ]; then
    systemctl start "${UPDATER_TIMER}" || true
  fi
}
trap restore_updater_timer EXIT

cd "${CURRENT}"

set -a
. "${ENV_DIR}/gateway.env"
set +a

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

set -a
. "${ENV_DIR}/updater.env"
set +a
export VITALS_SITE_CIRCLE_ID="${VITALS_PROGRAMMED_CIRCLE_ID}"
export VITALS_DEPLOY_SITE_CIRCLE=1

if [ "${VITALS_PAUSE_UPDATER_TIMER_DURING_ASSET_PUBLISH:-1}" = "1" ] && systemctl is-active --quiet "${UPDATER_TIMER}"; then
  RESTORE_UPDATER_TIMER=1
  systemctl stop "${UPDATER_TIMER}"
fi
while systemctl is-active --quiet "${UPDATER_SERVICE}"; do
  sleep 2
done

sudo --preserve-env -u "${APP_OPERATOR_USER}" env HOME="${DATA_DIR}" bash --noprofile --norc -lc "
  set -euo pipefail
  cd '${CURRENT}'
  node dist/scripts/deploy-site-circle.js '${DATA_DIR}/site-circle-deploy.json'
"

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
const manifest = JSON.parse(fs.readFileSync("app/manifest.json", "utf8"));
const assets = Array.from(new Set([manifest.entry || "/index.html", ...(Array.isArray(manifest.assets) ? manifest.assets : [])]));

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
