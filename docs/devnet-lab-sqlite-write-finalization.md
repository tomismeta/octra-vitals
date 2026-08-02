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
- Devnet Lab mirror systemd units are installed, but disabled/inactive.
- Lab DB is upgraded and ready.
- Lab mirror writer remains disabled until writes settle cleanly.

The 2026-08-02 controlled write-smoke retry later dropped with TTL expiry, so
the operator nonce recovered. A controlled AML-only snapshot run succeeded after
that recovery. Do not re-enable scheduled cadence or Lab mirroring unless
`pending_nonce == nonce`, staging is empty, and a minimal Lab SQLite write has
confirmed with a contract receipt.

## Environment

- Vitals programmed Circle: `oct7zM4JcKrU6AK3T1tRLxCpkVR3BxzTrtvro3EoyP5LPTb`
- Lab SQLite DB Circle: `octBa1SdBvjQ38dJWBwiLByPSQrGTdja2HG15dZCkGJFeJP`
- Operator: `oct1FnMzPjPXxXViAco3y7iAwjxvGg4gwjCbwnYx4hujd7p`
- Lab RPC: `https://devnet.octrascan.io/rpc`
- Lab SQLite binary: `/opt/octra-sqlite/bin/octra-sqlite`
- Lab SQLite CLI: `octra-sqlite 0.6.3`
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

### Independent octra-sqlite 0.6.3 Write Smoke

This used the deployed devnet service identity and `OCTRA_SQLITE_CONFIG`.

Command shape:

```sh
octra-sqlite verify "$VITALS_LAB_HISTORY_DATABASE_URI" \
  --rpc "$VITALS_LAB_HISTORY_RPC" \
  --write-smoke \
  --write-ou "$VITALS_LAB_HISTORY_WRITE_OU" \
  --json
```

- CLI: `octra-sqlite 0.6.3`
- Requested OU: `200000`
- Result: submitted, `contract_receipt` returned `receipt not found`, then the
  transaction dropped with TTL expiry
- Example tx: `a916049ba1ad899d98611785c902abccffc41d271b026a7da59c8c2b26899f13`

While pending:

```json
{
  "tx_status": "pending",
  "tx_ou": "200000",
  "nonce": 10233,
  "receipt_error": {
    "code": 112,
    "message": "not found",
    "data": "receipt not found"
  },
  "staging_estimateOu": {
    "staging_size": 1,
    "p50": "200000",
    "p75": "200000",
    "p95": "200000",
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
        "total_value": "0.200000"
      }
    ]
  },
  "balance": {
    "nonce": 10232,
    "pending_nonce": 10233
  }
}
```

Final transaction lookup:

```json
{
  "status": "dropped",
  "reason": "expired",
  "detail": "TTL exceeded",
  "tx_hash": "a916049ba1ad899d98611785c902abccffc41d271b026a7da59c8c2b26899f13",
  "from": "oct1FnMzPjPXxXViAco3y7iAwjxvGg4gwjCbwnYx4hujd7p",
  "to_": "octBa1SdBvjQ38dJWBwiLByPSQrGTdja2HG15dZCkGJFeJP",
  "nonce": 10233,
  "ou": "200000",
  "op_type": "circle_call"
}
```

After the drop:

```json
{
  "staging_stats": {
    "total_transactions": 0,
    "total_ou": "0",
    "ou_remaining": "10000000000"
  },
  "balance": {
    "nonce": 10232,
    "pending_nonce": 10232
  }
}
```

The next controlled AML-only updater run then confirmed snapshot
`vitals.2026-08-02T21:05:19Z` at index `15` with tx
`9d280600d8ddd78101885eeb14bcbdd6504978267cd858b35564e2488ad939c8`.
Post-run staging remained empty and the operator recovered to
`nonce == pending_nonce == 10233`.

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
