# Runbook

Operating the Solstice cranker on Filecoin Mainnet: the two permissionless crank calls and
the f02 `Claim`. Everything here assumes `https://github.com/decentramike/solstice-cranker`.

Read [`WALLET.md`](WALLET.md) before you handle a key. Read the [README](../README.md) for
why a missed `submitShares(Q)` is unrecoverable.

Tables of things to do are **the command and its expected result, nothing else**. What the
workflows do on their own is described once, in [What runs by itself](#what-runs-by-itself),
and is never a step for a person.

**Contents**

- [What runs by itself](#what-runs-by-itself)
- [Mainnet schedule](#mainnet-schedule)
- [Mainnet go-live](#mainnet-go-live)
- [Setting the secrets and variables](#setting-the-secrets-and-variables)
- [Triggering a manual run](#triggering-a-manual-run)
- [Reading a run's output](#reading-a-runs-output)
- [What each alert means](#what-each-alert-means)
- [What to do if `NotLatestQuarter` fires](#what-to-do-if-notlatestquarter-fires)
- [Claim](#claim)
- [Pausing](#pausing)
- [Reliable scheduling: an external trigger](#reliable-scheduling-an-external-trigger)
- [Regenerating the schedule](#regenerating-the-schedule)
- [Topping up a wallet](#topping-up-a-wallet)
- [Rotating a key](#rotating-a-key)
- [Changing an RPC endpoint](#changing-an-rpc-endpoint)
- [Changing a contract address](#changing-a-contract-address)
- [If a scheduled workflow gets disabled](#if-a-scheduled-workflow-gets-disabled)
- [DRI table](#dri-table)

---

## What runs by itself

Four workflows. Each starts with a **gate** job that reads `config/schedule.<NETWORK>.json`,
runs no `npm ci`, holds no key, and finishes in seconds when there is nothing to do.

| Workflow | Trigger | Does work when | Key |
| :-- | :-- | :-- | :-- |
| **Solstice crank** | hourly at :17, plus the external 15-minute dispatch | a crank window is open (below) | `CRANKER_PRIVATE_KEY` |
| **Solstice Claim** | weekly Wed 14:41 UTC, plus hourly at :41 | weekly; and once 24 h after each `submitShares` lands | `CLAIM_PRIVATE_KEY` |
| **Crank watchdog** | every 6 h at :47 | every 6 h inside a crank window, daily (00:47) outside | none |
| **Keepalive** | weekly | always: one commit so GitHub keeps the schedules enabled | none |

**The crank window for quarter Q** opens one hour before Q binds and closes when
`submitShares(Q)` **and** the gate check due at Q have both landed on chain. Every trigger
runs for the first 72 hours; after that, one hour in six, until the work lands. Elapsed time
never closes a window: a window still open after 72 hours is one whose work has not landed.
If the gate cannot read the chain or the schedule file is missing, the crank runs anyway.

Inside a window the crank simulates every call first, sends only what is due, decodes every
revert, and treats `NotLatestQuarter` as critical (exit 1).

**The Claim** reads f02's stream 2, finds every wallet owed something, simulates, and sends
a batch only if it pays more than 0, its max fee is ≤ `CLAIM_MAX_FEE_FIL` (0.05) and ≤ 10% of
the payout, the sender has nothing pending in the mpool, and fewer than 3 messages have gone
this run. The post-submit run waits 24 h from the actual `SharesSubmitted` event and sends at
most once per quarter.

**Every crank and Claim run checks both gas wallets** (the other one by its public address)
and alerts below threshold. The watchdog does the same daily between windows.

**On Mainnet nothing is broadcast until `MAINNET_SEND_ENABLED` is set.** Until then every
run is a dry run: it reads, decides, simulates and reports.

---

## Mainnet schedule

Activation: **Mon 19 Oct 2026 13:00 UTC, epoch 6470280** (`quarterStart(0)` on chain,
matching upstream `deployments.json`). A quarter is 262,974 epochs (91.3 days), so binding
drifts about 7 h 27 min later each quarter.

<!-- schedule:mainnet:start -->
As of epoch 6459878 (Thu 15 Oct 2026 22:19 UTC), from `npm run schedule` on mainnet.

| Quarter | Window opens | `submitShares(Q)` callable (binding) | Every run until | Post-submit Claim from | Deadline: Q lost after |
| :-- | :-- | :-- | :-- | :-- | :-- |
| Q1 | Thu 28 Jan 2027 19:27 UTC | Thu 28 Jan 2027 20:27 UTC (epoch 6762054) | Sun 31 Jan 2027 19:27 UTC | Fri 29 Jan 2027 20:27 UTC | Fri 30 Apr 2027 03:54 UTC (epoch 7025028) |
| Q2 | Fri 30 Apr 2027 02:54 UTC | Fri 30 Apr 2027 03:54 UTC (epoch 7025028) | Mon 03 May 2027 02:54 UTC | Sat 01 May 2027 03:54 UTC | Fri 30 Jul 2027 11:21 UTC (epoch 7288002) |
| Q3 | Fri 30 Jul 2027 10:21 UTC | Fri 30 Jul 2027 11:21 UTC (epoch 7288002) | Mon 02 Aug 2027 10:21 UTC | Sat 31 Jul 2027 11:21 UTC | Fri 29 Oct 2027 18:48 UTC (epoch 7550976) |
| Q4 | Fri 29 Oct 2027 17:48 UTC | Fri 29 Oct 2027 18:48 UTC (epoch 7550976) | Mon 01 Nov 2027 17:48 UTC | Sat 30 Oct 2027 18:48 UTC | Sat 29 Jan 2028 02:15 UTC (epoch 7813950) |
| Q5 | Sat 29 Jan 2028 01:15 UTC | Sat 29 Jan 2028 02:15 UTC (epoch 7813950) | Tue 01 Feb 2028 01:15 UTC | Sun 30 Jan 2028 02:15 UTC | Sat 29 Apr 2028 09:42 UTC (epoch 8076924) |
| Q6 | Sat 29 Apr 2028 08:42 UTC | Sat 29 Apr 2028 09:42 UTC (epoch 8076924) | Tue 02 May 2028 08:42 UTC | Sun 30 Apr 2028 09:42 UTC | Sat 29 Jul 2028 17:09 UTC (epoch 8339898) |
| Q7 | Sat 29 Jul 2028 16:09 UTC | Sat 29 Jul 2028 17:09 UTC (epoch 8339898) | Tue 01 Aug 2028 16:09 UTC | Sun 30 Jul 2028 17:09 UTC | Sun 29 Oct 2028 00:36 UTC (epoch 8602872) |
| Q8 | Sat 28 Oct 2028 23:36 UTC | Sun 29 Oct 2028 00:36 UTC (epoch 8602872) | Tue 31 Oct 2028 23:36 UTC | Mon 30 Oct 2028 00:36 UTC | Sun 28 Jan 2029 08:03 UTC (epoch 8865846) |
<!-- schedule:mainnet:end -->

"Every run until" is when the cadence drops to one hour in six, not when the window closes.
The deadline column is binding of Q+1: after it, quarter Q's share map is lost for good.

---

## Mainnet go-live

Each row is a command and the result that means "go on". Any other result: stop.

### Before activation

| Command | Expected result |
| :-- | :-- |
| `NETWORK=mainnet npm run preflight` | `17/17 checks passed`, chain 314, `config activationEpoch agrees with chain -- 6470280` |
| `NETWORK=mainnet npm run schedule` | `wrote config/schedule.mainnet.json`; Q1 binding `Thu 28 Jan 2027 20:27 UTC (epoch 6762054)` |
| `NETWORK=mainnet npm run crank:dry` | exit 0, `submitShares: nothing to do -- no quarter is bound yet` |
| `NETWORK=mainnet npm run claim:dry` | exit 0, `f02 has no stream state yet` before activation; after it, `stream 2 candidates` |

### Keys and variables (Michael)

| Command | Expected result |
| :-- | :-- |
| Generate the cranker key: [`WALLET.md` §1](WALLET.md#1-generate-the-key) with `~/.solstice/cranker-mainnet.key` | `address: 0x…` printed; key file `-rw-------` |
| Generate the Claim key: [`WALLET.md` §7](WALLET.md#7-the-claim-key) | `address: f1…` printed; key file `-rw-------` |
| Fund the cranker: ~1 FIL to its `0x…` / `f410…` address | `NETWORK=mainnet CRANKER_ADDRESS=0x… npm run preflight` shows `cranker wallet funded` |
| Fund the Claim wallet: ~0.5 FIL to its `f1…` address | `NETWORK=mainnet CLAIM_ADDRESS=f1… npm run preflight` shows `Claim wallet funded` |
| `gh secret set CRANKER_PRIVATE_KEY --repo decentramike/solstice-cranker < ~/.solstice/cranker-mainnet.key` | `✓ Set Actions secret CRANKER_PRIVATE_KEY` |
| `gh secret set CLAIM_PRIVATE_KEY --repo decentramike/solstice-cranker < ~/.solstice/claim-mainnet.key` | `✓ Set Actions secret CLAIM_PRIVATE_KEY` |
| `gh secret set RPC_URL --repo decentramike/solstice-cranker --body https://api.node.glif.io/rpc/v1` | `✓ Set Actions secret RPC_URL` |
| `gh variable set CRANKER_ADDRESS --repo decentramike/solstice-cranker --body 0x…` | `✓ Created variable CRANKER_ADDRESS` |
| `gh variable set CLAIM_ADDRESS --repo decentramike/solstice-cranker --body f1…` | `✓ Created variable CLAIM_ADDRESS` |
| `gh variable set NETWORK --repo decentramike/solstice-cranker --body mainnet` | `✓ Updated variable NETWORK` |
| `gh workflow run "Solstice crank" --repo decentramike/solstice-cranker -f dry_run=true -f ignore_window=true` | run succeeds; summary shows `mainnet`, the new `0x…` cranker and its balance, `dry run` |
| `gh workflow run "Solstice Claim" --repo decentramike/solstice-cranker -f dry_run=true` | run succeeds; summary shows the new `f1…` sender and its balance |

### Turning Mainnet sends on (Michael)

| Command | Expected result |
| :-- | :-- |
| `gh variable set MAINNET_SEND_ENABLED --repo decentramike/solstice-cranker --body true` | `✓ Created variable MAINNET_SEND_ENABLED` |
| `gh workflow run "Solstice crank" --repo decentramike/solstice-cranker -f ignore_window=true` | run succeeds; no `dry run` in the summary; nothing sent unless a quarter is bound |

To turn sends off again: `gh variable delete MAINNET_SEND_ENABLED --repo decentramike/solstice-cranker`.

---

## Setting the secrets and variables

> **Settings** → **Secrets and variables** → **Actions**, or `gh secret set` / `gh variable set`.

A value in the wrong tab reads as empty. Secrets are write-only and masked in logs;
variables are public in a public repository.

### Secrets

| Name | Value | Used by |
| :-- | :-- | :-- |
| `CRANKER_PRIVATE_KEY` | 0x-prefixed EVM key of the cranker wallet. [`WALLET.md` §1](WALLET.md#1-generate-the-key). | crank only |
| `CLAIM_PRIVATE_KEY` | hex f1 (secp256k1) key of the Claim wallet. [`WALLET.md` §7](WALLET.md#7-the-claim-key). Never the cranker key. | Claim only |
| `RPC_URL` | Public or rate-limited Filecoin JSON-RPC, e.g. `https://api.node.glif.io/rpc/v1`. Serves both `eth_*` and `Filecoin.*`. | all |
| `SENDGRID_API_KEY` / `RESEND_API_KEY` / `ALERT_WEBHOOK_URL` | Only for the matching `ALERT_TRANSPORT`. | all |

### Variables

| Name | Example | What it does |
| :-- | :-- | :-- |
| `NETWORK` | `mainnet` | Which entry of `config/networks.json`, and which schedule file the gate reads. |
| `MAINNET_SEND_ENABLED` | `true` | Unset: every Mainnet run is a dry run. |
| `CRANK_PAUSED` | `1` | The stop switch, for the crank **and** the Claim. Delete to resume. |
| `CRANKER_ADDRESS` | `0x…` | Public address of the cranker wallet, for balance checks in the Claim and watchdog jobs. |
| `CLAIM_ADDRESS` | `f1…` | Public address of the Claim wallet. Must match `CLAIM_PRIVATE_KEY`. |
| `SRA_ADDRESS` / `SWA_ADDRESS` | `0x…` | Override the committed addresses. Must agree with `config/networks.json`. |
| `CRANK_MIN_BALANCE_FIL` / `CLAIM_MIN_BALANCE_FIL` | `0.1` | Low-balance thresholds. |
| `CLAIM_MAX_FEE_FIL` / `CLAIM_MAX_MESSAGES` | `0.05` / `3` | Claim guards. |
| `CRANK_MAX_GATE_CATCHUP` | `8` | Gate calls per run while catching up. |
| `CRANK_CONFIRMATIONS` | `2` | Confirmations to wait after a send. |
| `CRANK_LOG_LEVEL` | `debug` | When investigating. |
| `WATCHDOG_GRACE_EPOCHS` | `120` | How long after binding the watchdog calls a crank overdue. |
| `ALERT_TRANSPORT` / `ALERT_EMAIL_TO` / `ALERT_EMAIL_FROM` | `sendgrid` / … | Alert delivery. Console and job summary when unset. |

`CRANK_PAUSED_WINDOWS`, `CRANK_DISABLED_DAYS` and `CRANK_DISABLED_WEEKDAYS` no longer do
anything. Delete them if they are still set.

`GITHUB_TOKEN` is provided by Actions. The crank and Claim jobs have `contents: read` and
nothing else; the watchdog adds `issues: write` and holds no key; only keepalive has
`contents: write`, and it holds no key.

---

## Triggering a manual run

| Command | Expected result |
| :-- | :-- |
| `gh workflow run "Solstice crank" --repo decentramike/solstice-cranker -f dry_run=true -f ignore_window=true` | a run that reads, decides and simulates; nothing broadcast |
| `gh workflow run "Solstice crank" --repo decentramike/solstice-cranker -f ignore_window=true` | a real crank outside the gate; sends only what is due |
| `gh workflow run "Solstice Claim" --repo decentramike/solstice-cranker -f dry_run=true` | discovery and simulation; summary lists what each batch would pay |
| `gh workflow run "Crank watchdog" --repo decentramike/solstice-cranker` | a watchdog run; closes its issue if healthy |
| `npm run crank:dry` / `npm run claim:dry` / `npm run preflight` | the same, locally, sending nothing |

A dispatch **without** `ignore_window` (which is what the external timer sends) goes through
the gate like a scheduled run. Runs are serialised per workflow and never cancelled in flight.
Space manual runs out: the concurrency group keeps one pending run and drops the rest.

---

## Reading a run's output

- **Gate line** in the summary: `run` or `skip`, and why (`Q1 window closed on chain…`,
  `inside the Q1 window (5h open): submitShares pending, gate settled`).
- **Crank summary**: network, epoch, quarter and phase, wallet balance, one row per call with
  the decision (`sent`, `skipped`, `failed`, `dry run`) and the decoded revert.
- **Claim summary**: sender and balance, one row per batch: wallets, decision, outcome
  (`landed`, `would-send`, `fee-guard`, `pending-nonce`, `capped`, `not-due`), pays, max
  fee, message CID.
- **Exit code**: 0 is healthy, including every expected revert and every Claim the guards
  declined. 1 means a person is needed and an alert went out.

---

## What each alert means

| Alert / revert | Severity | Meaning | Action |
| :-- | :-- | :-- | :-- |
| `NotBound(q)` | info | Too early; quarter q has not bound. | None. |
| `AlreadySubmitted(q)` | info | Someone else sent it first (the watchtower's backup cranker waits a day, so normally it is the one that gets this). | None. |
| `StepsComplete()` | info | The gate took all 8 steps and is closed for good. | None. |
| Gate write inside the SWA hold | info | The previous gate write is still in its timelock. | None. |
| `PendingGateParams(task)` / `PendingWeightWrite(epoch)` | info | A governance write is outstanding; the gate waits. | None. |
| `the head crossed a binding during the run` (log) | info | Computed and chain quarter differ by one at a binding. | None. |
| `cranker wallet is low on gas` / `Claim wallet is low on gas` | warn | Below threshold. | [Top up](#topping-up-a-wallet) the same day. |
| `Claim sender has a pending message` | warn | A message from the Claim key is already in the mpool; nothing was sent on top. | Look up the sender on an explorer; if it is stuck, wait for it to clear or replace it. |
| `Claim sent but not confirmed` | warn | Pushed, not seen on chain within 10 minutes. | Look up the CID before anything else is sent. |
| `Claim failed on chain` | critical | A simulated Claim landed with a non-zero exit code. | Read the receipt; pause (`CRANK_PAUSED`) if it repeats. |
| `Cranker ran degraded` | warn | An optional read failed; submitShares still went ahead. | None if the next run is clean. |
| `Solstice cranker aborted` … `RPC node failed 3 times` | critical | The node did not answer for the call with a deadline. | Check the endpoint; [change it](#changing-an-rpc-endpoint) if it stays down. |
| `reverted with unrecognised selector 0x…` | critical | `abi/` does not match the deployed contract. | Rebuild `abi/` from the deployed commit. |
| `chainAgreesWithConfig: false` | warn / critical | `postPeriod`/`verificationWindow` disagree with the chain. | Pause; fix config; `npm run schedule`. |
| Watchdog issue opened | warn | A crank is overdue on chain, or a gas wallet is low. | Work the issue: `npm run preflight` first. |
| **`NotLatestQuarter(q)`** / **quarter q never submitted** | **critical** | **Quarter q's share map is gone.** | [Escalate below.](#what-to-do-if-notlatestquarter-fires) Do not retry. |

---

## What to do if `NotLatestQuarter` fires

Nothing recovers quarter q's share map. `submitShares` only accepts the latest bound quarter.
Do not retry and do not send from another wallet.

| Command | Expected result |
| :-- | :-- |
| `gh variable set CRANK_PAUSED --repo decentramike/solstice-cranker --body 1` | crank and Claim stop sending |
| `gh run list --workflow solstice-crank.yml --repo decentramike/solstice-cranker --limit 50` | the runs inside quarter q's window: did they run and fail, or not run? |
| `NETWORK=mainnet npm run preflight` | names the broken piece: RPC, balance, addresses, schedule |
| `gh issue create --repo decentramike/solstice-cranker --label cranker-watchdog --title "Quarter q lost"` | issue with: quarter, the epoch its window closed, last good crank, cause |
| Comment on [solstice#68](https://github.com/filecoin-project/solstice/issues/68) and notify the DRI table | acknowledged by the SRA governance tier (§2.3.10) |
| Fix the cause, then `gh variable delete CRANK_PAUSED --repo decentramike/solstice-cranker` | next run inside a window sends |

Record the loss in the governance repository before that quarter's reports are filed.

---

## Claim

`Claim(2, wallets)` on f02 moves the service stream's accrued FIL to the wallets in the share
map. It is permissionless and pays only those wallets (FIP-0118 §2.4.5), so the sender
chooses who pays the gas, never where the money goes. It has no deadline; an unclaimed
entitlement waits.

| Command | Expected result |
| :-- | :-- |
| `NETWORK=mainnet CLAIM_ADDRESS=f1… npm run claim:dry` | `stream 2 candidates`, `owed in stream 2`, one `would pay … for at most …` line per batch |
| `gh workflow run "Solstice Claim" --repo decentramike/solstice-cranker -f dry_run=true` | the same in Actions |
| `gh run list --workflow solstice-claim.yml --repo decentramike/solstice-cranker --limit 5` | weekly runs on Wednesdays; one post-submit run a day after each `submitShares` |
| [Watchtower](https://solsticewatchtower.eth.limo) P2, f02 | `Claim ok` and one `claim-payout` per paid wallet, for each landed Claim CID |

The standalone Claim tool (`decentramike/solstice-claim`) is retired: its workflow is
disabled and this workflow replaces it. Do not re-enable it; two senders on one key collide.

---

## Pausing

| Command | Expected result |
| :-- | :-- |
| `gh variable set CRANK_PAUSED --repo decentramike/solstice-cranker --body 1` | runs still read and report, and send nothing (crank and Claim) |
| `gh variable delete CRANK_PAUSED --repo decentramike/solstice-cranker` | sending resumes on the next run |

A pause that ends by itself on a date is a way to lose a quarter, so there is no such thing.

---

## Reliable scheduling: an external trigger

GitHub delivers scheduled runs late and drops some (measured: every 2–6 hours on this repo).
The primary timer is **cron-job.org starting the crank workflow every 15 minutes** through the
GitHub API; the hourly cron is the backstop. Both go through the gate, so outside a window
each costs seconds. The dispatch body is `{"ref":"main"}`: no inputs, so never
`ignore_window`.

| Command | Expected result |
| :-- | :-- |
| Fine-grained token: Only `decentramike/solstice-cranker`, **Actions: Read and write**, nothing else | token created; paste it only into cron-job.org |
| cron-job.org job: `POST https://api.github.com/repos/decentramike/solstice-cranker/actions/workflows/solstice-crank.yml/dispatches`, body `{"ref":"main"}`, headers `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, every 15 min | **Test run** returns HTTP 204 |
| `gh run list --workflow solstice-crank.yml --repo decentramike/solstice-cranker --event workflow_dispatch --limit 3` | runs every ~15 min, each with a gate line |

The token can start runs on this repo and read their logs. It cannot read secrets or change
files. When it expires, runs fall back to GitHub's own schedule; set a calendar reminder.

---

## Regenerating the schedule

Run after any redeploy, upgrade or config change, and whenever CI's schedule test fails.

| Command | Expected result |
| :-- | :-- |
| `NETWORK=mainnet npm run schedule` | `wrote config/schedule.mainnet.json`, then the table above. Exit 1 and **nothing written** if config, upstream `deployments.json` and the chain disagree, with each disagreement listed |
| Paste the printed table between the `schedule:mainnet` markers in this file | `npm test` passes (it checks the table matches the file) |

---

## Topping up a wallet

| Command | Expected result |
| :-- | :-- |
| Send FIL to the cranker's `0x…` (or its `f410…`; same account, [`WALLET.md` §3](WALLET.md#3-the-two-address-forms)) | `NETWORK=mainnet CRANKER_ADDRESS=0x… npm run preflight` shows `cranker wallet funded` |
| Send FIL to the Claim wallet's `f1…` | `NETWORK=mainnet CLAIM_ADDRESS=f1… npm run preflight` shows `Claim wallet funded` |

About 1 FIL for the cranker and 0.5 FIL for Claim is several years of gas.

---

## Rotating a key

Rotate immediately if a key was exposed. The blast radius is the gas balance, but an empty
wallet misses a deadline.

| Command | Expected result |
| :-- | :-- |
| Generate the new key ([`WALLET.md`](WALLET.md) §1 or §7) | new address printed |
| Fund it | preflight shows it funded |
| `gh secret set CRANKER_PRIVATE_KEY` (or `CLAIM_PRIVATE_KEY`) `--repo decentramike/solstice-cranker < <new key file>` | `✓ Set Actions secret …` |
| `gh variable set CRANKER_ADDRESS` (or `CLAIM_ADDRESS`) `--repo decentramike/solstice-cranker --body <new address>` | `✓ Updated variable …` |
| Dry-run the workflow (see [manual runs](#triggering-a-manual-run)) | the summary shows the **new** address |

Never reuse the old key, on any network.

---

## Changing an RPC endpoint

| Command | Expected result |
| :-- | :-- |
| `curl -s -X POST <endpoint> -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"Filecoin.StateNetworkName","params":[]}'` | `"mainnet"` |
| `curl -s -X POST <endpoint> -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'` | `"0x13a"` |
| `RPC_URL=<endpoint> NETWORK=mainnet npm run preflight` | `RPC refuses wallet methods`, all checks pass |
| `gh secret set RPC_URL --repo decentramike/solstice-cranker --body <endpoint>` | `✓ Set Actions secret RPC_URL` |

The Claim sender refuses any endpoint that answers `Filecoin.WalletList`.

---

## Changing a contract address

| Command | Expected result |
| :-- | :-- |
| `npm run sync:deployments -- --write` | `config/networks.json` updated from upstream; review the diff |
| `NETWORK=mainnet npm run schedule` | schedule regenerated with no disagreement |
| `gh variable set SRA_ADDRESS` / `SWA_ADDRESS` `--repo decentramike/solstice-cranker --body 0x…` | the same addresses as the config |
| `NETWORK=mainnet npm run preflight` | live code at both addresses; `config activationEpoch agrees with chain` |

A redeploy can change `postPeriod`/`verificationWindow`, which the chain cannot confirm
before the first binding; `npm run schedule` checks them against upstream `deployments.json`.

---

## If a scheduled workflow gets disabled

| Command | Expected result |
| :-- | :-- |
| `gh workflow enable "Solstice crank" --repo decentramike/solstice-cranker` (or the Claim / watchdog) | the workflow shows `active` in `gh workflow list` |
| `gh run list --workflow keepalive.yml --repo decentramike/solstice-cranker --limit 3` | recent successful runs; if not, that is why |

---

## DRI table

| Role | Mainnet |
| :-- | :-- |
| Owner | Michael Madoff (@decentramike), michael@fil.org, until the repository moves; then as recorded in [Solstice-Governance](https://github.com/filecoin-project/Solstice-Governance) |
| Backup | As recorded in Solstice-Governance |
| Escalation | SRA governance tier, Solstice-Governance §2.3.10; [solstice#68](https://github.com/filecoin-project/solstice/issues/68) |
