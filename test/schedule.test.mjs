/**
 * src/schedule.mjs against the SRA's own arithmetic.
 *
 * The rule this file exists to protect: submitShares(q) is callable on exactly
 * [bindingEpoch(q), bindingEpoch(q+1)), and one epoch past that the quarter's share map is
 * gone. So every assertion here is about a boundary, and every boundary is checked against a
 * transcription of vendor/solstice/src/ServiceRewardsActor.sol rather than against itself.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PHASE,
  bindingEpoch,
  buildSchedule,
  compareWithChain,
  epochsToDuration,
  expiryEpoch,
  latestBoundQuarter,
  phaseAt,
  quarterOf,
  quarterStartEpoch,
} from '../src/schedule.mjs';
import {
  ALL_GEOMETRIES,
  NETWORK_GEOMETRIES,
  interestingEpochs,
  solidity,
} from './helpers/geometries.mjs';

/** Geometries small enough to sweep every single epoch. */
const DENSE = ALL_GEOMETRIES.filter((g) => g.epochsPerQuarter <= 300n);

function denseEpochs(g, quarters = 10) {
  const end = g.activationEpoch + g.epochsPerQuarter * BigInt(quarters);
  const out = [];
  for (let e = 0n; e <= end; e++) out.push(e);
  return out;
}

describe('geometry matches the SRA', () => {
  for (const g of ALL_GEOMETRIES) {
    it(`${g.name}: quarterStartEpoch === _quarterStart`, () => {
      for (let q = 0; q <= 40; q++) {
        assert.equal(quarterStartEpoch(g, q), solidity.quarterStart(g, q), `q=${q}`);
      }
    });

    it(`${g.name}: bindingEpoch is the first epoch _afterBinding is true`, () => {
      for (let q = 0; q <= 20; q++) {
        const b = bindingEpoch(g, q);
        assert.equal(solidity.afterBinding(g, q, b), true, `q=${q} at bindingEpoch`);
        assert.equal(solidity.afterBinding(g, q, b - 1n), false, `q=${q} one epoch before`);
      }
    });

    it(`${g.name}: bindingEpoch(q) falls inside time-quarter q`, () => {
      // This is the invariant that makes latestBoundQuarter constant-time. It follows from the
      // SRA constructor's POST + VERIFY < EPOCHS_PER_QUARTER, so if it ever fails the config is
      // describing a deployment that could not have been constructed.
      for (let q = 0; q <= 20; q++) {
        const b = bindingEpoch(g, q);
        assert.ok(b >= quarterStartEpoch(g, q), `q=${q}`);
        assert.ok(b < quarterStartEpoch(g, q + 1), `q=${q}`);
      }
    });

    it(`${g.name}: quarterOf === _quarterOf, including below activation`, () => {
      for (const e of interestingEpochs(g)) {
        assert.equal(quarterOf(g, e), solidity.quarterOf(g, e), `epoch=${e}`);
      }
      if (g.activationEpoch > 0n) {
        assert.equal(quarterOf(g, g.activationEpoch - 1n), 0);
        assert.equal(quarterOf(g, 0n), 0);
      }
      assert.equal(quarterOf(g, g.activationEpoch), 0);
      assert.equal(quarterOf(g, g.activationEpoch + g.epochsPerQuarter - 1n), 0);
      assert.equal(quarterOf(g, g.activationEpoch + g.epochsPerQuarter), 1);
    });

    it(`${g.name}: phaseAt agrees with _inPostingWindow / _inVerificationWindow / _afterBinding`, () => {
      for (const e of interestingEpochs(g)) {
        const phase = phaseAt(g, e);

        if (e < g.activationEpoch) {
          assert.equal(phase, PHASE.PRE_ACTIVATION, `epoch=${e}`);
          continue;
        }

        const q = solidity.quarterOf(g, e);
        const posting = solidity.inPostingWindow(g, q, e);
        const verifying = solidity.inVerificationWindow(g, q, e);
        const bound = solidity.afterBinding(g, q, e);

        // The three Solidity predicates partition the quarter; if they ever overlap the
        // transcription is wrong, not the code under test.
        assert.equal([posting, verifying, bound].filter(Boolean).length, 1, `epoch=${e} overlap`);

        const expected = posting ? PHASE.POSTING : verifying ? PHASE.VERIFICATION : PHASE.BOUND;
        assert.equal(phase, expected, `epoch=${e} q=${q}`);
      }
    });

    it(`${g.name}: phase boundaries are exact`, () => {
      for (let q = 0; q <= 6; q++) {
        const qs = quarterStartEpoch(g, q);
        const postEnd = qs + g.postPeriod;
        const bind = postEnd + g.verificationWindow;
        const nextQs = quarterStartEpoch(g, q + 1);

        assert.equal(phaseAt(g, qs), PHASE.POSTING, `q=${q} first posting epoch`);
        assert.equal(phaseAt(g, postEnd - 1n), PHASE.POSTING, `q=${q} last posting epoch`);
        assert.equal(phaseAt(g, postEnd), PHASE.VERIFICATION, `q=${q} first verification epoch`);
        assert.equal(phaseAt(g, bind - 1n), PHASE.VERIFICATION, `q=${q} last verification epoch`);
        assert.equal(phaseAt(g, bind), PHASE.BOUND, `q=${q} binding epoch`);
        assert.equal(phaseAt(g, nextQs - 1n), PHASE.BOUND, `q=${q} last epoch of quarter`);
        assert.equal(phaseAt(g, nextQs), PHASE.POSTING, `q=${q + 1} first posting epoch`);
      }
    });
  }
});

