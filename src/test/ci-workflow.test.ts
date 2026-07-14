import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("GitHub CI stays independent from live AML compiler RPCs", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");

  assert.match(workflow, /npm run native:verify:ci/);
  assert.doesNotMatch(workflow, /npm run native:verify(?!:ci)/);
  assert.doesNotMatch(workflow, /npm run native:verify:offline/);
  assert.doesNotMatch(workflow, /npm run program:compile/);
  assert.doesNotMatch(workflow, /VITALS_SINGLE_COMPILER_RPC_MAINNET_ACK/);
});
