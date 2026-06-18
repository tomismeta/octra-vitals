export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params: unknown[];
}

export interface JsonRpcRow {
  id: JsonRpcId;
  result?: any;
  error?: unknown;
}

export interface EvidenceEntry {
  id: string;
  kind: string;
  url: string;
  method: string;
  request_hash: string | null;
  response_hash: string;
  observed_at: string;
  epoch: number | string | null;
  block_number: string | null;
  parser_version: string;
}

export interface RawEvidenceEntry {
  id: string;
  kind?: string;
  url?: string;
  method?: string;
  request_hash?: string | null;
  response_hash: string;
  request?: unknown;
  body: string;
  content_type: string;
  observed_at: string;
  epoch?: number | string | null;
  block_number?: string | null;
}

export interface SourceRef {
  id: string;
  kind: string;
  method: string;
  url: string;
  hash: string;
}

export interface SnapshotRoute {
  route_id: string;
  src_chain: string;
  src_chain_id: number;
  dst_chain: string;
  dst_chain_id: number;
  asset: string;
  vault_address: string;
  wrapped_address: string;
  bridge_address: string;
  locked_raw: string;
  wrapped_supply_raw: string;
  unclaimed_raw: string;
  source_ref_ids: string[];
}

export interface SnapshotPayload {
  schema_version: string;
  units: {
    oct_decimals: number;
    woct_decimals: number;
  };
  octra: {
    epoch: number;
    state_root: string;
    txid_hi: string;
    network_version: string;
    validator: string;
    timestamp: string;
  };
  supply: {
    max_oct_raw: string;
    issued_oct_raw: string;
    encrypted_oct_raw: string;
    burned_oct_raw: string;
    confirmed_burned_oct_raw?: string;
  };
  bridge: {
    vault_address: string;
    vault_balance_oct_raw: string;
    total_locked_oct_raw: string;
    total_unlocked_oct_raw: string;
    lock_nonce: string;
    unlock_count: string;
    woct_supply_raw: string;
    unclaimed_oct_raw: string;
  };
  ethereum: {
    chain_id: number;
    block_number: string;
    block_hash: string;
    woct_address: string;
    bridge_address: string;
  };
  relayer: {
    latest_finalized_epoch: number;
    latest_scanned_epoch: number;
    recovery_updated_at: number | string | null;
    mode: string;
    src_chain_id?: number;
    dst_chain_id?: number;
    src_bridge_id?: string;
    dst_bridge_id?: string;
    token_id?: string;
    validator_set_hash?: string;
  };
  routes?: SnapshotRoute[];
  health?: {
    conservation: {
      status: "green" | "yellow" | "red";
      ok: boolean;
      flags: string[];
      largest_abs_delta_raw?: string;
      required_inputs?: {
        burned_rpc: boolean;
        woct_decimals_verified: boolean;
      };
      units?: {
        expected_woct_decimals: number;
        actual_woct_decimals: number;
      };
      clocks?: {
        octra_epoch: number;
        relayer_finalized_epoch: number;
        recovery_scanned_epoch: number;
        relayer_lag_epochs: number;
        recovery_lag_epochs: number;
        ethereum_block: string;
      };
      deltas: {
        cap_remaining_raw: string;
        cap_burn_mismatch_raw: string;
        encrypted_minus_issued_raw: string;
        bridge_residual_raw?: string;
        bridge_claim_balance_raw: string;
        bridge_claim_overage_raw: string;
        vault_surplus_raw: string;
      };
    };
  };
}

export interface EvidenceManifest {
  schema_version: string;
  observed_at: string;
  parser_version: string;
  entries: EvidenceEntry[];
}

export interface SnapshotEnvelope {
  schema_version: string;
  snapshot_id: string;
  observed_at: string;
  payload_hash: string;
  evidence_manifest_hash: string;
  canonicalization: string;
  payload: SnapshotPayload;
  source_refs: SourceRef[];
  submitted_by: string;
}

export interface SnapshotArtifact {
  envelope: SnapshotEnvelope;
  evidence_manifest: EvidenceManifest;
  canonical_source_refs?: string;
  canonical_payload: string;
  canonical_evidence_manifest: string;
  generated_at: string;
  raw_evidence?: RawEvidenceEntry[];
}

export interface ProgramArtifacts {
  schema: "octra-vitals-program-artifacts-v0" | "octra-vitals-program-circle-artifacts-v0";
  source: string | null;
  abi: any | null;
  formal_verification: Record<string, any> | null;
  formal_certificate: Record<string, any> | null;
  lowered_oasm: string | null;
}
