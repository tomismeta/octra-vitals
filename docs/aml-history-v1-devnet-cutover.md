# AML History v1 Devnet Cutover Runbook

Date: 2026-06-23

Scope: preparation for flipping `devnet.octra.live` from the current split devnet deployment to a fresh fixed-build v1 programmed Site Circle. Mainnet is out of scope.

## Decision Rule

Do not point `devnet.octra.live` at the disposable boundary-test Circle:

```text
oct3KrVDTTR1tQVE69BG6hT9bBesZFhWfBtQ18DExEsWvWy
```

That Circle is valuable proof, but it contains synthetic snapshots (`2026-06-23T11:45:00Z` and `2026-06-23T12:15:00Z`). The live devnet cutover should deploy a new clean fixed-build programmed Site Circle and let it start collecting real snapshots from index 1.

## Target Circle Shape

The target devnet cutover shape is one programmed Site Circle containing both:

- the v1 AML state program from `program-v1/main.aml`;
- the static app assets (`index.html`, `app.js`, `styles.css`, icons, manifests, release metadata, and provenance files).

The current devnet deployment is intentionally noted as split because that is the inherited state being replaced:

```text
current assets Circle    oct48TxRTECzSNuhu7uDJ4MRyFkD2W2usyZqf2EbpXwRUeg
current program Circle   octF4GkQPDiJs7Yth1sCG4qXLcJGnZdrz98dWbVh3AhQeGi
```

The cutover candidate should not preserve that split. The gateway remains a thin HTTPS compatibility shim, but Circle-native readers should be able to resolve the app assets and AML state from the same Circle.

If the current webcli/deploy tooling cannot attach assets and a program to the same Circle in one deploy flow, stop and treat that as a release-tooling blocker. Do not silently deploy another split live target.

## Current Public Objects

```text
devnet site              https://devnet.octra.live
site Circle              oct48TxRTECzSNuhu7uDJ4MRyFkD2W2usyZqf2EbpXwRUeg
current live v1 Circle   octF4GkQPDiJs7Yth1sCG4qXLcJGnZdrz98dWbVh3AhQeGi
current live owner       oct2TRuwrUoEmDwf7t9nW54Zhs69AZUzMEhctpa5TP64JGZ
current live operator    oct1FnMzPjPXxXViAco3y7iAwjxvGg4gwjCbwnYx4hujd7p
boundary-test Circle     oct3KrVDTTR1tQVE69BG6hT9bBesZFhWfBtQ18DExEsWvWy
fresh target Circle      TBD; must contain both app assets and v1 AML program
```

Preferred live-devnet wallet topology:

- Owner/deployer: preserve `oct2TRuwrUoEmDwf7t9nW54Zhs69AZUzMEhctpa5TP64JGZ` if that devnet deployer key is available through the existing secure path.
- Operator/updater: preserve `oct1FnMzPjPXxXViAco3y7iAwjxvGg4gwjCbwnYx4hujd7p`.

Acceptable devnet-only fallback:

- Use `oct1FnMzPjPXxXViAco3y7iAwjxvGg4gwjCbwnYx4hujd7p` as both deployer and operator, exactly as the disposable boundary-test Circle did. This is fine for devnet rehearsal, but mainnet should make the owner/operator choice explicitly.

## Fixed Artifact To Deploy

```text
source hash              sha256:19ca6d324eaccd6b87551477580dfd551bb060913a8d98e137c5e5a6dc4ad6ab
bytecode hash            sha256:cdc149f50ffa26d506c1497397cb6044224b469176eea804c2c0e4c5c1701907
verification hash        sha256:e7de44d20b6b9c66d7aee23107f6163525fc41b91cc7a6931e3cd611470566f4
formal status            safe / verified
instructions             1950
bytecode size            12658
```

The fixed build has passed a disposable devnet boundary proof:

```text
partial seal             T00 capsule sealed with one row
next capsule             T12 capsule opened with the next row
overflow seal            T00.0000 sealed at 48 rows; T00.0001 can continue the same half
body/meta/root checks    passed
```

## Pre-Cutover Gates

Run these locally before touching `octra-dev`:

```bash
npm test
npm run program-v1:compile
git diff --check
```

Confirm the live devnet baseline:

```bash
curl -fsS https://devnet.octra.live/api/native-readiness
curl -fsS https://devnet.octra.live/api/latest
curl -fsS https://devnet.octra.live/api/history
```

Required baseline:

- `native_readiness.status` is `native_ready`.
- Current programmed Circle is still `octF4GkQPDiJs7Yth1sCG4qXLcJGnZdrz98dWbVh3AhQeGi`.
- Site Circle assets are verified.
- Current history is readable.
- Updater and watchdog timers are active before the cutover starts.

## Cutover Steps

1. Pause devnet updater/watchdog timers on `octra-dev`.

   This avoids nonce races and avoids a final write landing on the old Circle mid-cutover.

2. Deploy a fresh fixed-build v1 programmed Site Circle on devnet.

   Use the fixed artifact above. The same Circle must also receive the static app assets. Set `predecessor_program` to the current live v1 Circle:

   ```text
   octF4GkQPDiJs7Yth1sCG4qXLcJGnZdrz98dWbVh3AhQeGi
   ```

