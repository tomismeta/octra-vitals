#!/usr/bin/env bash
set -euo pipefail

ENV_DIR="${ENV_DIR:-/etc/octra-vitals}"
PORT="$(sudo grep -E '^PORT=' "${ENV_DIR}/gateway.env" | tail -n1 | cut -d= -f2- || true)"
PORT="${PORT:-4173}"
BASE="http://127.0.0.1:${PORT}"

for _ in $(seq 1 20); do
  if curl -fsS "${BASE}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

curl -fsSI "${BASE}/" | tr -d '\r' | grep -E '^(HTTP/|Content-Type:|X-Octra-Asset-Source:|X-Octra-Asset-SHA256:)'

node - <<'NODE' "${BASE}"
const http = require("http");
const base = new URL(process.argv[2]);
function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: base.hostname, port: base.port, path }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (error) {
          reject(error);
        }
      });
    }).on("error", reject);
  });
}
(async () => {
  const [latest, history, site, readiness, version] = await Promise.all([
    get("/api/latest"),
    get("/api/history"),
    get("/api/site-integrity"),
    get("/api/native-readiness"),
    get("/api/version")
  ]);
  const summary = {
    latest_status_code: latest.status,
    latest_status: latest.body.status,
    latest_snapshot_id: latest.body.envelope?.snapshot_id || latest.body.snapshot_id || null,
    latest_fresh: latest.body.fresh,
    latest_canonical_state_read: latest.body.authority?.canonical_state_read,
    history_rows: history.body.row_count || history.body.snapshots?.length || 0,
    history_window_hash: history.body.window_hash || null,
    site_circle_id: site.body.site_integrity?.circle_id || null,
    site_local_assets_match: site.body.site_integrity?.local_assets_match,
    site_circle_assets_match: site.body.site_integrity?.circle_assets_match,
    readiness_status: readiness.body.native_readiness?.status || null,
    readiness_state_target_mode: readiness.body.native_readiness?.state_target_mode || null,
    version_site_circle_id: version.body.site_circle_id || null,
    version_state_target_mode: version.body.state_target_mode || null,
    version_programmed_circle_id: version.body.programmed_circle_id || null
  };
  console.log(JSON.stringify(summary, null, 2));
  const ok =
    summary.latest_status_code === 200 &&
    summary.latest_status === "program" &&
    summary.latest_fresh === true &&
    summary.latest_canonical_state_read === true &&
    summary.history_rows >= 1 &&
    summary.site_local_assets_match === true &&
    summary.site_circle_assets_match === true &&
    summary.readiness_status === "native_ready" &&
    summary.readiness_state_target_mode === "circle_program";
  if (!ok) process.exit(2);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE
