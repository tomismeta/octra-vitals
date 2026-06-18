#!/usr/bin/env bash
set -euo pipefail

APP_USER="${APP_USER:-octra-vitals}"
APP_OPERATOR_USER="${APP_OPERATOR_USER:-octra-vitals-operator}"
APP_ROOT="${APP_ROOT:-/opt/octra-vitals}"
DATA_DIR="${VITALS_DATA_DIR:-/var/lib/octra-vitals}"
ENV_DIR="${ENV_DIR:-/etc/octra-vitals}"

sudo apt-get update
sudo apt-get install -y ca-certificates curl git rsync gnupg

node_major() {
  if command -v node >/dev/null 2>&1; then
    node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || true
  fi
}

if [ "${FORCE_NODE22_INSTALL:-0}" = "1" ] || [ -z "$(node_major)" ] || [ "$(node_major)" -lt 22 ]; then
  sudo install -d -m 0755 /etc/apt/keyrings
  sudo rm -f /etc/apt/keyrings/nodesource.gpg
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    | sudo tee /etc/apt/sources.list.d/nodesource.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y nodejs
fi

node -e 'const major = Number(process.versions.node.split(".")[0]); if (major < 22) { console.error(`Node 22+ is required; found ${process.version}. Install Node 22 before continuing.`); process.exit(1); }'
npm -v >/dev/null

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

for name in gateway updater watchdog notify; do
  file="${ENV_DIR}/${name}.env"
  if [ ! -f "${file}" ]; then
    if [ "${name}" = "updater" ]; then
      sudo install -m 600 -o root -g root /dev/null "${file}"
    else
      sudo install -m 640 -o root -g "${APP_USER}" /dev/null "${file}"
    fi
  else
    if [ "${name}" = "updater" ]; then
      sudo chown root:root "${file}"
      sudo chmod 600 "${file}"
    else
      sudo chown root:"${APP_USER}" "${file}"
      sudo chmod 640 "${file}"
    fi
  fi
done

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
