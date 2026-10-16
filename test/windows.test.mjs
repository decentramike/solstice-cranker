/**
 * src/windows.mjs and scripts/gate.mjs -- when the workflows run.
 *
 * The properties that matter, each pinned below:
 *   - a crank window opens exactly one hour before binding, not an epoch earlier;
 *   - every trigger runs for the first 72 hours, then one hour in six;
 *   - a window closes only on confirmed chain state -- never because time passed;
 *   - an unreadable chain or a missing schedule file means the crank runs (fail open);
 *   - the committed schedule files agree with config/networks.json.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';

import {
  binding,
  buildScheduleFile,
  crankWindowAt,
  deadline,
  decideClaim,
  decideCrank,
  decideWatchdog,
  scheduleMarkdown,
  scheduleMatchesConfig,
  unixToEpoch,
  windowClosed,
} from '../src/windows.mjs';
import { gate, WEEKLY_CLAIM_CRON } from '../scripts/gate.mjs';

const NETWORKS = JSON.parse(readFileSync(new URL('../config/networks.json', import.meta.url), 'utf8'));
const geometryOf = (n) => ({
  activationEpoch: NETWORKS[n].activationEpoch,
  epochsPerQuarter: NETWORKS[n].epochsPerQuarter,
  postPeriod: NETWORKS[n].postPeriod,
  verificationWindow: NETWORKS[n].verificationWindow,
});
const schedFor = (n, headEpoch = 0) => buildScheduleFile({
  network: n, geometry: geometryOf(n), genesisUnix: NETWORKS[n].genesisUnix, epochSeconds: NETWORKS[n].epochSeconds,
  addresses: { sra: NETWORKS[n].sra, swa: NETWORKS[n].swa }, headEpoch, generatedAt: 'test', sources: {},
});

const MAIN = schedFor('mainnet', 6459878);
const g = MAIN.geometry;
const HOUR = 120; // epochs
const opens = (q) => binding(g, q) - HOUR;
const NOT_DONE = { lastSubmittedQuarter: 0, lastCheckedQuarter: 0, gateComplete: false };
const done = (q) => ({ lastSubmittedQuarter: q, lastCheckedQuarter: q, gateComplete: false });

describe('the Mainnet schedule', () => {
  it('Q1 binds Thu 28 Jan 2027 20:27 UTC, at epoch 6762054', () => {
    const q1 = MAIN.quarters[0];
    assert.equal(q1.quarter, 1);
    assert.equal(q1.bindingEpoch, 6762054);
    assert.equal(q1.bindingUtc, '2027-01-28T20:27:00Z');
    assert.equal(q1.windowOpensUtc, '2027-01-28T19:27:00Z');
    assert.equal(q1.deadlineUtc, MAIN.quarters[1].bindingUtc, "Q1's deadline is the instant Q2 binds");
  });

  it('lists 8 quarters, starting at the first whose window has not closed', () => {
    assert.equal(MAIN.quarters.length, 8);
    const later = schedFor('mainnet', deadline(g, 1));
    assert.equal(later.quarters[0].quarter, 2, 'at the instant Q1 expires the list starts at Q2');
    const justBefore = schedFor('mainnet', deadline(g, 1) - 1);
    assert.equal(justBefore.quarters[0].quarter, 1);
  });

  it('refuses a geometry the SRA constructor would refuse', () => {
    assert.throws(() => buildScheduleFile({ ...MAIN, geometry: { ...g, postPeriod: g.epochsPerQuarter } }), /less than/);
  });
});

describe('the committed schedule files', () => {
  for (const n of ['mainnet', 'calibnet']) {
    it(`config/schedule.${n}.json matches config/networks.json and its own geometry`, () => {
      const file = JSON.parse(readFileSync(new URL(`../config/schedule.${n}.json`, import.meta.url), 'utf8'));
      assert.equal(file.network, n);
      assert.deepEqual(scheduleMatchesConfig(file, NETWORKS[n]), []);
      const again = schedFor(n, file.generatedAtEpoch);
      assert.deepEqual(file.quarters, again.quarters, 'regenerating from the same head gives the same table');
    });
  }

  it('docs/RUNBOOK.md carries exactly the table npm run schedule prints for the committed file', () => {
    const file = JSON.parse(readFileSync(new URL('../config/schedule.mainnet.json', import.meta.url), 'utf8'));
    const runbook = readFileSync(new URL('../docs/RUNBOOK.md', import.meta.url), 'utf8');
    const m = /<!-- schedule:mainnet:start -->\n([\s\S]*?)\n<!-- schedule:mainnet:end -->/.exec(runbook);
    assert.ok(m, 'schedule markers missing from docs/RUNBOOK.md');
    assert.equal(m[1], scheduleMarkdown(file), 'regenerate: npm run schedule, then paste the table into the runbook');
  });

  it('the Mainnet file was generated with activation epoch 6470280', () => {
    const file = JSON.parse(readFileSync(new URL('../config/schedule.mainnet.json', import.meta.url), 'utf8'));
    assert.equal(file.geometry.activationEpoch, 6470280);
  });

  it('a stale schedule is caught: any geometry or address change is a mismatch', () => {
    assert.deepEqual(scheduleMatchesConfig(MAIN, { ...NETWORKS.mainnet, activationEpoch: 6450120 }), ['activationEpoch: schedule 6470280, config 6450120']);
    assert.equal(scheduleMatchesConfig(MAIN, { ...NETWORKS.mainnet, sra: '0x' + '1'.repeat(40) }).length, 1);
  });
});

describe('crank window boundaries', () => {
  it('opens exactly one hour before binding', () => {
    assert.equal(crankWindowAt(MAIN, opens(1) - 1), null);
    const w = crankWindowAt(MAIN, opens(1));
    assert.equal(w.quarter, 1);
    assert.equal(w.hoursOpen, 0);
    assert.equal(w.everyRun, true);
  });

  it('runs every trigger for the first 72 hours, then one hour in six', () => {
    const at = (h, extra = 0) => crankWindowAt(MAIN, opens(1) + h * HOUR + extra);
    assert.equal(at(71, HOUR - 1).everyRun, true, 'the last epoch of hour 71');
    assert.equal(at(72).everyRun, false, 'the first epoch of hour 72');
    assert.equal(at(72).thinnedOut, false, 'hour 72 is a sixth hour');
    for (const h of [73, 74, 75, 76, 77]) assert.equal(at(h).thinnedOut, true, `hour ${h}`);
    assert.equal(at(78).thinnedOut, false, 'hour 78');
  });

  it('moves to Q+1 exactly one hour before Q+1 binds', () => {
    assert.equal(crankWindowAt(MAIN, opens(2) - 1).quarter, 1);
    assert.equal(crankWindowAt(MAIN, opens(2)).quarter, 2);
  });

  it('works on the devnet geometry, where quarters are shorter than 72 hours', () => {
    const dev = { ...schedFor('devnet'), genesisUnix: null };
    const dg = dev.geometry;
    assert.equal(crankWindowAt(dev, binding(dg, 3) - 120).quarter, 3);
    assert.equal(crankWindowAt(dev, binding(dg, 3) - 121).quarter, 2);
  });
});

describe('the window closes only on chain state', () => {
  it('stays open inside 72 hours until both calls have landed', () => {
    const e = binding(g, 1) + 5;
    assert.equal(decideCrank({ sched: MAIN, epoch: e, chain: NOT_DONE }).go, true);
    assert.equal(decideCrank({ sched: MAIN, epoch: e, chain: { ...NOT_DONE, lastSubmittedQuarter: 1 } }).go, true, 'gate still pending');
    assert.equal(decideCrank({ sched: MAIN, epoch: e, chain: { ...NOT_DONE, lastCheckedQuarter: 1 } }).go, true, 'submit still pending');
    assert.equal(decideCrank({ sched: MAIN, epoch: e, chain: done(1) }).go, false);
  });

  it('a completed gate counts as settled', () => {
    assert.equal(windowClosed({ lastSubmittedQuarter: 3, lastCheckedQuarter: 1, gateComplete: true }, 3).closed, true);
  });

  it('elapsed time alone never closes it: 80 days in, undone work still runs one hour in six', () => {
    const base = opens(1) + 80 * 24 * HOUR; // 1920 hours, a multiple of 6
    const runs = decideCrank({ sched: MAIN, epoch: base, chain: { ...NOT_DONE, lastSubmittedQuarter: 1 } });
    assert.equal(runs.go, true);
    assert.match(runs.reason, /gate check pending/);
    assert.equal(decideCrank({ sched: MAIN, epoch: base + HOUR, chain: NOT_DONE }).go, false, 'thinned hour');
  });

  it('closed means closed until the next window opens, whatever the clock says', () => {
    assert.equal(decideCrank({ sched: MAIN, epoch: opens(2) - 1, chain: done(1) }).go, false);
    assert.equal(decideCrank({ sched: MAIN, epoch: opens(2), chain: done(1) }).go, true, 'Q2 now due');
  });

  it('a lost quarter hands over to the next window, which runs', () => {
    // Q1 never submitted; Q2's window opens; the cranker must run (and will report Q1 lost).
    const d = decideCrank({ sched: MAIN, epoch: binding(g, 2) + 10, chain: { lastSubmittedQuarter: 0, lastCheckedQuarter: 1, gateComplete: false } });
    assert.equal(d.go, true);
    assert.equal(d.window.quarter, 2);
  });

  it('fails open when the chain cannot be read', () => {
    assert.equal(decideCrank({ sched: MAIN, epoch: binding(g, 1), chain: null }).go, true);
  });

  it('runs nothing before the first window, and a person can always force a run', () => {
    assert.equal(decideCrank({ sched: MAIN, epoch: opens(1) - 1000, chain: null }).go, false);
    assert.equal(decideCrank({ sched: MAIN, epoch: opens(1) - 1000, chain: null, ignoreWindow: true }).go, true);
  });
});

describe('watchdog cadence', () => {
  it('every 6 hours inside an open window', () => {
    for (const h of [0, 6, 12, 18]) assert.equal(decideWatchdog({ sched: MAIN, epoch: binding(g, 1), chain: NOT_DONE, utcHour: h }).go, true);
  });
  it('daily outside: only the 00:00-06:00 slot', () => {
    assert.equal(decideWatchdog({ sched: MAIN, epoch: binding(g, 1), chain: done(1), utcHour: 0 }).go, true);
    for (const h of [6, 12, 18]) assert.equal(decideWatchdog({ sched: MAIN, epoch: binding(g, 1), chain: done(1), utcHour: h }).go, false);
    assert.equal(decideWatchdog({ sched: MAIN, epoch: 6459878, chain: null, utcHour: 12 }).go, false, 'before activation');
  });
});

describe('Claim cadence', () => {
  it('weekly and manual triggers always run', () => {
    assert.equal(decideClaim({ sched: MAIN, epoch: 1, trigger: 'weekly' }).mode, 'weekly');
    assert.equal(decideClaim({ sched: MAIN, epoch: 1, trigger: 'manual' }).mode, 'manual');
  });
  it('the hourly trigger runs only from binding + 24h, for 72 hours', () => {
    const b = binding(g, 1);
    assert.equal(decideClaim({ sched: MAIN, epoch: b + 24 * HOUR - 1, trigger: 'hourly' }).go, false);
    const d = decideClaim({ sched: MAIN, epoch: b + 24 * HOUR, trigger: 'hourly' });
    assert.deepEqual([d.go, d.mode, d.quarter], [true, 'post-submit', 1]);
    assert.equal(decideClaim({ sched: MAIN, epoch: b + 96 * HOUR - 1, trigger: 'hourly' }).go, true);
    assert.equal(decideClaim({ sched: MAIN, epoch: b + 96 * HOUR, trigger: 'hourly' }).go, false);
  });
});

describe('scripts/gate.mjs', () => {
  let server;
  let url;
  let storage = {};
  before(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const { params } = JSON.parse(body);
        const key = `${params[0].toLowerCase()}:${BigInt(params[1])}`;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + (storage[key] ?? 0n).toString(16).padStart(64, '0') }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  const slots = JSON.parse(readFileSync(new URL('../config/storage-slots.json', import.meta.url), 'utf8'));
  const setChain = ({ submitted, checked, steps = 0 }) => {
    storage = {
      [`${NETWORKS.mainnet.sra.toLowerCase()}:${BigInt(slots.sraQuarter.slot)}`]: BigInt(submitted),
      [`${NETWORKS.mainnet.swa.toLowerCase()}:${BigInt(slots.swaGateParams.slot)}`]: BigInt(checked),
      [`${NETWORKS.mainnet.swa.toLowerCase()}:${BigInt(slots.swaGateParams.slot) + 3n}`]: BigInt(steps),
    };
  };
  const iso = (epoch) => new Date((NETWORKS.mainnet.genesisUnix + epoch * 30) * 1000).toISOString();
  const env = (extra) => ({ NETWORK: 'mainnet', GITHUB_EVENT_NAME: 'schedule', RPC_URL: url, ...extra });

  it('outside a window it answers from the file, before any RPC', async () => {
    const d = await gate('crank', env({ RPC_URL: 'http://127.0.0.1:1', GATE_NOW: '2026-11-01T00:00:00Z' }));
    assert.equal(d.go, false);
  });

  it('inside a window it reads the chain and closes only when both calls landed', async () => {
    const now = iso(binding(g, 1) + 300);
    setChain({ submitted: 0, checked: 1 });
    assert.equal((await gate('crank', env({ GATE_NOW: now }))).go, true);
    setChain({ submitted: 1, checked: 1 });
    assert.equal((await gate('crank', env({ GATE_NOW: now }))).go, false);
  });

  it('fails open when the RPC is unreachable', async () => {
    const d = await gate('crank', env({ RPC_URL: 'http://127.0.0.1:1', GATE_NOW: iso(binding(g, 1)) }));
    assert.equal(d.go, true);
  });

  it('fails open for the crank, and runs only weekly/manual Claims, when the schedule file is missing', async () => {
    assert.equal((await gate('crank', { NETWORK: 'devnet', GITHUB_EVENT_NAME: 'schedule' })).go, true);
    assert.equal((await gate('claim', { NETWORK: 'devnet', GITHUB_EVENT_NAME: 'schedule', EVENT_SCHEDULE: '41 * * * *' })).go, false);
    assert.equal((await gate('claim', { NETWORK: 'devnet', GITHUB_EVENT_NAME: 'schedule', EVENT_SCHEDULE: WEEKLY_CLAIM_CRON })).go, true);
  });

  it('a manual run with ignore_window always goes', async () => {
    const d = await gate('crank', env({ GITHUB_EVENT_NAME: 'workflow_dispatch', IGNORE_WINDOW: 'true', GATE_NOW: '2026-11-01T00:00:00Z' }));
    assert.equal(d.go, true);
  });

  it('a dispatch without ignore_window (the external timer) is gated like the schedule', async () => {
    const d = await gate('crank', env({ GITHUB_EVENT_NAME: 'workflow_dispatch', GATE_NOW: '2026-11-01T00:00:00Z' }));
    assert.equal(d.go, false);
  });

  it('claim: the weekly cron string selects weekly mode; the hourly cron needs a post-submit window', async () => {
    assert.equal((await gate('claim', env({ EVENT_SCHEDULE: WEEKLY_CLAIM_CRON, GATE_NOW: '2026-11-04T14:41:00Z' }))).mode, 'weekly');
    assert.equal((await gate('claim', env({ EVENT_SCHEDULE: '41 * * * *', GATE_NOW: '2026-11-04T14:41:00Z' }))).go, false);
    const d = await gate('claim', env({ EVENT_SCHEDULE: '41 * * * *', GATE_NOW: iso(binding(g, 1) + 25 * HOUR) }));
    assert.deepEqual([d.go, d.mode, d.quarter], [true, 'post-submit', 1]);
  });

  it('unixToEpoch agrees with the schedule file\'s own times', () => {
    assert.equal(unixToEpoch(MAIN, Date.parse(MAIN.quarters[0].bindingUtc) / 1000), MAIN.quarters[0].bindingEpoch);
  });
});
