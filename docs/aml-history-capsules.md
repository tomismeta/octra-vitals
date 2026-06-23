# AML History Capsules

Status: recommended future design, not yet implemented.

Octra Vitals v0 stores the latest full snapshot plus a bounded 48-row summary window. That is intentionally small and honest for the current product, but it is not a forever history layer. The recommended next design is an append-only AML history layer that keeps thin snapshot history in the programmed Site Circle permanently, while preserving the current principle that AML is the source of truth and the gateway is only a verifier/adapter.

This is a v1/successor-program design, not an in-place public v0 change. Public v0 deliberately avoids unbounded maps and retains only the recent summary window. Forever history requires a new AML state shape, a devnet probe, and a controlled cutover.

The devnet probe plan is captured in [AML History Devnet Probe](aml-history-devnet-probe.md).

## Goals

- Retain every thin snapshot row from the cutover point onward, assuming the AML-resident body path passes the devnet probe.
- Keep AML state Octra-native, append-only, and independently verifiable.
- Support UI horizons such as 1 day, 7 days, 30 days, and longer views without inventing gateway-local history.
- Preserve original snapshot granularity: a future verifier should be able to retrieve and verify the 15-minute rows for a historical date, not only a calendar summary.
- Allow new captured fields over time without corrupting old rows or pretending older snapshots had data that was not captured.
- Keep the latest snapshot rich, while keeping historical rows compact.

## Core Shape

Use append-only history capsules. A capsule is not a special Octra primitive; it is a Vitals data structure made of a fixed-width body string plus one packed metadata row.

```text
Programmed Site Circle AML
  latest full snapshot
  latest evidence/source refs
  latest summary row
  AML-resident history capsule bodies
  history capsule metadata
  calendar stat nodes
  history tip root
  schema/catalog metadata
```

## Ontology

Use this vocabulary consistently:

- **Latest bundle:** the current full snapshot payload, evidence manifest, source refs, summary row, and hashes. This is rich and current.
- **Observation row:** one compact 15-minute historical observation. This is the permanent granular source record.
- **Capsule body:** a bounded AML string containing fixed-width rows for one capsule family and deterministic time span.
- **Capsule family:** the row family stored in a capsule, such as core observations or a named extension family. This is separate from calendar tiers.
- **Capsule metadata:** one packed row describing a capsule body: ids, family, schema, row count, body hash, start root, end root, and sealing status.
- **Calendar stat node:** a derived AML summary over rows or lower calendar nodes for an hour, day, month, or year.
- **Calendar tip/root:** the current commitment over the calendar tree.
- **Extension family catalog:** append-only metadata describing optional future field families.
- **Extension capsule:** fixed-width historical rows for a future field family, keyed to snapshot index and capsule id.
- **Transaction lookup index:** optional sealed lookup metadata that maps capsule rows to their `record_snapshot` transaction hashes for audit convenience.
- **Raw evidence archive:** host/archive storage for full raw RPC bodies by content hash. It is not canonical AML history.

Avoid the term "page" for this design. Rows are grouped into capsules. Calendar nodes summarize and index rows/capsules.

Each canonical snapshot writes one compact row at the native collection cadence, currently every 15 minutes. The open capsule appends rows until it reaches the configured capsule row limit or time boundary, then it is sealed and a new capsule begins.

Sealing a capsule must never delete, overwrite, or replace the original granular rows. Later calendar nodes are indexes over the retained rows, not compaction events. The core product promise for this design is that a verifier can come back later and inspect the original 15-minute observations from the cutover point onward.

Prefer deterministic time-keyed capsules over anonymous row-count chunks. A 12-hour capsule is the starting recommendation because it is close to the already-proven v0 48-row window size at a 15-minute cadence. A one-day capsule is attractive for humans and calendar reads, but it doubles the open-body rewrite footprint and should only be used if the devnet probe shows the cost is comfortably safe.

Capsule identity should be deterministic and time-based, such as `YYYY-MM-DDT00` and `YYYY-MM-DDT12` for 12-hour halves or another fixed UTC period id. Outages should not require gapless capsule ids; enforce snapshot-index continuity across present capsules instead.

## Calendar Tree Layer

Use a calendar tree as the preferred multi-resolution layer over the retained raw rows.

