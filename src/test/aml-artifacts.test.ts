import assert from "node:assert/strict";
import test from "node:test";
import { approvedAmlRelease, assertAmlAbiBackwardCompatible, assertAmlCompileApproved, assertAmlCompilerAgreement, assertPreviousCompileApproved, hashJsonCompact, validateAmlCompile } from "../lib/aml-artifacts.js";
import { sha256Hex } from "../lib/canonical-json.js";

function compile(source = "contract Test {}", byte = "compiled") {
  const bytecode = Buffer.from(byte).toString("base64");
  const verification = { verified: true, safety: "safe", errors: 0, warnings: 0 };
  return {
    bytecode,
    version: "test-compiler",
    abi: { functions: [] },
    disasm: "STOP",
    verification,
    certificate: {
      source_hash: sha256Hex(source),
      bytecode_hash: sha256Hex(Buffer.from(bytecode, "base64")),
      verification_hash: hashJsonCompact(verification).replace("sha256:", ""),
      compiler: "test",
      compiler_version: "test-compiler"
    }
  };
}

test("AML compile validation hashes actual decoded bytecode and certificate bodies", () => {
  const source = "contract Test {}";
  const validated = validateAmlCompile(source, compile(source));
  const approved = approvedAmlRelease(validated);
  assert.doesNotThrow(() => assertAmlCompileApproved(validated, approved));
  assert.throws(() => validateAmlCompile(source, { ...compile(source), bytecode: Buffer.from("different").toString("base64") }), /certificate mismatch/);
});

test("independent AML compiler results must agree", () => {
  const source = "contract Test {}";
  const primary = validateAmlCompile(source, compile(source));
  const candidate = validateAmlCompile(source, compile(source, "other"));
  assert.throws(() => assertAmlCompilerAgreement(primary, candidate, "https://compiler-2"), /bytecode_hash/);
  const differentIdentity = compile(source);
  differentIdentity.certificate.compiler = "other-compiler";
  assert.throws(
    () => assertAmlCompilerAgreement(primary, validateAmlCompile(source, differentIdentity), "https://compiler-2"),
    /certificate.compiler/
  );
});

test("rollback compile artifacts must match every old approved hash", () => {
  const source = "contract Test {}";
  const result = compile(source) as ReturnType<typeof compile> & { source_hash: string };
  result.source_hash = `sha256:${sha256Hex(source)}`;
  const approved = approvedAmlRelease(validateAmlCompile(source, result));
  assert.doesNotThrow(() => assertPreviousCompileApproved(result, approved));
  assert.throws(() => assertPreviousCompileApproved({ ...result, disasm: "DIFFERENT" }, approved), /disasm_hash/);
  assert.throws(() => assertPreviousCompileApproved({
    ...result,
    certificate: { ...result.certificate, compiler: "different" }
  }, approved), /compiler/);
});

test("AML pin refresh cannot remove or mutate an existing getter contract", () => {
  const previous = {
    functions: [{ name: "get_owner", inputs: [], output: "address", view: true, payable: false }],
    events: [{ name: "OwnerChanged", fields: [{ name: "owner", type: "address" }] }]
  };
  assert.doesNotThrow(() => assertAmlAbiBackwardCompatible(previous, {
    functions: [...previous.functions, { name: "new_view", inputs: [], output: "string", view: true, payable: false }],
    events: previous.events
  }));
  assert.throws(() => assertAmlAbiBackwardCompatible(previous, { functions: [{ ...previous.functions[0], output: "string" }] }), /changed get_owner.output/);
  assert.throws(() => assertAmlAbiBackwardCompatible(previous, { functions: previous.functions, events: [] }), /removed event OwnerChanged/);
});
