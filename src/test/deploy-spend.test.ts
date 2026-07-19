import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { deploymentSpendReportFromSource } from "../scripts/archive-deploy-spend-report.js";

const execFileAsync = promisify(execFile);
const root = resolve(new URL("../..", import.meta.url).pathname);
const script = join(root, "dist", "scripts", "archive-deploy-spend-report.js");

test("deployment spend sanitizer extracts public site asset spend only", () => {
  const source = {
    schema: "octra-vitals-site-circle-deploy-report-v0",
    status: "submitted",
    generated_at: "2026-07-19T15:10:00Z",
    deployer_address: "oct3biwr26gwcgxM1TkHSxMN74KHQgJqry331CmpAuNzq6R",
    circle_id: "octSiteCircle111111111111111111111111111111111111",
    entry_uri: "oct://octSiteCircle111111111111111111111111111111111111/index.html",
    asset_submissions: [
      {
        path: "/producer.audit.json",
        op_type: "circle_asset_put",
        tx_hash: "a".repeat(64),
        ou: "20000",
        tx_json: { should: "not be copied" }
      }
    ]
  };

  const report = deploymentSpendReportFromSource(source, JSON.stringify(source), "/owner/site-circle-deploy.json", "site_assets");

  assert.equal(report.kind, "site_assets");
  assert.equal(report.source_status, "submitted");
  assert.equal(report.write_count, 1);
  assert.equal(report.total_ou, "20000");
  assert.deepEqual(report.writes, [{
    op_type: "circle_asset_put",
    label: "site_asset",
    path: "/producer.audit.json",
    tx_hash: "a".repeat(64),
    ou: "20000"
  }]);
  assert.equal(JSON.stringify(report).includes("should"), false);
  assert.match(report.source_report_sha256, /^sha256:[a-f0-9]{64}$/);
});

test("deployment spend sanitizer extracts programmed Circle deployment calls", () => {
  const source = {
    schema: "octra-vitals-programmed-circle-deploy-v0",
    status: "initialized",
    generated_at: "2026-07-19T15:10:00Z",
    deployer_address: "oct3biwr26gwcgxM1TkHSxMN74KHQgJqry331CmpAuNzq6R",
    circle_id: "octProgramCircle1111111111111111111111111111111111",
    ou: {
      deploy_circle: "200000",
      circle_program_update: "200000",
      circle_call: "200000"
    },
    deploy_tx_hash: "b".repeat(64),
    program_update_tx_hash: "c".repeat(64),
    initialize_tx_hash: "d".repeat(64),
    core_family_tx_hash: "e".repeat(64)
  };

  const report = deploymentSpendReportFromSource(source, JSON.stringify(source), "/owner/programmed-circle-deploy.json", "program_deploy");

  assert.equal(report.write_count, 4);
  assert.equal(report.total_ou, "800000");
  assert.deepEqual(report.writes.map((write) => write.label), [
    "programmed_circle_deploy",
    "programmed_circle_update",
    "initialize_fact_ledger",
    "initialize_core_family"
  ]);
});

test("deployment spend archive CLI writes a sanitized report under deployment-runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octra-vitals-deploy-spend-"));
  try {
    const sourcePath = join(dir, "site-circle-deploy.json");
    await writeFile(sourcePath, `${JSON.stringify({
      schema: "octra-vitals-site-circle-deploy-report-v0",
      status: "submitted",
      generated_at: "2026-07-19T15:10:00Z",
      circle_id: "octSiteCircle111111111111111111111111111111111111",
      asset_submissions: [{ path: "/app.js", op_type: "circle_asset_put", tx_hash: "f".repeat(64), ou: "40000" }]
    })}\n`);

    await execFileAsync(process.execPath, [script, "--kind", "site_assets", "--report", sourcePath, "--out-dir", dir]);
    const archived = JSON.parse(await readFile(join(dir, "2026-07-19T151000Z-site_assets", "deployment_spend_report.json"), "utf8"));

    assert.equal(archived.schema, "octra-vitals-deployment-spend-report-v0");
    assert.equal(archived.write_count, 1);
    assert.equal(archived.total_ou, "40000");
    assert.equal(archived.writes[0].tx_hash, "f".repeat(64));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
