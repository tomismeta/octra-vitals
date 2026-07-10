import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { configuredTrafficRecorder, TrafficRecorder, routeGroup } from "../lib/traffic.js";

test("routeGroup avoids query strings and high-cardinality evidence hashes", () => {
  assert.equal(routeGroup("/"), "/");
  assert.equal(routeGroup("/index.html"), "/");
  assert.equal(routeGroup("/api/latest"), "/api/latest");
  assert.equal(routeGroup("/api/evidence/raw/abcdef"), "/api/evidence/raw/:hash");
  assert.equal(routeGroup("/lab/history"), "/lab/history");
  assert.equal(routeGroup("/api/lab/query"), "/api/lab/query");
  assert.equal(routeGroup("/lab-history.js"), "lab_assets");
  assert.equal(routeGroup("/favicon.svg"), "static_assets");
  assert.equal(routeGroup("/strange/path"), "other");
});

test("traffic resource bounds reject malformed configuration", () => {
  const previousEnabled = process.env.VITALS_TRAFFIC_AGGREGATES;
  const previousQueue = process.env.VITALS_TRAFFIC_QUEUE_LIMIT;
  try {
    process.env.VITALS_TRAFFIC_AGGREGATES = "1";
    process.env.VITALS_TRAFFIC_QUEUE_LIMIT = "not-a-number";
    assert.throws(() => configuredTrafficRecorder("/tmp"), /VITALS_TRAFFIC_QUEUE_LIMIT/);
  } finally {
    if (previousEnabled === undefined) delete process.env.VITALS_TRAFFIC_AGGREGATES;
    else process.env.VITALS_TRAFFIC_AGGREGATES = previousEnabled;
    if (previousQueue === undefined) delete process.env.VITALS_TRAFFIC_QUEUE_LIMIT;
    else process.env.VITALS_TRAFFIC_QUEUE_LIMIT = previousQueue;
  }
});

test("traffic recorder stores daily client hashes, not raw IPs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octra-vitals-traffic-"));
  try {
    const recorder = new TrafficRecorder({
      enabled: true,
      dir,
      clientMode: "daily_hash",
      trustedProxyAddresses: ["127.0.0.1"],
      clientIpHeader: "x-forwarded-for",
      flushDelayMs: 100,
      diagnosticPathLimit: 0,
      clientCardinalityLimit: 100,
      queueLimit: 100
    });
    const req = new EventEmitter() as any;
    req.method = "GET";
    req.url = "/api/latest?ignored=true";
    req.headers = { "x-forwarded-for": "203.0.113.9" };
    req.socket = { remoteAddress: "127.0.0.1" };
    const res = new EventEmitter() as any;
    res.statusCode = 200;
    res.getHeader = (name: string) => name.toLowerCase() === "content-length" ? "123" : undefined;

    recorder.record(req, res, process.hrtime.bigint() - 1_000_000n);
    await recorder.flush();

    const files = (await import("node:fs/promises")).readdir(dir);
    const hourFile = (await files).find((file) => file.endsWith(".json"));
    assert.ok(hourFile);
    assert.equal((await stat(join(dir, hourFile))).mode & 0o777, 0o640);
    assert.equal((await stat(join(dir, ".client_hash_salt"))).mode & 0o777, 0o600);
    const text = await readFile(join(dir, hourFile), "utf8");
    assert.equal(text.includes("203.0.113.9"), false);
    const parsed = JSON.parse(text);
    assert.equal(parsed.routes["/api/latest"].requests, 1);
    assert.equal(Object.keys(parsed.routes["/api/latest"].clients).length, 1);
    assert.equal(parsed.routes["/api/latest"].client_sources.proxy, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("traffic recorder stores bounded diagnostic paths without queries or raw IPs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octra-vitals-traffic-"));
  try {
    const recorder = new TrafficRecorder({
      enabled: true,
      dir,
      clientMode: "daily_hash",
      trustedProxyAddresses: ["127.0.0.1"],
      clientIpHeader: "x-forwarded-for",
      flushDelayMs: 100,
      diagnosticPathLimit: 2,
      clientCardinalityLimit: 100,
      queueLimit: 100
    });

    const record = (url: string, statusCode: number) => {
      const req = new EventEmitter() as any;
      req.method = "GET";
      req.url = url;
      req.headers = { "x-forwarded-for": "203.0.113.10" };
      req.socket = { remoteAddress: "127.0.0.1" };
      const res = new EventEmitter() as any;
      res.statusCode = statusCode;
      res.getHeader = () => undefined;
      recorder.record(req, res, process.hrtime.bigint() - 1_000_000n);
    };

    record("/.env?token=secret", 404);
    record("/wp-admin?x=1", 404);
    record("/third-path", 404);
    record("/api/latest?ok=true", 200);
    await recorder.flush();

    const files = (await import("node:fs/promises")).readdir(dir);
    const hourFile = (await files).find((file) => file.endsWith(".json"));
    assert.ok(hourFile);
    const text = await readFile(join(dir, hourFile), "utf8");
    assert.equal(text.includes("203.0.113.10"), false);
    assert.equal(text.includes("token=secret"), false);
    assert.equal(text.includes("?"), false);
    const parsed = JSON.parse(text);
    assert.equal(parsed.diagnostic_paths["/.env"].requests, 1);
    assert.equal(parsed.diagnostic_paths["/wp-admin"].requests, 1);
    assert.equal(parsed.diagnostic_paths["/api/latest"], undefined);
    assert.equal(parsed.diagnostic_paths["/third-path"], undefined);
    assert.equal(parsed.diagnostic_path_overflow.requests, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
