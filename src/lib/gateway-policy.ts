import type http from "node:http";

export interface HostPolicyOptions {
  allowedHosts: string[];
  gatewayOriginHost?: string | null;
  servicePort?: number | string | null;
}

function headerString(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] || null;
  return value || null;
}

function normalizeIp(value: string | null | undefined): string | null {
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
  return ip || null;
}

function proxyIp(req: http.IncomingMessage): string | null {
  return normalizeIp(
    headerString(req.headers["x-forwarded-for"]) ||
      headerString(req.headers["x-real-ip"]) ||
      headerString(req.headers["cf-connecting-ip"]) ||
      headerString(req.headers["true-client-ip"]) ||
      headerString(req.headers["x-client-ip"]) ||
      headerString(req.headers["fly-client-ip"])
  );
}

export function trustedClientKey(req: http.IncomingMessage, trustProxyHeaders: boolean): string {
  const proxied = trustProxyHeaders ? proxyIp(req) : null;
  return proxied || normalizeIp(req.socket.remoteAddress) || "unknown";
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
