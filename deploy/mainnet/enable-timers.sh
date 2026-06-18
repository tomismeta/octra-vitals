#!/usr/bin/env bash
set -euo pipefail

EXPECTED_ACK="${ENABLE_MAINNET_TIMERS_EXPECTED_ACK:-ENABLE OCTRA VITALS MAINNET TIMERS}"
ENV_DIR="${ENV_DIR:-/etc/octra-vitals}"
UPDATER_ENV="${UPDATER_ENV:-${ENV_DIR}/updater.env}"

if [ "${ENABLE_MAINNET_TIMERS_ACK:-}" != "${EXPECTED_ACK}" ]; then
  echo "refusing to enable timers without ENABLE_MAINNET_TIMERS_ACK='${EXPECTED_ACK}'" >&2
  exit 1
fi

tmp="$(mktemp)"
sudo awk -F= '$1 != "VITALS_SUBMIT" { print }' "${UPDATER_ENV}" > "${tmp}"
printf 'VITALS_SUBMIT=1\n' >> "${tmp}"
sudo install -m 600 -o root -g root "${tmp}" "${UPDATER_ENV}"
rm -f "${tmp}"

sudo systemctl enable --now octra-vitals-gateway.service
sudo systemctl enable --now octra-vitals-updater.timer
sudo systemctl enable --now octra-vitals-watchdog.timer
systemctl is-enabled octra-vitals-gateway.service octra-vitals-updater.timer octra-vitals-watchdog.timer
systemctl is-active octra-vitals-gateway.service octra-vitals-updater.timer octra-vitals-watchdog.timer
