# ADR 0002: AML History Era Model

Date: 2026-06-23

Status: accepted for the mainnet history design.

## Context

Octra Vitals is moving from a bounded recent history window toward AML-native
forever history. The desired product property is:

```text
AML state records the canonical observation history.
Gateway and UI read, verify, and render it.
```

That creates a real constraint. AML program logic and AML state layout are
coupled. A `circle_program_update` replaces the active Circle program. If the
new program does not preserve the old state layout exactly, previously recorded
history remains on chain but may be orphaned from the new program's read
surface. This is not a normal database migration model.

A devnet probe on 2026-06-23 also showed that the current Circle runtime exposes
one active AML program slot per Circle. Installing Program B into a disposable
Circle after Program A caused Program B to replace Program A; both programs did
not coexist as companions inside the same Circle.

Probe evidence:

```text
circle_id: octACaigSbDan7L43ETmShCRaPsRnjquSx95hJ1qRPk3n1V
program_a_update_tx: d8f28d7e31f1b2024c447cdf46ebaf774cee7fe876c8d987184118aaed4cea93
program_b_update_tx: 6a74ac3e43af037556e4b781013342cdc9e1b0a8c548d803a681860e244892db
result: second program update replaced the first active program
```

Local report:

```text
reports/multi-program-circle-probe-2026-06-23T222631Z.json
```

## Problem Statement

We need a history architecture that can survive schema and index evolution
without losing the credibility of previously collected AML history.

The specific risks are:

- adding derived structures, such as calendar tree nodes, may require a new AML
  state layout;
- a new AML layout can create a new program era unless old state is explicitly
  migrated or imported;
- rebuilding history off-chain or replaying synthetic backfill would weaken the
  honesty claim;
- putting too much logic in the first mainnet AML increases the chance that we
  need to replace it later.

## Options Considered

### Option A: Put Everything In One First Mainnet AML

The first production AML would contain latest state, permanent capsule rows,
capsule metadata, root checkpoints, and calendar tree nodes.

Pros:

- one Circle program and one read surface;
- no immediate multi-era stitching;
- long-horizon views can be efficient from day one.

Cons:

- larger pre-mainnet AML surface;
- more rollover logic and write cost;
- harder formal and operational soak;
- future changes to tree/index logic risk forcing a new era anyway;
- tree nodes are derived indexes, not the canonical observation record.

### Option B: Keep Mainnet AML Minimal And Era-Based

The first production AML stores the durable core log: latest bundle, fixed-width
observation rows, AML-resident capsules, capsule metadata, and root checkpoints.
If a future AML program is needed, it becomes a new canonical era rather than a
silent replacement.

Pros:

- smallest durable mainnet state model;
- preserves the original 15-minute observations from cutover forward;
- avoids coupling the canonical log to optional derived indexes;
- makes upgrades honest: old program remains canonical for its real time range;
- easier to audit, soak, and reason about before mainnet.

Cons:

- long-horizon reads may initially require more raw capsule reads;
- future UI/gateway/native clients must stitch eras when a successor exists;
- calendar trees may start only from the era that introduces them unless an
  explicit import/index process is built.

### Option C: Use A Companion AML Index In The Same Circle

The Circle would contain one stable core history AML plus a second companion AML
for calendar trees or other derived views.

Pros:

- clean separation of source log and derived indexes;
- index logic could evolve without replacing the core log;
- one Circle identity would remain the native boundary.

Cons:

- current devnet probe indicates this is not supported today;
- `circle_program_update` appears to replace the single active program slot;
- cannot be the near-term mainnet architecture unless Octra adds multi-program
  Circle support.

### Option D: Migrate Old History Into Every New AML

Each successor AML would include import/replay methods to carry old capsule rows
or root commitments forward.

Pros:

- can provide a single active read surface after migration;
- old rows can be re-committed under a new root if designed carefully.

Cons:

- costly and operationally complex;
- easy to blur the line between recorded history and reconstructed history;
- requires migration-specific AML methods and gates;
- should be a deliberate tool, not the default upgrade model.

## Decision

Use an **AML history era model**.

The first mainnet forever-history AML should be minimal and stable:

```text
latest snapshot bundle
fixed-width 15-minute observation rows
AML-resident capsule bodies
capsule metadata
row root checkpoints
capsule root checkpoints
predecessor/successor pointers
```

Do not add calendar tree nodes to the first mainnet AML unless a separate
pre-mainnet decision explicitly accepts the added complexity. Trees are useful
derived indexes, but they are not required to preserve canonical granular
history.

When a future AML program changes the state layout, treat it as a new era:

```text
era 1 program: canonical for snapshots 1..N
era 2 program: canonical for snapshots N+1..M
era 3 program: canonical for snapshots M+1..latest
```

Old eras remain valid and readable. New eras do not pretend to own old rows
unless an explicit migration/import path is implemented and audited.

## Requirements

Every history-era AML should expose enough metadata for stitching:

- `history_schema_id`;
- `snapshot_count`;
- `latest_snapshot_index`;
- `first_snapshot_index` or equivalent era-start metadata;
- `latest_snapshot_id`;
- `history_root`;
- `capsules_root`;
- `predecessor_program`;
- `successor_program`;
- sealed capsule bodies and metadata by deterministic id;
- root-after checkpoints for sealed capsules.

The gateway/UI/native client may stitch eras, but must preserve proof boundaries.
A rendered timeline can be continuous, but verification details must identify
which AML era produced each row.

Future migration/import methods must be explicit. They should import sealed
capsule bodies or root commitments by hash/root, never fabricate historical
rows from gateway-local data.

## Deployment Guardrails

Before any future AML update on a Circle with nonzero history:

- detect that the active program has recorded history;
- classify the update as either schema-compatible, new-era, or migration;
- require an explicit operator acknowledgement for new-era or migration paths;
- preserve the old program/Circle id in an era registry or predecessor pointer;
- verify the successor's first snapshot index and predecessor metadata;
- do not rewrite or fake-backfill old rows.

## Consequences

- Mainnet v1 prioritizes durable raw capsule history over derived indexes.
- Calendar trees remain a future read-acceleration layer, not the first
  canonical storage requirement.
- A later index program may live in a separate Circle or in a future
  multi-program Circle runtime if Octra adds that capability.
- The product can honestly say that each AML era is canonical for the period it
  actually recorded.
- The gateway remains a stitcher/verifier, not a source of historical truth.
