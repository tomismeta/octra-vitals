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
fact family = versioned stream of fixed-width rows joined to snapshot_index
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
global snapshot completeness root
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
- snapshot index;
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
- **Snapshot index:** the monotonic join key across all fact families.
- **Latest bundle:** full current payload, evidence manifest, source refs,
  hashes, and current verdict. Rich, current, and hash-gated.
- **Fact family:** an append-only historical stream with one schema lineage and
  one root lineage.
- **Core accounting family:** the required fact family that records the durable
  fields needed to recompute Octra Vitals' main conservation verdict.
- **Auxiliary fact family:** an optional family for durable non-core facts, such
  as route-level totals, detailed RPC fields, bridge counters, or relayer
  diagnostics.
- **Projection family:** a derived fact family whose rows summarize other
  families over a period. Projection families are optional and must declare
  source families and derivation rules.
- **Fact row:** one fixed-width encoded observation in a family, keyed by
  `snapshot_index` or by a declared period key for projection families.
- **Capsule:** bounded group of fact rows for one family and deterministic time
  span.
- **Family catalog entry:** append-only metadata defining a family id, schema,
  row length, domain strings, coverage start, and whether it is required for a
  verdict.
- **Family root:** running commitment over a family.
- **Capsule metadata:** one packed metadata row for a family capsule.
- **Era:** a program/state-layout boundary. Compatible changes stay in an era;
  incompatible changes start a new era.
- **Not captured:** explicit absence before a family or field existed. Never
  backfill as zero.

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

family_catalog[family_id]
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

snapshot_family_set_hash[snapshot_index]
global_snapshot_root
```

The state is larger than a single hardcoded core row model, but the mechanics
are uniform. That is the trade: a small generic substrate up front to avoid a
series of future incompatible AML redesigns.

## Family Catalog

Each family catalog entry should be fixed-width or otherwise tightly bounded.

Minimum fields:

```text
family_id
family_kind
schema_id
schema_version
row_len
join_key_type
first_snapshot_index
latest_snapshot_index
source_family_ids_hash
schema_hash
row_hash_domain
capsule_hash_domain
root_hash_domain
status
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

Keep the catalog structural. It should define how to store and verify rows, not
what the product should believe about them. Verdict requirements, display
labels, and derivation semantics should live in schema documents, source refs,
and verifier code committed by `schema_hash` or `source_family_ids_hash`.

## Row Strategy

Rows should stay fixed-width. This is the boring part that makes AML feasible:

- no arbitrary JSON history rows;
- no variable field lists;
- no dynamic row parsing in AML;
- no semantic interpretation in AML beyond declared row length and monotonic
  index rules;
- no invented backfill.

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
- family 0 capsule sealing must be tested across the zero-margin boundary;
- family 0 schema changes are era-level changes unless byte-compatible;
- old family 0 rows must verify byte-identically under every compatible update.

This is how the design protects the most important path while keeping the
storage model unified.

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

`record_snapshot` accepts a fixed maximum number of auxiliary family rows.

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

This is the preferred first implementation of the fact-family ledger. It pushes
the architecture forward without asking AML to support unbounded iteration. The
slot count should be chosen by devnet measurement, not guessed.

For a mainnet candidate, probe at least:

```text
0 auxiliary slots
2 auxiliary slots
4 auxiliary slots
8 auxiliary slots
```

The active launch shape can still write only core rows. Empty slots do not mean
inactive families are deployed; they mean the method has future capacity.

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

## Snapshot Completeness Root

The proposal includes `snapshot_family_set_hash[snapshot_index]` and
`global_snapshot_root` as the cross-family completeness proof.

For each snapshot, AML commits to the set of family rows accepted with that
snapshot:

```text
snapshot_family_set_hash =
  sha256(domain | snapshot_index | family_id_0 | row_hash_0 | ... | family_id_n | row_hash_n)
```

Then `global_snapshot_root` folds the snapshot family-set hash over time. This
does not replace per-family roots. It answers a different question:

