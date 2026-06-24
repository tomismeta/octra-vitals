# AML Typed Metric Facts Mainnet Proposal

Status: accepted for fact-v2 devnet rehearsal; mainnet target pending soak.

Date: 2026-06-24

This proposal refines the current fact-ledger design so the first mainnet AML
era can absorb ordinary future metric changes without repeated AML redesigns.

It should be read alongside:

- [AML Extensible Fact Ledger Proposal](aml-extensible-fact-ledger-proposal.md)
- [AML Fact Ledger Implementation Brief](aml-fact-ledger-implementation-brief.md)
- [ADR 0002: AML History Era Model](adr-0002-aml-history-era-model.md)

## Decision Thesis

For mainnet, prefer one clean foundation:

```text
mandatory core accounting history
+ optional typed scalar metric history
+ latest full payload/evidence/source refs
+ immutable family capsules and roots
```

The goal is not to predict every future metric. The goal is to make the first
mainnet AML era flexible enough that normal product/source evolution does not
force a new AML program.

This is not arbitrary key/value storage. It is a small typed metric substrate:

```text
registered metric ids
fixed-width rows
bounded optional slots
explicit status values
payload-hash binding
immutable capsule history
```

## Design Principles

1. **AML is a recorder, not an analyst.**
   AML preserves facts, order, roots, and immutability. It does not compute
   charts, parse arbitrary JSON, or interpret business labels.

2. **Core remains mandatory and special.**
   Family `0000` remains the conservation/accounting backbone. It is required
   for every snapshot and keeps the strongest AML faithfulness checks.

3. **Optional metrics are typed, not free-form.**
   Future scalar values use registered ids, units, source classes, and status
   codes. No free-form names or schema-less values are stored in AML.

4. **Extensibility is bounded.**
   Mainnet gets a small optional metric budget. If a future need exceeds that
   budget, that is a real design change and should require a new AML decision.

5. **Absence is explicit.**
   Missing, unavailable, deprecated, pending, and not-yet-captured values must
   never be silently rendered as zero.

6. **Launch can still be quiet.**
   Mainnet may launch with `aux_count = 0`. The capability exists from day one,
   but optional metrics do not need to be active until there is a real need.

## Current Model

The current devnet fact-ledger path is already structurally sound, but the live
write path is core-only:

```text
record_snapshot_fact_v1(...)
  writes latest payload/evidence/source refs
  writes summary row
  writes core accounting family 0000
  seals/verifies core capsules
```

That handles:

- latest payload expansion;
- raw evidence expansion;
- UI label changes;
- UI-only derived values;
- latest-only route display.

It does not yet give us a clean durable historical home for new scalar facts
such as:

- burned and unissued as separate permanent series;
- per-chain wrapped/locked/unclaimed aggregates;
- new Octra RPC scalar fields;
- bridge residuals or other durable derived scalar checks.

## Proposed Mainnet Shape

Add a bounded typed metric surface to the existing fact-ledger program:

```text
record_snapshot_fact_v2(...)
  writes the same latest bundle
  writes the same mandatory core family 0000
  optionally writes typed scalar metric rows
```

The current core substrate remains the foundation. This proposal adds only the
minimum machinery needed to register and append optional scalar facts.

The implemented devnet rehearsal shape is intentionally launch-quiet:

```text
FACT_LEDGER_MANIFEST = octra-vitals-fact-ledger.v2
MAX_AUX_FACT_ROWS_PER_SNAPSHOT = 4
launch aux_count = 0
initial registered family set = core accounting only
```

The AML can append auxiliary fact rows once a metric family is registered, but
the first devnet/mainnet-shaped launch records only the core accounting family.
That lets us prove the dormant capability overhead before activating optional
metric history.

## Metric Ontology

Use these terms consistently.

- **Metric:** a named scalar observation such as `burned_raw`,
  `ethereum_wrapped_raw`, or `bridge_residual_raw`.
- **Metric id:** compact stable id used in AML rows.
- **Metric registry:** human-readable, content-addressed asset mapping metric
  ids to names, descriptions, units, source paths, and lifecycle.
- **Metric family:** AML family that stores metric facts using a fixed schema.
- **Metric row:** one fixed-width historical record bound to a snapshot index
  and canonical payload hash.
- **Metric status:** explicit state of the value, such as captured,
  unavailable, pending, deprecated, or not captured before activation.

