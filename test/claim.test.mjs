/**
 * src/claim.mjs against the fake Lotus in devnet/fake-lotus.mjs.
 *
 * The fake verifies every signature against From and every nonce, so a message this code
 * builds wrongly is rejected here the way a real node would reject it. The key is a fixed byte
 * pattern that holds nothing anywhere.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Interface } from 'ethers';

import sraAbi from '../abi/ServiceRewardsActor.json' with { type: 'json' };
import { createFakeLotus } from '../devnet/fake-lotus.mjs';
import { POST_SUBMIT_DELAY_EPOCHS, runClaim } from '../src/claim.mjs';
import { loadClaimConfig } from '../src/config.mjs';
import { addressOfKey, parsePrivateKey } from '../src/filecoin/message.mjs';
import { decode, fromBase64 } from '../src/filecoin/cbor.mjs';
import { addressToString } from '../src/filecoin/address.mjs';

const KEY = '0x' + '22'.repeat(32);
const OTHER_KEY = '0x' + '33'.repeat(32);
const FIL = 10n ** 18n;
const FROM_T = addressOfKey(parsePrivateKey(KEY), 't');

function setup({ wallets = ['t0163912', 't090'], accrue = 1n * FIL, env = {}, fakeOpts = {} } = {}) {
  const bundle = createFakeLotus(fakeOpts);
  bundle.fake.fund(FROM_T, 10n * FIL);
  bundle.fake.setShares(wallets.map((w) => [w, 10n ** 18n / BigInt(wallets.length)]));
  bundle.fake.accrue(accrue);
  const config = loadClaimConfig({ NETWORK: 'calibnet', CLAIM_PRIVATE_KEY: KEY, CLAIM_POLL_MS: '10', ALERT_TRANSPORT: 'console', ...env }, { requireKey: false });
  config.alerts.transports = [];
  return { ...bundle, config };
}

const pushedWallets = (fake, i = 0) => decode(fromBase64(fake.log.pushed[i].msg.Params))[1].map((b) => addressToString(b, 't'));

describe('Claim: discovery and send', () => {
  it('finds every owed wallet in stream 2, sends one signed Claim, and pays them', async () => {
    const { fake, client, config } = setup();
    const { record, exitCode } = await runClaim(config, { lotus: client });
    assert.equal(exitCode, 0);
    assert.equal(fake.log.pushed.length, 1);
    assert.deepEqual(pushedWallets(fake).sort(), ['t0163912', 't090']);
    const landed = record.actions.find((a) => a.outcome === 'landed');
    assert.equal(landed.payoutFil, '2');
    assert.equal(fake.owed('t0163912'), 0n);
    assert.equal(fake.log.pushed[0].msg.To, 't02');
    assert.equal(fake.log.pushed[0].msg.Method, 4045527845);
  });

  it('a second run right after sends nothing: nothing is owed', async () => {
    const { fake, client, config } = setup();
    await runClaim(config, { lotus: client });
    const { record } = await runClaim(config, { lotus: client });
    assert.equal(fake.log.pushed.length, 1);
    assert.equal(record.actions.at(-1).outcome, 'not-due');
  });

  it('leaves out wallets owed nothing', async () => {
    const { fake, client, config } = setup({ wallets: ['t0163912', 't090', 't0555'] });
    fake.clear('t090');
    await runClaim(config, { lotus: client });
    assert.deepEqual(pushedWallets(fake).sort(), ['t0163912', 't0555']);
  });

  it('batches more than 64 wallets and stops at CLAIM_MAX_MESSAGES', async () => {
    const wallets = Array.from({ length: 130 }, (_, i) => `t0${10000 + i}`);
    const three = setup({ wallets, accrue: FIL });
    await runClaim(three.config, { lotus: three.client });
    assert.deepEqual(three.fake.log.pushed.map((_, i) => pushedWallets(three.fake, i).length), [64, 64, 2]);

    const two = setup({ wallets, accrue: FIL, env: { CLAIM_MAX_MESSAGES: '2' } });
    const { record } = await runClaim(two.config, { lotus: two.client });
    assert.equal(two.fake.log.pushed.length, 2);
    assert.ok(record.actions.some((a) => a.outcome === 'capped'));
  });

  it('uses consecutive nonces when it sends several messages', async () => {
    const wallets = Array.from({ length: 70 }, (_, i) => `t0${20000 + i}`);
    const { fake, client, config } = setup({ wallets });
    await runClaim(config, { lotus: client });
    assert.deepEqual(fake.log.pushed.map((p) => p.msg.Nonce), [0, 1]);
  });
});

describe('Claim: guards', () => {
  it('fee cap: a node that ignores MaxFee cannot push the fee past CLAIM_MAX_FEE_FIL', async () => {
    const { fake, client, config } = setup({ accrue: 1000n * FIL });
    fake.knobs.ignoreMaxFee = true;
    fake.knobs.baseFeeCap = 10n ** 13n; // 6e6 gas * 1e13 = 0.06 FIL > 0.05
    const { record } = await runClaim(config, { lotus: client });
    assert.equal(fake.log.pushed.length, 0);
    assert.match(record.actions.at(-1).message, /above the 0\.05 FIL cap/);
  });

  it('the fee cap is passed to the node as MaxFee, so an honest node prices under it', async () => {
    const { fake, client, config } = setup({ accrue: 1000n * FIL });
    fake.knobs.baseFeeCap = 10n ** 13n;
    await runClaim(config, { lotus: client });
    const m = fake.log.pushed[0].msg;
    assert.ok(BigInt(m.GasLimit) * BigInt(m.GasFeeCap) <= 5n * 10n ** 16n);
  });

  it('skips a Claim whose fee is more than 10% of what it pays', async () => {
    const { fake, client, config } = setup({ accrue: 1_000_000_000n }); // 2e9 atto paid vs 6e11 max fee
    const { record } = await runClaim(config, { lotus: client });
    assert.equal(fake.log.pushed.length, 0);
    assert.match(record.actions.at(-1).message, /more than 10%/);
  });

  it('refuses to send on top of a message already pending from the same key', async () => {
    const { fake, client, config } = setup();
    fake.phantomPending(FROM_T);
    const { record, alerts } = await runClaim(config, { lotus: client });
    assert.equal(fake.log.pushed.length, 0);
    assert.equal(record.actions.at(-1).outcome, 'pending-nonce');
    assert.equal(alerts.worst, 'warn');
  });

  it('a simulation that fails sends nothing', async () => {
    const { fake, client, config } = setup();
    fake.knobs.failStateCall = 16;
    const { record, exitCode } = await runClaim(config, { lotus: client });
    assert.equal(exitCode, 0);
    assert.equal(fake.log.pushed.length, 0);
    assert.match(record.actions[0].message, /simulation exit code 16/);
  });

  it('a Claim that fails on chain is exit 1 and critical', async () => {
    const { fake, client, config } = setup();
    fake.knobs.failOnChain = 33;
    const { exitCode, alerts } = await runClaim(config, { lotus: client });
    assert.equal(exitCode, 1);
    assert.equal(alerts.worst, 'critical');
  });

  it('dry run simulates and sends nothing', async () => {
    const { fake, client, config } = setup({ env: { CLAIM_DRY_RUN: '1' } });
    const { record } = await runClaim(config, { lotus: client });
    assert.equal(fake.log.pushed.length, 0);
    assert.equal(record.actions.at(-1).outcome, 'would-send');
    assert.equal(fake.owed('t090'), FIL);
  });

  it('CRANK_PAUSED stops the Claim too', async () => {
    const { fake, client, config } = setup({ env: { CRANK_PAUSED: '1' } });
    const { record } = await runClaim(config, { lotus: client });
    assert.equal(fake.log.pushed.length, 0);
    assert.equal(record.actions[0].outcome, 'paused');
  });

  it('before activation there is nothing to claim', async () => {
    const { fake, client, config } = setup({ fakeOpts: { activated: false } });
    const { record } = await runClaim(config, { lotus: client });
    assert.equal(fake.log.pushed.length, 0);
    assert.match(record.actions[0].message, /before activation/);
  });

  it('refuses an endpoint on the wrong network', async () => {
    const { client, config } = setup({ fakeOpts: { networkName: 'mainnet' } });
    await assert.rejects(runClaim(config, { lotus: client }), /expects "calibrationnet"/);
  });

  it('refuses an endpoint that exposes wallet methods', async () => {
    const { fake, client, config } = setup();
    fake.knobs.exposeWallet = true;
    await assert.rejects(runClaim(config, { lotus: client }), /wallet methods/);
  });

  it('refuses a key that is not CLAIM_ADDRESS', async () => {
    const { client, config } = setup({ env: { CLAIM_ADDRESS: addressOfKey(parsePrivateKey(OTHER_KEY), 't') } });
    await assert.rejects(runClaim(config, { lotus: client }), /CLAIM_ADDRESS says/);
  });

  it('warns when either gas wallet is low', async () => {
    const { fake, client, config } = setup({ env: { CRANKER_ADDRESS: '0x170356558bd57623d3df9877319014ec9de6e263' } });
    fake.fund(FROM_T, 1n);
    const { alerts } = await runClaim(config, { lotus: client });
    const titles = alerts.alerts?.map((a) => a.title) ?? [];
    assert.ok(titles.some((t) => /Claim wallet is low/.test(t)), titles.join(' | '));
    assert.ok(titles.some((t) => /cranker wallet is low/.test(t)), titles.join(' | '));
  });
});

describe('Claim config', () => {
  it('NETWORK=mainnet is a dry run until MAINNET_SEND_ENABLED is set', () => {
    const blocked = loadClaimConfig({ NETWORK: 'mainnet', CLAIM_PRIVATE_KEY: KEY });
    assert.equal(blocked.dryRun, true);
    assert.match(blocked.dryRunReason, /MAINNET_SEND_ENABLED/);
    const on = loadClaimConfig({ NETWORK: 'mainnet', CLAIM_PRIVATE_KEY: KEY, MAINNET_SEND_ENABLED: 'true' });
    assert.equal(on.dryRun, false);
    assert.equal(on.prefix, 'f');
  });

  it('never one key for both jobs', () => {
    assert.throws(() => loadClaimConfig({ NETWORK: 'calibnet', CLAIM_PRIVATE_KEY: KEY, CRANKER_PRIVATE_KEY: KEY }), /same key/);
  });

  it('defaults: 0.05 FIL fee cap, 3 messages, batches of 64', () => {
    const c = loadClaimConfig({ NETWORK: 'calibnet', CLAIM_PRIVATE_KEY: KEY });
    assert.equal(c.maxFeeAtto, 5n * 10n ** 16n);
    assert.equal(c.maxMessages, 3);
    assert.equal(c.batchSize, 64);
    assert.equal(c.maxFeeRatioPercent, 10);
  });

  it('uses the f prefix on Mainnet and t on calibnet and the devnet', () => {
    assert.equal(loadClaimConfig({ NETWORK: 'mainnet', CLAIM_PRIVATE_KEY: KEY }).prefix, 'f');
    assert.equal(loadClaimConfig({ NETWORK: 'calibnet', CLAIM_PRIVATE_KEY: KEY }).prefix, 't');
    assert.equal(loadClaimConfig({ NETWORK: 'devnet', CLAIM_PRIVATE_KEY: KEY }).prefix, 't');
  });

  it('error messages never contain the key', () => {
    try {
      loadClaimConfig({ NETWORK: 'calibnet', CLAIM_PRIVATE_KEY: KEY, CRANKER_PRIVATE_KEY: KEY });
    } catch (err) {
      assert.ok(!err.message.includes('22'.repeat(32)));
    }
  });
});

describe('Claim: post-submit, 24 hours after submitShares lands', () => {
  const iface = new Interface(sraAbi);
  const SRA = '0x0339f205314C8210AF7Cb075d1A96D012e7896a9';
  function chainAt({ head, lastSubmitted, landedAt }) {
    const word = '0x' + BigInt(lastSubmitted).toString(16).padStart(64, '0');
    return {
      sraAddress: SRA,
      sra: { interface: iface },
      provider: {
        getBlockNumber: async () => Number(head),
        getStorage: async () => word,
        getLogs: async ({ fromBlock, toBlock }) =>
          landedAt !== null && landedAt >= fromBlock && landedAt <= toBlock ? [{ blockNumber: landedAt }] : [],
      },
    };
  }
  const env = { CLAIM_MODE: 'post-submit', CLAIM_QUARTER: '20' };
  // calibnet: binding(20) = 4109134 + 20*2880 + 720
  const B20 = 4109134 + 20 * 2880 + 720;

  it('waits while submitShares(Q) has not landed', async () => {
    const { fake, client, config } = setup({ env });
    const { record } = await runClaim(config, { lotus: client, chain: chainAt({ head: B20 + 3000, lastSubmitted: 19, landedAt: null }) });
    assert.equal(fake.log.pushed.length, 0);
    assert.match(record.actions[0].message, /has not landed yet/);
  });

  it('waits until 24 hours after the landing, measured from the event, not from binding', async () => {
    const landed = B20 + 500;
    const { fake, client, config } = setup({ env });
    fake.fold();
    const early = await runClaim(config, { lotus: client, chain: chainAt({ head: landed + Number(POST_SUBMIT_DELAY_EPOCHS) - 1, lastSubmitted: 20, landedAt: landed }) });
    assert.equal(fake.log.pushed.length, 0);
    assert.match(early.record.actions[0].message, /due at/);
    await runClaim(config, { lotus: client, chain: chainAt({ head: landed + Number(POST_SUBMIT_DELAY_EPOCHS), lastSubmitted: 20, landedAt: landed }) });
    assert.equal(fake.log.pushed.length, 1);
  });

  it('sends once: after a Claim since the fold, later runs in the window do nothing', async () => {
    const landed = B20 + 10;
    const { fake, client, config } = setup({ env });
    fake.fold();
    fake.accrue(FIL); // f02 accrues every block, so a day after the fold the live portion is > 0
    const chain = chainAt({ head: landed + 3000, lastSubmitted: 20, landedAt: landed });
    await runClaim(config, { lotus: client, chain });
    fake.accrue(FIL); // more accrues during the hour
    const { record } = await runClaim(config, { lotus: client, chain });
    assert.equal(fake.log.pushed.length, 1);
    assert.equal(record.actions[0].outcome, 'already-done');
  });

  it('a quarter with no SharesSubmitted event is left to the weekly Claim', async () => {
    const { fake, client, config } = setup({ env });
    const { record } = await runClaim(config, { lotus: client, chain: chainAt({ head: B20 + 5000, lastSubmitted: 20, landedAt: null }) });
    assert.equal(fake.log.pushed.length, 0);
    assert.match(record.actions[0].message, /weekly Claim covers/);
  });
});
