import { createHmac, randomBytes } from "node:crypto";
import type http from "node:http";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { trustedClientIdentity } from "./gateway-policy.js";

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
  client_overflow?: number;
}

export interface TrafficHourFile {
  schema: typeof TRAFFIC_SCHEMA_VERSION;
  hour: string;
  updated_at: string;
  totals: TrafficMetric;
  routes: Record<string, TrafficMetric>;
  diagnostic_paths?: Record<string, TrafficMetric>;
  diagnostic_path_overflow?: TrafficMetric;
  dropped_records?: number;
}

interface TrafficRecorderOptions {
  enabled: boolean;
  dir: string;
  clientMode: "none" | "daily_hash";
  trustedProxyAddresses: string[];
  clientIpHeader: string;
  flushDelayMs: number;
  diagnosticPathLimit: number;
  clientCardinalityLimit: number;
  queueLimit: number;
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
  if (pathname === "/lab/history") return "/lab/history";
  if (pathname === "/api/lab/status") return "/api/lab/status";
  if (pathname === "/api/lab/tables") return "/api/lab/tables";
  if (pathname === "/api/lab/schema") return "/api/lab/schema";
  if (pathname === "/api/lab/history") return "/api/lab/history";
  if (pathname === "/api/lab/query") return "/api/lab/query";
  if (pathname === "/api/lab/mirror/sync") return "/api/lab/mirror/sync";
  if (pathname.startsWith("/api/evidence/raw/")) return "/api/evidence/raw/:hash";
  if (pathname.startsWith("/api/evidence/")) return "/api/evidence/:hash";
  if (pathname.startsWith("/lab-history.")) return "lab_assets";
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
  private pendingRecords = 0;
  private droppedRecords = 0;

  constructor(private readonly options: TrafficRecorderOptions) {}

  record(req: http.IncomingMessage, res: http.ServerResponse, startedAtNs: bigint): void {
    if (!this.options.enabled) return;
    if (this.pendingRecords >= this.options.queueLimit) {
      this.droppedRecords += 1;
      return;
    }
    this.pendingRecords += 1;
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
      })
      .finally(() => {
        this.pendingRecords = Math.max(0, this.pendingRecords - 1);
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
        await chmod(this.options.dir, 0o750);
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
    const identity = trustedClientIdentity(req, {
      trustedProxyAddresses: this.options.trustedProxyAddresses,
      clientIpHeader: this.options.clientIpHeader
    });
    const ip = identity.ip;
    if (!ip || !this.salt) return { hash: null, source: identity.source };
    const hash = createHmac("sha256", this.salt)
      .update(`${dayIso(date)}\0${ip}`)
      .digest("hex")
      .slice(0, 24);
    return { hash, source: identity.source };
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
    this.current.dropped_records = this.droppedRecords;
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
      if (metric.clients[client.hash] || Object.keys(metric.clients).length < this.options.clientCardinalityLimit) {
        metric.clients[client.hash] = true;
      } else {
        metric.client_overflow = (metric.client_overflow || 0) + 1;
      }
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
    await chmod(tmp, 0o640);
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

function boundedIntegerEnv(name: string, fallback: number, min: number, max: number): number {
  const configured = process.env[name];
  const parsed = configured !== undefined && configured !== "" ? Number(configured) : fallback;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

export function configuredTrafficRecorder(dataDir: string): TrafficRecorder | null {
  const enabled = process.env.VITALS_TRAFFIC_AGGREGATES === "1";
  if (!enabled) return null;
  const clientMode = process.env.VITALS_TRAFFIC_CLIENT_MODE === "daily_hash" ? "daily_hash" : "none";
  const diagnosticPathLimit = boundedIntegerEnv("VITALS_TRAFFIC_DIAGNOSTIC_PATH_LIMIT", 0, 0, 500);
  const trustedProxyAddresses = (process.env.VITALS_TRUSTED_PROXY_ADDRESSES || "127.0.0.1,::1")
    .split(",").map((value) => value.trim()).filter(Boolean);
  return new TrafficRecorder({
    enabled,
    dir: resolve(process.env.VITALS_TRAFFIC_DIR || join(dataDir, "traffic")),
    clientMode,
    trustedProxyAddresses: process.env.VITALS_TRAFFIC_TRUST_PROXY_HEADERS === "1" ? trustedProxyAddresses : [],
    clientIpHeader: process.env.VITALS_PROXY_CLIENT_IP_HEADER || "x-forwarded-for",
    flushDelayMs: boundedIntegerEnv("VITALS_TRAFFIC_FLUSH_MS", 2_000, 100, 60_000),
    diagnosticPathLimit,
    clientCardinalityLimit: boundedIntegerEnv("VITALS_TRAFFIC_CLIENT_CARDINALITY_LIMIT", 10_000, 1, 100_000),
    queueLimit: boundedIntegerEnv("VITALS_TRAFFIC_QUEUE_LIMIT", 5_000, 1, 100_000)
  });
}
