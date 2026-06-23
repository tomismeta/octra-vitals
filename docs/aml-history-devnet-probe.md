# AML History Devnet Probe

Status: first isolated devnet pilot complete.

This probe prepares the future `record_snapshot_v1`/successor-program history design described in [AML History Capsules](aml-history-capsules.md). It must run on devnet only. It must not mutate the current mainnet programmed Circle, mainnet wallet, or production data collection path.

## Purpose

Answer the empirical questions that decide the v1 AML history shape:

- Can programmed Site Circle AML support the maps and return surfaces needed for forever history?
- What capsule size is cost-effective once latest writes, capsule metadata, calendar stat nodes, and optional transaction lookup indexes are included?
- Can the browser verify 1-day, 7-day, 30-day, and 1-year views directly from AML-resident history in acceptable time?
- Are AML-resident transaction lookup indexes worth their permanent bytes, or should we store only `tx_index_hash` in AML?
- Does fixed-depth calendar logic verify cleanly without fragile date parsing or unbounded loops?

## Non-Goals

- No mainnet deployment.
- No production successor cutover.
- No changes to the current public v0 snapshot schedule.
- No fake backfill of v0 history.
- No gateway-local canonical history.
- No raw RPC body archive in AML.

## Probe Candidates

Candidate A: plain AML-resident capsules.

- Core 15-minute observation rows live forever in AML capsule bodies.
- Capsule metadata includes body hash, start root, end root, schema ids, row count, and seal status.
- Longer horizons require reading more capsules or separate stat reads.

Candidate B: AML-resident calendar capsules.

- Core 15-minute observation rows live forever in AML capsule bodies.
- Calendar stat nodes provide hour/day/month/year summaries.
- Preferred if write cost, formal verification, and browser verification are comfortable.

Candidate C: AML metadata with Circle-asset capsule bodies.

- Fallback only.
- AML stores metadata and roots; sealed capsule bodies live as content-addressed Circle assets.
- Use only if AML-resident bodies hit a hard size, write, return, or verification limit.

## Measurement Matrix

Probe these row counts:

```text
12 rows   ~= 3 hours
24 rows   ~= 6 hours
48 rows   ~= 12 hours
96 rows   ~= 1 day
192 rows  ~= 2 days
384 rows  ~= 4 days
```

For each candidate and row count, capture:

- compile success/failure;
- formal verification success/failure;
- initialize effort;
- append effort per snapshot;
- seal effort per capsule;
- state read size for latest, capsule body, capsule metadata, and calendar nodes;
- browser verification time for 1-day, 7-day, 30-day, and 1-year slices;
- RPC call count for each UI horizon;
- transaction lookup index cost, with and without full AML-resident tx hashes;
- failure mode, if any.

## Minimal Probe Artifacts

The first implementation should be disposable and isolated from production code paths.

Recommended local shape:

```text
program-history-probe/
  main.aml
  abi.json
  formal_verification.json
  formal_certificate.json

src/scripts/probe-aml-history.ts
src/test/aml-history-probe.test.ts
```

The probe AML should use synthetic rows with the same byte lengths and hash domains expected by v1. It does not need to collect live RPC data. The point is to measure AML storage, compute, return sizes, and verification behavior before touching the production updater.

## Data Contracts To Simulate

Observation row should include the v1 core fields:

- schema/version;
- snapshot index;
- observed-at unix seconds;
- Octra epoch;
- external block height;
- max supply/cap;
- issued/circulating;
- burned;
- encrypted;
- bridge ledger locked;
- wrapped;
- unclaimed;
- vault balance;
- unit/decimal status;
- conservation status;
- route count;
- full payload hash commitment.

Capsule metadata should include:

- version;
- capsule family;
- history schema id;
- sealed flag;
- capsule id;
- first/last index;
- row count;
- row length;
- first/last observed unix;
- body hash;
- start root;
- end root;
- optional `tx_index_hash`.

Calendar stat nodes should include:

- calendar schema id;
- tier;
- period id;
- first/last index;
- first/last observed unix;
- count;
- first/last value set;
- min/max value set where meaningful;
- status;
- start root;
- end root;
- source child count.

## Devnet Safety Rules

- Use a new devnet probe Circle/program, not the active mainnet Circle.
- Prefer a disposable devnet Circle over the active devnet dogfood Circle until the probe is stable.
- Use a devnet-only wallet with limited funds.
- Keep the current devnet Vitals updater running unless explicitly testing a successor cutover.
- Do not publish probe artifacts into the production Circle asset manifest.
- Do not add probe routes to the production gateway.
- Record every deployed probe address/Circle id, transaction hash, and result in a dated report.

## Success Gate

The probe can advance to a devnet successor implementation only if:

- programmed Circle AML maps work and formally verify;
- chosen capsule size has acceptable append and seal effort;
- browser verification is acceptable for 1-day, 7-day, 30-day, and 1-year views;
- v0-to-v1 index continuity is modeled without fake backfill;
- conservation can be recomputed from retained historical fields;
- transaction lookup index strategy is chosen from measured cost;
- failure modes are explicit and do not silently fall back to gateway-local history.

## Expected Outcome

Pick one of:

```text
A. Plain AML capsules for v1.
B. AML calendar capsules for v1.
C. AML metadata + Circle asset bodies as fallback.
D. Do not proceed; AML limits require a smaller design.
```

The current recommendation before measurement is B if the numbers are comfortable, A if we want the safest admired v1, and C only if AML-resident bodies hit a hard wall.

