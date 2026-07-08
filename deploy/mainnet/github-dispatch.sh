#!/usr/bin/env bash
set -euo pipefail

ACTION="${DEPLOY_ACTION:-${MAINNET_ACTION:-verify_only}}"
TARGET_HOST="${DEPLOY_TARGET_HOST:-${MAINNET_TARGET_HOST:-}}"
GATEWAY_PORT="${DEPLOY_GATEWAY_PORT:-${MAINNET_GATEWAY_PORT:-8000}}"
CONFIRMATION="${DEPLOY_CONFIRMATION:-${MAINNET_CONFIRMATION:-}}"
ENABLE_TIMERS_ACK="${DEPLOY_ENABLE_TIMERS_ACK:-${MAINNET_ENABLE_TIMERS_ACK:-}}"
DEPLOY_ENVIRONMENT="${DEPLOY_ENVIRONMENT:-${MAINNET_DEPLOY_ENVIRONMENT:-mainnet}}"
SSH_USER="${DEPLOY_SSH_USER:-${MAINNET_SSH_USER:-}}"
SSH_PRIVATE_KEY="${DEPLOY_SSH_PRIVATE_KEY:-${MAINNET_SSH_PRIVATE_KEY:-}}"
SSH_KNOWN_HOSTS_B64="${DEPLOY_SSH_KNOWN_HOSTS_B64:-${MAINNET_SSH_KNOWN_HOSTS_B64:-}}"
SSH_HOST_KEY_LINE="${DEPLOY_SSH_HOST_KEY_LINE:-${MAINNET_SSH_HOST_KEY_LINE:-}}"
UPDATER_ENV_B64="${DEPLOY_UPDATER_ENV_B64:-${MAINNET_UPDATER_ENV_B64:-}}"
DEVNET_REHEARSAL_ACK="${DEPLOY_DEVNET_REHEARSAL_ACK:-${MAINNET_DEVNET_REHEARSAL_ACK:-}}"
DEVNET_REHEARSAL_REPORT_B64="${DEPLOY_DEVNET_REHEARSAL_REPORT_B64:-${MAINNET_DEVNET_REHEARSAL_REPORT_B64:-}}"
DEVNET_REHEARSAL_MAX_AGE_HOURS="${DEPLOY_DEVNET_REHEARSAL_MAX_AGE_HOURS:-48}"
DEVNET_REHEARSAL_ALLOWED_HOSTS="${DEPLOY_DEVNET_REHEARSAL_ALLOWED_HOSTS:-devnet.octra.live,octra-stage.exe.xyz,octra-dev.exe.xyz}"
PROGRAMMED_CIRCLE_PROGRAM="${DEPLOY_PROGRAMMED_CIRCLE_PROGRAM:-${MAINNET_PROGRAMMED_CIRCLE_PROGRAM:-${VITALS_PROGRAMMED_CIRCLE_PROGRAM:-}}}"
RECORD_SNAPSHOT_VERSION="${DEPLOY_RECORD_SNAPSHOT_VERSION:-${MAINNET_RECORD_SNAPSHOT_VERSION:-${VITALS_RECORD_SNAPSHOT_VERSION:-}}}"
PROGRAMMED_CIRCLE_ARTIFACT_DIR="${DEPLOY_PROGRAMMED_CIRCLE_ARTIFACT_DIR:-${MAINNET_PROGRAMMED_CIRCLE_ARTIFACT_DIR:-${VITALS_PROGRAMMED_CIRCLE_ARTIFACT_DIR:-}}}"
FACT_LEDGER_NETWORK_ID="${DEPLOY_FACT_LEDGER_NETWORK_ID:-${MAINNET_FACT_LEDGER_NETWORK_ID:-${VITALS_FACT_LEDGER_NETWORK_ID:-}}}"
FACT_LEDGER_PREDECESSOR_PROGRAM="${DEPLOY_FACT_LEDGER_PREDECESSOR_PROGRAM:-${MAINNET_FACT_LEDGER_PREDECESSOR_PROGRAM:-${VITALS_FACT_LEDGER_PREDECESSOR_PROGRAM:-}}}"
FACT_LEDGER_PREDECESSOR_FINAL_INDEX="${DEPLOY_FACT_LEDGER_PREDECESSOR_FINAL_INDEX:-${MAINNET_FACT_LEDGER_PREDECESSOR_FINAL_INDEX:-${VITALS_FACT_LEDGER_PREDECESSOR_FINAL_INDEX:-}}}"
FACT_LEDGER_PREDECESSOR_FINAL_ROOT="${DEPLOY_FACT_LEDGER_PREDECESSOR_FINAL_ROOT:-${MAINNET_FACT_LEDGER_PREDECESSOR_FINAL_ROOT:-${VITALS_FACT_LEDGER_PREDECESSOR_FINAL_ROOT:-}}}"
APP_ROOT="${APP_ROOT:-/opt/octra-vitals}"
DATA_DIR="${VITALS_DATA_DIR:-/var/lib/octra-vitals}"

