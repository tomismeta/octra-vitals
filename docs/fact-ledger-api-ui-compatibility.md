# Fact Ledger API and UI Compatibility Evaluation

Status: design evaluation.

Date: 2026-06-23

## Question

Does the fact-family ledger design fit cleanly with the existing API and UI
layers, while preserving extensibility and useful history views?

## Short Answer

Yes, if the gateway becomes the family-aware verifier and adapter, and the UI
continues to render a stable normalized history contract.

The UI should not learn AML storage details such as family maps, capsule ids, or
root checkpoints as its primary data model. It should receive verified,
normalized history rows plus proof metadata. The gateway should read fact
families from AML, verify them, stitch eras, and expose a browser-friendly
history shape.

This keeps the product thin and Octra-native:

```text
AML: immutable fact families, capsules, roots, latest bundle
Gateway: verified adapter, range reader, proof envelope, no invented history
UI: normalized rows, proof status, absence states, responsive history controls
```

## Current Code Shape

The current UI already has the right basic seam.

`app/app.js` renders history from:

```text
/api/history -> snapshots[]
```

Each row is normalized into a compact series:

```text
observed_at
octra_epoch
issued
encrypted
locked
woct
unclaimed
unclassified
burned
```

The 1d, 7d, and 30d controls filter this normalized series by timestamp. That
means the visual layer can survive the AML redesign as long as `/api/history`
continues to provide verified rows with the same semantic fields.

The gateway now has the first fact-family adapter seam. In
`src/lib/program-state.ts`, history readback supports:

- the old summary-window getters; and
- the interim v1 capsule shape by reading the open capsule or latest sealed
  capsule; and
- the fact-family core history shape by reading recent sealed capsules by
  ordinal plus the open capsule.

That is sufficient for the first 1d, 7d, and 30d gateway views once the
fact-ledger program is live and the capsule read limit covers the requested
range. It is not yet sufficient for direct Circle-native browser verification,
1y/all-time views, or cross-era history stitching.

## Required API Evolution

Keep `/api/history` as the compatibility contract, but version and enrich it.

Recommended response shape:

```json
{
  "schema": "octra-vitals-snapshot-history-v0",
  "api_schema": "octra-vitals-history-api-v1",
  "history_model": "fact_family",
  "generated_at": "2026-06-23T00:00:00Z",
  "request": {
    "window": "30d",
    "from_index": 1,
    "to_index": 1234,
    "valid": true,
    "errors": []
  },
  "coverage": {
    "status": "complete",
    "from_observed_at": "2026-06-01T00:00:00Z",
    "to_observed_at": "2026-06-23T00:00:00Z",
    "points": 2112
  },
  "authority": {
    "canonical_state_read": true,
    "state_target_mode": "circle_program",
    "state_target_id": "oct...",
    "history_discovery": "aml_fact_family"
  },
  "proof": {
    "proof_status": "fact_family_verified",
    "eras": [],
    "families": [],
    "capsules": []
  },
  "snapshots": []
}
```

The existing `snapshots[]` field should remain the primary UI input. The new
metadata lets the UI explain coverage, proof status, and era boundaries without
knowing how to decode every AML structure.

Add query support:

```text
GET /api/history?window=1d
GET /api/history?window=7d
GET /api/history?window=30d
GET /api/history?from_index=...&to_index=...
GET /api/history?from=...&to=...
```

The gateway should select the minimum required capsules for the requested range,
verify them, normalize family 0 rows, and include coverage metadata. It should
not always fetch all retained history for the first paint.

## Gateway Responsibilities

The gateway must become family-aware, but stay boring.

Required capabilities:

- discover family definitions and family state from AML;
- locate capsules covering a requested snapshot or time range;
- fetch capsule bodies and metadata;
- verify row length, body hash, start root, end root, and root-after;
- verify family roots against AML state;
- decode family 0 into the normalized history fields;
- expose absence states instead of inventing zeros;
- stitch eras while preserving visible proof boundaries;
- compare multiple RPC endpoints where configured;
- cache verified results only as a performance layer, never as the source of
  truth.

