# Standalone Vitals State Program

This directory contains the standalone State Program compatibility path. The current public architecture uses a programmed Site Circle with the fact-ledger AML under `program-fact-ledger/`.

The standalone program remains useful for compatibility, regression tests, and historical comparison. It stores:

- latest full canonical payload;
- latest full evidence manifest;
- latest full source refs;
- latest summary row;
- bounded rolling summary-window history;
- operator/owner/successor control state.

It intentionally does not store permanent historical capsules or full historical payload maps.

## Requirements

- Source is verified after deployment.
- Formal verification is `verified == true`.
- Formal verification safety is `safe`.
- `record_snapshot_v0` is owner/operator gated.
- Snapshot indexes and epoch/time move forward under the monotonicity rule.
- Hash domains, schema gates, and size bounds match the TypeScript updater.

## Artifacts

Tracked program artifacts:

- `main.aml`
- `abi.json`
- `lowered.oasm`
- `formal_verification.json`
- `formal_certificate.json`
- `storage.md`

Compile and verify:

```bash
npm run program:compile
npm run program:verify
```

Deploy is fail-closed:

```bash
VITALS_DEPLOY_STATE_PROGRAM=1 npm run program:deploy
```

Without `VITALS_DEPLOY_STATE_PROGRAM=1`, `program:deploy` emits a dry-run report only.
