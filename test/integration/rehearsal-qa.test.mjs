/**
 * QA: rehearsal mode end to end against a throwaway local Hardhat node on 127.0.0.1:8560 that reports
 * calibnet's chain id. The real entrypoint (scripts/crank.mjs, CRANK_MODE=rehearsal) runs as a child.
 *
 * The cranker key is account 2 of the PUBLIC Hardhat test mnemonic, derived here and handed to the
 * child in its environment. It is never printed and holds nothing anywhere real.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContractFactory, HDNodeWallet, Interface, JsonRpcProvider, Mnemonic } from 'ethers';

import { tagGasLimit } from '../../src/rehearsal/engine.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CHAIN_DIR = join(ROOT, 'test', 'rehearsal-chain');
const CONFIG = join(CHAIN_DIR, 'hardhat.config.cjs');
const MNEMONIC = 'test test test test test test test test test test test junk';
const HARDHAT = join(ROOT, 'node_modules', '.bin', 'hardhat');
const PORT = 8560; // QA only: never 8545/8547/8548
const RPC = `http://127.0.0.1:${PORT}`;

async function waitFor(url, ms = 30_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
      const j = await res.json();
      if (j.result) return Number(j.result);
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no node at ${url}`);
}

const wallet = (i, provider) => HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(MNEMONIC), `m/44'/60'/0'/0/${i}`).connect(provider);

describe('QA: rehearsal mode on a local calibnet-id chain', { skip: !spawnSync(HARDHAT, ['--version'], { cwd: ROOT }).stdout?.length && 'hardhat not installed' }, () => {
  let node;
  let provider;
  let swa;
  let sra;
  let cranker;
  let crankerKey;
  let tmp;
  let deploymentsFile;

  before(async () => {
    const compiled = spawnSync(HARDHAT, ['compile', '--quiet', '--config', CONFIG], { cwd: CHAIN_DIR, encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.stderr);
    node = spawn(HARDHAT, ['node', '--config', CONFIG, '--hostname', '127.0.0.1', '--port', String(PORT)], {
      cwd: CHAIN_DIR, env: { ...process.env, REHEARSAL_TEST_CHAIN_ID: '314159' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    node.stdout.on('data', () => {});
    node.stderr.on('data', () => {});
    assert.equal(await waitFor(RPC), 314159);
    provider = new JsonRpcProvider(RPC, 314159, { staticNetwork: true, cacheTimeout: -1 });
    const deployer = wallet(0, provider);
    const art = (name) => JSON.parse(readFileSync(join(CHAIN_DIR, 'artifacts', 'contracts', 'RehearsalMocks.sol', `${name}.json`), 'utf8'));
    swa = await (await new ContractFactory(art('MockSWA').abi, art('MockSWA').bytecode, deployer).deploy()).waitForDeployment();
    sra = await (await new ContractFactory(art('MockSRA').abi, art('MockSRA').bytecode, deployer).deploy()).waitForDeployment();
    cranker = wallet(2, provider);
    crankerKey = cranker.privateKey;
    tmp = mkdtempSync(join(tmpdir(), 'qa-rehearsal-it-'));
    deploymentsFile = join(tmp, 'deployments.json');
    writeFileSync(deploymentsFile, JSON.stringify({ 314159: { sra: await sra.getAddress(), swa: await swa.getAddress() } }));
  });

  after(() => {
    if (node) node.kill('SIGTERM');
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  const iso = (s) => new Date(s * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  const nonce = () => provider.getTransactionCount(cranker.address, 'latest');

  /** A second that is after both the wall clock and the head, reached on both; returns it. */
  async function freshSecond() {
    const head = await provider.getBlock('latest');
    const t = Math.max(Math.floor(Date.now() / 1000), head.timestamp) + 1;
    while (Date.now() < t * 1000 + 50) await new Promise((r) => setTimeout(r, 50));
    await provider.send('evm_mine', []);
    return t;
  }

  let n = 0;
  function writeSchedule(entries) {
    const f = join(tmp, `schedule-${++n}.json`);
    writeFileSync(f, JSON.stringify({ network: 'calibnet', chainId: 314159, entries }));
    return f;
  }
  const gate = (id, q, opens, over = {}) => ({
    id, step: Number(id), function: 'quarterlyGateCheck', args: [], gateQuarter: q,
    notBefore: iso(opens), notAfter: iso(opens + 3600), expect: 'pass', status: 'Pending', ...over,
  });

  function crank(scheduleFile, extraEnv = {}) {
    const env = {
      PATH: process.env.PATH, HOME: process.env.HOME,
      NETWORK: 'calibnet', RPC_URL: RPC, CRANKER_PRIVATE_KEY: crankerKey, CRANK_MODE: 'rehearsal',
      CRANK_ALERT_LEDGER: join(tmpdir(), `crank-alert-ledger-${process.pid}.json`), // never the working tree's
      CRANK_SCHEDULE_FILE: scheduleFile, SOLSTICE_DEPLOYMENTS: deploymentsFile, CRANK_REHEARSAL_GAS_LIMIT: '5000000',
      CRANK_PAUSE_FILE: join(tmp, 'PAUSED'), CRANK_CONFIRMATIONS: '1', ALERT_TRANSPORT: 'console', ...extraEnv,
    };
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'crank.mjs')], { cwd: ROOT, env, encoding: 'utf8', timeout: 120_000 });
    assert.ok(!r.stderr.includes(crankerKey.slice(2)) && !r.stdout.includes(crankerKey.slice(2)), 'the signing key reached the output');
    let record = null;
    try {
      record = JSON.parse(r.stdout);
    } catch {
      // aborted
    }
    return { code: r.status, record, stderr: r.stderr };
  }
  const decisions = (r) => r.record.actions.map((a) => [a.id, a.decision]);

  it('three byte-identical gate checks, one run: three sends in order (Q5, Q6, Q7); next run: all already-sent, nothing resent', async () => {
    await (await swa.setMode(0)).wait();
    await (await swa.setLastChecked(4)).wait();
    const t = await freshSecond();
    const file = writeSchedule([gate('78', 5, t), gate('79', 6, t), gate('80', 7, t)]);
    const before = await nonce();
    const r1 = crank(file);
    assert.equal(r1.code, 0, r1.stderr);
    assert.deepEqual(decisions(r1), [['78', 'sent'], ['79', 'sent'], ['80', 'sent']]);
    assert.deepEqual(r1.record.actions.map((a) => a.result), ['landed, gate passed for Q5 (steps 1)', 'landed, gate passed for Q6 (steps 2)', 'landed, gate passed for Q7 (steps 3)']);
    assert.equal(await nonce(), before + 3);
    await provider.send('evm_mine', []);
    const r2 = crank(file);
    assert.equal(r2.code, 0, r2.stderr);
    assert.deepEqual(decisions(r2), [['78', 'already-sent'], ['79', 'already-sent'], ['80', 'already-sent']]);
    assert.deepEqual(r2.record.actions.map((a) => a.txHash), r1.record.actions.map((a) => a.txHash));
    assert.equal(await nonce(), before + 3);
  });

  it('crash after broadcast: tx in the mpool -> held; mined -> already-sent; never resent', async () => {
    await (await swa.setLastChecked(4)).wait();
    const t = await freshSecond();
    const file = writeSchedule([gate('80', 5, t)]);
    const swaIface = new Interface(['function quarterlyGateCheck()']);
    await provider.send('evm_setAutomine', [false]);
    let hash;
    try {
      // What the crashed run broadcast before dying.
      // What the crashed rehearsal run broadcast before dying: its gas limit carries step 80's tag.
      const tx = await cranker.sendTransaction({ to: await swa.getAddress(), data: swaIface.encodeFunctionData('quarterlyGateCheck', []), gasLimit: tagGasLimit(5_000_000n, '80') });
      hash = tx.hash;
      const before = await nonce();
      const r1 = crank(file);
      assert.equal(r1.code, 0, r1.stderr);
      assert.deepEqual(decisions(r1), [['80', 'held']]);
      assert.equal(await provider.getTransactionCount(cranker.address, 'pending'), before + 1, 'a second message was queued');
      await provider.send('evm_mine', []);
    } finally {
      await provider.send('evm_setAutomine', [true]);
    }
    const before2 = await nonce();
    const r2 = crank(file);
    assert.equal(r2.code, 0, r2.stderr);
    assert.deepEqual(decisions(r2), [['80', 'already-sent']]);
    assert.equal(r2.record.actions[0].txHash, hash);
    assert.equal(await nonce(), before2);
  });

  it('78 held (gate already at Q6): 79 and 80 sent; the next run credits each step with its own tx', async () => {
    await (await swa.setLastChecked(5)).wait(); // someone already checked Q5
    const t = await freshSecond();
    const file = writeSchedule([gate('78', 5, t), gate('79', 6, t), gate('80', 7, t)]);
    const r1 = crank(file);
    assert.deepEqual(decisions(r1), [['78', 'blocked'], ['79', 'sent'], ['80', 'sent']]);
    await provider.send('evm_mine', []);
    const r2 = crank(file);
    const by = Object.fromEntries(r2.record.actions.map((a) => [a.id, a]));
    assert.deepEqual(decisions(r2), [['78', 'blocked'], ['79', 'already-sent'], ['80', 'already-sent']],
      `run 2: ${JSON.stringify(decisions(r2))}; 78 credited with ${by['78'].txHash}, 79 with ${by['79'].txHash} (79 actually sent ${r1.record.actions[1].txHash}); exit ${r2.code}`);
  });
});
