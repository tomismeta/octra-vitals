# Vitals State Storage

`VitalsState` public v0 is a bounded snapshot ledger. It keeps the latest full payload/evidence/source refs on-chain for native inspection, and keeps recent trend history as a fixed-width rolling summary window.

It intentionally does not store historical full payload maps, generic records, staged snapshot records, or an unbounded id index.

## Simple Fields

- `owner`
- `operator`
- `successor_program`
- `successor_set`
- `paused`
- `snapshot_count`
- `latest_snapshot_index`
- `latest_snapshot_id`
- `latest_observed_at`
- `latest_epoch`
- `latest_payload_hash`
- `latest_evidence_manifest_hash`
- `latest_source_refs_hash`
- `latest_summary_hash`
- `latest_payload`
- `latest_evidence_manifest`
- `latest_source_refs`
- `latest_summary`
- `latest_submitter`
- `summary_window`
- `summary_window_hash`
- `summary_window_first_index`
- `summary_window_row_count`

## Rolling Summary Window

The public trend surface is `summary_window`, a bounded string containing up to 48 fixed-width rows. Each row is 208 bytes and is hashed with:

```text
sha256("octra-vitals:summary:v0\n" + summary_row)
```

The full window is hashed with:

```text
sha256("octra-vitals:summary-window:v0\n" + summary_window)
```

While the window is partially full, `record_snapshot_v0()` appends rows. Once full, it drops the first 208-byte row with `substr()` and appends the new row. This keeps the AML history surface bounded and loopless.

## Write Flow

The updater records one snapshot with one atomic AML call:

```text
record_snapshot_v0(snapshot_id, observed_at, epoch_id, snapshot_index, payload_schema_version, summary_schema_version, payload_hash, evidence_hash, source_refs_hash, summary_hash, canonical_payload, canonical_evidence_manifest, canonical_source_refs, summary_row)
```

The program verifies:

- caller is owner/operator;
- program is not paused;
- `snapshot_id == "vitals." + observed_at`;
- `snapshot_index == snapshot_count + 1`;
- epoch/time move forward under the monotonicity rule;
- payload, evidence, source-ref, and summary hashes match their domain-separated canonical strings;
- payload/evidence/source refs/window sizes stay within explicit caps.

The program cannot parse canonical JSON, so it cannot prove the compact summary row was faithfully extracted from the payload. The gateway must recompute the latest summary row from `latest_payload` and fail loudly if it differs from `latest_summary`.

## Hash Rules

```text
payload_hash          = sha256("octra-vitals:snapshot:v0\n" + canonical_payload)
evidence_hash         = sha256("octra-vitals:evidence:v0\n" + canonical_evidence_manifest)
source_refs_hash      = sha256("octra-vitals:source-refs:v0\n" + canonical_source_refs)
summary_hash          = sha256("octra-vitals:summary:v0\n" + summary_row)
summary_window_hash   = sha256("octra-vitals:summary-window:v0\n" + summary_window)
```

Historical rows carry a payload-hash prefix as a commitment/locator, not a fetchable on-chain historical payload. Full historical bodies may later be archived by content hash outside AML.

## Latest Bundle Getter

`get_latest_bundle()` is a compact inspection string:

```text
latest_snapshot_index|latest_snapshot_id|latest_observed_at|latest_epoch|latest_payload_hash|latest_evidence_manifest_hash|latest_source_refs_hash|latest_summary_hash|summary_window_hash|paused|successor_set|successor_program|latest_summary
```

`latest_summary` is last because summary rows are themselves pipe-delimited. The full latest payload, evidence manifest, and source refs remain on dedicated getters so the bundle does not become a second large return surface.
