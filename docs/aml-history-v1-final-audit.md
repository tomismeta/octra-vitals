# AML History v1 Final Audit

Date: 2026-06-23

Scope: read-only architecture audit of the devnet AML forever-history probe and v1 successor plan. Mainnet was not touched.

Review lenses:

- Octra/AML principal engineering
- Data architecture
- CTO/security/operations
- Browser verification and information design

## Post-Rehearsal Addendum

Updated: 2026-06-23 after the devnet v1 successor rehearsal captured in [AML History v1 Devnet Rehearsal](aml-history-v1-devnet-rehearsal.md).

The devnet implementation is a successful proof of the core direction:

- v1 AML successor deployed on devnet as a programmed Circle.
- Full latest payload, evidence manifest, source refs, summary row, compact history rows, capsule body, capsule metadata, and root checkpoints are AML-resident.
- Formal artifact status is `safe` and `verified`.
- The devnet gateway is reading from the v1 programmed Circle and reports `native_ready`.
- `/api/history` is serving v1 capsule-backed rows through the existing compatibility shape.

The final pre-mainnet reviewer consensus is still **no-go for mainnet**.

The mainnet blockers are:

1. **Capsule-boundary liveness.** The original v1 MVP sealed only full 48-row capsules and rejected a capsule-id change while the open capsule was not full. A fixed source now partially seals a non-empty capsule on UTC half-day boundary change and passed a disposable devnet proof. Live devnet still needs a deliberate cutover to that fixed source, and mainnet still needs a longer restart/resume soak through real boundaries.
2. **History-row faithfulness.** AML verifies row shape, index, time field, and payload hash, but it cannot deeply parse JSON. The gateway/updater must rederive and check the full v1 history row from the latest payload, not only the summary projection, before serving or treating the row as canonical.
3. **Time binding.** `observed_at` and `observed_at_unix` need a stronger semantic binding. The current AML checks string shape but does not prove the ISO timestamp and unix timestamp are the same moment.
4. **Forever-history read surface.** The current gateway adapter reads the open capsule or latest sealed capsule. It does not yet expose capsule range discovery, calendar nodes, or verified multi-capsule horizons.
5. **Cutover continuity.** `initialize_v1` records the predecessor, but the product decision is still open: either v1 uses a clean program-scoped index starting at 1, or it seeds from the predecessor final index. The choice must be executable and documented before production.
6. **Release automation.** The devnet rehearsal still needed manual env and manifest regeneration for v1. Mainnet requires first-class v1 artifact awareness, timer pause/resume, hash pins, and cutover checks in the deployment playbook.
7. **Rollover and scale evidence.** Devnet has only a small number of live v1 rows. The synthetic missed-boundary test passed on a disposable Circle, but mainnet still needs a longer live soak through real seals, many-capsule state growth tests, browser/RPC read timing, and fee receipts.

Recommended next gate:

```text
cut live devnet to fixed boundary behavior
add full row/root verification
add v1 range/capsule read path
harden release automation
run devnet rollover + scale soak
repeat final audit on exact source and runbook
```

## Decision

Approved to start **devnet successor implementation work**.

Not approved for v1 cutover, production deployment, or mainnet changes.

The probe evidence is strong enough to build the next devnet contract and read path, but the current probe AML is not production AML. The successor must add the production invariants before any cutover rehearsal.

## Agreed Direction

Use AML-resident fixed-width capsules for canonical forever history from the v1 cutover point forward.

Use **48-row / 12-hour capsules** for the v1 MVP.

Keep **96-row / 1-day capsules** in the research lane only. They are attractive, but they have not yet passed programmed-Circle sealed retention, real cadence through seal, browser read timing, or fee calibration.

Keep full raw RPC/evidence bodies in the host/archive layer by content hash. AML owns the durable compact accounting observations, ordering, hashes, latest provenance strings, and verification commitments.

Do not fake backfill. v0 remains a bounded predecessor tail. v1 history starts when v1 starts collecting.

## What Passed

- Standalone AML retained multiple sealed 48-row capsule bodies.
- Programmed Circle parity passed with exact body, metadata, and root readback.
- Programmed Circle multi-capsule mechanics passed across two sealed capsules.
- A 3-hour wall-clock soak completed 12 real 15-minute ticks with matching roots.
- Local verification timing is comfortable: 30d and 1y CPU hashing are not the obvious bottleneck.
- The fixed-width row shape contains the core conservation/accounting fields and full payload hash commitment.

