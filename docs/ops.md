# Operations

This runbook is environment-neutral. Hostnames, wallets, Circle ids, and private env files belong on the target host or in protected deployment environments, not in git.

## Host Layout

```text
/opt/octra-vitals/current        release checkout or symlink
/var/lib/octra-vitals            producer-owned, gateway-read-only canonical artifacts
/var/lib/octra-vitals-gateway    gateway-owned traffic aggregates only
/var/lib/octra-vitals-operator   hot-operator run state and reports
/var/lib/octra-vitals-owner      cold-owner deployment reports
/var/lib/octra-vitals-notify     notifier state
/var/lib/octra-vitals-watchdog   watchdog state
/etc/octra-vitals/gateway.env    non-secret gateway config
/etc/octra-vitals/updater.env    hot operator signer config, root-only
/etc/octra-vitals/owner.env      cold Circle owner signer config, root-only
/etc/octra-vitals/notify.env     optional Telegram notification config
```

Use `deploy/mainnet/bootstrap-host.sh` to create the gateway, hot operator, cold owner, notifier, and watchdog users and their separate writable directories. Owner actions run only as the service-free `octra-vitals-owner` identity; the always-on updater cannot inspect the owner process or rewrite its reports. The gateway cannot write canonical snapshot/evidence files, and notifier/watchdog credentials are not readable by the public gateway process.

The watchdog unit is intentionally unprivileged and ships with recovery disabled. Any future restart capability must be a separate narrowly authorized helper, not a root watchdog process.

At minimum, the secret files are root-owned:

```bash
sudo install -d -m 755 -o root -g root /etc/octra-vitals
sudo install -m 640 -o root -g octra-vitals /dev/null /etc/octra-vitals/gateway.env
sudo install -m 600 -o root -g root /dev/null /etc/octra-vitals/updater.env
sudo install -m 600 -o root -g root /dev/null /etc/octra-vitals/owner.env
```

## Local Gate

Run before pushing or deploying:

```bash
npm install
npm run native:verify
```

This runs TypeScript tests, canonical JSON checks, AML compile/verification, producer-audit packaging, release packaging, and Circle deploy dry-run checks.

## Runtime Modes

Production-like environments should use:

```text
VITALS_PROGRAMMED_CIRCLE_PROGRAM=fact-ledger
VITALS_PROGRAMMED_CIRCLE_ARTIFACT_DIR=program-fact-ledger
VITALS_STATE_TARGET_MODE=circle_program
VITALS_STATE_SOURCE_MODE=program_required
VITALS_STATIC_ASSET_SOURCE=circle_required
```

The configured record-snapshot version must match the deployed AML. Keep it in env because it is a program/API compatibility gate, not a documentation version.

## Devnet First

Devnet is the proving lane. It should mirror mainnet architecture with environment-only differences:

- host/domain;
- Circle id;
- wallet;
- public origin;
- RPC/network target;
- expected source/code hashes.

Before any mainnet write, deploy the same git SHA to devnet or stage and capture proof:

```bash
DEPLOY_DEVNET_REHEARSAL_GATEWAY_URL=https://devnet.octra.live \
bash deploy/mainnet/capture-devnet-rehearsal-report.sh
```

Mainnet should not be updated from memory. Compare `/api/version.release_git_commit`, run `release:plan`, and deploy only the missing layer.

## Deployment Objects

Classify every change before deploying:

| Layer | Examples | Normal action |
| --- | --- | --- |
| Browser app | `app/index.html`, `app/app.js`, styles, icons | Host release plus Circle asset publish |
| Gateway | `src/gateway/**`, headers, API behavior | Host release and gateway restart |
| Producer/updater | collection, evidence, snapshot call, readback | Host release and updater/watchdog check |
| AML | `program-fact-ledger/**` | Compatible in-place code update or new era rehearsal |
| Runtime config | env, RPC URLs, timers, Circle ids | Host env update |
| Docs/tests | README, docs, test-only files | GitHub only unless included in producer audit assets |

Asset publishing is changed-only by default. Full republish is a recovery/drill action, not the normal path.

For AML changes, first decide compatibility:

- compatible layout/getter/row/authorization changes use `npm run circle:programmed:update-code` against the existing programmed Circle;
- incompatible storage, row, cardinality, or authorization changes require a fresh era and predecessor-anchor rehearsal.

