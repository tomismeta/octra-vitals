# Release Management

This project uses one codebase and environment-specific configuration. Devnet and
mainnet are deployed runtimes, not long-lived branches.

## Source Of Truth

- GitHub `main` is the source of truth for release candidates.
- Tags are public release markers. Use tags for mainnet releases, not for every
  devnet rehearsal.
- `/api/version` is the source of truth for what an environment is actually
  running.
- Always compare the deployed SHA to the local or GitHub SHA before deciding
  whether an environment is current.

Useful checks:

```bash
git rev-parse HEAD
curl -fsS https://devnet.octra.live/api/version
curl -fsS https://octra.live/api/version
git log --oneline <deployed_sha>..HEAD
```

If `git log <deployed_sha>..HEAD` prints commits, that environment is behind the
candidate even if the site looks visually close.

## Promotion Flow

1. Finish local changes on `main`.
2. Run the local gate:

   ```bash
   npm run native:verify
   ```

3. Push `main` to GitHub.
4. Deploy the exact same SHA to devnet.
5. Publish the static assets to the devnet programmed Site Circle when app
   assets changed.
6. Verify devnet:

   ```bash
   curl -fsS https://devnet.octra.live/api/version
   curl -fsS https://devnet.octra.live/api/latest
   curl -fsS https://devnet.octra.live/api/history
   curl -fsS https://devnet.octra.live/api/site-integrity
   curl -fsS https://devnet.octra.live/api/native-readiness
   ```

7. Capture a devnet rehearsal report for mainnet-gated writes.
8. Promote the same SHA to mainnet only after devnet is green and reviewed.
9. Tag the release after mainnet is verified.

## Release History

### v0.5.0 - Mainnet Circle-program hardening

- Live mainnet release at `e10b09d08676337691d37d6f0251b2d9d88c6d6b`.
- Kept the existing main/programmed Circle, Lab Circle, and Octra SQLite history
  database addresses.
- Updated the fact-ledger AML bytecode in place without creating a new era.
- Made the SQLite history mirror the optimized `/api/history` read surface,
  anchored back to AML with gateway latest/history TTL caching disabled.
- Kept app assets Circle-served with `circle_required` static asset policy.
- Added explicit single-provider acknowledgement paths for the current mainnet
  compiler/program RPC topology.
- Verified post-release snapshot `1579`, native readiness, Circle asset parity,
  and SQLite mirror readback.

## Deployment Objects

Every change should be classified before deployment.

| Layer | What changes | Normal deploy object |
| --- | --- | --- |
| Browser app | `app/index.html`, `app/app.js`, `app/style.css`, icons, manifest | Host release plus Circle asset publish |
| Gateway shim | `src/gateway/**`, route behavior, headers, diagnostics | Host release, restart gateway |
| Producer/updater | `src/lib/snapshot.ts`, collection, evidence, write path | Host release, updater timer/service |
| Programmed Circle AML | `program-fact-ledger/main.aml`, schema/state logic | Compatible in-place code update or new era, explicit rehearsal |
| Runtime config | env values, RPC URLs, Circle ids, timers | Host env update, no git change |
| Docs/tests | README, docs, test-only files | GitHub only unless included in producer-audit assets |

If browser app assets changed, the Circle asset publish is required for
`VITALS_STATIC_ASSET_SOURCE=circle_required`. If only gateway code changed, a
host release and gateway restart are usually enough.

If AML changed, do not assume a new era is required. Use a compatible in-place code update only when old state layout, old getters, row encodings, capsule immutability, and authorization semantics remain valid. Use a fresh era when any of those change.

The current security hardening is an in-place update candidate: the state field list, getters, row encodings, roots, and existing initialized owner/operator values are unchanged. It does **not** require a new Circle or history era. It does require the existing Circle's AML code to be updated after compilation and state-preservation rehearsal on devnet. Pause both the updater and the fact ledger before the update; `update-programmed-circle-code` refuses an unpaused ledger, fences all state reads, compares every invariant before and after, and requires byte-for-byte previous bytecode for verified rollback.

