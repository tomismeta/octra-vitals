# AML History Devnet Probe Results

Date: 2026-06-22 to 2026-06-23

Scope: devnet-only probe. Mainnet was not touched.

## Purpose

Evaluate whether Octra Vitals should move from a bounded 48-row recent window to an AML-native forever-history design.

The probe tested three things:

- fixed-width open AML capsule bodies for 15-minute observations;
- `map[string]string` support for small capsule metadata and calendar stat nodes;
- the practical cost/risk of larger 96-row/day capsules;
- AML-resident sealed body retention with resumable progress reporting.

Important caveat: the first capsule probe did not store sealed bodies forever. It kept one open capsule body in AML, computed its hash at seal time, then reset the open body. The map/calendar probe stored small metadata rows and calendar nodes, not body-sized historical capsules. These results are encouraging but they do not yet prove a growing AML map of sealed 14KB+ capsule bodies.

## Local Artifacts

Raw JSON reports are kept locally under ignored `reports/` paths:

```text
reports/aml-history-devnet-pilot-12.json
reports/aml-history-devnet-pilot-48.json
reports/aml-history-devnet-pilot-96-resumed.json
reports/aml-history-devnet-map-calendar-3.json
reports/aml-history-devnet-body-map-2x48.json
reports/aml-history-devnet-body-map-4x48.json
reports/aml-history-devnet-body-map-4x48.progress.json
reports/aml-history-devnet-body-map-cadence.json
reports/aml-history-devnet-body-map-circle-12-existing.json
reports/aml-history-devnet-body-map-circle-48.json
reports/aml-history-devnet-body-map-circle-cadence-2caps.json
reports/aml-history-devnet-body-map-circle-cadence-2caps.json.progress.json
reports/aml-history-devnet-body-map-circle-wallclock-soak-3h.json
reports/aml-history-devnet-body-map-circle-wallclock-soak-3h.json.progress.json
reports/history-verification-benchmark-2026-06-23T040302Z.json
reports/history-cost-model-2026-06-23T040301Z.json
```

The shareable summary is this file. The raw reports are not required for a public push.

Remote probe artifacts were copied off `/tmp` to a durable devnet host path during and after the wall-clock soak:

```text
octra-dev:/home/exedev/dev/octra-vitals-history-probe-artifacts/current
```

The disposable wallet env file is not part of that copied tree.

## Compile Results

History capsule probe:

```text
source_hash       sha256:4c358a5ad98cd70d9b4998073da14453542cc899b459db39559d1805d3b58329
bytecode_hash     sha256:bc37503a967b13ec4dbf9e7d416ab629118895339d6bfb9480b36463e8adf08c
verification_hash sha256:5a1f36e4bc4a32cfcfc788b555438deaf1c875a4bf0b286c26de594a2163f37d
safety            safe
verified          true
instructions      452
bytecode size     3150
```

Map/calendar metadata probe:

```text
source_hash       sha256:ffccdf7f00840cb6a438b05e18302060c52eb83e1c09e0aa4327ca188dc3db5a
bytecode_hash     sha256:a283879dbadb1f0d9040fdd73a753f2d95736f9d688a8ff6f0edacfbeb202357
verification_hash sha256:dbd94caed0a96147b2516c486a65dd29c3442395195a6dada0100aeef952a06f
safety            safe
verified          true
instructions      494
bytecode size     3200
```

Resident body-map probe:

```text
source_hash       sha256:1fd669fe7af973c5d21511b7bda64203c6552e7dab8ded1fd4f3b02d17876a92
bytecode_hash     sha256:6124c2a3e721940cfde1ad48b0125d5358488c033df990c1eb7699199f572f1a
verification_hash sha256:9c0458dccb89efa3ba94fe4eff3269de2ca1e16d8244b80bec6f16dee6bc01c3
safety            safe
verified          true
instructions      579
bytecode size     4084
```

## Measured Results

### Open AML Capsule Bodies

