#!/usr/bin/env bash
set -euo pipefail

DEPLOY_ENVIRONMENT="${DEPLOY_ENVIRONMENT:-stage}" \
bash /opt/octra-vitals/current/deploy/mainnet/publish-programmed-site-assets.sh
