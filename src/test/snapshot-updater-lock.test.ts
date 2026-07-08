import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { acquireLock } from "../scripts/run-snapshot-update.js";

test("snapshot updater lock refuses to reclaim stale lock for a live pid", async () => {
  const dir = await mkdtemp(join(tmpdir(), `octra-vitals-updater-lock-live-${process.pid}-`));
  const lockPath = join(dir, "snapshot-updater.lock");
  const lockBody = {
    schema: "octra-vitals-updater-lock-v0",
    run_id: "still-running",
    pid: process.pid,
    started_at: "2026-01-01T00:00:00Z",
    token: "existing-token"
  };
  await writeFile(lockPath, `${JSON.stringify(lockBody, null, 2)}\n`);

  try {
    await assert.rejects(
      () => acquireLock(lockPath, "new-run", 1),
      /pid .* is still alive/
    );
    assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), lockBody);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshot updater lock release does not remove a different owner", async () => {
  const dir = await mkdtemp(join(tmpdir(), `octra-vitals-updater-lock-owner-${process.pid}-`));
  const lockPath = join(dir, "snapshot-updater.lock");

  try {
    const lock = await acquireLock(lockPath, "owner-run", 60_000);
    await writeFile(lockPath, JSON.stringify({
      schema: "octra-vitals-updater-lock-v0",
      run_id: "new-owner",
      pid: process.pid,
      started_at: new Date().toISOString(),
      token: "new-token"
    }, null, 2));

    await assert.rejects(() => lock.assertOwned(), /lock ownership changed/);
    await lock.release();

    const remaining = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(remaining.run_id, "new-owner");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshot updater lock reclaims corrupt stale lock by file age", async () => {
  const dir = await mkdtemp(join(tmpdir(), `octra-vitals-updater-lock-corrupt-${process.pid}-`));
  const lockPath = join(dir, "snapshot-updater.lock");
  const old = new Date(Date.now() - 60_000);
  await writeFile(lockPath, "not-json\n");
  await utimes(lockPath, old, old);

  try {
    const lock = await acquireLock(lockPath, "new-run", 1);
    const body = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(body.run_id, "new-run");
    await lock.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshot updater lock reclaims stale lock for a dead pid", async () => {
  const dir = await mkdtemp(join(tmpdir(), `octra-vitals-updater-lock-dead-${process.pid}-`));
  const lockPath = join(dir, "snapshot-updater.lock");
  await writeFile(lockPath, JSON.stringify({
    schema: "octra-vitals-updater-lock-v0",
    run_id: "dead-run",
    pid: 999_999_999,
    started_at: "2026-01-01T00:00:00Z",
    token: "dead-token"
  }, null, 2));

  try {
    const lock = await acquireLock(lockPath, "new-run", 1);
    const body = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(body.run_id, "new-run");
    await lock.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
