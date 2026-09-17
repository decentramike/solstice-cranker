# Running the demo

A ten-minute walkthrough of the cranker on a local chain, for an audience. It runs a real
devnet, deploys the real upstream contracts, and cranks them with the real
`scripts/crank.mjs` — the same code path that runs in production. Nothing is faked; the
only thing that is local is the chain.

This is written so that someone who did not build it can run it. If you are that person,
do the dry run in *Before you start* the day before, not five minutes before.

---

## What the demo is for

It answers three questions, in this order:

1. **Why does this need to exist?** Two Solstice calls are permissionless, so anyone can
   send them, so nobody does. The demo shows a quarter passing with nobody cranking, and
   the share map being lost.
2. **What does the automation actually do?** It watches chain state and sends the two calls
   when, and only when, they are due.
3. **What happens when it goes wrong?** Missed windows, expected reverts, alerts.

The third part is the one that convinces people. Do not cut it for time.

---

## Before you start

You need Node 20+ and roughly 2 GB of disk for the compiler and artifacts. First run pulls
the upstream contracts and downloads solc, so it needs network access and a few minutes.

```bash
cd solstice-cranker
npm ci                    # full install: the demo needs hardhat, unlike production
npm run contracts:build   # clones upstream solstice, compiles it. Slow the first time.
```

Then, once, end to end, on your own machine before there is an audience:

```bash
npm run demo
```

Leave yourself a way out: know how to stop it (`Ctrl-C` in the terminal running it) and how
to start again from scratch (stop, `rm -f .devnet-state.json`, start again).

