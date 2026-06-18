# Operations Notes

This runbook describes a generic public v0 deployment. Hostnames, usernames, wallets, and release paths should be supplied by the deploy operator and kept out of git.

## Runtime Layout

Recommended host layout:

```text
/opt/octra-vitals/current        release checkout or symlink
/var/lib/octra-vitals            runtime data, receipts, evidence, updater runs
/etc/octra-vitals/gateway.env    non-secret gateway config
/etc/octra-vitals/updater.env    signer/updater config, including secrets when writes are enabled
/etc/octra-vitals/watchdog.env   optional watchdog overrides
```

Create a dedicated system user:

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin octra-vitals || true
sudo install -d -m 750 -o octra-vitals -g octra-vitals /var/lib/octra-vitals
sudo install -d -m 755 -o root -g root /etc/octra-vitals
sudo install -m 640 -o root -g octra-vitals /dev/null /etc/octra-vitals/gateway.env
sudo install -m 600 -o root -g root /dev/null /etc/octra-vitals/updater.env
```

## Verification

Run the full local gate before deploying artifacts:

```bash
npm install
npm run native:verify
```

This runs tests, canonical JSON checks, standalone AML compile/verify, programmed-Circle AML compile/verify, Site Circle release packaging, and a dry-run Circle deploy.

## Devnet Dogfood

The devnet deployment is the place to observe cadence, RPC semantics, gateway thinness, and Circle asset integrity before a public/mainnet cutover. During a dogfood window, avoid changing AML, timers, or gateway runtime unless the change is intentionally part of the test.

For production rehearsal, devnet/stage should mirror mainnet architecture: one programmed Site Circle, `VITALS_STATE_TARGET_MODE=circle_program`, `VITALS_STATE_SOURCE_MODE=program_required`, Circle-required static assets, and environment-only differences for hosts, wallets, RPCs, and public origin. Capture the mainnet gate proof with:

```bash
DEPLOY_DEVNET_REHEARSAL_GATEWAY_URL=https://devnet.octra.live \
bash deploy/mainnet/capture-devnet-rehearsal-report.sh
```

The older split dogfood shape is only a compatibility fallback:

- Observations use the live Octra RPC: `OCTRA_OBSERVATION_RPC_URL=https://octra.network/rpc`.
- AML state reads/writes use the deployed dogfood state-program environment: `OCTRA_PROGRAM_RPC_URL=https://devnet.octrascan.io/rpc` while the Vitals State Program is on devnet.

In that fallback, Vitals can observe live/mainnet Octra supply and bridge data while persisting experimental Vitals State Program snapshots to devnet. Do not treat that split fallback as sufficient mainnet rehearsal.

Useful live checks:

```bash
systemctl status octra-vitals-dev.service
systemctl status octra-vitals-dev-updater.timer
systemctl status octra-vitals-dev-watchdog.timer
journalctl -u octra-vitals-dev-updater.service --since "24 hours ago"
curl http://127.0.0.1:4173/api/latest
curl http://127.0.0.1:4173/api/history
curl http://127.0.0.1:4173/api/native-readiness
curl http://127.0.0.1:4173/api/site-integrity
```

Gateway traffic aggregation is optional and intentionally local. Enable it in `gateway.env` when request counts are useful:

```bash
VITALS_TRAFFIC_AGGREGATES=1
VITALS_TRAFFIC_DIR=/var/lib/octra-vitals/traffic
VITALS_TRAFFIC_CLIENT_MODE=daily_hash
VITALS_TRAFFIC_TRUST_PROXY_HEADERS=1
VITALS_TRAFFIC_DIAGNOSTIC_PATH_LIMIT=100
```

This stores hourly route/status/latency counters plus daily-rotating client hashes for unique-client estimates. If `VITALS_TRAFFIC_DIAGNOSTIC_PATH_LIMIT` is greater than zero, it also stores a bounded list of exact paths for 404/405/5xx diagnostics, with query strings stripped. It does not store raw IPs, user agents, cookies, query strings, headers, or request bodies. Summarize route traffic for graphing with:

```bash
npm run traffic:summary:dist -- --csv
```

Summarize diagnostic paths with:

```bash
npm run traffic:summary:dist -- --diagnostic-paths --csv
```

Snapshot updater runs are also summarized from structured run reports. Export recent run health for graphing with:

```bash
npm run snapshot-runs:summary:dist -- --csv --limit 96
```

This reads `VITALS_DATA_DIR/runs/*/snapshot_update_report.json` and reports status, snapshot id/index, transaction hash, collect/submit/total timing, collect retry counts, and readback status.

Telegram operator notifications are host-local and optional. They read the same local aggregates and gateway health endpoints, then send only summarized status to Telegram. They do not send raw RPC bodies, raw IPs, headers, user agents, cookies, wallet env, or request bodies.

Configure Telegram from the host so the bot token never passes through chat or git:

```bash
sudo bash /opt/octra-vitals/current/deploy/mainnet/configure-telegram-notify.sh
```

The script writes `/etc/octra-vitals/notify.env` as `root:octra-vitals` with mode `0640`, sends an optional test message, and can enable:

```bash
octra-vitals-notify-alerts.timer
octra-vitals-notify-digest.timer
```

Alerts run every five minutes and de-dupe repeated failures with `/var/lib/octra-vitals/notify/alert-state.json`. The digest runs hourly. Manual checks:

```bash
sudo -u octra-vitals bash -lc 'set -a; . /etc/octra-vitals/notify.env; set +a; cd /opt/octra-vitals/current; node dist/scripts/notify-operator.js --stdout'
sudo -u octra-vitals bash -lc 'set -a; . /etc/octra-vitals/notify.env; set +a; cd /opt/octra-vitals/current; node dist/scripts/notify-operator.js --alerts --stdout'
```

The hourly digest is formatted for Telegram and reports the last completed UTC hour, plus a completed 24-hour topline. The latest snapshot section still reports the freshest current gateway state.

The current public v0 AML history surface is a bounded 48-row summary window. At a roughly 16 minute cadence, the UI-visible trend window is about 12.5 hours even if the producer has been submitting for longer. Use `snapshot_index`, updater receipts, and journal logs to confirm longer operational uptime.

If a host is still using `octra-vitals-dev-*` systemd units, leave those names alone while actively monitoring a run. Migrate to the generic `octra-vitals-*` templates during a planned deploy window, not as incidental cleanup. `devnet.octra.live` was migrated to the generic templates on 2026-06-17.

## Programmed-Circle Rehearsal

Use a separate stage host when you need a destructive rehearsal. The active devnet host now runs the programmed Site Circle shape directly and should be treated as the main pre-mainnet dogfood environment.

```text
octra-dev
  programmed Site Circle dogfood
  devnet.octra.live

octra-stage
  optional clean rehearsal
  mainnet-shaped deploy process
```

Current environment comparison:

| Area | octra-dev | octra-stage |
| --- | --- | --- |
| Role | Programmed-Circle dogfood environment | Optional clean rehearsal |
| State shape | Programmed Site Circle: assets and Vitals AML under one Circle | Programmed Site Circle: assets and Vitals AML under one Circle |
| State target | `circle_program` | `circle_program` |
| Canonical state id | `oct48TxRTECzSNuhu7uDJ4MRyFkD2W2usyZqf2EbpXwRUeg` | new rehearsal Circle |
| Site Circle id | same as programmed Circle | same as programmed Circle |
| Gateway port | `4173` for current devnet ingress | `8000` for Exe public preview unless overridden |
| Static assets | Circle-required | Circle-required, served from the programmed Circle |
| Updater timer | Enabled via `octra-vitals-updater.timer` | Disabled by default to avoid shared-wallet nonce collisions |
| Snapshot writes | Automatic dogfood cadence | Manual until stage has a dedicated wallet or dev is paused |
| Readiness target | Must remain `native_ready` on the active dogfood Circle | Must reach `native_ready` before mainnet rehearsal is considered good |