```text
15-minute rows       permanent source observations
hour stat nodes      interior nodes over rows
day stat nodes       interior nodes over hour nodes
month stat nodes     interior nodes over day nodes
year stat nodes      interior nodes over month nodes
calendar tip/root    current root over year nodes
```

The important rule: interior calendar nodes accelerate reads; they do not replace the underlying rows. A year later, a verifier should still be able to retrieve the raw 15-minute rows from the relevant capsule and verify them against the calendar roots.

This is more elegant than maintaining unrelated summary streams because multi-resolution history becomes intrinsic to the data model. A 1-day view can read rows or hour/day nodes. A 30-day view can read day nodes under a month. A 1-year view can read month nodes. The UI gets longer horizons without asking the gateway to invent history.

The calendar tree should stay AML-feasible by using fixed, small depth. AML does not need an unbounded loop over arbitrary tree levels. The program can perform a fixed set of unrolled updates for the active hour, day, month, and year nodes, with rollover checks derived from `observed_at`. This keeps the design inside the primitive set already used by v0: `sha256`, `concat`, `substr`, fixed string length checks, and direct state assignments.

The calendar tree should be treated as a verification index:

- row capsules prove the original observations;
- hour/day/month/year nodes prove summaries over those observations;
- the calendar tip proves the current indexed state;
- a slice verifier should be able to validate the relevant capsule body plus a short path through the calendar nodes without replaying all prior history.

Reads should be bounded and explicit:

- latest/recent view reads the latest snapshot plus the open capsule or recent raw rows;
- 1-day view reads one or two raw capsules, or a day node plus rows for the current partial day;
- 7-day and 30-day views can read day nodes and only drill into raw rows where the UI needs full resolution;
- longer views can use month/year nodes first, then fetch raw capsules on demand.

Rollover policy:

- time boundaries are UTC;
- snapshot-index continuity is the primary continuity invariant;
- calendar periods are UTC buckets with explicit gaps, never synthetic rows;
- missed snapshots are represented by absent indices/period counts, not filled values;
- late arrivals are rejected if they violate the monotonic snapshot-index/time rule;
- the first snapshot in a new period seals the previous period's stat node and folds it into the parent.

Minimum viable v1 should include AML-resident 15-minute capsules plus at least day stat nodes. Hour, month, and year nodes can be enabled after the devnet probe confirms write cost and read complexity are comfortably safe. The enabled calendar tiers and their parent-child derivation are fixed by `calendar_schema_id`; adding an hour tier later is a calendar-schema bump, not a silent toggle. The calendar tree is the strongest candidate for the admired long-horizon design, but it is still gated by measured AML cost and programmed-Circle verification behavior.

## Capsule Metadata

Pack capsule metadata into one fixed-width meta row rather than spreading it across many parallel maps.

```text
version
capsule_family
history_schema_id
sealed
capsule_id
first_index
last_index
row_count
row_len
first_observed_unix
last_observed_unix
body_hash
start_root
end_root
tx_index_hash
```

`body_hash` content-addresses the capsule body. `start_root` and `end_root` make deep slice verification cheap: a browser or verifier folds only the rows in that capsule and checks the result against the end root. It does not need to replay all history from genesis. `row_len` is intentionally stored even when derivable from `history_schema_id`, because the meta row should remain self-describing for future verifiers. `tx_index_hash` is optional and commits to the capsule's transaction lookup index when that index is retained in AML.

Each capsule family and calendar tier should have its own domain-separated root family. Do not fold raw rows, extension rows, day summaries, month summaries, and year summaries into one undifferentiated hash domain. Separate domains keep the verification story clean and avoid confusing derived views with source observations.

Calendar stat nodes should have a fixed schema before implementation. At minimum each node should include:

- schema id
- tier
- period id
- first index
- last index
- first observed unix
- last observed unix
- count
- first value set
- last value set
- min value set
- max value set
- status
- start root
- end root
- source child count

The exact value set is schema-specific. Fields that are monotone under a schema may not need separate min/max storage if first/last already prove the same fact; non-monotone fields such as locked, vault balance, or residuals may need explicit min/max for honest long-horizon charts.

## Row Strategy

Keep the canonical row small and versioned.

Base row fields should cover the values needed for historical accounting:

- row version
- snapshot index
- observed-at unix seconds
- Octra epoch
- external block height
- max supply/raw cap OCT
- circulating/raw issued OCT
- burned/raw OCT
- encrypted OCT
- locked OCT
- wrapped OCT
- unclaimed OCT
- vault balance OCT
- unit/decimal status
- conservation status
- route count
- full payload hash commitment

