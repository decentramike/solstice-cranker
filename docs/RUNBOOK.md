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
| **network** | Overrides `NETWORK` for this run only. Leave blank in normal operation. |

Runs are serialised: the concurrency group means a manual run waits for an in-flight
scheduled run rather than racing it. A run in flight is never cancelled, because a
cancelled run cannot tell you whether it already broadcast a transaction.

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
| Low balance | warn | Wallet below `CRANK_MIN_BALANCE_FIL`. Still working, for now. | [Top up the wallet](#topping-up-the-wallet). Do it the same day. An empty wallet is how a deadline gets missed. |
| RPC unreachable / chain id mismatch | warn | The endpoint is down, rate-limited, or pointing at the wrong network. | Check the endpoint's status page. [Change the RPC endpoint](#changing-an-rpc-endpoint) if it stays down. The hourly retry covers a short outage. |
| `chainAgreesWithConfig: false` | warn | The schedule derived from `postPeriod` / `verificationWindow` disagrees with what the chain has bound. | Stop. Pause the cranker. Compare the config against the deployment parameters and fix the config before resuming. |
| Contract address is `0x0000…0000` | warn | The network has no deployment, or an override variable is blank. | See [Changing a contract address](#changing-a-contract-address). |
| Watchdog issue opened | warn | A crank is overdue on chain, whatever the crank job's own runs say. | Work the issue. Start with `npm run preflight`, then the crank workflow's recent runs. |
| **`NotLatestQuarter(q)`** | **critical** | **The submission window for quarter q has closed. Its share map is gone.** | [Follow the escalation below.](#what-to-do-if-notlatestquarter-fires) Do not retry. |

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
