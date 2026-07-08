import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface OctraSqliteConfig {
  enabled: boolean;
  reason: string | null;
  bin: string;
  configPath: string | null;
  database: string | null;
  databaseUri: string | null;
  network: string;
}

export interface OctraSqliteResult {
  codec?: string;
  columns: string[];
  ok: boolean;
  row_count: number;
  rows: unknown[][];
}

interface OctraSqliteWriteReceipt {
  ok?: boolean;
  type?: string;
  status?: string;
  writes?: Array<{ status?: string }>;
  receipt?: {
    success?: boolean;
    error?: unknown;
  };
  result?: {
    status?: string;
    tx_hash?: string;
  };
  tx_hash?: string;
}

export interface OctraSqliteQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  ok: boolean;
  proof?: OctraSqliteQueryProof;
}

export interface OctraSqliteQueryProof {
  schema: "octra-vitals-lab-query-proof-v0";
  mode: "circle_sqlite_view";
  transport: "octra-sqlite";
  database_uri: string | null;
  circle_id: string | null;
  network: string;
  rpc_url: string | null;
  jsonrpc_method: "octra_circleViewAuth";
  circle_method: "query_typed";
  normalized_sql: string;
  normalized_sql_sha256: string;
  normalized_limit: number;
  params_shape: string[];
}

const DEFAULT_BIN = "/opt/octra-sqlite/bin/octra-sqlite";
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

function envValue(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  return value && value.trim() ? value.trim() : null;
}

