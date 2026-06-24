#!/usr/bin/env bash
set -euo pipefail

APP_USER="${APP_USER:-octra-vitals}"
APP_OPERATOR_USER="${APP_OPERATOR_USER:-octra-vitals-operator}"
DATA_DIR="${VITALS_DATA_DIR:-/var/lib/octra-vitals}"
ENV_DIR="${ENV_DIR:-/etc/octra-vitals}"
PRIVATE_ENV="${PRIVATE_ENV:-}"
REPORT="${PROGRAMMED_CIRCLE_REPORT:-${DATA_DIR}/programmed-circle-deploy.json}"
GATEWAY_ROLE="${VITALS_GATEWAY_ROLE:-production}"
GATEWAY_HOST="${HOST:-127.0.0.1}"
GATEWAY_PORT="${PORT:-8000}"
STATIC_ASSET_SOURCE="${VITALS_STATIC_ASSET_SOURCE:-circle_required}"
STATE_SOURCE_MODE="${VITALS_STATE_SOURCE_MODE:-program_required}"
SUBMIT_DEFAULT="${VITALS_SUBMIT:-0}"

if [ ! -f "${REPORT}" ]; then
  echo "missing programmed Circle deploy report: ${REPORT}" >&2
  exit 1
fi

if ! id "${APP_USER}" >/dev/null 2>&1; then
  echo "missing app user: ${APP_USER}" >&2
  exit 1
fi
if ! id "${APP_OPERATOR_USER}" >/dev/null 2>&1; then
  sudo useradd --system --no-create-home --shell /usr/sbin/nologin --gid "${APP_USER}" "${APP_OPERATOR_USER}"
else
  sudo usermod -a -G "${APP_USER}" "${APP_OPERATOR_USER}"
fi

updater_env="${ENV_DIR}/updater.env"
gateway_env="${ENV_DIR}/gateway.env"
watchdog_env="${ENV_DIR}/watchdog.env"

if [ -n "${PRIVATE_ENV}" ]; then
  if [ ! -f "${PRIVATE_ENV}" ]; then
    echo "missing private updater env: ${PRIVATE_ENV}" >&2
    exit 1
  fi
  sudo install -m 600 -o root -g root "${PRIVATE_ENV}" "${updater_env}"
elif [ ! -s "${updater_env}" ]; then
  echo "missing updater env: ${updater_env}; install it before configuring runtime" >&2
  exit 1
fi

circle_id="$(node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(r.circle_id || "")' "${REPORT}")"
caller="$(node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(r.env_next?.VITALS_CIRCLE_VIEW_CALLER_ADDRESS || r.deployer_address || "")' "${REPORT}")"
operator="$(node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(r.operator_address || "")' "${REPORT}")"
program_kind="$(node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(r.program_kind || "")' "${REPORT}")"
artifact_dir="$(node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(r.env_next?.VITALS_PROGRAMMED_CIRCLE_ARTIFACT_DIR || r.artifact_dir || "")' "${REPORT}")"
record_version="$(node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(r.env_next?.VITALS_RECORD_SNAPSHOT_VERSION || "")' "${REPORT}")"
fact_ack="$(node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(r.env_next?.VITALS_FACT_LEDGER_CUTOVER_ACK || "")' "${REPORT}")"
fact_network="$(node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(r.env_next?.VITALS_FACT_LEDGER_NETWORK_ID || "")' "${REPORT}")"
fact_source_hash="$(node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(r.env_next?.VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_SOURCE_HASH || "")' "${REPORT}")"
fact_bytecode_hash="$(node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(r.env_next?.VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_BYTECODE_HASH || "")' "${REPORT}")"
fact_verification_hash="$(node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(r.env_next?.VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_VERIFICATION_HASH || "")' "${REPORT}")"

if [ -z "${circle_id}" ] || [ "${circle_id}" = "pending" ]; then
  echo "programmed Circle id missing from ${REPORT}" >&2
  exit 1
fi
if [ -z "${caller}" ] || [ "${caller}" = "pending" ]; then
  echo "Circle view caller missing from ${REPORT}" >&2
  exit 1
fi
if [ -z "${operator}" ] || [ "${operator}" = "pending" ]; then
  echo "Circle operator missing from ${REPORT}" >&2
  exit 1
fi

