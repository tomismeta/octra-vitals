# Mainnet Deployment Automation

Mainnet deployment is automated, but not automatic. Every host or chain write requires an explicit protected action and a recent devnet/stage rehearsal for the same commit.

Operational checks and wallet hygiene live in [Operations](ops.md). Release promotion policy lives in [Release Management](release-management.md).

## Target Shape

Mainnet uses one programmed Site Circle:

- public app assets live in the Circle;
- Vitals AML fact ledger lives in the same Circle program;
- the gateway is a thin HTTPS adapter;
- the snapshot producer runs off-chain because it reads external RPC sources;
- recurring timers start only after manual write/readback succeeds.

## Protected Inputs

Create separate protected deployment environments for stage and mainnet. Use the same secret names in each environment so the workflow can rehearse without touching mainnet secrets:

```text
DEPLOY_SSH_PRIVATE_KEY
DEPLOY_SSH_USER
DEPLOY_UPDATER_ENV_B64
```

Prefer installing `/etc/octra-vitals/updater.env` out of band as `0600 root:root`. The base64 secret path is useful for stage and break-glass automation, but mainnet signer env should stay on the host unless explicitly accepted.

The updater env must include:

- gateway/data dir/public origin;
- observation/program RPC URLs;
- relayer and Ethereum RPC URLs;
- source fetch retry limits;
- payload/evidence/source-ref hash-domain strings;
- deployer/operator public addresses and private key material;
- programmed-Circle and fact-ledger deployment settings;
- `VITALS_SUBMIT=1` only for write-capable contexts.

## Workflow

The main entrypoint is `.github/workflows/mainnet-deploy.yml`. The same dispatcher can run locally through `deploy/mainnet/run.sh`.

Use `verify_only` first. It performs CI gates and a programmed-Circle dry run without touching a host or chain.

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

Stage actions require:

```text
confirmation = DEPLOY OCTRA VITALS STAGE
```

Mainnet actions require:

```text
confirmation = DEPLOY OCTRA VITALS MAINNET
```

Timer enablement requires a separate acknowledgement.

## Devnet Gate

Before any mainnet write, capture a fresh rehearsal report:

```bash
DEPLOY_DEVNET_REHEARSAL_GATEWAY_URL=https://devnet.octra.live \
bash deploy/mainnet/capture-devnet-rehearsal-report.sh
```

The dispatcher refuses mainnet write actions unless the report:

- is recent;
- matches the current git commit;
- targets devnet or stage;
- serves program-backed latest state;
- serves AML-backed history;
- reports native readiness;
- verifies Circle assets;
- uses `circle_program` mode.

The only bypass is an explicit break-glass environment variable and should be treated as an incident-level decision.

## Release Plan

Run before any existing production update:

```bash
DEPLOY_GATEWAY_URL=https://octra.live npm run release:plan
```

The planner fetches live `/api/version`, `/api/latest`, `/api/history`, `/api/site-integrity`, `/api/native-readiness`, and `producer.audit.json`; stamps a candidate release with live Circle/program settings; compares candidate asset and producer-audit hashes; and writes `build/mainnet-release-plan.json`.

Use the plan to decide which deployment objects must move. Do not infer from local intent alone.

## Full Cutover

`full_cutover` performs:

1. local verification;
2. host release push;
3. optional private updater env install;
4. programmed Site Circle deployment/update;
5. runtime env configuration;
6. Circle asset publication;
7. one manual snapshot submit;
8. runtime verification.

It deliberately does not enable recurring timers.

For a clean first mainnet fact-ledger era, set:

```text
DEPLOY_PROGRAMMED_CIRCLE_PROGRAM=fact-ledger
DEPLOY_RECORD_SNAPSHOT_VERSION=fact-v2
DEPLOY_PROGRAMMED_CIRCLE_ARTIFACT_DIR=program-fact-ledger
DEPLOY_FACT_LEDGER_PREDECESSOR_PROGRAM=self
```

That initializes the new programmed Circle as its own genesis boundary with
predecessor index `0` and a zero predecessor root. Omit this only when the
deployment is an intentional successor migration from an older mainnet era.
The dispatcher forwards these values to the host deployment script so the
result does not depend on stale values already present in `updater.env`.

## Patch Release

Common safe patch order:

1. pause updater timer;
2. push host release;
3. publish Circle assets only if required;
4. restart gateway if host code changed;
5. submit one snapshot only if required;
6. verify runtime;
7. restore updater timer.

Asset publishing is changed-only by default. Batch submission is optional and only reduces RPC submit round trips; each selected asset still has its own signed transaction, hash, confirmation, and readback gate.

## Guardrails

- Do not deploy mainnet with uncommitted changes.
- Do not deploy a commit that has not been proven on devnet/stage.
- Do not silently fall back to local assets or sample snapshots.
- Keep signer env root-owned and out of git.
- Keep static assets in `circle_required` mode.
- Keep state reads in `program_required` mode.
- Require receipt/readback verification for writes.
- Treat producer-audit changes as public asset changes when the audit manifest includes them.
