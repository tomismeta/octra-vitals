# Devnet History Lab Mirror

The history lab is an optional devnet proving surface for querying Vitals history through `octra-sqlite`.

It is not canonical state. The canonical ledger remains the Vitals AML fact ledger in the programmed Circle. The lab database is a derived readback cache populated only after the updater has successfully persisted a snapshot to AML and verified the AML readback.

## Dependency

The lab uses `tomismeta/octra-sqlite` as an external dependency, unchanged.

Pinned build:

```text
repo: https://github.com/tomismeta/octra-sqlite
commit: 73472497b35f7dfe79506e8b8a13a7f73bd3f917
binary: /opt/octra-sqlite/bin/octra-sqlite
```

Install or refresh it on devnet with:

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

Enable only on devnet:

```text
VITALS_LAB_HISTORY_ENABLED=1
VITALS_LAB_HISTORY_NETWORK=devnet
VITALS_LAB_HISTORY_DATABASE=vitals_history_lab
VITALS_LAB_HISTORY_DATABASE_URI=oct://devnet/octBa1SdBvjQ38dJWBwiLByPSQrGTdja2HG15dZCkGJFeJP
VITALS_LAB_HISTORY_OCTRA_SQLITE_BIN=/opt/octra-sqlite/bin/octra-sqlite
VITALS_LAB_HISTORY_WRITE_TOKEN=<host-local secret>
VITALS_INCLUDE_LAB_HISTORY_ASSETS=1
VITALS_LAB_HISTORY_SYNC_SQL_MAX_BYTES=6000
VITALS_LAB_HISTORY_SYNC_MAX_ROWS=8
VITALS_LAB_HISTORY_SYNC_TAIL_ROWS=0
OCTRA_SQLITE_CONFIG=/etc/octra-vitals/octra-sqlite/config.json
```

The gateway refuses lab page, asset, query, and sync calls unless the lab feature is enabled and the configured database network is `devnet`. Disabled lab routes return `404`, including `/api/lab/status`.

Fresh snapshot rows are dual-written automatically after AML success: AML write first, verified AML readback second, SQLite Circle mirror third. If the mirror write fails, the canonical AML snapshot remains valid and the updater records the lab mirror failure for repair.

Manual mirror sync is intentionally incremental and exists for repair/backfill. Each sync reads verified AML history, skips snapshots already present as complete rows in the lab database, writes a bounded newest-missing chunk, and writes the completion watermark last. This avoids giant Circle writes and prevents a failed partial sync from being reported as complete. Newest-first syncs may show a recent `mirror_runs.mirrored_through_index` while `mirror_watermarks.last_complete_snapshot_index` remains empty until the contiguous prefix has been mirrored. `VITALS_LAB_HISTORY_SYNC_TAIL_ROWS` can limit the mirrored range to a recent tail; `0` means the available verified AML history range.

Lab reads do not require a token. The query endpoint accepts bounded read-only `select` / `with` SQL so reviewers can inspect the derived mirror without wallet or operator access. Each query response includes a proof envelope with the database Circle, RPC URL, JSON-RPC method, Circle method, normalized SQL, limit, and normalized SQL hash. Vitals does not expose raw JSON-RPC request/response traces from lab queries. Admin mirror repair/backfill is the only token-gated path: `VITALS_LAB_HISTORY_WRITE_TOKEN` protects `/api/lab/mirror/sync`. Keep this host-local and out of git/chat; it is an operator secret, not a wallet key or OCT token.

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

`/api/lab/mirror/sync` reads canonical AML history through the same verified path as `/api/history`, then writes derived rows into the lab database. This endpoint is an operator repair/backfill tool; normal fresh rows are mirrored directly by the snapshot updater after successful AML readback. The response includes `row_count`, `pending_row_count`, and `complete` so operators can tell whether more sync passes are needed.

## Page

The hidden lab page is:

```text
/lab/history
```

It is intentionally not linked from the primary product navigation. The page is a canned-query explorer, not a general admin console. The visible canned queries are:

- `History`: recent mirrored snapshot accounting rows. The page exposes hour/day controls that regenerate the SQL window.
- `Tables`: a read-only list of mirror tables and indexes.
- `Schema`: a read-only view of mirror table and index definitions.

The SQL remains editable for review, but every browser query still goes through the gateway read-only guard. Fresh successful AML writes are mirrored automatically when lab mirroring is enabled; sync remains a separate operator repair/backfill action.

## Devnet Review Checklist

1. Set `VITALS_LAB_HISTORY_ENABLED=1`, `VITALS_LAB_HISTORY_DATABASE_URI=oct://devnet/<circle>`, and `VITALS_LAB_HISTORY_WRITE_TOKEN=<host-local secret>` on the devnet gateway.
2. Build/publish the devnet site with `VITALS_LAB_HISTORY_ENABLED=1` or `VITALS_INCLUDE_LAB_HISTORY_ASSETS=1` so the three lab assets are included in the Circle release.
3. Restart the gateway and verify `GET /api/lab/status` reports `enabled` with `lab_read_token_required: false` and `lab_admin_sync_token_configured: true`.
4. Make sure the updater service has the same lab database environment so fresh successful AML writes are mirrored automatically.
5. If needed, run `POST /api/lab/mirror/sync` with `X-Octra-Lab-Token` until any older desired range is backfilled.
6. Open `/lab/history` and verify the devnet banner, default `1d` result, tables/schema buttons, public read-only query, DB Circle link, and relationship join-key highlighting.
7. Confirm disabled/mainnet gateways return `404` for `/lab/history`, `/lab-history.js`, and `/api/lab/status`.