Exe VMs route authenticated public HTTPS to exposed image ports, not arbitrary process ports. The current image exposes `8000/tcp` and `9999/tcp`; keep Vitals on `8000` and leave `9999` to Exe. Unauthenticated public curl will usually see an Exe login redirect, while an authenticated browser session should reach the Vitals gateway.

Push a verified release to stage:

```bash
bash deploy/mainnet/push-release.sh octra-stage.exe.xyz
```

That script runs `npm run native:verify`, syncs the checkout to the host, preserves existing env files, bootstraps runtime dependencies, builds on the host, writes `producer.audit.json` and `build/site-circle-release.json` using the host env, runs the programmed-Circle compile/verify gate again, and updates `/opt/octra-vitals/current`.

Deploy and initialize a fresh programmed Circle from the stage host. The script is root-started so `/etc/octra-vitals/updater.env` can stay `0600 root:root`; it drops to the operator process after sourcing the env:

```bash
sudo bash /opt/octra-vitals/current/deploy/mainnet/deploy-programmed-circle.sh
```

Then set the returned values in both gateway and updater env:

```bash
sudo bash /opt/octra-vitals/current/deploy/mainnet/configure-programmed-circle.sh
```

That script reads `/var/lib/octra-vitals/programmed-circle-deploy.json`, keeps signer material in `updater.env`, writes a non-secret `gateway.env`, points both envs at the programmed Circle, sets `VITALS_STATIC_ASSET_SOURCE=circle_required`, and sets `PORT=8000` for Exe preview.

Publish the static app assets into the same programmed Circle:

```bash
sudo bash /opt/octra-vitals/current/deploy/mainnet/publish-programmed-site-assets.sh
```

For the first stage write, keep the timer disabled and run one manual update:

```bash
sudo bash /opt/octra-vitals/current/deploy/mainnet/submit-one-snapshot.sh
```

### Devnet Migration Rehearsal Note

The 2026-06-17 devnet cutover intentionally did not rewrite historical summary rows. The old devnet artifacts used temporary `octra-vitals-snapshot-v0.3` payload/hash-domain strings, while the clean programmed Circle accepts the public `octra-vitals-snapshot-v0` schema. Replaying those rows failed with `execution reverted [payload schema]`, which is the correct outcome.

For mainnet, start clean with the public v0 schema and seed a fresh snapshot. For any future upgrade, either keep schema strings stable when the canonical payload semantics remain compatible, or deploy an explicit successor/migrator that documents exactly how hashes and indexes are preserved. Do not mutate old payloads merely to make a replay pass.

Verify the runtime:

```bash
sudo bash /opt/octra-vitals/current/deploy/stage/verify-runtime.sh
```

Only enable the timer after `/api/latest` and `/api/history` read back from `vitals-circle-program`, `/api/site-integrity` reports local and Circle asset matches, and `/api/native-readiness` reports `native_ready`. If stage and dev share a wallet, keep the stage updater timer disabled or offset the cadence so the two hosts do not compete for nonces.

Latest clean stage rehearsal:

```text
date: 2026-06-15
host: octra-stage.exe.xyz
method: deploy/mainnet/run.sh full_cutover with DEPLOY_ENVIRONMENT=stage
programmed_circle_id: oct54NYWahKZfNouRfi8Y5SGMSVyKf69bWwRZvSDJt2dcA7
program_update_tx: 534a2be77a358288e16023935871d0e1fece953ccaebf9bb6c06181cdaf64e0a
initialize_tx: a85ecc0f5458a867cb79d5cf4ab3cd0dcc57f4666e83bfd97c2da70506998b06
asset_publish_txs: 6
manual_snapshots: 2
latest_snapshot: vitals.2026-06-15T17:01:21Z
latest_snapshot_index: 2
latest_snapshot_tx: 91ec25a64ee4dedf2a9280d4c0d13ce18cdb09d340ee8697e1d1a4977211631a
readiness: native_ready
history_rows: 2
stage_timers: disabled
```

## Mainnet Cutover Plan

