export function jsonContentType(value: string | null | undefined): boolean {
  return /^application\/json(?:\s*;|$)/i.test(value || "");
}

export function browserPostOriginAllowed(input: {
  origin: string | null | undefined;
  requestHost: string | null | undefined;
  allowedOrigins: string[];
  requireConfiguredOrigins?: boolean;
}): boolean {
  if (!input.origin) return true;
  let parsed: URL;
  try {
    parsed = new URL(input.origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const allowed = new Set(input.allowedOrigins.map((value) => value.trim().replace(/\/$/, "")).filter(Boolean));
  if (allowed.size > 0) return allowed.has(parsed.origin);
  if (input.requireConfiguredOrigins) return false;
  return Boolean(input.requestHost && parsed.host.toLowerCase() === input.requestHost.toLowerCase());
}