The gateway may compute display-only derived values, such as unclassified or
downsampled chart points, from verified rows. It must label those as derived and
must not persist them as canonical unless a future derived index family is
explicitly added to AML.

## Browser/UI Responsibilities

The UI should remain proof-aware but storage-agnostic.

It should:

- render the same first-viewport latest state from `/api/latest`;
- hydrate history after first paint, as it does today;
- request only the selected history window when possible;
- treat `snapshots[]` as the chart source of truth;
- show incomplete coverage honestly;
- show era boundaries in verify/provenance surfaces, not as disruptive visual
  clutter in the main flow;
- render missing family data as an explicit absence state;
- avoid gateway-local fallback history in production.

The direct Circle-native browser path needs a second implementation pass. Today
`loadNativeProgramHistory()` reads the old summary-window getters. Under the
fact-ledger design it should either:

1. read the same fact-family getters directly and verify capsules in the
   browser; or
2. intentionally fall back to gateway history in normal browsers while marking
   the path as gateway-integrity-verified, not fully Circle-native.

For the product claim, option 1 is the long-term target.

## History Views

The fact-family ledger preserves history views cleanly.

For the first implementation:

- 1d, 7d, and 30d views can be rendered from verified family 0 rows;
- the API should return exactly the row range needed for the selected horizon;
- the UI can continue filtering by timestamp as a fallback;
- if a requested horizon spans multiple capsules, the gateway verifies each
  capsule and returns one normalized timeline;
- if it spans multiple eras, the gateway returns one visual timeline plus proof
  metadata identifying the era for each segment.

Longer horizons are still possible:

- `1y` can use raw rows if read performance is acceptable;
- if raw reads are too heavy, add a derived projection family later;
- projection families must never replace retained source rows;
- a chart may use projection rows for overview while allowing drilldown to raw
  15-minute rows.

## Extensibility Check

### Adding New Chains

Latest view:

- add routes to the latest payload immediately;
- UI route/bracket rendering can stay dynamic.

Durable history:

- add a route family only when route history is ready to be permanent;
- use `entity_per_snapshot` only after a separate proof gate; or
- use a bounded `one_per_snapshot` route-summary family if a fixed route cap is
  acceptable.

The API should expose route-family data separately from core history and join it
by `snapshot_index` when a view needs it.

### Splitting Burned And Unissued

Latest view:

- expose both in the latest payload once protocol/RPC semantics are settled.

Durable history:

- if the split becomes part of the conservation invariant, it may require a new
  core schema or new era;
- if it is useful but not core, add a supply-components auxiliary family;
- old rows must remain under their original schema and should show
  `not_captured_before_activation` for the new field.

This is exactly the kind of change the fact-family design handles better than a
single widened core row.

## Risks

The design is clean, but the API/UI layer has real work before mainnet:

- current history readback reads a bounded recent capsule suffix, not arbitrary
  historical ranges;
- current browser-native history reads only old summary-window methods;
- current `/api/history` has only the first range query and coverage model;
- current fact-family readback verifies capsule body hashes and folded roots in
  the gateway, but proof metadata still needs populated family/capsule detail
  before cutover;
- current history cache is a single whole-window cache, not keyed by
  target/range/family/era.

None of these undermine the architecture. They are adapter work and should be
explicit devnet gates.

## Recommendation

Proceed with the fact-family ledger design, but make the API/UI compatibility
work part of the implementation plan, not a later polish pass.

Implementation order:

1. Define a `HistoryApiV1` TypeScript type and fixture suite.
2. Preserve the current `/api/history` `snapshots[]` compatibility field.
3. Add range/window parameters and coverage metadata.
4. Add fact-family discovery and range readback in `program-state.ts`.
5. Add gateway verification for capsule ranges and era boundaries.
6. Keep UI rendering against normalized rows.
7. Update direct browser-native history reads after the AML getter set is final.
8. Add tests for v0 summary-window, interim v1 capsule, and fact-family history
   fixtures so old/devnet paths do not regress during the transition.

This gives the user experience the same simple mental model:

```text
pick a horizon -> see verified history
```

while letting AML evolve into the more extensible, permanent fact-family ledger
underneath.
