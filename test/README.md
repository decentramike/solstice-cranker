# Tests

```
npm test                 # test/*.test.mjs -- pure, no chain, no network, ~0.7s
npm run test:integration # test/integration/*.test.mjs -- needs the local devnet
```

Node's built-in runner (`node --test`). No vitest, no jest, no extra dependencies.

## What each file is for

| File | Covers | Notes |
|---|---|---|
| `schedule.test.mjs` | `src/schedule.mjs` | Every geometry assertion is checked against a transcription of `vendor/solstice/src/ServiceRewardsActor.sol`, not against the code under test. |
| `errors.test.mjs` | `src/errors.mjs` | Reverts are ABI-encoded with the real selectors from `abi/selectors.json` and wrapped in seven provider error shapes. |
| `config.test.mjs` | `src/config.mjs` | Pause rules in UTC, key validation, redaction. |
| `chain.test.mjs` | `src/chain.mjs` | Storage decoding against hand-packed words and one word captured from a live devnet; probing, retry, provider construction. |
| `integration/crank.test.mjs` | `src/crank.mjs` end to end | Real transactions on the devnet. |
| `helpers/geometries.mjs` | shared fixtures | The Solidity reference implementations and the epoch sweeps. Not a test file. |

## The reference implementations

`helpers/geometries.mjs` holds a deliberate re-transcription of `_quarterStart`,
`_inPostingWindow`, `_inVerificationWindow`, `_afterBinding`, `_quarterOf` and the
`submitShares` require chain. It is copied from the Solidity, not derived from
`src/schedule.mjs`, so a refactor of the JS cannot drag the expectation along with it. If
upstream changes a window, change the transcription first and let the tests fail.

`latestBoundQuarter` is checked against a brute-force loop (`q = 1, 2, 3 …` while
`bindingEpoch(q) <= epoch`) over all three network geometries, three re-anchored variants and
two synthetic extremes — densely for every epoch where the quarter is short enough to sweep,
and at every window boundary plus a strided and a seeded-random sample otherwise.

## Integration tests

They skip, with the reason printed, when:

- `devnet/fixtures.mjs` will not load, or nothing answers on `http://127.0.0.1:8545`;
- the chain id is not the devnet's;
- `devnet/.deployed.json` is missing, or the addresses in it have no code;
- the Hardhat artifacts have not been built;
- **another process is driving the node.** The suite mines, snapshots and reverts, so it
  refuses to run alongside `npm run rehearsal`, `npm run demo` or the devnet server rather
  than racing them and throwing away their work.

To run them:

```
npm run devnet        # in one terminal
npm run devnet:deploy # once
npm run test:integration
```

Every test takes an `evm_snapshot` first and reverts to it afterwards, so the devnet ends
where it started. No key is written anywhere: the cranker signer is derived at run time from
Hardhat's public test mnemonic by account index (`ACCOUNTS.cranker`).

## Tests named "known defect" / "DEFECT"

A handful of tests assert what the code does today rather than what it should do, and say so
in the assertion message. They exist so the defect cannot quietly change shape, and they are
meant to **fail** when the underlying bug is fixed — at which point delete the pin and assert
the correct behaviour. They are:

- `chain.test.mjs` — one spurious probe failure drops `observeLatestBoundQuarter` a quarter.
- `chain.test.mjs` — the exhausted-search fallback names a quarter it knows is not the latest.
- `chain.test.mjs` — the chain-id guard never fires, because the node is never asked.
- `config.test.mjs` — `loadConfig(env)` reads secrets and addresses from `process.env`.
- `integration/crank.test.mjs` — a skipped quarter is lost with exit 0 and no alert.
