#!/usr/bin/env bash
set -euo pipefail

HOST="${1:?usage: deploy/mainnet/push-release.sh <host>}"
APP_ROOT="${APP_ROOT:-/opt/octra-vitals}"
DEPLOY_ENVIRONMENT="${DEPLOY_ENVIRONMENT:-mainnet}"
RELEASE_ID="${RELEASE_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
REMOTE_TMP="/tmp/octra-vitals-release-${RELEASE_ID}"
REMOTE_RELEASE="${APP_ROOT}/releases/${RELEASE_ID}"
PROGRAM_ARTIFACT_DIR="${VITALS_PROGRAMMED_CIRCLE_ARTIFACT_DIR:-program-fact-ledger}"
COMPILE_ARTIFACT="${VITALS_PROGRAMMED_CIRCLE_COMPILE_ARTIFACT:-build/${PROGRAM_ARTIFACT_DIR}/compile.json}"
PREVIOUS_COMPILE_ARTIFACT="${VITALS_PROGRAM_UPDATE_PREVIOUS_COMPILE_ARTIFACT:-build/${PROGRAM_ARTIFACT_DIR}/previous-approved-compile.json}"
RELEASE_GIT_COMMIT="${VITALS_RELEASE_GIT_COMMIT:-$(git rev-parse HEAD)}"
if [[ ! "${PROGRAM_ARTIFACT_DIR}" =~ ^[A-Za-z0-9._/-]+$ ]] || [[ "/${PROGRAM_ARTIFACT_DIR}/" == *"/../"* ]] || [[ "${PROGRAM_ARTIFACT_DIR}" == /* ]]; then
  echo "invalid VITALS_PROGRAMMED_CIRCLE_ARTIFACT_DIR: ${PROGRAM_ARTIFACT_DIR}" >&2
  exit 1
fi
if [ -z "$(git status --porcelain)" ]; then
  RELEASE_GIT_DIRTY="${VITALS_RELEASE_GIT_DIRTY:-0}"
else
  RELEASE_GIT_DIRTY="${VITALS_RELEASE_GIT_DIRTY:-1}"
fi

if [ "${SKIP_LOCAL_VERIFY:-0}" != "1" ]; then
  npm run native:verify
fi
if [ ! -s "${COMPILE_ARTIFACT}" ]; then
  echo "missing promoted AML compile artifact: ${COMPILE_ARTIFACT}" >&2
  exit 1
fi
npm run program:compile:artifact:dist

rsync -az --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude dist \
  --exclude build \
  --exclude data \
  --exclude reports \
  --exclude app/producer.audit.json \
  ./ "${HOST}:${REMOTE_TMP}/"

quote() {
  printf "%q" "$1"
}

ssh "${HOST}" "mkdir -p $(quote "${REMOTE_TMP}/build/${PROGRAM_ARTIFACT_DIR}")"
rsync -az "${COMPILE_ARTIFACT}" "${HOST}:${REMOTE_TMP}/build/${PROGRAM_ARTIFACT_DIR}/compile.json"
if [ -s "${PREVIOUS_COMPILE_ARTIFACT}" ]; then
  rsync -az "${PREVIOUS_COMPILE_ARTIFACT}" "${HOST}:${REMOTE_TMP}/build/${PROGRAM_ARTIFACT_DIR}/previous-approved-compile.json"
fi

ssh "${HOST}" "REMOTE_TMP=$(quote "${REMOTE_TMP}") REMOTE_RELEASE=$(quote "${REMOTE_RELEASE}") APP_ROOT=$(quote "${APP_ROOT}") DEPLOY_ENVIRONMENT=$(quote "${DEPLOY_ENVIRONMENT}") VITALS_RELEASE_GIT_COMMIT=$(quote "${RELEASE_GIT_COMMIT}") VITALS_RELEASE_GIT_DIRTY=$(quote "${RELEASE_GIT_DIRTY}") VITALS_SINGLE_COMPILER_RPC_MAINNET_ACK=$(quote "${VITALS_SINGLE_COMPILER_RPC_MAINNET_ACK:-}") bash -se" <<'REMOTE'
  set -euo pipefail
  cd "${REMOTE_TMP}"
  . deploy/lib/env-file.sh
  bash deploy/mainnet/bootstrap-host.sh
  if sudo test -r /etc/octra-vitals/gateway.env; then
    gateway_env_copy="$(mktemp)"
    trap 'rm -f "${gateway_env_copy:-}"' EXIT
    sudo cat /etc/octra-vitals/gateway.env > "${gateway_env_copy}"
    chmod 600 "${gateway_env_copy}"
    load_env_file_data "${gateway_env_copy}"
  fi
  npm ci
  npm run build
  npm run program:compile:artifact:dist
  npm run producer:audit:dist
  node dist/scripts/build-site-circle-release.js
  if [ -n "${VITALS_LAB_SITE_CIRCLE_ID:-}" ]; then
    node dist/scripts/build-site-circle-release.js --lab
  fi
  sudo rm -rf "${REMOTE_RELEASE}"
  sudo mkdir -p "${REMOTE_RELEASE}"
  sudo rsync -a --delete "${REMOTE_TMP}/" "${REMOTE_RELEASE}/"
  sudo chown -R root:root "${REMOTE_RELEASE}"
  sudo ln -sfn "${REMOTE_RELEASE}" "${APP_ROOT}/current"
  sudo systemctl daemon-reload
  rm -rf "${REMOTE_TMP}"
  echo "${REMOTE_RELEASE}"
REMOTE
