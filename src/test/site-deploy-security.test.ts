import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(new URL("../..", import.meta.url).pathname);
const script = join(root, "dist/scripts/deploy-site-circle.js");

test("Site Circle deployment confines release manifests and asset paths", async () => {
  const releasePath = join(root, "build", `unsafe-site-release-${process.pid}.json`);
  const reportPath = join(root, "build", `unsafe-site-report-${process.pid}.json`);
  await mkdir(join(root, "build"), { recursive: true });
  try {
    await writeFile(releasePath, JSON.stringify({
      release_kind: "core",
      entry: "/index.html",
      assets: [{ path: "/../package.json" }]
    }));
    await assert.rejects(
      execFileAsync(process.execPath, [script, "--dry-run", reportPath], {
        cwd: root,
        env: { ...process.env, VITALS_SITE_RELEASE_PATH: releasePath }
      }),
      /safe absolute asset path/
    );
    await assert.rejects(
      execFileAsync(process.execPath, [script, "--dry-run", reportPath], {
        cwd: root,
        env: { ...process.env, VITALS_SITE_RELEASE_PATH: join(root, "package.json") }
      }),
      /must stay under build/
    );
  } finally {
    await rm(releasePath, { force: true });
    await rm(reportPath, { force: true });
  }
});
