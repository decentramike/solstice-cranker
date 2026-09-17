# The cranker wallet

How to create, fund, verify and rotate the wallet that pays gas for the Solstice cranks.

**Read all of this before you generate anything.** The commands are short; the reasons
they are written the way they are matter more than the commands.

---

## What this wallet is, and what it is not

The cranker wallet is a gas wallet. That is its entire job.

- It holds FIL for transaction fees and nothing else.
- It has **no role** on the SRA or the SWA. It is not an owner, not an orchestrator, not a
  Safe signer, not on any allowlist.
- `submitShares(Q)` and `quarterlyGateCheck()` are permissionless. Any funded wallet can
  send them. This one is not special; it is just the one that does it on a schedule.
- It cannot move anyone's rewards, change any parameter, or approve anything.

**Blast radius if the key leaks: the FIL sitting in the wallet.** That is roughly 1 FIL on
mainnet and worthless test FIL on calibnet. Nobody's rewards are at risk. No governance
action becomes possible. That is the honest picture and it is genuinely small.

**Rotate it anyway, immediately.** Not because of what a thief gains, but because of what
you lose: a drained wallet cannot pay for `submitShares(Q)`, and a `submitShares(Q)` that
does not land before quarter Q+1 binds loses that quarter's share map permanently. The
cheap key protects an expensive deadline.

---

## The rules

These are not suggestions.

- **You generate the key yourself, on your own machine.** Nobody generates it for you. Not
  a colleague, not a support channel, not an AI assistant, not a website.
- **The key never goes into a chat, an issue, a pull request, a commit, a ticket, a
  screenshot, a Slack or Signal message, a support channel, or an email.** There is no
  exception. Anyone who asks you for it is either mistaken or attacking you.
- **Never run a command that prints the key to a terminal.** Terminals get screen-shared,
  screen-shotted, recorded and scrolled back through. Every command below writes the key
  to a file and prints only the address.
- **Never put the key in a directory that syncs to a shared or cloud drive.** On macOS,
  `~/Desktop` and `~/Documents` sync to iCloud Drive by default — check yours. Dropbox,
  Google Drive, OneDrive and any backup that leaves your machine are all the same problem.
  Use `~/.solstice/`, which syncs nowhere.
- **`.env` is gitignored. Do not un-ignore it, and do not `git add -f` it.** Check
  [`.gitignore`](../.gitignore) if you ever doubt it.
- **One wallet per network.** The calibnet key and the mainnet key are different keys. Do
  not reuse a testnet key on mainnet, ever, for any reason.

---

## 1. Generate the key

From the repository root, with dependencies installed (`npm ci`). This uses the repo's own
ethers v6 — no extra tools, nothing downloaded, no network call.

```bash
mkdir -p ~/.solstice && chmod 700 ~/.solstice

( umask 077; node --input-type=module -e '
import { Wallet } from "ethers";
import { writeFileSync } from "node:fs";
const out = process.argv[1];
const w = Wallet.createRandom();
writeFileSync(out, w.privateKey + "\n", { mode: 0o600 });
console.log("address:      " + w.address);
console.log("key written:  " + out);
' ~/.solstice/cranker-calibnet.key )
```

It prints two lines: the **address**, and where the key went. It does not print the key.

For mainnet, run it again with `~/.solstice/cranker-mainnet.key`. A separate key.

Confirm the permissions:

```bash
ls -l ~/.solstice/cranker-calibnet.key
```

It must read `-rw-------` (owner read/write only). If it does not, `chmod 600` it and work
out why your `umask` is unusual before you continue.

Write the **address** down somewhere ordinary — a note, a ticket, the runbook. The address
is public. Only the key is secret.

### Why not a keystore file?

A password-encrypted keystore is better at rest, but GitHub Actions needs the raw key at
runtime, so the password would have to become a second secret and buy nothing. A 0600 file
on a machine you control, and a repository secret, is the honest shape of this. Keep the
file only as your copy of what is in the secret.

---

## 2. Load it into GitHub

The key has to reach GitHub without appearing on your screen. Copy it to the clipboard
straight from the file:

```bash
pbcopy < ~/.solstice/cranker-calibnet.key      # macOS
# xclip -selection clipboard < ~/.solstice/cranker-calibnet.key    # Linux
```

Then, in the browser:

> **Settings** → **Secrets and variables** → **Actions** → **Secrets** tab →
> **New repository secret**

- **Name:** `CRANKER_PRIVATE_KEY`
- **Secret:** paste (⌘V). Do not type it by hand and do not paste it anywhere else first.
- **Add secret**

Then clear the clipboard:

```bash
printf '' | pbcopy
```

Two notes. Clipboard managers keep history — if you run one, clear its history too, or
skip the clipboard and paste directly from a text editor you then close without saving.
And GitHub secrets are write-only: once saved you can replace the value but never read it
back, which is the behaviour you want.

