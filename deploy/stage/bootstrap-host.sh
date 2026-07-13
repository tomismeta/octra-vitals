#!/usr/bin/env bash
set -euo pipefail

APP_USER="${APP_USER:-octra-vitals}"
APP_OPERATOR_USER="${APP_OPERATOR_USER:-octra-vitals-operator}"
APP_OWNER_USER="${APP_OWNER_USER:-octra-vitals-owner}"
APP_NOTIFY_USER="${APP_NOTIFY_USER:-octra-vitals-notify}"
APP_WATCHDOG_USER="${APP_WATCHDOG_USER:-octra-vitals-watchdog}"
APP_ROOT="${APP_ROOT:-/opt/octra-vitals}"
DATA_DIR="${VITALS_DATA_DIR:-/var/lib/octra-vitals}"
GATEWAY_DATA_DIR="${VITALS_GATEWAY_DATA_DIR:-/var/lib/octra-vitals-gateway}"
OPERATOR_DATA_DIR="${VITALS_OPERATOR_DATA_DIR:-/var/lib/octra-vitals-operator}"
OWNER_DATA_DIR="${VITALS_OWNER_DATA_DIR:-/var/lib/octra-vitals-owner}"
NOTIFY_DATA_DIR="${VITALS_NOTIFY_STATE_DIR:-/var/lib/octra-vitals-notify}"
WATCHDOG_DATA_DIR="${VITALS_WATCHDOG_STATE_DIR:-/var/lib/octra-vitals-watchdog}"
ENV_DIR="${ENV_DIR:-/etc/octra-vitals}"

sudo apt-get update
sudo apt-get install -y ca-certificates curl git rsync nodejs npm
node -e 'const major = Number(process.versions.node.split(".")[0]); if (major < 22) { console.error(`Node 22+ is required; found ${process.version}. Install Node 22 before continuing.`); process.exit(1); }'

if ! getent group "${APP_USER}" >/dev/null 2>&1; then
  sudo groupadd --system "${APP_USER}"
fi
if ! id "${APP_USER}" >/dev/null 2>&1; then
  sudo useradd --system --no-create-home --shell /usr/sbin/nologin --gid "${APP_USER}" "${APP_USER}"
fi
if ! getent group "${APP_OWNER_USER}" >/dev/null 2>&1; then
  sudo groupadd --system "${APP_OWNER_USER}"
fi
if ! id "${APP_OWNER_USER}" >/dev/null 2>&1; then
  sudo useradd --system --no-create-home --shell /usr/sbin/nologin --gid "${APP_OWNER_USER}" "${APP_OWNER_USER}"
fi
if ! id "${APP_OPERATOR_USER}" >/dev/null 2>&1; then
  sudo useradd --system --no-create-home --shell /usr/sbin/nologin --gid "${APP_USER}" "${APP_OPERATOR_USER}"
else
  sudo usermod -a -G "${APP_USER}" "${APP_OPERATOR_USER}"
fi
for service_user in "${APP_NOTIFY_USER}" "${APP_WATCHDOG_USER}"; do
  if ! getent group "${service_user}" >/dev/null 2>&1; then
    sudo groupadd --system "${service_user}"
  fi
  if ! id "${service_user}" >/dev/null 2>&1; then
    sudo useradd --system --no-create-home --shell /usr/sbin/nologin --gid "${service_user}" "${service_user}"
  fi
  sudo usermod -a -G "${APP_USER}" "${service_user}"
done

sudo install -d -m 755 -o root -g root "${APP_ROOT}" "${APP_ROOT}/releases"
sudo install -d -m 750 -o "${APP_OPERATOR_USER}" -g "${APP_USER}" "${DATA_DIR}" "${DATA_DIR}/lab-history-trigger"
sudo install -d -m 710 -o "${APP_USER}" -g "${APP_USER}" "${GATEWAY_DATA_DIR}"
sudo install -d -m 750 -o "${APP_USER}" -g "${APP_USER}" "${GATEWAY_DATA_DIR}/traffic"
sudo install -d -m 700 -o "${APP_OPERATOR_USER}" -g "${APP_USER}" "${OPERATOR_DATA_DIR}"
sudo install -d -m 700 -o "${APP_OWNER_USER}" -g "${APP_OWNER_USER}" "${OWNER_DATA_DIR}"
sudo install -d -m 700 -o "${APP_NOTIFY_USER}" -g "${APP_NOTIFY_USER}" "${NOTIFY_DATA_DIR}"
sudo install -d -m 700 -o "${APP_WATCHDOG_USER}" -g "${APP_WATCHDOG_USER}" "${WATCHDOG_DATA_DIR}"
sudo chown -R "${APP_OPERATOR_USER}:${APP_USER}" "${DATA_DIR}"
sudo find "${DATA_DIR}" -xdev -type d -exec chmod g-w,o-rwx {} +
sudo find "${DATA_DIR}" -xdev -type f -exec chmod g-w,o-rwx {} +
sudo install -d -m 755 -o root -g root "${ENV_DIR}"
for name in gateway updater owner watchdog notify lab-history; do
  file="${ENV_DIR}/${name}.env"
  mode=640
  group="${APP_USER}"
  case "${name}" in
    updater|owner|lab-history) mode=600; group=root ;;
    notify) group="${APP_NOTIFY_USER}" ;;
    watchdog) group="${APP_WATCHDOG_USER}" ;;
  esac
  if [ ! -f "${file}" ]; then
    sudo install -m "${mode}" -o root -g "${group}" /dev/null "${file}"
  else
    sudo chown "root:${group}" "${file}"
    sudo chmod "${mode}" "${file}"
  fi
done

if [ -d deploy/systemd ]; then
  sudo cp deploy/systemd/octra-vitals-gateway.service /etc/systemd/system/octra-vitals-gateway.service
  sudo cp deploy/systemd/octra-vitals-updater.service /etc/systemd/system/octra-vitals-updater.service
  sudo cp deploy/systemd/octra-vitals-updater.timer /etc/systemd/system/octra-vitals-updater.timer
  sudo cp deploy/systemd/octra-vitals-lab-history-mirror.service /etc/systemd/system/octra-vitals-lab-history-mirror.service
  sudo cp deploy/systemd/octra-vitals-lab-history-mirror.timer /etc/systemd/system/octra-vitals-lab-history-mirror.timer
  sudo cp deploy/systemd/octra-vitals-lab-history-trigger.path /etc/systemd/system/octra-vitals-lab-history-trigger.path
  sudo cp deploy/systemd/octra-vitals-watchdog.service /etc/systemd/system/octra-vitals-watchdog.service
  sudo cp deploy/systemd/octra-vitals-watchdog.timer /etc/systemd/system/octra-vitals-watchdog.timer
  sudo cp deploy/systemd/octra-vitals-notify-alerts.service /etc/systemd/system/octra-vitals-notify-alerts.service
  sudo cp deploy/systemd/octra-vitals-notify-alerts.timer /etc/systemd/system/octra-vitals-notify-alerts.timer
  sudo cp deploy/systemd/octra-vitals-notify-digest.service /etc/systemd/system/octra-vitals-notify-digest.service
  sudo cp deploy/systemd/octra-vitals-notify-digest.timer /etc/systemd/system/octra-vitals-notify-digest.timer
  sudo systemctl daemon-reload
fi

node --version
npm --version
echo "bootstrapped ${APP_ROOT} with runtime data at ${DATA_DIR}"
