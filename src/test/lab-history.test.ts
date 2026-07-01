import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { buildLabHistoryMirrorSql, mirrorLabHistory, planLabHistoryMirrorRows } from "../lib/lab-history.js";
import { normalizeReadOnlySql, octraSqliteConfig, octraSqliteQueryProof, parseOctraSqliteOutput } from "../lib/octra-sqlite-client.js";
import type { ProgramHistoryWindow, SummaryRow } from "../lib/summary-window.js";

const execFileAsync = promisify(execFile);

function sampleHistory(): ProgramHistoryWindow {
  return {
    first_index: 10,
    row_count: 2,
    row_len: 208,
    window: "",
    window_hash: "sha256:window",
    history_discovery: "aml_fact_family_core_capsules_verified",
    history_root: "a".repeat(64),
    capsules_root: "b".repeat(64),
    rows: [
      {
        row_version: "00",
        snapshot_index: 10,
        observed_at_unix: 1_798_000_000,
        octra_epoch: 123,
        external_block: 456,
        issued_raw: "623000000000000",
        burned_raw: "377000000000000",
        encrypted_raw: "12413100000000",
        total_locked_raw: "201000000000000",
        total_wrapped_raw: "190000000000000",
        total_unclaimed_raw: "10000000000000",
        route_count: 1,
        payload_hash_prefix: "0123456789abcdef01234567"
      },
      {
        row_version: "00",
        snapshot_index: 11,
        observed_at_unix: 1_798_000_900,
        octra_epoch: 124,
        external_block: 457,
        issued_raw: "623100000000000",
        burned_raw: "376900000000000",
        encrypted_raw: "12413100000000",
        total_locked_raw: "201100000000000",
        total_wrapped_raw: "190100000000000",
        total_unclaimed_raw: "10000000000000",
        route_count: 1,
        payload_hash_prefix: "89abcdef0123456701234567"
      }
    ],
    proof: {
      scope: "full_chain",
      truncated: false,
      families: [{ family_id: "0000", schema_id: "0000", family_root: "a".repeat(64) }],
      capsules: [{ family_id: "0000", capsule_id: "2026-06-28T00.0000", ordinal: 0, root_after: "a".repeat(64) }]
    },
    eras: [{
      era_id: "octDevCircle",
      era_program: "octDevCircle",
      era_network_id: "octra-devnet",
      manifest: "octra-vitals-fact-ledger.v2",
      history_model: "aml_fact_family_core_capsules_verified",
      first_index: 10,
      latest_index: 11,
      row_count: 2,
      root_hash: "a".repeat(64),
      capsules_root: "b".repeat(64),
      proof_scope: "full_chain",
      proof_truncated: false
    }]
  };
}

function sqliteResult(columns: string[], rows: unknown[][] = []) {
  return {
    columns,
    rows,
    row_count: rows.length,
    ok: true
  };
}

async function withLabReadbackRetryEnv<T>(attempts: number, delayMs: number, fn: () => Promise<T>): Promise<T> {
  const previousAttempts = process.env.VITALS_LAB_HISTORY_READBACK_RETRY_ATTEMPTS;
  const previousDelay = process.env.VITALS_LAB_HISTORY_READBACK_RETRY_DELAY_MS;
  process.env.VITALS_LAB_HISTORY_READBACK_RETRY_ATTEMPTS = String(attempts);
  process.env.VITALS_LAB_HISTORY_READBACK_RETRY_DELAY_MS = String(delayMs);
  try {
    return await fn();
  } finally {
    if (previousAttempts === undefined) delete process.env.VITALS_LAB_HISTORY_READBACK_RETRY_ATTEMPTS;
    else process.env.VITALS_LAB_HISTORY_READBACK_RETRY_ATTEMPTS = previousAttempts;
    if (previousDelay === undefined) delete process.env.VITALS_LAB_HISTORY_READBACK_RETRY_DELAY_MS;
    else process.env.VITALS_LAB_HISTORY_READBACK_RETRY_DELAY_MS = previousDelay;
  }
}