The mainnet target is a programmed Site Circle: app assets and Vitals AML state live under one Circle identity. The active devnet deployment now uses this same shape; the separate Site Circle plus separate Vitals State Program remains only a compatibility fallback and historical reference.

The automated mainnet entrypoints live in `deploy/mainnet/` and `.github/workflows/mainnet-deploy.yml`. The detailed CI/CD runbook is `docs/mainnet-deployment.md`.

Recommended sequence for the first public/mainnet release:

1. Freeze the devnet-tested source tree and run `npm run native:verify`.
2. Run `DEPLOY_GATEWAY_URL=https://octra.live npm run release:plan` and inspect `build/mainnet-release-plan.json`. The planner queries live mainnet first, stamps the candidate release with the live Circle/program identifiers, compares candidate assets and producer-audit hashes, and blocks dirty or target-mismatched candidates.
3. Run the production-sized programmed-Circle release gate with the real 48-row window and realistic latest payload/evidence/source-ref sizes. The programmed-Circle AML compile must be `safe`, verified, zero-error, zero-warning, and native readiness must later report a non-null matching Circle code hash.
4. Provision the host with one dedicated low-balance mainnet wallet for v0 deployer/operator duties; keep it idle outside the deploy/update path.
5. Push the release with `deploy/mainnet/push-release.sh` or the `push_release` workflow action.
6. Deploy or update the programmed Site Circle and call `initialize_v0` exactly once.
7. Run `deploy/mainnet/configure-programmed-circle.sh` with the mainnet env/report.
8. Run `deploy/mainnet/publish-programmed-site-assets.sh` so app assets and Vitals AML state share one Circle id.
9. Submit one snapshot into the programmed Site Circle and verify Circle-native readback. The manual `submit-one-snapshot.sh` is intentionally root-started so `updater.env` can remain root-only; it drops to the operator user after sourcing env.
10. Submit a second snapshot before expecting visible trend movement; submit at least 49 snapshots on devnet/stage when validating history-window rollover and trend honesty.
11. Start the gateway with `VITALS_STATE_SOURCE_MODE=program_required` and `VITALS_STATIC_ASSET_SOURCE=circle_required`.
12. Confirm `/api/latest`, `/api/history`, `/api/native-readiness`, and `/api/site-integrity` all report canonical programmed-Circle state.
13. Enable the updater timer only after the manual write path is stable and no other host is using the same operator wallet.
14. Keep the devnet dogfood deployment available as a separate environment; do not backfill devnet history into the public Circle program.

The `full_cutover` workflow action performs the host push, programmed-Circle deployment, initialization, asset publish, and verification steps, then stops. It intentionally leaves the updater timer disabled; use the separate `enable_timers` action only after the manual write path has been observed.

Learnings from the stage rehearsal:

- Preserve `/etc/octra-vitals/*.env` during bootstrap; never recreate empty env files over live config.
- Root-owned release directories are good for immutability, but host scripts must use `*:dist` commands or direct `node dist/...` entrypoints.
- Write deploy reports and runtime evidence to `/var/lib/octra-vitals`, not into the root-owned release tree.
- Stamp `vitals.manifest.json` at release/deploy time from env so direct Circle-browser mode, gateway mode, and asset hashes agree.
- In programmed-Circle mode, do not require legacy standalone state-program compile artifacts for site-release metadata.
- Verify the latest summary row against the latest payload in the gateway before serving.
- Publish app assets into the same programmed Circle and then require Circle assets at the gateway.
- Exe preview expects the app on exposed port `8000`; port `4173` is fine for local/dev but not sufficient for browser preview on Exe.
- Keep stage timers disabled when stage shares the dogfood wallet; nonce contention is more dangerous than missing an automated sample.
- Expect occasional RPC aborts; retry read-only RPC calls with bounded backoff, allow one canonical program RPC when that is all mainnet exposes, compare all configured program RPCs for programmed-Circle state reads and submit preflight/readback, and keep signed writes explicitly verified/fail-closed.
- For patch releases, plan from live mainnet first. Host code, Circle assets, producer audit metadata, and one-shot snapshot writes are separate objects; the deployment plan should classify which of those actually need to move before making any change.
- `producer.audit.json` is part of the public Circle asset set. A producer, gateway, deploy-script, or audited-doc change can require Circle asset publication even when the visible app UI is unchanged.
- Keep the updater timer paused across host release, Circle asset publication, and any manual snapshot submit that share the operator wallet. Restore it only after `/api/latest`, `/api/site-integrity`, and `/api/native-readiness` are green.
- The gateway and operator share local evidence/cache paths. Snapshot artifact writes must be atomic and group-writable so a manual operator run cannot make the gateway fail closed while refreshing its local verified cache.

