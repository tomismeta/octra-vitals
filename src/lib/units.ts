export const OCT_DECIMALS = 6;

export function hexToRawString(hex: string): string {
  if (!hex || hex === "0x") return "0";
  return BigInt(hex).toString();
}

export function decimalToRawString(value: string | number, decimals = OCT_DECIMALS): string {
  const text = String(value).trim();
  if (!text) return "0";
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [wholePart, fractionPart = ""] = unsigned.split(".");
  if (!/^\d+$/.test(wholePart || "0") || !/^\d*$/.test(fractionPart)) {
    throw new Error(`invalid decimal amount: ${value}`);
  }
  const fraction = fractionPart.padEnd(decimals, "0").slice(0, decimals);
  const raw = `${wholePart || "0"}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  return negative && raw !== "0" ? `-${raw}` : raw;
}

export function decimalOrRawToRawString(value: string | number, decimals = OCT_DECIMALS): string {
  const text = String(value).trim();
  if (!text) return "0";
  return text.includes(".") ? decimalToRawString(text, decimals) : BigInt(text).toString();
}

export function formatRaw(raw: string | number | bigint, decimals = OCT_DECIMALS, maxFraction = decimals): string {
  const negative = String(raw).startsWith("-");
  const digits = negative ? String(raw).slice(1) : String(raw);
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  let fraction = padded.slice(-decimals);
  if (maxFraction < decimals) fraction = fraction.slice(0, maxFraction);
  fraction = fraction.replace(/0+$/, "");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${fraction ? `.${fraction}` : ""}`;
}

export function sumRaw(values: Array<string | number | bigint>): string {
  return values.reduce<bigint>((total, value) => {
    if (typeof value === "string" && !/^-?\d+$/.test(value)) throw new Error(`invalid raw amount: ${value}`);
    return total + BigInt(value);
  }, 0n).toString();
}