| Rows | Horizon | Program | Deploy tx | Body bytes | Meta bytes | Tx-index bytes | Init effort | Append effort avg | Append effort max | Seal effort | Reset effort | Result |
| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 12 | 3h | `oct8LTDwgDEw3dtd9Ezh9xACG6tmwGDzbgsxcZNcTBLfEXT` | `6715534a6fab11d54cb1fe5a8d1c8315ec25c92754804bf14f140cbb24d0f7b2` | 3,540 | 346 | 768 | 1,654 | 1,270 | 1,489 | 563 | 934 | Passed |
| 48 | 12h | `octDbznRAZ2PqxtCn4KEAvLGnvJHbMNWH4Bx3KXYBX3bozh` | `23394ecd39db63888f9a3a9745eb54be0b495f274f2c5523cc3b18de6803f19c` | 14,160 | 346 | 3,072 | 1,660 | 1,418 | 1,628 | 729 | 934 | Passed |
| 96 | 1d | `oct2wi9DGCrHoVy9z6a4Mdr9shenJHejN7ggC6TRgDBt8rL` | recovered from failed full run | 28,320 | 346 | not retained | not retained | 2,029 for final 10 appends | 2,071 for final 10 appends | 951 | 934 | Passed via resume |

Open-body readback matched before seal/reset for the completed runs. After sealing and reset, the open capsule row count returned to `0` and the final root remained available. Sealed body retention was not tested by this first probe.

For the 96-row run, the final body readback returned 28,320 bytes and matched the locally reconstructed capsule body:

```text
body_hash_hex 42c3c14156797d81c8217d6ba6aaf7a4a68f5403f8a1d6a24541834fdd991424
end_root_hex  440113de2e0dcf7495b65bf9a0dc84bebbebb517782d0773e99e40e8ee8935ef
```

### Map-Backed Calendar Metadata

Program:

```text
octnRGTeUvy5S4Mh4zcCgUfz9F4UwzZmGS7qjBw3WbdPe36
```

Deploy transaction:

```text
1c73c54807af3fe7c7a73f4f39de282eda54589bea2760d87c0a71467a2210e9
```

Measured write:

```text
bundle writes            3
capsule metadata writes  3
calendar node writes     9
bundle payload bytes     1,999
initialize effort        1,229
bundle effort avg/max    2,009 / 2,009
```

Each bundle contained:

```text
346-byte capsule metadata row
551-byte day calendar node
551-byte month calendar node
551-byte year calendar node
```

Readback result:

```text
capsule metadata matched  true
day node matched          true
month node matched        true
year node matched         true
```

Conclusion: AML maps using `map[string]string` are viable for this small metadata shape, at least in isolated devnet standalone programs. This does not prove body-sized map values, long-term state growth, or programmed Site Circle behavior.

### Resident Body Map Probe

Program:

```text
octCehSDj3iw4egE1KuDvyMbrZu8efY3j67D9xEQT3RrTSn
```

Deploy transaction:

```text
55b9345469c011538ef7577ab9e6aeb563243a097b87646599d3921830b88b6a
```

Measured write:

```text
capsules stored          2
rows per capsule         48
total rows               96
body bytes each          14,160
metadata bytes each      346
tx-index bytes each      3,072
initialize effort        2,239
append effort avg/max    1,482 / 1,692
seal effort each         3,127
final capsules_root      6e30fe47d187a2a6b7338657aa1e065cc4a963d15b88ef12817ad96297b5b47e
```

Readback result:

```text
capsules_root matched    true
open row count           0
capsule 2026-06-07T00    body true, meta true, tx-index true
capsule 2026-06-07T12    body true, meta true, tx-index true
```

Interpretation: a standalone devnet AML program can retain multiple sealed 14,160-byte capsule bodies in `map[string]string`, retain aligned 3,072-byte transaction indexes, and return all of them later by capsule id. This materially strengthens the AML-resident history case, but it is still not a programmed Site Circle result and the first body-map run only proved two stored capsules, not months of accumulated map growth.

### Resumable Resident Body Map Extension

The 2-capsule body-map program was then extended in place using a resumable runner seeded from the first report.

Program:

```text
octCehSDj3iw4egE1KuDvyMbrZu8efY3j67D9xEQT3RrTSn
```

Measured write:

```text
target capsules          4
rows per capsule         48
total rows               192
body bytes each          14,160
metadata bytes each      346
tx-index bytes each      3,072
new append effort avg/max 1,482 / 1,692
seal effort each         3,127
final capsules_root      59bbbad32a10a8698143c0fcc3988180ed652038999356db72eeca64a94c030d
```

Readback result:

