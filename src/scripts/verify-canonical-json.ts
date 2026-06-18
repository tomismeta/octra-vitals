#!/usr/bin/env node
import { canonicalJson, sha256Tagged } from "../lib/canonical-json.js";

const fixtures = [
  {
    name: "sorted-object",
    value: { b: "2", a: "1", nested: { z: false, m: null } },
    canonical: "{\"a\":\"1\",\"b\":\"2\",\"nested\":{\"m\":null,\"z\":false}}",
    taggedHash: "sha256:8d9bd31975f7ae50dc4b441501ffcb1472ceb9c3d70330938cca2696b6a3de64"
  },
  {
    name: "snapshot-shape",
    value: {
      schema_version: "octra-vitals-snapshot-v0",
      units: { woct_decimals: 6, oct_decimals: 6 },
      supply: {
        max_oct_raw: "1000000000000000",
        issued_oct_raw: "622215150304816",
        encrypted_oct_raw: "12413100000000",
        burned_oct_raw: "377784849695184",
        confirmed_burned_oct_raw: "377784849695184"
      },
      routes: [
        {
          route_id: "octra-7777:ethereum-1:woct",
          src_chain: "octra",
          src_chain_id: 7777,
          dst_chain: "ethereum",
          dst_chain_id: 1,
          asset: "wOCT",
          vault_address: "octVault",
          wrapped_address: "0xToken",
          bridge_address: "0xBridge",
          locked_raw: "190812959049874",
          wrapped_supply_raw: "190314381881115",
          unclaimed_raw: "371566348509",
          source_ref_ids: ["octra.batch"]
        }
      ]
    },
    canonical: "{\"routes\":[{\"asset\":\"wOCT\",\"bridge_address\":\"0xBridge\",\"dst_chain\":\"ethereum\",\"dst_chain_id\":1,\"locked_raw\":\"190812959049874\",\"route_id\":\"octra-7777:ethereum-1:woct\",\"source_ref_ids\":[\"octra.batch\"],\"src_chain\":\"octra\",\"src_chain_id\":7777,\"unclaimed_raw\":\"371566348509\",\"vault_address\":\"octVault\",\"wrapped_address\":\"0xToken\",\"wrapped_supply_raw\":\"190314381881115\"}],\"schema_version\":\"octra-vitals-snapshot-v0\",\"supply\":{\"burned_oct_raw\":\"377784849695184\",\"confirmed_burned_oct_raw\":\"377784849695184\",\"encrypted_oct_raw\":\"12413100000000\",\"issued_oct_raw\":\"622215150304816\",\"max_oct_raw\":\"1000000000000000\"},\"units\":{\"oct_decimals\":6,\"woct_decimals\":6}}",
    taggedHash: "sha256:c74490aa5005305eb5641d429ff2f9152cfcc574a8d3e6343a409f7a40c36e55"
  }
];

const failures: string[] = [];
for (const fixture of fixtures) {
  const canonical = canonicalJson(fixture.value);
  if (canonical !== fixture.canonical) {
    failures.push(`${fixture.name}: canonical mismatch`);
  }
  const hash = sha256Tagged("octra-vitals:canonical-fixture:v0", canonical);
  if (hash !== fixture.taggedHash) {
    failures.push(`${fixture.name}: tagged hash mismatch`);
  }
}

console.log(JSON.stringify({
  ok: failures.length === 0,
  fixtures: fixtures.length,
  failures
}, null, 2));

if (failures.length) process.exitCode = 1;