environment_label() {
  printf '%s' "${DEPLOY_ENVIRONMENT}" | tr '[:lower:]' '[:upper:]'
}

require_host() {
  if [ -z "${TARGET_HOST}" ]; then
    echo "DEPLOY_TARGET_HOST or MAINNET_TARGET_HOST is required" >&2
    exit 1
  fi
}

remote_target() {
  if [[ "${TARGET_HOST}" == *@* ]] || [ -z "${SSH_USER}" ]; then
    printf '%s' "${TARGET_HOST}"
  else
    printf '%s@%s' "${SSH_USER}" "${TARGET_HOST}"
  fi
}

scan_host() {
  local host="${TARGET_HOST#*@}"
  host="${host%%:*}"
  printf '%s' "${host}"
}

validate_target_host() {
  local host allowed
  host="$(scan_host)"
  if [ "${DEPLOY_ALLOW_ANY_TARGET_HOST:-0}" = "1" ]; then
    return
  fi
  if [ "${DEPLOY_ENVIRONMENT}" = "mainnet" ]; then
    allowed="${DEPLOY_MAINNET_ALLOWED_HOSTS:-octra-live.exe.xyz,octra.live,www.octra.live}"
  else
    allowed="${DEPLOY_STAGE_ALLOWED_HOSTS:-octra-stage.exe.xyz,devnet.octra.live,octra-dev.exe.xyz}"
  fi
  case ",${allowed}," in
    *",${host},"*) ;;
    *)
      echo "refusing ${DEPLOY_ENVIRONMENT} deploy to ${host}; allowed hosts: ${allowed}" >&2
      exit 1
      ;;
  esac
}

setup_ssh() {
  require_host
  validate_target_host
  mkdir -p "${HOME}/.ssh"
  chmod 700 "${HOME}/.ssh"
  if [ -n "${SSH_PRIVATE_KEY}" ]; then
    printf '%s\n' "${SSH_PRIVATE_KEY}" > "${HOME}/.ssh/octra_vitals_mainnet"
    chmod 600 "${HOME}/.ssh/octra_vitals_mainnet"
    cat >> "${HOME}/.ssh/config" <<EOF
Host *
  IdentityFile ${HOME}/.ssh/octra_vitals_mainnet
  IdentitiesOnly yes
EOF
    chmod 600 "${HOME}/.ssh/config"
    export GIT_SSH_COMMAND="ssh -i ${HOME}/.ssh/octra_vitals_mainnet -o IdentitiesOnly=yes"
  fi
  if [ -n "${SSH_KNOWN_HOSTS_B64}" ]; then
    printf '%s' "${SSH_KNOWN_HOSTS_B64}" | base64 -d >> "${HOME}/.ssh/known_hosts"
  elif [ -n "${SSH_HOST_KEY_LINE}" ]; then
    printf '%s\n' "${SSH_HOST_KEY_LINE}" >> "${HOME}/.ssh/known_hosts"
  elif [ "${DEPLOY_ENVIRONMENT}" = "mainnet" ] && is_write_action && [ "${DEPLOY_ALLOW_SSH_KEYSCAN:-0}" != "1" ]; then
    echo "refusing mainnet write action without pinned SSH host key; set DEPLOY_SSH_KNOWN_HOSTS_B64 or DEPLOY_SSH_HOST_KEY_LINE" >&2
    exit 1
  else
    ssh-keyscan -H "$(scan_host)" >> "${HOME}/.ssh/known_hosts" 2>/dev/null || true
  fi
  chmod 600 "${HOME}/.ssh/known_hosts"
}