Rows must include `row_version` or equivalent schema identity. When new fields are added later, old rows remain valid under their original schema. Missing old values should be represented as "not captured yet", never backfilled as if they were observed.

Rows, capsule metadata, and calendar stat nodes should each carry explicit schema ids. A future verifier must be able to decode a historical row without assuming the latest code knows the old layout implicitly.

The historical payload hash must be a full hash, not a short display prefix, if it is used as a forensic pointer. Historical full payloads are not AML-resident in this design; only the latest full payload remains in AML. A historical row's full payload hash is therefore a commitment and recovery key for archive/transaction-log inspection, not a guaranteed AML fetch path.

The base row should carry enough accounting inputs to recompute the core conservation verdict for any retained historical point. If a field participates in a red/green conservation rule, it belongs either in the base row or in a deterministic extension capsule that the verifier can discover from AML. For the current conservation rules, the base row should include at least max supply/cap, issued, burned, encrypted, bridge ledger locked, wrapped, unclaimed, vault balance, unit/decimal status, and the recorded conservation status. Diagnostic counters such as lock/unlock nonce can remain extension fields unless they become part of the signed verdict.

Use compact fixed-width encoding where it buys a clear win without making the verifier clever. Good candidates are raw digests without repeated `sha256:` prefixes, compact integer encodings for raw amounts, and small enum codes. Defer variable-width delta compression: it fights fixed-width addressing, complicates random access, and should only be revisited if compact fixed-width rows fail the probe.

## Extensibility

Do not make one giant row that tries to anticipate every future field. Use tiers:

1. Core history rows for the durable accounting values.
2. Extension capsules for new families of fields, keyed by schema id and snapshot index.
3. Latest full payload for rich current detail and provenance.
4. Catalog/dictionary state for repeated identifiers such as route ids, chain ids, source ids, and field schema ids.

This keeps the first history layer stable while allowing future additions such as new destination chains, route-level bridge data, relayer health, fees, or protocol-specific counters.

Catalogs should earn their keep. They are not needed for the hot core row if that row has no repeated strings. They become valuable if detail history moves into AML, because dictionary ids can turn otherwise-variable route/source/detail records into bounded fixed-width rows. Catalog entries must be append-only and immutable once assigned.

Extension capsules need a deterministic discovery rule. Do not rely on gateway-local indexes. If a field family is introduced later, AML should expose an append-only extension-family catalog and a deterministic key pattern such as `(family_id, capsule_id)` or `(family_id, first_index, last_index)` so a browser can discover and verify the extension history for a range.

## Granularity

The canonical high-resolution cadence should remain the snapshot cadence. Today that means one row every 15 minutes.

Longer horizons should be served by calendar stat nodes, not by deleting or destructively compacting the canonical rows.

Recommended calendar tiers:

- hourly
- daily
- monthly
- yearly
- weekly only as a presentation convenience, because weeks cross month/year boundaries and should not complicate the canonical tree unless a real read-cost need appears

Stat nodes should contain first, last, min, max, count, and status fields sufficient for charts and conservation summaries. They are derived views over retained canonical rows, not replacements for them.

If a future fallback ever prunes raw rows from AML, calendar stat nodes become producer-asserted summaries rather than fully recomputation-verifiable views. That distinction must be exposed honestly.

Query examples:

- `1d`: read raw rows directly, or use hourly/day nodes and expand raw rows on demand.
- `7d`: read day/hour nodes, then fetch raw capsules for exact inspection.
- `30d`: read day nodes under the relevant month span.
- `1y`: read month nodes.
- exact historical date: fetch the relevant capsule body, verify `body_hash`, fold rows from `start_root` to `end_root`, and render the original 15-minute points.

AML forever history should retain thin accounting rows, not full raw RPC bodies. Full raw evidence can remain in host/archive storage by content hash. The AML history row should include enough committed pointers for audit, but it should not become a permanent raw-response database.

## Capsule Size Selection

Capsule size is a cost knee, not simply the largest value AML accepts. Larger capsules reduce read count for long horizons, but they make every append more expensive because the open capsule body is rewritten. With calendar nodes enabled, the per-snapshot write footprint also includes latest fields, the open capsule metadata row, open calendar stat nodes, and tier tips.