Normal `npm run program:compile` is verification-only and must match `program-fact-ledger/approved-release.json`. A new candidate is approved only with `npm run program:compile:refresh`, two agreeing compiler RPCs, `VITALS_REFRESH_AML_PINS_ACK=sha256:<candidate-source-hash>`, and a previous compile artifact matching every old approved hash. Refresh preserves that recovery input as the tracked `program-fact-ledger/previous-approved-compile.json` and a build copy; a clean checkout without a matching current recovery artifact must supply `VITALS_PROGRAM_UPDATE_PREVIOUS_COMPILE_ARTIFACT`. Never refresh pins as a side effect of deployment.

Promotion carries the resulting `build/program-fact-ledger/compile.json` and, when present, its preserved `previous-approved-compile.json` into the host release. The host runs `program:compile:artifact:dist` offline and requires the v2 quorum schema, compiler agreement metadata, decoded-bytecode/certificate validation, and exact approved pins; it does not recompile through a mainnet RPC.

## Circle Asset Batch Publishing

Circle asset publishing defaults to changed-only uploads. The publisher compares
the candidate release asset hashes with live Circle asset bytes and signs
transactions only for changed, missing, forced, or mismatched assets. A new
Circle still uploads the full asset set.

Use `VITALS_SITE_ASSET_UPLOAD_MODE=all` only for explicit recovery or full
republish drills. Use `VITALS_SITE_ASSET_FORCE_PATHS=/app.js,/style.css` to
republish specific assets even when their live hashes already match.

Circle asset batch publishing is an RPC submission optimization, not a new proof
object. Each selected asset is still a separate signed `circle_asset_put`
transaction with its own nonce, transaction hash, confirmation status, and
readback check.

Use `VITALS_SITE_ASSET_SUBMIT_BATCH=1` only after the target environment has
been rehearsed. A valid batch deploy must prove all of the following:

- the `octra_submitBatch` response accepted every prepared asset transaction;
- every selected asset transaction hash confirmed on chain;
- `circle_asset(circle_id, path)` returns the expected bytes, `blob_hash`, and
  `resource_key`;
- `/api/site-integrity` reports local and Circle asset parity.

The value is fewer submit round trips against the RPC and a shorter nonce window
during asset publication. It is not expected to reduce OU materially because the
chain still records one asset transaction per selected file. Changed-only
publishing is where OU savings come from. Keep single-asset publishing as the
fallback path for diagnosis or partial-recovery situations.

## Devnet First

Devnet is the proving lane. It should run the same architecture as mainnet:

```text
VITALS_STATE_TARGET_MODE=circle_program
VITALS_STATE_SOURCE_MODE=program_required
VITALS_STATIC_ASSET_SOURCE=circle_required
```

Program/version compatibility env values should match the deployed AML, but documentation itself does not need per-version copies. Git history is the document version log.

Environment differences should be configuration only: hostnames, Circle ids,
wallets, allowed hosts, public origins, and RPC/network targets.

Before a mainnet write, capture proof from the deployed devnet SHA:

```bash
DEPLOY_DEVNET_REHEARSAL_GATEWAY_URL=https://devnet.octra.live \
bash deploy/mainnet/capture-devnet-rehearsal-report.sh
```

## Mainnet Guardrails

- Do not deploy mainnet from memory. Run `release:plan` and compare SHAs first.
- Do not deploy mainnet with uncommitted local changes.
- Do not deploy a different commit than the one proven on devnet unless the
  difference is intentionally reviewed.
- Do not silently fall back to local assets or sample snapshots in production.
- Keep mainnet wallet material only on the host in root-owned env files.

## Drift Response

When someone asks whether a change is live, answer from data:

1. `git rev-parse HEAD`
2. `curl /api/version` for devnet and mainnet
3. `git log <deployed_sha>..HEAD`
4. classify changed layers from the diff
5. deploy the missing layer only after the target environment is clear

This avoids confusing GitHub freshness, local freshness, Circle asset freshness,
and host runtime freshness.
