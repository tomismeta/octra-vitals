#!/usr/bin/env bash
set -euo pipefail

EXPECTED_ACK="${ENABLE_MAINNET_TIMERS_EXPECTED_ACK:-ENABLE OCTRA VITALS MAINNET TIMERS}"
ENV_DIR="${ENV_DIR:-/etc/octra-vitals}"
UPDATER_ENV="${UPDATER_ENV:-${ENV_DIR}/updater.env}"
LAB_ENV="${LAB_ENV:-${ENV_DIR}/lab-history.env}"

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

lab_env_value() {
  key="$1"
  if sudo test -r "${LAB_ENV}"; then
    sudo awk -F= -v key="${key}" '$1 == key { value=$0; sub(/^[^=]*=/, "", value); print value }' "${LAB_ENV}" | tail -n1
  fi
}

LAB_TRIGGER_ENABLED="${VITALS_ENABLE_LAB_HISTORY_TRIGGER:-$(lab_env_value VITALS_LAB_HISTORY_ENABLED)}"
if [ "${LAB_TRIGGER_ENABLED}" = "1" ]; then
  sudo systemctl enable --now octra-vitals-lab-history-trigger.path
fi
if [ "${VITALS_ENABLE_LAB_HISTORY_TIMER:-0}" = "1" ]; then
  sudo systemctl enable --now octra-vitals-lab-history-mirror.timer
elif [ "${LAB_TRIGGER_ENABLED}" = "1" ]; then
  sudo systemctl disable --now octra-vitals-lab-history-mirror.timer >/dev/null 2>&1 || true
fi
systemctl is-enabled octra-vitals-gateway.service octra-vitals-updater.timer octra-vitals-watchdog.timer
systemctl is-active octra-vitals-gateway.service octra-vitals-updater.timer octra-vitals-watchdog.timer
if [ "${LAB_TRIGGER_ENABLED}" = "1" ]; then
  systemctl is-enabled octra-vitals-lab-history-trigger.path
  systemctl is-active octra-vitals-lab-history-trigger.path
fi
if [ "${VITALS_ENABLE_LAB_HISTORY_TIMER:-0}" = "1" ]; then
  systemctl is-enabled octra-vitals-lab-history-mirror.timer
  systemctl is-active octra-vitals-lab-history-mirror.timer
fi
