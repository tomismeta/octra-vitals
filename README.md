# Octra Vitals

Octra Vitals is a public, Octra-native supply and bridge reconciliation surface: a financial instrument that proves itself.

It observes Octra, Ethereum, and relayer RPC sources, commits canonical snapshots into an Octra AML program, and serves a static browser UI that verifies and explains the latest state and history. The goal is not to replace explorers, RPCs, or bridge internals. The goal is to make the important accounting relationships visible, source-linked, and hard to silently fake.

The go-forward shape is a programmed Site Circle: the Circle hosts the app assets and also carries the AML state program. The current mainnet-shaped AML candidate is a fact-family ledger that stores the latest full snapshot plus compact per-snapshot accounting facts in sealed history capsules. Successor eras are stitched with explicit predecessor anchors so future AML versions can be verified without pretending old state moved.

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

**Hash-gated payloads.** The AML program stores canonical snapshot strings and hashes for payload, evidence manifest, source references, latest fact row, and history/capsule roots. The gateway and browser verify those commitments before rendering.

**Conservation verdicts.** The app does not only display balances. It recomputes accounting identities and renders whether supply and bridge claims reconcile against the signed snapshot verdict.

**AML-retained history.** AML state keeps thin, fixed-width accounting facts in capsule form for long-horizon history. The latest full payload, evidence manifest, and source refs remain AML-readable for provenance. Historical raw RPC bodies are retained by content hash outside AML so the program does not become a raw-response database.

**Era-aware upgrades.** New AML generations create explicit eras. A successor stores the predecessor program id, final index, final root, first successor index, and a domain-separated anchor hash. The gateway and browser-facing API can stitch eras only when the boundary verifies.

**Auditable producer.** The off-chain producer is deliberately visible. The Site Circle includes `producer.audit.json`, a hash-only manifest of the producer, gateway, deploy scripts, AML, and architecture docs used to create and serve snapshots.

**Fail closed.** Missing required inputs, hash mismatches, stale program reads, asset drift, or unsafe AML verification should stop rendering or deployment rather than silently degrade trust.

## Repository Layout