Fallback if the production-sized programmed-Circle release gate exposes a hard protocol limit: deploy the already-tested split architecture with a separate verified Vitals State Program, but keep that as an explicit exception rather than the default mainnet shape.

Mainnet should start clean. Devnet observations can inform labels, thresholds, and runbooks, but the public state program should only contain snapshots written by its own operator against its own configured sources.

## Environment

Gateway env:

```bash
VITALS_STATE_PROGRAM_ADDRESS=oct...
VITALS_STATE_TARGET_MODE=state_program
VITALS_PROGRAMMED_CIRCLE_ID=pending
VITALS_SITE_CIRCLE_ID=oct...
VITALS_GATEWAY_ROLE=production
VITALS_STATE_SOURCE_MODE=program_required
VITALS_STATIC_ASSET_SOURCE=circle_required
VITALS_EXPOSE_PROGRAM_ARTIFACTS=0
VITALS_EXPOSE_ERRORS=0
VITALS_CORS_ALLOW_ORIGIN=*
VITALS_OCTRA_SCAN_ADDRESS_URL=https://octrascan.io/address.html?addr=
VITALS_OCTRA_SCAN_TX_URL=https://octrascan.io/tx.html?hash=
OCTRA_OBSERVATION_RPC_URL=https://octra.network/rpc
OCTRA_PROGRAM_RPC_URL=<mainnet-program-rpc>
# Optional hardening later: list independent program RPCs and set the minimum above 1.
OCTRA_PROGRAM_RPC_URLS=<mainnet-program-rpc>
VITALS_MIN_PROGRAM_RPC_URLS=1
VITALS_REQUIRE_MULTI_RPC_FOR_SUBMIT=0
RELAYER_URL=https://relayer-002838819188.octra.network
ETH_RPC_URL=https://ethereum-rpc.publicnode.com
```

For devnet dogfooding of the Vitals State Program, set `OCTRA_PROGRAM_RPC_URL=https://devnet.octrascan.io/rpc`. That does not change the observation RPC; snapshots should still record source refs from `https://octra.network/rpc` unless you are deliberately testing against a different observation network.

If `OCTRA_PROGRAM_RPC_URLS` is set, `/api/latest` and `/api/history` read the primary URL first and then require every additional program RPC to return the same latest snapshot and summary window. Snapshot writes also compare `get_snapshot_count` across the configured program RPCs before the wallet is loaded. A mismatch fails closed instead of serving or writing against a self-consistent but provider-specific view. This is still RPC comparison, not a consensus light client.

Observation collection should use provider pools, not single endpoints:

```bash
OCTRA_OBSERVATION_RPC_URLS=https://octra.network/rpc
RELAYER_URLS=https://relayer-002838819188.octra.network
ETH_RPC_URLS=https://ethereum-rpc.publicnode.com,<second-eth-rpc>,<third-eth-rpc>
VITALS_FETCH_TIMEOUT_MS=15000
VITALS_SOURCE_FETCH_ATTEMPTS=2
VITALS_COLLECT_ATTEMPTS=2
VITALS_COLLECT_RETRY_DELAY_MS=15000
OCTRA_RPC_TIMEOUT_MS=15000
OCTRA_RPC_ATTEMPTS=3
OCTRA_RPC_RETRY_DELAY_MS=1500
VITALS_PAYLOAD_SCHEMA_VERSION=octra-vitals-snapshot-v0
VITALS_EVIDENCE_SCHEMA_VERSION=octra-vitals-evidence-v0
VITALS_ENVELOPE_SCHEMA_VERSION=octra-vitals-envelope-v0
VITALS_SNAPSHOT_HASH_DOMAIN=octra-vitals:snapshot:v0
VITALS_EVIDENCE_HASH_DOMAIN=octra-vitals:evidence:v0
VITALS_SOURCE_REFS_HASH_DOMAIN=octra-vitals:source-refs:v0
```

