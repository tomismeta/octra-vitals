# Octra Vitals

Octra Vitals is a public, Octra-native supply and bridge reconciliation surface: a financial instrument that proves itself.

It observes Octra, Ethereum, and relayer RPC sources, commits canonical snapshots into an Octra AML program, and serves a static browser UI that verifies and explains the latest state. The goal is not to replace explorers, RPCs, or bridge internals. The goal is to make the important accounting relationships visible, source-linked, and hard to silently fake.

The current public shape is a programmed Site Circle: the Circle hosts the app assets and also carries the AML state program that stores the latest snapshot plus a bounded recent-history window.

## Verification Boundary

Do not trust the dashboard. The dashboard is designed to prove itself to you.

In a normal browser, Octra Vitals is integrity-verified and gateway-tamper-evident: the page re-derives canonical hashes, checks the payload/evidence/source-reference commitments, recomputes the conservation verdict, and links the on-chain anchors needed for independent inspection.

In a Circle-native client, the trust boundary is stronger: the app can read the programmed Site Circle directly, route around the HTTPS gateway, and verify against the chain-native state surface.

The gateway remains a compatibility shim for normal browsers. It translates HTTPS requests into verified Octra program reads; it is not the source of truth.

## What It Shows

Octra Vitals focuses on a few first-class questions:

- How much OCT is in circulation versus burned?
- How much OCT is encrypted?
- How much OCT is locked in the Octra bridge vault?
- How much wOCT has been issued on Ethereum?
- How much locked collateral is claimable recovery/unclaimed?
- What residual bridge collateral remains unclassified by the public sources?
- Which snapshot, program, evidence, and source references support the numbers?

All user-facing values come from a canonical snapshot payload committed to AML state. Derived values such as unclassified bridge collateral are labeled as reconciliation values, not upstream facts.

## Architecture Principles

Octra Vitals is built around a few constraints.

**Octra first.** The canonical app and canonical state live in Octra infrastructure. Normal web hosting is treated as a transport adapter, not the source of truth.

**Thin gateway.** The gateway serves Circle-pinned static assets and adapts HTTPS requests to Octra program reads for normal browsers. It should not invent production truth, cache substitute snapshots, or recover with sample data in production.

**Program-backed state.** Production mode requires `program_required` reads from the Vitals AML program. If the program state is unavailable, the app shows unavailable rather than rendering fallback numbers.

**Hash-gated payloads.** The AML program stores canonical snapshot strings and hashes for payload, evidence manifest, source references, summary row, and recent-history window. The gateway and browser verify those hashes before rendering.

**Conservation verdicts.** The app does not only display balances. It recomputes accounting identities and renders whether supply and bridge claims reconcile against the signed snapshot verdict.

**Bounded on-chain history.** AML state stores the latest full snapshot and a fixed recent summary window. Long raw evidence retention belongs on the host or external archival systems, not in AML.

**Auditable producer.** The off-chain producer is deliberately visible. The Site Circle includes `producer.audit.json`, a hash-only manifest of the producer, gateway, deploy scripts, AML, and architecture docs used to create and serve snapshots.

**Fail closed.** Missing required inputs, hash mismatches, stale program reads, asset drift, or unsafe AML verification should stop rendering or deployment rather than silently degrade trust.

## Repository Layout

```text
app/              Static browser app assets for the Site Circle
program-circle/   AML for the programmed Site Circle target
program/          Standalone State Program compatibility path
src/              TypeScript producer, gateway, verification, deploy tooling
deploy/           Host, systemd, stage, and mainnet deployment scripts
docs/             Architecture, schema, operations, costs, and deployment docs
```

Generated/runtime output is intentionally ignored:

```text
build/
dist/
data/
reports/
app/producer.audit.json
```

## System Components

**Producer**

Collects Octra supply, Octra bridge/vault state, Ethereum wOCT supply, relayer recovery data, and source metadata. It builds canonical JSON, writes raw evidence locally, prepares the AML `record_snapshot_v0` call, submits only when explicitly enabled, then verifies program readback.

**AML Program**

Stores the latest canonical snapshot, evidence manifest, source references, summary row, recent summary window, owner/operator controls, paused/successor state, and hash commitments. It is intentionally small and bounded.

**Gateway**

