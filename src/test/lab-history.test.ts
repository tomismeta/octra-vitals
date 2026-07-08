import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { buildLabHistoryMirrorSql, mirrorLabHistory, planLabHistoryMirrorRows } from "../lib/lab-history.js";
import { normalizeReadOnlySql, octraSqliteConfig, octraSqliteQueryProof, parseOctraSqliteOutput, publicLabQueryError } from "../lib/octra-sqlite-client.js";
import { acquireLock, historyReadOptionsForGap, runLabHistoryMirror } from "../scripts/run-lab-history-mirror.js";
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

async function withEnv<T>(updates: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(updates)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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

test("lab query guard rejects unsafe SQLite extension functions", () => {
  assert.throws(() => normalizeReadOnlySql("select load_extension('x')"), /unsafe_sql_function_not_allowed/);
  assert.throws(() => normalizeReadOnlySql("select readfile('/etc/passwd')"), /unsafe_sql_function_not_allowed/);
  assert.throws(() => normalizeReadOnlySql("select writefile('/tmp/x', 'x')"), /unsafe_sql_function_not_allowed/);
  assert.throws(() => normalizeReadOnlySql("select fileio_write('/tmp/x', 'x')"), /unsafe_sql_function_not_allowed/);
  assert.throws(() => normalizeReadOnlySql("select * from pragma_table_info('snapshots')"), /unsafe_sql_function_not_allowed/);
});

test("lab query guard rejects recursive and expensive read-looking SQL", () => {
  assert.throws(
    () => normalizeReadOnlySql("with recursive n(x) as (values(1) union all select x + 1 from n) select * from n"),
    /recursive_sql_not_allowed/
  );
  assert.throws(
    () => normalizeReadOnlySql("select * from (with recursive n(x) as (values(1) union all select x + 1 from n) select * from n)"),
    /recursive_sql_not_allowed/
  );
  assert.throws(
    () => normalizeReadOnlySql("with n(x) as (values(1) union all select x + 1 from n where x < 10) select * from n"),
    /recursive_sql_not_allowed/
  );
  assert.throws(
    () => normalizeReadOnlySql('with "n"(x) as (values(1) union all select x + 1 from "n" where x < 10) select * from "n"'),
    /recursive_sql_not_allowed/
  );
  assert.throws(
    () => normalizeReadOnlySql("with a(x) as (select x from b), b(x) as (select x from a) select * from a"),
    /recursive_sql_not_allowed/
  );
  assert.throws(
    () => normalizeReadOnlySql("with n(x) as (values(1) union all select x + 1 from (select 1 as d), n where x < 10) select * from n"),
    /recursive_sql_not_allowed/
  );
  assert.throws(() => normalizeReadOnlySql("select zeroblob(100000000)"), /expensive_sql_function_not_allowed/);
  assert.throws(() => normalizeReadOnlySql("select randomblob(100000000)"), /expensive_sql_function_not_allowed/);
});

test("lab query guard errors are safe to expose publicly", () => {
  assert.deepEqual(publicLabQueryError(new Error("unsafe_sql_function_not_allowed")), {
    error: "unsafe_sql_function_not_allowed",
    message: "SQLite extension, pragma, and file access functions are not available in public Lab queries."
  });
  assert.deepEqual(publicLabQueryError(new Error("recursive_sql_not_allowed")), {
    error: "recursive_sql_not_allowed",
    message: "Recursive queries are not available in public Lab queries."
  });
  assert.equal(publicLabQueryError(new Error("some_internal_circle_error")), null);
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
  assert.equal(summary.readback_status, "verified");
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

test("lab mirror replaces a dead-pid lock instead of skipping", async () => {
  const dir = await mkdtemp(join(tmpdir(), `octra-vitals-lab-lock-${process.pid}-`));
  const lockPath = join(dir, "lab-history-mirror.lock");
  await writeFile(lockPath, JSON.stringify({
    run_id: "dead-run",
    pid: 999_999_999,
    created_at: "2026-01-01T00:00:00Z"
  }, null, 2));

  try {
    const report = await withEnv({
      VITALS_LAB_HISTORY_RUN_ID: "lock-replacement-test",
      VITALS_LAB_HISTORY_DATA_DIR: dir,
      VITALS_LAB_HISTORY_LOCK_PATH: lockPath,
      VITALS_LAB_HISTORY_REPORT_PATH: join(dir, "latest.json"),
      VITALS_LAB_HISTORY_ENABLED: "0"
    }, () => runLabHistoryMirror());

    assert.equal(report.status, "skipped");
    assert.notEqual(report.reason, "mirror_already_running");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lab mirror stale-lock reclaim does not steal the fresh active lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), `octra-vitals-lab-lock-reclaim-${process.pid}-`));
  const lockPath = join(dir, "lab-history-mirror.lock");
  await writeFile(lockPath, JSON.stringify({
    run_id: "dead-run",
    pid: 999_999_999,
    created_at: "2026-01-01T00:00:00Z"
  }, null, 2));

  try {
    const first = await acquireLock(lockPath, "first-reclaimer", 0);
    assert.ok(first);
    const second = await acquireLock(lockPath, "second-reclaimer", 10 * 60_000);
    assert.equal(second, null);
    await first.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
  assert.equal(summary.readback_status, "verified");
});

test("lab mirror marks delayed readback pending without failing the optional worker", async () => {
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

  const summary = await withLabReadbackRetryEnv(1, 0, () => mirrorLabHistory(history, {
      target_kind: "circle_program",
      target_id: "octDevCircle"
    }, open));

  assert.equal(summary.readback_status, "pending");
  assert.match(summary.readback_error || "", /lab mirror readback mismatch/);
  assert.equal(summary.complete_through_index, 11);
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

test("lab mirror history read planner stays bounded to the missing gap", async () => {
  assert.deepEqual(historyReadOptionsForGap(100, 100), {});
  assert.deepEqual(historyReadOptionsForGap(100, 95), { maxSealedCapsules: 2 });

  await withEnv({
    VITALS_LAB_HISTORY_MAX_SEALED_CAPSULES: "4",
    VITALS_LAB_HISTORY_SYNC_TAIL_ROWS: "48"
  }, async () => {
    assert.deepEqual(historyReadOptionsForGap(300, 1), { maxSealedCapsules: 4 });
    assert.deepEqual(historyReadOptionsForGap(300, 299), { maxSealedCapsules: 3 });
  });
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
  const auditPath = resolve("app/producer.audit.json");
  let previousAudit: string | null = null;
  const env = {
    ...process.env,
    VITALS_STATE_TARGET_MODE: "circle_program",
    VITALS_LAB_HISTORY_ENABLED: "1",
    VITALS_INCLUDE_LAB_HISTORY_ASSETS: "1",
    VITALS_LAB_HISTORY_DATABASE_URI: "oct://devnet/octLabDatabaseCircle",
    VITALS_LAB_SITE_CIRCLE_ID: "octLabWebCircle"
  };

  try {
    try {
      previousAudit = await readFile(auditPath, "utf8");
    } catch {
      previousAudit = null;
    }

    await execFileAsync(process.execPath, ["dist/scripts/build-producer-audit-manifest.js"], { env });
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
  } finally {
    await rm(coreOut, { force: true });
    await rm(labOut, { force: true });
    if (previousAudit === null) {
      await rm(auditPath, { force: true });
    } else {
      await writeFile(auditPath, previousAudit);
    }
  }
});
