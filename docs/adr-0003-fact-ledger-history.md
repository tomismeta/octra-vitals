# ADR 0003: Fact Ledger History

Date: 2026-06-24

Status: accepted

## Context

Vitals needs more than a recent trend window. A reviewer should be able to inspect compact historical observations long after they were recorded, while AML remains small enough to verify and operate.

The design must also accommodate future fields, destination chains, and derived metrics without turning every source change into a mainnet AML replacement.

## Decision

Use an AML fact ledger.

The core family records one compact accounting fact per snapshot. Facts are fixed-width rows grouped into deterministic UTC half-day capsules. Each capsule commits to:

- row body;
- row count and key bounds;
- body hash;
- row-root start/end;
- capsule-chain root.

The latest snapshot remains rich and AML-readable: full payload, evidence manifest, and source refs. Historical raw RPC bodies remain outside AML by content hash.

The first public shape may include a dormant typed-metric surface. It costs little when inactive and provides a controlled path for future durable scalar facts. Activation requires explicit registration, sorted auxiliary rows, readback tests, and soak evidence.

The public AML ABI is intentionally small. Fact-family getters are the canonical read surface; core-only convenience aliases and constant getters are not part of the long-term contract. This keeps the program compatible with stricter runtimes that validate lowered jump labels and treats public AML methods as scarce protocol surface.

Gateway APIs continue to expose stable, normalized `/api/latest` and `/api/history` responses. The gateway translates strict family reads into the existing JSON contract. The SQLite lab mirror remains downstream: it writes only after AML success/readback, and its query APIs must tolerate the strict ABI without becoming a second source of truth.

## Non-Goals

- Store historical full RPC bodies in AML.
- Put every future derived chart/index into AML.
- Rebuild historical facts from off-chain sources after launch.
- Hide era boundaries when AML changes incompatibly.

## Consequences

- Long-horizon history can be served from AML facts and capsule roots.
- The core row should change rarely.
- New chains usually enter the latest payload first.
- Durable new scalar history should use auxiliary fact families instead of widening the core row.
- Removing or renaming public AML methods is a successor-era change. In-place updates must remain ABI-compatible unless an explicit new-era artifact refresh is acknowledged.
- Mainnet promotion requires the current release gates in [Readiness](readiness.md).