The snapshot collector first retries each source URL, then falls through to the next provider. Ethereum block discovery and `wOCT.totalSupply()` are read from the same provider at the same pinned block number. Octra program reads also use bounded retry/backoff before failing the run; mutating submit calls are not retried by the generic RPC helper. If the entire collection or write-prep path still fails, the updater writes a failed run report with `collect_attempts`; the watchdog treats a failed latest run as a recovery trigger instead of waiting for the receipt to age out.

For an existing AML program, keep these schema and hash-domain env values aligned with the deployed program. Mainnet and current devnet should use the clean public v0 defaults unless the deployed AML explicitly gates a different string or domain.

Updater env:

```bash
VITALS_STATE_PROGRAM_ADDRESS=oct...
VITALS_STATE_TARGET_MODE=state_program
VITALS_PROGRAMMED_CIRCLE_ID=pending
VITALS_OPERATOR_ADDRESS=oct...
VITALS_OPERATOR_PRIVATE_KEY_B64=...
VITALS_SUBMIT=0
VITALS_CALL_OU=1000
VITALS_UPDATE_LOCK_STALE_MS=600000
```

Keep deployer/operator private keys out of the public gateway env. The public gateway should only read verified program state and pinned Circle assets.

## Write Gates

All writes are fail-closed by default:

```bash
VITALS_DEPLOY_STATE_PROGRAM=1 npm run program:deploy
VITALS_SUBMIT=1 npm run program:update
VITALS_DEPLOY_SITE_CIRCLE=1 npm run circle:deploy
```

The first signed snapshot write against a newly initialized public v0 program is a cutover gate. It proves AML hash framing, fixed-width summary-row encoding, source-ref hashes, and the rolling window agree with the TypeScript updater. If it reverts or readback fails, inspect the run directory named in `latest_snapshot_update_report.json` and the AML receipt before updating the Site Circle or gateway.

For programmed Site Circle deployments, `program_update` must be followed by an explicit initializer before any snapshot write. Constructor defaults are not sufficient after attaching code to an existing Circle.

For mainnet program deploys, use a dedicated deployer wallet and keep it idle between the dry run and the real deploy. The predicted program address is nonce-derived; any intervening transaction from that wallet invalidates the dry-run address. Before setting `VITALS_DEPLOY_STATE_PROGRAM=1`, confirm the live `octra_recommendedFee("deploy")` response or explicitly set `VITALS_DEPLOY_OU`, and fund the deployer for that fee.

## Octra-Native Runtime Gates

Keep these enabled for stage and mainnet:

```bash
VITALS_REQUIRE_CONTRACT_RECEIPT=1
VITALS_ENRICH_NATIVE_RECEIPT=1
VITALS_NATIVE_RECEIPT_CACHE_MS=300000
VITALS_CIRCLE_PROGRAM_VERIFICATION_CACHE_MS=300000
```

Snapshot writes are receipt-gated by default. After `octra_submit` confirms, the updater calls `contract_receipt(tx_hash)` and verifies the native `SnapshotRecorded` event against the submitted snapshot id, index, payload hash, evidence hash, source-ref hash, and summary hash. `/api/latest` also enriches the latest submit receipt with a fresh `contract_receipt` proof when the tx hash is available.

Programmed-Circle readiness is live, not manifest-only. `/api/native-readiness` calls `octra_circleProgramInfo`, `circle_info`, and Circle program views to confirm the active runtime, non-null matching code hash, required methods, initialized state, browser/resource modes, RPC agreement, and canonical AML history readability.