```text
snapshot_count           192
capsule_count            4
capsules_root matched    true
open row count           0
capsule 2026-06-07T00    body true, meta true, tx-index true
capsule 2026-06-07T12    body true, meta true, tx-index true
capsule 2026-06-08T00    body true, meta true, tx-index true
capsule 2026-06-08T12    body true, meta true, tx-index true
```

Progress behavior:

```text
progress file            reports/aml-history-devnet-body-map-4x48.progress.json
progress writes          after seed, every append, every seal, final completion
resume source            reports/aml-history-devnet-body-map-2x48.json
```

Interpretation: the resident-body map shape can be extended beyond the initial two capsules, and the cross-capsule root remains verifiable after four retained body-sized map entries. The resumable runner also fixes the operational gap exposed by the 96-row stress test: a failed long run now leaves enough public progress to continue without restarting from scratch.

### Production-Cadence Soak Tick

The resumable runner was updated to support one-row invocations via `VITALS_HISTORY_BODY_MAP_PROBE_ROWS_PER_RUN=1`, then exercised once against the existing disposable standalone devnet program.

Program:

```text
octCehSDj3iw4egE1KuDvyMbrZu8efY3j67D9xEQT3RrTSn
```

Result:

```text
status                  partial
target capsules          5
row limit                48
rows appended this run   1
rows recorded            193
capsules_root            59bbbad32a10a8698143c0fcc3988180ed652038999356db72eeca64a94c030d
error                    null
```

Interpretation: the probe can now be driven at a 15-minute updater cadence without racing through all remaining rows in one process. The first cadence tick opened capsule 5 and appended one row, leaving the existing four sealed capsules intact. This is a standalone-program cadence tick; the programmed-Circle cadence soak still depends on the parity/funding gate below.

### Programmed Circle Parity

A programmed Site Circle parity pass succeeded at the conservative 48-row capsule size.

Circle:

```text
circle_id              oct9HoM5zCHfJHP8BRmHQtb5mdvqsMZkiZRRjajUt6ep7S8
owner                  oct2TRuwrUoEmDwf7t9nW54Zhs69AZUzMEhctpa5TP64JGZ
runtime                octb
has_program            true
code_hash              6124c2a3e721940cfde1ad48b0125d5358488c033df990c1eb7699199f572f1a
code_bytes             4,084
```

Run:

```text
row_limit              48
snapshot_count         48
capsule_count          1
body bytes             14,160
meta bytes             346
tx-index bytes         3,072
deploy tx              c463b629207f6d5b67b44592d162a696bab105b323576c448f39af22abe88dff
program_update tx      3d8fdf2aac740c8b8c852fbbe471becabe536da8f4f11c6d87958134f04e6ce6
seal tx                9bc7440de0f23fe085ba61ed26cc10eb068a284b66949949c914a9f065de1ab5
program_update OU      50,000
initialize effort      2,239
append effort avg/max  1,481.5 / 1,692
seal effort            3,127
readback_ok            true
capsules_root          4ca6bd3feec25ce123cd5accdb01f5f823407724a4e32d854a9128b291860ec2
```

Readback result:

```text
capsules_root matched  true
body matched           true
meta matched           true
tx-index matched       true
open row count         0
```

Interpretation: the resident body-map shape now has parity across standalone AML and programmed Site Circle for the baseline 48-row capsule size. The production host shape can install the formally verified AML, append a full 12-hour capsule, seal retained body/meta/tx-index values, and return exact stored values later.

The disposable wallet balance after this pass was about `1.739001` devnet OCT.

### Programmed Circle Multi-Capsule Cadence Runner

A dedicated programmed-Circle cadence runner was added after the 48-row parity pass. It resumes against an already-initialized programmed Circle, writes a progress file, appends a bounded number of rows per invocation, and seals only when the open capsule reaches the row limit.

The first cadence invocation appended exactly one row to capsule 2:

```text
circle_id              oct9HoM5zCHfJHP8BRmHQtb5mdvqsMZkiZRRjajUt6ep7S8
rows_appended_this_run 1
rows_recorded          49
target_capsules        2
capsules_root          4ca6bd3feec25ce123cd5accdb01f5f823407724a4e32d854a9128b291860ec2
```

The same runner then completed the remaining rows in an accelerated pass and sealed capsule 2:

```text
rows_appended_this_run 47
rows_recorded          96
base capsule count     1
target capsules        2
row limit              48
capsule id             2026-06-07T12
body bytes             14,160
meta bytes             346
tx-index bytes         3,072
append effort avg/max  1,481.5 / 1,692
seal effort            3,127
seal tx                f7e617c88c5d2bc3dcd8d4842fbf3cd1a5c7ac347056323ca1b5a7045041ae9b
capsules_root          8438f1955031812a72bb723f97169532f1fdc8e3f9f7bb19783ba0aa3edba332
```

Readback:

```text
capsules_root matched  true
open root matched      true
capsule body matched   true
capsule meta matched   true
capsule tx-index       true
```

Interpretation: the programmed Site Circle can continue after an initial sealed capsule, carry the history root forward, open a second deterministic capsule, append rows through a resumable cadence runner, seal the second body/meta/tx-index, and return exact stored values. This clears the multi-capsule programmed-Circle mechanics gate. The state shape and runner behavior have now been exercised across two sealed programmed-Circle capsules.

The disposable wallet balance after this pass was about `1.690001` devnet OCT.

### Programmed Circle 15-Minute Wall-Clock Soak

A true 15-minute cadence soak then ran against the same programmed Circle instead of compressing writes into one process.

```text
circle_id              oct9HoM5zCHfJHP8BRmHQtb5mdvqsMZkiZRRjajUt6ep7S8
wall-clock duration    3h
ticks                  12 / 12
rows before soak       96
rows after soak        108
open capsule           2026-06-08T00
open capsule rows      12
base sealed capsules   2
capsules_root matched  true
open root matched      true
error                  none
durable artifact copy  complete
```

The report status remains `partial` because this soak intentionally appended 12 rows into capsule 3 and did not fill/seal the 48-row capsule. That status means "open capsule still in progress," not failure. The watcher copied the final artifacts to:

```text
octra-dev:/home/exedev/dev/octra-vitals-history-probe-artifacts/current
```

Interpretation: the cadence runner can survive real 15-minute spacing, re-enter cleanly on each tick, preserve the existing sealed capsules, append to an open capsule, and read back matching roots. A longer soak that fills and seals capsule 3 would be useful hardening, but the first wall-clock cadence gate has passed.

#### Earlier 12-Row Programmed Circle Smoke Pass

A first programmed Site Circle smoke pass succeeded using the existing disposable Circle from the failed funding attempt.

```text
circle_id              oct4w52E3Px5caekgZt4azxt9vdhuvbvqCc3w2a1c8BmXjt
row_limit              12
snapshot_count         12
body bytes             3,540
tx-index bytes         768
program_update tx      13f9845a6fd3cf2f58641623c6f415d0f08cba4124bb514e60fea93a1d9d80e1
seal tx                40ce3a17b30ba4b4cf72484ac03b079cad2f5860d96d6b9e5db6f4bfb64b8985
readback_ok            true
```

### Programmed Circle Funding Note

A programmed Site Circle parity runner was added and compiled, then attempted against devnet using the same disposable probe wallet.

Compile result matched the resident body-map AML artifact:

```text
source_hash       sha256:1fd669fe7af973c5d21511b7bda64203c6552e7dab8ded1fd4f3b02d17876a92
bytecode_hash     sha256:6124c2a3e721940cfde1ad48b0125d5358488c033df990c1eb7699199f572f1a
verification_hash sha256:9c0458dccb89efa3ba94fe4eff3269de2ca1e16d8244b80bec6f16dee6bc01c3
```

Disposable Circle created:

```text
circle_id              oct4w52E3Px5caekgZt4azxt9vdhuvbvqCc3w2a1c8BmXjt
owner                  oct2TRuwrUoEmDwf7t9nW54Zhs69AZUzMEhctpa5TP64JGZ
runtime                octb
has_program            false
code_bytes             0
```

The Circle deploy consumed the transaction at deploy nonce 299. The next `circle_program_update` failed before submission with insufficient balance:

```text
program_update history body-map probe Circle submit failed nonce=300 op_type=circle_program_update message_bytes=5463 data_bytes=0: octra_submit failed: insufficient balance
```

Original interpretation:

- programmed Circle creation works for the disposable probe wallet;
- this is a funding/cost gate, not an AML correctness failure;
- the probe runner now writes partial failure reports so future attempts keep the Circle id, nonce, and exact failure.

The first retry reused the empty Circle, installed the program, and completed a 12-row parity pass. After topping up the same disposable wallet, the separate 48-row programmed-Circle pass above completed successfully. Do not use the live devnet updater wallet for these probes.

