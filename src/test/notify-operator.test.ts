import assert from "node:assert/strict";
import test from "node:test";

import {
  detectOperatorAlerts,
  formatOperatorDigest,
  type OperatorSummary
} from "../scripts/notify-operator.js";

function healthySummary(overrides: Partial<OperatorSummary> = {}): OperatorSummary {
  const summary: OperatorSummary = {
    generated_at: "2026-06-16T21:00:00Z",
    periods: {
      last_hour_start_at: "2026-06-16T20:00:00Z",
      last_hour_end_at: "2026-06-16T21:00:00Z",
      last_24h_start_at: "2026-06-15T21:00:00Z",
      last_24h_end_at: "2026-06-16T21:00:00Z"
    },
    gateway: {
      latest_ok: true,
      latest_status_code: 200,
      latest_error: null,
      latest_snapshot_id: "vitals.2026-06-16T20:55:00Z",
      latest_snapshot_index: "101",
      latest_observed_at: "2026-06-16T20:55:00Z",
      latest_age_ms: 5 * 60_000,
      latest_source: "program",
      latest_fresh: true,
      readback_matches: true,
      conservation_status: "green",
      conservation_flags: [],
      conservation_largest_abs_delta_raw: "0",
      native_status: "native_ready",
      site_integrity_ok: true,
      site_integrity_status: "verified",
      site_integrity_error_count: 0
    },
    snapshots: {
      run_count: 101,
      confirmed_count: 101,
      failed_count: 0,
      last_hour: {
        run_count: 4,
        confirmed_count: 4,
        failed_count: 0,
        latest_snapshot_id: "vitals.2026-06-16T20:55:00Z",
        latest_snapshot_index: "101",
        latest_tx_hash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
      },
      last_24h: {
        run_count: 96,
        confirmed_count: 96,
        failed_count: 0,
        latest_snapshot_id: "vitals.2026-06-16T20:55:00Z",
        latest_snapshot_index: "101",
        latest_tx_hash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
      },
      latest_status: "confirmed",
      latest_generated_at: "2026-06-16T20:55:10Z",
      latest_age_ms: 5 * 60_000,
      latest_snapshot_id: "vitals.2026-06-16T20:55:00Z",
      latest_snapshot_index: "101",
      latest_tx_hash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      latest_readback_matches: true,
      median_cadence_minutes: 16,
      median_total_ms: 10_500
    },
    traffic: {
      hours: 24,
      total_requests_24h: 500,
      total_unique_daily_hashes_24h: 32,
      homepage_requests_24h: 80,
      homepage_unique_daily_hashes_24h: 20,
      api_latest_requests_24h: 100,
      diagnostic_requests_24h: 12,
      diagnostic_requests_current_hour: 0,
      last_hour: {
        requests: 25,
        unique_daily_hashes: 7,
        homepage_requests: 5,
        homepage_unique_daily_hashes: 4,
        api_latest_requests: 8,
        diagnostic_requests: 1,
        top_diagnostic_paths: [{ path: "/wp-login.php", requests: 1, unique_clients: 1 }]
      },
      last_24h: {
        requests: 500,
        unique_daily_hashes: 32,
        homepage_requests: 80,
        homepage_unique_daily_hashes: 20,
        api_latest_requests: 100,
        diagnostic_requests: 12,
        top_diagnostic_paths: [{ path: "/.env", requests: 6, unique_clients: 3 }]
      },
      top_diagnostic_paths_24h: [{ path: "/.env", requests: 6, unique_clients: 3 }]
    },
    archive: {
      evidence_files: 101,
      evidence_bytes: 100_000,
      evidence_files_last_hour: 4,
      evidence_bytes_last_hour: 4_000,
      evidence_files_24h: 96,
      evidence_bytes_24h: 96_000,
      raw_evidence_files: 505,
      raw_evidence_bytes: 25_000_000,
      raw_evidence_files_last_hour: 20,
      raw_evidence_bytes_last_hour: 1_000_000,
      raw_evidence_files_24h: 480,
      raw_evidence_bytes_24h: 24_000_000
    },
    disk: {
      path: "/var/lib/octra-vitals",
      used_percent: 20,
      available_kb: 10_000_000,
      error: null
    }
  };
  return { ...summary, ...overrides };
}

test("operator notifier reports no alerts for a healthy native deployment", () => {
  const alerts = detectOperatorAlerts(healthySummary(), {
    max_snapshot_age_ms: 45 * 60_000,
    disk_used_percent: 75,
    diagnostic_requests_current_hour: 300
  });
  assert.deepEqual(alerts, []);
});

