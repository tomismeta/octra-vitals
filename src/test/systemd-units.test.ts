import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("snapshot updater retries are controlled by the timer, not service restart loops", async () => {
  const service = await readFile("deploy/systemd/octra-vitals-updater.service", "utf8");
  const timer = await readFile("deploy/systemd/octra-vitals-updater.timer", "utf8");

  assert.match(timer, /^Unit=octra-vitals-updater\.service$/m);
  assert.match(timer, /^OnCalendar=\*:0\/15$/m);
  assert.doesNotMatch(service, /^Restart=on-failure$/m);
  assert.doesNotMatch(service, /^RestartSec=/m);
});
