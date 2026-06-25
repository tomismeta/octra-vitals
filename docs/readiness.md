# Readiness Gates

This checklist defines what must be true before a devnet-soaked candidate can be promoted to mainnet.

## Code And AML

- `npm run native:verify` passes.
- Active programmed-Circle AML compiles `safe` and formally verified.
- Live Circle code hash matches the compiled artifact.
- Required view/write methods are exposed.
- Owner/operator controls are configured as intended.
- Non-owner/non-operator Circle calls are rejected by a devnet negative probe.

## Runtime

- `/api/latest` is program-backed, fresh, and conservation-aware.
- `/api/history` is AML-backed and exposes proof metadata.
- `/api/history.proof.proof_scope` honestly states whether the response is a full-chain proof or a tail-window proof.
- `/api/site-integrity` reports Circle asset parity.
- `/api/native-readiness` reports `native_ready`.
- Configured program RPCs agree, or the deployment explicitly accepts one canonical RPC.

## History

- Snapshot cadence is stable.
- At least one fresh capsule has sealed in the active era.
- Prefer multiple fresh capsule seals before mainnet.
- If auxiliary fact support is included in the AML, devnet has registered an auxiliary family and written at least one `aux_count > 0` snapshot.
- Cross-era reads remain continuous.
- Era boundaries verify against predecessor roots, not only index continuity.
- History read latency and RPC count are acceptable for expected UI horizons.

## Operations

- `release:plan` has been run against the target environment.
- Devnet/stage rehearsal report matches the candidate commit.
- Updater timer behavior is understood and paused during writes that share the operator wallet.
- Raw evidence retention and disk growth are within host budget.
- Telegram/operator diagnostics are green or intentionally disabled.

## Security

- Wallet material is not in git.
- Signer env is root-owned on the host.
- Mainnet uses a dedicated low-balance wallet at launch.
- SSH host keys and deployment approvals are protected.
- Gateway env contains only public/non-secret configuration.

## Mainnet Approval

Mainnet remains no-go until the user explicitly approves the mainnet write after the above gates pass.
