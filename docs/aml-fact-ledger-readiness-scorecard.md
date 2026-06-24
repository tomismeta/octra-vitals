# AML Fact Ledger — Devnet Readiness Scorecard

Status: **fact-v2 mainnet-shaped devnet cutover complete; soak active**. Mainnet (`octra.live`) is untouched.
Date: 2026-06-24
Scope: the fact-family ledger running behind `devnet.octra.live`. The old fact-v1 devnet Circle remains a soak artifact; the mainnet-shaped rehearsal uses a fresh fact-v2 programmed Circle with AML and assets together.

This scorecard records the gates we require before the fact-ledger model is considered production-ready. It is intentionally conservative: a local/formal pass is not treated as a live pass until the devnet Circle has run through the same path.

## Current Devnet Target

- Network: `octra-devnet`.
- Previous devnet fact-v1 Circle: `octDxjWHdLQX3RRmU9tdh16in35wPR9c8uRniBwEpHsG9K8`.
- Fresh devnet fact-v2 Circle: `oct5cp4FuVqZJ6W5o1cxVyeE3BvP1R9owZWR9evGmZf3gyu`.
- Fresh fact-v2 deploy tx: `82ef11b79541f5884a8046f11c142e384be350f447db3738c5d6d22d4c9b373d`.
- Fresh fact-v2 program update tx: `710646bab2a418b66d56439607ec9ab64f3edb3178dec6f45e90b65201c8c747`.
- Fresh fact-v2 initialize tx: `3ccb91116b18ed072c4e54f3258550a3349b4244c85be0dbeb2565318a8e3830`.
- First fact-v2 snapshot tx: `046056bd0b08480e7039cdefe97d3a968cc5d5d6b5697221e211a6d587b6bd46`.
- First scheduled fact-v2 snapshot tx: `404c0522b622b9ea973efe39157b1714c62bf694282e9378c1ea3ab136ca490c`.
- Devnet wallet: documented separately in `docs/devnet-fact-ledger-wallets.md`; no private material is stored in the repo.
- Mainnet: no deploy, no configuration change, no wallet access.

## Candidate Build

The candidate fact-ledger program was built with `npm test` and `npm run fact-ledger-program:compile` on 2026-06-24. It is the first fact-v2 candidate intended to model the mainnet shape.

| Artifact | Value |
| --- | --- |
| Manifest | `octra-vitals-fact-ledger.v2` |
| Source hash | `sha256:ca56b577909e88eaedf28cde388bb4a4fc593ca8df4076064a2468d605066f6d` |
| Bytecode hash | `sha256:aa30cedd75ab28ef2057a58312afac529d72753dee81768494e2abdba8fb28c2` |
| Verification hash | `sha256:f212e13eaa7cab7b4dcacf3569957aa6dcec4722667cbd449ff2ffe41311117e` |
| Formal result | `safe`, `verified`, 0 errors, 0 warnings |
| Size | 22,706 bytes |
| Instructions | 3,873 |
| Dormant aux overhead | `fact-v2` sample call is +14 bytes vs `fact-v1` (+0.21%) with `aux_count=0` |

The generic fact-ledger substrate probe also verifies cleanly:

| Artifact | Value |
| --- | --- |
| Source hash | `sha256:a9a1b9f55d80c2ce591258da54a4dfee5503c400927df254d78975fa0bbb4ac9` |
| Bytecode hash | `sha256:2544030e6df0010cce003f0e9030f5b2a3ee1a3ca0d45cfd22970e228e89e375` |
| Verification hash | `sha256:755b81d964fe3cff6cf9979f6eb358c44941ffd4f266cef7f5abda5734d35a05` |
| Formal result | `safe`, `verified`, 0 errors, 0 warnings |

## Review-Hardening Changes In This Candidate

The fact-v2 candidate carries forward the prior hardening and adds the typed-metric substrate:

1. **AML-owned capsule time binding.** `record_snapshot_fact_v2` takes `observed_at`, validates the UTC timestamp, derives the deterministic `YYYY-MM-DDT00/12` capsule base in AML, and rejects mismatched caller-provided capsule bases.
2. **Full core-row assertion.** The write path now calls both `assert_core_row_matches_summary` and `assert_fact_row`, binding the durable row to row version, snapshot index, schema id, and full payload hash.
3. **Latest identity restored.** Fact-ledger writes now populate `latest_snapshot_id`, `latest_observed_at`, and `latest_submitter`, and emit those fields in `SnapshotRecorded`. Submit/readback tooling verifies them against the submitted call.
4. **Immediate caller authorization.** Owner/operator checks now use `caller`, matching the prior programmed Circle AML programs and avoiding reliance on transitive `origin` semantics. `origin` is not used for authorization in this candidate; `latest_submitter` records the immediate caller context that successfully invoked the write.
5. **Dormant typed metric surface.** `record_snapshot_fact_v2` accepts `aux_count` plus four optional fixed-width auxiliary fact rows. The launch path uses `aux_count=0`; auxiliary rows are appendable only for registered non-core families and must be sorted by family id.

