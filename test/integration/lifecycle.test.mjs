/**
 * The whole windowed lifecycle on the local devnet, over several short quarters.
 *
 * Each "tick" is one trigger: the gate decides exactly as the workflow's gate job does
 * (decideCrank over the schedule geometry, closure read by scripts/gate.mjs's own storage
 * probe), and when it says go, the cranker runs as GitHub runs it -- `node scripts/crank.mjs`
 * in a child process, env in, record and exit code out.
 *
 * Scenarios, in chain order:
 *   Q    window opens an hour before binding; a missed run inside the window; lands; closes
 *   Q+1  our crank lands first; a second sender's submitShares reverts AlreadySubmitted (benign)
 *   Q+2  a second sender lands submitShares first; the gate stays pending, so the window stays
 *        open (late gate) until our crank lands the gate check; only then does it close
 *   Q+3  rescued in the handover hour: nothing ran in its window until Q+4's window opened
 *   Q+5  lost: no run at all until Q+6 binds; the cranker lands Q+6 and reports Q+5 critical
 *   Claim: 24 hours after a submitShares lands, scripts/claim.mjs (post-submit) sends one
 *        signed Claim to the fake f02 and pays the share map; a second run sends nothing.
 *
 * Devnet geometry: 240-epoch quarters, binding 160 epochs in; one hour is 120 epochs.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

const ROOT = new URL('../../', import.meta.url);

async function unavailable() {
  let F;
  try {
    F = await import(new URL('devnet/fixtures.mjs', ROOT).href);
  } catch (err) {
    return { reason: `devnet/fixtures.mjs could not be loaded (${err.message})` };
  }
  try {
    if (Number(await F.rpc('eth_chainId')) !== F.CHAIN_ID) return { reason: 'wrong chain on the devnet port' };
  } catch {
    return { reason: `nothing answering on ${F.RPC_URL} -- start it with \`npm run devnet\`` };
  }
  if (!F.deploymentExists()) return { reason: 'devnet/.deployed.json is missing -- run `npm run devnet:deploy`' };
  const d = F.loadDeployment();
  const code = await F.rpc('eth_getCode', [d.sra, 'latest']);
  if (!code || code === '0x') return { reason: 'no code at the SRA -- the node was restarted since the deploy' };
  const a = Number(await F.rpc('eth_blockNumber'));
  await new Promise((r) => setTimeout(r, 500));
  if (Number(await F.rpc('eth_blockNumber')) !== a) return { reason: 'another process is driving the devnet' };
  return { F, d };
}

const probe = await unavailable();
const skip = probe.reason ?? false;
if (skip) process.stderr.write(`\n  lifecycle: skipping -- ${skip}\n\n`);
const { F, d: D } = probe;

describe('windowed lifecycle on the devnet', { skip }, () => {
  let W;
  let gateProbe;
  let classifyRevert;
  let sched;
  let snap;
  const HOUR = 120;
  const SECOND_SENDER = 7; // a hardhat account that is not the cranker

  before(async () => {
    W = await import(new URL('src/windows.mjs', ROOT).href);
    ({ probeChain: gateProbe } = await import(new URL('scripts/gate.mjs', ROOT).href));
    ({ classifyRevert } = await import(new URL('src/errors.mjs', ROOT).href));
    sched = W.buildScheduleFile({
      network: 'devnet',
      geometry: { activationEpoch: D.activationEpoch, epochsPerQuarter: D.epochsPerQuarter, postPeriod: D.postPeriod, verificationWindow: D.verificationWindow },
      genesisUnix: null, epochSeconds: 30, addresses: { sra: D.sra, swa: D.swa }, headEpoch: 0, generatedAt: 'test', sources: {},
    });
    snap = await F.snapshot();
  });
  after(async () => {
    if (snap) await F.revertTo(snap);
  });

  const binding = (q) => F.bindingEpochOf(q, D);
  const opens = (q) => binding(q) - HOUR;
  const chainNow = () => gateProbe(F.RPC_URL, D.sra, D.swa);

  /** One trigger: gate first, crank only if the gate says go. */
  async function tick(epoch) {
    const now = await F.currentEpoch();
    if (epoch > now) await F.mineTo(epoch);
    const at = await F.currentEpoch();
    const decision = W.decideCrank({ sched, epoch: at, chain: await chainNow() });
    if (!decision.go) return { decision, ran: false };
    const run = await F.runCranker();
    assert.equal(run.spawnError, null, run.stderr);
    const record = JSON.parse(run.stdout);
    return { decision, ran: true, record, exitCode: run.exitCode, stderr: run.stderr };
  }

  const sent = (r, call) => (r.record?.actions ?? []).filter((a) => a.call === call && a.decision === 'sent');

  let Q;

  it('settles whatever is already due, then starts at the next quarter whose window has not opened', async () => {
    for (let i = 0; i < 30; i++) {
      const run = await F.runCranker();
      const rec = JSON.parse(run.stdout);
      if (!rec.actions.some((a) => a.decision === 'sent')) break;
    }
    const now = await F.currentEpoch();
    Q = W.crankWindowAt(sched, now)?.quarter ?? 0;
    Q += 1;
    while (opens(Q) <= now) Q += 1;
    assert.ok(Q >= 1);
  });

  it('Q: closed before the window, open exactly one hour before binding', async () => {
    const pre = await tick(opens(Q) - 1);
    assert.equal(pre.ran, false, pre.decision.reason);
    const open = await tick(opens(Q));
    assert.equal(open.ran, true, open.decision.reason);
    assert.equal(open.exitCode, 0, open.stderr);
    assert.equal(sent(open, 'submitShares').length, 0, 'nothing is callable before binding');
  });

  it('Q: a missed run inside the window costs nothing; the next run lands both calls and the window closes', async () => {
    await F.postVolume(Q, '1000', { autoAdvance: false }).catch(() => null); // may be past posting; volumes are optional
    // Runs at binding and binding+10 were dropped (GitHub outage). The next one fires at +30.
    await F.mineTo(binding(Q) + 30);
    const r = await tick(binding(Q) + 30);
    assert.equal(r.ran, true);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(sent(r, 'submitShares')[0]?.quarter, Q);
    const c = await chainNow();
    assert.equal(c.lastSubmittedQuarter, Q);
    assert.ok(c.gateComplete || c.lastCheckedQuarter >= Q, JSON.stringify(c));
    const after = await tick(binding(Q) + 31);
    assert.equal(after.ran, false);
    assert.match(after.decision.reason, /closed on chain/);
  });

  it('Q+1: our crank lands first; a second sender gets AlreadySubmitted, which is benign', async () => {
    const q = Q + 1;
    const r = await tick(binding(q) + 1);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(sent(r, 'submitShares')[0]?.quarter, q);
    const err = await F.sra(SECOND_SENDER).submitShares(q).then(() => null, (e) => e);
    assert.ok(err, 'a duplicate submitShares was accepted');
    const v = classifyRevert(err);
    assert.equal(v.name, 'AlreadySubmitted');
    assert.equal(v.kind, 'benign');
    assert.equal((await tick(binding(q) + 2)).ran, false);
  });

  it('Q+2: a second sender submits first; the window stays open while the gate is pending, and closes when it lands', async () => {
    const q = Q + 2;
    await F.mineTo(binding(q) + 1);
    await (await F.sra(SECOND_SENDER).submitShares(q)).wait();
    const c = await chainNow();
    assert.equal(c.lastSubmittedQuarter, q);

    // The gate for q has not run. Elapsed time must not close the window.
    assert.equal(c.gateComplete, false, 'the devnet gate has spent its steps; redeploy (npm run devnet:deploy)');
    assert.ok(c.lastCheckedQuarter < q, `gate already at ${c.lastCheckedQuarter}`);
    const d = W.decideCrank({ sched, epoch: binding(q) + 50, chain: c });
    assert.equal(d.go, true, 'submit landed but the gate is pending: still open');
    assert.match(d.reason, /gate check pending/);
    const r = await tick(binding(q) + 50);
    assert.equal(r.ran, true);
    assert.equal(r.exitCode, 0, r.stderr);
    const sub = r.record.actions.find((a) => a.call === 'submitShares');
    assert.equal(sub.decision, 'skipped');
    assert.equal(sub.outcome, 'already-done', 'someone else submitting is not a failure');
    assert.ok(sent(r, 'quarterlyGateCheck').length >= 1, 'the late gate check landed');
    assert.equal((await tick(binding(q) + 51)).ran, false, 'closed once both are on chain');
  });

  it('Q+3: nothing ran in its window, but the handover hour before Q+4 binds still rescues it', async () => {
    const q = Q + 3;
    // Inside Q+4's window by the clock, before Q+4 binds: Q+3 is still the latest bound quarter.
    const r = await tick(opens(q + 1) + 10);
    assert.equal(r.ran, true, r.decision.reason);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(sent(r, 'submitShares')[0]?.quarter, q, 'Q+3 rescued');
  });

  it('Q+4 lands normally; Q+5 is lost when nothing runs until Q+6 binds: critical, exit 1', async () => {
    const r4 = await tick(binding(Q + 4) + 1);
    assert.equal(sent(r4, 'submitShares')[0]?.quarter, Q + 4);

    const lost = Q + 5;
    const r = await tick(binding(lost + 1) + 1);
    assert.equal(r.ran, true);
    assert.equal(r.exitCode, 1, 'a lost quarter is exit 1');
    assert.deepEqual(r.record.schedule.missedQuarters, [lost]);
    assert.equal(sent(r, 'submitShares')[0]?.quarter, lost + 1, 'the next quarter still lands');
    assert.match(r.stderr, new RegExp(`quarter ${lost} never submitted|quarters whose submit window closed`));
  });

  describe('Claim, 24 hours after submitShares lands', () => {
    let lotus;
    let server;
    const KEY = '0x' + '44'.repeat(32); // a byte pattern, valueless, local only

    before(async () => {
      const { createFakeLotus, serveFakeLotus } = await import(new URL('devnet/fake-lotus.mjs', ROOT).href);
      const { addressOfKey, parsePrivateKey } = await import(new URL('src/filecoin/message.mjs', ROOT).href);
      lotus = createFakeLotus({ networkName: 'devnet', prefix: 't' });
      lotus.from = addressOfKey(parsePrivateKey(KEY), 't');
      lotus.fake.fund(lotus.from, 10n ** 19n);
      lotus.fake.setShares([['t01001', 5n * 10n ** 17n], ['t01002', 5n * 10n ** 17n]]);
      server = await serveFakeLotus(lotus, { upstream: F.RPC_URL });
    });
    after(async () => server?.close());

    /** scripts/claim.mjs as a child. Async: the fake node answers from this same process. */
    function claim(extra = {}) {
      return new Promise((resolve) => {
        const child = spawn(process.execPath, ['scripts/claim.mjs'], {
          cwd: fileURLToPath(ROOT),
          env: {
            PATH: process.env.PATH, NETWORK: 'devnet', RPC_URL: server.url, CLAIM_PRIVATE_KEY: KEY,
            SRA_ADDRESS: D.sra, SWA_ADDRESS: D.swa, CLAIM_POLL_MS: '10', ...extra,
          },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => (stdout += c));
        child.stderr.on('data', (c) => (stderr += c));
        child.on('close', (code) => resolve({ exitCode: code, record: stdout ? JSON.parse(stdout) : null, stderr }));
      });
    }

    it('waits for the day, then sends one signed Claim that pays the share map; a re-run sends nothing', async () => {
      const q = Q + 7;
      await F.postVolume(q, '2500');
      const r = await tick(binding(q) + 1);
      assert.equal(sent(r, 'submitShares')[0]?.quarter, q);
      const landedAt = await F.currentEpoch();
      lotus.fake.fold(); // what the SRA's SetShares does to f02
      lotus.fake.accrue(3n * 10n ** 18n);

      const gateD = W.decideClaim({ sched, epoch: binding(q) + 24 * HOUR, trigger: 'hourly' });
      assert.deepEqual([gateD.go, gateD.mode, gateD.quarter], [true, 'post-submit', q]);

      const early = await claim({ CLAIM_MODE: 'post-submit', CLAIM_QUARTER: String(q) });
      assert.equal(early.exitCode, 0, early.stderr);
      assert.match(early.record.actions[0].message, /due at/);
      assert.equal(lotus.fake.log.pushed.length, 0);

      await F.mineTo(landedAt + 2880);
      const due = await claim({ CLAIM_MODE: 'post-submit', CLAIM_QUARTER: String(q) });
      assert.equal(due.exitCode, 0, due.stderr);
      assert.equal(lotus.fake.log.pushed.length, 1, due.stderr);
      const landed = due.record.actions.find((a) => a.outcome === 'landed');
      assert.equal(landed.payoutFil, '6');
      assert.equal(lotus.fake.owed('t01001'), 0n);

      lotus.fake.accrue(10n ** 18n);
      const again = await claim({ CLAIM_MODE: 'post-submit', CLAIM_QUARTER: String(q) });
      assert.equal(again.record.actions[0].outcome, 'already-done');
      assert.equal(lotus.fake.log.pushed.length, 1);
    });
  });
});
