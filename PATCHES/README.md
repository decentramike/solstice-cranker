# Prepared changes to Solstice-Governance

Two changes to [filecoin-project/Solstice-Governance](https://github.com/filecoin-project/Solstice-Governance)
that point governance readers at the cranker as the automation for the quarterly
permissionless calls.

**These are prepared, not pushed.** They are a pull request for someone else's repository
and belong to that repository's review process, which is public review by PR and, for
program rules, a Change Log entry. Nothing here has been sent.

| File | Changes | Size |
| :-- | :-- | :-- |
| `0001-readme-link-to-cranker.patch` | `README.md` | one line added to §1.4 Reference Links |
| `0002-runbook-permissionless-cranks.patch` | `docs/04-quarterly-review-and-runbook.md` | one line in the Contents list, plus a new §4.5 |
| `04-section-4.5.md` | — | the §4.5 prose on its own, for applying by hand |

---

## Verified against

Fetched from the public repository on **17 September 2026**, at

```
main @ 434e88807a37908fad65de823fceffc4c05e52c5   (2026-09-14)
```

Both patches were applied to a fresh clone of that commit and checked: `git apply --check`
passes and the applied result renders with the section ordering intact. If upstream has
moved since, see *If they no longer apply* below.

## What is actually upstream today

Worth knowing before reviewing, because two assumptions about the governance repo turn out
to be wrong:

- **`docs/04-quarterly-review-and-runbook.md` is not about the on-chain cranks at all.**
  Despite "Runbook" in the title, its four sections are the Orchestrator's quarterly
  *community report*: the reporting duty (§4.1), the report template (§4.2), a worked
  example (§4.3), and declaration, verification and escalation (§4.4). There is no existing
  section about `SubmitShares` or `QuarterlyGateCheck`, and no text to amend. So patch 0002
  **adds** a section rather than editing one. If reviewers would rather the material live
  somewhere else, the prose in `04-section-4.5.md` moves without change.

- **The crank oversight duties live in `docs/02-solstice-program-governance.md`, not 04.**
  They are §2.2.9 ("Monitor mechanism-executed updates", SWA tier) and §2.3.10 (same title,
  SRA tier). §2.3.10 says of `FinalizeConversion(Q)` and `SubmitShares(Q)`: *"Duty: confirm
  each has run and that `SubmitShares` wrote the correct wallet-to-share map."* That duty is
  exactly what the cranker serves, and the new §4.5 defers to it rather than restating it.

- **§2.2.9 and §2.3.10 have no link anchors.** They are `<details>`/`<summary>` blocks, not
  Markdown headings, so there is no `#229` to link to. The new §4.5 therefore cites them by
  number in prose and links to their parent sections, which do have anchors. This is
  deliberate; please do not "fix" it into a broken anchor.

- **§1.4 Reference Links already has two `TBD` entries** ("Reference indexer",
  "Settlement data and dashboards"). Patch 0001 adds a third bullet alongside them, which is
  the least invasive place for the link and matches the existing list.

## What the changes say

**`README.md` §1.4** — one bullet linking to the cranker repository and to the new §4.5.

**`docs/04` §4.5, "Permissionless quarterly cranks"** — the two calls and their deadlines,
including that a missed `SubmitShares(Q)` loses that quarter's share map permanently; that
both calls are permissionless and confer no authority; that the cranker is a convenience
rather than a dependency, since any funded wallet can send them; who operates it; and what
to do when a crank is missed. It defers to §2.2.9 and §2.3.10 for the oversight duty rather
than duplicating it.

Three claims in that section are the ones to check hardest, because they are consequential:

1. **A missed `SubmitShares(Q)` is unrecoverable.** Checked against the contract source:
   `submitShares` requires `!_afterBinding(q + 1)`, so once quarter Q+1 binds, quarter Q can
   never be submitted. FIP-0118 §4.2 is the rule it implements.
2. **`RemoveOrchestrator` is blocked while a share map is outstanding.** Also checked
   against the source. The guard is `_pendingSharesQuarter()`, which reports pending
   whenever `lastSubmittedQuarter != _quarterOf(currentEpoch())`, and `removeOrchestrator`
   reverts `PendingShares(q)` on it. Note this is about the **current** quarter, not
   quarter Q specifically: a permanently missed Q does not block removals forever, only
   until some later quarter is submitted. [solstice#68](https://github.com/filecoin-project/solstice/issues/68)
   states this more loosely ("`RemoveOrchestrator` reverts too"); §4.5 uses the precise
   form.
3. **Operating the cranker confers no authority.** True of the wallet — it holds gas and
   has no role, permission or Safe membership — but it is a statement about the program's
   trust model and is worth a governance reader agreeing with explicitly.

## How to apply

```bash
git clone https://github.com/filecoin-project/Solstice-Governance
cd Solstice-Governance
git checkout -b cranker-references

git apply --check /path/to/solstice-cranker/PATCHES/*.patch   # verify first
git apply         /path/to/solstice-cranker/PATCHES/*.patch

git add -A
git commit -m "docs: reference the Solstice cranker as the automation for the quarterly cranks"
```

Then open a PR against `main`. Per [§1.3](https://github.com/filecoin-project/Solstice-Governance#13-changing-this-repository),
changes happen by pull request with public review.

**Is this a Change Log entry?** Probably not — §4.5 documents automation for a mechanism
FIP-0118 already fixes, and changes no program rule. But the Change Log covers "every change
to the program rules", and whether naming an operator for the cranks crosses that line is a
judgement for the maintainers, not for this repository. Ask in the PR rather than deciding
it here.

## If they no longer apply

The patches are context diffs, so they survive unrelated upstream edits and fail only when
the surrounding lines change.

```bash
git apply --3way /path/to/PATCHES/0002-runbook-permissionless-cranks.patch
```

If that also fails, apply by hand — both changes are small:

1. **`README.md`**: add one bullet to the end of the §1.4 Reference Links list. The exact
   line is the single `+` line in `0001-readme-link-to-cranker.patch`.
2. **`docs/04-quarterly-review-and-runbook.md`**: add
   `- [4.5 Permissionless quarterly cranks](#45-permissionless-quarterly-cranks)` to the
   **Contents** list, then paste the whole of `04-section-4.5.md` after §4.4.6 and before
   the `---` and the footer navigation line.

Regenerating them is also cheap: re-fetch the two files, re-apply the edits, and
`git diff`.

## Not included, on purpose

- **No change to `docs/02`.** §2.2.9 and §2.3.10 already describe the oversight duty
  correctly and do not need the cranker named to stay true. Editing the tiers' duties is a
  heavier change than this warrants.
- **No Change Log entry in `docs/06`.** See the question above — it is the maintainers' call,
  and writing the entry pre-emptively would presume the answer.
- **No mainnet DRI names.** `docs/RUNBOOK.md` in the cranker repo says the mainnet owner and
  backup belong here rather than there, because this repository outlives that one. The names
  are not settled yet, so §4.5 names Filecoin Foundation and @decentramike and points at the
  cranker runbook for the backup. Replace that with real names in the PR if they are known
  by then.
