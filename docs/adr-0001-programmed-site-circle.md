# ADR 0001: Programmed Site Circle Mainnet Target

Date: 2026-06-10

Status: accepted and active for public v0.

## Context

The devnet dogfood system currently uses:

```text
Site Circle
  app assets

Separate Vitals State Program
  canonical snapshot state

Gateway
  HTTPS adapter and verifier
```

This works, but Circle browser support is cleaner when app state is inside the active Circle. WebCLI now exposes `circle_program_update`, and the devnet probe confirmed that a Circle can be updated with AML code, initialized, written through `circle_call`, and read through `octra_circleView`.

## Decision

The mainnet target is a programmed Site Circle:

```text
Programmed Site Circle
  app assets
  hash-only producer audit manifest
  Vitals AML program
  latest payload/evidence/source refs
  bounded recent summary window

Gateway
  verified HTTPS adapter for normal browsers

Snapshot Producer
  external evidence collector
  signed writes into the Site Circle program
```

The devnet dogfood deployment has been cut over to this shape. The older devnet split remains valid as a compatibility fallback. It should not be treated as the default public architecture unless the production-sized programmed-Circle release gate exposes a hard protocol limit.

## Requirements

- `initialize_v0` is mandatory after `program_update`.
- `initialize_v0` must reset every state field used by the program.
- State remains bounded: latest full bodies plus fixed-width recent rows.
- History is sourced only from AML summary rows.
- The gateway remains replaceable and fail-closed.
- The app should prefer Circle-local program views in Circle/browser contexts.
- Mainnet cutover requires a production-sized release gate with the real 48-row window and realistic latest payload/evidence/source-ref sizes.

## Consequences

- Mainnet app identity and state authority share one Circle id.
- Circle browsers do not need cross-program reads for the primary experience.
- The gateway gets thinner, not thicker.
- The snapshot producer remains external because it must collect Octra, Ethereum, and relayer evidence.
- Upgrade operations must treat `program_update` as powerful and auditable.

## Historical Probe Evidence

Latest verified devnet probe:

```text
circle_id: oct3muU9yHmLvVxLMoKbFH6NscsEaU3Fu6w5TxFsRpo9ZcZ
deploy_tx: 9d1252585dbd8a2919f7d6e6f95a90911e4864e1825d93ec06ac773eb1a98fd0
program_update_tx: a885003551902572b523b94d1fad246d228427d0908367065a7e80c143451474
initialize_tx: 99f6ee4381b145264b4a7c71cf783df59daf3c20637f0c6e10e78ade7269964b
result: verified, snapshot_count=5, first_index=2, row_count=4
```

The first probe also proved a negative requirement: constructor defaults are not enough after `program_update`. The production AML must explicitly initialize state.

Latest full devnet cutover rehearsal:

```text
date: 2026-06-17
host: octra-dev.exe.xyz
domain: devnet.octra.live
circle_id: oct48TxRTECzSNuhu7uDJ4MRyFkD2W2usyZqf2EbpXwRUeg
deploy_tx: 822999fd4f477101146d8a1b356960086493fb7c48e1e44025539a1ced06ccb7
program_update_tx: 4fbcf8c230eac5c8dc1a9f5789d7b64aedfe26b84aedfce36854fcb906c326c1
initialize_tx: b65e146acc1f05fb9dae63002d22e0cd80b1792d4c9c24e0acfd76e5bbeb2fc2
first_seed_tx: 4e91e663e97fc3d98edbe4bc26d666a46d09a2048b590cf69e03bdb014136e04
post-cutover_snapshot_tx: 1480b2b60697e8c272a6b64e92edf16b9eba4a75e931953e817b8d565a0a8da3
result: native_ready, site assets verified, Circle program verified, generic timers active
```

Migration lesson: do not rewrite historical hashes to force a replay. The old devnet window had temporary `octra-vitals-snapshot-v0.3` payload/hash domains, while the clean public v0 Circle accepts `octra-vitals-snapshot-v0`. The rehearsal correctly blocked historical replay and seeded a fresh v0 snapshot instead.
