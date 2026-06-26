#!/usr/bin/env bash
set -euo pipefail

GATEWAY_URL="${DEPLOY_DEVNET_REHEARSAL_GATEWAY_URL:-${1:-https://devnet.octra.live}}"
REPORT_PATH="${DEPLOY_DEVNET_REHEARSAL_REPORT:-build/devnet-rehearsal-report.json}"
ALLOWED_HOSTS="${DEPLOY_DEVNET_REHEARSAL_ALLOWED_HOSTS:-devnet.octra.live,octra-stage.exe.xyz,octra-dev.exe.xyz}"
MIN_HISTORY_INDEX="${DEPLOY_DEVNET_REHEARSAL_MIN_HISTORY_INDEX:-${DEPLOY_DEVNET_REHEARSAL_MIN_HISTORY_ROWS:-49}}"

npm run native:verify

mkdir -p "$(dirname "${REPORT_PATH}")"

node - <<'NODE' "${GATEWAY_URL}" "${REPORT_PATH}" "${ALLOWED_HOSTS}" "${MIN_HISTORY_INDEX}"
const fs = require("fs");
const { execFileSync } = require("child_process");

const gatewayUrl = process.argv[2].replace(/\/$/, "");
const reportPath = process.argv[3];
const allowedHosts = String(process.argv[4] || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
const minHistoryIndex = Number(process.argv[5] || 49);
const generatedAt = new Date().toISOString();
const gitCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

async function getJson(path) {
  const url = `${gatewayUrl}${path}`;
  const startedAt = Date.now();
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch (error) {
    body = { parse_error: error instanceof Error ? error.message : String(error), body_prefix: text.slice(0, 200) };
  }
  return {
    path,
    status: res.status,
    elapsed_ms: Date.now() - startedAt,
    body
  };
}

function hostAllowed(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return allowedHosts.includes(host);
  } catch {
    return false;
  }
}

function check(id, ok, detail) {
  return { id, ok: Boolean(ok), detail };
}

