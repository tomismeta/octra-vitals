# AML History Devnet Probe Results

Date: 2026-06-22 to 2026-06-23

Scope: devnet-only probe. Mainnet was not touched.

## Purpose

Evaluate whether Octra Vitals should move from a bounded 48-row recent window to an AML-native forever-history design.

The probe tested three things:

- fixed-width open AML capsule bodies for 15-minute observations;
- `map[string]string` support for small capsule metadata and calendar stat nodes;
- the practical cost/risk of larger 96-row/day capsules.

Important caveat: the first capsule probe did not store sealed bodies forever. It kept one open capsule body in AML, computed its hash at seal time, then reset the open body. The map/calendar probe stored small metadata rows and calendar nodes, not body-sized historical capsules. These results are encouraging but they do not yet prove a growing AML map of sealed 14KB+ capsule bodies.

## Local Artifacts

Raw JSON reports are kept locally under ignored `reports/` paths:

```text
reports/aml-history-devnet-pilot-12.json
reports/aml-history-devnet-pilot-48.json
reports/aml-history-devnet-pilot-96-resumed.json
reports/aml-history-devnet-map-calendar-3.json
reports/aml-history-devnet-body-map-2x48.json
```

The shareable summary is this file. The raw reports are not required for a public push.

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

Interpretation: a standalone devnet AML program can retain multiple sealed 14,160-byte capsule bodies in `map[string]string`, retain aligned 3,072-byte transaction indexes, and return all of them later by capsule id. This materially strengthens the AML-resident history case, but it is still not a programmed Site Circle result and it only proves two stored capsules, not months of accumulated map growth.

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

- Browser verification timing for 1-day, 7-day, 30-day, and 1-year views.
- A built-in resumable/progress-reporting long-run probe so failures do not lose partial state.
- A production-like cadence test, because tight back-to-back stress writes are harsher than one snapshot every 15 minutes.
- A longer resident-body map probe that stores more than two sealed capsules and writes progress after every append/seal.
- A programmed Site Circle probe, because standalone AML success is not automatically equivalent to the production host shape.
- A successor-program design review that converts the measured probe shape into a real v1 AML state contract.
- A cutover/migration plan that preserves v0 honestly without fake backfill.

## Recommendation

Use the measured path as the current devnet-favored target, still gated before production successor work:

```text
48-row open capsule body is the conservative measured baseline
96-row open capsule body is technically viable after recovery
map-backed small capsule metadata/calendar rows are viable in standalone AML
sealed 48-row body retention in AML maps is viable for two capsules in standalone AML
aligned tx-index retention in AML maps is viable for two capsules in standalone AML
latest full payload/evidence/source refs retained separately
raw evidence archive remains host-side by content hash
```

The 96-row/day capsule option is viable enough to keep in the design space. It is more elegant operationally because capsule ids line up with UTC days, but the 48-row/12-hour option remains the conservative measured baseline.

The next engineering step should be a resumable resident-body runner that writes progress after every append/seal, then repeats this probe with a longer capsule count and, after that, in a programmed Site Circle shape. A production-cadence soak is still useful for wallet/RPC reliability, but it should not be treated as proof of forever AML-resident history by itself.

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
