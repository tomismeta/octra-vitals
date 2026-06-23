#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  CALENDAR_STAT_NODE_LEN,
  CAPSULE_META_LEN,
  HISTORY_ROW_LEN,
  TX_HASH_HEX_LEN
} from "../lib/aml-history-probe.js";

const root = resolve(new URL("../..", import.meta.url).pathname);

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isoStamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function reportPath(): string {
  return process.env.VITALS_HISTORY_COST_MODEL_REPORT ||
    join(root, "reports", `history-cost-model-${isoStamp().replace(/[:]/g, "")}.json`);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stableJson(value));
}

function configuredRowLimit(): number {
  const value = Number(process.env.VITALS_HISTORY_COST_MODEL_ROW_LIMIT || "48");
  if (![12, 24, 48, 96].includes(value)) throw new Error("VITALS_HISTORY_COST_MODEL_ROW_LIMIT must be one of 12,24,48,96");
  return value;
}

function round(value: number, decimals = 3): number {
  return Number(value.toFixed(decimals));
}

const rowLimit = configuredRowLimit();
const snapshotsPerDay = 24 * 4;
const snapshotsPerYear = 365 * snapshotsPerDay;
const capsulesPerDay = snapshotsPerDay / rowLimit;
const capsulesPerYear = Math.ceil(snapshotsPerYear / rowLimit);

// Current measured baseline from the 4x48 standalone resident body-map devnet probe.
const measured = {
  row_limit: 48,
  append_effort_avg: 1482,
  append_effort_max: 1692,
  seal_effort: 3127,
  initialize_effort: 2239,
  body_bytes_per_capsule: 48 * HISTORY_ROW_LEN,
  meta_bytes_per_capsule: CAPSULE_META_LEN,
  tx_index_bytes_per_capsule: 48 * TX_HASH_HEX_LEN
};

const appendEffortAvg = measured.append_effort_avg;
const sealEffort = measured.seal_effort;
const bodyBytesPerCapsule = rowLimit * HISTORY_ROW_LEN;
const metaBytesPerCapsule = CAPSULE_META_LEN;
const txIndexBytesPerCapsule = rowLimit * TX_HASH_HEX_LEN;
const capsuleBytesWithTxIndex = bodyBytesPerCapsule + metaBytesPerCapsule + txIndexBytesPerCapsule;
const capsuleBytesWithoutTxIndex = bodyBytesPerCapsule + metaBytesPerCapsule;
const dayNodesPerYear = 365;
const monthNodesPerYear = 12;
const yearNodesPerYear = 1;
const hourNodesPerYear = 365 * 24;

const report = {
  schema: "octra-vitals-history-cost-model-v1",
  generated_at: isoStamp(),
  basis: {
    cadence_minutes: 15,
    row_limit: rowLimit,
    snapshots_per_day: snapshotsPerDay,
    snapshots_per_year: snapshotsPerYear,
    capsules_per_day: capsulesPerDay,
    capsules_per_year: capsulesPerYear,
    measured_devnet_baseline: measured,
    caveat: "Effort is not asserted to be the final OCT fee. Mainnet OCT cost must be calibrated from live fee policy and receipts."
  },
  effort_model: {
    append_effort_per_snapshot_avg: appendEffortAvg,
    seal_effort_per_capsule: sealEffort,
    daily_append_effort: round(snapshotsPerDay * appendEffortAvg),
    daily_seal_effort: round(capsulesPerDay * sealEffort),
    daily_total_effort: round(snapshotsPerDay * appendEffortAvg + capsulesPerDay * sealEffort),
    yearly_append_effort: round(snapshotsPerYear * appendEffortAvg),
    yearly_seal_effort: round(capsulesPerYear * sealEffort),
    yearly_total_effort: round(snapshotsPerYear * appendEffortAvg + capsulesPerYear * sealEffort),
    transaction_count_if_probe_style_separate_seal: {
      daily: snapshotsPerDay + capsulesPerDay,
      yearly: snapshotsPerYear + capsulesPerYear
    },
    transaction_count_if_v1_atomic_boundary_seal: {
      daily: snapshotsPerDay,
      yearly: snapshotsPerYear
    }
  },
  aml_state_bytes_per_year: {
    capsules_without_tx_index: capsuleBytesWithoutTxIndex * capsulesPerYear,
    capsules_with_tx_index: capsuleBytesWithTxIndex * capsulesPerYear,
    calendar_day_month_year_nodes: (dayNodesPerYear + monthNodesPerYear + yearNodesPerYear) * CALENDAR_STAT_NODE_LEN,
    calendar_hour_day_month_year_nodes: (hourNodesPerYear + dayNodesPerYear + monthNodesPerYear + yearNodesPerYear) * CALENDAR_STAT_NODE_LEN,
    note: "Calendar nodes are derived verification indexes. If hour nodes are too costly, day/month/year nodes still support the primary longer-horizon UI."
  },
  read_model_48_row_capsules: {
    one_day_capsules: 2,
    seven_day_capsules: 14,
    thirty_day_capsules: 60,
    one_year_capsules: 730,
    one_day_body_meta_tx_bytes: 2 * capsuleBytesWithTxIndex,
    seven_day_body_meta_tx_bytes: 14 * capsuleBytesWithTxIndex,
    thirty_day_body_meta_tx_bytes: 60 * capsuleBytesWithTxIndex,
    one_year_body_meta_tx_bytes: 730 * capsuleBytesWithTxIndex
  },
  recommendation: [
    "Use 48-row capsules as the conservative measured baseline.",
    "Keep tx indexes in the design gate, but make them removable if permanent AML bytes matter more than lookup convenience.",
    "Treat 96-row daily capsules as a follow-up cost-knee probe, not the default until programmed-Circle parity and cadence soak pass.",
    "Calibrate OCT fees from real receipts before mainnet successor deployment."
  ]
};

const outputPath = reportPath();
await writeJson(outputPath, report);
console.log(stableJson({
  status: "ok",
  report_path: outputPath,
  yearly_total_effort: report.effort_model.yearly_total_effort,
  yearly_state_mb_with_tx_index: round(report.aml_state_bytes_per_year.capsules_with_tx_index / 1_000_000),
  yearly_state_mb_without_tx_index: round(report.aml_state_bytes_per_year.capsules_without_tx_index / 1_000_000)
}));
