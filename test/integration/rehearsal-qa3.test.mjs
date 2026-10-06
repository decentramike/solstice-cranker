/**
 * QA round 3: the real entrypoint (scripts/crank.mjs, CRANK_MODE=rehearsal) against a throwaway
 * Hardhat node on 127.0.0.1:8580 that reports calibnet's chain id, with the mock SRA/SWA from
 * test/rehearsal-chain/. The runner is killed with SIGKILL right after it logs its broadcast.
 *
 * The cranker key is account 3 of the PUBLIC Hardhat test mnemonic, handed to the child in its
 * environment. It is never printed and holds nothing anywhere real. The node is killed afterwards.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ContractFactory, HDNodeWallet, JsonRpcProvider, Mnemonic, parseUnits } from 'ethers';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CHAIN_DIR = join(ROOT, 'test', 'rehearsal-chain');
const CONFIG = join(CHAIN_DIR, 'hardhat.config.cjs');
const MNEMONIC = 'test test test test test test test test test test test junk';
const HARDHAT = join(ROOT, 'node_modules', '.bin', 'hardhat');
const PORT = 8580; // QA3 only
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
const hasHardhat = spawnSync(HARDHAT, ['--version'], { cwd: ROOT }).stdout?.length;

describe('QA3: a runner killed between broadcast and receipt, on a local calibnet-id chain (port 8580)', { skip: !hasHardhat && 'hardhat not installed' }, () => {
  let node;
  let provider;
  let deployer;
  let cranker;
  let crankerKey;
  let tmp;
  let art;

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
    deployer = wallet(0, provider);
    cranker = wallet(3, provider);
    crankerKey = cranker.privateKey;
    tmp = mkdtempSync(join(tmpdir(), 'qa3-rehearsal-it-'));
    writeFileSync(join(tmp, 'clock.mjs'), 'const o = Number(process.env.QA3_NOW_OFFSET_MS || 0); if (o) { const real = Date.now; Date.now = () => real() + o; }\n');
    art = (name) => JSON.parse(readFileSync(join(CHAIN_DIR, 'artifacts', 'contracts', 'RehearsalMocks.sol', `${name}.json`), 'utf8'));
  });

  after(() => {
    if (node) node.kill('SIGKILL');
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  async function deployMocks() {
    const swa = await (await new ContractFactory(art('MockSWA').abi, art('MockSWA').bytecode, deployer).deploy()).waitForDeployment();
    const sra = await (await new ContractFactory(art('MockSRA').abi, art('MockSRA').bytecode, deployer).deploy()).waitForDeployment();
    const file = join(tmp, `deployments-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify({ 314159: { sra: await sra.getAddress(), swa: await swa.getAddress() } }));
    return { swa, sra, file };
  }

  let offsetMs = 0;
  const runnerNowSec = () => Math.floor((Date.now() + offsetMs) / 1000);
  async function setTime(tSec, { baseFeeGwei = null } = {}) {
    await provider.send('evm_setNextBlockTimestamp', [tSec]);
    if (baseFeeGwei !== null) await provider.send('hardhat_setNextBlockBaseFeePerGas', ['0x' + parseUnits(String(baseFeeGwei), 'gwei').toString(16)]);
    await provider.send('evm_mine', []);
    offsetMs = tSec * 1000 - Date.now();
  }
  async function fresh() {
    const head = await provider.getBlock('latest');
    const t = Math.max(runnerNowSec(), head.timestamp) + 2;
    await setTime(t);
    return t;
  }
  const iso = (s) => new Date(s * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  let n = 0;
  function writeSchedule(entries) {
    const f = join(tmp, `schedule-${++n}.json`);
    writeFileSync(f, JSON.stringify({ network: 'calibnet', chainId: 314159, entries }));
    return f;
  }
  function env(scheduleFile, deployments) {
    return {
      PATH: process.env.PATH, HOME: process.env.HOME,
      NETWORK: 'calibnet', RPC_URL: RPC, CRANKER_PRIVATE_KEY: crankerKey, CRANK_MODE: 'rehearsal',
      CRANK_SCHEDULE_FILE: scheduleFile, SOLSTICE_DEPLOYMENTS: deployments, CRANK_REHEARSAL_GAS_LIMIT: '5000000',
      CRANK_PAUSE_FILE: join(tmp, 'PAUSED'), CRANK_CONFIRMATIONS: '1', ALERT_TRANSPORT: 'console',
      QA3_NOW_OFFSET_MS: String(offsetMs),
    };
  }
  const args = () => ['--import', pathToFileURL(join(tmp, 'clock.mjs')).href, join(ROOT, 'scripts', 'crank.mjs')];
  function crank(scheduleFile, deployments) {
    const r = spawnSync(process.execPath, args(), { cwd: ROOT, env: env(scheduleFile, deployments), encoding: 'utf8', timeout: 120_000 });
    assert.ok(!r.stderr.includes(crankerKey.slice(2)) && !r.stdout.includes(crankerKey.slice(2)), 'the signing key reached the output');
    let record = null;
    try {
      record = JSON.parse(r.stdout);
    } catch {
      // aborted
    }
    const alerts = [...r.stderr.matchAll(/\[ALERT (\w+)\] ([^\n]*)/g)].map((m) => `${m[1]}: ${m[2].trim()}`);
    return { code: r.status, record, stderr: r.stderr, alerts };
  }
  /** Starts a run with automine off and SIGKILLs it as soon as it logs the broadcast. */
  async function crankKilledAfterBroadcast(scheduleFile, deployments) {
    await provider.send('evm_setAutomine', [false]);
    const child = spawn(process.execPath, args(), { cwd: ROOT, env: env(scheduleFile, deployments), stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    const killed = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(false);
      }, 60_000);
      child.stderr.on('data', (d) => {
        err += d;
        if (/rehearsal step=\S+ broadcast 0x[0-9a-f]{64}/.test(err)) {
          child.kill('SIGKILL');
          clearTimeout(timer);
          resolve(true);
        }
      });
      child.on('exit', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    assert.ok(!err.includes(crankerKey.slice(2)), 'the signing key reached the output');
    assert.ok(killed, `the run never broadcast: ${err.split('\n').slice(-5).join(' / ')}`);
    return err.match(/broadcast (0x[0-9a-f]{64})/)[1];
  }

  it('killed after broadcasting step 80 (expects StepWeightRecordsFailed); the message lands and PASSES instead: a later run must alert', async () => {
    const { swa, file } = await deployMocks();
    await (await swa.setLastChecked(6)).wait(); // next quarter 7; mode 0 = the check passes
    const t = await fresh();
    const sched = writeSchedule([{ id: '80', step: 80, function: 'quarterlyGateCheck', args: [], gateQuarter: 7, notBefore: iso(t), notAfter: iso(t + 45 * 60), expect: 'revert:StepWeightRecordsFailed', status: 'Pending' }]);
    const hash = await crankKilledAfterBroadcast(sched, file);
    await provider.send('evm_setAutomine', [true]);
    await setTime(t + 60);
    const rc = await provider.getTransactionReceipt(hash);
    assert.equal(rc.status, 1, 'harness: the killed run\'s message should have landed');
    assert.equal((await provider.getTransaction(hash)).gasLimit % 100_000n, 800n, 'tagged with step 80');
    await setTime(t + 10 * 60);
    const r = crank(sched, file);
    assert.deepEqual(r.record.actions.map((a) => [a.id, a.decision, a.txHash, a.match]), [['80', 'already-sent', hash, false]]);
    assert.ok(r.code === 1 && r.alerts.length > 0,
      `step 80 landed "${r.record.actions[0].result}" against expect revert:StepWeightRecordsFailed, and the run exited ${r.code} with alerts ${JSON.stringify(r.alerts)}`);
  });

  it('killed after broadcasting; the message is stuck in the mpool when the window closes: the run must not say "nothing sent, send it by hand"', async () => {
    const { swa, file } = await deployMocks();
    await (await swa.setLastChecked(6)).wait();
    const t = await fresh();
    const sched = writeSchedule([{ id: '78', step: 78, function: 'quarterlyGateCheck', args: [], gateQuarter: 7, notBefore: iso(t), notAfter: iso(t + 20 * 60), expect: 'pass', status: 'Pending' }]);
    const hash = await crankKilledAfterBroadcast(sched, file);
    // Keep it underpriced: the block at the window's close is mined with a base fee it cannot pay.
    await setTime(t + 20 * 60 + 30, { baseFeeGwei: 100_000 });
    assert.equal(await provider.getTransactionReceipt(hash), null, 'harness: the message should still be pending');
    // Revised after QA round 3: Hardhat's 'pending' nonce leaves out a message the next block's base
    // fee would exclude; Lotus's (MpoolGetNonce) counts every message in its mpool. Put the next base
    // fee back down -- without mining -- so this node reports the stuck message the way Lotus would.
    await provider.send('hardhat_setNextBlockBaseFeePerGas', ['0x1']);
    assert.ok((await provider.getTransactionCount(cranker.address, 'pending')) > (await provider.getTransactionCount(cranker.address, 'latest')),
      'harness: the pending nonce should include the stuck message, as Lotus does');
    const r = crank(sched, file);
    const a = r.record.actions.find((x) => x.id === '78');
    const advice = r.stderr.includes('send it by hand');
    try {
      assert.ok(!(a?.result === 'never sent' && advice),
        `cranker message ${hash.slice(0, 10)} is in the mpool, and the run said: ${a?.decision} / ${a?.result}; alerts ${JSON.stringify(r.alerts)}`);
    } finally {
      await provider.send('hardhat_dropTransaction', [hash]);
      await provider.send('evm_setAutomine', [true]);
      await provider.send('evm_mine', []);
    }
  });
});
