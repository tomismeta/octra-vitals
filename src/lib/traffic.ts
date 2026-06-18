import { createHmac, randomBytes } from "node:crypto";
import type http from "node:http";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

export const TRAFFIC_SCHEMA_VERSION = "octra-vitals-traffic-hour-v0";

type CounterMap = Record<string, number>;
type ClientMap = Record<string, true>;

export interface TrafficMetric {
  requests: number;
  bytes: number;
  duration_ms: number;
  methods: CounterMap;
  statuses: CounterMap;
  latency_ms: CounterMap;
  client_sources: CounterMap;
  clients?: ClientMap;
}

export interface TrafficHourFile {
  schema: typeof TRAFFIC_SCHEMA_VERSION;
  hour: string;
  updated_at: string;
  totals: TrafficMetric;
  routes: Record<string, TrafficMetric>;
  diagnostic_paths?: Record<string, TrafficMetric>;
  diagnostic_path_overflow?: TrafficMetric;
}

interface TrafficRecorderOptions {
  enabled: boolean;
  dir: string;
  clientMode: "none" | "daily_hash";
  trustProxyHeaders: boolean;
  flushDelayMs: number;
  diagnosticPathLimit: number;
}

interface ClientIdentity {
  hash: string | null;
  source: "none" | "remote" | "proxy";
}

const latencyBuckets = [
  ["lt_100", 100],
  ["lt_500", 500],
  ["lt_1000", 1000],
  ["lt_3000", 3000],
  ["lt_10000", 10_000]
] as const;

function emptyMetric(): TrafficMetric {
  return {
    requests: 0,
    bytes: 0,
    duration_ms: 0,
    methods: {},
    statuses: {},
    latency_ms: {},
    client_sources: {}
  };
}

