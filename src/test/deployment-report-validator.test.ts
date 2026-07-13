import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const validator = resolve(new URL("../..", import.meta.url).pathname, "deploy/lib/validate-programmed-circle-report.mjs");
const address = `oct${"1".repeat(44)}`;
const hash = `sha256:${"a".repeat(64)}`;

function report(): Record<string, unknown> {
  return {
    schema: "octra-vitals-programmed-circle-deploy-v0",
    status: "initialized",
    deploy_enabled: true,
    program_kind: "fact-ledger",
    circle_id: address,
    deployer_address: address,
    operator_address: `oct${"2".repeat(44)}`,
    views: { owner_matches: true, operator_matches: true },
    env_next: {
      VITALS_CIRCLE_VIEW_CALLER_ADDRESS: address,
      VITALS_PROGRAMMED_CIRCLE_ARTIFACT_DIR: "program-fact-ledger",
      VITALS_RECORD_SNAPSHOT_VERSION: "fact-v2",
      VITALS_FACT_LEDGER_NETWORK_ID: "octra-devnet",
      VITALS_FACT_LEDGER_CUTOVER_ACK: `fact-v2:circle_program:${address}`,
      VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_SOURCE_HASH: hash,
      VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_BYTECODE_HASH: hash,
      VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_VERIFICATION_HASH: hash
    }
  };
}

test("deployment report validator emits only strict inert assignments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octra-vitals-report-"));
  try {
    const input = join(dir, "report.json");
    const output = join(dir, "report.env");
    await writeFile(input, JSON.stringify(report()), { mode: 0o600 });
    await execFileAsync(process.execPath, [validator, input, output, String(process.getuid?.() ?? 0)]);
    const text = await readFile(output, "utf8");
    assert.match(text, new RegExp(`^REPORT_CIRCLE_ID=${address}$`, "m"));
    assert.equal(text.includes("NODE_OPTIONS"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deployment report validator rejects control-character injection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octra-vitals-report-"));
  try {
    const input = join(dir, "report.json");
    const output = join(dir, "report.env");
    const malicious = report() as any;
    malicious.env_next.VITALS_PROGRAMMED_CIRCLE_ARTIFACT_DIR = "program-fact-ledger\nNODE_OPTIONS=--require=/tmp/x";
    await writeFile(input, JSON.stringify(malicious), { mode: 0o600 });
    await assert.rejects(execFileAsync(process.execPath, [validator, input, output]), /control characters/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deployment report validator refuses symlink inputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octra-vitals-report-"));
  try {
    const target = join(dir, "target.json");
    const input = join(dir, "report.json");
    const output = join(dir, "report.env");
    await writeFile(target, JSON.stringify(report()), { mode: 0o600 });
    await symlink(target, input);
    await assert.rejects(execFileAsync(process.execPath, [validator, input, output]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deployment report validator refuses symlink outputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octra-vitals-report-"));
  try {
    const input = join(dir, "report.json");
    const target = join(dir, "target.env");
    const output = join(dir, "report.env");
    await writeFile(input, JSON.stringify(report()), { mode: 0o600 });
    await writeFile(target, "unchanged\n", { mode: 0o600 });
    await symlink(target, output);
    await assert.rejects(execFileAsync(process.execPath, [validator, input, output]));
    assert.equal(await readFile(target, "utf8"), "unchanged\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
