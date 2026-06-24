export type VitalsManifest = Record<string, any>;

export interface VitalsManifestRuntimeOptions {
  env?: Record<string, string | undefined>;
  siteCircleId?: string;
  programmedCircleId?: string;
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function choose(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (value && value !== "pending") return value;
  }
  return "pending";
}

function targetMode(manifest: VitalsManifest, env: Record<string, string | undefined>): "state_program" | "circle_program" {
  const configured = env.VITALS_STATE_TARGET_MODE || manifest.state_target_mode;
  return configured === "circle_program" ? "circle_program" : "state_program";
}

export function runtimeVitalsManifest(
  manifest: VitalsManifest,
  options: VitalsManifestRuntimeOptions = {}
): VitalsManifest {
  const env = options.env || process.env;
  const stateTargetMode = targetMode(manifest, env);
  const programmedCircleProgram = choose(env.VITALS_PROGRAMMED_CIRCLE_PROGRAM, manifest.programmed_circle_program);
  const programmedCircleArtifactDir = choose(env.VITALS_PROGRAMMED_CIRCLE_ARTIFACT_DIR, manifest.programmed_circle_artifact_dir);
  const recordSnapshotVersion = choose(env.VITALS_RECORD_SNAPSHOT_VERSION, manifest.record_snapshot_version);
  const factLedgerProgram = programmedCircleProgram === "fact-ledger" || recordSnapshotVersion === "fact-v1";
  const siteCircleId = choose(options.siteCircleId, env.VITALS_SITE_CIRCLE_ID, manifest.site_circle_id);
  const programmedCircleId = choose(options.programmedCircleId, env.VITALS_PROGRAMMED_CIRCLE_ID, manifest.programmed_circle_id);
  const stateProgramAddress = stateTargetMode === "circle_program"
    ? null
    : choose(env.VITALS_STATE_PROGRAM_ADDRESS, manifest.state_program_address);
  return {
    ...manifest,
    app_version: env.VITALS_APP_VERSION || manifest.app_version,
    gateway_origin: choose(env.VITALS_GATEWAY_ORIGIN, manifest.gateway_origin),
    octra_scan_address_url: choose(env.VITALS_OCTRA_SCAN_ADDRESS_URL, env.OCTRA_SCAN_ADDRESS_URL, manifest.octra_scan_address_url),
    octra_scan_tx_url: choose(env.VITALS_OCTRA_SCAN_TX_URL, env.OCTRA_SCAN_TX_URL, manifest.octra_scan_tx_url),
    site_circle_id: siteCircleId,
    state_target_mode: stateTargetMode,
    programmed_circle_id: programmedCircleId,
    programmed_circle_program: programmedCircleProgram,
    programmed_circle_artifact_dir: programmedCircleArtifactDir,
    record_snapshot_version: recordSnapshotVersion,
    programmed_circle_source_hash: choose(
      factLedgerProgram ? env.VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_SOURCE_HASH : null,
      env.VITALS_PROGRAMMED_CIRCLE_SOURCE_HASH,
      manifest.programmed_circle_source_hash
    ),
    programmed_circle_bytecode_hash: choose(
      factLedgerProgram ? env.VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_BYTECODE_HASH : null,
      env.VITALS_PROGRAMMED_CIRCLE_BYTECODE_HASH,
      manifest.programmed_circle_bytecode_hash
    ),
    programmed_circle_verification_hash: choose(
      factLedgerProgram ? env.VITALS_FACT_LEDGER_PROGRAMMED_CIRCLE_VERIFICATION_HASH : null,
      env.VITALS_PROGRAMMED_CIRCLE_VERIFICATION_HASH,
      manifest.programmed_circle_verification_hash
    ),
    state_program_address: stateProgramAddress,
    authority: {
      ...(manifest.authority || {}),
      canonical_app: "site-circle",
      canonical_state: stateTargetMode === "circle_program" ? "vitals-circle-program" : "vitals-state-program",
      gateway_role: manifest.authority?.gateway_role || "https-transport-adapter",
      state_target_mode: stateTargetMode,
      site_circle_id: siteCircleId,
      programmed_circle_id: programmedCircleId,
      state_program_address: stateProgramAddress
    }
  };
}
