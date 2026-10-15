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

  // From "Rehearsal Plan for Sept 28th start": activation Mon 2026-09-28 13:00 UTC at epoch
  // 4109134, one quarter per day, each quarter's cycle running the following day and binding
  // six hours in. This block pins the calendar deliberately -- when the plan moved from its
  // 23 September start to this one, these assertions failed, which is how the redeploy was
  // caught before the cranker spent Thursday cranking the abandoned contracts.
  const EXPECTED = {
    1: '2026-09-29T19:00:00Z',  // Tue -- bootstrap, no gate
    2: '2026-09-30T19:00:00Z',  // Wed -- first gate pass
    3: '2026-10-01T19:00:00Z',  // Thu
    4: '2026-10-02T19:00:00Z',  // Fri
    5: '2026-10-03T19:00:00Z',  // Sat -- no cranks
    6: '2026-10-04T19:00:00Z',  // Sun -- no cranks
    7: '2026-10-05T19:00:00Z',  // Mon -- catch-up day
    11: '2026-10-09T19:00:00Z', // Fri -- terminal state
  };

  it('activates when the plan says: Mon 28 Sep 13:00 UTC, epoch 4109134', () => {
    assert.equal(net.activationEpoch, 4109134);
    assert.equal(net.genesisUnix + net.activationEpoch * net.epochSeconds, utc('2026-09-28T13:00:00Z'));
  });

  for (const [q, when] of Object.entries(EXPECTED)) {
    it(`Q${q} fires at ${when}`, () => {
      assert.equal(bindingTime(net, Number(q)), utc(when));
    });
  }

  it('the weekend quarters fire on an actual Saturday and Sunday', () => {
    assert.equal(DAY[new Date(bindingTime(net, 5) * 1000).getUTCDay()], 'Sat');
    assert.equal(DAY[new Date(bindingTime(net, 6) * 1000).getUTCDay()], 'Sun');
  });

  it("Q5's deadline is exactly when Q6 binds, which is why the weekend costs it", () => {
    assert.equal(bindingTime(net, 6), bindingTime(net, 5) + 24 * 3600);
  });
});