set_env() {
  file="$1"
  key="$2"
  value="$3"
  mode="${4:-640}"
  group="${5:-${APP_USER}}"
  tmp="$(mktemp)"
  sudo awk -F= -v key="${key}" '$1 != key { print }' "${file}" > "${tmp}"
  printf '%s=%s\n' "${key}" "${value}" >> "${tmp}"
  sudo install -m "${mode}" -o root -g "${group}" "${tmp}" "${file}"
  rm -f "${tmp}"
}

set_env "${updater_env}" VITALS_GATEWAY_ROLE "${GATEWAY_ROLE}" 600 root
set_env "${updater_env}" VITALS_DATA_DIR "${DATA_DIR}" 600 root
set_env "${updater_env}" VITALS_STATE_SOURCE_MODE "${STATE_SOURCE_MODE}" 600 root
set_env "${updater_env}" VITALS_STATE_TARGET_MODE circle_program 600 root
set_env "${updater_env}" VITALS_PROGRAMMED_CIRCLE_ID "${circle_id}" 600 root
set_env "${updater_env}" VITALS_CIRCLE_VIEW_CALLER_ADDRESS "${caller}" 600 root
set_env "${updater_env}" VITALS_CIRCLE_OWNER_ADDRESS "${caller}" 600 root
set_env "${updater_env}" VITALS_CIRCLE_OPERATOR_ADDRESS "${operator}" 600 root
set_env "${updater_env}" VITALS_SITE_CIRCLE_ID "${circle_id}" 600 root
set_env "${updater_env}" VITALS_STATIC_ASSET_SOURCE "${STATIC_ASSET_SOURCE}" 600 root
set_env "${updater_env}" VITALS_SUBMIT "${SUBMIT_DEFAULT}" 600 root
if [ "${program_kind}" = "fact-ledger" ]; then
  set_env "${updater_env}" VITALS_PROGRAMMED_CIRCLE_PROGRAM fact-ledger 600 root
  set_env "${updater_env}" VITALS_PROGRAMMED_CIRCLE_ARTIFACT_DIR "${artifact_dir:-program-fact-ledger}" 600 root
  set_env "${updater_env}" VITALS_RECORD_SNAPSHOT_VERSION "${record_version:-fact-v1}" 600 root
  set_env "${updater_env}" VITALS_FACT_LEDGER_CUTOVER_ACK "${fact_ack}" 600 root
  set_env "${updater_env}" VITALS_FACT_LEDGER_NETWORK_ID "${fact_network}" 600 root
  set_env "${updater_env}" VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_SOURCE_HASH "${fact_source_hash}" 600 root
  set_env "${updater_env}" VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_BYTECODE_HASH "${fact_bytecode_hash}" 600 root
  set_env "${updater_env}" VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_VERIFICATION_HASH "${fact_verification_hash}" 600 root
fi
sudo install -d -m 770 -o "${APP_USER}" -g "${APP_USER}" "${DATA_DIR}/watchdog"

tmp_gateway="$(mktemp)"
for key in ETH_RPC_URL OCTRA_OBSERVATION_RPC_URL OCTRA_PROGRAM_RPC_URL OCTRA_PROGRAM_RPC_URLS RELAYER_URL VITALS_APP_VERSION VITALS_GATEWAY_ORIGIN VITALS_CORS_ALLOW_ORIGIN VITALS_OCTRA_SCAN_ADDRESS_URL VITALS_OCTRA_SCAN_TX_URL OCTRA_SCAN_ADDRESS_URL OCTRA_SCAN_TX_URL; do
  value="$(sudo grep -E "^${key}=" "${updater_env}" | tail -n1 | cut -d= -f2- || true)"
  if [ -n "${value}" ]; then
    printf '%s=%s\n' "${key}" "${value}" >> "${tmp_gateway}"
  fi
