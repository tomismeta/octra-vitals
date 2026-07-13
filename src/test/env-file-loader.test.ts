import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const loader = resolve(new URL("../..", import.meta.url).pathname, "deploy/lib/env-file.sh");

test("env loader treats shell metacharacters as inert data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octra-vitals-env-"));
  const envFile = join(dir, "runtime.env");
  const marker = join(dir, "executed");
  try {
    await writeFile(envFile, `SAFE=$(touch ${marker})\nPLAIN=value\n`);
    const { stdout } = await execFileAsync("bash", ["--noprofile", "--norc", "-c", `. '${loader}'; load_env_file_data '${envFile}'; printf '%s|%s' "$SAFE" "$PLAIN"`]);
    assert.equal(stdout, `$(touch ${marker})|value`);
    await assert.rejects(access(marker));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("env loader rejects duplicate and runtime-injection keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octra-vitals-env-"));
  try {
    const duplicate = join(dir, "duplicate.env");
    await writeFile(duplicate, "A=1\nA=2\n");
    await assert.rejects(execFileAsync("bash", ["--noprofile", "--norc", "-c", `. '${loader}'; load_env_file_data '${duplicate}'`]), /duplicate env key/);
    const injection = join(dir, "injection.env");
    await writeFile(injection, "NODE_OPTIONS=--require=/tmp/payload.js\n");
    await assert.rejects(execFileAsync("bash", ["--noprofile", "--norc", "-c", `. '${loader}'; load_env_file_data '${injection}'`]), /forbidden runtime env key/);
    const pathOverride = join(dir, "path.env");
    await writeFile(pathOverride, "PATH=/tmp/attacker\n");
    await assert.rejects(execFileAsync("bash", ["--noprofile", "--norc", "-c", `. '${loader}'; load_env_file_data '${pathOverride}'`]), /forbidden runtime env key/);
    const controlValue = join(dir, "control.env");
    await writeFile(controlValue, "SAFE=value\twith-tab\n");
    await assert.rejects(execFileAsync("bash", ["--noprofile", "--norc", "-c", `. '${loader}'; load_env_file_data '${controlValue}'`]), /control character/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("selected env snapshots omit unrelated parent variables", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octra-vitals-env-"));
  const output = join(dir, "selected.env");
  try {
    await execFileAsync("bash", ["--noprofile", "--norc", "-c", `. '${loader}'; KEEP='value with spaces'; DROP='secret'; write_selected_env_file '${output}' KEEP`]);
    assert.equal(await readFile(output, "utf8"), "KEEP=value with spaces\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("selected env snapshots reject control characters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octra-vitals-env-"));
  const output = join(dir, "selected.env");
  try {
    await assert.rejects(
      execFileAsync("bash", ["--noprofile", "--norc", "-c", `. '${loader}'; KEEP=$'value\\twith-tab'; write_selected_env_file '${output}' KEEP`]),
      /control character/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