function networkFromUri(uri: string | null): string | null {
  if (!uri) return null;
  const match = uri.match(/^oct:\/\/([^/]+)\//);
  return match?.[1] || null;
}

function circleIdFromUri(uri: string | null): string | null {
  if (!uri) return null;
  const match = uri.match(/^oct:\/\/[^/]+\/([^/?#]+)/);
  return match?.[1] || null;
}

function sha256Prefixed(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function configuredRpcUrl(config: OctraSqliteConfig): Promise<string | null> {
  const envRpc = envValue(process.env, "OCTRA_RPC_URL") || envValue(process.env, "VITALS_LAB_HISTORY_RPC");
  if (envRpc) return envRpc;
  if (config.configPath) {
    try {
      const parsed = JSON.parse(await readFile(config.configPath, "utf8")) as Record<string, any>;
      const networkRpc = parsed?.networks?.[config.network]?.rpc;
      if (typeof networkRpc === "string" && networkRpc.trim()) return networkRpc.trim();
      if (typeof parsed.rpc === "string" && parsed.rpc.trim()) return parsed.rpc.trim();
    } catch {
      // The query still works through octra-sqlite; proof just omits the configured RPC URL.
    }
  }
  if (config.network === "devnet") return "https://devnet.octrascan.io/rpc";
  if (config.network === "mainnet") return "https://octra.network/rpc";
  return null;
}

export function octraSqliteConfig(env = process.env): OctraSqliteConfig {
  const databaseUri = envValue(env, "VITALS_LAB_HISTORY_DATABASE_URI");
  const configuredDatabase = envValue(env, "VITALS_LAB_HISTORY_DATABASE");
  const database = databaseUri || configuredDatabase;
  const databaseNetwork = networkFromUri(database);
  const configuredNetwork = envValue(env, "VITALS_LAB_HISTORY_NETWORK");
  const network = databaseNetwork || configuredNetwork || "devnet";
  const enabled = env.VITALS_LAB_HISTORY_ENABLED === "1";
  let reason: string | null = null;
  if (!enabled) reason = "lab_history_disabled";
  else if (!database) reason = "lab_history_database_unconfigured";
  else if (!databaseNetwork) reason = "lab_history_database_uri_required";
  else if (configuredNetwork && configuredNetwork !== databaseNetwork) reason = "lab_history_network_mismatch";
  else if (network === "mainnet" && env.VITALS_LAB_HISTORY_ALLOW_MAINNET !== "1") reason = "lab_history_mainnet_requires_explicit_enable";
  else if (!["devnet", "mainnet"].includes(network)) reason = "lab_history_network_unsupported";
  return {
    enabled: enabled && !reason,
    reason,
    bin: envValue(env, "VITALS_LAB_HISTORY_OCTRA_SQLITE_BIN") || DEFAULT_BIN,
    configPath: envValue(env, "OCTRA_SQLITE_CONFIG"),
    database,
    databaseUri,
    network
  };
}

export function sqlString(value: unknown): string {
  if (value === null || value === undefined) return "null";
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function sqlNumber(value: unknown): string {
  if (value === null || value === undefined || value === "") return "null";
  const number = Number(value);
  return Number.isFinite(number) ? String(Math.trunc(number)) : "null";
}

export function sqlJson(value: unknown): string {
  return sqlString(JSON.stringify(value ?? null));
}

function timeoutMs(): number {
  const configured = Number(process.env.VITALS_LAB_HISTORY_SQL_TIMEOUT_MS || 20_000);
  return Number.isFinite(configured) && configured > 0 ? configured : 20_000;
}

function maxBufferBytes(): number {
  const configured = Number(process.env.VITALS_LAB_HISTORY_SQL_MAX_BUFFER_BYTES || 4_000_000);
  return Number.isFinite(configured) && configured > 0 ? configured : 4_000_000;
}

function emptyOctraSqliteResult(): OctraSqliteResult {
  return {
    columns: [],
    ok: true,
    row_count: 0,
    rows: []
  };
}

function normalizeOctraSqliteQuery(parsed: Record<string, unknown>): OctraSqliteResult | null {
  if (!Array.isArray(parsed.columns) || !Array.isArray(parsed.rows)) return null;
  return {
    ...parsed,
    columns: parsed.columns.map(String),
    ok: true,
    row_count: typeof parsed.row_count === "number" ? parsed.row_count : parsed.rows.length,
    rows: parsed.rows as unknown[][]
  };
}

function successfulOctraSqliteWrite(parsed: OctraSqliteWriteReceipt): boolean {
  if (parsed.ok === false) return false;
  if (parsed.receipt?.success === true) return true;

  const status = parsed.status || parsed.result?.status;
  if (status && ["accepted", "confirmed", "submitted"].includes(status)) return true;

  if ((parsed.type === "write" || parsed.type === "exec" || parsed.type === "write_script") && parsed.ok === true) {
    return parsed.receipt?.success !== false && status !== "rejected";
  }

  if (parsed.type === "restore" && parsed.ok === true) {
    return !parsed.writes?.some((write) => write.status === "rejected");
  }

  return false;
}

export function parseOctraSqliteOutput(stdout: string): OctraSqliteResult {
  const parsed = JSON.parse(stdout) as Record<string, unknown> & OctraSqliteWriteReceipt;
  if (parsed.ok === false) {
    throw new Error(`octra_sqlite_not_ok: ${stdout.slice(0, 1000)}`);
  }

  const query = normalizeOctraSqliteQuery(parsed);
  if (query) return query;

  if (successfulOctraSqliteWrite(parsed)) return emptyOctraSqliteResult();

  throw new Error(`octra_sqlite_result_shape_invalid: ${stdout.slice(0, 1000)}`);
}

export async function octraSqliteOpen(sql: string, config = octraSqliteConfig()): Promise<OctraSqliteResult> {
  if (!config.enabled || !config.database) {
    throw new Error(config.reason || "lab_history_unavailable");
  }
  const env = { ...process.env };
  if (config.configPath) env.OCTRA_SQLITE_CONFIG = config.configPath;
  const args = ["open", "--json", config.database, sql];
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(config.bin, args, {
      env,
      timeout: timeoutMs(),
      maxBuffer: maxBufferBytes()
    }, (error, out, err) => {
      if (error) {
        const detail = String(err || out || error.message || "octra_sqlite_failed").trim();
        reject(new Error(detail || "octra_sqlite_failed"));
        return;
      }
      resolve(out);
    });
  });
  return parseOctraSqliteOutput(stdout);
}

export function rowsAsObjects(result: OctraSqliteResult): OctraSqliteQueryResult {
  const rows = result.rows.map((row) => {
    const out: Record<string, unknown> = {};
    result.columns.forEach((column, index) => {
      out[column] = row[index];
    });
    return out;
  });
  return {
    columns: result.columns,
    rows,
    row_count: rows.length,
    ok: result.ok
  };
}

function requestedLimit(limit: unknown): number {
  const parsed = Number(limit || DEFAULT_LIMIT);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

const unsafeSqlFunctions = /\b(load_extension|readfile|writefile|fileio_[a-z0-9_]*|fsdir|lsmode|pragma[_a-z0-9]*)\s*\(/i;
const expensiveSqlFunctions = /\b(zeroblob|randomblob)\s*\(/i;
const publicLabQueryMessages: Record<string, string> = {
  sql_required: "Enter a read-only SQL query.",
  only_one_read_only_statement_allowed: "Only one read-only SQL statement is allowed.",
  sql_comments_not_allowed: "SQL comments are not allowed in public Lab queries.",
  only_select_queries_allowed: "Only SELECT or WITH queries are allowed.",
  only_read_only_queries_allowed: "Only read-only queries are allowed.",
  recursive_sql_not_allowed: "Recursive queries are not available in public Lab queries.",
  unsafe_sql_function_not_allowed: "SQLite extension, pragma, and file access functions are not available in public Lab queries.",
  expensive_sql_function_not_allowed: "Expensive SQLite blob functions are not available in public Lab queries."
};

export function publicLabQueryError(error: unknown): { error: string; message: string } | null {
  const code = error instanceof Error ? error.message : String(error);
  const message = publicLabQueryMessages[code];
  return message ? { error: code, message } : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function skipWhitespace(sql: string, index: number): number {
  while (index < sql.length && /\s/.test(sql[index] || "")) index += 1;
  return index;
}

function readIdentifier(sql: string, index: number): { name: string; next: number } | null {
  const char = sql[index];
  if (!char) return null;
  const quotePairs: Record<string, string> = {
    "\"": "\"",
    "'": "'",
    "`": "`",
    "[": "]"
  };
  const close = quotePairs[char];
  if (close) {
    let name = "";
    for (let cursor = index + 1; cursor < sql.length; cursor += 1) {
      const current = sql[cursor];
      if (current === close) {
        if (sql[cursor + 1] === close && close !== "]") {
          name += close;
          cursor += 1;
          continue;
        }
        return name ? { name: name.toLowerCase(), next: cursor + 1 } : null;
      }
      name += current;
    }
    return null;
  }
  const match = /^[a-z_][a-z0-9_]*/i.exec(sql.slice(index));
  if (!match) return null;
  return { name: match[0].toLowerCase(), next: index + match[0].length };
}

function matchingParenIndex(sql: string, openIndex: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = openIndex; index < sql.length; index += 1) {
    const char = sql[index];
    if (quote) {
      if (char === quote) {
        if (sql[index + 1] === quote) {
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

interface CteDefinition {
  name: string;
  body: string;
}

function readCteDefinitions(sql: string, withIndex: number): CteDefinition[] {
  const definitions: CteDefinition[] = [];
  let cursor = skipWhitespace(sql, withIndex + 4);
  if (/^recursive\b/i.test(sql.slice(cursor))) {
    cursor = skipWhitespace(sql, cursor + "recursive".length);
  }
  while (cursor < sql.length) {
    cursor = skipWhitespace(sql, cursor);
    const identifier = readIdentifier(sql, cursor);
    if (!identifier) break;
    cursor = skipWhitespace(sql, identifier.next);
    if (sql[cursor] === "(") {
      const columnClose = matchingParenIndex(sql, cursor);
      if (columnClose <= cursor) break;
      cursor = skipWhitespace(sql, columnClose + 1);
    }
    if (!/^as\b/i.test(sql.slice(cursor))) break;
    cursor = skipWhitespace(sql, cursor + 2);
    if (sql[cursor] !== "(") break;
    const openIndex = cursor;
    const closeIndex = matchingParenIndex(sql, openIndex);
    if (closeIndex <= openIndex) break;
    const body = sql.slice(openIndex + 1, closeIndex);
    definitions.push({ name: identifier.name, body });
    cursor = skipWhitespace(sql, closeIndex + 1);
    if (sql[cursor] !== ",") break;
    cursor += 1;
  }
  return definitions;
}

function referencesCteName(sql: string, name: string): boolean {
  const escaped = escapeRegExp(name);
  const identifier = `(?:"${escaped}"|'${escaped}'|\`${escaped}\`|\\[${escaped}\\]|${escaped}\\b)`;
  const reference = new RegExp(`(?:\\b(?:from|join)\\s+|,\\s*)${identifier}(?=\\s|,|\\)|$)`, "i");
  return reference.test(sql);
}

function hasDependencyCycle(graph: Map<string, Set<string>>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string): boolean => {
    if (visiting.has(name)) return true;
    if (visited.has(name)) return false;
    visiting.add(name);
    for (const dependency of graph.get(name) || []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(name);
    visited.add(name);
    return false;
  };
  return Array.from(graph.keys()).some((name) => visit(name));
}

function containsRecursiveCte(sql: string): boolean {
  const withBlocks = Array.from(sql.matchAll(/\bwith\b/ig));
  for (const withBlock of withBlocks) {
    if (withBlock.index === undefined) continue;
    const definitions = readCteDefinitions(sql, withBlock.index);
    if (definitions.length === 0) continue;
    const names = new Set(definitions.map((definition) => definition.name));
    const graph = new Map<string, Set<string>>();
    for (const definition of definitions) {
      const dependencies = new Set<string>();
      for (const name of names) {
        if (referencesCteName(definition.body, name)) dependencies.add(name);
      }
      graph.set(definition.name, dependencies);
    }
    if (hasDependencyCycle(graph)) return true;
  }
  return false;
}

export function normalizeReadOnlySql(sql: string, limit?: unknown): { sql: string; limit: number } {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  const cappedLimit = requestedLimit(limit);
  if (!trimmed) throw new Error("sql_required");
  if (trimmed.includes(";")) throw new Error("only_one_read_only_statement_allowed");
  if (/\/\*|--/.test(trimmed)) throw new Error("sql_comments_not_allowed");
  if (!/^(select|with)\b/i.test(trimmed)) throw new Error("only_select_queries_allowed");
  if (/\bwith\s+recursive\b/i.test(trimmed) || containsRecursiveCte(trimmed)) throw new Error("recursive_sql_not_allowed");
  if (/\b(insert|update|delete|drop|alter|create|replace|attach|detach|vacuum|reindex|pragma|begin|commit|rollback)\b/i.test(trimmed)) {
    throw new Error("only_read_only_queries_allowed");
  }
  if (unsafeSqlFunctions.test(trimmed)) throw new Error("unsafe_sql_function_not_allowed");
  if (expensiveSqlFunctions.test(trimmed)) throw new Error("expensive_sql_function_not_allowed");
  return {
    sql: `select * from (${trimmed}) limit ${cappedLimit}`,
    limit: cappedLimit
  };
}

export async function octraSqliteQueryProof(
  normalized: { sql: string; limit: number },
  config = octraSqliteConfig()
): Promise<OctraSqliteQueryProof> {
  return {
    schema: "octra-vitals-lab-query-proof-v0",
    mode: "circle_sqlite_view",
    transport: "octra-sqlite",
    database_uri: config.databaseUri || config.database,
    circle_id: circleIdFromUri(config.databaseUri || config.database),
    network: config.network,
    rpc_url: await configuredRpcUrl(config),
    jsonrpc_method: "octra_circleViewAuth",
    circle_method: "query_typed",
    normalized_sql: normalized.sql,
    normalized_sql_sha256: sha256Prefixed(normalized.sql),
    normalized_limit: normalized.limit,
    params_shape: [
      "circle_id",
      "query_typed",
      "[normalized_sql]",
      "caller",
      "public_key_b64",
      "view_signature",
      "false"
    ]
  };
}

export async function octraSqliteReadOnlyQuery(sql: string, limit?: unknown): Promise<OctraSqliteQueryResult> {
  const normalized = normalizeReadOnlySql(sql, limit);
  const config = octraSqliteConfig();
  return {
    ...rowsAsObjects(await octraSqliteOpen(normalized.sql, config)),
    proof: await octraSqliteQueryProof(normalized, config)
  };
}
