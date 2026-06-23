# AML History v1 Successor Plan

Status: draft handoff for the next devnet implementation. Mainnet is not in scope until this passes devnet gates.

Devnet operational cutover steps are captured in [AML History v1 Devnet Cutover Runbook](aml-history-v1-devnet-cutover.md).

## Objective

Move Octra Vitals from a bounded recent window to AML-native forever history from the v1 cutover point forward.

The design keeps the current architecture principle:

```text
AML/programmed Circle = canonical state, ordering, hashes, and history
gateway = thin browser/RPC adapter
UI = verifier and renderer
host archive = raw evidence bodies by hash, non-canonical
```

No fake backfill. v0 history remains what v0 actually retained. v1 starts a new program-scoped history sequence or explicitly seeds from the predecessor final index.

The upgrade model is captured in [ADR 0002: AML History Era Model](adr-0002-aml-history-era-model.md). AML history programs are canonical for the rows they actually record. A future schema change should create an explicit era, or use a separately audited import path, rather than silently pretending a new program owns old state.

## Data Constructs

Use these terms consistently.

| Construct | Stored where | Purpose |
| --- | --- | --- |
| Latest bundle | AML state | Full current snapshot payload, evidence manifest, source refs, summary row, hashes, status, successor pointers. |
| Observation row | AML capsule body | One compact 15-minute accounting observation. This is the permanent granular history record. |
| Capsule body | AML map value | Fixed-width concatenation of observation rows for one deterministic UTC time span. |
| Capsule metadata | AML map value | Packed row with capsule id, row count, row length, body hash, start root, end root, capsules-root-before checkpoint, optional tx-index hash, and schema ids. |
| Capsule root checkpoint | AML map value | Running capsule root after each sealed capsule. Stored outside the meta row to avoid circular hashing. |
| Transaction lookup index | Deferred | Useful for forensic lookup, but not in the v1 MVP because the sealing transaction cannot know its own hash. |
| Calendar stat node | AML map value | Derived hour/day/month/year first/last/min/max/count/status node for long-horizon reads. |
| History root | AML scalar/meta | Running row root after each capsule or open capsule. |
| Capsules root | AML scalar/meta | Running commitment over sealed capsules in canonical order. |
| Calendar root | AML scalar/meta | Commitment over calendar nodes. |
| Raw evidence archive | VPS/archive storage | Full RPC/eth_call bodies by content hash. Useful and public, but not canonical AML history. |

Avoid "pages" for this design. The durable units are observation rows, capsules, and calendar nodes.

## State Shape

Recommended AML state for the v1 successor programmed Circle:

```text
owner
operator
paused
successor_program
predecessor_program
history_schema_id
calendar_schema_id
snapshot_count
latest_snapshot_index
latest_snapshot_id
latest_payload
latest_evidence_manifest
latest_source_refs
latest_summary_row
latest_payload_hash
latest_evidence_hash
latest_source_refs_hash
latest_summary_hash
open_capsule_id
open_capsule_body
open_capsule_row_count
open_capsule_start_root
open_capsule_end_root
history_root
capsules_root
calendar_root
capsule_count
history_capsule_body_by_id[capsule_id]
history_capsule_meta_by_id[capsule_id]
history_capsule_root_after_by_id[capsule_id]
calendar_node_by_tier_period[tier_period_id]
extension_family_catalog[family_id]
extension_capsule_body_by_family_id[family_id|capsule_id]
extension_capsule_meta_by_family_id[family_id|capsule_id]
```

The MVP can omit extension capsules, transaction lookup indexes, and hour/month/year nodes if the devnet cost gate says to start smaller. It should not omit core observation rows, capsule metadata, start/end roots, or full latest provenance strings. Calendar/tree nodes are derived indexes, not the source log; adding them later is an era/index decision unless Octra exposes a compatible multi-program Circle model.

## Core Row

The core observation row stays fixed-width and versioned. Current fields:

```text
row_version
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
payload_hash_hex
```

