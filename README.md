# Octra Vitals

Octra Vitals is a self-verifying supply and bridge reconciliation instrument for Octra.

It does three things:

1. observes Octra, Ethereum, and relayer sources;
2. commits canonical snapshots into an Octra AML fact ledger;
3. serves a browser UI that re-checks the commitments before it trusts what it renders.

The goal is simple: make the important accounting relationships visible, source-linked, and hard to silently fake.

## The Idea

Do not trust the dashboard. The dashboard proves itself to you.

Octra Vitals is not a hosted database with charts on top. The canonical app assets and canonical state live in an Octra programmed Site Circle. The HTTPS gateway exists for ordinary browsers; it is a shim, not the source of truth.

In a normal browser, the page is integrity-verified and gateway-tamper-evident: it re-derives hashes, checks snapshot commitments, recomputes the conservation verdict, and links the on-chain anchors.

In a Circle-native client, the trust boundary is stronger: the client can read the programmed Circle directly and route around the gateway.

## What It Shows

The product answers a few first-class questions:

- How much OCT is in circulation?
- How much OCT is burned?
- How much OCT is encrypted?
- How much OCT is locked in the bridge vault?
- How much wOCT has been issued?
- How much locked collateral is claimable or still unclassified?
- Which snapshot, program, evidence, and source references support those numbers?

Derived values are labeled as derived. Reconciliation residuals are shown openly rather than hidden.

## Principles

**Octra native.** State and assets belong in Octra infrastructure first.

**Thin gateway.** The server adapts browser HTTP to Octra reads. It should not invent truth.

**Fail closed.** If required program-backed data is missing, stale, or inconsistent, the UI should say unavailable instead of rendering sample values.

**Hash-gated.** Payloads, evidence manifests, source references, fact rows, and history roots are committed and rechecked.

**Conservation first.** The app does not only display balances. It asks whether the accounting reconciles.

**Small canonical state.** AML stores the latest rich snapshot plus compact historical facts. Raw RPC bodies stay outside AML by content hash.

**Era-aware.** AML successors anchor to predecessor final roots and indices. History can span eras without pretending state was migrated.

**Auditable producer.** The off-chain collector is visible and hash-manifested. It observes; AML records and orders.

## Architecture

```text
Octra/Ethereum/relayer RPCs
        |
        v
Producer on host
        |
        v
Programmed Site Circle
  - AML fact ledger
  - core web assets
        |
        v
Gateway shim
        |
        v
Browser verifier
```

Optional Lab:

```text
Confirmed AML write
        |
        v
Local trigger marker
        |
        v
Lab mirror worker
        |
        v
Sealed octra-sqlite Circle
        |
        v
/lab/history query page
```

The Lab is derived and non-canonical. It exists for discovery and experimentation. The AML fact ledger remains the record.

## Data Model

Each snapshot includes canonical payload, evidence manifest, source references, compact fact rows, and proof metadata.

The latest snapshot keeps rich AML-readable bodies for provenance. Historical snapshots are retained as compact fixed-width facts grouped into deterministic capsules. Capsules carry row ranges and roots so the UI and gateway can verify history without replaying everything from genesis.

The current mainnet shape uses a fact-family ledger. Core accounting is family zero by policy. Additional scalar facts can be added without changing the core accounting row.

## Operation

The snapshot updater runs on a fixed cadence and submits only when explicitly enabled. A successful update means:

1. source data was collected;
2. canonical artifacts were written locally;
3. an AML call was prepared and submitted;
4. the transaction confirmed;
5. program readback matched the submitted snapshot.

Only after that confirmed AML readback does the updater write the local Lab trigger marker. The Lab mirror runs separately and writes only missing rows. Empty catch-up runs should not spend OCT.

## Local Development

Requires Node 22.

```bash
npm install
npm run snapshot:sample
npm run dev
```

Open:

```text
http://127.0.0.1:4173
```

Useful checks:

```bash
npm run check
npm test
npm run native:verify
```

Useful routes:

```text
/api/latest
/api/history
/api/version
/api/site-integrity
/api/native-readiness
/api/evidence/raw/<sha256>
/lab/history
/health
```

## Repository Map

```text
app/                  Browser assets
program-fact-ledger/  AML fact ledger
src/                  Producer, gateway, verification, deploy tooling
deploy/               Host and systemd automation
docs/                 Architecture and operations notes
ops/                  Lab schema and helper assets
```

Generated and runtime files are ignored:

```text
build/
dist/
data/
reports/
app/producer.audit.json
```

## Release Shape

Production should be rehearsed on devnet or stage first. The normal release path is:

1. build and test locally;
2. rehearse the same commit on devnet/stage;
3. run a read-only release plan against production;
4. publish changed assets only;
5. verify `/api/latest`, `/api/history`, site integrity, native readiness, and Lab status if enabled;
6. resume timers only after the runtime is green.

The canonical production deployment is:

- Core Vitals Circle: AML fact ledger plus core web assets.
- Lab Web Circle: optional public Lab assets.
- Lab DB Circle: optional sealed `octra-sqlite` mirror.

## Documentation

Start here:

- [Architecture](docs/architecture.md)
- [Schema](docs/schema.md)
- [Operations](docs/ops.md)
- [Release Management](docs/release-management.md)
- [Mainnet Deployment](docs/mainnet-deployment.md)
- [History Lab Mirror](docs/lab-history-mirror.md)
- [Costs](docs/costs.md)
- [Readiness](docs/readiness.md)

Key decisions:

- [ADR 0001: Programmed Site Circle](docs/adr-0001-programmed-site-circle.md)
- [ADR 0002: AML History Era Model](docs/adr-0002-aml-history-era-model.md)
- [ADR 0003: Fact Ledger History](docs/adr-0003-fact-ledger-history.md)

## Security

No wallet material belongs in git, chat, Circle assets, or public logs.

Host secrets live under `/etc/octra-vitals`. Runtime data lives under `/var/lib/octra-vitals`. The gateway should expose verification artifacts, not operator credentials. Lab reads are bounded and read-only; Lab writes are host-local operator actions.

If something cannot be verified, the product should say so plainly.

## License

MIT
