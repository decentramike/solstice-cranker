# Internal data contract

This is the seam between the three pieces built in parallel. It is **devnet/demo only** —
the production cranker never serves HTTP and never reads any of this back.

## 1. Run records (written by the cranker, read by the devnet server)

When `CRANK_STATE_DIR` is set, `scripts/crank.mjs` appends one JSON object per line to
`$CRANK_STATE_DIR/runs.ndjson`. It is append-only; nothing rewrites earlier lines.

```jsonc
{
  "runId": "2026-09-17T14:03:11.204Z-a91f",
  "startedAt": "2026-09-17T14:03:11.204Z",
  "finishedAt": "2026-09-17T14:03:12.016Z",
  "durationMs": 812,
  "network": "devnet",
  "chainId": 3141592,
  "epoch": 1234,
  "cranker": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "balanceFil": "9999.981",
  "paused": false,
  "pauseReason": null,
  "actions": [
    {
      "call": "submitShares",           // "submitShares" | "quarterlyGateCheck"
      "quarter": 5,                      // target quarter; null when not applicable
      "decision": "sent",                // "sent" | "skipped" | "failed" | "dry-run"
      "outcome": "landed",               // "landed" | "not-due" | "already-done" | "gate-closed" | "missed-window" | "error"
      "reason": "NotBound(5)",           // decoded custom error, or null
      "txHash": "0x…",                   // null when nothing was broadcast
      "gasUsed": "84213",
      "severity": "info",                // "info" | "warn" | "critical"
      "message": "human-readable one-liner"
    }
  ],
  "schedule": {
    "currentQuarter": 5,
    "phase": "bound",                    // "pre-activation" | "posting" | "verification" | "bound"
    "submitDueQuarter": 5,               // the LATEST BOUND quarter -- see "Which quarter is due" below
    "submitDueAtEpoch": 1360,            // bindingEpoch(5) = 1200 + 120 + 40
    "submitDeadlineEpoch": 1600,         // bindingEpoch(6) = 1440 + 160, exclusive
    "gateDueQuarter": 5,
    "gateDueAtEpoch": 1360,
    "chainAgreesWithConfig": true,
    "divergence": null
  },
  "exitCode": 0
}
```

## 2. Devnet server HTTP API (served by `devnet/server.mjs`, default port 8787)

| Route | Returns |
|---|---|
| `GET /api/state` | The full state object below |
| `GET /api/stream` | `text/event-stream`; one `data:` frame with the same object on every change |
| `GET /api/health` | `{"ok":true,"devnetUp":bool,"deployed":bool}` |
| `POST /api/advance` | `{"epochs":N}` — mines N blocks. Devnet only; how the demo time-travels |
| `POST /api/crank` | Runs the cranker once, returns its run record |
| `POST /api/pause` | `{"paused":bool}` — toggles the simulated weekend pause |

State object:

```jsonc
{
  "network":  { "name": "devnet", "chainId": 3141592, "label": "Local devnet", "epochSeconds": 30 },
  "chain":    { "epoch": 1372, "connected": true },
  "contracts":{ "sra": "0x…", "swa": "0x…", "deployed": true },
  "wallet":   { "address": "0x…", "balanceFil": "9999.98", "minBalanceFil": "0.01", "belowThreshold": false },
  "quarters": {
    "activationEpoch": 0, "epochsPerQuarter": 240,
    "postPeriod": 120, "verificationWindow": 40,
    "currentQuarter": 5, "phase": "bound",
    "quarterStartEpoch": 1200, "bindingEpoch": 1360,
    "nextQuarterStartEpoch": 1440, "epochsUntilNextPhase": 68
  },
  "sra": { "lastSubmittedQuarter": 4, "dueQuarter": 5, "deadlineEpoch": 1600,
           "missedQuarters": [], "atRisk": false },
  "swa": { "lastCheckedQuarter": 4, "dueQuarter": 5, "steps": 2, "gateSteps": 8,
           "nextThresholdUsd": "9450.0", "complete": false },
  "runs":   [ /* newest first, cap 50, the run records above */ ],
  "events": [ /* newest first, cap 100 */
    { "type": "SharesSubmitted", "quarter": 4, "blockNumber": 1201, "txHash": "0x…",
      "args": { "recipientCount": 3, "totalUsd": "12500.0" } },
    { "type": "QuarterlyGateCheckResult", "quarter": 4, "blockNumber": 1201, "txHash": "0x…",
      "args": { "passed": true, "steps": 2 } },
    { "type": "FvmActorCall", "blockNumber": 1201, "txHash": "0x…",
      "args": { "actorId": 2, "method": 2414422607, "methodName": "SetShares", "paramsHex": "0x…" } }
  ],
  "alerts": [ { "at": "…", "severity": "critical", "title": "…", "body": "…" } ],
  "rehearsal": { "active": false, "step": 0, "totalSteps": 14, "label": null, "log": [] }
}
```

### Which quarter is due

`sra.dueQuarter` is the **latest bound quarter**, not `lastSubmittedQuarter + 1`.

`submitShares(q)` requires both `_afterBinding(q)` and `!_afterBinding(q + 1)`, so the only
quarter that can ever be submitted is the latest bound one. When quarters have been missed,
those two definitions diverge and only the first is right: with `lastSubmittedQuarter = 4`
and quarter 7 bound, quarters 5 and 6 are permanently lost and 7 is what the cranker will
send. `lastSubmittedQuarter + 1` would say 5, and the dashboard would show a deadline for a
quarter nothing can be done about.

`sra.missedQuarters` carries the gap explicitly -- `[5, 6]` in that example, `[]` normally.

**The server must ACCUMULATE this array, never recompute it per snapshot.** Append a
quarter when it is first observed to have left the submittable window unsubmitted, and
never remove one. A per-snapshot gap of `(lastSubmittedQuarter, dueQuarter)` is empty again
the instant a later quarter lands and `lastSubmittedQuarter` jumps past the hole -- which
is the exact disappearance the field exists to prevent. A reachable state is
`lastSubmittedQuarter: 7, dueQuarter: 7, missedQuarters: [5]`, and it is unreachable under
the recompute reading.

The cranker's own `schedule.missedQuarters` in a run record is necessarily the
point-in-time gap: `scripts/crank.mjs` is stateless by design, holds no database, and
**the contracts do not remember gaps either** -- `lastSubmittedQuarter` stores only the most
recent submission, and the two mirror slots only the current pair. A missed quarter is
therefore observable on chain for exactly one quarter, and after that only in a log.
`SharesSubmitted` events cannot close the gap either: a legitimately submitted all-zero
quarter sets `lastSubmittedQuarter` and emits no event, so absence of an event does not
imply a miss.

So the durable record lives in three places and the server should take the union of the
first: every run record ever written to `runs.ndjson`; the alert that fired at the moment
the window closed; and the GitHub Actions run history.

`swa.dueQuarter` is `lastCheckedQuarter + 1`, which for the gate *is* correct: each
`quarterlyGateCheck()` advances the counter by exactly one and catches up in order.

### Number formats

Values that can exceed `Number.MAX_SAFE_INTEGER` or that need exact decimal representation
are decimal **strings**: token and USD amounts, and `gasUsed`. Everything else -- epochs,
quarters, block numbers, counts -- is a JSON number.

## 3. Rules

- The dashboard is read-mostly. The only writes it makes are `/api/advance`, `/api/crank`
  and `/api/pause`, and all three exist only on the devnet server.
- The cranker never imports anything from `devnet/` or `dashboard/`.
- The devnet server never imports from `dashboard/`.