describe('latestBoundQuarter equals the brute-force reference', () => {
  for (const g of NETWORK_GEOMETRIES) {
    it(`${g.name}: sampled sweep`, () => {
      for (const e of interestingEpochs(g, 12)) {
        assert.equal(
          latestBoundQuarter(g, e),
          solidity.latestBoundQuarterBruteForce(g, e),
          `${g.name} epoch=${e}`
        );
      }
    });
  }

  for (const g of ALL_GEOMETRIES) {
    it(`${g.name}: every boundary epoch of quarters 0..20`, () => {
      for (let q = 0; q <= 20; q++) {
        for (const e of [
          quarterStartEpoch(g, q),
          bindingEpoch(g, q) - 1n,
          bindingEpoch(g, q),
          bindingEpoch(g, q) + 1n,
          quarterStartEpoch(g, q + 1) - 1n,
        ]) {
          if (e < 0n) continue;
          assert.equal(
            latestBoundQuarter(g, e),
            solidity.latestBoundQuarterBruteForce(g, e),
            `${g.name} q=${q} epoch=${e}`
          );
        }
      }
    });
  }

  for (const g of DENSE) {
    it(`${g.name}: every epoch of quarters 0..10`, () => {
      for (const e of denseEpochs(g)) {
        assert.equal(
          latestBoundQuarter(g, e),
          solidity.latestBoundQuarterBruteForce(g, e),
          `${g.name} epoch=${e}`
        );
      }
    });
  }

  it('is null until quarter 1 binds, and 1 from that epoch onward', () => {
    for (const g of ALL_GEOMETRIES) {
      const first = bindingEpoch(g, 1);
      assert.equal(latestBoundQuarter(g, first - 1n), null, `${g.name}`);
      assert.equal(latestBoundQuarter(g, first), 1, `${g.name}`);
      // Quarter 0 binds on chain but is never submittable, so it must never be the answer.
      assert.equal(latestBoundQuarter(g, bindingEpoch(g, 0)), null, `${g.name}`);
    }
  });
});

