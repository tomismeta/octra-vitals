# Octra Vitals Architecture

Octra Vitals is Octra-first and web-compatible.

## Mainnet Target

The go-forward mainnet architecture is a programmed Site Circle: the Circle is both the app identity and the native state boundary.

```text
Programmed Site Circle
  canonical app assets
  hash-only producer audit manifest
  Vitals Circle program
  latest canonical snapshot/provenance state
  bounded recent summary window

Gateway
  HTTPS transport adapter for normal browsers
  pinned mini oct:// browser for this app only

Snapshot Producer
  scheduled external evidence collection
  signed record_snapshot_v0 writes into the programmed Site Circle
```

In this shape, Circle browsers read state from the active Circle's own program view surface. Normal browsers still use the gateway, but the gateway remains replaceable: it translates and verifies, not originates truth.

This is the preferred mainnet pattern after the 2026-06-10 Circle program evaluation, stage rehearsal, and 2026-06-17 devnet cutover rehearsal. Do not cut over to mainnet until the production-sized programmed-Circle release gate passes with realistic latest payload, evidence, and source-ref sizes.

## Devnet Dogfood

```text
Programmed Site Circle
  canonical app assets
  Vitals Circle program
  latest canonical snapshot/provenance state
  bounded recent summary window

Gateway
  HTTPS transport adapter
  pinned mini oct:// browser for this app only
```

As of the 2026-06-17 rehearsal, `devnet.octra.live` uses the same programmed-Circle shape planned for mainnet. The previous split deployment, with a separate Site Circle and standalone Vitals State Program, remains useful as a compatibility path and historical dogfood reference. It is no longer the active devnet target.

The gateway is not the source of truth. In both shapes, it serves the Circle-hosted app assets to normal browsers and adapts normal HTTPS routes to native state reads.

The Site Circle follows the public Proof Console pattern: a public `octb` static asset Circle with `privacy_class = public`, `browser_mode = gateway_allowed`, and `resource_mode = public_resources`. The gateway is the normal-browser transport layer for those Circle-hosted app bytes, not a second source of truth.

The collector/updater does not run in the Site Circle or inside AML. It requires scheduled execution and outbound Octra, Ethereum, and relayer RPC reads. The Circle includes `producer.audit.json` as a hash-only manifest for the producer and related source files, while the AML program remains the canonical state and history verifier.

Production authority rule:

```text
App bytes     must resolve to the pinned Site Circle release
State reads   must resolve to the verified AML program
Gateway       must be replaceable; it may cache and translate, not originate truth
```

The gateway has three explicit state-source modes:

- `program_required`: production/reference mode. `/api/latest` refuses to serve data unless it can read and verify the Vitals State Program.
- `program_preferred`: transition mode. The gateway tries AML state first, then can fall back to bootstrap observation.
- `bootstrap_live`: bootstrap mode only. The gateway builds live observations so we can stand up the system before the experimental program is deployed.

Only `program_required` with a configured Site Circle and verified AML program should be called Octra-native production. For mainnet, the verified AML program should be attached to the Site Circle unless the production-sized programmed-Circle release gate reveals a hard protocol limit.

Current implementation split:

- `app/`: static browser shell that can move into the Site Circle.
- `app/manifest.json`: Circle asset manifest for public static resources.
- `app/producer.audit.json`: generated hash-only audit manifest for the off-chain producer and relevant state/gateway source files.
- `circle.json`: Circle build/deploy metadata using the official `runtime`, `build`, `deploy`, and `assets` sections.
- `program-circle/`: programmed Site Circle AML source for the preferred public path.
- `program/`: standalone AML source and formal verification artifacts for the compatibility path.
- `src/`: TypeScript gateway, RPC, snapshot, and artifact tooling.
- `dist/`: compiled JavaScript deployed on gateway hosts.
- `build/site-circle-release.json`: content-hashed Site Circle asset release manifest.