`RPC_URL` goes in the same tab, as its own secret. The rest of the configuration goes in
the **Variables** tab. Full table in [`RUNBOOK.md`](RUNBOOK.md#setting-the-secrets-and-variables).

---

## 3. The two address forms

Filecoin has two ways of writing the same account, and funding the wrong one is the classic
way to lose a transfer.

| Form | Looks like | Who uses it |
| :-- | :-- | :-- |
| Ethereum-style (`0x`) | `0xAbCd…1234` | The cranker, ethers, the RPC, block explorers, anything EVM. |
| Filecoin robust (`f410` / `t410`) | `f410f…` on mainnet, `t410f…` on calibnet | Faucets, exchanges, Filecoin-native wallets, `lotus send`. |

They are the **same account**. The `f410` form is derived deterministically from the 20
bytes of the `0x` address — it is that address, re-encoded with the Filecoin `f4`
namespace for the Ethereum Address Manager, plus a checksum. Nothing is chosen and nothing
is registered: every `0x` address already has exactly one `f410` equivalent, before the
account has ever been funded or seen on chain. `f410…` is mainnet, `t410…` is calibnet.

**The cranker only ever uses the `0x` form.** It is what goes in the config, the logs and
the preflight output.

To get the `f410` form when a faucet or an exchange insists on it, use a block explorer's
address page, which shows both:

- Calibnet: `https://calibration.filfox.info/en/address/<your-0x-address>`
- Mainnet: `https://filfox.info/en/address/<your-0x-address>`

An explorer can only show you an account it has seen, so for a brand-new wallet this
works after the first transaction, not before. Before then, use a purpose-built converter
(Beryx and Glif both have one) rather than transcribing anything by hand.

**Whichever form you use, check the last six characters against the first six before you
send.** And on mainnet, send a small test amount first, confirm it arrives, then send the
rest. A 0.01 FIL test transfer costs nothing and removes the whole class of mistake.

---

## 4. Fund it

### Calibnet

Test FIL, no value, top up generously.

**ChainSafe faucet:** <https://faucet.calibnet.chainsafe-fil.io/funds.html> — enter the
destination address and request. It dispenses 100 tFIL, which is far more than the
fourteen-day rehearsal needs. If it rejects the `0x` form, give it the `t410f…` form of
the same address.

Faucets move and go down. If that one is unavailable, the Beryx faucet
(<https://beryx.io/faucet>) is the usual alternative, or ask in the rehearsal channel —
any participant with calibnet FIL can send you some.

Recommended balance: **anything above 1 tFIL**. The rehearsal sends at most a few dozen
small transactions.

### Mainnet

Transfer roughly **1 FIL** from a Filecoin Foundation operational wallet. That covers
about 8 transactions a year with a wide margin for fee spikes.

- Confirm the destination address character by character. Send a 0.01 FIL test first.
- Do not over-fund. The balance is the entire blast radius, so there is no reason for it to
  be larger than it needs to be. Top up when the low-balance alert fires rather than
  parking a large balance there.
- Set `CRANK_MIN_BALANCE_FIL` if you want a warning earlier than the network default of
  0.1 FIL.

---

## 5. Verify it is live

```bash
npm run preflight
```

Preflight sends nothing. It reports the RPC endpoint and chain id, the contract addresses
and whether there is code at them, the wallet address the key produces, its balance, and
whether that balance is above the threshold.

Three things to check in the output:

1. **The address is the one you wrote down.** If it is not, the wrong key is loaded.
2. **The chain id matches the network** — 314159 for calibnet, 314 for mainnet.
3. **The balance is non-zero.**

Then repeat the check in CI: **Actions** → *Solstice crank* → **Run workflow** with
**dry_run** checked, and confirm the run prints the same address. That is the only way to
know the secret in GitHub is the key you think it is.

---

## 6. If the key leaks

Assume it is gone the moment it lands anywhere it should not be: a chat, a screenshot, a
commit, a shared terminal, a pastebin, a compromised laptop.

1. **Rotate now.** Generate a new wallet (step 1), fund it (step 4), replace the
   `CRANKER_PRIVATE_KEY` secret (step 2), and verify with a dry run (step 5). Full
   procedure in [`RUNBOOK.md`](RUNBOOK.md#rotating-the-key).
2. **Move the remaining balance** out of the old wallet to the funding wallet. On calibnet,
   dust is not worth the transaction.
3. **Do not reuse the old key anywhere.** Not on a testnet, not for a demo, not as an
   example. It is compromised permanently.
4. **Write down that it happened** in an issue on this repository — what leaked, where, when
   it was rotated. Never the key itself, and never any part of it.
5. **Delete the leaked copy** if you can, but do not treat deletion as remediation. Rotation
   is the remediation. Deleting the message after rotating is tidying up.

Do not delay rotation to investigate first. Rotation takes ten minutes and costs nothing.

---

## Quick checklist

- [ ] Key generated locally, by me, with the command above
- [ ] Key file is `0600`, in `~/.solstice/`, which syncs nowhere
- [ ] Key never printed to a terminal, never pasted into a chat, issue, PR or commit
- [ ] Address written down; key not written down anywhere but the file
- [ ] `CRANKER_PRIVATE_KEY` set in Settings → Secrets and variables → Actions → Secrets
- [ ] Clipboard cleared
- [ ] Wallet funded, and the `0x` / `f410` forms confirmed to be the same account
- [ ] `npm run preflight` shows the expected address, chain id and a non-zero balance
- [ ] A dry-run workflow run prints that same address
- [ ] Separate keys for calibnet and mainnet
