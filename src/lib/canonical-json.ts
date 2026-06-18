import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Cannot canonicalize non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (typeof value === "object" && value !== null) {
    const objectValue = value as Record<string, unknown>;
    const entries = Object.entries(objectValue).filter(([, entryValue]) => entryValue !== undefined);
    entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(",")}}`;
  }
  throw new TypeError(`Cannot canonicalize value of type ${typeof value}`);
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256Tagged(tag: string, canonicalValue: string): string {
  return `sha256:${sha256Hex(`${tag}\n${canonicalValue}`)}`;
}

export function responseHash(text: string): string {
  return `sha256:${sha256Hex(text)}`;
}

export function requestHash(value: unknown): string {
  return sha256Tagged("octra-vitals:request:v0", canonicalJson(value));
}