## Must Fix Before v1 Cutover

1. Production AML invariants

The probe AML accepts separate append/seal calls and operator-supplied metadata. The real successor must enforce:

- sealed capsule immutability;
- capsule-id time binding;
- strict monotonic snapshot index/time;
- metadata/body/root consistency;
- row/schema version checks;
- one canonical `record_snapshot_v1` path;
- no gateway-synthesized canonical history.

2. Transaction lookup index

Do not include AML-resident transaction lookup indexes in the v1 MVP. The final row's transaction hash cannot be known inside the transaction that writes and seals that row.

If tx lookup is added later, it needs a separate non-circular post-seal attachment design, with its own immutability and proof rules.

3. Real browser/Circle-read verification

Local CPU benchmarks are encouraging but insufficient. Before polished UI work, measure real programmed-Circle reads for:

- `1d`
- `7d`
- `30d`
- `1y`
- `all`

Measure RPC count, bytes transferred, decode time, WebCrypto/hash time, memory, and paint time.

4. Seal-through cadence soak

The 3-hour soak proves re-entry into an open capsule. It does not prove a real cadence through a seal boundary. Run a longer devnet soak that fills and seals capsule 3, including restart/resume across the boundary.

5. Many-capsule scale probe

The current evidence proves a small number of retained capsules, not year-scale state growth. Before cutover, run a devnet scale probe with hundreds of retained 48-row body-sized map entries. Measure per-key read cost, total state growth, formal verification behavior, and any per-program state ceiling.

6. Bounded historical proof checkpoints

Sealed capsule records must carry bounded capsule-root checkpoints: `capsules_root_before` in metadata and a separately stored root-after value keyed by capsule id. Putting root-after inside the hashed meta row would be circular. Without these checkpoints, deep historical capsule membership trends toward replaying all prior capsules from genesis.

7. Cost threshold

Do not only "calibrate" cost. Set an acceptable annual fee threshold first, then compare measured receipts against it. If the threshold fails, reduce row bytes or revisit capsule/calendar structure before mainnet.

8. Formal certificate gate

The production v1 AML, not only the probe AML, must compile `safe`/`verified` after immutability, monotonicity, capsule time binding, and atomic seal behavior are added.

9. Single-writer nonce topology

Do not create intentional nonce pressure with competing signers. Instead, prove the production topology has one writer and one nonce authority, with timers/watchdogs active and no second process able to sign with the updater wallet.

10. v0 to v1 continuity

Make the continuity contract executable:

- final v0 index;
- first v1 index;
- predecessor program reference;
- predecessor tail label;
- UI/API language that never presents missing v0 rows as canonical v1 history.

11. Devnet-only tooling hardening

Before successor deploy tooling exists, remove or sharply guard probe escape hatches:

- non-devnet override env vars;
- generic production wallet env fallbacks;
- any path that could point probe scripts at mainnet by environment accident.

## Recommended Next Sequence

1. Commit the current probe/design checkpoint.
2. Harden devnet-only probe tooling and artifact status/checksum reporting.
3. Add the scale/root/cost gates to the v1 spec.
4. Run a seal-through programmed-Circle cadence soak on devnet.
5. Run a many-capsule scale probe on devnet.
6. Build the v1 successor AML with production invariants and 48-row capsules.
7. Build gateway/browser read verification for capsule bodies and calendar nodes.
8. Benchmark real devnet horizon reads.
9. Deploy v1 successor on devnet only.
10. Let devnet collect fresh v1 history.
11. Re-audit before any production/mainnet cutover.

## Product/UI Guidance

The Monitor UI should remain visually quiet. Add horizon controls only after the real read path exists.

Recommended first display:

```text
1d  7d  30d  1y  all
```

Default to `1d`. For long horizons, use calendar nodes first and raw capsules on drill-down. Keep storage terms out of the main flow; put proof details in Verify.

Use precise status language:

- `raw rows verified`
- `day nodes verified`
- `since cutover`
- `predecessor tail`

## Final Recommendation

Go: start devnet successor implementation.

No-go: v1 deploy/cutover.

Absolute no-go: mainnet changes for this feature until devnet successor collection, browser verification, and the next audit pass are complete.