## Growth-Headroom Changes In This Candidate

Three changes directly address the size fragility found during devnet deployment:

1. **Sealed capsule-chain root.** Each family now stores `family_capsules_root_by_id[family_id]`, and sealed capsule metadata carries `family_root_before` / `family_root_after` for the capsule chain. A browser or gateway can verify a capsule slice by checking ordered capsule-chain continuity instead of replaying all historical rows from genesis.
2. **Per-snapshot size headroom telemetry.** Every producer call/report now includes byte usage and remaining headroom for canonical payload, evidence manifest, source refs, summary row, fact row, compact message, and the 48-row capsule body. Low-margin warnings are emitted before a data-growth change becomes an AML write failure.
3. **Fixed-width capsule id slot restored.** The live seal boundary exposed that capsule ids such as `2026-06-24T12.0000` are 18 bytes and must be padded to the 24-byte slot expected by the TypeScript verifier. The AML seal path now uses the same 24-byte capsule id slot as the browser/gateway encoding.

The AML state remains boring and bounded per write: one latest payload/evidence/source-ref set, one open capsule body per family, immutable sealed capsules, and small roots/counters.

## Era-Stitching Readiness Pass

The gateway/API verifier now reads the current fact-v2 Circle and recursively verifies its predecessor chain before serving history. Devnet currently stitches four eras:

1. `octCCXubqWXcXSGtHAiwvvgB7DZCFs8wCxEnx6FQu1Fs9Sn` — readable v1 capsule-tail era, rows `#1` through `#23`.
2. `octCbnRcmQRQyf8B31Hm5rcNAf94PZdMdpYe7gjaFmdjvJ7` — empty fact-ledger bridge era, no renderable rows, but an anchor from the v1 root to the fact-ledger root namespace.
3. `octDxjWHdLQX3RRmU9tdh16in35wPR9c8uRniBwEpHsG9K8` — fact-v1 era, rows `#24` through `#94`.
4. `oct5cp4FuVqZJ6W5o1cxVyeE3BvP1R9owZWR9evGmZf3gyu` — current fact-v2 era, rows `#95` onward.

The proof envelope exposes these eras under `/api/history.proof.eras`. Fact-ledger boundaries verify by recomputing `predecessor_anchor_hash` from `(network_id, predecessor_program, predecessor_final_root, predecessor_final_index, era_program, era_first_snapshot_index, core_family_id)`. The v1-to-fact-ledger boundary is intentionally represented as an era boundary, not as one single replayable root over all rows, because the fact-ledger root domain starts a new namespace.

Local gates for this pass:

- `npm test`: 82 passing, including manifest-scoped capsule roots and devnet era-anchor vectors.
- `npm run native:verify`: passed; fact-v2 AML bytecode remains `sha256:aa30cedd75ab28ef2057a58312afac529d72753dee81768494e2abdba8fb28c2`.
- Live devnet readback before deploy: stitched history spans rows `#1` through latest and returns `history_model=aml_multi_era_fact_family_core_capsules_verified`.

Latest live headroom, from first fresh fact-v2 devnet snapshot `#95` (`vitals.2026-06-24T22:29:51Z`):

| Field | Used | Limit | Remaining |
| --- | ---: | ---: | ---: |
| Canonical payload | 2,968 bytes | 12,000 bytes | 9,032 bytes |
| Evidence manifest | 2,626 bytes | 8,000 bytes | 5,374 bytes |
| Source refs | 1,270 bytes | 4,096 bytes | 2,826 bytes |
| Compact record message | 8,077 bytes | 22,000 bytes | 13,923 bytes |
| Open capsule | 1 row / 295 bytes | 48 rows / 14,160 bytes | 47 rows / 13,865 bytes |

The latest size-headroom report has no warnings. A near-full capsule may warn as it approaches the 48-row seal boundary; that is expected telemetry, not a failure.

## Legend

`done` means completed and reproducible. `live pending` means code exists and passed local/formal gates but still needs the devnet Circle to prove it. `open` means not implemented or not yet exercised.

## Scorecard

### Correctness & Formal Verification

