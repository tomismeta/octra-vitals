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
sudo -u "${APP_OPERATOR_USER}" env -i \
  PATH="/usr/local/bin:/usr/bin:/bin" \
  HOME="${VITALS_DATA_DIR:-/var/lib/octra-vitals}" \
  bash --noprofile --norc -c "
  set -euo pipefail
  cd '${CURRENT}'
  . deploy/lib/env-file.sh
  load_env_file_data /dev/stdin
  export VITALS_SUBMIT=1
  node dist/scripts/run-snapshot-update.js
" < "${ENV_DIR}/updater.env"
