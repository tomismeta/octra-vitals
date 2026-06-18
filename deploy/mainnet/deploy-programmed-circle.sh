#!/usr/bin/env bash
set -euo pipefail

APP_OPERATOR_USER="${APP_OPERATOR_USER:-octra-vitals-operator}"
APP_ROOT="${APP_ROOT:-/opt/octra-vitals}"
DATA_DIR_DEFAULT="${VITALS_DATA_DIR:-/var/lib/octra-vitals}"
ENV_DIR="${ENV_DIR:-/etc/octra-vitals}"
CURRENT="${APP_ROOT}/current"

if [ "$(id -u)" -ne 0 ]; then
  echo "deploy-programmed-circle.sh must run as root so updater.env can stay root-only" >&2
  exit 1
fi

if [ ! -s "${ENV_DIR}/updater.env" ]; then
  echo "missing updater env: ${ENV_DIR}/updater.env" >&2
  exit 1
fi

cd "${CURRENT}"

set -a
. "${ENV_DIR}/updater.env"
set +a
DATA_DIR="${VITALS_DATA_DIR:-${DATA_DIR_DEFAULT}}"
REPORT="${PROGRAMMED_CIRCLE_REPORT:-${DATA_DIR}/programmed-circle-deploy.json}"
export VITALS_DEPLOY_PROGRAMMED_CIRCLE=1
export VITALS_DEPLOY_PROGRAMMED_CIRCLE_ACK=1

sudo --preserve-env -u "${APP_OPERATOR_USER}" env HOME="${DATA_DIR}" bash --noprofile --norc -lc "
  set -euo pipefail
  cd '${CURRENT}'
  npm run circle:programmed:deploy:dist -- '${REPORT}'
"
