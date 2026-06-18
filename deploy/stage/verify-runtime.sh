#!/usr/bin/env bash
set -euo pipefail

DEPLOY_ENVIRONMENT="${DEPLOY_ENVIRONMENT:-stage}" \
bash /opt/octra-vitals/current/deploy/mainnet/verify-runtime.sh
