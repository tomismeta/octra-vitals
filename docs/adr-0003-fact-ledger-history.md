# ADR 0003: Fact Ledger History

Date: 2026-06-24

Status: accepted for devnet soak; mainnet pending readiness gates

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
- Mainnet readiness depends on devnet soak, capsule seals, read latency, cost calibration, and verified era stitching.