describe('the submit window', () => {
  it('expiryEpoch(q) === bindingEpoch(q + 1)', () => {
    for (const g of ALL_GEOMETRIES) {
      for (let q = 0; q <= 50; q++) {
        assert.equal(expiryEpoch(g, q), bindingEpoch(g, q + 1), `${g.name} q=${q}`);
      }
    }
  });

  it('is exactly one quarter long', () => {
    for (const g of ALL_GEOMETRIES) {
      for (let q = 1; q <= 20; q++) {
        assert.equal(expiryEpoch(g, q) - bindingEpoch(g, q), g.epochsPerQuarter, `${g.name} q=${q}`);
      }
    }
  });

  it('submitShares(q) is accepted on exactly [bindingEpoch(q), bindingEpoch(q+1))', () => {
    for (const g of DENSE) {
      for (let q = 1; q <= 6; q++) {
        const open = bindingEpoch(g, q);
        const close = expiryEpoch(g, q);
        for (const e of denseEpochs(g, 9)) {
          const revert = solidity.submitSharesRevert(g, q, e);
          const inWindow = e >= open && e < close;
          assert.equal(revert === null, inWindow, `${g.name} q=${q} epoch=${e} revert=${revert}`);
          if (e < open) assert.equal(revert, 'NotBound', `${g.name} q=${q} epoch=${e}`);
          if (e >= close) assert.equal(revert, 'NotLatestQuarter', `${g.name} q=${q} epoch=${e}`);
        }
      }
    }
  });

  it('the epoch after the window closes is NotLatestQuarter, not NotBound', () => {
    // The whole failure mode, stated once: one epoch of slippage loses the quarter.
    for (const g of ALL_GEOMETRIES) {
      for (let q = 1; q <= 8; q++) {
        const close = expiryEpoch(g, q);
        assert.equal(solidity.submitSharesRevert(g, q, close - 1n), null, `${g.name} q=${q}`);
        assert.equal(solidity.submitSharesRevert(g, q, close), 'NotLatestQuarter', `${g.name} q=${q}`);
      }
    }
  });

  it('the due quarter is always inside its own submit window', () => {
    for (const g of ALL_GEOMETRIES) {
      for (const e of interestingEpochs(g, 12)) {
        const q = latestBoundQuarter(g, e);
        if (q === null) continue;
        assert.equal(
          solidity.submitSharesRevert(g, q, e),
          null,
          `${g.name} epoch=${e} dueQuarter=${q} would revert`
        );
      }
    }
  });
});

