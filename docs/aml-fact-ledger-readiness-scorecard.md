# AML Fact Ledger — Devnet Readiness Scorecard

Status: **fact-v2 mainnet-shaped candidate locally verified; fresh devnet cutover in progress**. Mainnet (`octra.live`) is untouched.
Date: 2026-06-24
Scope: the fact-family ledger running behind `devnet.octra.live`. The old fact-v1 devnet Circle remains a soak artifact; the mainnet-shaped rehearsal uses a fresh fact-v2 programmed Circle with AML and assets together.

This scorecard records the gates we require before the fact-ledger model is considered production-ready. It is intentionally conservative: a local/formal pass is not treated as a live pass until the devnet Circle has run through the same path.

## Current Devnet Target

- Network: `octra-devnet`.
- Previous devnet fact-v1 Circle: `octDxjWHdLQX3RRmU9tdh16in35wPR9c8uRniBwEpHsG9K8`.
- Fresh devnet fact-v2 Circle: pending deployment.
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

Latest live headroom, from devnet snapshot `#82` (`vitals.2026-06-24T19:01:20Z`):

| Field | Used | Limit | Remaining |
| --- | ---: | ---: | ---: |
| Canonical payload | 2,968 bytes | 12,000 bytes | 9,032 bytes |
| Evidence manifest | 2,626 bytes | 8,000 bytes | 5,374 bytes |
| Source refs | 1,270 bytes | 4,096 bytes | 2,826 bytes |
| Compact record message | 8,063 bytes | 22,000 bytes | 13,937 bytes |
| Open capsule | 11 rows / 3,245 bytes | 48 rows / 14,160 bytes | 37 rows / 10,915 bytes |

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
| Capsule id bound to observed time | done | AML derives half-day capsule base from `observed_at` and rejects mismatches; live candidate hash `7a2948df...5804601` | Continue soak |
| Latest identity compatibility restored | done | AML writes latest id/time/submitter; live snapshot `#82` readback has id/time/submitter populated | Continue soak |
| Gateway/browser verifier understands capsule-chain roots | done | JS tests + `/api/history` verifier updated for `get_family_capsules_root`; live history proof status `fact_family_verified` | Continue soak |
| Unit suite and native verification green | done | 77 JS tests pass; full native verify passes | — |

### Liveness, Scale & Data Growth

| Gate | Status | Evidence | To close |
| --- | --- | --- | --- |
| Devnet Circle updated to candidate AML | done | Target Circle `octDxj...HsG9K8`; live code hash `7a2948df...5804601`; Circle version 17; in-place update tx `c2fb4942...05dd23a` | Continue soak |
| Snapshot reports expose size headroom | done | Latest submit report includes byte use, remaining headroom, dynamic capsule rows, submitted OU, and receipt effort | Continue monitoring |
| Seal-through a capsule boundary | done | Snapshot `#71` sealed capsule `2026-06-24T12.0000`; tx `960c0bee...698c3039` | Continue soak |
| Over-cadence in one 12h half opens `.0001` cleanly | done | Snapshot `#72` opened `2026-06-24T12.0001`; tx `0fb7e19d...0cf39a7e` | Continue soak |
| Restart/resume across seal boundary | done | Systemd updater service produced snapshot `#73` after gateway restart and sealed-state resume; tx `1a67242d...61b3b559` | Continue soak |
| Many-capsule scale in programmed Circle | open | First fact-ledger capsule is sealed and verified; live open capsule has 11/48 rows; more live capsules still need time | Let devnet accumulate capsules; track read/write cost |

### Read Path & Honesty

| Gate | Status | Evidence | To close |
| --- | --- | --- | --- |
| `/api/latest` serves program-backed data | done | `/api/latest` returns 200, `status=program`, `source=program` after update | Continue monitoring freshness |
| `/api/history` sourced from verified fact-family capsules | done | `/api/history?window=1d` returns 59 canonical points, proof status `fact_family_verified` | Continue monitoring |
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
| Final devnet report | done | Program update report `/var/lib/octra-vitals/reports/fact-ledger-program-update-20260624T184022Z.json`; latest run report `/var/lib/octra-vitals/runs/snapshot-2026-06-24T190120Z-253787/submit_snapshot.json` | Keep updating this scorecard after major gates |

## Mainnet Gate

Mainnet remains no-go until:

- the candidate AML has soaked on devnet beyond the first sealed capsule;
- many-capsule reads and writes remain healthy as devnet history grows;
- browser-side 1d/7d/30d verification timing is measured once enough history exists;
- the final report records receipt effort/cost and live Circle readback;
- the user explicitly approves mainnet.
