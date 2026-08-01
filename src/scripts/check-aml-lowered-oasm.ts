#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assertNoDuplicateJdestLabels } from "../lib/aml-lowered-oasm.js";

const root = resolve(new URL("../..", import.meta.url).pathname);
const artifactDir = process.env.VITALS_PROGRAMMED_CIRCLE_ARTIFACT_DIR || "program-fact-ledger";
const loweredPath = join(root, artifactDir, "lowered.oasm");

const source = await readFile(loweredPath, "utf8");
const inspection = assertNoDuplicateJdestLabels(source);

console.log(JSON.stringify({
  ok: true,
  lowered_oasm: artifactDir,
  jdest_labels: inspection.labels,
  duplicate_jdest_labels: 0
}, null, 2));
