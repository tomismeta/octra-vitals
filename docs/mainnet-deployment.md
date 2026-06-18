# Mainnet Deployment Automation

This is the mainnet run of show for Octra Vitals v0. It is intentionally automated, but not automatic: every host or chain write requires an explicit GitHub workflow input acknowledgement.

This document focuses on automation controls. Operational checks, wallet hygiene, and emergency actions live in `docs/ops.md`.

## Target Shape

Mainnet uses one programmed Site Circle:

- app assets live in the Circle;
- Vitals AML state lives in the same Circle program;
- the gateway is a thin HTTPS adapter;
- the snapshot producer runs off-chain because it must read Octra RPC, Ethereum RPC, and relayer sources;
- recurring snapshot timers are disabled until the first manual cutover write verifies cleanly.

## GitHub Secrets

Create separate GitHub environments named `stage` and `mainnet`. Put the same generic secret names in each environment so the workflow can rehearse against stage without touching mainnet secrets:

```text
DEPLOY_SSH_PRIVATE_KEY       private key for the deployment SSH user
DEPLOY_SSH_USER              optional user when target_host is only a hostname
DEPLOY_UPDATER_ENV_B64       base64 of /etc/octra-vitals/updater.env for the host
```

`DEPLOY_UPDATER_ENV_B64` should include signer material and RPC configuration. It should not be committed. Prefer installing `/etc/octra-vitals/updater.env` out-of-band as `0600 root:root`; root-started maintenance scripts source it before dropping to the operator user. The GitHub secret install path remains useful for stage, but mainnet should avoid storing signer env in GitHub unless explicitly accepted.

For `stage`, use devnet program RPC and a devnet deployer/operator wallet. For `mainnet` v0, use one dedicated low-balance production wallet as deployer, initial operator, and recurring operator. The same automation remains compatible with a later split into a cold owner plus separate hot operator via `set_operator(new_operator)`.

The 2026-06-17 devnet rehearsal proved one migration rule for mainnet: do not carry temporary schema/hash-domain strings into the public v0 deployment. The public programmed Circle gates `octra-vitals-snapshot-v0`; any replay or seed data must be produced with the same schema and hash domains.

Minimum updater env for the programmed-Circle path:

```bash
VITALS_GATEWAY_ROLE=production
VITALS_DATA_DIR=/var/lib/octra-vitals
VITALS_GATEWAY_ORIGIN=https://octra.live
VITALS_OCTRA_SCAN_ADDRESS_URL=https://octrascan.io/address.html?addr=
VITALS_OCTRA_SCAN_TX_URL=https://octrascan.io/tx.html?hash=
OCTRA_OBSERVATION_RPC_URL=https://octra.network/rpc
OCTRA_OBSERVATION_RPC_URLS=https://octra.network/rpc
OCTRA_PROGRAM_RPC_URL=https://octra.network/rpc
OCTRA_PROGRAM_RPC_URLS=https://octra.network/rpc
VITALS_MIN_PROGRAM_RPC_URLS=1
VITALS_REQUIRE_MULTI_RPC_FOR_SUBMIT=0
RELAYER_URL=https://relayer-002838819188.octra.network
RELAYER_URLS=https://relayer-002838819188.octra.network
ETH_RPC_URL=https://ethereum-rpc.publicnode.com
ETH_RPC_URLS=https://ethereum-rpc.publicnode.com,<second-eth-rpc>,<third-eth-rpc>
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
VITALS_DEPLOYER_ADDRESS=oct...                 # dedicated production wallet
VITALS_DEPLOYER_PRIVATE_KEY_B64=...            # same wallet key
VITALS_OPERATOR_ADDRESS=oct...                 # same wallet at v0 launch
VITALS_OPERATOR_PRIVATE_KEY_B64=...            # same wallet key
VITALS_INITIAL_OPERATOR_ADDRESS=oct...         # same wallet at v0 launch
VITALS_CIRCLE_OWNER_ADDRESS=oct...            # same wallet at v0 launch
VITALS_CIRCLE_OPERATOR_ADDRESS=oct...         # same wallet at v0 launch
VITALS_SUBMIT=1
VITALS_STATE_SOURCE_MODE=program_required
VITALS_STATIC_ASSET_SOURCE=circle_required
```

## Workflow