Runs as a HTTPS shim for normal browsers. It serves Circle assets, reads program state, verifies hashes, exposes `/api/latest`, `/api/history`, evidence routes, health, site-integrity, and native-readiness endpoints.

**Browser App**

Renders the accounting view, trend window, provenance links, raw evidence references, and proof references. It re-derives hashes and conservation checks before trusting production values, and it does not use sample values in production mode.

## Trust Model

Octra Vitals is a reconciliation and proof surface, not a consensus light client.

It trusts configured RPC endpoints for observation, then preserves exactly what was observed through canonical payloads, evidence hashes, source references, raw evidence, and AML commitments. A normal browser can verify internal consistency and detect gateway tampering, but it still receives transport through the gateway. A Circle-native client can verify against the programmed Circle state surface directly. When multiple program RPCs are configured, reads and write preflight/readback must agree. If only one canonical mainnet RPC exists, the system can run with one RPC while keeping the comparison path ready.

Bridge residuals are intentionally visible. A positive value for `locked - wOCT - unclaimed` is treated as reconciliation data, not automatically as a Vitals health issue. Red health is reserved for invalid identities such as overclaims, cap/burn mismatch, vault shortfall, missing required fields, or unit/decimal mismatch.

## Local Development

Octra Vitals targets Node 22. Use `.nvmrc` / `.node-version` if your local shell has multiple Node versions installed.

Install and run the app locally:

```bash
npm install
npm run snapshot:sample
npm run dev
```

Open:

```text
http://127.0.0.1:4173
```

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

Set `VITALS_DATA_DIR` to keep runtime snapshots and evidence outside the checkout.

## Command Lanes

The package scripts are grouped by operating lane. The short path for most contributors is `check`, `test`, `native:verify`, and `dev`; the `*:dist` entries are deployment/runtime entrypoints used after the TypeScript build has already completed.

General checks:

```bash
npm run check
npm test
npm run native:verify
```

Snapshot/update lifecycle:

```bash
npm run snapshot
npm run program:record-call
npm run program:submit-snapshot
npm run program:update
```

AML lifecycle:

```bash
npm run program:compile
npm run program:verify
npm run program:deploy
npm run program:read-latest
```

Circle lifecycle:

```bash
npm run producer:audit
npm run circle:release
npm run circle:verify
npm run circle:deploy
npm run circle:programmed:deploy
```

Production release planning:

```bash
DEPLOY_GATEWAY_URL=https://octra.live npm run release:plan
```

`release:plan` is read-only against the target gateway. It queries live deployment state, stamps a candidate release with the live Circle/program identifiers, compares candidate asset and producer-audit hashes, and recommends the required deployment objects before any write action.

## Production Posture

Production should use:

```text
VITALS_STATE_TARGET_MODE=circle_program
VITALS_STATE_SOURCE_MODE=program_required
VITALS_STATIC_ASSET_SOURCE=circle_required
```

The normal production path is:

1. rehearse the same commit on devnet/stage;
2. capture a devnet/stage rehearsal report;
3. run `release:plan` against mainnet;
4. use the protected deployment dispatcher for approved write actions;
5. keep the updater timer paused across host release, Circle asset publication, and manual snapshot writes;
6. verify `/api/latest`, `/api/history`, `/api/site-integrity`, and `/api/native-readiness`;
7. restore the updater timer only after the runtime is green.

Mainnet writes are devnet-gated. After rehearsing the same commit on devnet/stage, capture proof with:

```bash
DEPLOY_DEVNET_REHEARSAL_GATEWAY_URL=https://devnet.octra.live \
bash deploy/mainnet/capture-devnet-rehearsal-report.sh
```

See:

- `docs/architecture.md`
- `docs/schema.md`
- `docs/ops.md`
- `docs/release-management.md`
- `docs/mainnet-deployment.md`
- `docs/costs.md`
- `docs/adr-0001-programmed-site-circle.md`

## Security Notes

Never commit wallet material, private keys, `.env` files, Telegram tokens, raw host secrets, or production updater env files.

The gateway env should contain public/non-secret config only. Snapshot-writing keys belong in `/etc/octra-vitals/updater.env` on the host, owned by root, with minimal permissions. The v0 launch posture uses a dedicated low-balance production wallet and keeps the path open for later operator rotation.

## License

MIT.
