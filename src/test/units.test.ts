import assert from "node:assert/strict";
import test from "node:test";

import { decimalOrRawToRawString, decimalToRawString, formatRaw, hexToRawString, sumRaw } from "../lib/units.js";

test("decimal amounts convert to raw OCT strings without rounding", () => {
  assert.equal(decimalToRawString("1.234567"), "1234567");
  assert.equal(decimalToRawString("1.23456789"), "1234567");
  assert.equal(decimalToRawString("0.1"), "100000");
  assert.equal(decimalToRawString("-0.000001"), "-1");
  assert.equal(decimalToRawString(""), "0");
});

test("raw, hex, formatting, and sums stay deterministic", () => {
  assert.equal(decimalOrRawToRawString("1234567"), "1234567");
  assert.equal(hexToRawString("0x0f"), "15");
  assert.equal(formatRaw("1234567"), "1.234567");
  assert.equal(formatRaw("123456700", 6, 2), "123.45");
  assert.equal(sumRaw(["1", 2n, "3"]), "6");
});

test("invalid decimal input is rejected", () => {
  assert.throws(() => decimalToRawString("12abc"), /invalid decimal amount/);
  assert.throws(() => sumRaw(["1", ""]), /invalid raw amount/);
});