The main entrypoint is `.github/workflows/mainnet-deploy.yml`.

Use `verify_only` first. It performs local CI gates and a programmed-Circle dry run without touching the host or chain.

Choose `deployment_environment=stage` for the clean rehearsal and `deployment_environment=mainnet` only for the real cutover.

Mainnet write actions are devnet-gated. Before any mainnet host or chain write, run the same code against devnet/stage and capture a rehearsal report:

```bash
DEPLOY_DEVNET_REHEARSAL_GATEWAY_URL=https://devnet.octra.live \
bash deploy/mainnet/capture-devnet-rehearsal-report.sh

base64 < build/devnet-rehearsal-report.json | tr -d '\n'
```

Then pass the base64 report into the mainnet workflow with:

```text
devnet_rehearsal_ack = DEVNET REHEARSAL PASSED FOR OCTRA VITALS MAINNET
devnet_rehearsal_report_b64 = <base64 build/devnet-rehearsal-report.json>
```

The dispatcher refuses mainnet write actions unless the report passed, targets a devnet/stage URL, is recent, matches the current commit, shows native readiness, verifies Circle assets, serves program-backed latest/history, and uses `circle_program`. The only bypass is the explicit break-glass `DEPLOY_ALLOW_MAINNET_WITHOUT_DEVNET_REHEARSAL=1`.

The rehearsal host must be in `DEPLOY_DEVNET_REHEARSAL_ALLOWED_HOSTS`, which defaults to `devnet.octra.live,octra-stage.exe.xyz,octra-dev.exe.xyz`. The report also checks `/api/version.release_git_commit` against the local commit, rejects a dirty deployed release, and requires the 48-row bounded history window to have rolled over: row count at least 48, first index greater than 1, and latest index at least 49. Optional hard pins are available with `DEPLOY_DEVNET_REHEARSAL_EXPECTED_SITE_CIRCLE_ID` and `DEPLOY_DEVNET_REHEARSAL_EXPECTED_PROGRAMMED_CIRCLE_ID`.

Mainnet write actions also require a pinned SSH host key. Provide either `DEPLOY_SSH_KNOWN_HOSTS_B64` or `DEPLOY_SSH_HOST_KEY_LINE` in the protected environment; the dispatcher refuses first-use `ssh-keyscan` for mainnet unless the break-glass `DEPLOY_ALLOW_SSH_KEYSCAN=1` is explicitly set.

Asset publication pauses `octra-vitals-updater.timer` while it writes Circle assets, waits for any in-flight updater service to finish, and restores the timer afterward if it was active. This keeps the recurring snapshot writer and asset publisher from racing on the same operator-wallet nonce.

Protect the GitHub `mainnet` environment with required reviewers before adding production secrets. Stage and mainnet should use different SSH credentials and updater env secrets. The dispatcher also enforces environment-specific host allowlists by default; set `DEPLOY_MAINNET_ALLOWED_HOSTS` or `DEPLOY_STAGE_ALLOWED_HOSTS` only when the canonical hostnames change.

For stage host/chain actions, set:

```text
confirmation = DEPLOY OCTRA VITALS STAGE
```

For mainnet host/chain actions, set:

```text
confirmation = DEPLOY OCTRA VITALS MAINNET
```

Available actions:

```text
verify_only
plan_release
push_release
deploy_programmed_circle
configure_runtime
publish_assets
submit_snapshot
verify_runtime
enable_timers
full_cutover
```

`plan_release` is read-only against the target gateway. It fetches the live `/api/version`, `/api/latest`, `/api/history`, `/api/site-integrity`, `/api/native-readiness`, and `producer.audit.json` surfaces before recommending any deploy action. It then stamps a candidate release with the live Circle/program settings, compares candidate asset hashes and producer-audit file hashes against mainnet, and writes `build/mainnet-release-plan.json`.

Run it before any existing production update:

```bash
DEPLOY_GATEWAY_URL=https://octra.live npm run release:plan
```

The planner blocks dirty candidate releases, target mismatches, or program source changes that need the programmed-Circle update path instead of a patch release. For normal patch releases, use its `decision.recommended_actions` as the run order. The common safe patch order is:

