# Devnet Lab SQLite Write Finalization

Status: open devnet blocker. Mainnet was not touched.

## Summary

Devnet Vitals now passes the configured Lab SQLite write budget correctly. The
original symptom looked like Vitals was signing Lab writes with `OU=1000`, but
the current evidence shows a lower-level devnet SQLite Circle write finalization
issue:

- Vitals Lab mirror writes submit with the requested OU.
- Independent `octra-sqlite verify --write-smoke` writes also submit with the
  requested OU.
- The submitted transactions remain pending, never expose a contract receipt,
  then drop.
- While pending, `staging_view` reports the transaction OU correctly, but
  `staging_stats` and `staging_estimateOu` account the queue as `1000`.

## Current Safe State

- Devnet gateway is active.
- Devnet `/api/latest` is fresh and program-backed.
- Devnet operator nonce is clean.
- Devnet staging is empty.
- Lab DB is upgraded and ready.
- Lab mirror writer remains disabled until writes settle cleanly.

## Environment

- Vitals programmed Circle: `oct7zM4JcKrU6AK3T1tRLxCpkVR3BxzTrtvro3EoyP5LPTb`
- Lab SQLite DB Circle: `octBa1SdBvjQ38dJWBwiLByPSQrGTdja2HG15dZCkGJFeJP`
- Operator: `oct1FnMzPjPXxXViAco3y7iAwjxvGg4gwjCbwnYx4hujd7p`
- Lab RPC: `https://devnet.octrascan.io/rpc`
- Lab SQLite binary: `/opt/octra-sqlite/bin/octra-sqlite`
- Lab SQLite version after upgrade: `3.53.4`

## Confirmed Fixes

- Vitals passes `--ou` to `octra-sqlite open`.
- `VITALS_LAB_HISTORY_WRITE_OU=200000` is configured.
- Lab DB was upgraded successfully from SQLite `3.53.3` to `3.53.4`.
- Lab DB status reports:
  - `read_ready: true`
  - `write_ready: true`
  - `engine_current: true`
  - `upgrade_needed: false`

## Reproduction Evidence

### Vitals Lab Mirror Write

The Lab mirror attempted a small metadata batch after the DB upgrade.

- Requested OU: `200000`
- Result: submitted, receipt not found, pending, then dropped
- Example tx: `1541849f198e00d748d54e9f3613aeea49573f1e804b82fd286f1f2d0250e0e1`

While pending:

```json
{
  "tx_status": "pending",
  "tx_ou": "200000",
  "receipt_error": {
    "code": 112,
    "message": "not found",
    "data": "receipt not found"
  },
  "staging_count": 1,
  "ours_in_staging": true
}
```

### Independent octra-sqlite Write Smoke

This bypassed Vitals mirror SQL and used octra-sqlite's built-in write smoke.

Command shape:

```sh
octra-sqlite verify "$VITALS_LAB_HISTORY_DATABASE_URI" \
  --rpc "$VITALS_LAB_HISTORY_RPC" \
  --write-smoke \
  --write-ou 1000000 \
  --json
```

- Requested OU: `1000000`
- Result: submitted, receipt not found, pending, then dropped
- Example tx: `16beb23b63342f5180952f3c515e26a09bbd604774c2dcbb3f7e4ec8879cc184`

While pending:

```json
{
  "tx_status": "pending",
  "tx_ou": "1000000",
  "receipt_error": {
    "code": 112,
    "message": "not found",
    "data": "receipt not found"
  },
  "staging_count": 1,
  "ours_in_staging": true
}
```

At the same time, staging reported:

```json
{
  "staging_estimateOu": {
    "staging_size": 1,
    "p50": "1000000",
    "p75": "1000000",
    "p95": "1000000",
    "recommended": "1000",
    "staging_ou": "1000"
  },
  "staging_stats": {
    "total_transactions": 1,
    "total_ou": "1000",
    "by_sender": [
      {
        "address": "oct1FnMzPjPXxXViAco3y7iAwjxvGg4gwjCbwnYx4hujd7p",
        "tx_count": 1,
        "total_value": "1"
      }
    ]
  }
}
```

## Current Interpretation

The remaining failure is not caused by Vitals omitting the configured write
budget. It is also not solved by increasing the budget from `200000` to
`1000000`.

The likely issue is in devnet SQLite Circle call finalization, staging OU
accounting, or the octra-sqlite transaction/receipt path for this runtime.

## Operating Rule

Keep `VITALS_LAB_HISTORY_ENABLED=0` for the Lab mirror worker until a minimal
`octra-sqlite verify --write-smoke` can:

1. submit,
2. confirm,
3. return a contract receipt,
4. leave `nonce == pending_nonce`,
5. leave staging empty.

Only after that should devnet Lab mirror writes and the trigger path be
re-enabled.
