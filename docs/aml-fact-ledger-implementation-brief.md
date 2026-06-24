# AML Fact Ledger Implementation Brief

Status: implementation handoff for devnet. Mainnet remains no-go until the
gates below pass.

Date: 2026-06-23

## Current Implementation Status

Initial additive implementation work has started without changing any live
devnet or mainnet target.

- `src/lib/aml-fact-ledger.ts` pins the fact-family fixed-width codecs, roots,
  and capsule metadata.
- `program-fact-ledger-probe/main.aml` is a disposable Gate 0 substrate probe.
- `program-fact-ledger/main.aml` is the first production-shaped candidate. It
  preserves the latest snapshot/evidence/source-ref getter surface, records
  family `0000` core accounting rows, seals immutable capsules, enumerates
  sealed capsules by ordinal, and stores predecessor era anchors.
- `src/scripts/build-record-snapshot-call.ts` can emit explicit `fact-v1`
  record bundles behind `VITALS_RECORD_SNAPSHOT_VERSION=fact-v1`.
- `src/scripts/submit-snapshot.ts` requires a target-bound
  `VITALS_FACT_LEDGER_CUTOVER_ACK=fact-v1:<target_kind>:<target_id>` and a
  live `manifest() == octra-vitals-fact-ledger.v1` preflight before any
  `fact-v1` write is signed.
- `/api/history` remains the normalized UI contract and can request a 30-day
  window while the gateway reads recent fact-family capsules.
- `npm run fact-ledger-probe:compile` passed Octra AML compilation and formal
  verification on 2026-06-23:

```text
source_hash       sha256:a9a1b9f55d80c2ce591258da54a4dfee5503c400927df254d78975fa0bbb4ac9
bytecode_hash     sha256:2544030e6df0010cce003f0e9030f5b2a3ee1a3ca0d45cfd22970e228e89e375
verification_hash sha256:755b81d964fe3cff6cf9979f6eb358c44941ffd4f266cef7f5abda5734d35a05
safety            safe
verified          true
instructions      1407
size              8702
```

This proves the small generic substrate compiles and verifies with stricter
row-key, capsule-id, and capsule-metadata checks. It does **not** mean devnet or
mainnet is ready to cut over. The probe does not replace the production
latest-bundle program surface, and it does not yet provide sealed range reads.

- `npm run fact-ledger-program:compile` passed Octra AML compilation and formal
  verification on 2026-06-23:

```text
source_hash       sha256:cd3ab1807b2d813e8e207fe4866d7299efe59ff1fc7c2dc2f09a9e899375bd66
bytecode_hash     sha256:5f65e1c69d33cb3f8f35545d5ffebdfe4b1257ed1b4a7bfd3dbed382d8f5057a
verification_hash sha256:d40c7c252a68d1db5899e8168b1a3aa9efbe4e89c44ddf36d8b1d787836d86a2
safety            safe
verified          true
instructions      2999
size              18579
```

This proves the production-shaped candidate compiles and verifies locally. It
still is **not** a devnet cutover approval. Before devnet cutover, the project
must run a disposable devnet/programmed-Circle rehearsal that initializes the
candidate, records real or fixture snapshots with `fact-v1`, seals through a
capsule boundary, reads recent sealed capsules through `/api/history`, and
passes the reviewer gates.

## Instruction

Implement the **fact-family ledger** path, not the interim simple capsule log.

`program-v1/main.aml` is the proven devnet mechanics vehicle. Keep it as a
source of known-good encodings, tests, soak behavior, and formal-verification
lessons. Do not treat `program-v1` or the simple-capsule v1 docs as the mainnet
target unless Gate 0 fails and the project explicitly selects the fallback.

Primary target spec:

- [AML Extensible Fact Ledger Proposal](aml-extensible-fact-ledger-proposal.md)
- [ADR 0002: AML History Era Model](adr-0002-aml-history-era-model.md)
- [Fact Ledger API and UI Compatibility Evaluation](fact-ledger-api-ui-compatibility.md)

Interim proof docs, now superseded for mainnet:

- [AML History v1 Successor Plan](aml-history-v1-successor-plan.md)
- [AML History v1 Devnet Cutover Runbook](aml-history-v1-devnet-cutover.md)
- [AML History v1 Devnet Rehearsal](aml-history-v1-devnet-rehearsal.md)
- [AML History v1 Final Audit](aml-history-v1-final-audit.md)

## Target Shape

Build one unified fact-family ledger:

```text
family 0: core_accounting
family N: future one_per_snapshot auxiliary facts
```

For the first devnet implementation, support only:

```text
family_cardinality = one_per_snapshot
```

Defer `entity_per_snapshot` route fanout and `period_projection` derived-index
families until they have their own proof.

## Gate 0: Formal Substrate Probe

Build the smallest generic AML substrate first:

```text
2-entry family definition catalog
append_to_family()
seal_family_capsule()
one_per_snapshot ordering only
fixed-width rows
body/meta/root-after maps
write-once sealed capsules
```

Run it through `octra_aml` before building the full program.

Gate 0 must prove the universal-over-`family_id` invariants:

- family definitions are write-once;
- row length, family id, schema id, row version, and key shape are enforced;
- strict snapshot-index ordering holds for every catalogued family;
- sealed capsules cannot be overwritten;
- body hash, metadata, start root, end root, and root-after agree;
- root domains include era/program id, family id, schema id, key, row ordinal,
  and row bytes;
