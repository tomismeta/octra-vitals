#!/usr/bin/env bash
set -euo pipefail

HOST="${1:-${STAGE_HOST:-octra-stage.exe.xyz}}"
DEPLOY_ENVIRONMENT="${DEPLOY_ENVIRONMENT:-stage}" \
bash deploy/mainnet/push-release.sh "${HOST}"
