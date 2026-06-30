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

LAB_SITE_CIRCLE_ID="$(
  { sudo grep -h -E '^VITALS_LAB_SITE_CIRCLE_ID=' "${ENV_DIR}/gateway.env" "${ENV_DIR}/lab-history.env" 2>/dev/null || true; } \
    | tail -n1 \
    | cut -d= -f2-
)"
LAB_DB_URI="$(
  { sudo grep -h -E '^VITALS_LAB_HISTORY_DATABASE_URI=' "${ENV_DIR}/gateway.env" "${ENV_DIR}/lab-history.env" 2>/dev/null || true; } \
    | tail -n1 \
    | cut -d= -f2-
)"

if [ -z "${LAB_SITE_CIRCLE_ID}" ]; then
  echo "VITALS_LAB_SITE_CIRCLE_ID is required for lab runtime verification" >&2
  exit 2
fi
if [ -z "${LAB_DB_URI}" ]; then
  echo "VITALS_LAB_HISTORY_DATABASE_URI is required for lab runtime verification" >&2
  exit 2
fi

node - <<'NODE' "${BASE}" "${LAB_SITE_CIRCLE_ID}" "${LAB_DB_URI}"
const http = require("http");

const base = new URL(process.argv[2]);
const expectedLabCircle = process.argv[3];
const labDbUri = process.argv[4];
const dbMatch = labDbUri.match(/^oct:\/\/([^/]+)\/([^/?#]+)/);
if (!dbMatch) throw new Error(`invalid lab database uri: ${labDbUri}`);
const expectedNetwork = dbMatch[1];
const expectedDbCircle = dbMatch[2];
if (expectedLabCircle === expectedDbCircle) {
  throw new Error("Lab Web Circle must be distinct from sealed Lab DB Circle");
}

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      host: base.hostname,
      port: base.port,
      method,
      path,
      headers: {
        Accept: "application/json",
        ...(payload ? { "Content-Type": "application/json", "Content-Length": String(payload.length) } : {})
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.setTimeout(30_000, () => req.destroy(new Error(`timeout: ${method} ${path}`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function head(path) {
  return request("HEAD", path);
}

(async () => {
  const staticPaths = ["/lab/history", "/lab-history.css", "/lab-history.js"];
  const staticChecks = [];
  for (const path of staticPaths) {
    const res = await head(path);
    staticChecks.push({
      path,
      status: res.status,
      source: res.headers["x-octra-asset-source"] || null,
      circle: res.headers["x-octra-circle-id"] || null,
      consistency: res.headers["x-octra-circle-consistency"] || null
    });
  }

  const status = await request("GET", "/api/lab/status");
  const history = await request("GET", "/api/lab/history?window=1h&limit=5");
  const tables = await request("GET", "/api/lab/tables");
  const schema = await request("GET", "/api/lab/schema");
  const query = await request("POST", "/api/lab/query", {
    sql: "select snapshot_index, snapshot_id from snapshots order by snapshot_index desc",
    limit: 1
  });

  const failures = [];
  for (const item of staticChecks) {
    if (item.status !== 200) failures.push(`${item.path} returned ${item.status}`);
    if (item.source !== "circle") failures.push(`${item.path} was not served from Circle`);
    if (item.circle !== expectedLabCircle) failures.push(`${item.path} served from ${item.circle}, expected ${expectedLabCircle}`);
    if (item.consistency !== "verified") failures.push(`${item.path} Circle consistency is ${item.consistency}`);
  }
  for (const [name, res] of Object.entries({ status, history, tables, schema, query })) {
    if (res.status !== 200) failures.push(`/api/lab/${name} returned ${res.status}: ${res.text.slice(0, 160)}`);
  }
  const authority = status.json?.authority || {};
  if (authority.lab_database_enabled !== true) failures.push("lab database is not enabled");
  if (authority.lab_database_network !== expectedNetwork) failures.push(`lab database network ${authority.lab_database_network} != ${expectedNetwork}`);
  if (authority.lab_database_uri !== labDbUri) failures.push("lab database URI does not match env");
  const queryCircle = query.json?.result?.proof?.circle_id || null;
  if (queryCircle !== expectedDbCircle) failures.push(`query proof circle ${queryCircle} != DB circle ${expectedDbCircle}`);

  const summary = {
    lab_site_circle_id: expectedLabCircle,
    lab_db_circle_id: expectedDbCircle,
    lab_db_network: expectedNetwork,
    static_assets: staticChecks,
    status_rows: status.json?.database?.rows?.length || 0,
    history_rows: history.json?.result?.row_count || 0,
    query_rows: query.json?.result?.row_count || 0
  };
  console.log(JSON.stringify(summary, null, 2));
  if (failures.length) {
    console.error(JSON.stringify({ failures }, null, 2));
    process.exit(2);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE
