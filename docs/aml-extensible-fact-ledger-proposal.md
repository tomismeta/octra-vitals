# AML Extensible Fact Ledger Proposal

Status: proposed for review.

Date: 2026-06-23

This is a reimagining of the Octra Vitals AML history layer from scratch, with
the specific goal of keeping AML boring while making it naturally extensible to
new destination chains, new RPC fields, and derived values.

## Thesis

The AML should be generic about storage mechanics and strict about history
semantics.

It should not become a database, analytics engine, schema-less JSON store, or
chain-specific bridge interpreter. It should be an append-only, fixed-width,
schema-cataloged fact ledger.

The key ontology change is to stop treating "extensions" as a later add-on. The
first-class primitive should be a **fact family**:

```text
fact family = immutable fixed-width record stream with declared key cardinality and root domain
```

`core_accounting` is simply the required fact family. Route totals, future RPC
fields, diagnostics, and durable projections are additional families with their
own schemas, capsules, and roots.

## Design Stance

Optimize for the architecture we would still admire after the product grows.

The conservative path is a dedicated core log plus a separate auxiliary
substrate. That is acceptable as a fallback if devnet proves the generic shape
is too costly or too hard to verify, but it is not the design target. The target
is a single fact-family ledger where the core is family 0 and every durable
stream follows the same proof model.

This does not mean AML becomes dynamic or clever. "Generic" means the state
shape, capsule mechanics, roots, and getters are uniform. It does not mean AML
interprets arbitrary schemas, parses JSON, loops over unbounded arrays, or
performs analytics.

The admired version is:

```text
one append-only fact ledger
many tightly defined families
fixed-width rows
per-family roots
measured completeness commitment
semantics in schemas and verifiers
AML as recorder, not analyst
```

If this passes devnet cost, readback, and formal verification gates, prefer it
over a compromised hybrid.

## Why This Is Cleaner

The current mental model is:

```text
core row
extension rows if needed later
```

The proposed model is:

```text
family 0: core_accounting
family 1: route_totals
family 2: supply_components
family 3: relayer_diagnostics
family 4: projection_daily
...
```

That sounds like a small naming change, but it matters. It makes extensibility
native without making AML clever. AML does not know what Ethereum, Hyperliquid,
Monero, burned, unissued, relayers, or fees mean. AML only knows:

- family id;
- schema id;
- row length;
- key cardinality;
- capsule id;
- row bytes;
- family root;
- sealed capsule metadata.

The interpretation lives in schemas, docs, gateway verification, and browser
verification code. AML only preserves ordering, immutability, commitments, and
readability.

The core remains special by policy even though it uses the same substrate:

- `core_accounting` has a reserved family id;
- it is required for every snapshot;
- it has the strictest monotonicity and row-faithfulness checks;
- the conservation verdict cannot be served without it;
- any incompatible change to it starts a new era.

That gives core the safety it deserves without fragmenting the data model.

## Ontology

Use these terms consistently.

- **Snapshot:** one collection event at a specific observed time.
- **Snapshot index:** the monotonic observation key for one-per-snapshot
  families, and the common join point for source facts captured at a snapshot.
- **Latest bundle:** full current payload, evidence manifest, source refs,
  hashes, and current verdict. Rich, current, and hash-gated.
- **Fact family:** an append-only historical stream with one schema lineage, one
  key-cardinality rule, and one root lineage.
- **Core accounting family:** the required fact family that records the durable
  fields needed to recompute Octra Vitals' main conservation verdict.
- **Auxiliary fact family:** an optional family for durable non-core facts, such
  as route-level totals, detailed RPC fields, bridge counters, or relayer
  diagnostics.
- **Derived index family:** a derived family whose rows summarize other
  families over a period. Derived index families are optional, must use separate
  root domains, and must never substitute for retained source rows.
- **Fact row:** one fixed-width encoded observation in a family, keyed by
  the family's declared cardinality rule.
- **Family cardinality:** the ordering/key rule for a family:
  `one_per_snapshot`, `entity_per_snapshot`, or `period_projection`.
- **Capsule:** bounded group of fact rows for one family and deterministic time
  span.
- **Family definition:** immutable metadata defining a family id, schema, row
  length, key cardinality, codec hashes, and root domains.
- **Family state:** mutable coverage and tip metadata for a family.
- **Family root:** running commitment over a family.
- **Capsule metadata:** one packed metadata row for a family capsule.
- **Era:** a program/state-layout boundary. Compatible changes stay in an era;
  incompatible changes start a new era.
- **Absence state:** explicit non-value semantics such as
  `not_captured_before_activation`, `not_applicable`, `source_unavailable`,
  `pending`, or `zero`. Never backfill as zero.

## Proposed AML Shape

The AML state should have one generic family substrate plus latest-bundle state.

```text
owner
operator
paused
predecessor_program
successor_program

latest_snapshot_index
latest_snapshot_id
latest_payload
latest_evidence_manifest
latest_source_refs
latest_payload_hash
latest_evidence_hash
latest_source_refs_hash
latest_verdict_hash

family_count
family_id_by_ordinal[ordinal]
catalog_root
family_definition[family_id]
family_definition_hash[family_id]
family_state[family_id]
family_root[family_id]
family_latest_index[family_id]
family_open_capsule_id[family_id]
family_open_capsule_body[family_id]
family_open_capsule_row_count[family_id]
family_open_capsule_start_root[family_id]
family_open_capsule_end_root[family_id]
family_capsule_count[family_id]
family_capsule_body[family_id|capsule_id]
family_capsule_meta[family_id|capsule_id]
family_capsule_root_after[family_id|capsule_id]
```

The state is larger than a single hardcoded core row model, but the mechanics
are uniform. That is the trade: a small generic substrate up front to avoid a
series of future incompatible AML redesigns.

Completeness commitments are intentionally not part of the base state above.
They should be probed as a measured addition. Pattern A's atomic batch already
gives the first completeness boundary; a per-snapshot completeness map may be
too expensive to justify before Pattern B exists.

## Family Definition And State

Split immutable family definition from mutable family state. This is a
contract-grade rule, not just naming. "Append-only" should be enforced as
write-once fields and stable hashes.

Minimum immutable family definition fields:

```text
family_id
family_kind
family_cardinality
schema_id
schema_version
row_len
primary_key_type
entity_id_type
period_type
max_rows_per_snapshot
first_snapshot_index
source_family_ids_hash
schema_hash
row_codec_hash
field_manifest_hash
unit_scale_hash
null_semantics_hash
row_hash_domain
capsule_hash_domain
root_hash_domain
status
```

Minimum mutable family state fields:

```text
family_id
latest_covered_snapshot_index
latest_capsule_id
latest_capsule_root
coverage_status
successor_family_id
retired_at_snapshot_index
```

`family_kind` should be a small enum:

```text
0 core
1 source_auxiliary
2 diagnostic
3 projection
4 display_auxiliary
```

The catalog is append-only. A family definition cannot be reinterpreted. If the
schema changes incompatibly, create a new family id or a new schema id with
explicit coverage.

Keep family definitions structural. They should define how to store and verify
rows, not what the product should believe about them. Verdict requirements,
display labels, and derivation semantics should live in schema documents,
capture/verdict profiles, source refs, and verifier code committed by
`schema_hash`, `field_manifest_hash`, or `source_family_ids_hash`.

Use deterministic enumeration:

```text
family_count
family_id_by_ordinal[ordinal]
family_definition_hash[family_id]
catalog_root
```

Do not rely on gateway-local family discovery.

## Row Strategy

Rows should stay fixed-width. This is the boring part that makes AML feasible:

- no arbitrary JSON history rows;
- no variable field lists;
- no dynamic row parsing in AML;
- no semantic interpretation in AML beyond declared row length and monotonic
  index rules;
- no invented backfill.

Every row should include or be bound by a canonical header:

```text
family_id
schema_id
row_version
join_key
row_ordinal_or_entity_key
row_body
```

AML does not need to understand the body semantics, but it should enforce the
family id, schema id, row version, key shape, fixed length, and hash domains.

The core family should remain compact and stable:

```text
family_id = core_accounting
join_key = snapshot_index
row = row_version
      snapshot_index
      observed_at_unix
      octra_epoch
      external_block
      max_supply_raw
      issued_raw
      burned_raw
      encrypted_raw
      total_locked_raw
      total_wrapped_raw
      total_unclaimed_raw
      vault_balance_raw
      unit_status
      conservation_status
      route_count
      payload_hash
```

Additional fields should not be forced into this row unless they are truly part
of the durable core conservation invariant.

## Core Safety Inside The Generic Model

The generic model should not make the critical path mushy. Family 0 receives
extra invariants:

- exactly one `core_accounting` row per snapshot index;
- no snapshot is valid without the family 0 row;
- family 0 row hash must match the latest payload-derived row before serving
  latest data;
- shared capsule sealing must include the zero-margin overflow fix, such as a
  unique overflow capsule id, explicit headroom, or a recovery path;
- family 0 capsule sealing must be tested across the zero-margin boundary;
- family 0 schema changes are era-level changes unless byte-compatible;
- old family 0 rows must verify byte-identically under every compatible update.

This is how the design protects the most important path while keeping the
storage model unified.

## Gate 0: Formal Substrate Probe

Before building the full program, probe the smallest generic substrate that can
prove the abstraction:

```text
2-entry family definition catalog
append_to_family()
seal_family_capsule()
one_per_snapshot cardinality only
fixed-width rows
body/meta/root-after maps
write-once sealed capsules
```

This is the load-bearing gate. If AML cannot verify universal invariants over
`family_id` and composite-key maps, the elegant substrate fails early and the
fallback is a dedicated core log or a narrower hybrid.

Gate 0 must prove:

- family definitions are write-once;
- row length, family id, schema id, row version, and key shape are enforced;
- append order holds for every catalogued family;
- sealed capsules cannot be overwritten;
- body hash, metadata, start root, end root, and root-after agree;
- root domains include era/program id, family id, schema id, key, row ordinal,
  and row bytes;
- empty slots use the known safe sentinel and cannot be confused with real rows.

Only after Gate 0 passes should we spend effort on slot-count probes,
completeness commitments, route/entity fanout, or browser range reads.

## Write Path

The cleanest conceptual write is:

```text
record_snapshot(
  latest_bundle,
  core_accounting_row,
  auxiliary_family_rows
)
```

Because AML may not support easy loops, the implementation can still stay
boring by using bounded, unrolled writes.

### Preferred Pattern: Bounded Atomic Family Batch

`record_snapshot` accepts a fixed maximum number of auxiliary family rows. The
first implementation should support only `one_per_snapshot` families. That
keeps the proof to one ordering regime:

```text
next snapshot index == previous family latest index + 1
```

`entity_per_snapshot` families, such as per-route rows, need a different rule:

```text
snapshot index is non-decreasing
entity key is sorted and unique within the snapshot
rowset hash commits to all entities for that snapshot
```

That is valuable, but it multiplies the proof surface. Add it only after the
one-per-snapshot substrate proves out.

```text
core_row
aux_family_1_id, aux_row_1
aux_family_2_id, aux_row_2
aux_family_3_id, aux_row_3
...
```

Unused slots are empty. This keeps one snapshot atomic without requiring AML to
loop over arbitrary arrays. It is simple, but it caps the number of active
families per snapshot unless the cap is raised in a compatible update.

This is the preferred first implementation of the fact-family ledger for
`one_per_snapshot` families. It pushes the architecture forward without asking
AML to support unbounded iteration. The slot count should be chosen by devnet
measurement, not guessed.

For a mainnet candidate, probe at least:

```text
0 auxiliary slots
2 auxiliary slots
4 auxiliary slots
8 auxiliary slots
```

The active launch shape can still write only core rows. Empty slots do not mean
inactive families are deployed; they mean the method has future capacity.

For `entity_per_snapshot` families, the slot count means peak concurrent rows,
not peak concurrent families. Route totals may therefore dominate `K` once they
arrive. Do not size launch `K` around hypothetical route fanout until a route
family is actually ready to be captured.

### Fallback Pattern: Core First, Auxiliary Attachments

`record_snapshot` records the core row and latest bundle. Then
`attach_family_row(snapshot_index, family_id, row)` records auxiliary rows for
the same snapshot.

This is more extensible, but creates a partial-state window where the core row
exists before all optional families arrive. That is acceptable only if:

- core conservation never depends on optional families for the latest verdict;
- family coverage explicitly marks missing rows as not captured or pending;
- the UI can show family completeness honestly;
- AML forbids attaching rows outside allowed monotonic/coverage windows.

This pattern is less elegant for Vitals because it introduces a partial-state
window. Keep it as a future high-fanout escape hatch, not the first mainnet
target.

## Completeness Commitment

Completeness is the question:

```text
which family rows were part of this snapshot or capsule?
```

Do not make a high-cardinality per-snapshot map the default. At a 15-minute
cadence, `snapshot_family_set_hash[snapshot_index]` creates roughly 35,000 new
state entries per year, far more than capsule metadata. It also needs running
root checkpoints if historical completeness verification is expected to stay
bounded.

Probe completeness in three tiers:

### Tier A: Atomic Batch Completeness

With bounded Pattern A, all rows for a snapshot are written in one transition.
Completeness can be derived from:

- the accepted slot set;
- per-family coverage;
- per-family roots;
- the receipt/event for the atomic write.

This is the minimal launch posture if only family 0 is active.

### Tier B: Capsule-Level Completeness

Commit the set of families represented in a sealed capsule:

```text
capsule_family_set_hash =
  sha256(domain | capsule_id | family_id_0 | family_capsule_root_0 | ... | family_id_n | family_capsule_root_n)
```

This is much lower cardinality than a per-snapshot map and fits the capsule
model. It is the preferred completeness probe if multiple one-per-snapshot
families become active.

### Tier C: Per-Snapshot Completeness

Use `snapshot_family_set_hash[snapshot_index]` only if Pattern B attachments or
high-fanout entity families require it:

```text
snapshot_family_set_hash =
  sha256(domain | snapshot_index | family_id_0 | rowset_hash_0 | ... | family_id_n | rowset_hash_n)
```

If this tier is used, include canonical sorted family ids, schema ids, row
counts, absence states, and entity rowset hashes. Also store enough running-root
checkpoints to avoid all-history replay.

Completeness commitments do not replace per-family roots. They answer a
different question:

```text
per-family root: did this row exist in this family history?
completeness commitment: which families/rowsets were part of this snapshot or capsule?
```

## Read Path

Minimum AML getters:

```text
get_latest_bundle()
get_family_count()
get_family_id_at(ordinal)
get_family_definition(family_id)
get_family_state(family_id)
get_family_root(family_id)
get_family_capsule_meta(family_id, capsule_id)
get_family_capsule_body(family_id, capsule_id)
get_recent_capsule_id_at(family_id, ordinal)
get_roots()
```

The gateway and UI should be able to ask:

- What families exist?
- What schemas define them?
- What snapshot range does each family cover?
- What absence state applies when a row or family is missing?
- Does the committed schema/verifier treat this family as verdict-relevant?
- Which capsules cover this requested time/index range?
- Can I verify the family body against its root?

## Handling New Destination Chains

Do not hardcode chains into AML.

Add or use a route family:

```text
family_id: route_totals.v1
family_kind: source_auxiliary
family_cardinality: entity_per_snapshot
join_key: snapshot_index + route_id
row fields:
  row_version
  snapshot_index
  route_id
  dst_chain_id
  wrapped_raw
  unclaimed_raw
  bridge_balance_raw
  status
  source_hash
```

When Hyperliquid or Monero arrives, the same family can record additional route
ids if the row schema already supports them. If a fundamentally different
destination model appears, add a new route family instead of rewriting the old
one.

The latest bundle can show rich per-chain details immediately. Permanent
historical route rows start when the route family starts capturing them. Earlier
snapshots say "not captured."

Do not activate route history until the `entity_per_snapshot` ordering rule has
its own devnet proof. A simpler alternative is to pack a bounded route set into
one `one_per_snapshot` route-summary row, but that trades fanout complexity for
a fixed route cap. Either choice must be explicit.

## Handling New RPC Fields

Every new RPC field should be classified before changing AML:

```text
latest_only
core_invariant
auxiliary_durable
diagnostic_durable
derived_projection
```

Examples:

- A new RPC display field used only in the current provenance panel:
  `latest_payload`.
- A new field required to recompute supply conservation forever:
  consider core family only if stable and protocol-blessed.
- A new field useful for future audits but not core:
  auxiliary fact family.
- A new counter for updater or relayer health:
  diagnostic family.
- A daily min/max/first/last over locked or issued values:
  projection family derived from core.

This avoids reflexively widening the core row.

## Absence Semantics

Never collapse missing history into a single `null`.

Use distinct states:

```text
zero
not_captured_before_activation
not_applicable
source_unavailable
pending
invalid
```

These states matter for audits. `zero` is a measured value.
`not_captured_before_activation` is honest historical absence.
`not_applicable` means the family does not apply to that snapshot or entity.
`source_unavailable` means the producer tried but could not verify the source.
`pending` means an allowed attachment or source is not finalized yet. `invalid`
means the family row or source failed verification.

The first mainnet target should avoid `pending` by using bounded atomic writes.
If a future attachment pattern introduces pending states, the UI and verifier
must expose them directly.

## Handling Derived Values

Derived values should not be mixed with source observations unless they are part
of the signed verdict.

Use three levels:

1. **Render-time derived:** computed by gateway/UI from verified rows. Not
   persisted.
