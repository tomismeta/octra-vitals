# Strict AML ABI Runtime Impact

Date: 2026-08-01

## Problem

The devnet runtime now rejects lowered AML with duplicate jump labels. The fact-ledger program had grown a broad public surface, so compiler-assigned public method labels crossed into the same numeric range used by generated internal branches.

## Decision

Treat the AML public ABI as scarce protocol surface.

The fact ledger keeps the same state layout and data model, but the current public ABI removes transitional helpers:

- constant getters;
- core-only capsule aliases;
- the split `initialize_core_family` path;
- the old `record_snapshot_fact_v1` write method.

The canonical read surface is the generic fact-family API with core family id `0000`.

## Layer Impact

| Layer | Change | Why |
| --- | --- | --- |
| AML | Public ABI reduced to 55 methods; state layout unchanged | Avoid lowered label collisions under stricter runtime |
| Gateway readiness | Required-method list now matches strict fact-ledger ABI | Prevent false `program_pending_verification` from removed helpers |
| `/api/latest` | No response schema change | Latest getters and `get_latest_bundle` remain |
| `/api/history` | No response schema change | Fact-ledger history already reads generic family capsules |
| SQLite mirror | No schema change | It consumes verified gateway history/latest output, not removed AML helpers |
| Snapshot updater | No record payload shape change for `fact-v2` | Current write method remains `record_snapshot_fact_v2` |
| Deployment | Core family must be registered atomically by `initialize_fact_ledger` | Removed fallback write to `initialize_core_family` |
| Verification | Added duplicate-`JDEST` guard | Catch runtime-incompatible lowered output before deployment |

## Compatibility Analysis

### Public APIs

The browser and external HTTP contracts do not change. `/api/latest`, `/api/history`,
`/api/status`, and the Lab history APIs continue to expose the same JSON shapes. The
gateway absorbs the AML ABI change by using the generic fact-family methods behind the
existing API contract.

This is intentional: AML method names are protocol internals, while the HTTP API is the
stable product contract.

### Snapshot Updater

The updater must run with `VITALS_RECORD_SNAPSHOT_VERSION=fact-v2`. The old
`record_snapshot_fact_v1` method is retired and call bundles using it are rejected before
submission.

The snapshot payload, evidence manifest, source refs, summary row, core fact row, and
aux-row shape do not change.

### SQLite Mirror

No SQLite schema change is required. The mirror remains downstream from verified AML
state:

1. the producer writes the canonical snapshot to the Vitals AML fact ledger;
2. the gateway reads back and verifies AML state;
3. the optional Lab mirror writes the verified row into the octra-sqlite Circle.

The mirror reads gateway/API history contracts, not retired AML helper methods. It should
therefore continue to work after the strict ABI cutover without database migration or
backfill mechanics changing.

### History Views

History rendering continues to work because the canonical fact-ledger history path already
uses:

- `get_family_root("0000")`;
- `get_family_capsules_root("0000")`;
- `get_family_open_capsule_*("0000")`;
- `get_family_capsule_*("0000", capsule_id)`.

Legacy alias getters such as `get_history_root` are preserved only in reader code for old
non-fact-ledger eras. They are not required on the new strict fact-ledger program.

### Deployment And Era Model

This is an ABI break, so the clean deployment shape is a fresh successor era, not an
in-place update. The new era keeps state compatibility by anchoring to the predecessor
final root/index, then continuing the snapshot sequence in the new program.

Deployment tooling now treats `initialize_fact_ledger` as the single atomic initializer
for owner, predecessor anchor, and core family registration. If core family `0000` is not
registered after initialization, deployment fails instead of attempting a second
transitional write.

### Verification And CI

The lowered-oasm duplicate-`JDEST` check is now part of native verification and CI. This
turns the stricter runtime behavior into a local gate instead of a devnet surprise.

Pin refreshes also require explicit release intent:

- `VITALS_AML_RELEASE_MODE=in_place` for backward-compatible refreshes;
- `VITALS_AML_RELEASE_MODE=new_era` plus source-hash acknowledgement for ABI breaks.

## Release Rule

This is a successor-era ABI change, not an in-place compatible update. Artifact refresh requires:

- state-layout hash unchanged;
- explicit `VITALS_AML_RELEASE_MODE=new_era`;
- explicit source-hash acknowledgement for the ABI break;
- devnet soak before mainnet;
- normal production compiler quorum before mainnet promotion.

## What Does Not Change

- No app/UI contract changes.
- No SQLite table changes.
- No raw evidence retention changes.
- No change to the core fact row, capsule row, or latest snapshot payload shape.
- No mainnet action without explicit approval.