Devnet probes should measure at least:

- 12 rows
- 24 rows
- 48 rows
- 96 rows
- 192 rows
- 384 rows

Choose the size from measured write cost, read cost, verification cost, and AML field/return limits. A 48-row/12-hour capsule is the starting recommendation because it keeps the open rewrite footprint near the known v0 window size, but the probe should bracket below 48 rows because the true cost knee may be smaller once calendar-node writes are included. A 96-row/day capsule should remain in the probe because the operational shape is appealing if the measured write cost is low enough.

## Devnet Probe Candidates

Probe the design as a product decision, not as an abstract data-structure contest.

Candidate A: plain AML-resident capsules.

- Lowest conceptual complexity.
- Strongest immediate path from v0.
- Supports forever 15-minute rows, but longer horizons need separate stat reads.

Candidate B: AML-resident calendar capsules.

- Preferred design if measured cost and code complexity stay reasonable.
- Keeps raw 15-minute rows in AML and makes hour/day/month/year views native to the model.
- Avoids maintaining unrelated summary streams that can drift from the source rows.

Candidate C: AML metadata with Circle-asset capsule bodies.

- Fallback only if AML-resident bodies hit hard write, size, return, or verification limits.
- Still tamper-evident through AML roots and hashes, but not equivalent to AML-resident history unless Circle asset durability is proven to match the product's trust claim.

The devnet gate should compare these candidates on:

- write effort and fee per snapshot;
- maximum safe retained row count per capsule;
- browser verification time for 1-day, 7-day, 30-day, and 1-year slices;
- RPC/read count for each UI horizon;
- formal verification behavior with maps and packed metadata;
- operator clarity when a period has gaps or rollover occurs.

The winning design should preserve the product claim in plain language: AML owns the durable history; the gateway adapts; calendar nodes accelerate reads; original rows remain inspectable forever from cutover onward.

## State Body Versus Circle Asset Body

The most important architecture fork is where sealed capsule bodies live.

Primary recommendation: AML stores both body and metadata.

- Strongest AML-state durability story.
- More expensive writes and larger state growth.
- Depends heavily on programmed-Circle map and return-size viability.

Fallback/probe option: AML stores packed metadata, roots, and content hashes; sealed capsule bodies are immutable content-addressed Circle assets named by `body_hash`.

- AML remains small and commitment-oriented.
- Heavy historical bytes move to the same native Circle asset layer already used for app bytes.
- A browser verifies a slice by reading AML metadata, fetching the capsule asset, checking `body_hash`, and folding rows from `start_root` to `end_root`.
- This is attractive if AML limits are too tight and Circle assets have consensus-like durability and availability.

Prefer the AML-resident version unless the devnet probe shows a hard cost, size, or verification limit. If Circle assets are host-served rather than consensus-durable, the asset-backed version becomes root-proven external history: still useful and tamper-evident, but not equivalent to AML-resident history.

## Transaction Log Recovery Path

Every successful `record_snapshot` call is also a chain transaction. If Octra exposes durable archive reads for historical transactions, those transactions can be used as a forensic recovery path for the submitted row and full call arguments.

Do not make transactions the primary history API for v1. The product still needs AML-resident indexed history because normal UI reads should not depend on explorer-specific enumeration, archive-node retention, or fetching one full transaction per 15-minute point. The transaction log is valuable as a secondary proof/recovery layer:

- recover or audit a specific snapshot when the transaction hash is known;
- cross-check that an AML row was submitted in the expected call;
- rebuild external research datasets if archive access remains available.

This path is not a substitute for AML capsules unless Octra later exposes a canonical, enumerable, durable snapshot-event index with inclusion proofs.

## Transaction Lookup Index

For easier audit lookup, each sealed capsule may include a transaction lookup index aligned 1:1 with its observation rows.

The current `record_snapshot` transaction hash should not be part of the row written by that same transaction. That creates a circular or preimage-dependent design: the transaction hash depends on the call arguments, and the call arguments would include the transaction hash. AML also should not need to know its enclosing transaction hash to validate the row.

Instead, the producer can attach transaction lookup data when a capsule seals, because all `record_snapshot` transaction hashes for the completed capsule are known by then. The preferred shape is:

