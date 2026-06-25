# ADR 0002: AML History Eras

Date: 2026-06-23

Status: accepted

## Context

AML program logic and AML state layout are tightly coupled. A Circle program update changes the active read/write logic for that Circle. If a new program cannot read old state exactly, old history remains on chain but may no longer be exposed through the new program's getters.

Vitals wants durable history without fake backfill or silent state reinterpretation.

## Decision

Use explicit AML history eras.

Each era is canonical for the snapshots it actually records:

```text
era A: snapshots 1..N
era B: snapshots N+1..M
era C: snapshots M+1..latest
```

A successor era must store:

- predecessor program/Circle id;
- predecessor final snapshot index;
- predecessor final root;
- successor first snapshot index;
- era program/Circle id;
- domain-separated predecessor anchor hash.

The gateway/API may stitch eras only after reading the predecessor era and verifying the successor anchor against the predecessor's actual final root.

Compatible in-place AML updates are still allowed when the new program preserves old state layout, old getters, old row semantics, and old capsule immutability. Incompatible changes create a new era.

## Consequences

- Historical truth stays local to the AML era that recorded it.
- Future schema changes do not need dishonest backfill.
- UI and gateway code must expose era proof boundaries.
- Retired era Circles remain read dependencies unless a future migration/import path is explicitly audited.
- Mainnet launch should minimize future era churn by keeping the first public AML boring, extensible, and formally verified.