run_local_verify() {
  npm run native:verify
}

require_deploy_confirmation() {
  local expected="DEPLOY OCTRA VITALS $(environment_label)"
  if [ "${CONFIRMATION}" != "${expected}" ]; then
    echo "refusing write action without confirmation: ${expected}" >&2
    exit 1
  fi
}

is_write_action() {
  case "${ACTION}" in
    push_release|deploy_programmed_circle|configure_runtime|publish_assets|submit_snapshot|enable_timers|full_cutover)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

default_gateway_url() {
  if [ -n "${DEPLOY_GATEWAY_URL:-}" ]; then
    printf '%s' "${DEPLOY_GATEWAY_URL}"
  elif [ "${DEPLOY_ENVIRONMENT}" = "mainnet" ]; then
    printf '%s' "https://octra.live"
  else
    printf '%s' "https://devnet.octra.live"
  fi
}

require_devnet_rehearsal_for_mainnet() {
  if [ "${DEPLOY_ENVIRONMENT}" != "mainnet" ] || ! is_write_action; then
    return
  fi
  if [ "${DEPLOY_ALLOW_MAINNET_WITHOUT_DEVNET_REHEARSAL:-0}" = "1" ]; then
    echo "warning: bypassing devnet rehearsal gate for mainnet write action" >&2
    return
  fi

  local expected="DEVNET REHEARSAL PASSED FOR OCTRA VITALS MAINNET"
  if [ "${DEVNET_REHEARSAL_ACK}" != "${expected}" ]; then
    echo "refusing mainnet write action without devnet rehearsal acknowledgement: ${expected}" >&2
    exit 1
  fi
  if [ -z "${DEVNET_REHEARSAL_REPORT_B64}" ]; then
    echo "refusing mainnet write action without DEPLOY_DEVNET_REHEARSAL_REPORT_B64" >&2
    exit 1
  fi

  local tmp current_commit
  tmp="$(mktemp)"
  printf '%s' "${DEVNET_REHEARSAL_REPORT_B64}" | base64 -d > "${tmp}"
  current_commit="$(git rev-parse HEAD)"

  node - <<'NODE' "${tmp}" "${current_commit}" "${DEVNET_REHEARSAL_MAX_AGE_HOURS}" "${DEPLOY_DEVNET_REHEARSAL_ALLOW_COMMIT_MISMATCH:-0}" "${DEVNET_REHEARSAL_ALLOWED_HOSTS}"
const fs = require("fs");
const [path, currentCommit, maxAgeHoursRaw, allowCommitMismatch, allowedHostsRaw] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(path, "utf8"));
const failures = [];
const maxAgeHours = Number(maxAgeHoursRaw);
const allowedHosts = String(allowedHostsRaw || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
function fail(message) { failures.push(message); }
function hostAllowed(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return allowedHosts.includes(host);
  } catch {
    return false;
  }
}
if (report.schema !== "octra-vitals-devnet-rehearsal-report-v0") fail(`unexpected rehearsal report schema: ${report.schema}`);
if (report.status !== "passed") fail(`rehearsal report did not pass: ${report.status}`);
if (!hostAllowed(report.gateway_url || report.summary?.gateway_url || "")) fail(`rehearsal report gateway is not allowlisted: ${report.gateway_url || report.summary?.gateway_url || ""}`);
if (report.local_native_verify !== "passed") fail("local native verification was not recorded as passed");
if (!report.generated_at || Number.isNaN(Date.parse(report.generated_at))) {
  fail("rehearsal report generated_at is missing or invalid");
} else if (Number.isFinite(maxAgeHours) && maxAgeHours > 0) {
  const ageMs = Date.now() - Date.parse(report.generated_at);
  if (ageMs < 0 || ageMs > maxAgeHours * 60 * 60 * 1000) fail(`rehearsal report is older than ${maxAgeHours}h`);
}
if (allowCommitMismatch !== "1" && report.git_commit !== currentCommit) {
  fail(`rehearsal commit ${report.git_commit} does not match current commit ${currentCommit}`);
}
if (allowCommitMismatch !== "1" && report.summary?.version_release_git_commit !== currentCommit) {
  fail(`deployed rehearsal release ${report.summary?.version_release_git_commit} does not match current commit ${currentCommit}`);
}
if (report.summary?.version_release_git_dirty !== false) {
  fail(`deployed rehearsal release dirty flag is not clean: ${report.summary?.version_release_git_dirty}`);
}
const checks = Array.isArray(report.checks) ? report.checks : [];
for (const required of [
  "gateway_host_allowlisted",
  "deployed_release_matches_local",
  "latest_serves_program_data",
  "latest_is_fresh",
  "latest_is_canonical_state_read",
  "history_is_anchored_or_canonical",
  "history_has_required_coverage",
  "site_integrity_verified",
  "native_readiness_ready",
  "programmed_circle_runtime"
]) {
  const item = checks.find((check) => check.id === required);
  if (!item || item.ok !== true) fail(`rehearsal check failed or missing: ${required}`);
}
if (report.summary?.readiness_state_target_mode !== "circle_program") fail("rehearsal did not use circle_program runtime");
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(2);
}
console.log(`devnet rehearsal gate accepted: ${report.gateway_url} at ${report.generated_at}`);
NODE
  rm -f "${tmp}"
}

