export function observationTimeMs(value: string, label = "observed_at"): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
    throw new Error(`${label} must be an RFC3339 UTC timestamp at whole-second precision`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().replace(".000Z", "Z") !== value) {
    throw new Error(`${label} is not a real UTC calendar timestamp`);
  }
  return parsed;
}

export function assertObservationTimeSafe(
  observedAt: string,
  options: { nowMs?: number; maxFutureSkewMs?: number; previousObservedAt?: string | null } = {}
): void {
  const observedMs = observationTimeMs(observedAt);
  const nowMs = options.nowMs ?? Date.now();
  const maxFutureSkewMs = options.maxFutureSkewMs ?? 5 * 60_000;
  if (!Number.isSafeInteger(maxFutureSkewMs) || maxFutureSkewMs < 0) {
    throw new Error("max future observation skew must be a non-negative integer");
  }
  if (observedMs > nowMs + maxFutureSkewMs) {
    throw new Error(`observed_at is more than ${maxFutureSkewMs}ms in the future`);
  }
  if (options.previousObservedAt) {
    const previousMs = observationTimeMs(options.previousObservedAt, "previous observed_at");
    if (observedMs <= previousMs) throw new Error("observed_at must strictly advance");
  }
}

export function configuredObservationFutureSkewMs(): number {
  const value = Number(process.env.VITALS_MAX_OBSERVATION_FUTURE_SKEW_MS || 5 * 60_000);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("VITALS_MAX_OBSERVATION_FUTURE_SKEW_MS must be a non-negative integer");
  }
  return value;
}
