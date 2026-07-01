# History Lab Mirror

The history lab is an optional proving surface for querying Vitals history through `octra-sqlite`.

It is not canonical state. The canonical ledger remains the Vitals AML fact ledger in the programmed Circle. The lab database is a derived readback cache populated only after the updater has successfully persisted a snapshot to AML and verified the AML readback.

## Dependency

The lab uses `tomismeta/octra-sqlite` as an external dependency, unchanged.

Pinned build:

```text
repo: https://github.com/tomismeta/octra-sqlite
commit: 95105c57a2949f0ae03a71907f2da20d23f415f0
binary: /opt/octra-sqlite/bin/octra-sqlite
```

Install or refresh it on a gateway host with:

```bash
sudo VITALS_REPO_DIR=/opt/octra-vitals/current \
  bash /opt/octra-vitals/current/deploy/devnet/setup-lab-history-db.sh
```

The setup script expects the existing host wallet file at:

```text
/etc/octra-vitals/octra-sqlite/wallet.json
```

Do not commit that wallet file.

## Database

Current devnet lab database:

```text
name: vitals_history_lab
uri: oct://devnet/octBa1SdBvjQ38dJWBwiLByPSQrGTdja2HG15dZCkGJFeJP
schema: ops/octra-sqlite/history-lab-schema.sql
```

The schema is query-oriented:

- `snapshots` stores one row per mirrored AML history fact;
- `core_accounting_facts` stores the compact accounting row values;
- `derived_snapshot_metrics` stores query-friendly derived values such as public balance, bridge gap, unclassified collateral, and wOCT coverage;
- `aml_eras`, `fact_families`, and `fact_capsules` preserve proof context from the AML history readback;
- `mirror_runs` and `mirror_watermarks` record what was mirrored and when.

Raw RPC evidence bodies are not copied into the lab database.

## Gateway Config

The lab is disabled by default. Devnet and staging can enable it with an `oct://devnet/...` database URI. Mainnet additionally requires `VITALS_LAB_HISTORY_ALLOW_MAINNET=1` so production exposure is explicit.

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

The gateway refuses lab page, asset, query, and sync calls unless the lab feature is enabled and the database URI network matches the configured network. Mainnet lab databases are refused unless `VITALS_LAB_HISTORY_ALLOW_MAINNET=1`. Disabled lab routes return `404`, including `/api/lab/status`.

The production deployment boundary is three Circles:

- Vitals Circle: AML fact ledger plus core web assets.
- Lab Web Circle: public `/lab/history` web assets only.
- Lab DB Circle: sealed `octra-sqlite` database mirror.

`VITALS_LAB_SITE_CIRCLE_ID` is required for lab asset publishing unless `VITALS_LAB_SITE_CIRCLE_CREATE=1` is set for the one-time Lab Web Circle creation. It must be distinct from the Circle id in `VITALS_LAB_HISTORY_DATABASE_URI`; the SQLite database Circle stays sealed and is not used as a static asset host.

The Lab mirror is decoupled from the core snapshot updater. The core updater collects data, writes AML, verifies readback, and updates the public Vitals receipt. After a confirmed AML write, it writes a small local marker at `VITALS_LAB_HISTORY_TRIGGER_PATH`; `octra-vitals-lab-history-trigger.path` wakes the separate `octra-vitals-lab-history-mirror` worker. The worker reads verified AML history and mirrors missing rows into the SQLite Circle. If the mirror fails or lags, the canonical AML snapshot and public site remain valid.

Mirror runs are intentionally incremental and exist for post-AML-write follow-up plus repair/backfill. Each run reads verified AML history, exits before any Circle write when the mirror is already complete, writes a bounded oldest-missing chunk when rows are missing, and writes the completion watermark last. This avoids giant Circle writes, prevents a failed partial sync from being reported as complete, and prevents empty catch-up runs from spending OCT. The systemd service does not auto-restart on failure; a stale post-write readback should wait for the next confirmed AML trigger or an explicit operator repair run, not loop and spend. `VITALS_LAB_HISTORY_SYNC_TAIL_ROWS` can limit the mirrored range to a recent tail; `0` means the available verified AML history range.

Lab reads do not require a token. The query endpoint accepts bounded read-only `select` / `with` SQL so reviewers can inspect the derived mirror without wallet or operator access, and the gateway applies a small concurrency/rate guard before spawning `octra-sqlite`. Each query response includes a proof envelope with the database Circle, RPC URL, JSON-RPC method, Circle method, normalized SQL, limit, and normalized SQL hash. Vitals does not expose raw JSON-RPC request/response traces from lab queries. Admin mirror repair/backfill is the only token-gated path: `VITALS_LAB_HISTORY_WRITE_TOKEN` protects `/api/lab/mirror/sync`. Keep this host-local and out of git/chat; it is an operator secret, not a wallet key or OCT token.

