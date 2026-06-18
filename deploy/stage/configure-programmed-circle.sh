#!/usr/bin/env bash
set -euo pipefail

PRIVATE_ENV="${PRIVATE_ENV:-/home/exedev/.config/octra-vitals/dev.env}" \
VITALS_GATEWAY_ROLE="${VITALS_GATEWAY_ROLE:-stage}" \
VITALS_SUBMIT="${VITALS_SUBMIT:-0}" \
bash /opt/octra-vitals/current/deploy/mainnet/configure-programmed-circle.sh
