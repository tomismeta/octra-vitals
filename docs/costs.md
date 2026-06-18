# Cost Notes

Octra fees are paid in `ou`, the smallest unit of OCT.

Current devnet defaults:

```bash
VITALS_CALL_OU=1000
VITALS_DEPLOY_OU=200000
```

As of the devnet dogfood run, `octra_recommendedFee("call")` returned:

```json
{
  "minimum": "1",
  "base_fee": "1000",
  "recommended": "1000",
  "fast": "2000"
}
```

`record_snapshot_v0` receipts may also show `effort used`. Treat that as execution telemetry unless Octra publishes a fee model that prices program calls from actual effort consumed.

Before any mainnet deployment, re-check:

- `octra_recommendedFee("call")`
- `octra_recommendedFee("deploy")`
- Circle deploy and asset upload fee guidance
- whether mainnet program/Circle operations use the same fee fields as devnet