Deploy and submit reports include native fee/staging telemetry from `octra_recommendedFee`, `staging_stats`, and `staging_estimateOu`. Treat this as operator telemetry; it does not replace explicit write confirmation and receipt verification.

Asset publishing is changed-only by default. The publisher reads live Circle asset bytes, compares them with the candidate release manifest, and signs transactions only for changed, missing, forced, or mismatched assets. Set `VITALS_SITE_ASSET_UPLOAD_MODE=all` for an intentional full republish, or `VITALS_SITE_ASSET_FORCE_PATHS=/app.js,/style.css` to republish specific files.

Asset publishing remains single-transaction by default for easiest troubleshooting. Set `VITALS_SITE_ASSET_SUBMIT_BATCH=1` only after the target RPC has been probed for `octra_submitBatch` support in that environment. Batch mode reduces RPC submit round trips, but it still produces one signed asset transaction, nonce, transaction hash, confirmation, and `circle_asset` readback per selected file. Treat any rejected batch item, missing transaction confirmation, or `/api/site-integrity` mismatch as a failed asset publish.

## Systemd

Generic templates live in `deploy/systemd/`:

```bash
sudo cp deploy/systemd/octra-vitals-gateway.service /etc/systemd/system/
sudo cp deploy/systemd/octra-vitals-updater.service /etc/systemd/system/
sudo cp deploy/systemd/octra-vitals-updater.timer /etc/systemd/system/
sudo cp deploy/systemd/octra-vitals-watchdog.service /etc/systemd/system/
sudo cp deploy/systemd/octra-vitals-watchdog.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now octra-vitals-gateway.service
sudo systemctl enable --now octra-vitals-updater.timer
sudo systemctl enable --now octra-vitals-watchdog.timer
```

The updater records one logical snapshot with one `record_snapshot_v0` AML call and rolls the bounded summary window in the same transition. Runtime artifacts live in `VITALS_DATA_DIR/runs/<run_id>/`; the latest successful AML receipt is promoted atomically to `VITALS_DATA_DIR/latest_submit_receipt.json`.

Manual runs, timer runs, and watchdog-triggered runs share `VITALS_DATA_DIR/snapshot-updater.lock`. A stale lock may be removed after `VITALS_UPDATE_LOCK_STALE_MS`.

The updater prunes local artifacts after each run. By default it keeps up to 672 run directories, prunes run directories older than 7 days, and prunes evidence/raw-evidence files older than 365 days:

```bash
VITALS_UPDATE_RETENTION_MAX_RUNS=672
VITALS_UPDATE_RETENTION_MAX_AGE_MS=604800000
VITALS_UPDATE_EVIDENCE_RETENTION_MAX_AGE_MS=31536000000
VITALS_UPDATE_RETENTION_DISABLED=0
```

Raw evidence files live in `VITALS_DATA_DIR/evidence/raw/<response_hash>.json`. They include the exact response body and, where available, the exact request payload that produced the response. These files are intentionally local debugging/audit artifacts; they are content-hash linked from source refs but are not AML state.

This does not prune AML state. The canonical latest payload/evidence/source refs and bounded summary window remain in the programmed Circle; local retention only caps host debugging artifacts.

## Readiness Checks

```bash
curl https://<gateway-origin>/health
curl https://<gateway-origin>/api/latest
curl https://<gateway-origin>/api/history
curl https://<gateway-origin>/api/native-readiness
curl https://<gateway-origin>/api/site-integrity
```

Before calling a deployment native-ready:

- `/api/latest` reports `source: "program"` and `fresh: true`.
- `/api/history` reports `history_discovery: "aml_summary_window"`.
- `/api/native-readiness` reports `native_ready`.
- `/api/site-integrity` shows local and Circle asset hashes matching `build/site-circle-release.json`.
- The deployed Vitals State Program source, bytecode hash, verification hash, and certificate match `app/vitals.manifest.json`.
