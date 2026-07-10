import type http from "node:http";
import { isIP } from "node:net";

export interface HostPolicyOptions {
  allowedHosts: string[];
  gatewayOriginHost?: string | null;
  servicePort?: number | string | null;
}

export interface ClientIpPolicyOptions {
  trustedProxyAddresses: string[];
  clientIpHeader?: string;
}

function headerString(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] || null;
  return value || null;
}

export function normalizeIp(value: string | null | undefined): string | null {
  if (!value) return null;
  let ip = value.trim();
  if (!ip) return null;
  if (ip.includes(",")) ip = ip.split(",")[0]?.trim() || "";
  if (!ip) return null;
  if (ip.startsWith("::ffff:")) ip = ip.slice("::ffff:".length);
  if (ip.startsWith("[") && ip.includes("]")) {
    ip = ip.slice(1, ip.indexOf("]"));
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) {
    ip = ip.slice(0, ip.lastIndexOf(":"));
  }
  return isIP(ip) ? ip : null;
}

function normalizedHeaderName(value: string | undefined): string {
  const name = (value || "x-forwarded-for").trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("client IP header name is invalid");
  return name;
}

export function trustedClientIdentity(
  req: http.IncomingMessage,
  options: ClientIpPolicyOptions
): { ip: string | null; source: "remote" | "proxy" | "none" } {
  const remote = normalizeIp(req.socket.remoteAddress);
  const trusted = new Set(options.trustedProxyAddresses.map((value) => normalizeIp(value)).filter(Boolean));
  if (remote && trusted.has(remote)) {
    const headerName = normalizedHeaderName(options.clientIpHeader);
    const rawHeader = headerString(req.headers[headerName]);
    const proxied = rawHeader && !rawHeader.includes(",") ? normalizeIp(rawHeader) : null;
    if (proxied) return { ip: proxied, source: "proxy" };
  }
  return remote ? { ip: remote, source: "remote" } : { ip: null, source: "none" };
}

export function trustedClientKey(req: http.IncomingMessage, options: ClientIpPolicyOptions): string {
  return trustedClientIdentity(req, options).ip || "unknown";
}

function localRequestHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function parseHostHeader(headerHost: string | undefined): { hostname: string; port: string } | null {
  if (!headerHost) return null;
  try {
    const parsed = new URL(`http://${headerHost}`);
    return {
      hostname: parsed.hostname.toLowerCase(),
      port: parsed.port
    };
  } catch {
    return null;
  }
}

function configuredAllowedHosts(options: HostPolicyOptions): Set<string> {
  const hosts = new Set(options.allowedHosts.map((value) => value.trim().toLowerCase()).filter(Boolean));
  const originHost = options.gatewayOriginHost?.trim().toLowerCase();
  if (originHost) {
    hosts.add(originHost);
    if (!originHost.startsWith("www.")) hosts.add(`www.${originHost}`);
  }
  return hosts;
}

export function hostAllowed(headerHost: string | undefined, options: HostPolicyOptions): boolean {
  const hosts = configuredAllowedHosts(options);
  const parsed = parseHostHeader(headerHost);
  if (!parsed) return hosts.size === 0;
  if (localRequestHost(parsed.hostname)) return true;
  if (hosts.size === 0) return true;
  if (parsed.port && hosts.has(`${parsed.hostname}:${parsed.port}`)) return true;
  if (!hosts.has(parsed.hostname)) return false;
  const servicePort = options.servicePort === undefined || options.servicePort === null ? null : String(options.servicePort);
  return parsed.port === "" || parsed.port === "80" || parsed.port === "443" || (servicePort !== null && parsed.port === servicePort);
}
