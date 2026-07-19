#!/usr/bin/env bash
set -euo pipefail

APP_NOTIFY_USER="${APP_NOTIFY_USER:-octra-vitals-notify}"
APP_ROOT="${APP_ROOT:-/opt/octra-vitals}"
DATA_DIR="${VITALS_DATA_DIR:-/var/lib/octra-vitals}"
ENV_DIR="${ENV_DIR:-/etc/octra-vitals}"
NOTIFY_ENV="${NOTIFY_ENV:-${ENV_DIR}/notify.env}"

if ! id "${APP_NOTIFY_USER}" >/dev/null 2>&1; then
  echo "missing notify user: ${APP_NOTIFY_USER}" >&2
  exit 1
fi
if [ ! -d "${APP_ROOT}/current" ]; then
  echo "missing release symlink: ${APP_ROOT}/current" >&2
  exit 1
fi

gateway_port="4173"
notify_network="${VITALS_NOTIFY_NETWORK:-mainnet}"
operator_rpc_url="${VITALS_NOTIFY_OPERATOR_RPC_URL:-https://octra.network/rpc}"
operator_address="${VITALS_NOTIFY_OPERATOR_ADDRESS:-}"
if sudo test -r "${ENV_DIR}/gateway.env"; then
  configured_port="$(sudo sed -n 's/^PORT=//p' "${ENV_DIR}/gateway.env" | tail -n1 || true)"
  if [ -n "${configured_port}" ]; then
    gateway_port="${configured_port}"
  fi
  configured_role="$(sudo sed -n 's/^VITALS_GATEWAY_ROLE=//p' "${ENV_DIR}/gateway.env" | tail -n1 || true)"
  configured_rpc="$(sudo sed -n 's/^OCTRA_PROGRAM_RPC_URL=//p; s/^OCTRA_RPC_URL=//p' "${ENV_DIR}/gateway.env" | tail -n1 || true)"
  if [ "${configured_role}" = "devnet" ] || [ "${configured_role}" = "development" ]; then
    notify_network="devnet"
    operator_rpc_url="https://devnet.octrascan.io/rpc"
  elif [ "${configured_role}" = "production" ] || [ "${configured_role}" = "prod" ]; then
    notify_network="mainnet"
    operator_rpc_url="https://octra.network/rpc"
  fi
  if [ -n "${configured_rpc}" ]; then
    operator_rpc_url="${configured_rpc}"
  fi
fi
if [ -z "${operator_address}" ] && sudo test -r "${ENV_DIR}/updater.env"; then
  operator_address="$(sudo sed -n 's/^VITALS_OPERATOR_ADDRESS=//p' "${ENV_DIR}/updater.env" | tail -n1 || true)"
fi
gateway_url="${VITALS_NOTIFY_GATEWAY_URL:-http://127.0.0.1:${gateway_port}}"

echo "This writes ${NOTIFY_ENV}; the token will not be printed."
read -r -s -p "Telegram bot token: " telegram_token
echo
if [[ ! "${telegram_token}" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]]; then
  echo "token format did not match Telegram bot token shape" >&2
  exit 1
fi

cat <<'EOF'
If you do not know the chat id:
  1. Open Telegram and send any message to your bot.
  2. Leave chat id blank here.
  3. This script will list chat ids from getUpdates without printing the token.
EOF
read -r -p "Telegram chat id: " telegram_chat_id
if [ -z "${telegram_chat_id}" ]; then
  echo "Resolving chat ids..."
  TELEGRAM_BOT_TOKEN="${telegram_token}" node "${APP_ROOT}/current/dist/scripts/notify-operator.js" --resolve-chat-id
  read -r -p "Telegram chat id from the list above: " telegram_chat_id
fi
if [[ ! "${telegram_chat_id}" =~ ^-?[0-9]+$ ]]; then
  echo "chat id must be numeric" >&2
  exit 1
fi

tmp="$(mktemp)"
trap 'rm -f "${tmp}"' EXIT
cat > "${tmp}" <<EOF
TELEGRAM_BOT_TOKEN=${telegram_token}
TELEGRAM_CHAT_ID=${telegram_chat_id}
VITALS_NOTIFY_GATEWAY_URL=${gateway_url}
VITALS_NOTIFY_DATA_DIR=${DATA_DIR}
VITALS_NOTIFY_NETWORK=${notify_network}
VITALS_NOTIFY_OPERATOR_RPC_URL=${operator_rpc_url}
VITALS_NOTIFY_OPERATOR_ADDRESS=${operator_address}
VITALS_NOTIFY_ALERT_MAX_SNAPSHOT_AGE_MS=2700000
VITALS_NOTIFY_ALERT_COOLDOWN_MS=1800000
VITALS_NOTIFY_ALERT_DISK_PCT=75
VITALS_NOTIFY_ALERT_DIAGNOSTIC_REQUESTS_PER_HOUR=300
VITALS_NOTIFY_ALERT_OPERATOR_WALLET_WARN_OCT=5
VITALS_NOTIFY_ALERT_OPERATOR_WALLET_CRITICAL_OCT=2
VITALS_NOTIFY_ALERT_OPERATOR_WALLET_RUNWAY_WARN_DAYS=30
VITALS_NOTIFY_ALERT_OPERATOR_WALLET_RUNWAY_CRITICAL_DAYS=7
EOF
sudo install -d -m 755 -o root -g root "${ENV_DIR}"
sudo install -m 640 -o root -g "${APP_NOTIFY_USER}" "${tmp}" "${NOTIFY_ENV}"
unset telegram_token TELEGRAM_BOT_TOKEN
sudo systemctl daemon-reload

read -r -p "Send a Telegram test message now? [Y/n] " send_test
if [[ ! "${send_test}" =~ ^[Nn]$ ]]; then
  sudo -u "${APP_NOTIFY_USER}" bash --noprofile --norc -c ". '${APP_ROOT}/current/deploy/lib/env-file.sh'; load_env_file_data '${NOTIFY_ENV}'; cd '${APP_ROOT}/current'; node dist/scripts/notify-operator.js --test"
fi

read -r -p "Enable alert and daily digest timers now? [Y/n] " enable_timers
if [[ ! "${enable_timers}" =~ ^[Nn]$ ]]; then
  sudo systemctl enable --now octra-vitals-notify-alerts.timer octra-vitals-notify-digest.timer
  systemctl list-timers octra-vitals-notify-alerts.timer octra-vitals-notify-digest.timer --no-pager
else
  echo "Timers left disabled. Enable later with:"
  echo "  sudo systemctl enable --now octra-vitals-notify-alerts.timer octra-vitals-notify-digest.timer"
fi

echo "Telegram notifications configured for ${gateway_url}"
