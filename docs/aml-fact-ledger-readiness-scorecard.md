# AML Fact Ledger — Devnet Readiness Scorecard

Status: **devnet soak candidate live**. Mainnet (`octra.live`) is untouched.
Date: 2026-06-24
Scope: the fact-family ledger running behind `devnet.octra.live`, updated in place on the devnet programmed Site Circle.

This scorecard records the gates we require before the fact-ledger model is considered production-ready. It is intentionally conservative: a local/formal pass is not treated as a live pass until the devnet Circle has run through the same path.

## Current Devnet Target

- Network: `octra-devnet`.
- Devnet Circle: `octDxjWHdLQX3RRmU9tdh16in35wPR9c8uRniBwEpHsG9K8`.
- Devnet wallet: documented separately in `docs/devnet-fact-ledger-wallets.md`; no private material is stored in the repo.
- Mainnet: no deploy, no configuration change, no wallet access.

## Candidate Build

The candidate fact-ledger program was built with `npm run native:verify` on 2026-06-24 and deployed to the devnet Circle in place.

| Artifact | Value |
| --- | --- |
| Source hash | `sha256:0be233844291a66a9a50a0607d28efde506c65633416e58f214976a35bf061d2` |
| Bytecode hash | `sha256:2423f9af739b7307dd741560e1bd1762821ad412a492f1c7423154f16ae5ef63` |
| Verification hash | `sha256:bf6d1e091139e7e794d3433cefdc031c9726e43b6c6abe07e3385fbc03ded7ea` |
| Formal result | `safe`, `verified`, 0 errors, 0 warnings |
| Size | 19,528 bytes |
| Instructions | 3,214 |

The generic fact-ledger substrate probe also verifies cleanly:

| Artifact | Value |
| --- | --- |
| Source hash | `sha256:a9a1b9f55d80c2ce591258da54a4dfee5503c400927df254d78975fa0bbb4ac9` |
| Bytecode hash | `sha256:2544030e6df0010cce003f0e9030f5b2a3ee1a3ca0d45cfd22970e228e89e375` |
| Verification hash | `sha256:755b81d964fe3cff6cf9979f6eb358c44941ffd4f266cef7f5abda5734d35a05` |
| Formal result | `safe`, `verified`, 0 errors, 0 warnings |

## Growth-Headroom Changes In This Candidate

Three changes directly address the size fragility found during devnet deployment:

1. **Sealed capsule-chain root.** Each family now stores `family_capsules_root_by_id[family_id]`, and sealed capsule metadata carries `family_root_before` / `family_root_after` for the capsule chain. A browser or gateway can verify a capsule slice by checking ordered capsule-chain continuity instead of replaying all historical rows from genesis.
2. **Per-snapshot size headroom telemetry.** Every producer call/report now includes byte usage and remaining headroom for canonical payload, evidence manifest, source refs, summary row, fact row, compact message, and the 48-row capsule body. Low-margin warnings are emitted before a data-growth change becomes an AML write failure.
3. **Fixed-width capsule id slot restored.** The live seal boundary exposed that capsule ids such as `2026-06-24T12.0000` are 18 bytes and must be padded to the 24-byte slot expected by the TypeScript verifier. The AML seal path now uses the same 24-byte capsule id slot as the browser/gateway encoding.

The AML state remains boring and bounded per write: one latest payload/evidence/source-ref set, one open capsule body per family, immutable sealed capsules, and small roots/counters.

Latest live post-restart headroom, from devnet snapshot `#73` (`vitals.2026-06-24T16:53:56Z`):

| Field | Used | Limit | Remaining |
| --- | ---: | ---: | ---: |
| Canonical payload | 2,970 bytes | 12,000 bytes | 9,030 bytes |
| Evidence manifest | 2,626 bytes | 8,000 bytes | 5,374 bytes |
| Source refs | 1,270 bytes | 4,096 bytes | 2,826 bytes |
| Compact record message | 8,042 bytes | 22,000 bytes | 13,958 bytes |
| Open capsule after restart | 2 rows / 590 bytes | 48 rows / 14,160 bytes | 46 rows / 13,570 bytes |

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
| Core row bound to verified summary | done | `assert_core_row_matches_summary` remains in AML | — |
| Gateway/browser verifier understands capsule-chain roots | done | JS tests + `/api/history` verifier updated for `get_family_capsules_root` | Live history readback after seal |
| Unit suite and native verification green | done | 77 JS tests pass; full native verify passes | — |

### Liveness, Scale & Data Growth

| Gate | Status | Evidence | To close |
| --- | --- | --- | --- |
| Devnet Circle updated to candidate AML | done | Circle `octDxj...HsG9K8` code hash `2423f9af...ae5ef63`; in-place update used 1000 OU | Continue soak |
| Snapshot reports expose size headroom | done | Latest submit report includes byte use, remaining headroom, dynamic capsule rows, submitted OU, and receipt effort | Continue monitoring |
| Seal-through a capsule boundary | done | Snapshot `#71` sealed capsule `2026-06-24T12.0000`; tx `960c0bee...698c3039` | Continue soak |
| Over-cadence in one 12h half opens `.0001` cleanly | done | Snapshot `#72` opened `2026-06-24T12.0001`; tx `0fb7e19d...0cf39a7e` | Continue soak |
| Restart/resume across seal boundary | done | Systemd updater service produced snapshot `#73` after gateway restart and sealed-state resume; tx `1a67242d...61b3b559` | Continue soak |
| Many-capsule scale in programmed Circle | open | First fact-ledger capsule is sealed and verified; more live capsules still need time | Let devnet accumulate capsules; track read/write cost |

### Read Path & Honesty

| Gate | Status | Evidence | To close |
| --- | --- | --- | --- |
| `/api/latest` serves program-backed data | done | `/api/latest` returns 200, `status=program`, `source=program` after update | Continue monitoring freshness |
| `/api/history` sourced from verified fact-family capsules | done | `/api/history?window=1d` returns 50 canonical points, capsule-chain verification readable | Continue monitoring |
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
| Final devnet report | done | `/var/lib/octra-vitals/reports/fact-ledger-program-update-20260624T1648Z.json`; latest run reports under `/var/lib/octra-vitals/runs/snapshot-2026-06-24T165356Z-251758/` | Keep updating this scorecard after major gates |

## Mainnet Gate

Mainnet remains no-go until:

- the candidate AML has soaked on devnet beyond the first sealed capsule;
- many-capsule reads and writes remain healthy as devnet history grows;
- browser-side 1d/7d/30d verification timing is measured once enough history exists;
- the final report records receipt effort/cost and live Circle readback;
- the user explicitly approves mainnet.