test("lab query guard wraps bounded read-only select SQL", () => {
  const normalized = normalizeReadOnlySql("select snapshot_index from snapshots order by snapshot_index desc", 25);

  assert.equal(normalized.limit, 25);
  assert.match(normalized.sql, /^select \* from \(select snapshot_index/);
  assert.match(normalized.sql, /limit 25$/);
});

test("lab query guard rejects mutating SQL", () => {
  assert.throws(() => normalizeReadOnlySql("delete from snapshots"), /only_select_queries_allowed/);
  assert.throws(() => normalizeReadOnlySql("select 1; drop table snapshots"), /only_one_read_only_statement_allowed/);
  assert.throws(() => normalizeReadOnlySql("select * from snapshots -- nope"), /sql_comments_not_allowed/);
});

test("octra-sqlite output parser accepts query and write envelopes", () => {
  const query = parseOctraSqliteOutput(JSON.stringify({
    ok: true,
    type: "query",
    columns: ["snapshot_index"],
    rows: [[465]],
    row_count: 1
  }));

  assert.deepEqual(query.columns, ["snapshot_index"]);
  assert.deepEqual(query.rows, [[465]]);
  assert.equal(query.row_count, 1);

  const write = parseOctraSqliteOutput(JSON.stringify({
    ok: true,
    type: "write",
    status: "confirmed",
    tx_hash: "abc123",
    receipt: { success: true }
  }));

  assert.deepEqual(write, { columns: [], ok: true, row_count: 0, rows: [] });

  const writeScript = parseOctraSqliteOutput(JSON.stringify({
    ok: true,
    type: "write_script",
    schema: "octra-sqlite.cli.v1",
    statements: 14,
    batches: 1,
    writes: [{ status: "confirmed" }]
  }));

  assert.deepEqual(writeScript, { columns: [], ok: true, row_count: 0, rows: [] });

  const restore = parseOctraSqliteOutput(JSON.stringify({
    ok: true,
    type: "restore",
    statements: 3279,
    batches: 200,
    writes: [{ status: "confirmed" }, { status: "confirmed" }]
  }));

  assert.deepEqual(restore, { columns: [], ok: true, row_count: 0, rows: [] });
  assert.throws(() => parseOctraSqliteOutput(JSON.stringify({ ok: false, error: "bad" })), /octra_sqlite_not_ok/);
});

test("lab query proof describes Circle read without exposing auth material", async () => {
  const normalized = normalizeReadOnlySql("select snapshot_index from snapshots", 10);
  const proof = await octraSqliteQueryProof(normalized, {
    enabled: true,
    reason: null,
    bin: "/opt/octra-sqlite/bin/octra-sqlite",
    configPath: null,
    database: "oct://devnet/octExample",
    databaseUri: "oct://devnet/octExample",
    network: "devnet"
  });

  assert.equal(proof.database_uri, "oct://devnet/octExample");
  assert.equal(proof.circle_id, "octExample");
  assert.equal(proof.rpc_url, "https://devnet.octrascan.io/rpc");
  assert.equal(proof.jsonrpc_method, "octra_circleViewAuth");
  assert.equal(proof.circle_method, "query_typed");
  assert.equal(proof.normalized_limit, 10);
  assert.match(proof.normalized_sql, /^select \* from \(select snapshot_index/);
  assert.match(proof.normalized_sql_sha256, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(proof.params_shape, [
    "circle_id",
    "query_typed",
    "[normalized_sql]",
    "caller",
    "public_key_b64",
    "view_signature",
    "false"
  ]);
});

test("lab database config requires an explicit oct URI and explicit mainnet enable", () => {
  const plain = octraSqliteConfig({
    VITALS_LAB_HISTORY_ENABLED: "1",
    VITALS_LAB_HISTORY_DATABASE: "vitals_history_lab",
    VITALS_LAB_HISTORY_NETWORK: "devnet"
  } as NodeJS.ProcessEnv);

  assert.equal(plain.enabled, false);
  assert.equal(plain.reason, "lab_history_database_uri_required");

  const mismatch = octraSqliteConfig({
    VITALS_LAB_HISTORY_ENABLED: "1",
    VITALS_LAB_HISTORY_DATABASE_URI: "oct://mainnet/octExample",
    VITALS_LAB_HISTORY_NETWORK: "devnet"
  } as NodeJS.ProcessEnv);

  assert.equal(mismatch.enabled, false);
  assert.equal(mismatch.reason, "lab_history_network_mismatch");

  const mainnetWithoutEnable = octraSqliteConfig({
    VITALS_LAB_HISTORY_ENABLED: "1",
    VITALS_LAB_HISTORY_DATABASE_URI: "oct://mainnet/octExample",
  } as NodeJS.ProcessEnv);

  assert.equal(mainnetWithoutEnable.enabled, false);
  assert.equal(mainnetWithoutEnable.reason, "lab_history_mainnet_requires_explicit_enable");

  const mainnetWithEnable = octraSqliteConfig({
    VITALS_LAB_HISTORY_ENABLED: "1",
    VITALS_LAB_HISTORY_DATABASE_URI: "oct://mainnet/octExample",
    VITALS_LAB_HISTORY_NETWORK: "mainnet",
    VITALS_LAB_HISTORY_ALLOW_MAINNET: "1"
  } as NodeJS.ProcessEnv);

  assert.equal(mainnetWithEnable.enabled, true);
  assert.equal(mainnetWithEnable.network, "mainnet");

  const unsupported = octraSqliteConfig({
    VITALS_LAB_HISTORY_ENABLED: "1",
    VITALS_LAB_HISTORY_DATABASE_URI: "oct://stage/octExample"
  } as NodeJS.ProcessEnv);

  assert.equal(unsupported.enabled, false);
  assert.equal(unsupported.reason, "lab_history_network_unsupported");

  const devnet = octraSqliteConfig({
    VITALS_LAB_HISTORY_ENABLED: "1",
    VITALS_LAB_HISTORY_DATABASE_URI: "oct://devnet/octExample",
    VITALS_LAB_HISTORY_NETWORK: "devnet"
  } as NodeJS.ProcessEnv);

  assert.equal(devnet.enabled, true);
  assert.equal(devnet.network, "devnet");
  assert.equal(devnet.database, "oct://devnet/octExample");
});

test("lab mirror SQL preserves AML authority and derived query fields", () => {
  const { sql, summary } = buildLabHistoryMirrorSql(sampleHistory(), {
    target_kind: "circle_program",
    target_id: "octDevCircle"
  }, "2026-06-28T12:00:00Z");

  assert.equal(summary.row_count, 2);
  assert.equal(summary.latest_index, 11);
  assert.equal(summary.complete_through_index, 11);
  assert.equal(summary.mirrored_latest_index, 11);
  assert.equal(summary.proof_scope, "full_chain");
  assert.match(sql, /insert or replace into mirror_meta/);
  assert.match(sql, /canonical_state_source/);
  assert.match(sql, /aml_fact_ledger/);
  assert.match(sql, /mirror_network/);
  assert.doesNotMatch(sql, /values \('devnet_only'/);
  assert.match(sql, /insert or replace into snapshots/);
  assert.match(sql, /circle_program:octDevCircle/);
  assert.match(sql, /insert or replace into core_accounting_facts/);
  assert.match(sql, /public_balance_raw/);
  assert.match(sql, /unclassified_raw/);
  assert.match(sql, /woct_coverage_ppm/);
});

test("lab mirror confirms post-write readback before reporting success", async () => {
  const history = sampleHistory();
  let writes = 0;
  const open = async (sql: string) => {
    if (/select\s+source_range_first_index/i.test(sql)) {
      return sqliteResult(["source_range_first_index", "source_range_latest_index", "last_complete_snapshot_index"]);
    }
    if (/select\s+source_range_latest_index,\s*last_complete_snapshot_index,\s*complete/i.test(sql)) {
      return sqliteResult(
        ["source_range_latest_index", "last_complete_snapshot_index", "complete"],
        [[11, 11, 1]]
      );
    }
    if (/select count\(\*\) as row_count\s+from snapshots/i.test(sql)) {
      return sqliteResult(["row_count"], [[2]]);
    }
    writes += 1;
    return sqliteResult([]);
  };

  const summary = await mirrorLabHistory(history, {
    target_kind: "circle_program",
    target_id: "octDevCircle"
  }, open);

  assert.ok(writes > 0);
  assert.equal(summary.complete_through_index, 11);
  assert.equal(summary.complete, true);
});

test("lab mirror performs no Circle writes when already complete", async () => {
  const history = sampleHistory();
  let writes = 0;
  const open = async (sql: string) => {
    if (/select\s+source_range_first_index/i.test(sql)) {
      return sqliteResult(
        ["source_range_first_index", "source_range_latest_index", "last_complete_snapshot_index"],
        [[10, 11, 11]]
      );
    }
    writes += 1;
    return sqliteResult([]);
  };

  const summary = await mirrorLabHistory(history, {
    target_kind: "circle_program",
    target_id: "octDevCircle"
  }, open);

  assert.equal(writes, 0);
  assert.equal(summary.row_count, 0);
  assert.equal(summary.complete, true);
  assert.equal(summary.complete_through_index, 11);
});

test("lab mirror waits for post-write readback to become visible", async () => {
  const history = sampleHistory();
  let watermarkChecks = 0;
  const open = async (sql: string) => {
    if (/select\s+source_range_first_index/i.test(sql)) {
      return sqliteResult(["source_range_first_index", "source_range_latest_index", "last_complete_snapshot_index"]);
    }
    if (/select\s+source_range_latest_index,\s*last_complete_snapshot_index,\s*complete/i.test(sql)) {
      watermarkChecks += 1;
      return watermarkChecks === 1
        ? sqliteResult(["source_range_latest_index", "last_complete_snapshot_index", "complete"], [[10, 10, 0]])
        : sqliteResult(["source_range_latest_index", "last_complete_snapshot_index", "complete"], [[11, 11, 1]]);
    }
    if (/select count\(\*\) as row_count\s+from snapshots/i.test(sql)) {
      return sqliteResult(["row_count"], [[2]]);
    }
    return sqliteResult([]);
  };

  const summary = await withLabReadbackRetryEnv(3, 0, () => mirrorLabHistory(history, {
    target_kind: "circle_program",
    target_id: "octDevCircle"
  }, open));

  assert.equal(watermarkChecks, 2);
  assert.equal(summary.complete_through_index, 11);
});

test("lab mirror rejects optimistic write success when readback is stale", async () => {
  const history = sampleHistory();
  const open = async (sql: string) => {
    if (/select\s+source_range_first_index/i.test(sql)) {
      return sqliteResult(["source_range_first_index", "source_range_latest_index", "last_complete_snapshot_index"]);
    }
    if (/select\s+source_range_latest_index,\s*last_complete_snapshot_index,\s*complete/i.test(sql)) {
      return sqliteResult(
        ["source_range_latest_index", "last_complete_snapshot_index", "complete"],
        [[10, 10, 0]]
      );
    }
    if (/select count\(\*\) as row_count\s+from snapshots/i.test(sql)) {
      return sqliteResult(["row_count"], [[1]]);
    }
    return sqliteResult([]);
  };

  await assert.rejects(
    () => withLabReadbackRetryEnv(1, 0, () => mirrorLabHistory(history, {
      target_kind: "circle_program",
      target_id: "octDevCircle"
    }, open)),
    /lab mirror readback mismatch/
  );
});

test("lab mirror planner advances from completion watermark without enumerating old rows", () => {
  const history = sampleHistory();
  const base: SummaryRow = history.rows[1]!;
  history.rows = [history.rows[0]!, history.rows[1]!, 12, 13, 14].map((index, offset) => {
    if (typeof index !== "number") return index;
    return {
      ...base,
      snapshot_index: index,
      observed_at_unix: 1_798_001_800 + (offset - 2) * 900,
      octra_epoch: 113 + index
    };
  });

  const plan = planLabHistoryMirrorRows(history, 11, 2);

  assert.deepEqual(plan.rows.map((row) => row.snapshot_index), [12, 13]);
  assert.equal(plan.completeThroughIndex, 13);
  assert.equal(plan.mirroredLatestIndex, 13);
  assert.equal(plan.pendingRowCount, 1);
  assert.equal(plan.complete, false);
});

test("core snapshot updater does not depend on the optional Lab mirror", async () => {
  const source = await readFile(resolve("src/scripts/run-snapshot-update.ts"), "utf8");

  assert.doesNotMatch(source, /from\s+["'][^"']*lab-history/);
  assert.doesNotMatch(source, /octra-sqlite/);
  assert.match(source, /confirmedAmlWrite/);
});

test("site release keeps Lab assets out of the core Circle and builds a separate Lab release", async () => {
  const coreOut = join(tmpdir(), `octra-vitals-core-release-${process.pid}.json`);
  const labOut = join(tmpdir(), `octra-vitals-lab-release-${process.pid}.json`);
  const env = {
    ...process.env,
    VITALS_STATE_TARGET_MODE: "circle_program",
    VITALS_LAB_HISTORY_ENABLED: "1",
    VITALS_INCLUDE_LAB_HISTORY_ASSETS: "1",
    VITALS_LAB_HISTORY_DATABASE_URI: "oct://devnet/octLabDatabaseCircle",
    VITALS_LAB_SITE_CIRCLE_ID: "octLabWebCircle"
  };

  await execFileAsync(process.execPath, ["dist/scripts/build-site-circle-release.js", coreOut], { env });
  await execFileAsync(process.execPath, ["dist/scripts/build-site-circle-release.js", "--lab", labOut], { env });

  const coreRelease = JSON.parse(await readFile(coreOut, "utf8"));
  const labRelease = JSON.parse(await readFile(labOut, "utf8"));
  const corePaths = coreRelease.assets.map((asset: any) => asset.path);
  const labPaths = labRelease.assets.map((asset: any) => asset.path);

  assert.equal(coreRelease.release_kind, "core");
  assert.doesNotMatch(corePaths.join("\n"), /lab-history/);
  assert.equal(labRelease.release_kind, "lab");
  assert.deepEqual(labPaths, ["/lab-history.html", "/lab-history.css", "/lab-history.js"]);
  assert.equal(labRelease.site_circle_id, "octLabWebCircle");
  assert.equal(labRelease.entry, "/lab-history.html");
});
