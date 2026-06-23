# AML History v1 Devnet Rehearsal

Date: 2026-06-23

Scope: devnet-only rehearsal of the AML history v1 successor path. Mainnet was not touched.

## Current Result

Devnet is running against the v1 successor Circle and serving program-backed history through the existing gateway/UI path.

```text
site                     https://devnet.octra.live
v1 Circle                octF4GkQPDiJs7Yth1sCG4qXLcJGnZdrz98dWbVh3AhQeGi
predecessor Circle       oct48TxRTECzSNuhu7uDJ4MRyFkD2W2usyZqf2EbpXwRUeg
host release             /opt/octra-vitals/releases/20260623T200608Z
release commit           cb964a7653e00b65817f638d05fd5232c2d61cf3
native readiness         native_ready
site integrity           verified
canonical history        readable
history discovery        aml_history_v1_capsule
history rows observed    3 after cutover
```

## Public Devnet Registry

Public addresses and roles observed during the v1 devnet work:

| Address | Role | Notes |
| --- | --- | --- |
| `oct48TxRTECzSNuhu7uDJ4MRyFkD2W2usyZqf2EbpXwRUeg` | Devnet Site Circle / predecessor reference | Serves the static app assets for `devnet.octra.live`. |
| `octF4GkQPDiJs7Yth1sCG4qXLcJGnZdrz98dWbVh3AhQeGi` | Current live devnet v1 programmed Circle | `devnet.octra.live` still points here after the boundary-fix rehearsal. |
| `oct2TRuwrUoEmDwf7t9nW54Zhs69AZUzMEhctpa5TP64JGZ` | Current live devnet v1 owner/deployer | Expected owner for the live devnet v1 Circle. |
| `oct1FnMzPjPXxXViAco3y7iAwjxvGg4gwjCbwnYx4hujd7p` | Devnet updater/operator wallet | Expected operator for the live devnet v1 Circle. Also used to deploy/operate the disposable boundary-test Circle. |
| `oct3KrVDTTR1tQVE69BG6hT9bBesZFhWfBtQ18DExEsWvWy` | Disposable fixed-build boundary-test Circle | Contains synthetic test snapshots. Do not point `devnet.octra.live` here. |

No private key material is documented here.

The current live devnet deployment remains split between a Site Circle and a program Circle. The next clean cutover should replace that with one fresh programmed Site Circle that contains both the app assets and the v1 AML state program. The disposable boundary-test Circle was program-only proof, not the live target shape.

## v1 Program Artifact

```text
source hash              sha256:dc85f72914843412bec39d543e8e333454813df8a303e5f97fa086199cf30932
bytecode hash            sha256:83639abdd19be63c58e8bc136844d95e4bd02462c3f2192ce84b348ab0747457
verification hash        sha256:f8aeabe0f18bbc702041eb4943932a3903b5f9ee2e11b857e231a9016c653d00
formal status            safe / verified
instructions             1651
bytecode size            11103
```

## Deployment Receipts

```text
program_update tx        4f0613f4521a0ba05cc61aab736f1b4bd41b6fc608a6aeb3e50009c1aa8bdd39
initialize_v1 tx         620ee2e8ce848b4c543bb8f1761c4e210b16ff8ad33922994175782be62898c1
set_operator tx          8d281fea47a087e320ed797edf0685c31c9c0839d9ed9e4ad68647c06df5b216
```

Initial root readback after `initialize_v1`:

```text
history_root             8ccb60fb6a653de3545db4d1d2ec858f40d309d33d978e91c884a1407f5042fd
capsules_root            325fc0030bedcb264437ce41631cf4a599f61c5512202742bb788d0fb99d62ce
open_capsule_body_len    0
```

## Snapshot Receipts

Shadow writes before host cutover:

```text
#1 snapshot              vitals.2026-06-23T19:51:12Z
#1 tx                    022a5308b7a150e005aa0833a8bc241eb26a4d8a0a370c8d3b52ea395675b7e7

#2 snapshot              vitals.2026-06-23T20:03:17Z
#2 tx                    308ba20d26de2697628e933d2032717321f6d67a39d0a8777ff73556ef278d70
```

Live updater write after host cutover:

```text
#3 snapshot              vitals.2026-06-23T20:09:33Z
#3 tx                    501b12e6ca8029c4b786f5e03771b725ffb5526aeb032b828e91d29e1dec690e
```

One scheduled updater tick landed on the predecessor v0 Circle during the release/env switch:

```text
v0 snapshot index        582
v0 tx                    87baff...
time                     2026-06-23T20:06:39Z approximate
impact                   harmless devnet deployment lesson; disable timers during mainnet cutover
```

## Devnet Host Configuration

The devnet gateway and updater were pointed at the v1 Circle with these public-safe settings:

```text
VITALS_STATE_TARGET_MODE=circle_program
VITALS_PROGRAMMED_CIRCLE_ID=octF4GkQPDiJs7Yth1sCG4qXLcJGnZdrz98dWbVh3AhQeGi
VITALS_RECORD_SNAPSHOT_VERSION=v1
VITALS_PROGRAMMED_CIRCLE_ARTIFACT_DIR=program-v1
VITALS_PROGRAMMED_CIRCLE_V1_SOURCE_HASH=sha256:dc85f72914843412bec39d543e8e333454813df8a303e5f97fa086199cf30932
VITALS_PROGRAMMED_CIRCLE_V1_BYTECODE_HASH=sha256:83639abdd19be63c58e8bc136844d95e4bd02462c3f2192ce84b348ab0747457
VITALS_PROGRAMMED_CIRCLE_V1_VERIFICATION_HASH=sha256:f8aeabe0f18bbc702041eb4943932a3903b5f9ee2e11b857e231a9016c653d00
```

## Site Circle Asset Refresh

The devnet Site Circle received a changed-only asset refresh after the host config moved to v1.

```text
mode                     changed-only batch
assets changed           2
asset tx 1               5b0961194263fecea2bbc2740824aebfc477e3aa4483620a1f1fc8279e02e3b7
asset tx 2               0716104768e9ec79a502160c3e835e8103d22262f98c17b3b8b0995db1b2395a
```

## Verification Gates Run

```text
npm test                 passed, 59 tests
npm run program-v1:compile passed
git diff --check         passed
/api/native-readiness    native_ready
/api/history             returned 3 v1 capsule rows
```

Local v1 verification benchmark:

```text
report                   reports/history-verification-benchmark-2026-06-23T200255Z.json
1d                       96 rows, 29,142 bytes, 0.209 ms median
7d                       672 rows, 203,994 bytes, 1.265 ms median
30d                      2,880 rows, 874,260 bytes, 5.811 ms median
1y                       35,040 rows, 10,636,830 bytes, 66.219 ms median
```

## Boundary Fix Rehearsal

Follow-up: 2026-06-23 devnet-only disposable Circle rehearsal for the missed-snapshot boundary case.

The first v1 successor rehearsal revealed that the original source could wedge if a capsule id changed before the open capsule reached 48 rows. The fixed source now partially seals a non-empty capsule when the UTC half-day id changes, then opens the next capsule and records the new row in the same `record_snapshot_v1` call.

Final fixed artifact:

```text
source hash              sha256:3fd7d00b7283ec612eefba40f1f1f8ed36a27f5426c1912ccdc434556d1f470d
bytecode hash            sha256:74ce0daab91d0d245ba327f9983a57cec0dbbe3d86bbce97510ed1bed630b6f3
verification hash        sha256:d493f243ee00cd8886bc1a546e7c55d8ba3d76388be5b04c527525a0570da6aa
formal status            safe / verified
instructions             1778
bytecode size            11702
```

Disposable fixed Circle:

```text
circle                   oct3KrVDTTR1tQVE69BG6hT9bBesZFhWfBtQ18DExEsWvWy
program_update tx        afac31928eceacb95053129134bd7c67855a03127c98c0881ad4db8034fcfcae
initialize tx            c6bc6ba45f4d84e6b4ec63202abf23e90a6998627c40b7876cffa3e601d11b84
```

Boundary test snapshots:

```text
first snapshot           vitals.2026-06-23T11:45:00Z
first tx                 b64fc00748f4ac6c7b48638d116634a0e08b32dbe8da24efe765aa458d4bf2bc

second snapshot          vitals.2026-06-23T12:15:00Z
second tx                c0eeb03386114e60e16687dc5cae7fb901d5b2c28764c36098815de3dd514c4c
```

Passed checks:

```text
snapshot_count           2
capsule_count            1
sealed capsule           2026-06-23T00.0000
sealed row_count         000001
sealed body bytes        295
open capsule             2026-06-23T12.0000
open row_count           1
body hash                matched
sealed end root          matched
capsule root-after       matched
capsules root            matched latest sealed root-after
history root             matched open capsule end root
```

Two useful implementation lessons came out of the failed attempts before the final pass:

- Programmed-Circle unset map slots may read as `"0"`, not only `""`. Sealed-capsule immutability checks now treat both as empty, while real capsule bodies/meta/root values cannot be `"0"`.
- Avoid AML helper parameter names that shadow VM concepts. A parameter named `value` lowered to transaction `VALUE`; renaming it to `count_value` / `slot_value` fixed the generated code.

The live `devnet.octra.live` deployment was not switched to this fixed Circle in this rehearsal. It remains on the prior v1 Circle until a separate devnet cutover updates host env, hash pins, and site metadata deliberately.

## Lessons

1. Do not rely on programmed-Circle constructor defaults for state. `initialize_v1` now seeds every scalar explicitly.
2. Mainnet cutover should disable the updater timer during release/env flips, then re-enable only after gateway/readiness checks pass.
3. Release automation needs first-class v1 artifact awareness. The devnet rehearsal required manual env and manifest regeneration after the release was installed.
4. The original v1 MVP required a full 48-row capsule before the UTC 12-hour capsule id changed. The fixed source now partially seals on boundary change and passed a disposable devnet proof, but live devnet still needs a deliberate cutover to that source.
5. Devnet is healthy enough for continued soak and UI/read-path work. It is not yet a mainnet green light by itself.

## Mainnet Decision Gate

No mainnet deployment should happen until the team explicitly decides how to handle capsule boundary gaps, release automation is cleaned up, and the final audit approves the exact cutover runbook.
