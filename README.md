# Solstice Cranker

**If `submitShares(Q)` does not land before quarter Q+1 binds, quarter Q's share map is
lost permanently.** There is no retry, no recovery and no governance action that puts it
back. The contract reverts `NotLatestQuarter(Q)` and that quarter's orchestrators never
receive their share of the service stream. A cranker that stops running also blocks
`RemoveOrchestrator`, which reverts `PendingShares(q)` while the current quarter's share
map is outstanding.

Nothing on chain sends that transaction. Someone has to.

This repository is that someone: a script, an hourly schedule, a funded wallet, and an
alert when a crank does not land.

---

## What it does

Solstice has two permissionless quarterly calls. Permissionless means anyone can send
them — no multisig approval, no orchestrator key, no privileged role. It also means
nobody is responsible for sending them, which is the problem.

| Call | Contract | Deadline | What happens if it is late |
| :-- | :-- | :-- | :-- |
| `submitShares(Q)` | Service Rewards Actor (SRA) | Hard. Must land before quarter Q+1 binds. | Reverts `NotLatestQuarter(Q)`. Quarter Q's share map is never installed, permanently. |
| `quarterlyGateCheck()` | Stream Weight Actor (SWA) | None. | Nothing breaks, but the downstream weight step is delayed by exactly as long as the call is late. |

Each hour the cranker reads chain state, works out whether either call is due, and sends
only the ones that are. A run with nothing due reads, reports, sends nothing and exits 0.
That is the normal outcome of almost every run.

The submission window for `submitShares(Q)` is exactly one quarter wide: it opens when
quarter Q binds and closes when quarter Q+1 binds. On mainnet that is about 91 days. In
the calibnet rehearsal, where a "quarter" is one day, it is 24 hours. Hourly cron gives
24 attempts inside the tightest window the project ever runs.

## Status: live on calibnet for the rehearsal

The SRA and SWA are deployed on calibnet, and this repository cranks them on a schedule.

| | Address |
| :-- | :-- |
| SRA | `0x0339f205314C8210AF7Cb075d1A96D012e7896a9` |
| SWA | `0x66C11A9F6dfEC3c1557958cF9f575a023EB01421` |