For an in-place update, pause the updater timer and call the ledger owner's `set_paused(true)` first. Keep confirmation waiting enabled, leave the ledger paused through post-update invariant verification, and unpause it only after the candidate code hash and preserved state are confirmed.

Use `sudo bash deploy/mainnet/update-programmed-circle-code.sh` for the host-side dry run or update. The wrapper reads root-only signer files, passes only the owner operation's allowlisted variables over stdin, runs as `octra-vitals-owner`, and writes the report under `/var/lib/octra-vitals-owner`.

## Health Checks

On the host:

```bash
systemctl status octra-vitals-gateway.service
systemctl status octra-vitals-updater.timer
systemctl status octra-vitals-watchdog.timer
journalctl -u octra-vitals-updater.service --since "24 hours ago"
```

Through the gateway:

```bash
curl https://<gateway-origin>/health
curl https://<gateway-origin>/api/version
curl https://<gateway-origin>/api/latest
curl https://<gateway-origin>/api/history
curl https://<gateway-origin>/api/native-readiness
curl https://<gateway-origin>/api/site-integrity
```

Native-ready means:

- latest is program-backed and fresh;
- history is proof-bearing and explicitly labels whether rows were served from AML or the SQLite mirror;
- site assets match the pinned Circle release;
- programmed-Circle code/methods/source/formal artifacts verify;
- the gateway is in fail-closed production mode.

## Snapshot Operations

Manual one-shot write:

```bash
sudo bash /opt/octra-vitals/current/deploy/mainnet/submit-one-snapshot.sh
```

Enable timers only after manual write/readback is stable:

```bash
sudo systemctl enable --now octra-vitals-gateway.service
sudo systemctl enable --now octra-vitals-updater.timer
sudo systemctl enable --now octra-vitals-watchdog.timer
```

Keep the updater paused across host release, Circle asset publication, and manual snapshot submits that share the operator wallet. Restore it only after `/api/latest`, `/api/history`, `/api/site-integrity`, and `/api/native-readiness` are green.

## Evidence Retention

Runtime artifacts live under `VITALS_DATA_DIR`, usually `/var/lib/octra-vitals`.

Default retention posture:

```text
runs/                 short operational retention
evidence/             longer forensic retention
evidence/raw/         content-hash raw RPC/request wrappers
```

Raw evidence is intentionally public when linked from the app or API. Source URLs must be public-safe: no credentials, query tokens, fragments, private hosts, or non-HTTPS sources. The producer and gateway enforce public-host and byte-size guardrails.

Gateway API JSON is pretty-printed by default. Use:

```text
/api/evidence/raw/<response_hash>          parsed evidence view
/api/evidence/raw/<response_hash>?raw=1    raw wrapper as formatted JSON
?exact=1                                   stored file bytes without reformatting
```

Local retention does not prune AML state. AML stores compact historical facts and latest provenance; host retention only controls local debugging and raw evidence archives.

## Traffic And Snapshot Diagnostics

Optional traffic aggregation stores hourly route/status/latency counters plus daily-rotating client hashes. The gateway sets a signed, first-party metrics cookie so browser traffic can be distinguished even when the hosting edge collapses source IPs; the aggregate files store only salted daily hashes, not raw IPs, user agents, cookie values, query strings, headers, or request bodies.

```bash
npm run traffic:summary:dist -- --csv
npm run traffic:summary:dist -- --diagnostic-paths --csv
npm run snapshot-runs:summary:dist -- --csv --limit 96
```

Snapshot run summaries read `runs/*/snapshot_update_report.json` and report status, snapshot id/index, transaction hash, timings, retries, and readback status.

## History Lab

The optional history lab mirrors verified AML history into an `octra-sqlite` Circle database for query experiments. It is non-canonical: AML remains the ledger of record.

Enable on devnet/stage gateway hosts with a devnet database URI:

```text
VITALS_LAB_HISTORY_ENABLED=1
VITALS_LAB_HISTORY_NETWORK=devnet
VITALS_LAB_HISTORY_ALLOW_MAINNET=0
VITALS_LAB_HISTORY_DATABASE=vitals_history_lab
VITALS_LAB_HISTORY_DATABASE_URI=oct://devnet/octBa1SdBvjQ38dJWBwiLByPSQrGTdja2HG15dZCkGJFeJP
VITALS_LAB_SITE_CIRCLE_ID=octD4K6tHUsUsCb37fjd1Fa6Rv5WzeXhWfKfvzcXJb5tVZK
VITALS_LAB_HISTORY_OCTRA_SQLITE_BIN=/opt/octra-sqlite/bin/octra-sqlite
VITALS_LAB_HISTORY_WRITE_TOKEN=<host-local secret>
VITALS_LAB_HISTORY_SYNC_SQL_MAX_BYTES=6000
VITALS_LAB_HISTORY_SYNC_MAX_ROWS=8
VITALS_LAB_HISTORY_SYNC_TAIL_ROWS=0
VITALS_LAB_HISTORY_REPORT_PATH=/var/lib/octra-vitals/latest_lab_history_mirror_report.json
OCTRA_SQLITE_CONFIG=/etc/octra-vitals/octra-sqlite/config.json
```

Install or refresh the upstream dependency and database with:

```bash
sudo VITALS_REPO_DIR=/opt/octra-vitals/current \
  bash /opt/octra-vitals/current/deploy/devnet/setup-lab-history-db.sh
```

See `docs/lab-history-mirror.md`.

The Lab mirror is intentionally outside the core snapshot updater. After a confirmed AML write, the updater writes a local trigger marker and `octra-vitals-lab-history-trigger.path` wakes the separate mirror worker. The mirror reads verified AML history, writes bounded missing chunks into the SQLite Circle, and records its own report at `latest_lab_history_mirror_report.json`. A mirror failure or lag does not invalidate the canonical AML snapshot and should not page as a core Vitals failure.

The mirror worker and sync endpoint are chunked and completion-last. Repeated runs backfill missing rows; complete no-op runs exit before any Circle write, and a partial write does not advance the mirror watermark to complete. The mirror service does not auto-restart on failure, so a slow Circle readback cannot become a transaction loop. The lab web assets are published as a separate Lab release to a public Lab Web Circle, not bundled into the canonical Vitals Circle and not hosted by the sealed Lab SQLite Circle.
The lab query endpoint is read-only and does not require the token, but gateway concurrency/rate guards protect the shared gateway process. `VITALS_LAB_HISTORY_WRITE_TOKEN` is only for admin mirror repair/backfill. The lab page exposes canned `History`, `Tables`, and `Schema` queries, each editable before execution.

Publish or refresh Lab assets with:

```bash
sudo bash /opt/octra-vitals/current/deploy/mainnet/publish-lab-assets.sh
```

The script requires `VITALS_LAB_SITE_CIRCLE_ID`, uploads only changed Lab assets, and verifies the gateway serves them from that public Lab Web Circle. Create the Lab Web Circle once with `VITALS_LAB_SITE_CIRCLE_CREATE=1`; the sealed SQLite history stays in the Lab DB Circle and only the web assets live in the public Lab Web Circle. After publishing, run:

```bash
bash /opt/octra-vitals/current/deploy/mainnet/verify-lab-runtime.sh
```

Runtime verification is intentionally read-only and does not require `sudo`.
Set `VITALS_RUNTIME_BASE_URL=https://<host>` to run the same check from outside
the VM.

Production Lab exposure must be explicit. For mainnet, use an `oct://mainnet/<circle>` database URI, set `VITALS_LAB_HISTORY_NETWORK=mainnet`, and set `VITALS_LAB_HISTORY_ALLOW_MAINNET=1` only after a stage rehearsal passes.

Useful Lab mirror commands:

```bash
sudo systemctl enable --now octra-vitals-lab-history-trigger.path
sudo systemctl disable --now octra-vitals-lab-history-mirror.timer
sudo systemctl start octra-vitals-lab-history-mirror.service
sudo cat /var/lib/octra-vitals/latest_lab_history_mirror_report.json
```

## Telegram Notifications

Telegram notifications are host-local and optional. Configure on the host so bot tokens never pass through chat or git:

```bash
sudo bash /opt/octra-vitals/current/deploy/mainnet/configure-telegram-notify.sh
```

Alerts run every five minutes and de-duplicate repeated failures. Digests run hourly and report the last completed UTC hour plus a 24-hour topline.

## Security Notes

- Keep signer material only in root-owned env files or protected deployment secrets.
- Keep gateway env public/non-secret.
- Use distinct production owner and hot-operator wallets; role collapse requires the exact break-glass acknowledgement.
- Treat `program_update` and Circle asset publication as cold-owner actions, and manual snapshot writes as explicit hot-operator actions.
- Do not enable fallback/sample rendering in production.