## API

```text
GET  /api/lab/status
GET  /api/lab/tables
GET  /api/lab/schema
GET  /api/lab/history?window=1d
POST /api/lab/query        # read-only; no token required
POST /api/lab/mirror/sync  # X-Octra-Lab-Token required
```

`/api/lab/query` accepts bounded read-only SQL:

```json
{
  "sql": "select snapshot_index, observed_at from snapshots order by snapshot_index desc",
  "limit": 200
}
```

Only `select` / `with` statements are accepted. Mutating statements, comments, multiple statements, and PRAGMA-style access are rejected before calling `octra-sqlite`.

`/api/lab/mirror/sync` reads canonical AML history through the same verified path as `/api/history`, then writes derived rows into the lab database. This endpoint is an operator repair/backfill tool; the primary automated path is the separate Lab mirror worker. The response includes `row_count`, `pending_row_count`, and `complete` so operators can tell whether more sync passes are needed.

The preferred automated path is the post-AML-write trigger:

```bash
sudo systemctl enable --now octra-vitals-lab-history-trigger.path
sudo systemctl disable --now octra-vitals-lab-history-mirror.timer
```

The timer is only a repair/backfill lane:

```bash
sudo systemctl start octra-vitals-lab-history-mirror.service
sudo cat /var/lib/octra-vitals/latest_lab_history_mirror_report.json
```

## Page

The hidden lab page is:

```text
/lab/history
```

It is intentionally not linked from the primary product navigation. The page is a canned-query explorer, not a general admin console. The visible canned queries are:

- `History`: recent mirrored snapshot accounting rows. The page exposes hour/day controls that regenerate the SQL window.
- `Tables`: a read-only list of mirror tables and indexes.
- `Schema`: a read-only view of mirror table and index definitions.

The SQL remains editable for review, but every browser query still goes through the gateway read-only guard. Successful AML writes are mirrored by the separate Lab worker; the page can honestly show lag until the worker catches up.

## Lab Asset Release

Core Circle releases never include Lab assets. Host releases package the Lab release
manifest when `VITALS_LAB_SITE_CIRCLE_ID` is configured, so the gateway keeps a
pinned hash list for the separate Lab Web Circle after code-only deploys. Build
the Lab release directly when you want to inspect it:

```bash
npm run circle:release:lab
```

Publish Lab assets to the public Lab Web Circle:

```bash
sudo bash /opt/octra-vitals/current/deploy/mainnet/publish-lab-assets.sh
```

The script requires `VITALS_LAB_SITE_CIRCLE_ID`, uses changed-only asset uploads,
refreshes the pinned Lab release manifest, and verifies `/lab/history`,
`/lab-history.css`, and `/lab-history.js` are served from that Lab Web Circle.
To create the public Lab Web Circle, run it once with
`VITALS_LAB_SITE_CIRCLE_CREATE=1`; the script writes the created Circle id back
to `gateway.env` and `lab-history.env`. The script refuses to publish lab assets
to the sealed SQLite DB Circle.

## Review Checklist

1. Set `VITALS_LAB_HISTORY_ENABLED=1`, `VITALS_LAB_HISTORY_DATABASE_URI=oct://devnet/<circle>`, and `VITALS_LAB_HISTORY_WRITE_TOKEN=<host-local secret>` on the devnet gateway/Lab env.
2. Build/publish the core site without Lab assets, then run `publish-lab-assets.sh` so the three Lab assets are uploaded to the public Lab Web Circle.
3. Restart the gateway and verify `GET /api/lab/status` reports `enabled` with `lab_read_token_required: false` and `lab_admin_sync_token_configured: true`.
4. Make sure `octra-vitals-lab-history-mirror.service` has the Lab database environment and the core updater does not need Lab variables.
5. Run `sudo systemctl start octra-vitals-lab-history-mirror.service` repeatedly, or enable the timer, until any older desired range is backfilled.
6. Open `/lab/history` and verify the default `1d` result, tables/schema buttons, public read-only query, DB Circle link, network status, and relationship join-key highlighting.
7. Confirm disabled gateways return `404` for `/lab/history`, `/lab-history.js`, and `/api/lab/status`.
8. Before enabling on mainnet, rehearse the same commit on stage using devnet, run `verify-lab-runtime.sh`, then set `VITALS_LAB_HISTORY_NETWORK=mainnet`, `VITALS_LAB_HISTORY_DATABASE_URI=oct://mainnet/<sealed-db-circle>`, `VITALS_LAB_SITE_CIRCLE_ID=<public-lab-web-circle>`, and `VITALS_LAB_HISTORY_ALLOW_MAINNET=1` only for the production cutover.
