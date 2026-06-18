# Vitals State Program

The Vitals State Program is the canonical public v0 AML state surface.

It stores:

- latest full canonical payload;
- latest full evidence manifest;
- latest full source refs;
- latest summary row;
- bounded recent summary-window history;
- operator/owner/successor control state.

It intentionally does not store historical full payload maps, generic records, staged records, duplicate id maps, or unbounded indexes.

## Requirements

- Source is verified after deployment.
- `contract_source(<program_address>)` exposes source, ABI, verification, and certificate.
- Formal verification is `verified == true`.
- Formal verification safety is `safe`.
- Scanner/RPC formal verification trace has zero errors.
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