| Gate | Status | Evidence | To close |
| --- | --- | --- | --- |
| Production AML formally `safe`/`verified` | done | `npm run native:verify`; fact-ledger program `safe`/`verified` | Reconfirm after any AML edit |
| Gate 0 generic substrate verified | done | `npm run fact-ledger-probe:compile`; probe `safe`/`verified` | — |
| Capsule metadata has distinct row-root and capsule-chain-root semantics | done | `family_root_before` / `family_root_after` now track the capsule chain, not duplicate row roots | Live seal readback |
| Issue C overflow path is fixed | done | Segment suffix on overflow; unit tests cover same-half overflow capsule IDs | Live over-cadence run |
| Core row bound to verified summary and full payload hash | done | `assert_core_row_matches_summary` + `assert_fact_row` remain in AML | — |
| Capsule id bound to observed time | done | AML derives half-day capsule base from `observed_at` and rejects mismatches; live fact-v2 hash `aa30cedd...fb28c2` | Continue soak |
| Latest identity compatibility restored | done | AML writes latest id/time/submitter; fresh fact-v2 snapshot `#95` readback has id/time/submitter populated | Continue soak |
| Gateway/browser verifier understands capsule-chain roots | done | JS tests + `/api/history` verifier updated for `get_family_capsules_root`; live history proof status `fact_family_verified` | Continue soak |
| Unit suite and native verification green | done | 79 JS tests pass; full native verify passes | — |

### Liveness, Scale & Data Growth

| Gate | Status | Evidence | To close |
| --- | --- | --- | --- |
| Devnet Circle deployed to candidate AML | done | Fresh Circle `oct5cp4...3gyu`; live code hash `aa30cedd...fb28c2`; deploy tx `82ef11b...9b373d`; program update tx `710646...c8c747`; initialize tx `3ccb91...e3830` | Continue soak |
| Snapshot reports expose size headroom | done | Latest submit report includes byte use, remaining headroom, dynamic capsule rows, submitted OU, and receipt effort | Continue monitoring |
| Scheduled fact-v2 updater path | done | Timer-produced snapshot `#96` (`vitals.2026-06-24T22:45:10Z`), tx `404c0522...ca490c`, total run 5.5s | Continue soak |
| Seal-through a capsule boundary | done | Snapshot `#71` sealed capsule `2026-06-24T12.0000`; tx `960c0bee...698c3039` | Continue soak |
| Over-cadence in one 12h half opens `.0001` cleanly | done | Snapshot `#72` opened `2026-06-24T12.0001`; tx `0fb7e19d...0cf39a7e` | Continue soak |
| Restart/resume across seal boundary | done | Systemd updater service produced snapshot `#73` after gateway restart and sealed-state resume; tx `1a67242d...61b3b559` | Continue soak |
| Many-capsule scale in programmed Circle | open | Fresh fact-v2 era starts at snapshot `#95`; first row is verified, but no fresh fact-v2 seal yet | Let devnet accumulate capsules; track read/write cost |

### Read Path & Honesty

| Gate | Status | Evidence | To close |
| --- | --- | --- | --- |
| `/api/latest` serves program-backed data | done | `/api/latest` returns 200, `status=program`, `source=program` after update | Continue monitoring freshness |
| `/api/history` sourced from verified fact-family capsules | done | `/api/history?window=1d` returns stitched fact/v1 history with `aml_multi_era_fact_family_core_capsules_verified` and era-boundary proof metadata | Continue monitoring |
| Era boundary proof exposed in API | done | `/api/history.proof.eras` carries predecessor roots, indexes, anchor hashes, and `boundary_verified=true` for fact-ledger successor boundaries | Continue monitoring |
| Browser-side range verification measured | open | — | Measure 1d/7d/30d reads once enough history exists |
| Coverage honesty for short history | done | UI/API expose available coverage; no fake history is synthesized | Continue monitoring |
| Completeness for future multi-family snapshots | deferred | Core-only launch is atomic; 1:many families are not active | Decide before adding route/detail families |

### Ops, Supply Chain & Governance

| Gate | Status | Evidence | To close |
| --- | --- | --- | --- |
| Exact artifacts pinned | done | Devnet gateway/updater env pins source, bytecode, and verification hashes above | Reconfirm after any AML edit |
| Programmed-Circle method surface includes new views | done | `get_family_capsules_root` / `get_capsules_root` added to readiness method list | Live readiness check |
| No raw private material in repo | done | Secrets remain host-local root-only env files | Continue not printing/copying secrets |
| Cost optimized for devnet update | done | Existing Circle updated in place at 1000 OU; no fresh Circle deploy | Keep using update path for AML-only devnet patches |
| Final devnet report | done | Fresh deploy report `/var/lib/octra-vitals/programmed-circle-deploy.json`; first fact-v2 run `/var/lib/octra-vitals/runs/snapshot-2026-06-24T222951Z-256360/submit_snapshot.json` | Keep updating this scorecard after major gates |

## Mainnet Gate

Mainnet remains no-go until:

- the candidate AML has soaked on devnet beyond the first sealed capsule;
- many-capsule reads and writes remain healthy as devnet history grows;
- browser-side 1d/7d/30d verification timing is measured once enough history exists;
- the final report records receipt effort/cost and live Circle readback;
- the user explicitly approves mainnet.
