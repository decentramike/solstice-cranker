/**
 * runCrank against the local devnet.
 *
 * These are the only tests that prove the pieces fit: real storage slots, real reverts coming
 * back through a real provider, real transactions landing. Everything else in test/ is pure.
 *
 * The devnet is built in parallel with this suite, so the whole file skips with a readable
 * reason when it is not up. Nothing here is hard-coded to a particular chain height: each test
 * reads the current state, picks a quarter ahead of it, and mines forward. Every test takes an
 * evm_snapshot first and reverts to it afterwards, so a shared devnet ends where it started.
 *
 * No key is written anywhere. The cranker signer is derived at run time from Hardhat's public
 * test mnemonic by account index (devnet/fixtures.mjs ACCOUNTS.cranker).
 */
import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it } from 'node:test';

const ROOT = new URL('../../', import.meta.url);

/** Loads the devnet helpers and checks the chain is actually usable. Returns null when it is. */
async function unavailable() {
  let F;
  try {
    F = await import(new URL('devnet/fixtures.mjs', ROOT).href);
  } catch (err) {
    return { reason: `devnet/fixtures.mjs could not be loaded (${err.message})` };
  }

  let chainId;
  try {
    chainId = Number(await F.rpc('eth_chainId'));
  } catch {
    return { reason: `nothing answering on ${F.RPC_URL} -- start it with \`npm run devnet\`` };
  }
  if (chainId !== F.CHAIN_ID) {
    return { reason: `chain ${chainId} on ${F.RPC_URL}, expected ${F.CHAIN_ID}` };
  }

  if (!F.deploymentExists()) {
    return { reason: 'devnet/.deployed.json is missing -- run `npm run devnet:deploy`' };
  }

  const d = F.loadDeployment();
  for (const key of ['sra', 'swa']) {
    const code = await F.rpc('eth_getCode', [d[key], 'latest']);
    if (!code || code === '0x') {
      return { reason: `no code at ${key} ${d[key]} -- the node was restarted since the deploy` };
    }
  }

  try {
    F.artifactOf('ServiceRewardsActor');
  } catch (err) {
    return { reason: err.message };
  }

  // These tests mine, snapshot and revert. Another process doing the same on the same node
  // (npm run rehearsal, npm run demo, the devnet server) makes every assertion here a race,
  // and reverting would throw away its work. Refuse rather than interfere.
  const before = Number(await F.rpc('eth_blockNumber'));
  await new Promise((r) => setTimeout(r, 500));
  const after = Number(await F.rpc('eth_blockNumber'));
  if (before !== after) {
    return {
      reason:
        `another process is driving ${F.RPC_URL} (block ${before} -> ${after} while idle); ` +
        'the integration suite needs the devnet to itself',
    };
  }

  return { F, d };
}

const probe = await unavailable();
const skip = probe.reason ?? false;
if (skip) process.stderr.write(`\n  integration: skipping -- ${skip}\n\n`);

const F = probe.F;
const DEPLOYMENT = probe.d;