describe('buildSchedule', () => {
  it('dueQuarter is never 0 -- submitShares rejects q == 0 with InvalidQuarter', () => {
    for (const g of ALL_GEOMETRIES) {
      for (const e of interestingEpochs(g, 12)) {
        const s = buildSchedule(g, e);
        assert.notEqual(s.dueQuarter, 0, `${g.name} epoch=${e}`);
        assert.ok(s.dueQuarter === null || s.dueQuarter >= 1, `${g.name} epoch=${e}`);
        assert.notEqual(s.submit.quarter, 0, `${g.name} epoch=${e}`);
      }
    }
  });

  it('submit.dueAtEpoch/expiresAtEpoch bracket the current epoch when a quarter is due', () => {
    for (const g of ALL_GEOMETRIES) {
      for (const e of interestingEpochs(g, 12)) {
        const s = buildSchedule(g, e);
        if (s.dueQuarter === null) {
          assert.equal(s.submit.dueAtEpoch, null);
          assert.equal(s.submit.expiresAtEpoch, null);
          continue;
        }
        assert.ok(s.submit.dueAtEpoch <= e, `${g.name} epoch=${e}`);
        assert.ok(s.submit.expiresAtEpoch > e, `${g.name} epoch=${e}`);
        assert.equal(s.submit.marginEpochs, s.submit.expiresAtEpoch - e);
        assert.ok(s.submit.marginEpochs > 0n, `${g.name} epoch=${e}`);
      }
    }
  });

  it('due flips with lastSubmittedQuarter', () => {
    const g = ALL_GEOMETRIES[0];
    const e = bindingEpoch(g, 4);
    assert.equal(buildSchedule(g, e, { lastSubmittedQuarter: 3 }).submit.due, true);
    assert.equal(buildSchedule(g, e, { lastSubmittedQuarter: 4 }).submit.due, false);
    assert.equal(buildSchedule(g, e, { lastSubmittedQuarter: 4 }).submit.alreadyDone, true);
    assert.equal(buildSchedule(g, e, { lastSubmittedQuarter: 0 }).submit.due, true);
    // A chain ahead of us is not a reason to send.
    assert.equal(buildSchedule(g, e, { lastSubmittedQuarter: 5 }).submit.due, false);
  });

  it('atRisk turns on with under a fifth of the window left, and only while unsubmitted', () => {
    const g = ALL_GEOMETRIES[0];
    const q = 4;
    const close = expiryEpoch(g, q);
    const threshold = g.epochsPerQuarter / 5n;

    const justSafe = close - threshold; // margin === threshold, not < threshold
    const atRisk = close - threshold + 1n;

    assert.equal(buildSchedule(g, justSafe, { lastSubmittedQuarter: q - 1 }).submit.atRisk, false);
    assert.equal(buildSchedule(g, atRisk, { lastSubmittedQuarter: q - 1 }).submit.atRisk, true);
    assert.equal(buildSchedule(g, atRisk, { lastSubmittedQuarter: q }).submit.atRisk, false);
  });

  it('nextPhaseEpoch always moves forward and lands on a phase change', () => {
    for (const g of ALL_GEOMETRIES) {
      for (const e of interestingEpochs(g, 8)) {
        const s = buildSchedule(g, e);
        assert.ok(s.nextPhaseEpoch > e, `${g.name} epoch=${e} phase=${s.phase}`);
        assert.equal(s.epochsUntilNextPhase, s.nextPhaseEpoch - e);
        assert.notEqual(phaseAt(g, s.nextPhaseEpoch), s.phase, `${g.name} epoch=${e}`);
        if (s.nextPhaseEpoch - 1n >= e) {
          assert.equal(phaseAt(g, s.nextPhaseEpoch - 1n), s.phase, `${g.name} epoch=${e}`);
        }
      }
    }
  });

  describe('the gate', () => {
    const g = ALL_GEOMETRIES[0];

    it('targets lastCheckedQuarter + 1, matching ++lastCheckedQuarter in quarterlyGateCheck', () => {
      const s = buildSchedule(g, bindingEpoch(g, 5), { lastCheckedQuarter: 2 });
      assert.equal(s.gate.quarter, 3);
      assert.equal(s.gate.due, true);
      assert.equal(s.gate.dueAtEpoch, bindingEpoch(g, 3));
      assert.equal(s.gate.behindBy, 3); // quarters 3, 4, 5
    });

    it('is not due while its target quarter is unbound', () => {
      const s = buildSchedule(g, bindingEpoch(g, 3) - 1n, { lastCheckedQuarter: 2 });
      assert.equal(s.gate.quarter, 3);
      assert.equal(s.gate.due, false);
      assert.equal(s.gate.behindBy, 0);
    });

    it('is never due once the 8 steps are spent', () => {
      const s = buildSchedule(g, bindingEpoch(g, 9), { lastCheckedQuarter: 2, gateComplete: true });
      assert.equal(s.gate.due, false);
      assert.equal(s.gate.complete, true);
    });

    it('handles an uninitialised gate (lastCheckedQuarter 0) without targeting quarter 0', () => {
      // GateParamsLibrary.init() seeds lastCheckedQuarter = 1; a 0 means the proxy was never
      // initialised. ++lastCheckedQuarter would then check quarter 1, which is what we target.
      const s = buildSchedule(g, bindingEpoch(g, 5), { lastCheckedQuarter: 0 });
      assert.equal(s.gate.quarter, 1);
      assert.ok(s.gate.quarter >= 1);
    });

    it('is not due when state carries no gate reading at all', () => {
      const s = buildSchedule(g, bindingEpoch(g, 5));
      assert.equal(s.gate.quarter, null);
      assert.equal(s.gate.due, false);
      assert.equal(s.gate.dueAtEpoch, null);
    });
  });
});

