# Schema And API Contract

This document describes the current public contract. Git tracks document history; explicit version strings are used only where the protocol or API needs compatibility gates.

## Snapshot Envelope

Each snapshot has a canonical envelope:

- `snapshot_id`
- `observed_at`
- `payload_hash`
- `evidence_manifest_hash`
- `source_refs`
- `submitter`
- canonical payload/evidence/source-ref strings

`/api/latest` also exposes parsed `payload` and `source_refs` for app consumers. Parsed fields are convenience views; canonical strings and hashes are the verification surface.

Hash domains are fixed compatibility strings, not document versions:

```text
payload_hash       = sha256("octra-vitals:snapshot:v0\n" + canonical_payload)
evidence_hash      = sha256("octra-vitals:evidence:v0\n" + canonical_evidence)
source_refs_hash   = sha256("octra-vitals:source-refs:v0\n" + canonical_source_refs)
```

## AML Write Path

The producer performs one logical update:

1. collect source evidence;
2. build canonical JSON and compact fact rows;
3. write raw evidence locally by content hash;
4. submit the configured AML snapshot call;
5. read back AML state and verify hashes, latest identity, roots, and receipt data;
6. atomically promote local latest artifacts.

The active programmed-Circle path uses the fact-ledger AML. Legacy bounded-window calls remain in the repo as compatibility paths, but the mainnet target is the fact ledger.

## Core Accounting Fact

The core fact row is a fixed-width OCT-denominated accounting observation. It commits to:

- snapshot index;
- integer-second UTC observed time;
- Octra epoch;
- external block height;
- issued, burned, encrypted, locked, wrapped, unclaimed, and vault raw OCT values;
- unit and conservation status;
- route count;
- full payload hash commitment.

Rows are grouped into deterministic UTC half-day capsules. Capsule metadata commits to body hash, row-root range, key bounds, row count, catalog root, and capsule-chain root.

## Latest Versus History

The latest snapshot is intentionally rich. It keeps full payload, evidence manifest, source refs, health verdicts, routes, and source provenance AML-readable.

Historical rows are intentionally thin. They preserve the accounting facts needed for long-horizon charts and audit, while historical raw RPC bodies remain outside AML by content hash.

## Era Boundaries

`/api/history` may return rows from multiple AML eras. Each era carries proof metadata:

- era program/Circle id;
- history model;
- first/latest index;
- row count;
- root hash;
- capsule root;
- predecessor program id;
- predecessor final index/root;
- predecessor anchor hash;
- boundary verification status.

The gateway only marks a boundary verified after reading the predecessor era's actual final root and recomputing the successor anchor.

## Bridge Accounting

All OCT and wOCT values use 6 raw decimals. The producer reads wOCT `decimals()` at the same pinned Ethereum block as `totalSupply()` and fails the snapshot if units are unsafe.

Direct observed fields include:

- Octra supply values from `octra_supply`;
- BridgeVault `total_locked`, `total_unlocked`, lock nonce, and unlock count;
- BridgeVault account balance;
- Ethereum wOCT total supply;
- relayer status and recovery claim data.

Derived reconciliation fields include:

- unclaimed: sum of relayer recovery claims;
- unclassified: `max(locked - wrapped - unclaimed, 0)`;
- vault surplus: `vault_balance - locked`;
- conservation status: green/yellow/red accounting verdict.

A positive unclassified value is reconciliation data, not automatically a Vitals health issue. Red health is reserved for invalid identities such as overclaims, cap/burn mismatch, vault shortfall, missing required fields, or unit mismatch.

## Gateway Contract

Production/reference mode requires:

```text
VITALS_STATE_TARGET_MODE=circle_program
VITALS_STATE_SOURCE_MODE=program_required
VITALS_STATIC_ASSET_SOURCE=circle_required
```

In this mode:

- `/api/latest` fails closed if program-backed latest state is unavailable or stale;
- `/api/history` is sourced from verified AML facts and era roots;
- `/api/site-integrity` verifies Circle asset parity;
- `/api/native-readiness` verifies programmed-Circle code, methods, source/formal artifacts, initialized state, assets, history readability, and RPC agreement.

Gateway-originated bootstrap reads are explicitly labeled and are not production truth.

## Public Evidence API

Useful routes:

```text
/api/latest
/api/history
/api/version
/api/site-integrity
/api/native-readiness
/api/evidence/<sha256>
/api/evidence/raw/<sha256>
/health
```

API JSON is pretty-printed by default. Raw evidence routes expose parsed evidence views by default and support `?exact=1` only when byte-for-byte stored file output is needed.

## Circle Asset Bundle

The public Circle asset bundle contains app bytes plus `producer.audit.json`. It does not contain production sample data or gateway-local history. Local sample snapshots remain test fixtures only.