**Two things to say out loud at the start, because someone will ask and it is better coming
from you:** this is a local chain, not calibnet or mainnet; and the SRA and SWA are not
deployed on any public network yet, which is tracked as
[solstice#51](https://github.com/filecoin-project/solstice/issues/51).

---

## Running it

```bash
npm run demo
```

That starts the local devnet, deploys the contracts to it, starts the devnet server on
port 8787, and opens the dashboard. Leave the terminal visible on a second screen if you
have one — the log lines are part of the story.

Two other entry points, both useful and neither required for the demo:

| Command | What it does |
| :-- | :-- |
| `npm run rehearsal` | Replays all fourteen rehearsal days, including the Q5/Q6 weekend, without you clicking anything. Good for a recording; too fast to narrate live. |
| `npm run crank:dry` | The cranker's decision for the current state, printed, with nothing sent. Good for a one-screen answer to "what would it do right now?" |

---

## What is on screen

The dashboard is read-mostly. Everything on it is derived from chain state, except the run
records, which come from the cranker itself.

| Panel | What it shows | The point it makes |
| :-- | :-- | :-- |
| **Chain** | Current epoch, chain id, connection state. | Everything else is a function of the epoch. This is the clock. |
| **Quarters** | Current quarter, the phase — `posting`, `verification`, `bound` — the quarter start, the binding epoch, and epochs until the next phase. | The crank is not "every 90 days". It is "after this quarter binds, and before the next one does." |
| **SRA** | `lastSubmittedQuarter`, the quarter now due, the deadline epoch, and whether it is at risk. | This is the countdown that matters. When `atRisk` goes true, a share map is about to be lost. |
| **SWA** | `lastCheckedQuarter`, steps taken out of 8, the next volume threshold. | The gate is a ratchet: 8 steps and then it is closed for good. |
| **Wallet** | The cranker address and its FIL balance. | It is a gas wallet. No role, no permission. Say this while it is on screen. |
| **Runs** | Newest first: what each run decided and why, with transaction hashes. | Most runs send nothing. That is the normal state and the thing people find surprising. |
| **Events** | `SharesSubmitted`, `QuarterlyGateCheckResult`, `FvmActorCall`, newest first. | The chain's own record, independent of the cranker's log. |
| **Alerts** | Severity, title, body. | What a human would actually receive. |

Two controls exist, and both are devnet-only — neither has any equivalent in production.
Say so when you use them:

- **Advance** — mines N blocks, which is how a two-hour devnet quarter becomes a keypress.
- **Pause** — the weekend switch. On a real deployment this is the `CRANK_PAUSED`
  repository variable.

---

## The demo, beat by beat

Roughly ten minutes. Times are the narration, not the machine.

### 1. The setup (1 min)

Start on the **Quarters** and **SRA** panels.

> "Solstice has two calls that have to happen every quarter. Both are permissionless —
> anyone can send them, no multisig, no orchestrator key. Which means nobody is assigned to
> send them. Right now, on this chain, nobody has."

Point at `lastSubmittedQuarter`. Point at the deadline epoch.

### 2. Nothing is due yet (1 min)

Click **Crank** once, without advancing anything.

The run appears in **Runs** with decision `skipped` and reason `NotBound`. Exit code 0.

> "It looked, it decided nothing was due, it sent nothing, it exited clean. That is what
> almost every run looks like. Twenty-four runs a day, and most of them do nothing."

This beat is quiet on purpose. It is the one that establishes the cranker is not spraying
transactions at the chain.

### 3. The window opens (2 min)

**Advance** past the posting period and the verification window — on this devnet that is
160 epochs; advancing a full quarter (240) is easier to say out loud.

Watch the phase in **Quarters** move to `bound`.

Click **Crank**.

Now two transactions go out. **Events** picks up `SharesSubmitted` and
`QuarterlyGateCheckResult`. The SWA step counter moves. **Runs** shows decision `sent`,
outcome `landed`, with transaction hashes.

> "The quarter bound, so the cranker sent both calls. This is the entire job."

### 4. Someone else got there first (1 min)

Click **Crank** again immediately.

`AlreadySubmitted`. Exit 0.

> "It is permissionless, so anyone can send it. If a community member beats the cranker to
> it, the cranker notices and stands down. That is not an error — that is the property we
> want. The automation is a backstop, not a gatekeeper."

### 5. The weekend nobody cranks (2 min)

This is the part the rehearsal is designed around, so give it room.

Toggle **Pause**. Advance two full quarters.

Click **Crank** during the paused stretch: it reads state, reports, sends nothing. Note in
the log that it says *why* it is not sending.

Un-pause. Click **Crank**.

`NotLatestQuarter`. Exit code 1. A critical alert appears in **Alerts**.

> "That quarter's share map is gone. Not delayed — gone. The contract only ever accepts the
> latest bound quarter, so there is no resend, no recovery, no governance action that puts
> it back. The orchestrators who earned a share of that quarter do not get one.
>
> This is exactly the failure the calibnet rehearsal tests on purpose, over the weekend of
> the 27th and 28th of September. We switch the cranker off and find out what breaks while
> it is still test FIL."

Let the alert sit on screen while you say the last sentence.

### 6. The gate closes (1 min)

Advance quarters and crank until the SWA step counter reaches 8.

`StepsComplete`. Exit 0.

> "The gate takes eight steps and then it is finished for good. After that this call never
> needs sending again. `submitShares` never stops."

### 7. Where the alert goes (1 min)

Switch to the terminal, or to GitHub if you have the repository open.

> "In production this is an hourly GitHub Actions job with `contents: read` and a gas
> wallet. A second workflow checks the chain every six hours and opens an issue if a crank
> is overdue — that one is deliberately independent, and it holds no key at all. And a
> third runs weekly for the least interesting and most important reason: GitHub switches
> off scheduled workflows in a public repo after 60 days of quiet, and on mainnet 60 days
> of quiet between quarters is normal."

### 8. Close (1 min)

> "Script, schedule, funded wallet, alert. About 8 transactions a year on mainnet. The
> thing it is protecting is a data loss that cannot be undone."

Take questions on the **SRA** panel, with the deadline visible.

---

## Questions you will get

**"What if the cranker's wallet is compromised?"** The wallet holds gas and nothing else —
no role, no permission on either contract. A thief gets the gas. The real cost is that a
drained wallet cannot pay for the next crank, which is why rotation is immediate.
[`WALLET.md`](WALLET.md).

**"What if GitHub is down when the deadline hits?"** The window is a full quarter wide —
about 91 days on mainnet, 24 hours in the rehearsal. An hourly schedule gives 24 attempts
inside the tightest window this project ever has. And the call is permissionless: anyone
can send it by hand, from any funded wallet.

**"Why not a multisig or a keeper network?"** Neither call needs authorisation, so a
multisig adds signatures to a transaction that requires none. It would add failure modes,
not remove them.

**"Is this running on mainnet now?"** No. The contracts are not deployed on any public
network yet — [solstice#51](https://github.com/filecoin-project/solstice/issues/51). The
cranker is complete, configured, and refuses to run against a zero address.

---

## If something goes wrong mid-demo

| Symptom | Fix |
| :-- | :-- |
| Dashboard shows "disconnected" | The devnet died. `Ctrl-C`, `rm -f .devnet-state.json`, `npm run demo` again. Costs about 30 seconds. |
| `npm run demo` fails on a missing artifact | `npm run contracts:build` was not run, or was interrupted. Run it. Needs network. |
| Contracts show as not deployed | The deploy step did not complete. Restart the demo from scratch. |
| State is somewhere confusing | Restart. The devnet is disposable and there is nothing in it worth keeping. |
| Everything is broken and there is an audience | `npm run crank:dry` in a terminal still tells the story: it prints the decision and the reasoning without needing a chain to be healthy. |

Have the terminal open in a second window from the start. Restarting looks like confidence
if you narrate it and like disaster if you go quiet.

## Shutting down

`Ctrl-C` in the terminal running the demo. The devnet is in-memory and leaves nothing
behind except `.devnet-state.json`, `devnet/artifacts/` and `devnet/cache/`, all of which
are gitignored. `rm -f .devnet-state.json` resets it to a fresh chain.

Nothing in the demo touches calibnet or mainnet, and the demo never reads
`CRANKER_PRIVATE_KEY` — the devnet uses its own well-known, published test accounts, which
hold nothing and exist only on the local chain.
