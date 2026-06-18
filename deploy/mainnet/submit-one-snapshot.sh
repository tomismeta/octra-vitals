#!/usr/bin/env bash
set -euo pipefail

APP_USER="${APP_USER:-octra-vitals}"
APP_OPERATOR_USER="${APP_OPERATOR_USER:-octra-vitals-operator}"
APP_ROOT="${APP_ROOT:-/opt/octra-vitals}"
ENV_DIR="${ENV_DIR:-/etc/octra-vitals}"
CURRENT="${APP_ROOT}/current"

if [ "$(id -u)" -ne 0 ]; then
  echo "submit-one-snapshot.sh must run as root so updater.env can stay root-only" >&2
  exit 1
fi

cd "${CURRENT}"

set -a
. "${ENV_DIR}/updater.env"
set +a
export VITALS_SUBMIT=1

sudo --preserve-env -u "${APP_OPERATOR_USER}" env HOME="${VITALS_DATA_DIR:-/var/lib/octra-vitals}" bash --noprofile --norc -lc "
  set -euo pipefail
  cd '${CURRENT}'
  npm run program:update:dist
"