## Devnet Pilot Results

2026-06-22 and 2026-06-23 isolated probes, run from `octra-dev` against `https://devnet.octrascan.io/rpc`.

No mainnet endpoint, mainnet wallet, production programmed Circle, live devnet Circle, updater timer, or gateway release path was modified. The probe deployed disposable standalone AML programs from `/tmp/octra-vitals-history-probe`.

Compiler result:

```text
source_hash       sha256:4c358a5ad98cd70d9b4998073da14453542cc899b459db39559d1805d3b58329
bytecode_hash     sha256:bc37503a967b13ec4dbf9e7d416ab629118895339d6bfb9480b36463e8adf08c
verification_hash sha256:5a1f36e4bc4a32cfcfc788b555438deaf1c875a4bf0b286c26de594a2163f37d
formal safety     safe, verified, zero errors, zero warnings
instructions      452
bytecode size      3150
```

Measured pilots:

| Rows | Horizon | Program | Deploy tx | Body bytes | Meta bytes | Tx-index bytes | Init effort | Append effort avg | Append effort max | Seal effort | Reset effort | Readback |
| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 12 | 3h | `oct8LTDwgDEw3dtd9Ezh9xACG6tmwGDzbgsxcZNcTBLfEXT` | `6715534a6fab11d54cb1fe5a8d1c8315ec25c92754804bf14f140cbb24d0f7b2` | 3,540 | 346 | 768 | 1,654 | 1,270 | 1,489 | 563 | 934 | `snapshot_count=12`, open rows reset to 0 |
| 48 | 12h | `octDbznRAZ2PqxtCn4KEAvLGnvJHbMNWH4Bx3KXYBX3bozh` | `23394ecd39db63888f9a3a9745eb54be0b495f274f2c5523cc3b18de6803f19c` | 14,160 | 346 | 3,072 | 1,660 | 1,418 | 1,628 | 729 | 934 | `snapshot_count=48`, open rows reset to 0 |
| 96 | 1d | `oct2wi9DGCrHoVy9z6a4Mdr9shenJHejN7ggC6TRgDBt8rL` | recovered from failed full run | 28,320 | 346 | not retained | not retained | 2,029 for final 10 appends | 2,071 for final 10 appends | 951 | 934 | `snapshot_count=96`, body readback matched, open rows reset to 0 |

Map/calendar metadata probe:

```text
program                 octnRGTeUvy5S4Mh4zcCgUfz9F4UwzZmGS7qjBw3WbdPe36
deploy_tx               1c73c54807af3fe7c7a73f4f39de282eda54589bea2760d87c0a71467a2210e9
bundle writes            3
capsule metadata writes  3
calendar node writes     9
bundle payload bytes     1,999  (346-byte capsule meta + 3 x 551-byte calendar nodes)
initialize effort        1,229
bundle effort avg/max    2,009 / 2,009
readback                 capsule meta, day node, month node, and year node matched exactly
```

96-row/day-capsule stress result:

- A 96-row run with the live devnet operator wallet failed near the end with `invalid nonce`; this was caused by nonce contention with the active devnet updater using the same wallet.
- A dedicated throwaway devnet probe wallet was generated on `octra-dev`, stored in a root-only temp env file, and funded with 1 devnet OCT so it would not race the updater.
- The dedicated-wallet 96-row run progressed to 86 open rows and then failed at append nonce 89 with `invalid signature`. Because the same wallet signed and confirmed many earlier transactions, this is treated as devnet/RPC long-run submission fragility, not a deterministic AML size rejection.
- The partial program was recovered, resumed from 86 rows, completed to 96 rows, returned the full 28,320-byte body, sealed, reset, and read back the final root.
- The 96-row/day capsule size is therefore technically viable in AML/RPC, but future long probes and any migration tooling need resumable progress reports.

Local report artifacts were copied to ignored paths:

```text
reports/aml-history-devnet-pilot-12.json
reports/aml-history-devnet-pilot-48.json
reports/aml-history-devnet-map-calendar-3.json
```

Interpretation:

- Fixed-width AML-resident capsule bodies are viable through the current 48-row/12-hour window size.
- A 96-row/day capsule can be completed and read back when the probe is resumed after transient submission issues.
- Append effort rose modestly from the 12-row pilot to the 48-row pilot.
- The final 10 appends of the 96-row capsule averaged 2,029 effort, with a max of 2,071.
- Seal/reset costs were small relative to append writes.
- AML maps using `map[string]string` compiled, formally verified, wrote packed capsule metadata/calendar rows, and read back exact values.
- Calendar metadata writes are cheap enough to keep Candidate B alive: one bundle containing a capsule meta row plus day/month/year nodes cost 2,009 effort in the probe.
- Do not proceed to conversion/history preservation solely from this result. The current strongest candidates are 48-row or 96-row AML-resident capsules plus map-backed capsule metadata and calendar stat nodes; 96-row capsules now deserve serious consideration because daily capsule identity is much cleaner.

Operational lessons:

- Long devnet probes must not use the same wallet as the live updater; otherwise scheduled snapshots can consume the next nonce.
- Future long probes should use a dedicated probe wallet and write progress reports after deploy, initialize, and every N appends.
- Long-running probes should be resumable/progress-reporting by default.
- A production-like cadence test is still preferable before a real successor deployment because one snapshot every 15 minutes is gentler than a tight back-to-back stress loop.