test("operator notifier alerts on stale or non-program latest data", () => {
  const alerts = detectOperatorAlerts(healthySummary({
    gateway: {
      ...healthySummary().gateway,
      latest_ok: false,
      latest_source: "none",
      latest_age_ms: 60 * 60_000,
      latest_error: "/api/latest returned 503"
    }
  }), {
    max_snapshot_age_ms: 45 * 60_000,
    disk_used_percent: 75,
    diagnostic_requests_current_hour: 300
  });
  assert.equal(alerts.some((alert) => alert.id === "gateway_latest"), true);
  assert.equal(alerts.some((alert) => alert.id === "snapshot_stale_gateway"), true);
});

test("operator notifier does not page when gateway receipt readback is temporarily unavailable", () => {
  const alerts = detectOperatorAlerts(healthySummary({
    gateway: {
      ...healthySummary().gateway,
      latest_ok: true,
      readback_matches: null
    }
  }), {
    max_snapshot_age_ms: 45 * 60_000,
    disk_used_percent: 75,
    diagnostic_requests_current_hour: 300
  });
  assert.equal(alerts.some((alert) => alert.id === "gateway_latest"), false);
  assert.equal(alerts.some((alert) => alert.id === "gateway_latest_readback"), false);
});

test("operator notifier pages when gateway receipt readback explicitly mismatches", () => {
  const alerts = detectOperatorAlerts(healthySummary({
    gateway: {
      ...healthySummary().gateway,
      latest_ok: true,
      readback_matches: false
    }
  }), {
    max_snapshot_age_ms: 45 * 60_000,
    disk_used_percent: 75,
    diagnostic_requests_current_hour: 300
  });
  assert.equal(alerts.some((alert) => alert.id === "gateway_latest"), false);
  assert.equal(alerts.some((alert) => alert.id === "gateway_latest_readback"), true);
});

test("operator notifier warns on yellow signed conservation", () => {
  const alerts = detectOperatorAlerts(healthySummary({
    gateway: {
      ...healthySummary().gateway,
      conservation_status: "yellow",
      conservation_flags: ["future_reconciliation_review"],
      conservation_largest_abs_delta_raw: "127010820000"
    }
  }), {
    max_snapshot_age_ms: 45 * 60_000,
    disk_used_percent: 75,
    diagnostic_requests_current_hour: 300
  });
  assert.equal(alerts.some((alert) => alert.id === "conservation_yellow" && alert.severity === "warn"), true);
  assert.equal(alerts.some((alert) => alert.id === "conservation_red"), false);
});

test("operator notifier pages on red signed conservation", () => {
  const alerts = detectOperatorAlerts(healthySummary({
    gateway: {
      ...healthySummary().gateway,
      conservation_status: "red",
      conservation_flags: ["bridge_claims_exceed_locked"],
      conservation_largest_abs_delta_raw: "1"
    }
  }), {
    max_snapshot_age_ms: 45 * 60_000,
    disk_used_percent: 75,
    diagnostic_requests_current_hour: 300
  });
  assert.equal(alerts.some((alert) => alert.id === "conservation_red" && alert.severity === "critical"), true);
});

test("operator notifier treats Circle RPC site proof failures as availability warnings", () => {
  const alerts = detectOperatorAlerts(healthySummary({
    gateway: {
      ...healthySummary().gateway,
      native_status: "program_pending_verification",
      site_integrity_ok: false,
      site_integrity_status: "circle_unavailable",
      site_integrity_error_count: 7
    }
  }), {
    max_snapshot_age_ms: 45 * 60_000,
    disk_used_percent: 75,
    diagnostic_requests_current_hour: 300
  });
  assert.equal(alerts.some((alert) => alert.id === "site_integrity_unavailable" && alert.severity === "warn"), true);
  assert.equal(alerts.some((alert) => alert.id === "site_integrity"), false);
  assert.equal(alerts.some((alert) => alert.id === "native_readiness"), false);
});

test("operator digest is compact and uses aggregate traffic, not raw client details", () => {
  const digest = formatOperatorDigest(healthySummary(), []);
  assert.match(digest, /<b>Octra Vitals digest<\/b> <code>OK<\/code>/);
  assert.match(digest, /<b>Last hour<\/b> <code>20:00-21:00 UTC<\/code>/);
  assert.match(digest, /Web: <b>25<\/b> req, <b>7<\/b> unique daily hashes/);
  assert.match(digest, /Home: 5 req, 4 unique \| API latest: 8/);
  assert.match(digest, /<b>24h topline<\/b> <code>Jun 15 21:00-Jun 16 21:00 UTC<\/code>/);
  assert.match(digest, /Web: 500 req, 32 unique daily hashes/);
  assert.match(digest, /Home: 80 req, 20 unique \| API latest: 100/);
  assert.match(digest, /Archive: 505 raw files/);
  assert.equal(digest.includes("203.0.113."), false);
});