## Registry

Metric meaning lives in a governed registry, not in AML labels.

The Site Circle should publish a `metrics.registry.json` asset. It is part of
the integrity surface and should be treated as load-bearing documentation.

Each registry entry should include:

```text
metric_id
label
description
unit_id
value_kind
source_class
source_path
derived_from_metric_ids
activation_snapshot_index
deprecation_snapshot_index
display_precision
registry_entry_hash
```

AML stores only the compact fields needed to enforce row shape and bind rows to
the registry:

```text
metric_id
schema_id
row_len
unit_id
value_kind
source_class
activation_snapshot_index
deprecation_snapshot_index_or_zero
registry_entry_hash
```

Definitions are write-once. A semantic correction creates a new metric id or
schema id; it does not mutate history.

## Packed Metric Row Shape

The selected encoding is a packed metric row family. It keeps one historical row
per snapshot for a bounded group of scalar metrics instead of one family per
metric. This is the option most consistent with reducing future AML churn: a few
packed rows can carry many metric slots without creating a new family stream for
every ordinary scalar.

The implemented packed row is 295 bytes, the same width as the core row, and
keeps the full payload hash at byte offset 231 so it can reuse the existing fact
row hash and capsule machinery:

```text
row_version
snapshot_index
observed_at_unix
metric_family_id
schema_id
slot_count
slot[0..3]
reserved
payload_hash_hex
```

Each slot is 42 bytes:

```text
metric_id(4)
unit_id(4)
status(2)
source_class(2)
signed_value_raw(30)
```

Implemented status codes:

```text
00 captured
01 zero
02 not_captured_before_activation
03 source_unavailable
04 invalid
99 empty
```

`zero` is separate from `not_captured`. That distinction is part of the trust
model.

## Storage Shape

Use a small number of optional auxiliary rows per snapshot. Each auxiliary row
is fixed-width and validated by AML.

Preferred launch probe:

```text
MAX_AUX_ROWS_PER_SNAPSHOT = 4
stress probe = 8
upper-bound probe = 16
```

Pick the smallest value that passes devnet with comfortable cost/headroom and
still covers the realistic first wave of durable scalar metrics.

### Per-Metric Family vs Packed Metric Row

There are two viable encodings.

**Option A: one scalar metric per family.**

Pros:

- clean independent lifecycle;
- one root per metric;
- easy proof boundary;
- easy activation/deprecation.

Cons:

- N active metrics means N extra family streams;
- write cost and read cost scale linearly with active metric count;
- many chains can consume the budget quickly.

**Option B: packed metric row family.**

Pros:

- one auxiliary row can carry several metric slots;
- lower write/read overhead for many scalar metrics;
- fewer family streams and capsules;
- still fixed-width and governed.

Cons:

- metrics in a packed row share one proof boundary;
- lifecycle is more coupled;
- AML must validate slot ordering/empties or delegate more to gateway checks;
- harder to activate a single metric independently.

Selected direction:

```text
Use packed rows for the first mainnet-shaped fact-ledger era.
Keep aux_count = 0 at launch.
Activate optional metric families only when a real durable scalar needs history.
```

Local sample-call measurement shows the dormant v2 surface adds 14 bytes over
fact-v1, about 0.21% of the compact message. Live devnet receipts should still
be used to confirm actual effort/cost before mainnet.

## Write Path

Conceptual call:

```text
record_snapshot_fact_v2(
  canonical_payload,
  canonical_evidence_manifest,
  canonical_source_refs,
  summary_row,
  core_history_row,
  observed_at,
  capsule_base_id,
  epoch_id,
  snapshot_index,
  aux_count,
  aux_row_0,
  aux_row_1,
  aux_row_2,
  aux_row_3
)
```

AML verifies:

- core row is present and valid;
- `aux_count <= MAX_AUX_ROWS_PER_SNAPSHOT`;
- unused slots contain the empty sentinel;
- auxiliary rows use registered metric definitions;
- schema id and row length match the definition;
- snapshot index matches the core row;
- payload hash prefix matches the canonical payload hash;
- rows are sorted by metric/family id to prevent duplicates;
- each active auxiliary stream appends monotonically;
- capsule mechanics and root folding match the core family model.

`aux_count = 0` must remain a first-class path and should be close to today's
cost. That lets mainnet launch without optional metrics while preserving the
future surface.