- empty slots use the known safe sentinel and cannot be confused with real rows.

If Gate 0 fails, stop. The fallback is the simple core capsule path or a
narrower hybrid, not a partially generic mainnet AML.

## Era Anchoring

The program must not rely on predecessor pointers alone.

Initialization must store:

```text
era_id
era_first_snapshot_index
predecessor_program
predecessor_final_index
predecessor_final_root
predecessor_anchor_hash
```

`predecessor_anchor_hash` should domain-separate and commit to at least:

```text
domain
network id
predecessor program/circle id
predecessor final index
predecessor final history/root commitment
successor program/circle id
era_first_snapshot_index
```

The first fact-ledger snapshot must start at `era_first_snapshot_index`.
Cross-era charts may stitch eras, but verification must expose which era
produced each row.

## Encoding Derivation

Do not invent fresh encodings if the proven v1 artifact already solved the
shape.

Derive from `program-v1` where possible:

- core row: the proven 295-byte fixed-width layout;
- capsule metadata: the proven 411-byte meta layout;
- generic `seal_family_capsule`: parameterize the verified
  `seal_current_capsule` behavior;
- root-after checkpoints and sealed immutability guards;
- the empty-slot sentinel lesson from v1.

The fact-ledger program should look like the v1 proof generalized around
`family_id`, not a new unrelated storage machine.

## Capsule Seal Requirement

Fix the zero-margin capsule-id collision in the shared generic seal.

Testing the boundary is not enough. The design must include the actual liveness
fix, such as:

- unique-on-overflow capsule ids;
- explicit headroom;
- or a recovery path.

The fix must apply once in `seal_family_capsule()` so it protects every family.

## Write Path

Use bounded atomic batches first.

```text
record_snapshot(
  latest_bundle,
  core_accounting_row,
  aux_slot_1,
  aux_slot_2,
  ...
)
```

Probe:

```text
0 auxiliary slots
2 auxiliary slots
4 auxiliary slots
8 auxiliary slots as stress only
```

Do not implement the attachment path for mainnet launch. `attach_family_row`
introduces partial snapshot state and should remain a future high-fanout escape
hatch.

## Completeness Strategy

Do not default to a per-snapshot completeness map.

With bounded atomic batches, completeness is first implied by the atomic write.
Probe completeness in tiers:

1. Atomic batch only.
2. Capsule-level completeness commitment.
3. Per-snapshot completeness commitment only if future attachments or
   high-fanout entity rows require it.

Avoid `snapshot_family_set_hash[snapshot_index]` as launch state unless it
clearly earns its cost. It is high-cardinality and requires root checkpoints for
bounded historical verification.

## Gateway And Browser Scope

This is not AML-only work. The gateway and browser verifier are co-equal.

They must support:

- the existing latest-bundle getter surface used by `/api/latest`;
- family-aware reads;
- family definition/state discovery from AML, not gateway-local config;
- per-family capsule verification;
- family 0 latest-row faithfulness from the latest payload;
- era stitching with proof boundaries visible;
- absence states: `zero`, `not_captured_before_activation`, `not_applicable`,
  `source_unavailable`, `pending`, `invalid`;
- no synthesized canonical history.

## Tests And CI

Ship a new test suite for the substrate. The existing `aml-history-v1` tests
cover the simple capsule log, not the generic ledger.

Required tests:

- Gate 0 formal substrate test;
- row header and length enforcement;
- family id uniqueness and deterministic enumeration;
- immutable family definitions;
- strict one-per-snapshot ordering;
- missing required family 0 row rejection;
- duplicate family slot rejection;
- bad row length/schema/family id rejection;
- capsule boundary and overflow liveness;
- sealed capsule immutability;
- root-after consistency;
- old fixture byte-identical compatibility;
- absence-state rendering/verification;
- gateway latest-row faithfulness;
- browser range verification timing for real Circle reads.

Compatibility fixtures must be CI gates for same-era upgrades. A compatible
update must prove old getters, old rows, old capsules, map keys, root domains,
and sealed immutability are byte-identical.

## Devnet Sequence

```text
1. Gate 0 formal substrate probe.
2. Build full one_per_snapshot substrate with family 0.
3. Probe bounded atomic slots: 0, 2, 4, 8 stress.
4. Probe capsule boundary and overflow behavior.
5. Probe many-capsule scale in a programmed Site Circle.
6. Add gateway/browser family-aware verification.
7. Measure real Circle reads for 1d, 7d, 30d, 1y.
8. Calibrate costs from real receipts against a predeclared budget.
9. Run over-cadence and restart/resume soak through real seals.
10. Repeat architecture/security/AML/data audit on exact source and runbook.
```

## Mainnet No-Go Until

Mainnet remains no-go until all of these are true:

- exact AML source is formally `safe` and `verified`;
- Gate 0 passed;
- family maps and many-capsule state scale in a programmed Site Circle;
- seal-through and overflow behavior has soaked live on devnet;
- gateway/browser range verification is measured and acceptable;
- cost is calibrated from receipts;
- deployment automation can pause/resume timers and pin exact artifacts;
- no mainnet path relies on gateway-local history;
- final review approves the exact source, hashes, runbook, and rollback plan.
