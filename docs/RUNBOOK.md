# Runbook

Operating the Solstice cranker. Everything here assumes the repository at
`https://github.com/decentramike/solstice-cranker`.

Read [`WALLET.md`](WALLET.md) before you handle a key. Read the
[README](../README.md) for what the cranker is and why a missed
`submitShares(Q)` is unrecoverable.

**Contents**

- [Go-live checklist](#go-live-checklist)
- [Setting the secrets and variables](#setting-the-secrets-and-variables)
- [Triggering a manual run](#triggering-a-manual-run)
- [Reading a run's output](#reading-a-runs-output)
- [What each alert means](#what-each-alert-means)
- [What to do if `NotLatestQuarter` fires](#what-to-do-if-notlatestquarter-fires)
- [The rehearsal weekend: pause and un-pause](#the-rehearsal-weekend-pause-and-un-pause)
- [Moving to mainnet](#moving-to-mainnet)
- [Topping up the wallet](#topping-up-the-wallet)
- [Rotating the key](#rotating-the-key)
- [Changing an RPC endpoint](#changing-an-rpc-endpoint)
- [Changing a contract address](#changing-a-contract-address)
- [If a scheduled workflow gets disabled](#if-a-scheduled-workflow-gets-disabled)
- [DRI table](#dri-table)

---

## Go-live checklist

The calibnet contracts are deployed ([solstice#51](https://github.com/filecoin-project/solstice/issues/51))
and the committed config points at them. If they are ever redeployed — as they were once,
for the move to the 28 September plan — the steps are the same:

1. `npm run sync:deployments` locally. It pulls upstream's `deployments.json` and
   rewrites `config/networks.json`. Review the diff. Open a PR.
2. Confirm the addresses independently against the deployment transaction, not just
   against the file. A wrong address here is a silent no-op every hour.
3. Set the `SRA_ADDRESS` and `SWA_ADDRESS` repository variables to the same values
   (belt and braces: the variables win at runtime, so the two must agree).
4. `npm run preflight` locally, pointed at the real network. It must report both
   contracts as live code, not a zero address and not an empty account.
5. Actions → *Solstice crank* → **Run workflow** with **dry_run** checked. Read the
   decision it prints. It must match what you expect the schedule to be.
6. Run it again without **dry_run**, at a moment when you expect nothing to be due, and
   confirm it exits 0 having broadcast nothing.
7. Only then leave the hourly schedule to it.

---

## Setting the secrets and variables

Both live on the same page:

> **Settings** → (left sidebar) **Secrets and variables** → **Actions**

Direct link: `https://github.com/decentramike/solstice-cranker/settings/secrets/actions`

That page has two tabs, **Secrets** and **Variables**. They are different things and the
workflows read them differently. A value in the wrong tab reads as empty and the cranker
behaves as if you never set it.

### Secrets tab → "New repository secret"

Secrets are write-only. Once saved you cannot read them back, only replace them. They are
masked in workflow logs.

| Name | Value | Required |
| :-- | :-- | :-- |
| `CRANKER_PRIVATE_KEY` | The 0x-prefixed private key of the cranker wallet. See [`WALLET.md`](WALLET.md). | yes |
| `RPC_URL` | Filecoin JSON-RPC endpoint, e.g. `https://api.calibration.node.glif.io/rpc/v1`. | yes |
| `SENDGRID_API_KEY` | Only if `ALERT_TRANSPORT` includes `sendgrid`. | no |
| `RESEND_API_KEY` | Only if `ALERT_TRANSPORT` includes `resend`. | no |
| `ALERT_WEBHOOK_URL` | Only if `ALERT_TRANSPORT` includes `webhook`. | no |

`RPC_URL` is a secret rather than a variable on purpose: endpoints often carry an API key
in the path, and a variable is public in a public repository.

### Variables tab → "New repository variable"

Variables are readable by anyone who can see the repository. Nothing sensitive goes here.

| Name | Example | Required |
| :-- | :-- | :-- |
| `NETWORK` | `calibnet` | yes |
| `SRA_ADDRESS` | `0x…` | once deployed |
| `SWA_ADDRESS` | `0x…` | once deployed |
| `ALERT_EMAIL_TO` | `michael@fil.org` | no |
| `ALERT_EMAIL_FROM` | `cranker@fil.org` | no |
| `ALERT_TRANSPORT` | `sendgrid` | no |
| `CRANK_PAUSED` | `1` to pause, or delete the variable to resume | no |
| `CRANK_DISABLED_DAYS` | `2026-09-27,2026-09-28` | no |
| `CRANK_DISABLED_WEEKDAYS` | `Saturday,Sunday` | no |
| `CRANK_MAX_GATE_CATCHUP` | `8` | no |
| `CRANK_MIN_BALANCE_FIL` | `0.1` | no |
| `CRANK_CONFIRMATIONS` | `1` on calibnet, `2` on mainnet | no |
| `CRANK_LOG_LEVEL` | `debug` when investigating | no |
| `WATCHDOG_GRACE_EPOCHS` | how long after a quarter binds before the watchdog calls a crank overdue | no |

The last three are read by the code but are not in `.env.example`. They work; they are
just undocumented there.

To pause, set `CRANK_PAUSED` to `1`. To resume, **delete the variable.** Setting it to
`0`, `false`, `no`, `off` or empty also resumes — the cranker treats all of those as
not-paused — but a variable that is present and says `0` is easy to misread at a glance,
and the glance is the thing you want to get right. Deleting it is unambiguous.

### Nothing else goes near this repository

`GITHUB_TOKEN` is provided by Actions automatically. Do not create a personal access token
for any of these workflows. The crank workflow has `contents: read` and nothing else; the
watchdog adds `issues: write`; only keepalive has `contents: write`, and it holds no key.

---

## Triggering a manual run

**Actions** → **Solstice crank** (left sidebar) → **Run workflow** (button, top right).

| Input | Use |
| :-- | :-- |
| **dry_run** | Read chain state, decide, report, send nothing. Use this first, always, against anything new. |
| **force_call** | Sends ONE named call without the pre-send simulation, for scripted rehearsal reverts. Leave on `none` for a normal crank. |
| **force_quarter** | The quarter for a forced `submitShares`. Ignored otherwise. |

Runs are serialised: the concurrency group means a manual run waits for an in-flight
scheduled run rather than racing it. A run in flight is never cancelled, because a
cancelled run cannot tell you whether it already broadcast a transaction.

**Space manual runs out — one, wait for it to finish, then the next.** Two reasons:

- The concurrency group holds at most one *pending* run. Click **Run workflow** three
  times while one is in flight and the middle one is cancelled before it starts — the
  Actions tab shows it grey, and it never ran. Only the last click survives.
- Every run makes a burst of RPC calls against the same endpoint the 15-minute trigger
  uses. The public Glif endpoint rate-limits; a run that hits it now retries each
  simulation three times (2 s, then 4 s) before giving up, but back-to-back runs are the
  likeliest way to get there. No run so far has actually been rate-limited.

The same, locally:

```bash
npm run crank:dry    # decide only
npm run crank        # decide and send
npm run preflight    # connectivity and balance only, sends nothing
```

The watchdog can be run by hand the same way: **Actions** → **Crank watchdog** → **Run
workflow**. It has no inputs and cannot send anything.

The watchdog is deliberately not given `CRANKER_PRIVATE_KEY`: it only reads chain state,
and it is the one job in this repository that can write to the issue tracker, so it gets
the smaller blast radius. `scripts/watchdog.mjs` currently calls `loadConfig()`, which
insists on a well-formed private key even though nothing signs, so the workflow mints a
throwaway key for the length of that one step. That key holds nothing and is never used.
When `loadConfig()` grows a read-only mode, delete those three lines from
`.github/workflows/watchdog.yml`.

---

## Reading a run's output

Every run prints, in order: which network and chain id it connected to, the current epoch,
the wallet address and balance, the schedule it computed, and then one line per decision.

What to look at first:

- **The schedule block.** `currentQuarter`, the phase (`pre-activation`, `posting`,
  `verification`, `bound`), and the due quarters for each call. If this is wrong,
  everything downstream is wrong, and the usual cause is `postPeriod` or
  `verificationWindow` in `config/networks.json` not matching the deployment. Those two
  cannot be read from the chain.
- **`chainAgreesWithConfig`.** The cross-check against `aggregatedFilecoinPayVolume()`.
  `false` means the schedule the config produces disagrees with what the chain thinks is
  bound. Stop and investigate before sending anything.
- **The decision lines.** Each names the call, the target quarter, the decision
  (`sent`, `skipped`, `failed`, `dry-run`), the outcome, and a decoded revert reason if
  there is one.
- **The exit code.** 0 means everything is fine, including all the expected reverts. 1
  means something needs a person.

A run that sends nothing is the normal case. Most hours there is nothing due.

---

## What each alert means

| Alert / revert | Severity | What it means | What to do |
| :-- | :-- | :-- | :-- |
| `NotBound(q)` | info | Too early. Quarter q's volumes have not bound yet. Every gate check before the target quarter binds ends here. | Nothing. It will land on a later hourly run. |
| `AlreadySubmitted(q)` | info | Someone else sent it first. These calls are permissionless — this is the system working as designed. | Nothing. Confirm the on-chain `SharesSubmitted` event exists for q, then move on. |
| `StepsComplete()` | info | The gate has taken all 8 steps. It is closed permanently and will never need calling again. | Nothing. Consider removing the gate from the schedule at the next maintenance pass. |
| Gate write inside the SWA hold | info | The previous gate write is still in its timelock. Only happens when checks run late and close together. | Nothing. It retries after the hold expires. |
| `PendingGateParams(task)` | info | A `SetGateParams` governance task is outstanding. The gate check refuses to run until it is executed or vetoed — every gate check reverts with this meanwhile, even one that would otherwise be `NotBound`. | Nothing. The gate has no deadline; it lands on the first run after the task resolves. |
| `PendingWeightWrite(epoch)` | info | A discretionary SWA weight write is still settling in f02 until `epoch`. The gate check waits for it. | Nothing. It lands on the first run after that epoch. |
| `the head crossed a binding during the run` (log line, not an alert) | info | The run read the head just before a quarter bound and probed the chain just after, so computed and chain quarters differ by exactly one, within 10 epochs of that binding. | Nothing. The cranker uses the chain's answer. This used to raise a false critical "config is too large" at 19:00 binding boundaries. |
| Low balance | warn | Wallet below `CRANK_MIN_BALANCE_FIL`. Still working, for now. | [Top up the wallet](#topping-up-the-wallet). Do it the same day. An empty wallet is how a deadline gets missed. |
| RPC unreachable / chain id mismatch | warn | The endpoint is down, rate-limited, or pointing at the wrong network. HTTP 429, 5xx, and a call answered with no revert data at all (`missing revert data`) all count as the node, not the contract. | Check the endpoint's status page. [Change the RPC endpoint](#changing-an-rpc-endpoint) if it stays down. The next run covers a short outage. |
| `Cranker ran degraded` … `quarterlyGateCheck(q): the RPC node failed 3 times in a row (…); nothing was broadcast` | warn | The gate simulation got no usable answer three times running. Nothing was sent; the run still exits 0, because the gate has no deadline. | Nothing if the next run is clean. If it repeats, treat it as RPC unreachable. |
| `Solstice cranker aborted` … `submitShares(q): the RPC node failed 3 times in a row (…); nothing was broadcast` | critical | Same, for the call with a deadline. The run exits 1. | Check the endpoint. The next run retries on its own; once the node answers, `submitShares` goes out. If it is still failing with under a day of the window left, [change the RPC endpoint](#changing-an-rpc-endpoint). |
| `reverted with unrecognised selector 0x…` | critical | The contract answered with an error the shipped ABI does not know: `abi/` was built from a different commit than the one deployed. | Rebuild `abi/` from the deployed commit — set `REF` in `devnet/prepare-contracts.mjs`, then `npm run contracts:build && npm run abi:generate` — and add a rule for the new error in `src/errors.mjs`. Look the selector up in the new `abi/selectors.json`. |
| `chainAgreesWithConfig: false` | warn / critical | The schedule derived from `postPeriod` / `verificationWindow` disagrees with what the chain has bound. Critical when the chain is *ahead* of config. A one-quarter disagreement within 10 epochs of a binding is the head moving mid-run and no longer raises this (see above). | Stop. Pause the cranker. Compare the config against the deployment parameters and fix the config before resuming. If it fired once at a binding and the next run is clean, it was a race the margin did not cover — note it and move on. |
| Contract address is `0x0000…0000` | warn | The network has no deployment, or an override variable is blank. | See [Changing a contract address](#changing-a-contract-address). |
| Watchdog issue opened | warn | A crank is overdue on chain, whatever the crank job's own runs say. | Work the issue. Start with `npm run preflight`, then the crank workflow's recent runs. |
| `Solstice cranker could not start` | critical | The configuration did not load: a missing or malformed secret (`CRANKER_PRIVATE_KEY`), or a mistyped variable (`CRANK_MODE`, `CRANK_PAUSED_WINDOWS`, …). Nothing was sent. | Fix the secret or variable the alert names. The next run picks it up. |
| **`NotLatestQuarter(q)`** | **critical** | **The submission window for quarter q has closed. Its share map is gone.** | [Follow the escalation below.](#what-to-do-if-notlatestquarter-fires) Do not retry. |

**Keep `abi/` pinned to the commit that was deployed, not the one you last read.** Run 192
(1 Oct 2026) went red because `abi/` came from upstream `87fd57c`, while calibnet runs
`0006edc` — which added the gate-check guard (#67) and its two errors. A healthy
`PendingGateParams` revert decoded to nothing and was reported as a critical fault, three runs
in a row. Whenever the contracts are redeployed or upgraded, move `REF` in
`devnet/prepare-contracts.mjs` to the deployed commit in the same PR, and rebuild.

---

## What to do if `NotLatestQuarter` fires

**Nothing you do will recover quarter q's share map.** The contract enforces that
`submitShares` only ever operates on the latest bound quarter, so an older quarter's
shares can never be written. That is deliberate — it is what stops an old share map
overwriting a newer one — and it means the window, once closed, is closed.

Do not retry. Do not send it again from a different wallet. There is no path that works.

The response is escalation and documentation.

1. **Stop the cranker.** Set `CRANK_PAUSED=1`. You do not yet know whether the same fault
   is about to eat the next quarter.
2. **Establish the facts.** From the run logs and the chain, write down: which quarter was
   missed, the epoch at which its window closed, the last successful crank before it, and
   what the cranker did during the window — did it run and fail, or not run at all?
3. **Open an issue on this repository**, labelled `cranker-watchdog`, with those facts.
   This is the durable record.
4. **Notify the owner and backup** in the DRI table below, and the SRA governance tier.
   Their §2.3.10 duty is to confirm `SubmitShares(Q)` has run; a missed quarter is exactly
   the case that duty exists for.
5. **Report it upstream** on [solstice#68](https://github.com/filecoin-project/solstice/issues/68),
   because the cranker design is what failed, not the contract.
6. **Fix the cause before un-pausing.** Empty wallet, dead RPC, disabled workflow, wrong
   `postPeriod` — whichever it was, the fix goes in before the schedule goes back on.
7. **Record it in the governance repo.** The affected orchestrators' quarterly reports for
   that quarter will not reconcile against an on-chain share map that does not exist. That
   needs saying in writing, in public, before the reports are filed.

---

## Rehearsal mode: follow the runbook's schedule

In production the cranker decides for itself: it simulates each call and sends the ones that
would succeed, as soon as they would. That is wrong for the calibnet rehearsal. On 1 Oct and 5 Oct
it skipped every row that was supposed to revert (steps 29, 31, 73) and sent steps 78 and 79 four
hours early, at 18:16 and 18:17 instead of 22:15 and 22:20.

Rehearsal mode turns the decision over to the runbook's Schedule tab:

- **Only scheduled calls.** It sends what `config/rehearsal-schedule.json` lists (one entry per
  call on each Actor = Cranker row) and nothing else. A due quarter with no row is not sent.
- **Never early.** An entry goes out on the first run at or after its `notBefore` (the row's
  Opens time), judged by the runner's clock *and* the chain head's timestamp. So a 19:00
  `submitShares` cannot land before 19:00's binding epoch is on chain.
- **Never late without a person.** No send starts within a minute of `notAfter` (the row's
  Closes time plus 30 minutes), by either clock. After that the step is not sent at all, and the
  run after the window closes alerts that it was missed. The grace is short on purpose: a step
  sent late can meet a different chain than the plan assumed. Step 80, for example, must revert
  while step 78's write is in its hold. Sent after the hold ends, it would pass instead and use up
  the gate check meant for step 86.
- **At most once.** Before sending, the run reads the cranker's own nonce history to find every
  transaction it sent since the relevant windows opened, and credits each to an entry. Nothing is
  stored between runs. Every send carries its step in the last five digits of its gas limit:
  step 31 goes out with gas limit 100,000,310, and step 93.2 with 100,000,932. That tag is how a
  run knows which row its own earlier sends were for. It is needed because `quarterlyGateCheck()`
  and a repeated `submitShares(q)` are byte-identical. A gate check is also credited by the
  quarter it actually tested: its `QuarterlyGateCheckResult` event, or the gate state at the block
  before it. A send without a tag (a manual `force_call`, or production mode) counts as a row's
  only when its outcome fits that row's expectation and no other row's. Otherwise the rows it
  could belong to are **held, never resent**, and a person is told. Rows marked Complete keep
  their own transactions. A step found already sent is still checked against `expect`, and the
  result goes in the run record.
- **Expected reverts are sent.** For `expect: revert:…` there is no `eth_call` or
  `eth_estimateGas` pre-check. It sends with an explicit gas limit (100,000,000), the message
  lands on chain with a non-zero exit code, and the run decodes the revert from the Lotus
  receipt.
- **Gate checks check the quarter the row names.** `quarterlyGateCheck()` takes no argument; it
  checks whatever quarter is next. If the SWA is not at the quarter the row says (`gateQuarter`),
  the step is held and a person is told, rather than spending a later step's check.
- **Calibnet only.** It refuses to start unless both `NETWORK` and the RPC endpoint are chain
  314159.
- **Addresses from upstream.** The SRA and SWA addresses come from `filecoin-project/solstice`'s
  `deployments.json`, at the commit `abi/` was built from. Moving `REF` in
  `devnet/prepare-contracts.mjs` and rebuilding moves both together. The `SOLSTICE_DEPLOYMENTS`
  variable overrides the source.

Every action is one log line:

```
info rehearsal step=80 fn=quarterlyGateCheck() tx=0x… epoch=4130420 decision=sent result="reverted StepWeightRecordsFailed(16)" expect=revert:StepWeightRecordsFailed match=yes
```

### Turning it on and off

**Settings** → **Secrets and variables** → **Actions** → **Variables**:

| Variable | Value |
| :-- | :-- |
| `CRANK_MODE` | `rehearsal` to follow the schedule. Delete it (or set `production`) to go back. |
| `SOLSTICE_DEPLOYMENTS` | Leave unset. Set it to another `deployments.json` URL only to test a different deployment. |

Check what it will do before switching it on. This prints every step open in the next 24 hours
(`WOULD SEND`, `OPEN NOW`, `CLOSED`) and needs no key and no node:

```bash
npm run rehearsal:plan
```

Then run **Run workflow** with **dry_run** ticked. That makes the real decision against the
chain, sends nothing, and shows every step it would send in the job summary.

The trigger runs every 15 minutes, so a step can go out up to about 16 minutes after its Opens
time. To land within a couple of minutes, set the cron-job.org job to every 5 minutes for the
rehearsal week. A run with nothing open costs a handful of RPC reads.

Each problem is alerted once. The workflow keeps a small alert ledger, `.crank-state/alerted.json`,
in the Actions cache: the keys of the alerts already sent. It holds alerts only; no send decision
reads it, so it cannot make the cranker send or skip anything. If the cache entry is missing
(the first run, or evicted after a week unused), alerts fall back to the runs inside
`CRANK_REHEARSAL_REPORT_MINUTES` (default 30, about twice the trigger interval) of the moment a
problem starts. That fallback can repeat an alert but does not drop one. A dry run never alerts.

### Updating the schedule when the runbook changes

The schedule file is built from the runbook. That is a read: the script fetches the tab's CSV
export, and nothing in it can write to the sheet. The sheet id is not in this repository, because
the repository is public and the runbook is shared by link, so pass it in:

```bash
RUNBOOK_SHEET_ID=<id from the runbook URL> npm run rehearsal:schedule
```

It prints every call it parsed and every assumption it made. The Action column is prose, so read
the list. Then open a PR with the new `config/rehearsal-schedule.json`. The cranker only uses the
committed file, so a runbook edit changes nothing until that PR merges.
`npm run rehearsal:schedule -- --check` says whether the committed file is still current.

### Pausing

Either of these stops every automatic send, in both modes:

- the `CRANK_PAUSED` variable set to `1` (quickest), or
- a file named `PAUSED` at the repository root on the branch the workflow runs from.

A paused run still reads and reports. Every step it skips is in the run record, including any
whose window closes during the pause. A pause is deliberate, so none of this is alerted. The
exception is the first run after a pause ends: it can still report a step whose window closed in
the last half hour as not sent. A person pressing **Run workflow** with `force_call` still sends;
that is the manual override. A `force_call` carries no step tag, so it counts as a step only when
its outcome is what that step expects.

### What the rehearsal alerts mean

| Alert | What it means | What to do |
| :-- | :-- | :-- |
| `Rehearsal step N did not do what the plan expected` | The step was sent at its time and the chain did something else, e.g. a revert the plan did not predict, or a pass where it predicted a revert. The tx hash is in the alert. | Record it in the runbook's Notes. This is what a rehearsal is for; the cranker does not retry it. |
| `Rehearsal step N held: the gate is not where the plan expects` | The SWA would check a different quarter than the row names, usually because an earlier gate check went out early or was missed. Nothing was sent. | Decide whether the plan or the chain is wrong. Fix the row and rebuild, or catch the gate up by hand. The cranker keeps checking until the window closes. |
| `Rehearsal step N was not sent` | Its window closed with nothing sent: the trigger did not run, or the step was held. (Not alerted when the cranker was paused; the run record shows it.) | If it still matters, send it by hand (`force_call`) and note the time. |
| `Rehearsal step N could not be sent` | The node refused the broadcast or did not answer. Later steps in that run wait. | Usually transient; the next run retries inside the window. If it repeats, check the RPC endpoint and the wallet balance. |
| `Rehearsal step N: outcome unknown` | The message was broadcast, but its receipt could not be read for over a minute. It will not be resent. | Look the tx hash up on an explorer and compare it with the row's expectation. Later run records show the outcome, but they do not alert on it. |
| `Rehearsal step N held: a cranker transaction is stuck` | A message from the cranker has sat in the mpool for a report window, so no step is sent until it lands. | Find the stuck message on an explorer. Usually it is underpriced; it clears or is replaced. |
| `Rehearsal step N held: it may already have been sent` | A transaction in step N's window has the same call as another row's, and the chain cannot say which row it was. Usually this is a manual `force_call` sent during a window where two rows overlap. Rather than risk a second message, N is not sent. | Look the named tx up. If it was not step N, send N by hand. |
| `Rehearsal cranker cannot account for its own transactions` | The cranker's nonce says it sent more than the blocks show, so it cannot tell which steps are done. It sends nothing until that clears. | Check the cranker address on an explorer. A one-off usually clears on the next run. |

The watchdog does not know about the schedule. On days when the plan deliberately delays a crank,
an "overdue" issue from it is expected.

---

## The rehearsal weekend: pause and un-pause

The plan is **"Rehearsal Plan for Sept 28th start"** in the rehearsal doc. An earlier 23 September
plan was superseded, and the SRA and SWA were **redeployed** for this one:

| | Current (Sept 28 plan) | Superseded (Sept 23 plan) |
| :-- | :-- | :-- |
| SRA | `0x0339f205314C8210AF7Cb075d1A96D012e7896a9` | `0xeDfCd0947F7E9d58E0035f032520d75ce8eCA451` |
| SWA | `0x66C11A9F6dfEC3c1557958cF9f575a023EB01421` | `0xDE4fBd083F18f96C241DdE0A83C3EDC422Be9BA6` |
| Activation | Mon 28 Sep 13:00 UTC, epoch 4109134 | Wed 23 Sep 13:00 UTC, epoch 4094734 |

The superseded pair is still live on chain. Nothing reads it — the watchtower's SRA and SWA are
the current pair, confirmed by matching the ERC-1967 implementation slot of each proxy against
the implementation the watchtower shows. **If the addresses ever move again, run
`npm run sync:deployments -- --write` and `npm run preflight` before anything else.**

**Two clocks, six hours apart.** The quarter boundary is 13:00 UTC. Binding is 19:00 UTC —
boundary plus `POST_PERIOD` 2 h plus `VERIFICATION_WINDOW` 4 h — and binding is when
`submitShares(Q)` becomes callable, so 19:00 is when the cranker acts.

| Quarter | Binds | Scenario |
| :-- | :-- | :-- |
| Q1 | Tue 29 Sep 19:00 | Bootstrap, no gate |
| Q2 | Wed 30 Sep 19:00 | First gate pass |
| Q3 | Thu 01 Oct 19:00 | Orchestrator negatives, correction |
| Q4 | Fri 02 Oct 19:00 | Admit B, temporary stream queued |
| **Q5** | **Sat 03 Oct 19:00** | **Weekend post, no cranks** |
| **Q6** | **Sun 04 Oct 19:00** | **Weekend fail, no action** |
| Q7 | Mon 05 Oct 19:00 | Catch-up, stream removal |
| Q8–Q10 | Tue 06 – Thu 08 Oct 19:00 | Through to the 50% cap |
| Q11 | Fri 09 Oct 19:00 | Terminal state |

### The pause — set it once, now

Settings → Secrets and variables → Actions → **Variables**:

- **`CRANK_PAUSED_WINDOWS`** = `2026-10-03T19:00:00Z/2026-10-05T13:25:00Z`
- **Delete `CRANK_DISABLED_DAYS`** if it is still set. It held the superseded plan's dates.

The window is exact and expires by itself, so it can be set today and forgotten. Both ends are
deliberate:

- **Start, Sat 19:00 — the instant Q5 binds, not midnight.** Q4's submit window closes at that
  same instant. If GitHub dropped Friday's runs, Saturday daytime is Q4's last chance.
- **End, Mon 13:25 — not midnight.** The temporary stream takes effect at 13:00, and the plan's
  `QuarterlyGateCheck(Q5)` at 13:45 is supposed to revert for lack of headroom. Released at
  00:00, the cranker would check Q5 thirteen hours early, before the stream exists, and the
  check could pass — changing the scenario's outcome, not just when it happens.

The watchdog will flag Q5 as overdue across the weekend. That is correct; it is the finding the
weekend exists to produce. Leave its issue open and close it after Monday.

### The share map the weekend destroys — expected, and not recoverable

Monday's single `SubmitShares` installs Q6's map and supersedes Q5's. `submitShares` only ever
accepts the latest bound quarter, so there is no ordering that saves both. The cranker reports
Q5 as a **critical alert and exits 1** on the run that first sees the gap. That is the rehearsal
working. Note it against the scenario; do not treat it as a cranker defect, and do not attempt a
resubmission — the contract will reject it.

### What the automated cranker covers, and what needs a person

**Every successful crank in the plan is automated**, and each one appears in the watchtower's P2
as a `SharesSubmitted` or `QuarterlyGateCheckResult` event. The watchtower reads the SRA and
SWA directly and does not care who sent the message.

**Five rows expect a reverted message in P2, and the automated cranker will not produce them.**
It simulates every call first and never broadcasts one it knows will fail — which is what keeps
it from burning gas every ten minutes. So these scripted negative tests need a person:

| When (UTC) | Call | Expected revert | Watchtower expects |
| :-- | :-- | :-- | :-- |
| Tue 29 Sep 19:00 | `quarterlyGateCheck()` | `NotBound(2)` | P2: reverted, nothing queued |
| Thu 01 Oct 19:15 | `submitShares(3)`, a second time | `AlreadySubmitted(3)` | P2: reverted |
| Mon 05 Oct 13:45 | `quarterlyGateCheck()` | no headroom (temporary stream) | re-attemptable, step not consumed |
| Mon 05 Oct 20:40 | `quarterlyGateCheck()` | Q5's step still in its 6 h hold | P2: reverted, nothing queued |
| Fri 09 Oct 19:15 | `quarterlyGateCheck()` | no step above the 50% cap | P2: reverted at the cap |

The cranker still *sees* each of these — the decoded revert is in that run's log — it just does
not put a failed transaction on chain. The 13:45 row is satisfied anyway: the check is
demonstrably re-attemptable when it passes at 20:30.

### Timestamps will not match the script exactly

The plan is minute-by-minute. The automated cranker reproduces every **outcome**, on its own
clock, and GitHub has been delivering this repo's scheduled runs roughly every five to six
hours regardless of the cron. Two consequences:

- **Routine 19:00 cranks may land hours late** — still well inside each 24-hour window, so no
  share map is at risk, but not at 19:00. If the watchtower timeline needs the minute, press
  **Run workflow** at the scripted time. It is permissionless and cannot double-send, so a
  manual press is always safe.
- **Tuesday's Q7 gate step will land early.** The script re-runs `QuarterlyGateCheck(Q7)` at
  Tue 08:00, so its step lands about 14:00. The cranker retries until Q5's 6-hour hold clears
  around 02:30 and lands the step about 08:30 instead. Same end state, about six hours sooner.

## Reliable scheduling: an external trigger

**GitHub's own schedule is not reliable enough on its own.** Measured on this repo, scheduled runs
arrived every 5–6 hours whatever the cron asked for (16:00, 21:51, 01:21, 07:06, 14:01, 19:19 on
28–29 Sep); the watchtower measured every 2–5 hours on its repo. On a 24-hour calibnet window that is
four or five attempts, and on 29 Sep `SubmitShares(1)` landed 19 minutes after binding only because
one of those gaps happened to end at 19:19.

The fix is the one the watchtower already uses (its `DESIGN.md`, §5): an outside timer,
**cron-job.org, starts the workflow every 15 minutes through the GitHub API.** A dispatched run is
the same normal crank a button press is: it sends only what is due, cannot double-send, and still
honours `CRANK_PAUSED_WINDOWS`. GitHub's own `schedule:` stays in place underneath as a backstop.

### 1. A token that can only start workflows on this repo

github.com → your avatar → **Settings → Developer settings → Personal access tokens →
Fine-grained tokens → Generate new token**:

| Field | Value |
| :-- | :-- |
| Token name | `solstice-cranker-dispatch` |
| Expiration | past the rehearsal — e.g. 31 Oct 2026 |
| Resource owner | `decentramike` |
| Repository access | **Only select repositories** → `decentramike/solstice-cranker` |
| Repository permissions | **Actions: Read and write.** Nothing else. (Metadata: read is added automatically.) |

Generate it and copy it once; GitHub will not show it again. Paste it only into cron-job.org.

**What this token can do:** start, cancel and re-run workflows on this one repo, and read their logs.
**What it cannot do:** read any secret — the cranker's key included; GitHub never exposes secret
values, and logs mask them — or change any file or workflow, since it has no Contents or Workflows
permission. The worst misuse is triggering runs: normal ones send only what is due, and a forced
revert costs about 0.0000128 FIL. If it leaks, revoke it on the same page and make another.

### 2. The cron-job.org job

cron-job.org → **Create cronjob**:

| Field | Value |
| :-- | :-- |
| Title | `Solstice crank` |
| URL | `https://api.github.com/repos/decentramike/solstice-cranker/actions/workflows/solstice-crank.yml/dispatches` |
| Schedule | **Every 15 minutes** (:00, :15, :30, :45) |
| Request method *(Advanced)* | **POST** |
| Request body *(Advanced)* | `{"ref":"main"}` |
| Headers *(Advanced)* | `Authorization: Bearer <the token>` · `Accept: application/vnd.github+json` · `X-GitHub-Api-Version: 2022-11-28` · `Content-Type: application/json` |

The body names only the branch, so every input takes its default: not a dry run, no forced call — a
normal crank. **Never add `force_call` here**; forced sends are for a person at a scripted time.

Why :00/:15/:30/:45 fits the plan: GitHub takes 20–60 s to start a dispatched run, so the :00 run
reads the chain just after each 19:00 binding; and on Mon 5 Oct, with the pause ending 13:25, the
13:30 run lands the catch-up `SubmitShares` at the plan's scripted 13:30.

### 3. Check it

Press **Test run** on the job: expect **HTTP 204** with an empty body. Within a few seconds a run
appears under Actions → Solstice crank with event **workflow_dispatch**. A 401 means the token is
wrong; 403 means it lacks Actions: write or is scoped to another repo; 404 means the URL or the
repo selection is wrong; 422 means the body is malformed.

### When the token expires

Runs simply stop being started, silently, and the schedule falls back to GitHub's 5-hour gaps. Put
the expiry date in a calendar. The watchdog notices overdue cranks, but it runs on GitHub's scheduler
too — so after 7 October either extend the token or retire the job deliberately.

## Moving to mainnet

Not before the rehearsal ends on 7 October — and there is no rush after it. Mainnet
activates Monday 12 October 2026 13:00 UTC, but its first quarter does not bind until
**Thursday 21 January 2027, 20:27 UTC**. Switch any time before that.

| Mainnet quarter | Binds (crank due) | Submit window closes |
| :-- | :-- | :-- |
| Q1 | Thu 21 Jan 2027 20:27 UTC | Fri 23 Apr 2027 03:54 UTC |
| Q2 | Fri 23 Apr 2027 03:54 UTC | Fri 23 Jul 2027 11:21 UTC |
| Q3 | Fri 23 Jul 2027 11:21 UTC | Fri 22 Oct 2027 18:48 UTC |
| Q4 | Fri 22 Oct 2027 18:48 UTC | Sat 22 Jan 2028 02:15 UTC |

A mainnet quarter is 262,974 epochs — 91.3 days, not a whole number — so binding drifts
about seven hours later each quarter. That is why the times above are not round.

### The switchover, in order

1. **New wallet.** A separate key, never the calibnet one. Follow
   [`WALLET.md`](WALLET.md) §1 and write it to `~/.solstice/cranker-mainnet.key`.
2. **Fund it** with ~1 FIL from an FF operational wallet. That is several years of gas.
3. **Secrets:**
   - `CRANKER_PRIVATE_KEY` ← the mainnet key:
     `gh secret set CRANKER_PRIVATE_KEY --repo decentramike/solstice-cranker < ~/.solstice/cranker-mainnet.key`
   - `RPC_URL` ← `https://api.node.glif.io/rpc/v1`
4. **Variables:**
   - `NETWORK` ← `mainnet`
   - **Delete `CRANK_DISABLED_DAYS`.** Those are rehearsal dates. Left in place they do
     nothing harmful on mainnet, but they are a trap for whoever reads them next.
5. **Cadence → weekly.** In `.github/workflows/solstice-crank.yml`, replace the
   ten-minute schedule with:

   ```yaml
   - cron: '37 14 * * 3'   # Wednesdays 14:37 UTC
   ```

   Ten minutes is for calibnet, where a quarter is one day and every attempt counts. See
   the note below on what weekly costs.
6. **Verify, in this order:**
   - `NETWORK=mainnet npm run preflight` — must report **chain 314**. The SRA and SWA have
     the *same address on calibnet and mainnet*, so a correct address proves nothing; the
     chain-id check is what proves you are on mainnet. If you changed `NETWORK` but not
     `RPC_URL`, this is where it fails, loudly: `RPC reports chain 314159 but NETWORK=mainnet
     expects 314`.
   - Actions → Solstice crank → **Run workflow** with `dry_run` ticked. Confirm the log shows
     the *mainnet* wallet address and its balance.

### What weekly costs

Chosen deliberately, with these numbers in view. On the delivery GitHub showed this repo in
its first day live — about 20% of scheduled runs — weekly gives 13 attempts per 91-day
window:

| Cadence | Attempts per window | Chance a quarter's window passes with none delivered | Chance of losing ≥1 share map per year |
| :-- | --: | --: | --: |
| Weekly | 13 | 5.5% | ~20% |
| Daily | 91 | ~0% | ~0% |

That 20% is a first-day figure for a brand-new repo and should improve with history and the
keepalive, so treat it as a ceiling, not a forecast. The second cost is quieter:
`quarterlyGateCheck` has no deadline, but the w2 weight step is delayed by exactly as long as
the check is late, and f02 burns the difference in the meantime. Weekly allows that delay to
run to seven days a quarter; daily caps it at one.

If either matters more than the Actions-list noise, `'37 14 * * *'` is daily. The watchdog
is the backstop either way — but it is on the same scheduler.

## Topping up the wallet

The cranker wallet holds gas and nothing else. It needs enough FIL to send a handful of
small transactions per quarter, plus a margin for a fee spike.

**Calibnet.** Request test FIL from the ChainSafe faucet:
<https://faucet.calibnet.chainsafe-fil.io/funds.html>. Calibnet FIL has no value; top up
generously. A couple of FIL covers the whole rehearsal many times over.

**Mainnet.** Transfer from a Filecoin Foundation operational wallet. About 1 FIL is a
sensible standing balance for 8 transactions a year. Confirm the destination address
character by character before sending — see the `0x` / `f410` note in
[`WALLET.md`](WALLET.md#3-the-two-address-forms), because funding the wrong form of the
address is the classic way to lose a transfer.

Verify afterwards with `npm run preflight`, which prints the balance and whether it is
above the threshold.

Raise the warning threshold with the `CRANK_MIN_BALANCE_FIL` variable if you want more
notice than the network default.

---

## Rotating the key

Rotate immediately if the key was pasted anywhere it should not have been, if a machine
that held it was compromised, or if a person who had access leaves. The blast radius is
small — the wallet has no role and no permission, so a thief gets the gas balance and
nothing else — but a drained wallet means a missed crank, and a missed crank is permanent.

1. Generate a new wallet following [`WALLET.md`](WALLET.md). New key, new address, on your
   own machine.
2. Fund the new address. Do not skip this: a rotated-but-unfunded wallet fails exactly the
   way an emptied one does.
3. Settings → Secrets and variables → Actions → **Secrets** → `CRANKER_PRIVATE_KEY` →
   **Update**. Paste the new key. The old value is not recoverable and does not need to be.
4. Actions → *Solstice crank* → **Run workflow**, **dry_run** checked. Confirm the run
   prints the **new** address.
5. Sweep whatever is left in the old wallet back to the funding wallet, or leave it if the
   balance is dust and the network is calibnet.
6. Note the rotation and the reason in an issue on this repository. Never write either key
   in it.

The old key stays compromised forever. Do not reuse it anywhere, including on a testnet.

---

## Changing an RPC endpoint

1. Check the new endpoint answers and is on the right chain:
   ```bash
   curl -s -X POST <new-endpoint> \
     -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
   ```
   Expect `0x4cb2f` (314159) for calibnet, `0x13a` (314) for mainnet.
2. Settings → Secrets and variables → Actions → **Secrets** → `RPC_URL` → **Update**.
3. Run the crank workflow manually with **dry_run** checked and confirm the chain id and
   epoch in the output.

Use a public or rate-limited endpoint. Never point `RPC_URL` at a node whose RPC exposes
admin or wallet methods — the cranker signs locally and never needs them, so an
admin-capable endpoint is pure downside.

If an endpoint is flaky rather than dead, the hourly schedule already absorbs it: a missed
hour costs nothing when the window is 24 hours wide on calibnet and ~91 days on mainnet.
Change the endpoint when it is failing for hours, not minutes.

---

## Changing a contract address

The addresses live in two places and the repository variable wins at runtime.

1. `npm run sync:deployments` locally to pull upstream's `deployments.json` into
   `config/networks.json`. Review the diff, open a PR, merge it.
2. Update the `SRA_ADDRESS` and `SWA_ADDRESS` repository variables to match.
3. `npm run preflight` — it must report live contract code at both addresses.
4. Crank workflow, manual run, **dry_run** checked. Read the schedule it computes.

Do not update only the variable and leave the config stale, or only the config and leave a
stale variable. They must agree, otherwise a local run and a CI run behave differently and
you will debug the wrong one.

Redeployment also means the immutables may have changed. Re-check `postPeriod` and
`verificationWindow` against whatever the deploy script used — they are `private immutable`
on the SRA and cannot be verified from the chain.

---

## If a scheduled workflow gets disabled

GitHub disables scheduled workflows in a public repository after 60 days without repository
activity, and emails the repository admins. `keepalive.yml` exists to stop this happening
(weekly commit to `.github/keepalive.txt`), but if it does:

1. **Actions** → the workflow in the left sidebar → `...` (top right) → **Enable workflow**.
2. Run it once manually to confirm it is alive.
3. Check why keepalive stopped. A failing keepalive run is the early warning; the disabled
   crank workflow is the symptom.

---

## DRI table

| Role | Calibnet (Phase 1 rehearsal) | Mainnet (Phase 2) |
| :-- | :-- | :-- |
| Owner | Michael Madoff (@decentramike), michael@fil.org | Documented in [Solstice-Governance](https://github.com/filecoin-project/Solstice-Governance) |
| Backup | One named rehearsal participant, assigned before 23 September 2026 and recorded here | Documented in Solstice-Governance |
| Escalation | [solstice#68](https://github.com/filecoin-project/solstice/issues/68) | SRA governance tier, per Solstice-Governance §2.3.10 |

The backup is not optional and is not a formality. The rehearsal's tightest window is 24
hours; on a weekend with one person unreachable, that window is easily missed.

**Before the rehearsal starts, replace "one named rehearsal participant" above with an
actual name and contact.** It is written this way because the name is not decided yet, not
because a placeholder is acceptable.

The mainnet DRI belongs in the governance repository rather than here, because it outlives
this repository and needs to be discoverable by people who have never seen it. See
[`../PATCHES/README.md`](../PATCHES/README.md).
