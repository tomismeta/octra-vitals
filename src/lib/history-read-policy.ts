import { HistoryTailAnchorError } from "./canonical-history.js";

export interface SqliteFallbackDecision {
  allowed: boolean;
  code: string;
  reason: string;
}

const SQLITE_UNAVAILABLE_PATTERNS = [
  /\bsqlite_history_replica_unavailable\b/i,
  /\blab_history_unavailable\b/i,
  /\boctra_sqlite_failed\b/i,
  /\bspawn\b.*\bENOENT\b/i,
  /\bENOENT\b/i,
  /\bEACCES\b/i,
  /\bETIMEDOUT\b/i,
  /\bECONN(?:RESET|REFUSED|ABORTED)\b/i,
  /\bENOTFOUND\b/i,
  /\bEAI_AGAIN\b/i,
  /\btimeout\b/i,
  /\btimed out\b/i,
  /\btemporarily unavailable\b/i,
  /\bHTTP\s*429\b/i,
  /\b429\b.*\b(?:rate|too many requests)\b/i,
  /\btoo many requests\b/i,
  /\brate[-_ ]?limit/i,
  /\bHTTP\s*5\d\d\b/i,
  /\bwasm export trapped\b/i,
  /\ball fuel consumed\b/i,
  /\bresource exhausted\b/i
];

const SQLITE_TRUST_FAILURE_PATTERNS = [
  /\bsqlite_history_empty\b/i,
  /\bsqlite_history_incomplete\b/i,
  /\bsqlite_history_gap\b/i,
  /\bsqlite_history_index_gap\b/i,
  /\boctra_sqlite_result_shape_invalid\b/i,
  /\btoo_many_rows\b/i,
  /\bquery row limit\b/i
];

export function sqliteHistoryFallbackDecision(error: unknown): SqliteFallbackDecision {
  if (error instanceof HistoryTailAnchorError) {
    return {
      allowed: false,
      code: error.code,
      reason: "sqlite_history_anchor_not_verified"
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  if (SQLITE_TRUST_FAILURE_PATTERNS.some((pattern) => pattern.test(message))) {
    return {
      allowed: false,
      code: sqliteFallbackCodeFromMessage(message),
      reason: "sqlite_history_reachable_but_not_trusted"
    };
  }

  if (SQLITE_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(message))) {
    return {
      allowed: true,
      code: sqliteFallbackCodeFromMessage(message),
      reason: "sqlite_history_unavailable"
    };
  }

  return {
    allowed: false,
    code: sqliteFallbackCodeFromMessage(message),
    reason: "sqlite_history_failure_not_classified_unavailable"
  };
}

function sqliteFallbackCodeFromMessage(message: string): string {
  const match = message.match(/\b([a-z][a-z0-9_]+)\b/i);
  return match?.[1] || "sqlite_history_error";
}
