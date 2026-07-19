import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("snapshot updater retries are controlled by the timer, not service restart loops", async () => {
  const service = await readFile("deploy/systemd/octra-vitals-updater.service", "utf8");
  const timer = await readFile("deploy/systemd/octra-vitals-updater.timer", "utf8");

  assert.match(timer, /^OnUnitActiveSec=15min$/m);
  assert.doesNotMatch(service, /^Restart=on-failure$/m);
  assert.doesNotMatch(service, /^RestartSec=/m);
});