This preserves the data elements we already persist today, plus the hash pointer needed for forensic recovery. Future fields should use a new row version or extension family. Older rows remain truthful under their original schema.

## Write Path

`record_snapshot_v1(...)` should be one atomic transition:

1. Verify caller is the operator and program is not paused.
2. Enforce strict monotonicity by `snapshot_index` and observed time.
3. Verify input hashes for latest payload, evidence, source refs, and summary row.
4. Recompute or validate the compact observation row.
5. Append the observation row to the open capsule body.
6. Update open capsule metadata and history root.
7. Update calendar stat nodes for the active UTC period.
8. If the capsule reaches the row limit or a deterministic time boundary, seal it:
   - store body by capsule id;
   - store metadata by capsule id;
   - fold capsules root;
   - reset open capsule for the next period.
9. Set latest bundle fields.
10. Emit a receipt/event with snapshot id, index, row hash, capsule id, and conservation status.

The probe currently uses separate append/seal calls for measurement. The real v1 method should combine the boundary seal with the snapshot write so the updater remains one transaction per snapshot.

## Production Guards

The probe proves the storage mechanics, not the complete production safety surface. The v1 AML must add these guards before mainnet:

- **Sealed capsule immutability:** `record_snapshot_v1` must reject any seal if `history_capsule_body_by_id[capsule_id]`, metadata, or tx-index already exists. A sealed capsule id is write-once forever.
- **Capsule id time binding:** the program must bind `capsule_id` to `observed_at_unix` using deterministic UTC period rules, so an operator cannot accidentally or maliciously store a row under the wrong capsule.
- **Single atomic write:** append and boundary seal must happen inside one `record_snapshot_v1` transition. The updater should not need a separate seal transaction.
- **Latest-row faithfulness:** because AML cannot parse the full JSON payload deeply, the gateway must re-derive the compact observation row from the latest full payload and reject any mismatch before serving `/api/latest`.
- **Versioned schemas:** core rows, capsule metadata, calendar nodes, and extension families must carry schema ids. Old rows remain valid under their original schema.
- **No implicit backfill:** v1 starts retaining rows at cutover. Missing v0 history is predecessor context, not recreated v1 data.

## Read Path

Minimum views:

```text
get_latest_bundle()
get_history_capsule_meta(capsule_id)
get_history_capsule_body(capsule_id)
get_recent_capsule_ids(limit)
get_calendar_node(tier, period_id)
get_history_roots()
```

The UI should use raw capsules for short horizons and calendar nodes for long horizons:

| Horizon | Primary read path |
| --- | --- |
| Latest | `get_latest_bundle()` |
| 1 day | two 48-row capsules, or one 96-row capsule if selected later |
| 7 days | day nodes first, raw capsules on drill-down |
| 30 days | day nodes under month span |
| 1 year/all | month/year nodes first, raw capsules on demand |

Calendar nodes accelerate reads but do not replace raw rows.

## Verification

A verifier for any capsule should:

1. Fetch capsule body and metadata.
2. Check `body_hash`.
3. Split body by `row_len`.
4. Fold row hashes from `start_root`.
5. Check the result equals `end_root`.
6. Fold capsule id, body hash, meta hash, and end root into the capsules root path.
7. Use calendar nodes only as summaries over the retained rows.

Per-capsule `start_root`, `end_root`, `capsules_root_before`, and a separately stored root-after checkpoint are mandatory. Without row-root bounds, a verifier must replay all rows from genesis to prove a row slice. Without capsule-root checkpoints, a verifier must replay all earlier capsules to prove deep capsule membership against the latest tip.

## Cutover

Devnet first:

1. Keep the 3-hour wall-clock 15-minute cadence soak result as the baseline pass; optionally run a longer soak that fills and seals a third capsule.
2. Benchmark browser verification with real Circle reads.
3. Use 48-row capsules for the first v1 MVP unless a later 96-row programmed-Circle seal-through probe materially changes the cost/read tradeoff.
4. Run a many-capsule scale probe with hundreds of retained 48-row bodies before any cutover.
5. Set an explicit annual fee threshold and compare real receipts against it.
6. Deploy a devnet successor Circle.
7. Point only devnet gateway/config at the successor.
8. Let it collect fresh v1 history without fake backfill.
9. Verify UI horizons and raw capsule retrieval.

