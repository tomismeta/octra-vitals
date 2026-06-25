# Costs

Octra fees are paid in `ou`, the smallest unit of OCT.

Current devnet defaults:

```bash
VITALS_CALL_OU=1000
VITALS_DEPLOY_OU=200000
```

Example devnet `octra_recommendedFee("call")` response:

```json
{
  "minimum": "1",
  "base_fee": "1000",
  "recommended": "1000",
  "fast": "2000"
}
```

Snapshot receipts may also show `effort used`. Treat that as execution telemetry unless Octra publishes a fee model that prices program calls from actual effort consumed.

Before any mainnet deployment, re-check:

- `octra_recommendedFee("call")`
- `octra_recommendedFee("deploy")`
- Circle deploy and asset upload fee guidance
- whether mainnet program/Circle operations use the same fee fields as devnet

For asset updates, changed-only publishing is the main cost control. Batch submit reduces RPC round trips, but each selected file still has its own asset transaction and confirmation path.
