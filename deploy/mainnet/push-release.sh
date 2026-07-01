#!/usr/bin/env bash
set -euo pipefail

HOST="${1:?usage: deploy/mainnet/push-release.sh <host>}"
APP_ROOT="${APP_ROOT:-/opt/octra-vitals}"
RELEASE_ID="${RELEASE_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
REMOTE_TMP="/tmp/octra-vitals-release-${RELEASE_ID}"
REMOTE_RELEASE="${APP_ROOT}/releases/${RELEASE_ID}"
RELEASE_GIT_COMMIT="${VITALS_RELEASE_GIT_COMMIT:-$(git rev-parse HEAD)}"
if [ -z "$(git status --porcelain)" ]; then
  RELEASE_GIT_DIRTY="${VITALS_RELEASE_GIT_DIRTY:-0}"
else
  RELEASE_GIT_DIRTY="${VITALS_RELEASE_GIT_DIRTY:-1}"
fi

if [ "${SKIP_LOCAL_VERIFY:-0}" != "1" ]; then
  npm run native:verify
fi

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

ssh "${HOST}" "REMOTE_TMP=$(quote "${REMOTE_TMP}") REMOTE_RELEASE=$(quote "${REMOTE_RELEASE}") APP_ROOT=$(quote "${APP_ROOT}") VITALS_RELEASE_GIT_COMMIT=$(quote "${RELEASE_GIT_COMMIT}") VITALS_RELEASE_GIT_DIRTY=$(quote "${RELEASE_GIT_DIRTY}") bash -se" <<'REMOTE'
  set -euo pipefail
  cd "${REMOTE_TMP}"
  bash deploy/mainnet/bootstrap-host.sh
  if sudo test -r /etc/octra-vitals/gateway.env; then
    set -a
    . <(sudo sed -n '/^[A-Za-z_][A-Za-z0-9_]*=/p' /etc/octra-vitals/gateway.env)
    set +a
  fi
  npm ci
  npm run build
  npm run program-circle:compile
  npm run program-circle:verify
  npm run fact-ledger-probe:compile
  npm run fact-ledger-program:compile
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
