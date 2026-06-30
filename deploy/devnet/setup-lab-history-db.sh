#!/usr/bin/env bash
set -euo pipefail

OCTRA_SQLITE_REPO="${OCTRA_SQLITE_REPO:-https://github.com/tomismeta/octra-sqlite.git}"
OCTRA_SQLITE_COMMIT="${OCTRA_SQLITE_COMMIT:-95105c57a2949f0ae03a71907f2da20d23f415f0}"
OCTRA_SQLITE_PREFIX="${OCTRA_SQLITE_PREFIX:-/opt/octra-sqlite}"
OCTRA_SQLITE_SOURCE="${OCTRA_SQLITE_SOURCE:-$OCTRA_SQLITE_PREFIX/source}"
OCTRA_SQLITE_CONFIG="${OCTRA_SQLITE_CONFIG:-/etc/octra-vitals/octra-sqlite/config.json}"
OCTRA_SQLITE_WALLET="${OCTRA_SQLITE_WALLET:-/etc/octra-vitals/octra-sqlite/wallet.json}"
OCTRA_SQLITE_GROUP="${OCTRA_SQLITE_GROUP:-octra-vitals}"
VITALS_REPO_DIR="${VITALS_REPO_DIR:-/opt/octra-vitals}"
LAB_SCHEMA="${LAB_SCHEMA:-$VITALS_REPO_DIR/ops/octra-sqlite/history-lab-schema.sql}"
LAB_DATABASE="${VITALS_LAB_HISTORY_DATABASE:-vitals_history_lab}"
LAB_NETWORK="${VITALS_LAB_HISTORY_NETWORK:-devnet}"
case "$LAB_NETWORK" in
  devnet)
    LAB_RPC="${VITALS_LAB_HISTORY_RPC:-https://devnet.octrascan.io/rpc}"
    ;;
  mainnet)
    LAB_RPC="${VITALS_LAB_HISTORY_RPC:-https://octra.network/rpc}"
    ;;
  *)
    echo "unsupported lab network: $LAB_NETWORK" >&2
    exit 1
    ;;
esac

if [[ ! -s "$OCTRA_SQLITE_WALLET" ]]; then
  echo "missing wallet file: $OCTRA_SQLITE_WALLET" >&2
  exit 1
fi

if [[ ! -s "$LAB_SCHEMA" ]]; then
  echo "missing lab schema: $LAB_SCHEMA" >&2
  exit 1
fi

if getent group "$OCTRA_SQLITE_GROUP" >/dev/null 2>&1; then
  sudo install -d -m 0750 -o root -g "$OCTRA_SQLITE_GROUP" "$OCTRA_SQLITE_PREFIX"
else
  sudo install -d -m 0750 -o root -g root "$OCTRA_SQLITE_PREFIX"
fi
if [[ ! -d "$OCTRA_SQLITE_SOURCE/.git" ]]; then
  sudo git clone "$OCTRA_SQLITE_REPO" "$OCTRA_SQLITE_SOURCE"
fi
sudo git -C "$OCTRA_SQLITE_SOURCE" fetch --tags origin
sudo git -C "$OCTRA_SQLITE_SOURCE" checkout "$OCTRA_SQLITE_COMMIT"

if sudo test -x /root/.cargo/bin/cargo; then
  export PATH="/root/.cargo/bin:$PATH"
fi

sudo env PATH="$PATH" cargo install --path "$OCTRA_SQLITE_SOURCE" --locked --root "$OCTRA_SQLITE_PREFIX"

if getent group "$OCTRA_SQLITE_GROUP" >/dev/null 2>&1; then
  sudo chgrp -R "$OCTRA_SQLITE_GROUP" "$OCTRA_SQLITE_PREFIX"
  sudo chmod 0750 "$OCTRA_SQLITE_PREFIX"
  sudo chmod 0755 "$OCTRA_SQLITE_PREFIX/bin"
  sudo chmod 0755 "$OCTRA_SQLITE_PREFIX/bin/octra-sqlite"
fi

sudo env OCTRA_SQLITE_CONFIG="$OCTRA_SQLITE_CONFIG" \
  "$OCTRA_SQLITE_PREFIX/bin/octra-sqlite" init \
  --wallet "$OCTRA_SQLITE_WALLET" \
  --network "$LAB_NETWORK" \
  --rpc "$LAB_RPC"

if sudo env OCTRA_SQLITE_CONFIG="$OCTRA_SQLITE_CONFIG" \
  "$OCTRA_SQLITE_PREFIX/bin/octra-sqlite" database info "$LAB_DATABASE" >/dev/null 2>&1; then
  echo "database already registered: $LAB_DATABASE"
else
  sudo env OCTRA_SQLITE_CONFIG="$OCTRA_SQLITE_CONFIG" \
    "$OCTRA_SQLITE_PREFIX/bin/octra-sqlite" new "$LAB_DATABASE" \
    --read "$LAB_SCHEMA" \
    --network "$LAB_NETWORK" \
    --rpc "$LAB_RPC"
fi

sudo env OCTRA_SQLITE_CONFIG="$OCTRA_SQLITE_CONFIG" \
  "$OCTRA_SQLITE_PREFIX/bin/octra-sqlite" open "$LAB_DATABASE" \
  "alter table snapshots add column source_id text" >/dev/null 2>&1 || true

sudo env OCTRA_SQLITE_CONFIG="$OCTRA_SQLITE_CONFIG" \
  "$OCTRA_SQLITE_PREFIX/bin/octra-sqlite" verify "$LAB_DATABASE"
