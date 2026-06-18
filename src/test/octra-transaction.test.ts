import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  canonicalTransactionJson,
  deriveOctraAddress,
  publicTransactionJson,
  signTransaction,
  transactionHash,
  type OctraTransaction
} from "../lib/octra-transaction.js";

test("canonicalTransactionJson preserves Octra transaction field order", () => {
  const tx: OctraTransaction = {
    from: "octFrom",
    to_: "octTo",
    amount: "0",
    nonce: 7,
    ou: "1000",
    timestamp: 1780000000.125,
    op_type: "call",
    encrypted_data: "record_snapshot_v0",
    message: "[\"vitals.2026-06-07T00:00:00Z\"]"
  };

  const expected = '{"from":"octFrom","to_":"octTo","amount":"0","nonce":7,"ou":"1000","timestamp":1780000000.125,"op_type":"call","encrypted_data":"record_snapshot_v0","message":"[\\"vitals.2026-06-07T00:00:00Z\\"]"}';

  assert.equal(canonicalTransactionJson(tx), expected);
  assert.equal(transactionHash(tx), createHash("sha256").update(expected).digest("hex"));
});

test("deriveOctraAddress is stable for a known public key", () => {
  const publicKey = Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex");

  assert.equal(deriveOctraAddress(publicKey), "oct7ffZx9dmRweYnDbecGybaF66gitu9cbWBsJBzNEWF47v");
});

test("publicTransactionJson exposes signed transaction fields without private material", () => {
  const tx: OctraTransaction = {
    from: "octFrom",
    to_: "octTo",
    amount: "0",
    nonce: 1,
    ou: "1000",
    timestamp: 1780000000,
    op_type: "call",
    signature: "sig",
    public_key: "pub",
    encrypted_data: "record_snapshot_v0",
    message: "[]"
  };

  assert.deepEqual(publicTransactionJson(tx), {
    from: "octFrom",
    to_: "octTo",
    amount: "0",
    nonce: 1,
    ou: "1000",
    timestamp: 1780000000,
    signature: "sig",
    public_key: "pub",
    op_type: "call",
    encrypted_data: "record_snapshot_v0",
    message: "[]"
  });
});

test("signTransaction is pinned for a known seed and call payload", () => {
  const privateKeySeed = Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex");
  const publicKey = Buffer.from("03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8", "hex");
  const tx: OctraTransaction = {
    from: "octFixture",
    to_: "octProgram",
    amount: "0",
    nonce: 42,
    ou: "1000",
    timestamp: 1780000000.125,
    op_type: "call",
    encrypted_data: "record_snapshot_v0",
    message: "[\"vitals.2026-06-07T00:00:00Z\"]"
  };

  const signed = signTransaction(tx, {
    address: "octFixture",
    privateKeySeed,
    publicKey,
    publicKeyBase64: publicKey.toString("base64")
  });

  assert.equal(transactionHash(signed), "cfda8ee5bf839672b78c9497c17547e6f479721c654e975e92af314976af884f");
  assert.equal(signed.public_key, "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=");
  assert.equal(signed.signature, "10tVek3pvMmzJB1LfnBnN8Y2JnVmZQbfaLxT+fWU8ZiSuOLf4sT7c9YhQT/sGV2D/10cKx+qajf0HrUj8e4GDw==");
});

test("signTransaction rejects a public key that does not derive from the seed", () => {
  const privateKeySeed = Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex");
  const wrongPublicKey = Buffer.from("03a107bff3ce10be1d70dd18e74bc09967e3f7dd35e62d158b9e8fe0f7d6a202", "hex");
  const tx: OctraTransaction = {
    from: "octFixture",
    to_: "octProgram",
    amount: "0",
    nonce: 42,
    ou: "1000",
    timestamp: 1780000000.125,
    op_type: "call",
    encrypted_data: "record_snapshot_v0",
    message: "[\"vitals.2026-06-07T00:00:00Z\"]"
  };

  assert.throws(
    () => signTransaction(tx, {
      address: "octFixture",
      privateKeySeed,
      publicKey: wrongPublicKey,
      publicKeyBase64: wrongPublicKey.toString("base64")
    }),
    /public half does not match/
  );
});
