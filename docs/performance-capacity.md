# Performance and Capacity

Vitals should stay Octra-native without making every read expensive.

This hardening pass changes only read paths, retention, diagnostics, and the optional Lab mirror. It does not change AML state, AML row shape, or snapshot semantics.

## What Is Optimized

- `/api/history` keeps verified history in memory by window.
- Long windows can serve a verified stale value while a background refresh updates the cache.
- `/api/latest` schedules low-priority history prewarm after successful program-backed reads.
- JSON and text responses gzip when the browser or client accepts compression.
- The UI requests compact history JSON and samples sparkline hover hit targets.
- Octra RPC calls share one small concurrency budget.
- The Lab mirror reads only the gap after its completion watermark.
- New raw evidence bodies are stored gzip-compressed on disk.
- Operator alerts include a 365-day raw-evidence growth projection.
- `/api/performance` and `npm run perf:probe` expose low-impact timing and cache checks.

## What Is Not Changed

- No AML program changes.
- No additional Circle writes for user traffic.
- No gateway-local fallback truth.
- No public cache that can replace program-backed data.
- No Lab dependency in the core snapshot updater.

## Useful Knobs

```text
VITALS_HISTORY_READ_TTL_MS=3600000
VITALS_HISTORY_STALE_WHILE_REFRESH_MS=21600000
VITALS_HISTORY_API_STALE_WINDOWS=7d,30d
VITALS_HISTORY_PREWARM_ENABLED=1
VITALS_HISTORY_PREWARM_MIN_INTERVAL_MS=900000
VITALS_HISTORY_PREWARM_WINDOWS=1h,1d,7d,30d
VITALS_HISTORY_INTEGRITY_CAPSULE_LIMIT=3
VITALS_RESPONSE_GZIP_ENABLED=1
VITALS_RAW_EVIDENCE_COMPRESS=1
OCTRA_RPC_MAX_CONCURRENT=6
OCTRA_RPC_MIN_START_GAP_MS=50
VITALS_LAB_HISTORY_MAX_SEALED_CAPSULES=64
```

## Probe

Run from a host or workstation:

```bash
npm run perf:probe -- --url https://octra.live --out reports/perf-mainnet.json
```

The report records status, elapsed time, decoded body size, content type, and response encoding for:

- `/health`
- `/api/latest`
- `/api/history` for `1h`, `1d`, `7d`, and `30d`
- `/api/performance`

The probe is sequential by design. It should measure the site, not become load.

## Main Constraint

The expensive surface is long-horizon AML history reads. The current answer is verified cache plus stale-while-refresh, not weaker truth. Future AML getter changes remain a separate gated design decision.
