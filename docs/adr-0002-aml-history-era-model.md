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

A more general from-scratch variant is captured in
[AML Extensible Fact Ledger Proposal](aml-extensible-fact-ledger-proposal.md).
That proposal reframes the extension scaffold as first-class fact families for
review before the mainnet AML shape is finalized.

## Problem Statement

We need a history architecture that can survive schema and index evolution
without losing the credibility of previously collected AML history. That
includes ordinary product evolution such as:

- adding destination chains beyond Ethereum;
- receiving new fields from Octra RPC, bridge RPCs, relayers, or EVM calls;
- splitting a formerly aggregate token-supply category into more precise
  categories;
- adding derived long-horizon charting indexes.

The specific risks are:

- adding derived structures, such as calendar tree nodes, to AML state may
  require a new state layout;
- a new AML layout can create a new program era unless the update is
  storage/read-compatible, or old state is explicitly migrated or imported;
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

### Option B: Keep Mainnet AML Minimal, Extensible, And Era-Based

The first production AML stores the durable core log: latest bundle, fixed-width
observation rows, AML-resident capsules, capsule metadata, and root checkpoints.
Compatible additive upgrades may preserve the same era if the new program can
read old state and old rows exactly. Incompatible changes become a new canonical
era rather than a silent replacement.

Pros:

- smallest durable mainnet state model;
- preserves the original 15-minute observations from cutover forward;
- avoids coupling the canonical log to optional derived indexes;
- makes upgrades honest: old program remains canonical for its real time range;
- allows ordinary source expansion through the latest payload and versioned
  extension families;
- easier to audit, soak, and reason about before mainnet.

Cons:

- long-horizon reads may initially require more raw capsule reads;
- future UI/gateway/native clients must stitch eras when a successor exists;
- calendar trees may start only from the era that introduces them unless an
  explicit import/index process is built.
- if extension-family storage is omitted from first mainnet, the first
  permanent new historical field family may require either a compatible
  in-place upgrade or a new era.

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

Use an **AML history era model with compatible-upgrade rules**.

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

The first mainnet AML should also preserve a clean path for normal source
evolution. The preferred layering is:

```text
latest_payload/routes/source_refs
  rich latest truth; can add chains and source fields without changing AML

core observation row
  stable conservation/accounting fact table; change rarely

extension families
  optional fixed-width historical rows for new durable field families

off-chain verified projections
  derived calendar/tree views computed from AML capsules, not canonical AML
```

To avoid turning every future source addition into an era-management event,
prefer including a small extension-family scaffold in the first mainnet AML if
the devnet probe shows the cost and verification surface are acceptable. The
scaffold can be inert at launch: an append-only family catalog, deterministic
extension capsule maps, per-family root/checkpoint rules, and getters. No
extension family needs to be active on day one.

Do not add calendar tree nodes to the first mainnet AML unless a separate
pre-mainnet decision explicitly accepts the added complexity. Trees are useful
derived indexes, but they are not required to preserve canonical granular
history. Prefer computing calendar/tree projections off-chain from AML capsule
bodies and verifying them against AML roots. This keeps long-horizon charting
from forcing an AML state-layout change.

When a future AML program preserves storage layout, old getters, old row
semantics, and old capsule immutability, it may be a compatible in-place update
rather than a new era.

When a future AML program changes the state layout incompatibly, treat it as a
new era:

```text
era 1 program: canonical for snapshots 1..N
era 2 program: canonical for snapshots N+1..M
era 3 program: canonical for snapshots M+1..latest
```

Old eras remain valid and readable. New eras do not pretend to own old rows
unless an explicit migration/import path is implemented and audited.

## Extensibility Rules

### New Destination Chains

Adding a new destination chain should first land in the latest snapshot payload:

```text
payload.routes[]
payload.source_refs[]
latest_payload_hash
```

This supports new chains in the latest view without changing AML state layout.
If the core conservation verdict remains aggregate OCT-denominated, the core
history row does not need per-chain fields.

