# Operations

This runbook is environment-neutral. Hostnames, wallets, Circle ids, and private env files belong on the target host or in protected deployment environments, not in git.

## Host Layout

```text
/opt/octra-vitals/current        release checkout or symlink
/var/lib/octra-vitals            runtime data, receipts, evidence, updater runs
/etc/octra-vitals/gateway.env    non-secret gateway config
/etc/octra-vitals/updater.env    signer/updater config, root-only
/etc/octra-vitals/notify.env     optional Telegram notification config
```

Create a dedicated runtime user:

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin octra-vitals || true
sudo install -d -m 750 -o octra-vitals -g octra-vitals /var/lib/octra-vitals
sudo install -d -m 755 -o root -g root /etc/octra-vitals
sudo install -m 640 -o root -g octra-vitals /dev/null /etc/octra-vitals/gateway.env
sudo install -m 600 -o root -g root /dev/null /etc/octra-vitals/updater.env
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
| AML | `program-fact-ledger/**` or compatibility AML | Compatible in-place code update or new era rehearsal |
| Runtime config | env, RPC URLs, timers, Circle ids | Host env update |
| Docs/tests | README, docs, test-only files | GitHub only unless included in producer audit assets |

Asset publishing is changed-only by default. Full republish is a recovery/drill action, not the normal path.

For AML changes, first decide compatibility:

- compatible layout/getter/row/authorization changes use `npm run circle:programmed:update-code` against the existing programmed Circle;
- incompatible storage, row, cardinality, or authorization changes require a fresh era and predecessor-anchor rehearsal.

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
- history is AML-backed and proof-bearing;
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

Optional traffic aggregation stores hourly route/status/latency counters plus daily-rotating client hashes. It does not store raw IPs, user agents, cookies, query strings, headers, or request bodies.

```bash
npm run traffic:summary:dist -- --csv
npm run traffic:summary:dist -- --diagnostic-paths --csv
npm run snapshot-runs:summary:dist -- --csv --limit 96
```

Snapshot run summaries read `runs/*/snapshot_update_report.json` and report status, snapshot id/index, transaction hash, timings, retries, and readback status.

## Telegram Notifications

Telegram notifications are host-local and optional. Configure on the host so bot tokens never pass through chat or git:

```bash
sudo bash /opt/octra-vitals/current/deploy/mainnet/configure-telegram-notify.sh
```

Alerts run every five minutes and de-duplicate repeated failures. Digests run hourly and report the last completed UTC hour plus a 24-hour topline.

## Security Notes

- Keep signer material only in root-owned env files or protected deployment secrets.
- Keep gateway env public/non-secret.
- Use a dedicated low-balance production wallet at launch; the architecture allows later owner/operator separation.
- Treat `program_update`, Circle asset publication, and manual snapshot writes as explicit operator actions.
- Do not enable fallback/sample rendering in production.