### Local Verification Benchmark

Synthetic local verification was run against the same fixed-width 48-row capsule shape. This measures local CPU only; it excludes RPC latency and UI rendering.

| Horizon | Capsules | Rows | Bytes verified | Median local verify |
| --- | ---: | ---: | ---: | ---: |
| 1 day | 2 | 96 | 35,156 | 0.539 ms |
| 7 days | 14 | 672 | 246,092 | 2.868 ms |
| 30 days | 60 | 2,880 | 1,054,680 | 10.819 ms |
| 1 year | 730 | 35,040 | 12,831,940 | 125.305 ms |

Interpretation: hash/root verification is not the likely bottleneck. Real browser testing still needs actual programmed-Circle reads because RPC latency, response size, and layout/rendering are outside this local benchmark.

### Cost Model

Using the measured 48-row resident body-map baseline:

```text
snapshots per day        96
snapshots per year       35,040
capsules per year        730
yearly append effort     51,929,280
yearly seal effort       2,282,710
yearly total effort      54,211,990
yearly AML bytes         ~10.589 MB without tx index
yearly AML bytes         ~12.832 MB with tx index
```

This is an effort/byte model, not a final OCT cost projection. Mainnet OCT cost must be calibrated from live fee policy and receipts.

## 96-Row Stress Test

The 96-row/day-capsule path completed, but only after recovery.

The first two stress attempts exposed operational issues:

- Attempt 1 used the live devnet updater wallet and failed with `invalid nonce`, caused by nonce contention with scheduled updater activity.
- Attempt 2 used a dedicated throwaway devnet probe wallet and progressed much farther, but failed near append nonce `89` with `invalid signature`.

Because the dedicated wallet successfully signed and confirmed many earlier writes in the same run, this looked like devnet/RPC long-run submission fragility rather than a deterministic AML size rejection.

The partially written program was then recovered:

```text
program                 oct2wi9DGCrHoVy9z6a4Mdr9shenJHejN7ggC6TRgDBt8rL
recovered open rows     86
remaining appends       10
final body readback     28,320 bytes, matched expected body
seal effort             951
reset effort            934
after reset             snapshot_count=96, open_capsule_row_count=0
```

Conclusion: 96-row/day capsules are technically viable in AML/RPC, but long probe/migration tooling must be resumable.

## What Is Missing

- Browser verification timing using real programmed-Circle reads for 1-day, 7-day, 30-day, and 1-year views.
- A longer wall-clock cadence soak that fills and seals a third programmed-Circle capsule.
- A longer resident-body map probe beyond four sealed capsules, ideally over production cadence rather than tight back-to-back writes.
- A successor-program design review that converts the measured probe shape into a real v1 AML state contract.
- A cutover/migration plan that preserves v0 honestly without fake backfill.

## Recommendation

Use the measured path as the current devnet-favored target, still gated before production successor work:

```text
48-row open capsule body is the conservative measured baseline
96-row open capsule body is technically viable after recovery
map-backed small capsule metadata/calendar rows are viable in standalone AML
sealed 48-row body retention in AML maps is viable for four capsules in standalone AML
aligned tx-index retention in AML maps is viable for four capsules in standalone AML
resumable progress reporting works for long devnet body-map probes
latest full payload/evidence/source refs retained separately
raw evidence archive remains host-side by content hash
```

The 96-row/day capsule option is viable enough to keep in the design space. It is more elegant operationally because capsule ids line up with UTC days, but the 48-row/12-hour option remains the conservative measured baseline.

The next engineering step should be the same resident-body shape in a programmed Site Circle, followed by a production-cadence soak. A longer standalone run is still useful, but the largest remaining architecture uncertainty is now Circle parity rather than whether body-sized AML map entries can work at all.

## Push Recommendation

This is safe to push as a devnet probe/design commit if the commit is clearly labeled as exploratory and devnet-only.

Suggested commit scope:

```text
docs/aml-history-capsules.md
docs/aml-history-devnet-probe.md
docs/aml-history-devnet-probe-results.md
program-history-probe/
src/lib/aml-history-probe.ts
src/scripts/*history*probe*.ts
src/test/aml-history-probe.test.ts
package.json
docs/architecture.md
```

Do not push ignored raw `reports/` JSON files unless there is a specific reason to preserve raw probe evidence in the repo.