install_updater_env() {
  if [ -z "${UPDATER_ENV_B64}" ]; then
    echo "DEPLOY_UPDATER_ENV_B64 not set; using existing /etc/octra-vitals/updater.env on host"
    return
  fi
  local remote
  remote="$(remote_target)"
  local tmp
  tmp="$(mktemp)"
  printf '%s' "${UPDATER_ENV_B64}" | base64 -d > "${tmp}"
  scp "${tmp}" "${remote}:/tmp/octra-vitals-updater.env"
  rm -f "${tmp}"
  ssh "${remote}" "sudo install -m 600 -o root -g root /tmp/octra-vitals-updater.env /etc/octra-vitals/updater.env && rm -f /tmp/octra-vitals-updater.env"
}

push_release() {
  local remote
  remote="$(remote_target)"
  bash deploy/mainnet/push-release.sh "${remote}"
}

plan_release() {
  DEPLOY_GATEWAY_URL="$(default_gateway_url)" bash deploy/mainnet/plan-release.sh
}

deploy_programmed_circle() {
  local remote
  remote="$(remote_target)"
  local env_args app_root_q data_dir_q script_q value_q
  printf -v app_root_q "%q" "${APP_ROOT}"
  printf -v data_dir_q "%q" "${DATA_DIR}"
  printf -v script_q "%q" "${APP_ROOT}/current/deploy/mainnet/deploy-programmed-circle.sh"
  env_args="APP_ROOT=${app_root_q} VITALS_DATA_DIR=${data_dir_q}"
  if [ -n "${PROGRAMMED_CIRCLE_PROGRAM}" ]; then
    printf -v value_q "%q" "${PROGRAMMED_CIRCLE_PROGRAM}"
    env_args="${env_args} VITALS_PROGRAMMED_CIRCLE_PROGRAM=${value_q}"
  fi
  if [ -n "${RECORD_SNAPSHOT_VERSION}" ]; then
    printf -v value_q "%q" "${RECORD_SNAPSHOT_VERSION}"
    env_args="${env_args} VITALS_RECORD_SNAPSHOT_VERSION=${value_q}"
  fi
  if [ -n "${PROGRAMMED_CIRCLE_ARTIFACT_DIR}" ]; then
    printf -v value_q "%q" "${PROGRAMMED_CIRCLE_ARTIFACT_DIR}"
    env_args="${env_args} VITALS_PROGRAMMED_CIRCLE_ARTIFACT_DIR=${value_q}"
  fi
  if [ -n "${FACT_LEDGER_NETWORK_ID}" ]; then
    printf -v value_q "%q" "${FACT_LEDGER_NETWORK_ID}"
    env_args="${env_args} VITALS_FACT_LEDGER_NETWORK_ID=${value_q}"
  fi
  if [ -n "${FACT_LEDGER_PREDECESSOR_PROGRAM}" ]; then
    printf -v value_q "%q" "${FACT_LEDGER_PREDECESSOR_PROGRAM}"
    env_args="${env_args} VITALS_FACT_LEDGER_PREDECESSOR_PROGRAM=${value_q}"
  fi
  if [ -n "${FACT_LEDGER_PREDECESSOR_FINAL_INDEX}" ]; then
    printf -v value_q "%q" "${FACT_LEDGER_PREDECESSOR_FINAL_INDEX}"
    env_args="${env_args} VITALS_FACT_LEDGER_PREDECESSOR_FINAL_INDEX=${value_q}"
  fi
  if [ -n "${FACT_LEDGER_PREDECESSOR_FINAL_ROOT}" ]; then
    printf -v value_q "%q" "${FACT_LEDGER_PREDECESSOR_FINAL_ROOT}"
    env_args="${env_args} VITALS_FACT_LEDGER_PREDECESSOR_FINAL_ROOT=${value_q}"
  fi
  ssh "${remote}" "sudo env ${env_args} bash ${script_q}"
}

