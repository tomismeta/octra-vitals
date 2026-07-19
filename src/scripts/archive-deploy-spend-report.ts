#!/usr/bin/env node
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(new URL("../..", import.meta.url).pathname);

export interface DeploymentSpendWrite {
  op_type: string;
  label: string | null;
  path: string | null;
  tx_hash: string;
  ou: string;
}

export interface DeploymentSpendReport {
  schema: "octra-vitals-deployment-spend-report-v0";
  generated_at: string;
  source_generated_at: string | null;
  kind: string;
  source_schema: string | null;
  source_status: string | null;
  source_report_name: string;
  source_report_sha256: string;
  deployer_address: string | null;
  circle_id: string | null;
  entry_uri: string | null;
  write_count: number;
  total_ou: string;
  writes: DeploymentSpendWrite[];
}

function isDirectCli(metaUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(resolve(argvPath));
  } catch {
    return fileURLToPath(metaUrl) === resolve(argvPath);
  }
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1] || null;
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nonNegativeIntegerText(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? trimmed : null;
}

function normalizeTxHash(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const hash = raw.replace(/^sha256:/, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}

function safeKind(value: string | null): string {
  const kind = value || "deployment";
  if (!/^[a-z0-9._-]{1,64}$/.test(kind)) throw new Error("deployment spend kind must be lowercase and file-safe");
  return kind;
}

function fileSafe(value: string): string {
  return value.replace(/[:.]/g, "").replace(/[^0-9A-Za-z_-]/g, "-");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function addWrite(writes: DeploymentSpendWrite[], input: {
  op_type?: unknown;
  label?: unknown;
  path?: unknown;
  tx_hash?: unknown;
  ou?: unknown;
}): void {
  const txHash = normalizeTxHash(input.tx_hash);
  const ou = nonNegativeIntegerText(input.ou);
  if (!txHash || ou === null) return;
  writes.push({
    op_type: text(input.op_type) || "unknown",
    label: text(input.label),
    path: text(input.path),
    tx_hash: txHash,
    ou
  });
}

function txOu(value: any): string | null {
  return nonNegativeIntegerText(value?.ou) ||
    nonNegativeIntegerText(value?.transaction?.ou) ||
    nonNegativeIntegerText(value?.tx?.ou) ||
    null;
}

function collectSiteWrites(report: any): DeploymentSpendWrite[] {
  const writes: DeploymentSpendWrite[] = [];
  addWrite(writes, {
    op_type: "deploy_circle",
    label: "site_circle_deploy",
    tx_hash: report?.deploy_tx_hash,
    ou: txOu(report?.deploy_tx) || report?.deploy_submission?.ou
  });
  for (const submission of Array.isArray(report?.asset_submissions) ? report.asset_submissions : []) {
    addWrite(writes, {
      op_type: submission?.op_type || "circle_asset_put",
      label: "site_asset",
      path: submission?.path,
      tx_hash: submission?.tx_hash,
      ou: submission?.ou || txOu(submission?.tx)
    });
  }
  for (const prepared of Array.isArray(report?.prepared_asset_transactions) ? report.prepared_asset_transactions : []) {
    addWrite(writes, {
      op_type: prepared?.op_type || "circle_asset_put",
      label: "site_asset_prepared",
      path: prepared?.path,
      tx_hash: prepared?.tx_hash || prepared?.prepared_tx_hash,
      ou: prepared?.ou
    });
  }
  return writes;
}

function collectProgramDeployWrites(report: any): DeploymentSpendWrite[] {
  const writes: DeploymentSpendWrite[] = [];
  addWrite(writes, {
    op_type: "deploy_circle",
    label: "programmed_circle_deploy",
    tx_hash: report?.deploy_tx_hash,
    ou: txOu(report?.deploy_tx) || report?.ou?.deploy_circle
  });
  addWrite(writes, {
    op_type: "circle_program_update",
    label: "programmed_circle_update",
    tx_hash: report?.program_update_tx_hash,
    ou: txOu(report?.program_update_tx) || report?.ou?.circle_program_update
  });
  addWrite(writes, {
    op_type: "circle_call",
    label: "initialize_fact_ledger",
    tx_hash: report?.initialize_tx_hash,
    ou: txOu(report?.initialize_tx) || report?.ou?.circle_call
  });
  addWrite(writes, {
    op_type: "circle_call",
    label: "initialize_core_family",
    tx_hash: report?.core_family_tx_hash,
    ou: txOu(report?.core_family_tx) || report?.ou?.circle_call
  });
  return writes;
}

function collectProgramUpdateWrites(report: any): DeploymentSpendWrite[] {
  const writes: DeploymentSpendWrite[] = [];
  addWrite(writes, {
    op_type: "circle_program_update",
    label: "program_update",
    tx_hash: report?.update?.tx_hash,
    ou: report?.update?.ou || report?.ou
  });
  addWrite(writes, {
    op_type: "circle_program_update",
    label: "program_update_rollback",
    tx_hash: report?.rollback?.tx_hash,
    ou: report?.rollback?.ou || report?.ou
  });
  return writes;
}

export function deploymentSpendReportFromSource(
  source: any,
  sourceText: string,
  sourceReportPath: string,
  kindInput: string
): DeploymentSpendReport {
  const sourceSchema = text(source?.schema);
  const writes =
    sourceSchema === "octra-vitals-site-circle-deploy-report-v0"
      ? collectSiteWrites(source)
      : sourceSchema === "octra-vitals-programmed-circle-deploy-v0"
        ? collectProgramDeployWrites(source)
        : sourceSchema === "octra-vitals-programmed-circle-code-update-v1"
          ? collectProgramUpdateWrites(source)
          : [...collectSiteWrites(source), ...collectProgramDeployWrites(source), ...collectProgramUpdateWrites(source)];
  const deduped = [...new Map(writes.map((write) => [`${write.tx_hash}:${write.path || ""}:${write.label || ""}`, write])).values()];
  const totalOu = deduped.reduce((total, write) => total + BigInt(write.ou), 0n).toString();
  return {
    schema: "octra-vitals-deployment-spend-report-v0",
    generated_at: isoNow(),
    source_generated_at: text(source?.generated_at),
    kind: safeKind(kindInput),
    source_schema: sourceSchema,
    source_status: text(source?.status),
    source_report_name: basename(sourceReportPath),
    source_report_sha256: `sha256:${sha256Hex(sourceText)}`,
    deployer_address: text(source?.deployer_address) || text(source?.updater_address),
    circle_id: text(source?.circle_id),
    entry_uri: text(source?.entry_uri),
    write_count: deduped.length,
    total_ou: totalOu,
    writes: deduped
  };
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o750 });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o640 });
  await rename(tmp, path);
}

async function main(): Promise<void> {
  const reportArg = argValue("--report");
  if (!reportArg) throw new Error("--report is required");
  const reportPath = resolve(reportArg);
  const kind = safeKind(argValue("--kind"));
  const outDir = resolve(argValue("--out-dir") || process.env.VITALS_DEPLOYMENT_RUNS_DIR || join(root, "data", "deployment-runs"));
  const sourceText = await readFile(reportPath, "utf8");
  const source = JSON.parse(sourceText);
  const report = deploymentSpendReportFromSource(source, sourceText, reportPath, kind);
  const stamp = fileSafe(report.source_generated_at || report.generated_at);
  const outPath = join(outDir, `${stamp}-${kind}`, "deployment_spend_report.json");
  await writeJsonAtomic(outPath, report);
  console.log(JSON.stringify({
    schema: report.schema,
    kind: report.kind,
    source_schema: report.source_schema,
    source_status: report.source_status,
    circle_id: report.circle_id,
    write_count: report.write_count,
    total_ou: report.total_ou,
    out_path: outPath
  }, null, 2));
}

if (isDirectCli(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
