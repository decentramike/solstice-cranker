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
- [Topping up the wallet](#topping-up-the-wallet)
- [Rotating the key](#rotating-the-key)
- [Changing an RPC endpoint](#changing-an-rpc-endpoint)
- [Changing a contract address](#changing-a-contract-address)
- [If a scheduled workflow gets disabled](#if-a-scheduled-workflow-gets-disabled)
- [DRI table](#dri-table)

---

## Go-live checklist

The contracts are not deployed yet ([solstice#51](https://github.com/filecoin-project/solstice/issues/51)).
Until they are, `SRA_ADDRESS` and `SWA_ADDRESS` are the zero address and the cranker
refuses to run. When the deployment lands:

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
| Contract address is `0x0000…0000` | warn | Not deployed yet, or the variable is unset. | Expected until [solstice#51](https://github.com/filecoin-project/solstice/issues/51) lands. After that, see [Changing a contract address](#changing-a-contract-address). |
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

Phase 1 is fourteen daily quarters on calibnet, 23 September to 7 October 2026, with 19:00
UTC boundaries. Q5 (Saturday 27 September) and Q6 (Sunday 28 September) deliberately test
what happens when nobody cranks. Monday's Q7 catch-up is sent by hand.

### Before the weekend — by Friday 26 September

1. Settings → Secrets and variables → Actions → **Variables** → **New repository variable**.
2. Name `CRANK_DISABLED_DAYS`, value `2026-09-27,2026-09-28`.
3. Actions → *Solstice crank* → **Run workflow** with **dry_run** checked, and confirm the
   output says it is disabled for those dates. Do this on Friday, not on Saturday — you
   want to find a typo while there is time to fix it.

Use the variable rather than disabling the workflow. The job keeps running hourly, keeps
reading chain state and keeps reporting, and just does not send. You keep the
observability, the watchdog keeps working, and there is nothing to remember to switch back
on if you are hit by a bus on Sunday.

The watchdog will notice the missed cranks and open an issue. That is correct — it is what
the weekend is testing. Leave the issue open, note in a comment that it is the planned
Q5/Q6 test, and close it after the Monday catch-up.

### Monday 29 September — the Q7 catch-up, by hand

Send the outstanding calls manually, in a fixed order, one at a time, confirming each
before starting the next. Record the transaction hash of each.

1. `npm run preflight` — confirm connectivity and balance first.
2. `npm run crank:dry` — read the decision. It should list the outstanding quarters.
3. Send. The order is submissions before gate checks, oldest quarter first.
4. After each, confirm the `SharesSubmitted` or `QuarterlyGateCheckResult` event on the
   explorer (`https://calibration.filfox.info/en/message/<txhash>`) before sending the next.

Expect `NotLatestQuarter` on the older of the two missed quarters if both windows closed.
On calibnet that is the rehearsal working: it is the finding the weekend exists to produce.
Write it up. Do not treat it as an incident.

### After the catch-up

1. **Delete** the `CRANK_DISABLED_DAYS` variable. Do not set it to empty.
2. Run the crank workflow once manually with **dry_run** checked and confirm it is live
   again.
3. Close the watchdog issue with a link to the write-up.

---

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