## What Becomes Config/Product Work

With this surface in mainnet v1, these should usually avoid AML code changes:

| Future change | Path |
| --- | --- |
| Add latest-only RPC field | latest payload/evidence |
| Add UI-only derived value | gateway/browser |
| Rename a displayed category | UI/registry copy |
| Add latest-only chain route | payload routes |
| Add durable scalar metric | registry + auxiliary metric row |
| Split burned/unissued into durable facts | register two metric ids |
| Add per-chain aggregate scalar | register metric ids or packed slots |
| Deprecate a metric | registry lifecycle + status |
| Add durable derived scalar | register derived metric id |

## What Still Requires AML Change

These should remain explicit AML decisions:

| Future change | Why |
| --- | --- |
| Need more auxiliary rows than the chosen budget | Changes write bound and proof/cost surface |
| Need variable-cardinality entity/route fanout | Different ordering and completeness model |
| Need per-snapshot completeness across many entities | New invariant |
| Need larger payload/evidence/source-ref caps | AML-enforced limits |
| Need new capsule row limits | Storage/proof constants |
| Need hash/root semantic changes | Commitment model |
| Need authorization/governance changes | Security model |
| Need non-scalar or variable-width values | New codec/proof surface |

The aim is not to make AML never change. The aim is to make normal scalar
source evolution avoid AML changes.

## Completeness

Launch completeness model:

```text
core accounting: mandatory, enforced
typed scalar metrics: optional, explicit if present
multi-entity completeness: deferred
```

Do not claim a snapshot has all possible metrics. Claim only what was captured
and what the active registry says should be interpreted.

If the product later needs a stronger statement like "all active destination
chains were captured for snapshot N," that becomes a route/entity completeness
design. It should not be hidden inside scalar metrics.

## Layer Changes

### AML

Required:

- compact metric definition registration;
- scalar metric row validator;
- `record_snapshot_fact_v2`;
- bounded auxiliary row slots;
- duplicate prevention through sorted ids;
- family/capsule append using existing mechanics;
- getters for metric definitions and auxiliary capsule state.

Keep unchanged:

- core family `0000`;
- latest payload/evidence/source-ref state;
- capsule seal mechanics;
- predecessor/successor anchors;
- caller authorization;
- latest compatibility getters.

### Producer

Required:

- keep building the current core row;
- load the metric registry;
- encode active optional metric rows;
- emit deterministic ordering and empty sentinels;
- report auxiliary sizes/headroom;
- keep `aux_count = 0` as default until metrics are enabled.

### Gateway/API

Required:

- verify registry asset hash;
- read metric definitions;
- verify auxiliary family/capsule roots;
- normalize optional metrics into API fields;
- expose absence states;
- add richer `/api/history` proof metadata.

### UI

No UI change is required to adopt the storage model.

When metrics become visible, the UI should consume normalized API fields and
show value, absence state, and proof/source status. It should not decode AML
rows directly.

### Site Circle

Required if enabled:

- publish `metrics.registry.json`;
- include it in site integrity checks;
- include metric registry hash in producer audit metadata.

## Devnet Proof Plan

Before mainnet, run a focused devnet proof:

1. Implement the smallest `fact-v2` candidate.
2. Compile/formally verify with 4 auxiliary slots.
3. Stress compile/formally verify with 8 and 16 slots.
4. Run `aux_count = 0` snapshots and compare to today's cost.
5. Run representative active metric snapshots.
6. Test packed-row and per-metric-family variants if both remain plausible.
7. Seal through a capsule with auxiliary metrics active.
8. Restart/resume across auxiliary-family seal.
9. Verify `/api/latest` and `/api/history` remain stable.
10. Verify registry/site-integrity behavior.
11. Record write effort, fee, size headroom, read latency, and program size.

## Mainnet Recommendation

Preferred mainnet path:

```text
include typed metric capability before mainnet
launch with aux_count = 0 unless a real metric is ready
keep product/UI surface minimal
use registry to activate future durable scalar metrics
```

Fallback:

```text
if devnet proof makes the surface costly, awkward, or hard to verify,
launch current core-only fact ledger and rely on eras or compatible updates
later.
```

The cleanest mainnet shape is not the smallest possible AML. It is the smallest
AML that gives us the right long-term foundation.

This proposal is the candidate for that foundation.