describe('assertGeometry (via buildSchedule)', () => {
  // Mirrors the SRA constructor's own require (ServiceRewardsActor.sol L119-L124):
  //   epochsPerQuarter > 0 && postPeriod > 0 && verificationWindow > 0
  //   && postPeriod + verificationWindow < epochsPerQuarter
  const base = { activationEpoch: 0n, epochsPerQuarter: 100n, postPeriod: 40n, verificationWindow: 30n };

  it('accepts what the constructor accepts', () => {
    assert.doesNotThrow(() => buildSchedule(base, 0n));
    assert.doesNotThrow(() =>
      buildSchedule({ ...base, postPeriod: 60n, verificationWindow: 39n }, 0n)
    );
  });

  it('rejects postPeriod + verificationWindow >= epochsPerQuarter', () => {
    assert.throws(
      () => buildSchedule({ ...base, postPeriod: 70n, verificationWindow: 30n }, 0n),
      /less than epochsPerQuarter/
    );
    assert.throws(
      () => buildSchedule({ ...base, postPeriod: 80n, verificationWindow: 30n }, 0n),
      /less than epochsPerQuarter/
    );
  });

  it('rejects non-positive parameters', () => {
    assert.throws(() => buildSchedule({ ...base, epochsPerQuarter: 0n }, 0n), /epochsPerQuarter/);
    assert.throws(() => buildSchedule({ ...base, postPeriod: 0n }, 0n), /postPeriod/);
    assert.throws(() => buildSchedule({ ...base, verificationWindow: 0n }, 0n), /verificationWindow/);
    assert.throws(() => buildSchedule({ ...base, postPeriod: -1n }, 0n), /postPeriod/);
  });

  it('every shipped network geometry is constructible', () => {
    for (const g of NETWORK_GEOMETRIES) {
      assert.ok(
        g.postPeriod + g.verificationWindow < g.epochsPerQuarter,
        `${g.name} could not be deployed: POST + VERIFY >= EPOCHS_PER_QUARTER`
      );
      assert.doesNotThrow(() => buildSchedule(g, g.activationEpoch), g.name);
    }
  });
});

describe('compareWithChain', () => {
  it('agrees when the two match, including both-null', () => {
    assert.deepEqual(compareWithChain(5, 5), { agrees: true, divergence: null });
    assert.deepEqual(compareWithChain(null, null), { agrees: true, divergence: null });
  });

  it('config-ahead is a warning: we would send too early and get a benign NotBound', () => {
    const r = compareWithChain(6, 5);
    assert.equal(r.agrees, false);
    assert.equal(r.divergence, 'config-ahead');
    assert.equal(r.severity, 'warn');
    assert.match(r.message, /too small/);
  });

  it('config-ahead when the chain has nothing bound at all', () => {
    const r = compareWithChain(3, null);
    assert.equal(r.divergence, 'config-ahead');
    assert.equal(r.severity, 'warn');
    assert.match(r.message, /the chain says none is/);
  });

  it('config-behind is critical: we would send a stale quarter and hit NotLatestQuarter', () => {
    const r = compareWithChain(4, 7);
    assert.equal(r.agrees, false);
    assert.equal(r.divergence, 'config-behind');
    assert.equal(r.severity, 'critical');
    assert.match(r.message, /NotLatestQuarter/);
  });

  it('config-behind when config has nothing but the chain does', () => {
    const r = compareWithChain(null, 2);
    assert.equal(r.divergence, 'config-behind');
    assert.equal(r.severity, 'critical');
  });
});

describe('epochsToDuration', () => {
  it('renders days, hours and minutes', () => {
    assert.equal(epochsToDuration(2n, 30), '1m');
    assert.equal(epochsToDuration(120n, 30), '1h 0m');
    assert.equal(epochsToDuration(2880n, 30), '1d 0h');
    assert.equal(epochsToDuration(0n, 30), '0m');
  });

  it('signs a negative margin rather than rendering it as positive', () => {
    // A negative margin means the window has already closed; it must not read as time left.
    assert.equal(epochsToDuration(-120n, 30), '-1h 0m');
    assert.equal(epochsToDuration(-2880n, 30), '-1d 0h');
  });

  it('honours a non-30s epoch', () => {
    assert.equal(epochsToDuration(60n, 60), '1h 0m');
  });
});
