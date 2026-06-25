# ADR 0001: Programmed Site Circle

Date: 2026-06-10

Status: accepted

## Context

Octra Vitals needs the app identity and the canonical state boundary to be as Octra-native as possible. A split shape with static app assets in one Circle and state in a separate program works, but it makes Circle-native browsing and proof discovery less direct.

Octra Circle program updates allow a public Circle to carry AML code that can be initialized, written, and read through Circle program calls/views.

## Decision

Use one programmed Site Circle as the default public shape:

```text
Programmed Site Circle
  app assets
  producer audit manifest
  Vitals AML program

Gateway
  HTTPS compatibility adapter

Producer
  external evidence collector and snapshot writer
```

The gateway remains replaceable. It serves Circle-pinned assets and adapts HTTPS routes to verified Circle program reads for normal browsers. It is not the source of truth.

## Consequences

- App assets and state authority share one Circle id.
- Circle-native clients can read the active program directly.
- `program_update` must be treated as a high-trust operator action.
- AML programs require explicit initialization after update.
- The producer remains off-chain because it reads external Octra, Ethereum, and relayer RPC sources.
- The split app/state shape remains only a compatibility fallback.
