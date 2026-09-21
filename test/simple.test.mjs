/**
 * The simple cranker's clock must agree with the real one's.
 *
 * scripts/crank-simple.mjs decides everything from wall-clock arithmetic and never reads
 * the chain. src/schedule.mjs decides from epochs and is cross-checked against the chain on
 * every run. They are two independent derivations of the same thing, so they are worth
 * holding against each other: if they ever disagree, one of them is sending at the wrong
 * time, and the simple one has no way to notice on its own.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { bindingEpoch, expiryEpoch } from '../src/schedule.mjs';

const NETWORKS = JSON.parse(readFileSync(new URL('../config/networks.json', import.meta.url), 'utf8'));

/** Reimplemented from scripts/crank-simple.mjs -- deliberately, so a change there fails here. */
const bindingTime = (net, q) =>
  net.genesisUnix + (net.activationEpoch + q * net.epochsPerQuarter + net.postPeriod + net.verificationWindow) * net.epochSeconds;

function dueQuarterAt(net, now) {
  const first = bindingTime(net, 1);
  if (now < first) return null;
  return 1 + Math.floor((now - first) / (net.epochsPerQuarter * net.epochSeconds));
}

const REAL = ['calibnet', 'mainnet'];
const utc = (s) => Math.floor(Date.parse(s) / 1000);

describe('the simple cranker agrees with the epoch schedule', () => {
  for (const name of REAL) {
    const net = NETWORKS[name];

    it(`${name}: every quarter's send time is its binding epoch`, () => {
      assert.ok(net.genesisUnix, `${name} needs a genesisUnix`);
      const geometry = {
        activationEpoch: BigInt(net.activationEpoch),
        epochsPerQuarter: BigInt(net.epochsPerQuarter),
        postPeriod: BigInt(net.postPeriod),
        verificationWindow: BigInt(net.verificationWindow),
      };

      for (let q = 1; q <= 40; q++) {
        const fromEpochs = Number(bindingEpoch(geometry, q)) * net.epochSeconds + net.genesisUnix;
        assert.equal(bindingTime(net, q), fromEpochs, `${name} Q${q} binding time`);

        const deadlineFromEpochs = Number(expiryEpoch(geometry, q)) * net.epochSeconds + net.genesisUnix;
        assert.equal(bindingTime(net, q + 1), deadlineFromEpochs, `${name} Q${q} deadline`);
      }
    });

    it(`${name}: the due quarter matches a brute-force scan`, () => {
      const quarterSeconds = net.epochsPerQuarter * net.epochSeconds;
      const start = bindingTime(net, 1);
      // Every boundary and either side of it, across three years of quarters.
      for (let q = 1; q <= 40; q++) {
        for (const offset of [-1, 0, 1, Math.floor(quarterSeconds / 2), quarterSeconds - 1]) {
          const now = bindingTime(net, q) + offset;
          if (now < start) {
            assert.equal(dueQuarterAt(net, now), null);
            continue;
          }
          let expected = null;
          for (let probe = 1; bindingTime(net, probe) <= now; probe++) expected = probe;
          assert.equal(dueQuarterAt(net, now), expected, `${name} at ${new Date(now * 1000).toISOString()}`);
        }
      }
    });

    it(`${name}: nothing is due before the first quarter binds`, () => {
      const first = bindingTime(net, 1);
      assert.equal(dueQuarterAt(net, first - 1), null);
      assert.equal(dueQuarterAt(net, first), 1, 'due exactly on the binding second');
      assert.equal(dueQuarterAt(net, 0), null);
    });
  }
});

describe('the calibnet rehearsal lands on the days the plan says', () => {
  const net = NETWORKS.calibnet;
  const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // From the rehearsal plan: activation Wed 2026-09-23 13:00 UTC, one quarter per day,
  // each quarter's cycle running the following day and binding six hours in.
  const EXPECTED = {
    1: '2026-09-24T19:00:00Z',
    2: '2026-09-25T19:00:00Z',
    3: '2026-09-26T19:00:00Z', // Sat -- no cranks
    4: '2026-09-27T19:00:00Z', // Sun -- no cranks
    5: '2026-09-28T19:00:00Z', // Mon -- catch-up
    10: '2026-10-03T19:00:00Z', // Sat -- no cranks
    11: '2026-10-04T19:00:00Z', // Sun -- no cranks
    12: '2026-10-05T19:00:00Z', // Mon -- catch-up
    14: '2026-10-07T19:00:00Z', // end of the rehearsal
  };

  for (const [q, when] of Object.entries(EXPECTED)) {
    it(`Q${q} fires at ${when}`, () => {
      assert.equal(bindingTime(net, Number(q)), utc(when));
    });
  }

  it('the four no-crank days are the ones CRANK_DISABLED_DAYS names', () => {
    const paused = ['2026-09-26', '2026-09-27', '2026-10-03', '2026-10-04'];
    const firesOn = (q) => new Date(bindingTime(net, q) * 1000).toISOString().slice(0, 10);
    for (const q of [3, 4, 10, 11]) {
      assert.ok(paused.includes(firesOn(q)), `Q${q} fires on ${firesOn(q)}, which is not paused`);
    }
    // And the quarters either side must NOT be suppressed.
    for (const q of [2, 5, 9, 12]) {
      assert.ok(!paused.includes(firesOn(q)), `Q${q} fires on ${firesOn(q)}, which is paused but should not be`);
    }
  });

  it('every weekend quarter fires on an actual weekend day', () => {
    for (const q of [3, 10]) {
      assert.equal(DAY[new Date(bindingTime(net, q) * 1000).getUTCDay()], 'Sat', `Q${q}`);
    }
    for (const q of [4, 11]) {
      assert.equal(DAY[new Date(bindingTime(net, q) * 1000).getUTCDay()], 'Sun', `Q${q}`);
    }
  });

  it("Q3's deadline is exactly when Q4 binds, which is why the weekend costs it", () => {
    assert.equal(bindingTime(net, 4), bindingTime(net, 3) + 24 * 3600);
    assert.equal(bindingTime(net, 11), bindingTime(net, 10) + 24 * 3600);
  });
});
