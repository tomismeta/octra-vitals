#!/usr/bin/env bash
set -euo pipefail

APP_USER="${APP_USER:-octra-vitals}"
APP_OPERATOR_USER="${APP_OPERATOR_USER:-octra-vitals-operator}"
APP_ROOT="${APP_ROOT:-/opt/octra-vitals}"
DATA_DIR="${VITALS_DATA_DIR:-/var/lib/octra-vitals}"
ENV_DIR="${ENV_DIR:-/etc/octra-vitals}"

sudo apt-get update
sudo apt-get install -y ca-certificates curl git rsync nodejs npm

if ! id "${APP_USER}" >/dev/null 2>&1; then
  sudo useradd --system --no-create-home --shell /usr/sbin/nologin "${APP_USER}"
fi
if ! id "${APP_OPERATOR_USER}" >/dev/null 2>&1; then
  sudo useradd --system --no-create-home --shell /usr/sbin/nologin --gid "${APP_USER}" "${APP_OPERATOR_USER}"
else
  sudo usermod -a -G "${APP_USER}" "${APP_OPERATOR_USER}"
fi

sudo install -d -m 755 -o root -g root "${APP_ROOT}" "${APP_ROOT}/releases"
sudo install -d -m 770 -o "${APP_USER}" -g "${APP_USER}" "${DATA_DIR}" "${DATA_DIR}/watchdog"
sudo install -d -m 755 -o root -g root "${ENV_DIR}"
if [ ! -f "${ENV_DIR}/gateway.env" ]; then
  sudo install -m 640 -o root -g "${APP_USER}" /dev/null "${ENV_DIR}/gateway.env"
else
  sudo chown root:"${APP_USER}" "${ENV_DIR}/gateway.env"
  sudo chmod 640 "${ENV_DIR}/gateway.env"
fi
if [ ! -f "${ENV_DIR}/updater.env" ]; then
  sudo install -m 600 -o root -g root /dev/null "${ENV_DIR}/updater.env"
else
  sudo chown root:root "${ENV_DIR}/updater.env"
  sudo chmod 600 "${ENV_DIR}/updater.env"
fi
if [ ! -f "${ENV_DIR}/notify.env" ]; then
  sudo install -m 640 -o root -g "${APP_USER}" /dev/null "${ENV_DIR}/notify.env"
else
  sudo chown root:"${APP_USER}" "${ENV_DIR}/notify.env"
  sudo chmod 640 "${ENV_DIR}/notify.env"
fi

if [ -d deploy/systemd ]; then
  sudo cp deploy/systemd/octra-vitals-gateway.service /etc/systemd/system/octra-vitals-gateway.service
  sudo cp deploy/systemd/octra-vitals-updater.service /etc/systemd/system/octra-vitals-updater.service
  sudo cp deploy/systemd/octra-vitals-updater.timer /etc/systemd/system/octra-vitals-updater.timer
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