2. **Cached projection:** stored off-chain for speed, but recomputable from AML.
3. **Derived index family:** persisted in AML as a declared derived family if
   the value becomes product-critical.

A derived index family must declare:

```text
source_family_ids
source_schema_ids
period_type
derivation_rule_hash
coverage
derived_row_schema
```

Derived index rows are never a substitute for source rows.

## Verification Model

Each family is independently verifiable:

1. Fetch family definition and state.
2. Fetch capsule body and metadata.
3. Check row length and body hash.
4. Fold rows from capsule start root to end root.
5. Check capsule root checkpoint.
6. Check family root.
7. Join to core by `snapshot_index` when rendering a combined view.

This avoids one mega-root becoming a bottleneck. It also lets a verifier inspect
the exact proof boundary for each displayed value.

Completeness commitments are optional and separate from family verification.
For the push-the-limits design, probe capsule-level and per-snapshot
completeness rather than removing them from the architecture or accepting them
without cost data.

## Upgrade Model

This design reduces era churn but does not eliminate eras.

Same-era compatible changes:

- add a new family definition with an already-supported cardinality;
- activate a new auxiliary family under an already-supported cardinality;
- add getters that do not change old semantics;
- add a new schema id while preserving old decoders and old capsule immutability.

New era required:

- change core family row meaning incompatibly;
- reinterpret old rows;
- change map key formats;
- add a new cardinality regime if the existing program cannot verify it under
  the same invariants;
- remove or rename existing getters;
- change root domains;
- change how sealed capsules verify.

The goal is not "never have eras." The goal is that normal product evolution,
like new chains and new RPC fields, usually becomes a family addition instead
of an AML redesign.

## Tradeoffs

Pros:

- future chains and RPC fields have a native path;
- core accounting remains small and stable;
- old rows remain honest under their original schemas;
- every family has its own proof boundary;
- gateway stays an adapter/verifier rather than the source of history;
- fewer schema changes force new eras.

Cons:

- first AML is more general than the absolute-minimum capsule log;
- family definitions, family state, and per-family roots add state surface;
- generic write paths may be awkward in AML if loops are limited;
- optional-family completeness must be represented carefully;
- entity-per-snapshot families require a separate ordering proof;
- reviewers must reason about schema governance, not just one row layout;
- the full design must earn its way through devnet probes rather than being
  accepted on taste alone.

## Recommendation

If we are willing to push for the elegant version, use the **fact-family
ledger** as the first mainnet AML shape, subject to devnet proof.

The launch set can still be small:

```text
family 0: core_accounting      active
family 1: route_totals         added when needed
family 2: supply_components    added when needed
family 3: diagnostics          added when needed
```

Start with only `core_accounting` required for the conservation verdict. Include
the generic family substrate, bounded atomic family slots for
`one_per_snapshot` families, and per-family roots if Gate 0 proves the
universal family invariants. Probe completeness commitments separately.

This is the best balance between:

- AML-native permanence;
- boring implementation mechanics;
- extensibility for other chains;
- extensibility for future RPC fields;
- honest handling of derived values;
- minimal future era churn.

Recommended sequence:

1. Gate 0 formal substrate probe with two `one_per_snapshot` families.
2. Slot-count probe for 0, 2, 4, and 8 `one_per_snapshot` auxiliary slots.
3. Capsule boundary/overflow probe using the shared seal fix.
4. Completeness commitment A/B: none, capsule-level, per-snapshot.
5. Range-read/browser verification for real Circle reads.
6. Separate `entity_per_snapshot` route-family probe only when route history is
   ready to become durable AML history.

## Reviewer Questions

Ask reviewers to focus on these questions:

1. Is "fact family" the right top-level primitive, or does it hide too much
   semantics behind row bytes?
2. Should auxiliary rows be written atomically with the core snapshot, or
   attached after the core row?
3. What is the maximum family count we should support in the first AML without
   overengineering?
4. Should route totals wait for the `entity_per_snapshot` proof, or be packed
   into a bounded `one_per_snapshot` summary row?
5. Should completeness be atomic-only, capsule-level, or per-snapshot?
6. Are projection families worth including in the substrate now, or should they
   remain purely off-chain until needed?
7. What exact compatibility fixture suite is required before any same-era AML
   update?
8. Does the bounded atomic batch preserve enough future capacity without making
   first-mainnet writes too expensive?
9. Should first mainnet support only `one_per_snapshot` families, with
    `entity_per_snapshot` deferred until route history is imminent?