```text
per-family root: did this family row exist in this family history?
global snapshot root: which family rows were part of this snapshot?
```

If devnet shows this is too expensive, it can be deferred. But if it fits, it is
the elegant way to prove cross-family completeness without trusting gateway
bookkeeping.

## Read Path

Minimum AML getters:

```text
get_latest_bundle()
get_family_catalog(family_id)
get_family_ids()
get_family_roots()
get_family_capsule_meta(family_id, capsule_id)
get_family_capsule_body(family_id, capsule_id)
get_recent_capsule_ids(family_id, limit)
get_global_roots()
get_snapshot_family_set_hash(snapshot_index)
```

The gateway and UI should be able to ask:

- What families exist?
- What schemas define them?
- What snapshot range does each family cover?
- Does the committed schema/verifier treat this family as verdict-relevant?
- Which capsules cover this requested time/index range?
- Can I verify the family body against its root?

## Handling New Destination Chains

Do not hardcode chains into AML.

Add or use a route family:

```text
family_id: route_totals.v1
family_kind: source_auxiliary
join_key: snapshot_index
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

## Handling Derived Values

Derived values should not be mixed with source observations unless they are part
of the signed verdict.

Use three levels:

1. **Render-time derived:** computed by gateway/UI from verified rows. Not
   persisted.
2. **Cached projection:** stored off-chain for speed, but recomputable from AML.
3. **Projection family:** persisted in AML as a declared derived family if the
   value becomes product-critical.

A projection family must declare:

```text
source_family_ids
source_schema_ids
period_type
derivation_rule_hash
coverage
projection_row_schema
```

Projection rows are never a substitute for source rows.

## Verification Model

Each family is independently verifiable:

1. Fetch family catalog entry.
2. Fetch capsule body and metadata.
3. Check row length and body hash.
4. Fold rows from capsule start root to end root.
5. Check capsule root checkpoint.
6. Check family root.
7. Join to core by `snapshot_index` when rendering a combined view.

This avoids one mega-root becoming a bottleneck. It also lets a verifier inspect
the exact proof boundary for each displayed value.

`global_snapshot_root` is optional but useful. It can commit to which family
rows were attached for a snapshot, making completeness easier to prove. If AML
cost is high, it can be deferred as long as each required family has explicit
coverage and roots.

For the push-the-limits design, include it in the devnet probe rather than
removing it from the architecture.

## Upgrade Model

This design reduces era churn but does not eliminate eras.

Same-era compatible changes:

- add a new family catalog entry;
- activate a new auxiliary family;
- add getters that do not change old semantics;
- add a new schema id while preserving old decoders and old capsule immutability.

New era required:

- change core family row meaning incompatibly;
- reinterpret old rows;
- change map key formats;
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
- family catalog and per-family roots add state surface;
- generic write paths may be awkward in AML if loops are limited;
- optional-family completeness must be represented carefully;
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
the generic family substrate, bounded atomic family slots, per-family roots, and
the global snapshot completeness root if devnet proves their cost and readback
are acceptable.

This is the best balance between:

- AML-native permanence;
- boring implementation mechanics;
- extensibility for other chains;
- extensibility for future RPC fields;
- honest handling of derived values;
- minimal future era churn.

## Reviewer Questions

Ask reviewers to focus on these questions:

1. Is "fact family" the right top-level primitive, or does it hide too much
   semantics behind row bytes?
2. Should auxiliary rows be written atomically with the core snapshot, or
   attached after the core row?
3. What is the maximum family count we should support in the first AML without
   overengineering?
4. Should route totals be active at launch or only scaffolded?
5. Should `global_snapshot_root` be included immediately to prove which family
   rows were present per snapshot?
6. Are projection families worth including in the substrate now, or should they
   remain purely off-chain until needed?
7. What exact compatibility fixture suite is required before any same-era AML
   update?
8. Does the bounded atomic batch preserve enough future capacity without making
   first-mainnet writes too expensive?
9. Does `global_snapshot_root` fit comfortably enough to justify making
   cross-family completeness first-class from day one?