function bump(map: CounterMap, key: string, amount = 1): void {
  map[key] = (map[key] || 0) + amount;
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

function remoteIp(req: http.IncomingMessage): string | null {
  return normalizeIp(req.socket.remoteAddress);
}

function hourIso(date: Date): string {
  return `${date.toISOString().slice(0, 13)}:00:00Z`;
}

function dayIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function hourFileName(hour: string): string {
  return `${hour.slice(0, 13)}.json`;
}

export function routeGroup(pathname: string): string {
  if (pathname === "/" || pathname === "/index.html") return "/";
  if (pathname === "/health") return "/health";
  if (pathname === "/api/latest") return "/api/latest";
  if (pathname === "/api/history") return "/api/history";
  if (pathname === "/api/version" || pathname === "/version") return "/api/version";
  if (pathname === "/api/native-readiness") return "/api/native-readiness";
  if (pathname === "/api/site-integrity") return "/api/site-integrity";
  if (pathname === "/api/program/artifacts") return "/api/program/artifacts";
  if (pathname.startsWith("/api/evidence/raw/")) return "/api/evidence/raw/:hash";
  if (pathname.startsWith("/api/evidence/")) return "/api/evidence/:hash";
  const ext = extname(pathname).toLowerCase();
  if ([".html", ".js", ".css", ".json", ".webmanifest", ".svg", ".ico", ".png", ".txt", ".xml"].includes(ext)) {
    return "static_assets";
  }
  return "other";
}

export function createTrafficHour(hour: string): TrafficHourFile {
  return {
    schema: TRAFFIC_SCHEMA_VERSION,
    hour,
    updated_at: new Date().toISOString(),
    totals: emptyMetric(),
    routes: {}
  };
}

export class TrafficRecorder {
  private current: TrafficHourFile | null = null;
  private salt: string | null = null;
  private ready: Promise<void> | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: TrafficRecorderOptions) {}

  record(req: http.IncomingMessage, res: http.ServerResponse, startedAtNs: bigint): void {
    if (!this.options.enabled) return;
    const finishedAt = new Date();
    const durationMs = Math.max(0, Number(process.hrtime.bigint() - startedAtNs) / 1_000_000);
    const method = req.method || "UNKNOWN";
    const status = res.statusCode || 0;
    const bytes = Number(res.getHeader("Content-Length") || 0) || 0;
    const pathname = safePathname(req.url || "/");
    const route = routeGroup(pathname);
    const diagnosticPath = diagnosticStatus(status) ? diagnosticPathname(pathname) : null;

    this.queue = this.queue
      .then(async () => {
        await this.ensureReady();
        const client = this.clientIdentity(req, finishedAt);
        await this.recordInner(finishedAt, route, method, status, bytes, durationMs, client, diagnosticPath);
      })
      .catch((error) => {
        console.warn("traffic aggregate write failed", error instanceof Error ? error.message : String(error));
      });
  }

  async flush(): Promise<void> {
    if (!this.options.enabled) return;
    await this.queue;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.current) await this.writeCurrent();
  }

  private async ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        await mkdir(this.options.dir, { recursive: true, mode: 0o750 });
        if (this.options.clientMode === "daily_hash") {
          this.salt = await this.loadOrCreateSalt();
        }
      })();
    }
    await this.ready;
  }

  private async loadOrCreateSalt(): Promise<string> {
    const saltPath = join(this.options.dir, ".client_hash_salt");
    try {
      const existing = (await readFile(saltPath, "utf8")).trim();
      if (existing) return existing;
    } catch {
      // Create below.
    }
    const salt = randomBytes(32).toString("hex");
    await writeFile(saltPath, `${salt}\n`, { mode: 0o600 });
    await chmod(saltPath, 0o600).catch(() => undefined);
    return salt;
  }

  private clientIdentity(req: http.IncomingMessage, date: Date): ClientIdentity {
    if (this.options.clientMode !== "daily_hash") return { hash: null, source: "none" };
    const proxied = this.options.trustProxyHeaders ? proxyIp(req) : null;
    const ip = proxied || remoteIp(req);
    if (!ip || !this.salt) return { hash: null, source: ip ? (proxied ? "proxy" : "remote") : "none" };
    const hash = createHmac("sha256", this.salt)
      .update(`${dayIso(date)}\0${ip}`)
      .digest("hex")
      .slice(0, 24);
    return { hash, source: proxied ? "proxy" : "remote" };
  }

  private async recordInner(
    date: Date,
    route: string,
    method: string,
    status: number,
    bytes: number,
    durationMs: number,
    client: ClientIdentity,
    diagnosticPath: string | null
  ): Promise<void> {
    const hour = hourIso(date);
    if (!this.current || this.current.hour !== hour) {
      if (this.current) await this.writeCurrent();
      this.current = await this.loadHour(hour);
    }
    const routeMetric = this.current.routes[route] || emptyMetric();
    this.current.routes[route] = routeMetric;
    this.applyMetric(this.current.totals, method, status, bytes, durationMs, client);
    this.applyMetric(routeMetric, method, status, bytes, durationMs, client);
    if (diagnosticPath && this.options.diagnosticPathLimit > 0) {
      this.applyDiagnosticPath(diagnosticPath, method, status, bytes, durationMs, client);
    }
    this.current.updated_at = new Date().toISOString();
    this.scheduleFlush();
  }

  private applyMetric(metric: TrafficMetric, method: string, status: number, bytes: number, durationMs: number, client: ClientIdentity): void {
    metric.requests += 1;
    metric.bytes += bytes;
    metric.duration_ms += Math.round(durationMs);
    bump(metric.methods, method);
    bump(metric.statuses, String(status));
    bump(metric.latency_ms, latencyBucket(durationMs));
    bump(metric.client_sources, client.source);
    if (client.hash) {
      metric.clients ||= {};
      metric.clients[client.hash] = true;
    }
  }

  private applyDiagnosticPath(pathname: string, method: string, status: number, bytes: number, durationMs: number, client: ClientIdentity): void {
    if (!this.current) return;
    this.current.diagnostic_paths ||= {};
    let metric = this.current.diagnostic_paths[pathname];
    if (!metric) {
      const pathCount = Object.keys(this.current.diagnostic_paths).length;
      if (pathCount >= this.options.diagnosticPathLimit) {
        this.current.diagnostic_path_overflow ||= emptyMetric();
        this.applyMetric(this.current.diagnostic_path_overflow, method, status, bytes, durationMs, client);
        return;
      }
      metric = emptyMetric();
      this.current.diagnostic_paths[pathname] = metric;
    }
    this.applyMetric(metric, method, status, bytes, durationMs, client);
  }

  private async loadHour(hour: string): Promise<TrafficHourFile> {
    const file = join(this.options.dir, hourFileName(hour));
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as TrafficHourFile;
      if (parsed.schema === TRAFFIC_SCHEMA_VERSION && parsed.hour === hour) return parsed;
    } catch {
      // Start a fresh hour file below.
    }
    return createTrafficHour(hour);
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.options.flushDelayMs);
    this.flushTimer.unref?.();
  }

  private async writeCurrent(): Promise<void> {
    if (!this.current) return;
    await mkdir(this.options.dir, { recursive: true, mode: 0o750 });
    const file = join(this.options.dir, hourFileName(this.current.hour));
    const tmp = `${file}.tmp-${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(this.current, null, 2)}\n`, { mode: 0o640 });
    await rename(tmp, file);
  }
}

function latencyBucket(durationMs: number): string {
  for (const [label, limit] of latencyBuckets) {
    if (durationMs < limit) return label;
  }
  return "gte_10000";
}

function safePathname(rawUrl: string): string {
  try {
    return new URL(rawUrl, "http://local").pathname;
  } catch {
    return "/";
  }
}

function diagnosticStatus(status: number): boolean {
  return status === 404 || status === 405 || status >= 500;
}

function diagnosticPathname(pathname: string): string {
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
  if (normalized.length <= 240) return normalized;
  return `${normalized.slice(0, 237)}...`;
}

export function configuredTrafficRecorder(dataDir: string): TrafficRecorder | null {
  const enabled = process.env.VITALS_TRAFFIC_AGGREGATES === "1";
  if (!enabled) return null;
  const clientMode = process.env.VITALS_TRAFFIC_CLIENT_MODE === "daily_hash" ? "daily_hash" : "none";
  const diagnosticPathLimit = Number(process.env.VITALS_TRAFFIC_DIAGNOSTIC_PATH_LIMIT || 0);
  return new TrafficRecorder({
    enabled,
    dir: resolve(process.env.VITALS_TRAFFIC_DIR || join(dataDir, "traffic")),
    clientMode,
    trustProxyHeaders: process.env.VITALS_TRAFFIC_TRUST_PROXY_HEADERS === "1",
    flushDelayMs: Math.max(100, Number(process.env.VITALS_TRAFFIC_FLUSH_MS || 2_000)),
    diagnosticPathLimit: Math.max(0, Math.min(500, Number.isFinite(diagnosticPathLimit) ? diagnosticPathLimit : 0))
  });
}
