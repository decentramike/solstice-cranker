# Solstice Cranker

**If `submitShares(Q)` does not land before quarter Q+1 binds, quarter Q's share map is
lost permanently.** There is no retry, no recovery and no governance action that puts it
back. The contract reverts `NotLatestQuarter(Q)` and that quarter's orchestrators never
receive their share of the service stream. A cranker that stops running also blocks
`RemoveOrchestrator`, which reverts `PendingShares(q)` while the current quarter's share
map is outstanding.

Nothing on chain sends that transaction. Someone has to.

This repository is that someone: a script, a schedule that wakes up only when a crank is
due, two funded gas wallets, and an alert when something does not land. It also sends the
f02 `Claim` that pays the service stream out to the share map's wallets.

---

## What it does

Three permissionless calls. Permissionless means anyone can send them -- no multisig, no
orchestrator key, no privileged role. It also means nobody is responsible for sending them,
which is the problem.

| Call | Where | Deadline | What happens if it is late |
| :-- | :-- | :-- | :-- |
| `submitShares(Q)` | Service Rewards Actor (SRA) | Hard. Must land before quarter Q+1 binds. | Reverts `NotLatestQuarter(Q)`. Quarter Q's share map is never installed, permanently. |
| `quarterlyGateCheck()` | Stream Weight Actor (SWA) | None. | The w2 weight step is delayed by exactly as long as the call is late. |
| `Claim(2, wallets)` | f02 (native message, method 4045527845) | None. | The wallets' entitlement waits in f02. Nothing is lost. |

### When it runs

**The crank runs only inside a window.** For quarter Q the window opens one hour before Q
binds (binding is when `submitShares(Q)` becomes callable) and closes when `submitShares(Q)`
and the gate check due at Q have both landed on chain. Every trigger runs for the first 72
hours, then one hour in six until the work lands. Time alone never closes a window. Outside
a window, a gate step reads `config/schedule.<network>.json` and exits in seconds: no
`npm ci`, no key.

**The Claim runs weekly** (Wednesday 14:41 UTC) **and once 24 hours after each
`submitShares` lands.** It discovers every wallet owed something in stream 2 from f02's own
state, simulates, and sends a batch only if it pays more than 0 and its fee is at most
0.05 FIL and at most 10% of the payout. Claim pays only the wallets in f02's share map
(FIP-0118 §2.4.5), so the sender cannot redirect funds.