Mainnet later:

1. Freeze the chosen v1 AML source and formal artifacts.
2. Deploy a new production programmed Circle.
3. Set successor pointer from v0 if the deployed v0 program supports it.
4. Switch updater to `record_snapshot_v1`.
5. Switch gateway configuration after first verified v1 snapshot.
6. Keep v0 readable as predecessor history, but do not recreate missing v0 rows.

## Current Measurements

Standalone devnet results as of 2026-06-23:

```text
48-row capsule body       14,160 bytes
capsule metadata          346 bytes
tx index per 48 rows      3,072 bytes
4 retained capsules       passed exact readback
append effort avg/max     1,482 / 1,692
seal effort               3,127
30-day local verification 10.819 ms median
1-year local verification 125.305 ms median
yearly AML bytes          ~10.589 MB without tx index, ~12.832 MB with tx index
yearly effort model       ~54.212M effort units before fee calibration
```

Programmed-Circle parity has passed at the conservative 48-row capsule size:

```text
circle_id                oct9HoM5zCHfJHP8BRmHQtb5mdvqsMZkiZRRjajUt6ep7S8
row_limit                48
snapshot_count           48
body/meta/tx-index       exact readback
capsules_root            matched
```

Programmed-Circle multi-capsule mechanics have also passed:

```text
same circle              oct9HoM5zCHfJHP8BRmHQtb5mdvqsMZkiZRRjajUt6ep7S8
rows recorded            96
sealed capsules          2
second capsule id        2026-06-07T12
second body/meta/tx      exact readback
capsules_root            matched
```

A 3-hour wall-clock cadence soak has also passed against the same Circle:

```text
rows before soak         96
ticks                    12 / 12
rows after soak          108
open capsule rows        12
capsules_root            matched
open root                matched
error                    none
```

The first production-style v1 successor implementation exposed and then fixed the missed-boundary wedge. Final disposable devnet proof:

```text
fixed circle             oct3KrVDTTR1tQVE69BG6hT9bBesZFhWfBtQ18DExEsWvWy
source hash              sha256:3fd7d00b7283ec612eefba40f1f1f8ed36a27f5426c1912ccdc434556d1f470d
bytecode hash            sha256:74ce0daab91d0d245ba327f9983a57cec0dbbe3d86bbce97510ed1bed630b6f3
verification hash        sha256:d493f243ee00cd8886bc1a546e7c55d8ba3d76388be5b04c527525a0570da6aa
status                   safe / verified
test                     11:45Z row sealed as partial T00 capsule, 12:15Z row recorded in T12 capsule
sealed row_count         000001
root checks              body, meta, end root, capsule root-after all matched
```

Two implementation constraints from that proof should stay in the production checklist:

- unset AML map slots in programmed Circles can read as `"0"`, so write-once map guards must treat `""` and `"0"` as empty only before a real value is written;
- avoid AML helper parameter names such as `value` that can shadow VM opcodes or built-ins.

No mainnet state was touched.

## Gates

Do not proceed to production successor work until:

- the 3-hour wall-clock programmed Site Circle cadence soak result is accepted, or a longer seal-through soak passes;
- a many-capsule scale probe passes with body-sized AML map entries;
- browser verification uses real Circle reads and stays comfortable;
- cost model is calibrated from real receipts and fits the agreed annual fee threshold;
- production AML includes sealed-capsule immutability, capsule-id time binding, and single atomic `record_snapshot_v1`;
- v0 to v1 index continuity is explicitly chosen;
- transaction lookup index remains deferred, or a non-circular post-seal design is explicitly implemented and reviewed;
- CTO, Octra/AML, data architecture, and security reviews approve the final shape.