3. Initialize the fresh Circle.

   Set owner/deployer and operator according to the chosen devnet wallet topology. If owner and operator are split, verify both with public views.

4. Do not run the synthetic boundary rehearsal against the live candidate Circle.

   The boundary proof already passed on a disposable Circle. The live candidate should start with real collected snapshots only.

5. Submit one real shadow snapshot to the fresh Circle.

   Verify:

   - `record_snapshot_v1` receipt success;
   - latest payload/source/evidence/summary hashes match;
   - latest history row hash matches;
   - open capsule body ends with the submitted row;
   - `history_root` equals `open_capsule_end_root`.

6. Update `octra-dev` gateway/updater env files together.

   Public-safe values to change:

   ```text
   VITALS_SITE_CIRCLE_ID=<fresh-fixed-programmed-site-circle>
   VITALS_PROGRAMMED_CIRCLE_ID=<fresh-fixed-circle>
   VITALS_RECORD_SNAPSHOT_VERSION=v1
   VITALS_PROGRAMMED_CIRCLE_ARTIFACT_DIR=program-v1
   VITALS_PROGRAMMED_CIRCLE_V1_SOURCE_HASH=sha256:19ca6d324eaccd6b87551477580dfd551bb060913a8d98e137c5e5a6dc4ad6ab
   VITALS_PROGRAMMED_CIRCLE_V1_BYTECODE_HASH=sha256:cdc149f50ffa26d506c1497397cb6044224b469176eea804c2c0e4c5c1701907
   VITALS_PROGRAMMED_CIRCLE_V1_VERIFICATION_HASH=sha256:e7de44d20b6b9c66d7aee23107f6163525fc41b91cc7a6931e3cd611470566f4
   ```

   `VITALS_SITE_CIRCLE_ID` and `VITALS_PROGRAMMED_CIRCLE_ID` should be the same public address after this cutover. If the runtime requires separate names, keep both names for compatibility but point them at the same Circle.

7. Regenerate public app metadata from the new env.

   At minimum regenerate:

   - `producer.audit.json`
   - `vitals.manifest.json`
   - `site-circle-release.json`

8. Publish app assets into the fresh programmed Site Circle.

   Because this is a fresh Circle, upload the full canonical asset set once. After the cutover, return to changed-only/batch uploads for incremental releases.

9. Restart gateway.

10. Run runtime verification.

    Required checks:

    - `/api/native-readiness` reports `native_ready`;
    - `circle_program_verified` is true;
    - owner/operator match expected public addresses;
    - Site Circle and programmed Circle identifiers are the same Circle, or the readiness response explains an approved tool-level reason they are not;
    - fixed source/bytecode/verification hashes match;
    - `circle_program_required_methods_present` is true;
    - `site_circle_assets_verified` is true;
    - `/api/latest` serves program-backed data from the fresh Circle;
    - `/api/history` reports `history_discovery: aml_history_v1_capsule`;
    - no sample/bootstrap fallback is used.

11. Re-enable updater/watchdog timers.

12. Observe at least two scheduled real snapshots.

    Verify snapshot indices advance, Telegram/operator alerts stay clean, and `/api/history` row count increases on the fresh Circle.

## Additional Gates Before Calling Devnet Cutover Complete

- Full local test suite passes after any cutover-script changes.
- `program-v1:compile` hash pins match the host env and readiness output.
- The fresh target exposes both app assets and the v1 AML program from the same Circle.
- Public raw evidence links for the first fresh Circle snapshot render correctly.
- Submit readback includes sealed-capsule verification once a capsule has sealed.
- Timer restart/resume is documented in the deployment report.
- A rollback note exists: point env back to `octF4GkQPDiJs7Yth1sCG4qXLcJGnZdrz98dWbVh3AhQeGi`, regenerate metadata, restart gateway/updater.

## Audits Before Mainnet Consideration

After devnet is flipped to the fresh fixed Circle and has soaked:

1. Octra/AML principal review:
   - boundary sealing;
   - map-slot empty handling;
   - no `value`-style AML shadowing hazards;
   - formal artifacts match deployed bytecode.

2. Data architecture review:
   - fresh v1 sequence starts cleanly;
   - predecessor reference is explicit;
   - no fake backfill;
   - capsule body/meta/root proof path works.

3. CTO/release review:
   - timer pause/resume is automated;
   - env/hash pins are updated atomically;
   - changed-only Circle asset upload behaves predictably;
   - rollback path is real.

4. Security review:
   - no private key material appears in reports/logs/docs;
   - service env permissions remain root-only;
   - disposable test Circle cannot be mistaken for the live Circle.

5. Product/UI verification:
   - devnet banner still makes environment clear;
   - latest/history/proof links point to devnet;
   - no stale mainnet references in the devnet UI.

## Mainnet Gate

Passing this devnet cutover does not authorize mainnet. It only produces the evidence needed for the next mainnet decision conversation.