If permanent per-chain history becomes product-critical, add it as a versioned
extension family rather than widening the core row:

```text
family_id: route_totals
join key: snapshot_index
fields: route_id, dst_chain_id, locked_raw, wrapped_raw, unclaimed_raw, status
coverage: first_snapshot_index..latest_snapshot_index for that family
```

Extension rows are allowed to start at the first snapshot where the source data
exists. Do not backfill invented per-chain rows.

### New RPC Fields

New RPC fields should be classified before AML changes:

- **latest/provenance only:** keep in `latest_payload`, `latest_evidence`, or
  `latest_source_refs`;
- **derived display:** compute from existing AML rows or verified raw evidence;
- **core conservation/token ontology:** add to the core row only if it is a
  stable invariant field that future verifiers need for every snapshot;
- **durable diagnostic or route detail:** add as an extension family.

### Category Splits

If a category split, such as burned versus unissued, can be derived exactly from
fields already stored in the core row, it does not require an AML change. If the
RPC begins exposing two independent source-backed values and both should be
preserved forever, decide before mainnet whether they belong in the core row. If
the ontology is still unsettled, keep the core row stable and introduce the split
as latest-only or as a future extension family from the first trustworthy
snapshot forward.

### Extension Families

Extension families are the preferred way to add durable historical fields
without converting old capsules or creating an era for every new data source.

An extension family must define:

- `family_id`;
- schema id and row version;
- fixed row length and field widths;
- join key, usually `snapshot_index`;
- first and latest covered snapshot index;
- whether the family is required for a conservation verdict;
- hash domains and root/checkpoint rules;
- null/not-captured semantics.

If first-mainnet AML includes a generic extension-family catalog and extension
capsule maps, adding a new family can be a data/schema addition inside the same
era. This is the preferred extensibility path for future chains and new RPC data
that should become permanent history. If first-mainnet AML omits those maps, the
first extension family requires a strict compatible-upgrade gate or a new era.

### Compatible Upgrade Gate

A same-Circle AML update is compatible only if all of the following hold:

- existing state fields and map key formats remain readable;
- existing public getters keep their names and behavior;
- existing row versions and capsule metadata remain decodable;
- sealed capsules remain immutable;
- old history roots and capsule roots remain valid;
- new writes cannot corrupt or reinterpret old rows;
- formal verification and devnet readback prove the old fixtures still work.

Anything else is a new era or an explicit migration/import.

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

For compatible upgrades, the same metadata must also let a verifier distinguish
which row schema, extension families, and source commitments were active at each
snapshot index.

The gateway/UI/native client may stitch eras, but must preserve proof boundaries.
A rendered timeline can be continuous, but verification details must identify
which AML era produced each row.

Future migration/import methods must be explicit. They should import sealed
capsule bodies or root commitments by hash/root, never fabricate historical
rows from gateway-local data.

## Deployment Guardrails

Before any future AML update on a Circle with nonzero history:

- detect that the active program has recorded history;
- classify the update as compatible in-place, new-era, or migration/import;
- for compatible updates, run a storage/read compatibility fixture suite against
  existing rows, capsules, roots, and public getters;
- require an explicit operator acknowledgement for new-era or migration paths;
- preserve the old program/Circle id in an era registry or predecessor pointer;
- verify the successor's first snapshot index and predecessor metadata;
- do not rewrite or fake-backfill old rows.

## Consequences

- Mainnet v1 prioritizes durable raw capsule history over derived indexes.
- Calendar trees remain a verified projection/read-acceleration layer, not the
  first canonical AML storage requirement.
- New chains and new RPC fields should usually enter through latest payloads or
  extension families, not core-row rewrites.
- Compatible additive upgrades are allowed, but only under an explicit
  storage/read compatibility gate.
- A later index program may live in a separate Circle or in a future
  multi-program Circle runtime if Octra adds that capability.
- The product can honestly say that each AML era is canonical for the period it
  actually recorded.
- The gateway remains a stitcher/verifier, not a source of historical truth.