configure_runtime() {
  local remote port
  remote="$(remote_target)"
  printf -v port "%q" "${GATEWAY_PORT}"
  ssh "${remote}" "sudo env PORT=${port} bash ${APP_ROOT}/current/deploy/mainnet/configure-programmed-circle.sh"
}

publish_assets() {
  local remote
  remote="$(remote_target)"
  ssh "${remote}" "sudo bash ${APP_ROOT}/current/deploy/mainnet/publish-programmed-site-assets.sh"
}

submit_snapshot() {
  local remote
  remote="$(remote_target)"
  ssh "${remote}" "sudo bash ${APP_ROOT}/current/deploy/mainnet/submit-one-snapshot.sh"
}

verify_runtime() {
  local remote port
  remote="$(remote_target)"
  printf -v port "%q" "${GATEWAY_PORT}"
  ssh "${remote}" "PORT=${port} bash ${APP_ROOT}/current/deploy/mainnet/verify-runtime.sh"
}

enable_timers() {
  local expected="ENABLE OCTRA VITALS $(environment_label) TIMERS"
  if [ "${ENABLE_TIMERS_ACK}" != "${expected}" ]; then
    echo "refusing timer enable without ${expected}" >&2
    exit 1
  fi
  local remote
  remote="$(remote_target)"
  ssh "${remote}" "sudo env ENABLE_MAINNET_TIMERS_EXPECTED_ACK='${expected}' ENABLE_MAINNET_TIMERS_ACK='${expected}' bash ${APP_ROOT}/current/deploy/mainnet/enable-timers.sh"
}

setup_ssh
require_devnet_rehearsal_for_mainnet

case "${ACTION}" in
  verify_only)
    run_local_verify
    ;;
  plan_release)
    plan_release
    ;;
  push_release)
    require_deploy_confirmation
    push_release
    ;;
  deploy_programmed_circle)
    require_deploy_confirmation
    run_local_verify
    install_updater_env
    deploy_programmed_circle
    ;;
  configure_runtime)
    require_deploy_confirmation
    run_local_verify
    install_updater_env
    configure_runtime
    ;;
  publish_assets)
    require_deploy_confirmation
    run_local_verify
    publish_assets
    ;;
  submit_snapshot)
    require_deploy_confirmation
    run_local_verify
    submit_snapshot
    ;;
  verify_runtime)
    verify_runtime
    ;;
  enable_timers)
    require_deploy_confirmation
    run_local_verify
    enable_timers
    ;;
  full_cutover)
    require_deploy_confirmation
    run_local_verify
    push_release
    install_updater_env
    deploy_programmed_circle
    configure_runtime
    publish_assets
    submit_snapshot
    verify_runtime
    echo "full_cutover complete; timers remain disabled until the separate enable_timers action is acknowledged"
    ;;
  *)
    echo "unknown MAINNET_ACTION: ${ACTION}" >&2
    exit 1
    ;;
esac