```text
app/              Static browser app assets for the Site Circle
program-circle/   Bounded v0 programmed Site Circle AML compatibility path
program-fact-ledger/
                  Mainnet-shaped AML fact ledger candidate
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

Collects Octra supply, Octra bridge/vault state, Ethereum wOCT supply, relayer recovery data, and source metadata. It builds canonical JSON, writes raw evidence locally, prepares the configured AML `record_snapshot_*` call, submits only when explicitly enabled, then verifies program readback.

**AML Program**

Stores the latest canonical snapshot, evidence manifest, source references, compact accounting facts, capsule metadata, owner/operator controls, successor-era anchors, and hash commitments. The fact-ledger path is intentionally narrow: AML owns ordering, roots, hashes, and compact history; raw evidence bodies stay outside AML.

**Gateway**

Runs as a HTTPS shim for normal browsers. It serves Circle assets, reads program state, verifies hashes, exposes `/api/latest`, `/api/history`, evidence routes, health, site-integrity, and native-readiness endpoints.

**Browser App**

Renders the accounting view, trend window, provenance links, raw evidence references, and proof references. It re-derives hashes and conservation checks before trusting production values, and it does not use sample values in production mode.

**History Lab**

An optional lab can mirror verified AML history into an `octra-sqlite` Circle database for interactive querying at `/lab/history`. The mirror is explicitly derived and non-canonical: AML remains the ledger, and the lab exists to exercise query/discovery patterns without widening the production state model. It is disabled by default; mainnet enablement requires an explicit production flag.

## Trust Model

Octra Vitals is a reconciliation and proof surface, not a consensus light client.

It trusts configured RPC endpoints for observation, then preserves exactly what was observed through canonical payloads, evidence hashes, source references, raw evidence, and AML commitments. A normal browser can verify internal consistency and detect gateway tampering, but it still receives transport through the gateway. A Circle-native client can verify against the programmed Circle state surface directly. When multiple program RPCs are configured, reads and write preflight/readback must agree. If only one canonical mainnet RPC exists, the system can run with one RPC while keeping the comparison path ready.

Bridge residuals are intentionally visible. A positive value for `locked - wOCT - unclaimed` is treated as reconciliation data, not automatically as a Vitals health issue. Red health is reserved for invalid identities such as overclaims, cap/burn mismatch, vault shortfall, missing required fields, or unit/decimal mismatch.

## History Model

The fact-ledger model stores one compact core accounting fact per snapshot. Facts are fixed-width rows grouped into deterministic UTC half-day capsules. Each capsule has a body, metadata, body hash, row-root range, and capsule-chain root so a verifier can check a historical slice without replaying all history from genesis.

History can span multiple AML eras. The active era points to its predecessor by program id and commits to the predecessor final root/index. `/api/history` exposes the visible timeline plus proof metadata for each era boundary; continuity is accepted only when the predecessor root and successor anchor verify.

The latest snapshot remains richer than historical rows. Full latest payload, evidence manifest, and source references stay AML-readable. Older raw RPC bodies are linked by hash and served from host/archive storage for forensic inspection, not stored permanently in AML.

## History Lab

The optional History Lab is a query surface at `/lab/history`. A separate mirror worker reads verified AML history and writes missing rows into an `octra-sqlite` Circle database, then the gateway exposes bounded read-only SQL for inspection and experimentation.

The lab is deliberately non-canonical and can lag or fail without affecting snapshot collection or the public Vitals page. AML remains the ledger of record, and the SQLite Circle is a derived mirror for discoverability, query ergonomics, and `octra-sqlite` evaluation. In production shape, the canonical Vitals Circle carries AML plus the core web assets, the Lab Web Circle carries only the public lab assets, and the sealed Lab DB Circle carries the SQLite mirror. Lab reads do not require a token but are bounded and rate-limited; operator repair/backfill syncs do require a host-local token. Vitals does not expose raw JSON-RPC request/response traces from lab queries. Mainnet Lab exposure is opt-in and requires `VITALS_LAB_HISTORY_ALLOW_MAINNET=1`.

See `docs/lab-history-mirror.md` for schema, deployment, retention, and safety details.

## Operator Diagnostics

The host can send Telegram digests and alerts without changing the canonical data model. Digests summarize the last hour and last 24 hours: snapshot cadence, latest program-backed state, conservation status, site integrity, native readiness, traffic, diagnostic noise, raw-evidence growth, and disk usage. Alerts are fingerprinted and rate-limited so repeated conditions do not spam the operator.

Notifications are operational telemetry only. They do not write AML state, do not change Circle assets, and do not carry wallet material. Bot tokens and chat ids live only in `/etc/octra-vitals/notify.env` on the host.

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
/lab/history              optional devnet lab, when enabled
/health
```

API JSON responses are pretty-printed by default for inspection. Evidence endpoints also accept `?exact=1` when the stored file bytes need to be returned without gateway reformatting.

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
npm run fact-ledger-probe:compile
npm run fact-ledger-program:compile
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
VITALS_PROGRAMMED_CIRCLE_PROGRAM=fact-ledger
VITALS_PROGRAMMED_CIRCLE_ARTIFACT_DIR=program-fact-ledger
VITALS_RECORD_SNAPSHOT_VERSION=<matches deployed AML>
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
- `docs/lab-history-mirror.md`
- `docs/schema.md`
- `docs/ops.md`
- `docs/release-management.md`
- `docs/mainnet-deployment.md`
- `docs/costs.md`
- `docs/readiness.md`
- `docs/adr-0003-fact-ledger-history.md`
- `docs/adr-0002-aml-history-era-model.md`
- `docs/adr-0001-programmed-site-circle.md`

## Security Notes

Never commit wallet material, private keys, `.env` files, Telegram tokens, raw host secrets, or production updater env files.

The gateway env should contain public/non-secret config only. Snapshot-writing keys belong in `/etc/octra-vitals/updater.env` on the host, owned by root, with minimal permissions. The launch posture uses a dedicated low-balance production wallet and keeps the path open for later operator rotation.

Raw evidence is intentionally public when linked from the app or API. Evidence source URLs must therefore stay public-safe: no credentials, query tokens, fragments, private hosts, or non-HTTPS sources. The producer and gateway enforce public-host and byte-size guardrails before collecting or serving raw evidence.

## License

MIT.