```text
capsule_tx_index[capsule_id] = fixed-width tx hashes aligned to row order
capsule_meta.tx_index_hash   = sha256(domain + capsule_tx_index)
```

This index is a convenience and forensic pointer, not the primary proof of the row. A verifier can use a listed transaction hash to fetch the transaction, then compare the submitted row/call arguments back to the AML-retained row and capsule roots.

The devnet probe should measure this both ways:

- full AML-resident transaction index per sealed capsule;
- hash-only transaction index commitment with the full index retained in host/archive storage.

Full tx hashes are useful, but they add permanent bytes per row. If the cost is acceptable, AML-resident transaction lookup is preferable for usability. If not, `tx_index_hash` plus archive/index availability is the fallback.

## Formal Invariants

The AML successor should make the proof obligations explicit before implementation. At minimum:

- only the configured owner/operator can append snapshots;
- snapshot indices are strictly continuous from the v1 base index;
- observed times and epochs obey the monotonicity rule;
- there is at most one open capsule per active capsule family and UTC period;
- sealed capsules are immutable;
- a capsule meta row matches its body hash, row count, row length, first/last index, first/last observed time, start root, and end root;
- append updates fold the previous root and new row under the correct domain-separated hash;
- each calendar tier has at most one open node per active UTC period;
- calendar rollover folds a sealed child node into exactly one parent node;
- capsule roots are domain-separated by capsule family and schema id;
- calendar roots are domain-separated by calendar tier and schema id;
- extension-family catalogs are append-only and immutable once assigned;
- transaction lookup indexes, when present, have the same row count and ordering as the sealed capsule body;
- no getter or gateway path may synthesize missing canonical AML history.

## Cutover From Current v0

Do not fake historical backfill.

At cutover:

- keep v0 history as a bounded historical tail only;
- seed v1 with the final v0 latest index;
- make the first v1 snapshot use `v0_final_index + 1`;
- anchor the v0 tail with a domain-separated hash over the circle id, v0 final index, v0 latest summary hash, and v0 summary-window hash, with integer and string encodings pinned in the spec.

The v1 forever history starts at the v1 cutover point. Any pre-v1 data shown in the UI should be labeled as v0 retained window or external archive, not canonical forever history.

## Fallback Rule

If AML maps and return sizes are viable in a programmed Site Circle, use map-backed capsules.

If maps are not viable, do not pretend segmented fixed slots are forever. Fall back explicitly to:

- the largest safe AML high-resolution window;
- append-only AML calendar/checkpoint capsules;
- root-proven external or Circle asset capsules for full high-resolution archive.

The gateway must not synthesize local history and present it as canonical AML history.

Operator-signed checkpoints alone are not an acceptable replacement for AML-resident history. They are cheap, but they move the trust boundary back to an operator assertion. Merkle Mountain Ranges and other advanced accumulators are also deferred: they are elegant, but they likely exceed AML's current practical primitive set. Fixed-depth calendar nodes are the preferred elegance ceiling because they can be expressed with fixed update paths.

## Open Questions For Devnet Probe

- Exact AML map support in programmed Site Circle verification.
- Whether a growing `map[capsule_id] -> sealed body` with 14KB+ values remains safe, readable, and cost-effective after many capsules. Four retained 48-row bodies have passed in standalone devnet AML.
- Whether a persistent cross-capsule root can be maintained cheaply while preserving O(capsule) browser verification for historical slices.
- Maximum safe field size, return size, and transaction write footprint.
- Append cost for each candidate capsule size.
- Browser verification cost for 1-day, 7-day, 30-day, and 1-year slices.
- Best compact fixed-width row encoding: current pipe fields, raw digest fields, base36/base64url integers, or similar.
- Whether extension capsules are needed immediately or should wait for the first additional field family.
- Durability and availability properties of Circle assets versus AML state.
- Cost and verification comparison between AML-resident capsule bodies and Circle-asset capsule bodies.
- Cost and complexity comparison between plain AML capsules and AML capsules plus fixed-depth calendar stat nodes.
- Cost and storage impact of AML-resident transaction lookup indexes versus hash-only transaction index commitments.
- Whether calendar nodes can be updated and verified with fixed, unrolled AML code without introducing fragile date parsing.
- Whether known `record_snapshot` transactions remain readable far enough back to serve as forensic backup, and whether any RPC/explorer surface can enumerate those transactions without relying on gateway-local state.
