# AML Fact Ledger — Devnet Readiness Scorecard

Status: **devnet-only update candidate**. Mainnet (`octra.live`) is untouched.
Date: 2026-06-24
Scope: the fact-family ledger running behind `devnet.octra.live`, with the next AML/runtime update staged for the devnet programmed Site Circle.

This scorecard records the gates we require before the fact-ledger model is considered production-ready. It is intentionally conservative: a local/formal pass is not treated as a live pass until the devnet Circle has run through the same path.

## Current Devnet Target

- Network: `octra-devnet`.
- Devnet Circle: `octDxjWHdLQX3RRmU9tdh16in35wPR9c8uRniBwEpHsG9K8`.
- Devnet wallet: documented separately in `docs/devnet-fact-ledger-wallets.md`; no private material is stored in the repo.
- Mainnet: no deploy, no configuration change, no wallet access.

## Candidate Build

The candidate fact-ledger program was built with `npm run native:verify` on 2026-06-24.

| Artifact | Value |
| --- | --- |
| Source hash | `sha256:4d344e1ae8aad78fd973a0097072967055456ecc1ceb4fe73fc71c488fb1b0db` |
| Bytecode hash | `sha256:89a063fa54e17a773aa6a38bdabc090d938a15d6a48ea5401061f01c63587613` |
| Verification hash | `sha256:bf6d1e091139e7e794d3433cefdc031c9726e43b6c6abe07e3385fbc03ded7ea` |
| Formal result | `safe`, `verified`, 0 errors, 0 warnings |
| Size | 19,370 bytes |
| Instructions | 3,178 |

The generic fact-ledger substrate probe also verifies cleanly:

| Artifact | Value |
| --- | --- |
| Source hash | `sha256:a9a1b9f55d80c2ce591258da54a4dfee5503c400927df254d78975fa0bbb4ac9` |
| Bytecode hash | `sha256:2544030e6df0010cce003f0e9030f5b2a3ee1a3ca0d45cfd22970e228e89e375` |
| Verification hash | `sha256:755b81d964fe3cff6cf9979f6eb358c44941ffd4f266cef7f5abda5734d35a05` |
| Formal result | `safe`, `verified`, 0 errors, 0 warnings |

## Growth-Headroom Changes In This Candidate

Two changes directly address the size fragility found during devnet deployment:

1. **Sealed capsule-chain root.** Each family now stores `family_capsules_root_by_id[family_id]`, and sealed capsule metadata carries `family_root_before` / `family_root_after` for the capsule chain. A browser or gateway can verify a capsule slice by checking ordered capsule-chain continuity instead of replaying all historical rows from genesis.
2. **Per-snapshot size headroom telemetry.** Every producer call/report now includes byte usage and remaining headroom for canonical payload, evidence manifest, source refs, summary row, fact row, compact message, and the 48-row capsule body. Low-margin warnings are emitted before a data-growth change becomes an AML write failure.

The AML state remains boring and bounded per write: one latest payload/evidence/source-ref set, one open capsule body per family, immutable sealed capsules, and small roots/counters.

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
| Core row bound to verified summary | done | `assert_core_row_matches_summary` remains in AML | — |
| Gateway/browser verifier understands capsule-chain roots | done | JS tests + `/api/history` verifier updated for `get_family_capsules_root` | Live history readback after seal |
| Unit suite and native verification green | done | 77 JS tests pass; full native verify passes | — |

### Liveness, Scale & Data Growth

| Gate | Status | Evidence | To close |
| --- | --- | --- | --- |
| Devnet Circle updated to candidate AML | live pending | Candidate compiled locally | In-place `circle_program_update` on devnet |
| Snapshot reports expose size headroom | live pending | `size_headroom` emitted by builder/submitter | Confirm in latest devnet run report |
| Seal-through a capsule boundary | live pending | Code/tests pass | Run devnet cadence past at least one 48-row seal |
| Over-cadence in one 12h half opens `.0001` cleanly | live pending | Code/tests pass | Run devnet burst with real producer snapshots until a new segment opens |
| Restart/resume across seal boundary | open | — | Stop/restart updater across sealed state and confirm clean next write |
| Many-capsule scale in programmed Circle | open | Previous body-map probe reached multiple capsules; fact-ledger needs live soak | Let devnet accumulate capsules; track read/write cost |

### Read Path & Honesty

| Gate | Status | Evidence | To close |
| --- | --- | --- | --- |
| `/api/latest` serves program-backed data | live pending | Existing devnet did before candidate | Reconfirm after update |
| `/api/history` sourced from verified fact-family capsules | live pending | Verifier updated for capsule-chain root | Reconfirm after update and after first seal |
| Browser-side range verification measured | open | — | Measure 1d/7d/30d reads once enough history exists |
| Coverage honesty for short history | done | UI/API expose available coverage; no fake history is synthesized | Continue monitoring |
| Completeness for future multi-family snapshots | deferred | Core-only launch is atomic; 1:many families are not active | Decide before adding route/detail families |

### Ops, Supply Chain & Governance

| Gate | Status | Evidence | To close |
| --- | --- | --- | --- |
| Exact artifacts pinned | live pending | Candidate hashes above | Write hashes to devnet gateway/updater env after Circle update |
| Programmed-Circle method surface includes new views | done | `get_family_capsules_root` / `get_capsules_root` added to readiness method list | Live readiness check |
| No raw private material in repo | done | Secrets remain host-local root-only env files | Continue not printing/copying secrets |
| Cost optimized for devnet update | planned | Current devnet has no sealed capsules; in-place update preserves rows and costs update OU only | Execute `circle_program_update`, not fresh Circle deploy |
| Final devnet report | open | — | Record live hashes, receipt effort, size headroom, seal/overflow results |

## Mainnet Gate

Mainnet remains no-go until:

- the candidate AML is live on devnet with pinned hashes;
- at least one live capsule seal is verified;
- same-half overflow is exercised without brick risk;
- snapshot reports show size headroom with no low-margin warnings;
- `/api/latest`, `/api/history`, `/api/native-readiness`, and `/api/site-integrity` are green on devnet;
- the final report records receipt effort/cost and live Circle readback;
- the user explicitly approves mainnet.