done
gateway_value() {
  key="$1"
  fallback="$2"
  value="${!key:-}"
  if [ -z "${value}" ] && [ -f "${gateway_env}" ]; then
    value="$(sudo grep -E "^${key}=" "${gateway_env}" | tail -n1 | cut -d= -f2- || true)"
  fi
  printf '%s' "${value:-${fallback}}"
}
cat >> "${tmp_gateway}" <<EOF
HOST=${GATEWAY_HOST}
PORT=${GATEWAY_PORT}
VITALS_GATEWAY_ROLE=${GATEWAY_ROLE}
VITALS_DATA_DIR=${DATA_DIR}
VITALS_STATE_SOURCE_MODE=${STATE_SOURCE_MODE}
VITALS_STATE_TARGET_MODE=circle_program
VITALS_PROGRAMMED_CIRCLE_ID=${circle_id}
VITALS_CIRCLE_VIEW_CALLER_ADDRESS=${caller}
VITALS_CIRCLE_OWNER_ADDRESS=${caller}
VITALS_CIRCLE_OPERATOR_ADDRESS=${operator}
VITALS_SITE_CIRCLE_ID=${circle_id}
VITALS_STATIC_ASSET_SOURCE=${STATIC_ASSET_SOURCE}
VITALS_EXPOSE_ERRORS=0
VITALS_EXPOSE_PROGRAM_ARTIFACTS=0
VITALS_SUBMIT=0
VITALS_TRAFFIC_AGGREGATES=$(gateway_value VITALS_TRAFFIC_AGGREGATES 1)
VITALS_TRAFFIC_DIR=$(gateway_value VITALS_TRAFFIC_DIR "${DATA_DIR}/traffic")
VITALS_TRAFFIC_CLIENT_MODE=$(gateway_value VITALS_TRAFFIC_CLIENT_MODE daily_hash)
VITALS_TRAFFIC_TRUST_PROXY_HEADERS=$(gateway_value VITALS_TRAFFIC_TRUST_PROXY_HEADERS 1)
VITALS_TRAFFIC_FLUSH_MS=$(gateway_value VITALS_TRAFFIC_FLUSH_MS 2000)
VITALS_TRAFFIC_DIAGNOSTIC_PATH_LIMIT=$(gateway_value VITALS_TRAFFIC_DIAGNOSTIC_PATH_LIMIT 100)
EOF
if [ "${program_kind}" = "fact-ledger" ]; then
  cat >> "${tmp_gateway}" <<EOF
VITALS_PROGRAMMED_CIRCLE_PROGRAM=fact-ledger
VITALS_PROGRAMMED_CIRCLE_ARTIFACT_DIR=${artifact_dir:-program-fact-ledger}
VITALS_RECORD_SNAPSHOT_VERSION=${record_version:-fact-v1}
VITALS_FACT_LEDGER_NETWORK_ID=${fact_network}
VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_SOURCE_HASH=${fact_source_hash}
VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_BYTECODE_HASH=${fact_bytecode_hash}
VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_VERIFICATION_HASH=${fact_verification_hash}
EOF
fi
sudo install -m 640 -o root -g "${APP_USER}" "${tmp_gateway}" "${gateway_env}"
rm -f "${tmp_gateway}"

tmp_watchdog="$(mktemp)"
cat >> "${tmp_watchdog}" <<EOF
VITALS_WATCH_DATA_DIR=${DATA_DIR}
VITALS_WATCH_GATEWAY_URL=http://127.0.0.1:${GATEWAY_PORT}
VITALS_WATCH_UPDATER_TIMER=octra-vitals-updater.timer
VITALS_WATCH_UPDATER_SERVICE=octra-vitals-updater.service
VITALS_WATCH_GATEWAY_SERVICE=octra-vitals-gateway.service
VITALS_WATCH_MAX_RECEIPT_AGE_MS=2700000
VITALS_WATCH_REQUEST_TIMEOUT_MS=30000
VITALS_WATCH_RECOVERY_ENABLED=0
EOF
sudo install -m 640 -o root -g "${APP_USER}" "${tmp_watchdog}" "${watchdog_env}"
rm -f "${tmp_watchdog}"

sudo chown root:root "${updater_env}"
sudo chmod 600 "${updater_env}"
sudo chown root:"${APP_USER}" "${gateway_env}" "${watchdog_env}"
sudo chmod 640 "${gateway_env}" "${watchdog_env}"

if [ "${VITALS_DISABLE_PARKING_SERVICE_ON_CUTOVER:-1}" = "1" ] && systemctl list-unit-files octra-vitals-parking.service >/dev/null 2>&1; then
  sudo systemctl disable --now octra-vitals-parking.service >/dev/null 2>&1 || sudo systemctl stop octra-vitals-parking.service >/dev/null 2>&1 || true
fi

cat <<EOF
configured programmed Circle runtime
circle_id=${circle_id}
caller=${caller}
operator=${operator}
gateway_port=${GATEWAY_PORT}
static_asset_source=${STATIC_ASSET_SOURCE}
updater_submit_default=${SUBMIT_DEFAULT}
watchdog_url=http://127.0.0.1:${GATEWAY_PORT}
EOF
