# Architecture

Octra Vitals is an Octra-native accounting instrument with a web-compatible access path.

## Shape

```text
Programmed Site Circle
  public app assets
  producer audit manifest
  Vitals AML fact ledger
  latest full snapshot/provenance
  compact historical fact capsules

Gateway
  HTTPS adapter for normal browsers
  Circle asset verifier
  AML read verifier

Snapshot Producer
  scheduled external evidence collection
  signed writes into the programmed Circle
```

The programmed Site Circle is the canonical app identity and the canonical state boundary. The gateway exists so normal browsers can use the app before Circle-native browser APIs are universal. It must translate, verify, and fail closed; it must not originate production truth.

## Verification Boundary

Normal browsers receive data through the gateway, then the app re-derives canonical hashes and conservation checks before rendering. This path is integrity-verified and gateway-tamper-evident, but it is still transported through the gateway.

Circle-native clients can read the programmed Circle directly and verify against the chain-native state surface. That is the stronger trust boundary.

## State Model

The AML program stores:

- latest canonical payload, evidence manifest, and source references;
- latest compact accounting fact row;
- append-only capsule bodies and metadata for historical facts;
- row and capsule root checkpoints;
- predecessor/successor era anchors;
- owner/operator, pause, and configuration state.

The AML program does not store historical raw RPC bodies. Raw evidence is retained by content hash on the host/archive layer and linked from source references. This keeps AML focused on ordering, commitments, compact facts, and verification roots.

## History Model

Each successful snapshot writes one compact core accounting fact. Facts are fixed-width rows grouped into deterministic UTC half-day capsules. A capsule contains the row body plus metadata: row count, key bounds, body hash, row-root range, and capsule-chain root.

Snapshot index is the canonical ordering key. Octra epoch is recorded as observed source metadata and must not move backward, but two consecutive snapshots may observe the same epoch.

The fact ledger also supports dormant auxiliary fact families. The default producer writes only the core family. When a durable scalar metric needs historical retention, the operator can register an auxiliary family and include bounded auxiliary rows in the same atomic snapshot call.

History can span eras. When the AML shape changes incompatibly, a new programmed Circle era starts at the next snapshot index. The successor commits to the predecessor program id, predecessor final index, predecessor final root, era first index, and a domain-separated anchor hash. `/api/history` may stitch eras only when those anchors verify against live predecessor reads.

Compatible in-place AML updates are allowed only when old state layout, old getters, old row semantics, and capsule immutability remain valid.

Durable history reads are verified by folding capsule bodies and metadata against AML roots. The gateway exposes proof scope explicitly:

- `full_chain`: every sealed capsule needed for that era was read and folded from the empty root;
- `tail_window`: only the recent configured capsule tail was read, so the returned rows are verified locally but the whole era was not replayed in that response;
- `summary_window`: older-era bounded-window history.

## Extensibility

Most source expansion should not require AML changes:

- new source fields can live in the latest payload/evidence/source refs;
- new chains can appear in `payload.routes[]` while core history remains aggregate OCT accounting;
- new derived UI values can be computed from existing facts and verified latest payloads;
- durable new historical scalar families can use bounded auxiliary fact rows when activated.

Core row changes, new cardinality models, new authorization semantics, or incompatible storage layout changes require an AML update or a new era.

## External Sources

The producer observes:

- Octra supply and bridge/vault state through Octra RPC;
- Ethereum wOCT supply and decimals at a pinned Ethereum block;
- relayer status and recovery data;
- source metadata needed to reproduce or inspect the observation.

The observation RPC and program RPC are separate lanes. The gateway compares all configured program RPCs for latest/history/readback agreement and fails closed on disagreement. If only one canonical program RPC exists, the system can run with one while keeping the multi-RPC comparison path ready.

## Assets

Static app assets are published into the same programmed Circle as the AML state. The gateway verifies pinned release hashes, resource keys, returned blob hashes, and Circle asset parity before serving in `circle_required` mode.

`producer.audit.json` is part of the public asset set. It is a hash-only manifest of producer, gateway, deploy, AML, and architecture files used to build and operate the instrument.

## Non-Goals

Octra Vitals is not a bridge light client and does not replace explorers, protocol RPCs, or bridge internals. It is a hash-bound accounting and reconciliation surface: it records what was observed, preserves compact commitments in AML, exposes raw evidence by hash, and makes conservation status visible.