These are the contracts the [watchtower](https://solsticewatchtower.eth.limo) reads, for the
rehearsal that activates Mon 28 Sep 2026 13:00 UTC. They were redeployed for that plan: an
earlier pair for a 23 September start is still live on chain but superseded, and nothing reads
it. The same addresses are published for mainnet, where the first quarter binds in January 2027.

Addresses come from upstream's `deployments.json`. If they move again, run
`npm run sync:deployments -- --write` and then `npm run preflight`.

## Quickstart

You need Node 20 or newer and nothing else.

```bash
git clone https://github.com/decentramike/solstice-cranker
cd solstice-cranker
npm ci                 # npm ci --omit=dev on a production host; see below
cp .env.example .env   # then fill in NETWORK, RPC_URL, CRANKER_PRIVATE_KEY
npm run preflight      # checks RPC, chain id, addresses, wallet, balance. Sends nothing.
npm run crank:dry      # decides what it would do, and does not do it
```

`npm run preflight` is the command to run first and the command to run when something
looks wrong. It never broadcasts a transaction.

To get a wallet, read [`docs/WALLET.md`](docs/WALLET.md) before doing anything else. You
generate the key yourself, locally. It never goes through a chat, an issue, or a PR.

**Production installs use `npm ci --omit=dev`.** The cranker's only runtime dependency is
ethers v6. Hardhat, the local devnet and the dashboard are dev dependencies and must never
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
| `CRANK_PAUSED` | variable | no | Any truthy value: read state and report, send nothing. The big red switch. |
| `CRANK_PAUSED_WINDOWS` | variable | no | Exact `start/end` ISO 8601 windows, explicit timezone required. The rehearsal's: `2026-10-03T19:00:00Z/2026-10-05T13:25:00Z`. |
| `CRANK_DISABLED_DAYS` | variable | no | Comma-separated UTC dates on which not to send. Day-granular; prefer `CRANK_PAUSED_WINDOWS`. |
| `CRANK_DISABLED_WEEKDAYS` | variable | no | Same idea, recurring: `Saturday,Sunday`. |
| `CRANK_DRY_RUN` | dispatch input | no | Simulate and report, broadcast nothing. |
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

- **dry_run** — read state, decide, report, broadcast nothing. Use this first against a
  new deployment.
- **network** — override `NETWORK` for that run only. Leave blank for normal use.

A manual run also counts as repository activity, which matters (see *Keeping the schedule
alive* below).

**Locally:**

```bash
npm run crank:dry    # decide only
npm run crank        # decide and send
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

Both honour `CRANK_PAUSED` and `CRANK_DISABLED_DAYS`. Pausing is an operator decision, not a
condition to be clever about, and the rehearsal's no-crank weekends depend on it.

`CRANK_SIMPLE_WINDOW_HOURS` (default 6) is how long after a quarter binds the simple cranker
keeps trying. Wider than one hour on purpose: the cron fires hourly, so a single missed run
would otherwise lose the quarter. Repeat sends inside the window just revert.

## Pausing for the rehearsal weekend

Phase 1 is the calibnet rehearsal: activation **Monday 28 September 2026, 13:00 UTC** (epoch
4109134), eleven daily quarters, Q1 on Tuesday 29 September through Q11 on Friday 9 October.
The plan is "Rehearsal Plan for Sept 28th start" in the rehearsal doc; an earlier 23 September
plan, and the contracts deployed for it, are superseded.

Two clocks matter and they are six hours apart:

- **Quarter boundary — 13:00 UTC.** Posting for quarter Q opens only once Q has ended, so each
  quarter's cycle runs on the *following* day.
- **Binding — 19:00 UTC.** Boundary + `POST_PERIOD` (2 h) + `VERIFICATION_WINDOW` (4 h). This is
  when `submitShares(Q)` becomes callable, so it is when the cranker acts.

**One no-crank weekend:** Q5 binds Sat 3 Oct 19:00 ("weekend post, no cranks") and Q6 binds
Sun 4 Oct 19:00 ("weekend fail, no action"). Monday 5 October is the catch-up.

Set the repository variable **`CRANK_PAUSED_WINDOWS`** to:

```
2026-10-03T19:00:00Z/2026-10-05T13:25:00Z
```

That is an exact window, not two calendar days, and both ends matter:

- **It starts at Sat 19:00, not midnight.** Q4's window closes the instant Q5 binds. If GitHub
  dropped Friday's runs, Saturday daytime is Q4's last chance, and a midnight start would throw
  it away for nothing.
- **It ends Mon 13:25, not 00:00.** Monday's temporary stream takes effect at 13:00, and the
  plan's `QuarterlyGateCheck(Q5)` at 13:45 is supposed to *revert* for lack of headroom.
  Released at midnight, the cranker would check Q5 thirteen hours early, before the stream
  exists — and it could pass, changing the scenario's outcome rather than just its timestamp.

The workflow still runs, still reads chain state and still reports inside the window. It just
sends nothing. `CRANK_DISABLED_DAYS` still works but is day-granular and is the wrong shape here.

**The weekend permanently destroys one share map, by design.** Monday's single `SubmitShares`
installs Q6's map and supersedes Q5's. The cranker reports that as a critical alert and exits 1.
That is the rehearsal working, not the cranker failing — see `docs/RUNBOOK.md` before anyone
escalates it.

Full procedure, including which scripted rows need a human, is in
[`docs/RUNBOOK.md`](docs/RUNBOOK.md).

## Reverts you should expect

Most reverts here are normal. The cranker decodes each one and exits 0 for all of these:

| Revert | Means | Cranker does |
| :-- | :-- | :-- |
| `NotBound(q)` | Too early. Quarter q's volumes have not bound yet. | Nothing. Tries again next hour. Exit 0. |
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
2. **Open issues labelled `cranker-watchdog`.** The watchdog runs every 6 hours, checks the
   chain independently of the crank job, and opens or updates an issue when a crank is
   overdue. It closes the issue itself when things recover.
3. **`npm run preflight` locally.** Confirms RPC reachability, chain id, contract addresses,
   wallet address and balance. Sends nothing. This is what catches an empty wallet, a dead
   RPC endpoint or a zero contract address.
4. **[`docs/RUNBOOK.md`](docs/RUNBOOK.md) → "What each alert means."** One entry per alert,
   with the action to take.

## Keeping the schedule alive

GitHub disables scheduled workflows in a public repository after 60 days with no repository
activity. On mainnet there are roughly 8 cranks a year, so a 60-day quiet stretch between
quarters is the normal state, not an exception — the crank workflow would be switched off
before the next crank was even due, and the first symptom would be a missed
`submitShares(Q)`.

`.github/workflows/keepalive.yml` prevents this by writing a timestamp into
`.github/keepalive.txt` once a week and pushing that commit. Nothing reads the file. The
commit is the point. If a workflow does get disabled anyway: Actions → the workflow →
`...` → **Enable workflow**.

## Repository layout

```
.github/workflows/
  solstice-crank.yml   hourly crank; holds the key; contents: read only
  watchdog.yml         every 6h; independent chain check; opens an issue when overdue
  ci.yml               tests on Node 20 and 24, plus the ABI drift tripwire
  keepalive.yml        weekly repo touch so the schedules are not disabled
scripts/               crank.mjs, watchdog.mjs, preflight.mjs, sync-deployments.mjs
src/                   the shared library those scripts are built from
config/
  networks.json        the three networks and their quarter geometry
  storage-slots.json   ERC-7201 slots read directly, because they have no getter
abi/                   generated from upstream contracts; regenerate, never hand-edit
test/                  unit tests
devnet/                local chain, contract prep, rehearsal and demo. Never on a cron runner.
dashboard/             read-only demo dashboard. Devnet only.
docs/
  RUNBOOK.md           operations: secrets, alerts, pausing, rotation, escalation
  WALLET.md            generating and funding the cranker wallet. Read before you touch a key.
  DEMO.md              how to run the local demo for an audience
  DATA-CONTRACT.md     devnet/demo internal seam. Not production.
PATCHES/               prepared changes to the governance repo. Not pushed.
```

## Links

- Source issue: [filecoin-project/solstice#68](https://github.com/filecoin-project/solstice/issues/68) — design and run a Solstice cranker
- Deployment: [filecoin-project/solstice#51](https://github.com/filecoin-project/solstice/issues/51) — calibration contract deployment (done)
- [Solstice watchtower](https://solsticewatchtower.eth.limo) — reads the same SRA and SWA; every successful crank appears in its P2 panel
- [FIP-0118](https://github.com/filecoin-project/FIPs/blob/master/FIPS/fip-0118.md) — the protocol rules these calls implement
- [Solstice-Governance](https://github.com/filecoin-project/Solstice-Governance) — the operational layer; §2.2.9 and §2.3.10 are the oversight duties this automation serves

## Ownership

Owner: **@decentramike** (Michael Madoff, Filecoin Foundation). The named backup and the
escalation path are in the DRI table in [`docs/RUNBOOK.md`](docs/RUNBOOK.md).