The AML source intentionally follows the style of `octra-labs/circle_examples`: small state declarations, explicit initialization, `public view fn` reads, `public fn` writes, and private helpers only for repeated guard logic. For Circle `program_update`, constructor defaults are not sufficient; any production programmed-Circle AML must expose an explicit `initialize_v0` that resets all state fields it depends on.

Formal verification is part of the architecture, not a release decoration. A deploy is only native-ready when the active AML target has a matching source/code-hash story and the scanner/RPC formal trace is `safe` with zero errors. For the standalone compatibility path, `contract_source(<program_address>)` must expose the matching source, ABI, verification report, and certificate. For the programmed Site Circle path, `program-circle/main.aml` must have its own compile/verification artifacts, deployment must refuse unsafe compiler output, and `/api/native-readiness` must see a non-null matching Circle program code hash.

Bridge accounting uses three external accounting surfaces:

- Octra BridgeVault `oct5MrNfjiXFNRDLwsodn8Zm9hDKNGAYt3eQDCQ52bSpCHq` for vault balance and storage keys such as `total_locked`, `total_unlocked`, `lock_nonce`, and `unlock_count`.
- Ethereum wOCT `0x4647e1fE715c9e23959022C2416C71867F5a6E80` for ERC-20 `totalSupply()`.
- EthereumBridge `0xE7eD69b852fd2a1406080B26A37e8E04e7dA4caE` and the relayer status/recovery endpoints for bridge identifiers, finalized/scanned epochs, and recovery claims.

The observation RPC and program RPC are separate lanes. `OCTRA_OBSERVATION_RPC_URL` is the source of observed Octra supply/vault facts and is currently `https://octra.network/rpc`. `OCTRA_PROGRAM_RPC_URL` is the endpoint used for Vitals State Program deploy/read/write calls; during devnet dogfood it may point at `https://devnet.octrascan.io/rpc` even while observations come from the live Octra RPC.

The gateway verifies hash consistency for the program state it receives, but it is not an Octra consensus light client. A single program RPC is therefore a trust root for what state is reported. Public/mainnet deployments must configure `OCTRA_PROGRAM_RPC_URLS` with two or more independent endpoints; the gateway compares programmed-Circle latest snapshot reads, history-window reads, submit preflight/readback, owner/operator views, and readiness metadata, then fails closed on disagreement.

For Circle-served static assets, the gateway also verifies the pinned release hash, the webcli-compatible Circle `resource_key` derivation, and the returned `blob_hash` against decoded bytes. `/api/site-integrity` and Circle asset response headers expose those fields plus `stable_root`/`assets_root`, but this is still RPC consistency metadata until Octra exposes inclusion witnesses from asset/state keys to finalized roots.

Vitals does not claim to be a full bridge verifier. It is a hash-bound accounting and reconciliation surface. It stores direct observations and derived bridge reconciliation values in the Vitals State Program so reviewers can inspect the payload, formulas, source refs, and raw evidence independently.

Public v0 keeps the latest payload, evidence manifest, and source refs as full AML strings for native inspection. It stores trend history as a bounded fixed-width summary window rather than historical payload maps. The gateway verifies the latest summary row against the latest payload before serving it, and `/api/history` is drawn only from that AML summary window.

## Programmed Circle Adoption Rules

When we incorporate the programmed Site Circle into the production solution:

- Deploy or update the Site Circle with its AML program attached.
- Call `initialize_v0` exactly once before the first snapshot write.
- Keep the state shape bounded: latest full bodies plus a fixed-width recent summary window.
- Add a Circle-local app adapter for `window.OctraCircle.request("program.view", ...)`.
- Keep normal-browser API routes as verified gateway adapters.
- Do not reintroduce gateway-local history, static sample fallbacks, unbounded maps, staged records, or generic record stores.
- Keep a production-sized programmed-Circle release gate before mainnet cutover.

The deployment bar is intentionally narrow: public state and assets live in the programmed Circle, while the gateway remains a verified transport shim and the producer remains off-chain only for sources the Circle cannot read directly.