1. pause the updater timer;
2. push the host release;
3. publish Circle assets if `circle_asset_publish_required` is true;
4. restart the gateway if the host changed but assets did not;
5. submit one snapshot if `submit_snapshot_recommended` is true;
6. verify runtime;
7. restore the updater timer.

`full_cutover` performs:

1. run local verification;
2. push a root-owned release to `/opt/octra-vitals/current`;
3. install the private updater env if the secret is configured;
4. deploy a fresh programmed Site Circle;
5. configure gateway/updater env for `circle_program`;
6. publish static app assets into the programmed Circle;
7. submit one manual snapshot;
8. verify `/api/latest`, `/api/history`, `/api/site-integrity`, and `/api/native-readiness`.

It deliberately does not enable timers.

## Timers

Enable recurring writes only after the manual write/readback path has held stable.

Run the `enable_timers` action with both acknowledgements:

```text
confirmation = DEPLOY OCTRA VITALS MAINNET
enable_timers_ack = ENABLE OCTRA VITALS MAINNET TIMERS
```

For stage, use `DEPLOY OCTRA VITALS STAGE` and `ENABLE OCTRA VITALS STAGE TIMERS`.

This starts:

```text
octra-vitals-gateway.service
octra-vitals-updater.timer
octra-vitals-watchdog.timer
```

## Local Rehearsal Without GitHub

The GitHub workflow is optional. The same dispatcher can run directly from this checkout and rsync the current working tree to a fresh host.

For a clean stage rehearsal:

```bash
DEPLOY_ENVIRONMENT=stage \
DEPLOY_ACTION=full_cutover \
DEPLOY_TARGET_HOST=octra-stage.exe.xyz \
DEPLOY_GATEWAY_PORT=8000 \
DEPLOY_CONFIRMATION="DEPLOY OCTRA VITALS STAGE" \
DEPLOY_UPDATER_ENV_B64="$(base64 < /path/to/stage-updater.env | tr -d '\n')" \
bash deploy/mainnet/run.sh
```

After the stage cutover and one fresh snapshot, capture the rehearsal proof from the public devnet/stage gateway:

```bash
DEPLOY_DEVNET_REHEARSAL_GATEWAY_URL=https://devnet.octra.live \
bash deploy/mainnet/capture-devnet-rehearsal-report.sh
```

If SSH is already configured locally for the host, no SSH key env var is needed. Otherwise add `DEPLOY_SSH_USER` and `DEPLOY_SSH_PRIVATE_KEY`.

## Guardrails

- Run `plan_release` before every production write. Do not decide from local intent alone; compare against the live mainnet gateway and Circle asset state first.
- No timers are enabled by `full_cutover`.
- Mainnet write actions require a recent passed devnet/stage rehearsal report for the same commit.
- Direct local write commands and host write wrappers are break-glass/manual-only paths. The production route is the GitHub environment-protected dispatcher after user approval.
- `VITALS_SUBMIT=1` is scoped only to the one manual snapshot script.
- Signer env is installed as `0600 root:root`; programmed-Circle deploy and one-off snapshot submit are root-started wrappers that drop to the operator process after sourcing env.
- Static assets are served with `VITALS_STATIC_ASSET_SOURCE=circle_required`.
- State reads use `VITALS_STATE_SOURCE_MODE=program_required`.
- Runtime verification must report `native_ready` with `state_target_mode=circle_program`.
- Snapshot writes require a matching native `contract_receipt` by default; leave `VITALS_REQUIRE_CONTRACT_RECEIPT=1`.
- `/api/native-readiness` verifies the live Circle program with `octra_circleProgramInfo`, `circle_info`, and Circle program views.
- Deploy reports capture `octra_recommendedFee`, `staging_stats`, and `staging_estimateOu` telemetry for the write path.
- Batch asset publishing is opt-in with `VITALS_SITE_ASSET_SUBMIT_BATCH=1`; keep single-asset submits unless the target RPC has been rehearsed. Batch publishing lowers RPC submit calls, but every file still has its own asset transaction hash, confirmation, and `circle_asset` readback gate.
- Treat `producer.audit.json` as a production asset. If producer, gateway, deploy automation, or audited docs change, Circle asset parity may be required even when app UI bytes do not change.
- If the programmed Site Circle production release gate exposes a hard protocol limit, stop and use the documented split-state fallback instead of weakening gateway trust.
