#!/usr/bin/env bash
set -euo pipefail

APP_USER="${APP_USER:-octra-vitals}"
APP_OPERATOR_USER="${APP_OPERATOR_USER:-octra-vitals-operator}"
APP_ROOT="${APP_ROOT:-/opt/octra-vitals}"
ENV_DIR="${ENV_DIR:-/etc/octra-vitals}"
CURRENT="${APP_ROOT}/current"
SUBMIT_ENV=""

cleanup() {
  rm -f "${SUBMIT_ENV:-}"
}
trap cleanup EXIT

if [ "$(id -u)" -ne 0 ]; then
  echo "submit-one-snapshot.sh must run as root so updater.env can stay root-only" >&2
  exit 1
fi
if ! id "${APP_OPERATOR_USER}" >/dev/null 2>&1; then
  echo "missing operator user: ${APP_OPERATOR_USER}; run bootstrap-host.sh first" >&2
  exit 1
fi
if [ ! -s "${ENV_DIR}/updater.env" ]; then
  echo "missing updater env: ${ENV_DIR}/updater.env" >&2
  exit 1
fi

cd "${CURRENT}"

SUBMIT_ENV="$(mktemp)"
cp "${ENV_DIR}/updater.env" "${SUBMIT_ENV}"
chown "${APP_OPERATOR_USER}:${APP_OPERATOR_USER}" "${SUBMIT_ENV}"
chmod 600 "${SUBMIT_ENV}"

sudo -u "${APP_OPERATOR_USER}" env -i \
  PATH="/usr/local/bin:/usr/bin:/bin" \
  HOME="${VITALS_DATA_DIR:-/var/lib/octra-vitals}" \
  bash --noprofile --norc -c '
  set -euo pipefail
  cd "$1"
  . deploy/lib/env-file.sh
  load_env_file_data "$2"
  export VITALS_SUBMIT=1
  node dist/scripts/run-snapshot-update.js
' bash "${CURRENT}" "${SUBMIT_ENV}"