describe('cranker against the local devnet', { skip }, () => {
  let loadConfig;
  let runCrank;
  let classifyRevert;
  let crankerKey;

  before(async () => {
    ({ loadConfig } = await import(new URL('src/config.mjs', ROOT).href));
    ({ runCrank } = await import(new URL('src/crank.mjs', ROOT).href));
    ({ classifyRevert } = await import(new URL('src/errors.mjs', ROOT).href));
    // Derived from the public Hardhat mnemonic by index; never logged, never written to disk.
    crankerKey = F.walletAt(F.ACCOUNTS.cranker).privateKey;
  });

  /** A config pointed at the devnet deployment, with whatever the test wants changed. */
  function makeConfig({ addresses, ...rest } = {}) {
    process.env.NETWORK = 'devnet';
    process.env.RPC_URL = F.RPC_URL;
    process.env.SRA_ADDRESS = DEPLOYMENT.sra;
    process.env.SWA_ADDRESS = DEPLOYMENT.swa;
    process.env.CRANKER_PRIVATE_KEY = crankerKey;
    delete process.env.CRANK_DRY_RUN;
    delete process.env.CRANK_PAUSED;
    delete process.env.CRANK_DISABLED_DAYS;
    delete process.env.CRANK_DISABLED_WEEKDAYS;
    delete process.env.CRANK_STATE_DIR; // never write a run record into the repo from a test

    const config = loadConfig();
    config.alerts.transports = []; // collect alerts, deliver none
    Object.assign(config, rest);
    if (addresses) Object.assign(config.addresses, addresses);
    return config;
  }

  const actionsFor = (record, call) => record.actions.filter((a) => a.call === call);
  const bindingOf = (q) => F.bindingEpochOf(q, DEPLOYMENT);

  /**
   * config/networks.json carries placeholder geometry for devnet, so every run legitimately
   * warns that activationEpoch/epochsPerQuarter differ from the deployment. That is noise for
   * these assertions, not a finding.
   */
  const realAlerts = (alerts) =>
    alerts.alerts.filter((a) => !/stale (activationEpoch|epochsPerQuarter)/.test(a.title));

  /** Mines forward to `epoch` when we are not already past it. */
  async function ensureAtLeast(epoch) {
    const now = await F.currentEpoch();
    return epoch > now ? F.mineTo(epoch) : now;
  }

  /** The chain's latest bound quarter at `epoch`, from the deployment record's own geometry. */
  function latestBoundQuarterNow(epoch) {
    const g = F.quarterGeometry(epoch, DEPLOYMENT);
    return g.phase === 'bound' ? g.quarter : g.quarter - 1;
  }

  const failures = (record) => record.actions.filter((a) => a.decision === 'failed');

  /** Runs the cranker until it stops broadcasting, so the chain is caught up. */
  async function crankUntilQuiet(limit = 24) {
    for (let i = 0; i < limit; i++) {
      const { record } = await runCrank(makeConfig());
      if (!record.actions.some((a) => a.decision === 'sent')) return record;
    }
    throw new Error(`the cranker was still broadcasting after ${limit} runs`);
  }

  /** The first quarter whose posting window has not opened yet. */
  async function nextUntouchedQuarter() {
    const epoch = await F.currentEpoch();
    const here = F.quarterGeometry(epoch, DEPLOYMENT).quarter;
    const state = await F.readSraQuarterState();
    const gate = await F.readSwaGateState();
    return Math.max(here + 1, state.lastSubmittedQuarter + 1, gate.lastCheckedQuarter + 1);
  }

  let snap;
  beforeEach(async () => {
    snap = await F.snapshot();
  });
  afterEach(async () => {
    await F.revertTo(snap);
  });

  it('the deployment geometry is the one config/networks.json describes', () => {
    // A mismatch here means every epoch arithmetic below is testing the wrong chain.
    assert.ok(DEPLOYMENT.epochsPerQuarter > 0);
    assert.ok(
      DEPLOYMENT.postPeriod + DEPLOYMENT.verificationWindow < DEPLOYMENT.epochsPerQuarter,
      'the deployed geometry could not have passed the SRA constructor'
    );
  });

  it('skips cleanly before binding and exits 0', async () => {
    const q = await nextUntouchedQuarter();
    // Comfortably before quarter q binds, not one epoch before. At bindingOf(q) - 1 the
    // cranker's own first transaction mines the block that binds q, which makes this a test
    // of the mid-run binding race rather than of the early-skip path. That race has its own
    // test below.
    await F.mineTo(bindingOf(q) - 20);
    await crankUntilQuiet(); // settle whatever the deployment left outstanding

    const { record, exitCode, alerts } = await runCrank(makeConfig());

    // A run before binding must not FAIL, but its exit code also answers "is anything wrong
    // on this deployment?" -- and a gap left by an earlier fixture is genuinely wrong. Assert
    // the precise relationship rather than a bare 0, so this keeps testing the early-skip
    // behaviour instead of the state the fixtures happened to leave behind.
    assert.equal(
      exitCode,
      record.schedule.missedQuarters.length > 0 ? 1 : 0,
      JSON.stringify({ actions: record.actions, missed: record.schedule.missedQuarters }, null, 2)
    );
    assert.ok(!record.actions.some((a) => a.decision === 'failed'), 'a routine early run failed');
    assert.ok(!record.actions.some((a) => a.decision === 'sent'), 'something was broadcast too early');

    const submit = actionsFor(record, 'submitShares');
    assert.equal(submit[0].decision, 'skipped');
    assert.equal(submit[0].outcome, 'already-done');

    const gate = actionsFor(record, 'quarterlyGateCheck');
    assert.equal(gate.length, 1);
    assert.equal(gate[0].decision, 'skipped');
    if ((await F.readSwaGateState()).complete) {
      // The gate spent its 8 steps on this deployment; it is closed for good.
      assert.equal(gate[0].outcome, 'gate-closed');
      assert.equal(gate[0].reason, 'StepsComplete()');
    } else {
      assert.equal(gate[0].outcome, 'not-due');
      assert.match(gate[0].reason ?? '', /^NotBound\(/);
    }

    assert.deepEqual(
      realAlerts(alerts).map((a) => a.title),
      [],
      'a healthy early run raised an alert'
    );
  });

  it('submits the bound quarter and advances lastSubmittedQuarter', async () => {
    const q = await nextUntouchedQuarter();
    await F.postVolume(q, '4200');
    await F.mineTo(bindingOf(q));

    const before = await F.readSraQuarterState();
    assert.ok(before.lastSubmittedQuarter < q);

    const { record, exitCode } = await runCrank(makeConfig());

    const submit = actionsFor(record, 'submitShares');
    assert.equal(submit.length, 1);
    assert.equal(submit[0].decision, 'sent', submit[0].message);
    assert.equal(submit[0].outcome, 'landed');
    assert.equal(submit[0].quarter, q);
    assert.match(submit[0].txHash, /^0x[0-9a-f]{64}$/);
    assert.ok(Number(submit[0].gasUsed) > 0);
    assert.deepEqual(failures(record), []);
    assert.equal(exitCode, 0, JSON.stringify(record.actions, null, 2));

    const after = await F.readSraQuarterState();
    assert.equal(after.lastSubmittedQuarter, q, 'the chain did not record the submission');
    assert.equal(record.schedule.submitDueQuarter, q);
    assert.equal(record.schedule.chainAgreesWithConfig, true);
  });

  it('a second run over the same quarter is a clean skip, not a duplicate send', async () => {
    const q = await nextUntouchedQuarter();
    await F.postVolume(q, '4200');
    await F.mineTo(bindingOf(q));
    await crankUntilQuiet();

    const { record, exitCode, alerts } = await runCrank(makeConfig());

    assert.equal(exitCode, 0, JSON.stringify(record.actions, null, 2));
    const submit = actionsFor(record, 'submitShares');
    assert.equal(submit[0].decision, 'skipped');
    assert.equal(submit[0].outcome, 'already-done');
    assert.equal(submit[0].txHash, null, 'a duplicate submit was broadcast');
    assert.equal((await F.readSraQuarterState()).lastSubmittedQuarter, q);
    assert.deepEqual(
      realAlerts(alerts).map((a) => a.title),
      [],
      'a routine repeat run alerted'
    );
  });

  it('the contract rejects a second submitShares with AlreadySubmitted, classified benign', async () => {
    const q = await nextUntouchedQuarter();
    await F.postVolume(q, '4200');
    await F.mineTo(bindingOf(q));
    await runCrank(makeConfig());

    // Straight at the contract, through ethers, so the error object is the real shape.
    const err = await F.sra(F.ACCOUNTS.cranker)
      .submitShares(q)
      .then(() => null, (e) => e);
    assert.ok(err, 'the SRA accepted a duplicate submitShares');

    const v = classifyRevert(err);
    assert.equal(v.name, 'AlreadySubmitted');
    assert.deepEqual(v.args, [String(q)]);
    assert.equal(v.kind, 'benign');
    assert.notEqual(v.severity, 'critical');
  });

  describe('the missed window', () => {
    it('the SRA answers NotLatestQuarter once the next quarter binds, and it decodes as critical', async () => {
      const q = await nextUntouchedQuarter();
      await F.postVolume(q, '4200');
      // One epoch past the close of quarter q's submit window.
      await F.mineTo(bindingOf(q + 1));

      const err = await F.sra(F.ACCOUNTS.cranker)
        .submitShares.staticCall(q)
        .then(() => null, (e) => e);
      assert.ok(err, `submitShares(${q}) was still accepted after quarter ${q + 1} bound`);

      const v = classifyRevert(err);
      assert.equal(v.name, 'NotLatestQuarter');
      assert.deepEqual(v.args, [String(q)]);
      assert.equal(v.kind, 'critical');
      assert.equal(v.outcome, 'missed-window');
      assert.equal(v.severity, 'critical');

      // crank.mjs: kind critical|fault -> decision "failed"; any failed action -> exit code 1.
      const decision = v.kind === 'critical' || v.kind === 'fault' ? 'failed' : 'skipped';
      assert.equal(decision, 'failed');
      assert.equal([{ decision }].some((a) => a.decision === 'failed') ? 1 : 0, 1);
    });

    it('one epoch earlier the same call still lands', async () => {
      const q = await nextUntouchedQuarter();
      await F.postVolume(q, '4200');
      await F.mineTo(bindingOf(q + 1) - 1);
      await assert.doesNotReject(() => F.sra(F.ACCOUNTS.cranker).submitShares.staticCall(q));
    });

    it('reports a silently skipped quarter as critical, even though it lands the next one', async () => {
      // Quarter q is never submitted; by the time the cranker runs, q+1 has bound. The cranker
      // correctly targets q+1 and lands it -- so no NotLatestQuarter is ever raised, because
      // the stale quarter is never attempted. This used to report a completely healthy run
      // while a share map was permanently lost. The gap itself is now the alarm.
      // Land an earlier quarter first. With lastSubmittedQuarter still 0 this is a cold
      // start -- the cranker has never submitted anything on this deployment -- and it
      // deliberately does not page anyone about quarters that predate it being switched on.
      const earlier = await nextUntouchedQuarter();
      await F.postVolume(earlier, '4200');
      await F.mineTo(bindingOf(earlier));
      await crankUntilQuiet();
      assert.equal(
        (await F.readSraQuarterState()).lastSubmittedQuarter,
        earlier,
        'the fixture needs a real prior submission so this is not a cold start'
      );

      const q = await nextUntouchedQuarter();
      await F.postVolume(q, '4200');
      await F.mineTo(bindingOf(q + 1));

      const submittedBefore = (await F.readSraQuarterState()).lastSubmittedQuarter;
      assert.ok(submittedBefore < q, 'the fixture did not actually leave a gap');
      assert.ok(submittedBefore >= 1, 'not a cold start');

      const { record, exitCode, alerts } = await runCrank(makeConfig());

      const submit = actionsFor(record, 'submitShares');
      assert.equal(submit[0].quarter, q + 1, 'the cranker did not jump the gap');
      assert.equal(submit[0].decision, 'sent');
      assert.equal((await F.readSraQuarterState()).lastSubmittedQuarter, q + 1);

      // No action FAILED -- submitting q+1 genuinely succeeded -- but the run must not be
      // green, and somebody must be told.
      assert.deepEqual(failures(record), [], 'submitting the latest quarter did succeed');
      assert.ok(
        record.schedule.missedQuarters.includes(q),
        `missedQuarters ${JSON.stringify(record.schedule.missedQuarters)} must name quarter ${q}`
      );
      assert.equal(exitCode, 1, 'a run that leaves a lost quarter behind must not report healthy');

      const critical = realAlerts(alerts).filter((a) => a.severity === 'critical');
      assert.equal(critical.length, 1, 'exactly one critical alert about the lost quarter');
      assert.match(critical[0].title, new RegExp(`\\b${q}\\b`), 'the alert must name the quarter');
      assert.match(
        critical[0].body,
        /cannot be recovered|permanently|never submitted/i,
        'the alert must say the loss is permanent'
      );
    });
  });

  describe('the gate', () => {
    it('advances lastCheckedQuarter by exactly one per successful call', async (t) => {
      // The invariant the catch-up loop is built on: quarterlyGateCheck() takes no argument
      // and does ++lastCheckedQuarter (StreamWeightActor.sol L123).
      const before = await F.readSwaGateState();
      if (before.complete) return t.skip('the gate on this deployment has spent all 8 steps');
      await ensureAtLeast(bindingOf(before.lastCheckedQuarter + 3));

      const swa = F.swa(F.ACCOUNTS.cranker);
      for (let i = 1; i <= 3; i++) {
        await (await swa.quarterlyGateCheck()).wait();
        const now = await F.readSwaGateState();
        assert.equal(now.lastCheckedQuarter, before.lastCheckedQuarter + i);
      }
    });

    it('catches a multi-quarter gap up in a single run, one transaction per quarter', async (t) => {
      const gateBefore = await F.readSwaGateState();
      if (gateBefore.complete) return t.skip('the gate on this deployment has spent all 8 steps');

      const target = gateBefore.lastCheckedQuarter + 1;
      const gap = 3;
      await ensureAtLeast(bindingOf(target + gap - 1));
      // Settle submitShares first so this run is about the gate alone.
      await crankUntilQuiet(24);
      const settled = await F.readSwaGateState();
      if (settled.lastCheckedQuarter >= target + gap - 1) return t.skip('nothing left to catch up');

      const from = settled.lastCheckedQuarter + 1;
      const expected = latestBoundQuarterNow(await F.currentEpoch()) - from + 1;
      if (expected < 2) return t.skip('fewer than two quarters are outstanding');

      const { record, exitCode } = await runCrank(makeConfig());
      const gate = actionsFor(record, 'quarterlyGateCheck');
      const sent = gate.filter((a) => a.decision === 'sent');

      assert.equal(
        sent.length,
        expected,
        `expected ${expected} gate transactions in one run, got ` +
          JSON.stringify(gate.map((a) => [a.quarter, a.decision, a.message]))
      );
      assert.deepEqual(
        sent.map((a) => a.quarter),
        Array.from({ length: expected }, (_, i) => from + i),
        'the gate actions are not labelled with consecutive quarters'
      );
      assert.equal(exitCode, 0, JSON.stringify(record.actions, null, 2));

      // quarterlyGateCheck takes no argument and does ++lastCheckedQuarter, so N landed
      // transactions must move the counter by exactly N.
      assert.equal((await F.readSwaGateState()).lastCheckedQuarter, from + expected - 1);

      // It stops on the first quarter that is not yet bound rather than burning the cap.
      assert.equal(gate.at(-1).decision, 'skipped');
      assert.match(gate.at(-1).reason ?? '', /^NotBound\(/);
    });

    it('honours the gate catch-up cap', async (t) => {
      const gateBefore = await F.readSwaGateState();
      if (gateBefore.complete) return t.skip('the gate on this deployment has spent all 8 steps');
      await ensureAtLeast(bindingOf(gateBefore.lastCheckedQuarter + 5));
      await crankUntilQuiet(24);

      const settled = await F.readSwaGateState();
      const from = settled.lastCheckedQuarter + 1;
      if (latestBoundQuarterNow(await F.currentEpoch()) - from + 1 < 3) return t.skip('fewer than three quarters are outstanding');

      const { record } = await runCrank(makeConfig({ maxGateCatchup: 2 }));
      const sent = actionsFor(record, 'quarterlyGateCheck').filter((a) => a.decision === 'sent');
      assert.equal(sent.length, 2);
      assert.equal((await F.readSwaGateState()).lastCheckedQuarter, from + 1);
    });
  });

  it('a paused run reads state, sends nothing and still exits 0', async () => {
    const q = await nextUntouchedQuarter();
    await F.postVolume(q, '4200');
    await F.mineTo(bindingOf(q));

    const config = makeConfig();
    process.env.CRANK_PAUSED = '1'; // resolvePause reads process.env at run time
    let record, exitCode;
    try {
      ({ record, exitCode } = await runCrank(config));
    } finally {
      delete process.env.CRANK_PAUSED;
    }

    assert.equal(exitCode, 0, JSON.stringify(record.actions, null, 2));
    assert.equal(record.paused, true);
    assert.ok(record.actions.every((a) => a.decision === 'skipped'), 'a paused run broadcast');
    assert.ok(record.actions.every((a) => a.txHash === null));
    assert.ok((await F.readSraQuarterState()).lastSubmittedQuarter < q);
  });

  it('a dry run simulates and broadcasts nothing', async () => {
    const q = await nextUntouchedQuarter();
    await F.postVolume(q, '4200');
    await F.mineTo(bindingOf(q));

    const { record, exitCode } = await runCrank(makeConfig({ dryRun: true }));

    assert.equal(exitCode, 0, JSON.stringify(record.actions, null, 2));
    const submit = actionsFor(record, 'submitShares');
    assert.equal(submit[0].decision, 'dry-run');
    assert.equal(submit[0].txHash, null);
    assert.ok((await F.readSraQuarterState()).lastSubmittedQuarter < q);

    // A dry run must not loop the gate: nothing moved, so a second pass would re-simulate
    // the same quarter under a wrong label.
    assert.equal(actionsFor(record, 'quarterlyGateCheck').length, 1);
  });

  it('an undecodable revert fails the run and exits 1', async () => {
    // Point the SWA handle at the SRA: quarterlyGateCheck is not there, so the call reverts
    // with nothing the shipped ABI can decode. That must be a fault, never a quiet skip.
    const q = await nextUntouchedQuarter();
    await F.mineTo(bindingOf(q));

    const { record, exitCode, alerts } = await runCrank(
      makeConfig({ addresses: { swa: DEPLOYMENT.sra } })
    );

    const gate = actionsFor(record, 'quarterlyGateCheck');
    assert.equal(gate[0].decision, 'failed', JSON.stringify(gate, null, 2));
    assert.equal(gate[0].outcome, 'error');
    assert.equal(exitCode, 1);
    assert.equal(record.exitCode, 1);
    assert.ok(alerts.alerts.some((a) => a.title.includes('quarterlyGateCheck')));
  });

  it('the run record matches docs/DATA-CONTRACT.md', async () => {
    const q = await nextUntouchedQuarter();
    await F.mineTo(bindingOf(q));
    const { record } = await runCrank(makeConfig());

    for (const key of [
      'runId', 'startedAt', 'finishedAt', 'network', 'chainId', 'epoch',
      'cranker', 'balanceFil', 'paused', 'pauseReason', 'actions', 'schedule', 'exitCode',
    ]) {
      assert.ok(key in record, `run record is missing ${key}`);
    }
    assert.equal(typeof record.epoch, 'number');
    assert.equal(typeof record.chainId, 'number');

    const DECISIONS = new Set(['sent', 'skipped', 'failed', 'dry-run']);
    const OUTCOMES = new Set(['landed', 'not-due', 'already-done', 'gate-closed', 'missed-window', 'error']);
    const SEVERITIES = new Set(['info', 'warn', 'critical']);
    for (const a of record.actions) {
      assert.ok(['submitShares', 'quarterlyGateCheck', 'preflight'].includes(a.call), a.call);
      assert.ok(DECISIONS.has(a.decision), a.decision);
      assert.ok(OUTCOMES.has(a.outcome), a.outcome);
      assert.ok(SEVERITIES.has(a.severity), a.severity);
      assert.ok(a.quarter === null || Number.isInteger(a.quarter));
    }

    for (const key of [
      'currentQuarter', 'phase', 'submitDueQuarter', 'submitDueAtEpoch', 'submitDeadlineEpoch',
      'gateDueQuarter', 'gateDueAtEpoch', 'chainAgreesWithConfig', 'divergence',
    ]) {
      assert.ok(key in record.schedule, `record.schedule is missing ${key}`);
    }
    // Numbers, not BigInt: the record is serialised straight to JSON.
    assert.doesNotThrow(() => JSON.stringify(record));
  });

  it('the submit deadline in the record is the quarter the cranker actually targeted', async () => {
    const q = await nextUntouchedQuarter();
    await F.mineTo(bindingOf(q));
    const { record } = await runCrank(makeConfig());
    const due = record.schedule.submitDueQuarter;
    assert.equal(record.schedule.submitDueAtEpoch, bindingOf(due));
    assert.equal(record.schedule.submitDeadlineEpoch, bindingOf(due + 1));
  });
});