The Mainnet schedule, generated from chain, is in
[`docs/RUNBOOK.md`](docs/RUNBOOK.md#mainnet-schedule). Q1 binds **Thu 28 Jan 2027 20:27
UTC**; the cranker first wakes an hour before.

## Status: Mainnet-ready, sends off

| | Address |
| :-- | :-- |
| SRA | `0x0339f205314C8210AF7Cb075d1A96D012e7896a9` |
| SWA | `0x66C11A9F6dfEC3c1557958cF9f575a023EB01421` |
| f02 | `f02` (Mainnet), `t02` (Calibnet) |

The same SRA and SWA addresses exist on Calibnet and Mainnet. Mainnet activates **Mon 19 Oct
2026 13:00 UTC, epoch 6470280** (`quarterStart(0)` on chain). Until the repository variable
`MAINNET_SEND_ENABLED` is set, every Mainnet run is a dry run. Addresses and geometry come
from upstream `deployments.json`; `npm run schedule` refuses to write a schedule when config,
upstream and chain disagree.

## Quickstart

You need Node 20 or newer and nothing else.

```bash
git clone https://github.com/decentramike/solstice-cranker
cd solstice-cranker
npm ci                 # npm ci --omit=dev on a production host; see below
cp .env.example .env   # then fill in NETWORK and RPC_URL; keys only where they will send
npm run preflight      # RPC, chain id, network name, addresses, f02, balances. Sends nothing.
npm run schedule       # regenerates config/schedule.<network>.json from chain
npm run crank:dry      # decides what it would do, and does not do it
npm run claim:dry      # discovers and simulates the Claim, and does not send it
```

`npm run preflight` is the command to run first and the command to run when something
looks wrong. It never broadcasts a transaction.

To get a wallet, read [`docs/WALLET.md`](docs/WALLET.md) before doing anything else. There
are two: the cranker's EVM key and the Claim's f1 key, never the same key. You generate
them yourself, locally. They never go through a chat, an issue, or a PR.

**Production installs use `npm ci --omit=dev`.** The runtime dependencies are ethers v6 and,
for the native Claim message, `@noble/curves` and `@noble/hashes` (pinned). Hardhat, the local devnet and the dashboard are dev dependencies and must never
be installed on the machine holding the key.

## Configuration

Everything is environment variables. Locally they come from `.env`. In GitHub Actions they
come from repository secrets and variables — exact names and exact places in the UI are in
[`docs/RUNBOOK.md`](docs/RUNBOOK.md). [`.env.example`](.env.example) is the annotated
version; this table is the short one. Three further variables (`CRANK_CONFIRMATIONS`,
`CRANK_LOG_LEVEL`, `WATCHDOG_GRACE_EPOCHS`) are read by the code but not yet listed in
`.env.example` — see the runbook.

| Variable | In CI | Required | What it does |
| :-- | :-- | :-- | :-- |
| `NETWORK` | variable | yes | Which entry of `config/networks.json` to use: `devnet`, `calibnet` or `mainnet`. |
| `RPC_URL` | secret | yes | Filecoin JSON-RPC endpoint. Use a public or rate-limited one. Never a node whose RPC exposes admin or wallet methods. |
| `CRANKER_PRIVATE_KEY` | secret | yes | The gas wallet. Holds nothing but FIL for fees, and has no role or permission on either contract. |
| `SRA_ADDRESS` | variable | no | Overrides the committed SRA address. Set this when the deployment lands or moves. |
| `SWA_ADDRESS` | variable | no | Same, for the SWA. |
| `CLAIM_PRIVATE_KEY` | secret | for Claim | The Claim gas wallet, an f1 key. Only the Claim workflow gets it. Never the cranker key. |
| `CLAIM_ADDRESS` / `CRANKER_ADDRESS` | variables | no | Public addresses of the two wallets, so every job checks both balances without holding the other key. |
| `CRANK_PAUSED` | variable | no | Any truthy value: read state and report, send nothing. Stops the crank and the Claim. |
| `MAINNET_SEND_ENABLED` | variable | for Mainnet sends | Unset: every Mainnet run is a dry run. |
| `CRANK_DRY_RUN` / `CLAIM_DRY_RUN` | dispatch input | no | Simulate and report, broadcast nothing. |
| `CLAIM_MAX_FEE_FIL` / `CLAIM_MAX_MESSAGES` | variables | no | Claim guards. Defaults 0.05 FIL per message, 3 messages per run. |
| `CRANK_MAX_GATE_CATCHUP` | variable | no | Cap on `quarterlyGateCheck()` calls in one run while catching up. Default 8. |
| `CRANK_MIN_BALANCE_FIL` | variable | no | Low-balance warning threshold. Defaults to the network's `minBalanceFil`. |
| `ALERT_TRANSPORT` | variable | no | `console` (default), `sendgrid`, `resend`, `webhook`. Comma-separate for several. |
| `ALERT_EMAIL_TO` / `ALERT_EMAIL_FROM` | variables | no | Alert recipient and sender. |
| `SENDGRID_API_KEY` / `RESEND_API_KEY` / `ALERT_WEBHOOK_URL` | secrets | no | Credentials for whichever transport is configured. |

With no alert transport set, alerts go to stdout and the Actions job summary. That is a
real fallback, not a placeholder — the watchdog opens a GitHub issue independently.

Two values in `config/networks.json` cannot be checked against the chain: `postPeriod` and
`verificationWindow` are `private immutable` on the SRA and have no getter. Everything else
in the quarter geometry is read from chain at runtime (`EPOCHS_PER_QUARTER()` is public,
and the activation epoch is recovered from `quarterStart(0)`). If those two config values
ever drift from what the contract was deployed with, the cranker's idea of the schedule
drifts with them. It cross-checks the resulting schedule against
`aggregatedFilecoinPayVolume()` on every run and alerts on divergence, but it cannot
verify them directly. Treat a change to either as a deployment-level change.

## Running a crank by hand

**In GitHub:** Actions → *Solstice crank* → **Run workflow**. Two inputs:

- **dry_run** — read state, decide, simulate, broadcast nothing.
- **ignore_window** — run even outside a crank window. A dispatch without it (which is what
  the external 15-minute timer sends) goes through the gate like a scheduled run.

*Solstice Claim* → **Run workflow** has **dry_run**.

**Locally:**

```bash
npm run crank:dry    # decide only
npm run crank        # decide and send
npm run claim:dry    # discover and simulate the Claim
```

## Two crankers

There are two entrypoints. They send the same two calls and you can run either, or both.

| | `npm run crank` | `npm run crank:simple` |
| :-- | :-- | :-- |
| Decides what is due by | reading chain state | arithmetic on the clock |
| Contract reads per run | ~6 | **0** |
| Gas when nothing is due | none — it simulates first | one reverted transaction |
| Detects a permanently lost quarter | yes | no |
| Notices a wrong `postPeriod` | yes, alerts on it | no — sends at the wrong time |
| Can be stopped by an unreadable RPC | harder than it was, but yes | no |

**`crank` is the default.** It knows what it is doing: it reads `lastSubmittedQuarter`, the
gate pointer, and the chain's own view of the latest bound quarter, so it sends only what is
actually due, spends nothing when nothing is due, and can tell you a quarter has been lost.

**`crank:simple` is the fallback.** It reads nothing at all. The schedule is
`genesisUnix + (activationEpoch + Q × epochsPerQuarter + postPeriod + verificationWindow) × 30`,
which is four numbers already in `config/networks.json` and a clock. When that time arrives it
sends both calls and reports whatever comes back. A revert is the expected answer when a call
was not due, and is not treated as a failure.

Use it when the read path is the problem — a rate-limited RPC, a node serving stale or
malformed responses — because a cranker that never asks a question cannot be stopped by a bad
answer. The cost is gas on reverts and a loss of every diagnostic that needs chain state.

To switch, change one line in `.github/workflows/solstice-crank.yml`:

```yaml
- run: node scripts/crank-simple.mjs   # was: node scripts/crank.mjs
```

Both honour `CRANK_PAUSED`. Pausing is an operator decision, not a condition to be clever
about.

`CRANK_SIMPLE_WINDOW_HOURS` (default 6) is how long after a quarter binds the simple cranker
keeps trying. Wider than one hour on purpose: the cron fires hourly, so a single missed run
would otherwise lose the quarter. Repeat sends inside the window just revert.

## Reverts you should expect

Most reverts here are normal. The cranker decodes each one and exits 0 for all of these:

| Revert | Means | Cranker does |
| :-- | :-- | :-- |
| `NotBound(q)` | Too early. Quarter q's volumes have not bound yet. | Nothing. Tries again on the next run in the window. Exit 0. |
| `AlreadySubmitted(q)` | Someone else sent it first. The call is permissionless; this is the system working. | Nothing. Exit 0. |
| `StepsComplete()` | The gate has taken all 8 steps. It is closed for good and will never need calling again. | Stops calling the gate. Exit 0. |
| A gate write inside its SWA hold | The previous gate write is still in its timelock. Only happens when checks run late and close together. | Retries after the hold. Exit 0. |

One revert is not normal:

| Revert | Means | Cranker does |
| :-- | :-- | :-- |
| **`NotLatestQuarter(q)`** | **The window closed. Quarter q's share map is gone and cannot be recovered.** | Exit 1, critical alert. |

`NotLatestQuarter` is not a retry condition. There is nothing to retry. The response is
escalation and documentation — see *What to do if `NotLatestQuarter` fires* in
[`docs/RUNBOOK.md`](docs/RUNBOOK.md).

## When something breaks

Start here, in this order:

1. **Actions → Solstice crank → the most recent run.** The step log names the decision it
   made and decodes any revert. The job summary carries the same thing.
2. **Open issues labelled `cranker-watchdog`.** The watchdog runs every 6 hours inside a
   window and daily outside one, checks the chain and both wallet balances independently of
   the crank job, and opens or updates an issue when a crank is overdue or a wallet is low.
   It closes the issue itself when things recover.
3. **`npm run preflight` locally.** Confirms RPC reachability, chain id, contract addresses,
   wallet address and balance. Sends nothing. This is what catches an empty wallet, a dead
   RPC endpoint or a zero contract address.
4. **[`docs/RUNBOOK.md`](docs/RUNBOOK.md) → "What each alert means."** One entry per alert,
   with the action to take.

## Keeping the schedule alive

GitHub disables scheduled workflows in a public repository after 60 days with no repository
activity. On mainnet a crank window opens about every 91 days, so a 60-day quiet stretch
between quarters is the normal state, not an exception — the crank workflow would be switched off
before the next crank was even due, and the first symptom would be a missed
`submitShares(Q)`.

`.github/workflows/keepalive.yml` prevents this by writing a timestamp into
`.github/keepalive.txt` once a week and pushing that commit. Nothing reads the file. The
commit is the point. If a workflow does get disabled anyway: Actions → the workflow →
`...` → **Enable workflow**.

## Repository layout

```
.github/workflows/
  solstice-crank.yml   gate, then the crank inside a window; holds CRANKER_PRIVATE_KEY; contents: read
  solstice-claim.yml   gate, then Claim weekly and 24h after each submit; holds CLAIM_PRIVATE_KEY
  watchdog.yml         6h in a window, daily outside; chain and balance check; opens an issue
  ci.yml               tests on Node 20 and 24, plus the ABI drift tripwire
  keepalive.yml        weekly repo touch so the schedules are not disabled
scripts/               crank.mjs, claim.mjs, gate.mjs, schedule.mjs, watchdog.mjs, preflight.mjs,
                       crank-simple.mjs, sync-deployments.mjs
src/                   the shared library; src/filecoin/ is the native side (addresses, CBOR,
                       message signing, Lotus client, f02 decoding); src/windows.mjs the gate
config/
  networks.json        the three networks and their quarter geometry
  schedule.*.json      generated by `npm run schedule`; the gate reads only this
  storage-slots.json   ERC-7201 slots read directly, because they have no getter
abi/                   generated from upstream contracts; regenerate, never hand-edit
test/                  unit tests
devnet/                local chain, contract prep, rehearsal, demo, and fake-lotus.mjs (f02 for
                       Claim tests). Never on a cron runner.
dashboard/             read-only demo dashboard. Devnet only.
docs/
  RUNBOOK.md           operations: secrets, alerts, pausing, rotation, escalation
  WALLET.md            generating and funding both wallets. Read before you touch a key.
  DEMO.md              how to run the local demo for an audience
  DATA-CONTRACT.md     devnet/demo internal seam. Not production.
PATCHES/               prepared changes to the governance repo. Not pushed.
```

## Links

- Source issue: [filecoin-project/solstice#68](https://github.com/filecoin-project/solstice/issues/68) — design and run a Solstice cranker
- Deployment: [filecoin-project/solstice#51](https://github.com/filecoin-project/solstice/issues/51) — calibration contract deployment (done)
- [Solstice watchtower](https://solsticewatchtower.eth.limo) — reads the same SRA, SWA and f02; every successful crank and Claim appears in its P2 panel
- [FIP-0118](https://github.com/filecoin-project/FIPs/blob/master/FIPS/fip-0118.md) — the protocol rules these calls implement
- [Solstice-Governance](https://github.com/filecoin-project/Solstice-Governance) — the operational layer; §2.2.9 and §2.3.10 are the oversight duties this automation serves

## Ownership

Owner: **@decentramike** (Michael Madoff, Filecoin Foundation). The named backup and the
escalation path are in the DRI table in [`docs/RUNBOOK.md`](docs/RUNBOOK.md).