(async () => {
  const [latest, history, site, readiness, version] = await Promise.all([
    getJson("/api/latest"),
    getJson("/api/history"),
    getJson("/api/site-integrity"),
    getJson("/api/native-readiness"),
    getJson("/api/version")
  ]);

  const latestBody = latest.body || {};
  const authority = latestBody.authority || {};
  const health = latestBody.payload?.health?.conservation || latestBody.envelope?.payload?.health?.conservation || null;
  const historyBody = history.body || {};
  const siteIntegrity = site.body?.site_integrity || {};
  const nativeReadiness = readiness.body?.native_readiness || {};
  const versionBody = version.body || {};
  const historySnapshots = Array.isArray(historyBody.snapshots) ? historyBody.snapshots : [];
  const historyRows = Number(historyBody.row_count || historySnapshots.length || 0);
  const historyFirstIndex = Number(historyBody.first_index || historySnapshots[0]?.snapshot_index || 0);
  const historyLatestIndex = Number(historySnapshots[historySnapshots.length - 1]?.snapshot_index || 0);
  const historyProof = historyBody.proof || {};
  const historyCoverage = historyBody.coverage || {};
  const historyProvesFullChain = historyProof.proof_status === "fact_family_verified" &&
    historyProof.proof_scope === "full_chain" &&
    historyProof.truncated === false;
  const historyProvesRolloverWindow = historyRows >= 48 &&
    historyFirstIndex > 1 &&
    historyLatestIndex >= minHistoryIndex;
  const historyProvesCanonicalRange = historyProvesFullChain
    ? historyRows >= minHistoryIndex && historyLatestIndex >= minHistoryIndex
    : historyProvesRolloverWindow;

  const summary = {
    gateway_url: gatewayUrl,
    latest_status_code: latest.status,
    latest_status: latestBody.status || null,
    latest_snapshot_id: latestBody.envelope?.snapshot_id || latestBody.snapshot_id || null,
    latest_snapshot_index: latestBody.snapshot_index ?? latestBody.authority?.snapshot_index ?? null,
    latest_fresh: latestBody.fresh ?? null,
    latest_canonical_state_read: authority.canonical_state_read ?? null,
    conservation_status: health?.status || null,
    conservation_flags: Array.isArray(health?.flags) ? health.flags : [],
    history_status_code: history.status,
    history_rows: historyRows,
    history_first_index: historyFirstIndex || null,
    history_latest_index: historyLatestIndex || null,
    history_canonical_state_read: historyBody.authority?.canonical_state_read ?? null,
    history_window_hash: historyBody.window_hash || null,
    history_model: historyBody.history_model || historyProof.history_model || null,
    history_proof_status: historyProof.proof_status || null,
    history_proof_scope: historyProof.proof_scope || null,
    history_proof_truncated: historyProof.truncated ?? null,
    history_coverage_status: historyCoverage.status || null,
    site_status_code: site.status,
    site_circle_id: siteIntegrity.circle_id || null,
    site_local_assets_match: siteIntegrity.local_assets_match ?? null,
    site_circle_assets_match: siteIntegrity.circle_assets_match ?? null,
    readiness_status_code: readiness.status,
    readiness_status: nativeReadiness.status || null,
    readiness_state_target_mode: nativeReadiness.state_target_mode || null,
    version_status_code: version.status,
    version_site_circle_id: versionBody.site_circle_id || null,
    version_state_target_mode: versionBody.state_target_mode || null,
    version_programmed_circle_id: versionBody.programmed_circle_id || null,
    version_release_git_commit: versionBody.release_git_commit || null,
    version_release_git_dirty: versionBody.release_git_dirty ?? null
  };
  const expectedSiteCircleId = process.env.DEPLOY_DEVNET_REHEARSAL_EXPECTED_SITE_CIRCLE_ID || "";
  const expectedProgrammedCircleId = process.env.DEPLOY_DEVNET_REHEARSAL_EXPECTED_PROGRAMMED_CIRCLE_ID || "";

  const checks = [
    check("gateway_host_allowlisted", hostAllowed(gatewayUrl), `${gatewayUrl} allowed=${allowedHosts.join(",")}`),
    check("deployed_release_matches_local", summary.version_release_git_commit === gitCommit && summary.version_release_git_dirty === false, `deployed=${summary.version_release_git_commit} dirty=${summary.version_release_git_dirty} local=${gitCommit}`),
    check("latest_serves_program_data", latest.status === 200 && summary.latest_status === "program", `${latest.status} ${summary.latest_status}`),
    check("latest_is_fresh", summary.latest_fresh === true, String(summary.latest_fresh)),
    check("latest_is_canonical_state_read", summary.latest_canonical_state_read === true, String(summary.latest_canonical_state_read)),
    check("conservation_not_red", summary.conservation_status && summary.conservation_status !== "red", summary.conservation_status || "missing"),
    check("history_is_canonical", history.status === 200 && summary.history_canonical_state_read === true, `${history.status} ${summary.history_canonical_state_read}`),
    check(
      "history_proves_rollover_window",
      historyProvesCanonicalRange,
      `rows=${summary.history_rows} first=${summary.history_first_index} latest=${summary.history_latest_index} min_latest=${minHistoryIndex} proof=${summary.history_proof_status}/${summary.history_proof_scope} truncated=${summary.history_proof_truncated}`
    ),
    check("site_integrity_verified", site.status === 200 && summary.site_local_assets_match === true && summary.site_circle_assets_match === true, `${site.status} local=${summary.site_local_assets_match} circle=${summary.site_circle_assets_match}`),
    check("native_readiness_ready", readiness.status === 200 && summary.readiness_status === "native_ready", `${readiness.status} ${summary.readiness_status}`),
    check("programmed_circle_runtime", summary.readiness_state_target_mode === "circle_program", summary.readiness_state_target_mode || "missing"),
    check("site_circle_id_matches_expected", !expectedSiteCircleId || summary.version_site_circle_id === expectedSiteCircleId || summary.site_circle_id === expectedSiteCircleId, expectedSiteCircleId || "not configured"),
    check("programmed_circle_id_matches_expected", !expectedProgrammedCircleId || summary.version_programmed_circle_id === expectedProgrammedCircleId, expectedProgrammedCircleId || "not configured")
  ];

  const report = {
    schema: "octra-vitals-devnet-rehearsal-report-v0",
    generated_at: generatedAt,
    git_commit: gitCommit,
    gateway_url: gatewayUrl,
    local_native_verify: "passed",
    status: checks.every((item) => item.ok) ? "passed" : "failed",
    summary,
    checks
  };

  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${reportPath}`);
  console.log(JSON.stringify({ status: report.status, generated_at: generatedAt, git_commit: gitCommit, gateway_url: gatewayUrl }, null, 2));
  if (report.status !== "passed") {
    console.error(JSON.stringify(checks.filter((item) => !item.ok), null, 2));
    process.exit(2);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE
