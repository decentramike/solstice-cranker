/**
 * QA round 2: rehearsal mode end to end, against a throwaway Hardhat node on 127.0.0.1:8570 that
 * reports calibnet's chain id, with the mock SRA/SWA from test/rehearsal-chain/. The real
 * entrypoint (scripts/crank.mjs, CRANK_MODE=rehearsal) runs as a child process.
 *
 * Both clocks are moved together: the chain with evm_setNextBlockTimestamp, the child's Date.now()
 * with a preload module that adds the same offset. That lets a test walk through a 45-minute
 * runbook window in seconds.
 *
 * The cranker key is account 3 of the PUBLIC Hardhat test mnemonic, derived here and handed to the
 * child in its environment. It is never printed and holds nothing anywhere real.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ContractFactory, getAddress, HDNodeWallet, Interface, JsonRpcProvider, Mnemonic, parseUnits } from 'ethers';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CHAIN_DIR = join(ROOT, 'test', 'rehearsal-chain');
const CONFIG = join(CHAIN_DIR, 'hardhat.config.cjs');
const MNEMONIC = 'test test test test test test test test test test test junk';
const HARDHAT = join(ROOT, 'node_modules', '.bin', 'hardhat');
const PORT = 8570; // QA2 only
const RPC = `http://127.0.0.1:${PORT}`;
const GATE = new Interface(['function quarterlyGateCheck()']);

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

describe('QA2: rehearsal mode on a local calibnet-id chain (port 8570)', { skip: !hasHardhat && 'hardhat not installed' }, () => {
  let node;
  let provider;
  let deployer;
  let cranker;
  let crankerKey;
  let tmp;
  let art;
  const RUNS = []; // every child run: {label, code, alerts}

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
    tmp = mkdtempSync(join(tmpdir(), 'qa2-rehearsal-it-'));
    writeFileSync(join(tmp, 'clock.mjs'), 'const o = Number(process.env.QA2_NOW_OFFSET_MS || 0); if (o) { const real = Date.now; Date.now = () => real() + o; }\n');
    art = (name) => JSON.parse(readFileSync(join(CHAIN_DIR, 'artifacts', 'contracts', 'RehearsalMocks.sol', `${name}.json`), 'utf8'));
  });

  after(() => {
    if (node) node.kill('SIGTERM');
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  async function deployMocks() {
    const swa = await (await new ContractFactory(art('MockSWA').abi, art('MockSWA').bytecode, deployer).deploy()).waitForDeployment();
    const sra = await (await new ContractFactory(art('MockSRA').abi, art('MockSRA').bytecode, deployer).deploy()).waitForDeployment();
    const file = join(tmp, `deployments-${Date.now()}-${Math.random().toString(16).slice(2, 6)}.json`);
    writeFileSync(file, JSON.stringify({ 314159: { sra: await sra.getAddress(), swa: await swa.getAddress() } }));
    return { swa, sra, file };
  }

  // The runner's clock = wall clock + offsetMs, kept equal to the chain's clock.
  let offsetMs = 0;
  const runnerNowSec = () => Math.floor((Date.now() + offsetMs) / 1000);
  async function setTime(tSec) {
    await provider.send('evm_setNextBlockTimestamp', [tSec]);
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
  const nonce = () => provider.getTransactionCount(cranker.address, 'latest');

  let n = 0;
  function writeSchedule(entries) {
    const f = join(tmp, `schedule-${++n}.json`);
    writeFileSync(f, JSON.stringify({ network: 'calibnet', chainId: 314159, entries }));
    return f;
  }

  function crank(label, scheduleFile, deployments, extraEnv = {}) {
    const env = {
      PATH: process.env.PATH, HOME: process.env.HOME,
      NETWORK: 'calibnet', RPC_URL: RPC, CRANKER_PRIVATE_KEY: crankerKey, CRANK_MODE: 'rehearsal',
      CRANK_SCHEDULE_FILE: scheduleFile, SOLSTICE_DEPLOYMENTS: deployments, CRANK_REHEARSAL_GAS_LIMIT: '5000000',
      CRANK_PAUSE_FILE: join(tmp, 'PAUSED'), CRANK_CONFIRMATIONS: '1', ALERT_TRANSPORT: 'console',
      QA2_NOW_OFFSET_MS: String(offsetMs), ...extraEnv,
    };
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(join(tmp, 'clock.mjs')).href, join(ROOT, 'scripts', 'crank.mjs')], { cwd: ROOT, env, encoding: 'utf8', timeout: 120_000 });
    assert.ok(!r.stderr.includes(crankerKey.slice(2)) && !r.stdout.includes(crankerKey.slice(2)), 'the signing key reached the output');
    let record = null;
    try {
      record = JSON.parse(r.stdout);
    } catch {
      // aborted
    }
    const alerts = [...r.stderr.matchAll(/\[ALERT (\w+)\] ([^\n]*)/g)].map((m) => `${m[1]}: ${m[2].trim()}`);
    RUNS.push({ label, code: r.status, alerts, dryRun: record?.dryRun ?? null });
    return { code: r.status, record, stderr: r.stderr, alerts };
  }
  const decisions = (r) => r.record.actions.map((a) => [a.id, a.decision]);

  it('two of the cranker\'s gate checks in one block (Q5 lands, then a revert): each credited to its own step, nothing resent', async () => {
    const { swa, file } = await deployMocks();
    await (await swa.setLastChecked(4)).wait();
    const t = await fresh();
    const sched = writeSchedule([
      { id: '78', step: 78, function: 'quarterlyGateCheck', args: [], gateQuarter: 5, notBefore: iso(t), notAfter: iso(t + 3600), expect: 'pass', status: 'Pending' },
      { id: '79', step: 79, function: 'quarterlyGateCheck', args: [], gateQuarter: 6, notBefore: iso(t), notAfter: iso(t + 3600), expect: 'revert:StepWeightRecordsFailed', status: 'Pending' },
    ]);
    // A person's force_call and a run racing: two of the cranker's messages in one block, with the
    // SWA flipped to revert between them (a third party's setMode, ordered by fee).
    const to = await swa.getAddress();
    const n0 = await provider.getTransactionCount(cranker.address, 'latest');
    const fee = (p) => ({ maxFeePerGas: parseUnits('100', 'gwei'), maxPriorityFeePerGas: parseUnits(String(p), 'gwei') });
    await provider.send('evm_setAutomine', [false]);
    let tx1;
    let tx2;
    try {
      tx1 = await cranker.sendTransaction({ to, data: GATE.encodeFunctionData('quarterlyGateCheck', []), gasLimit: 5_000_000n, nonce: n0, ...fee(3) });
      await swa.setMode(2, { gasLimit: 200_000n, ...fee(2) });
      tx2 = await cranker.sendTransaction({ to, data: GATE.encodeFunctionData('quarterlyGateCheck', []), gasLimit: 5_000_000n, nonce: n0 + 1, ...fee(1) });
      await provider.send('evm_mine', []);
    } finally {
      await provider.send('evm_setAutomine', [true]);
    }
    const [r1, r2] = [await provider.getTransactionReceipt(tx1.hash), await provider.getTransactionReceipt(tx2.hash)];
    assert.equal(r1.blockNumber, r2.blockNumber, 'harness: not in one block');
    assert.deepEqual([r1.status, r2.status], [1, 0], 'harness: expected land then revert');
    await provider.send('evm_mine', []);
    const before = await nonce();
    const r = crank('same-block', sched, file);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.record.actions.map((a) => [a.id, a.decision, a.txHash]), [['78', 'already-sent', tx1.hash], ['79', 'already-sent', tx2.hash]]);
    assert.equal(r.record.actions[0].match, true);
    // 79's reason: Hardhat has no Lotus receipt, so the engine replays at the parent block, where the
    // SWA was not yet in revert mode -- "reason not recoverable", match NO. That is the documented
    // replay limitation (engine.mjs revertData), not an attribution error; on Lotus the receipt has it.
    assert.equal(r.record.actions[1].result, 'reverted (reason not recoverable)');
    assert.equal(await nonce(), before);
  });

  it('steps 30.1/31 on the real stack: 30.1 sent 19:05 then marked Complete, 31 sent 19:16 -- the 19:31 run must not send submitShares(3) again', async () => {
    const { file } = await deployMocks();
    const t0 = await fresh(); // "19:00"
    const e30 = { id: '30.1', step: 30, function: 'submitShares', args: [3], gateQuarter: null, notBefore: iso(t0), notAfter: iso(t0 + 45 * 60), expect: 'pass', status: 'Pending' };
    const e31 = { id: '31', step: 31, function: 'submitShares', args: [3], gateQuarter: null, notBefore: iso(t0 + 15 * 60), notAfter: iso(t0 + 60 * 60), expect: 'revert:*', status: 'Pending' };
    const v1 = writeSchedule([e30, e31]);
    await setTime(t0 + 5 * 60);
    const a = crank('30.1', v1, file);
    assert.equal(a.code, 0, a.stderr);
    assert.deepEqual(decisions(a), [['30.1', 'sent']]);
    // The runbook marks 30.1 Complete and the schedule is rebuilt.
    const v2 = writeSchedule([{ ...e30, status: 'Complete' }, e31]);
    await setTime(t0 + 16 * 60);
    const b = crank('31', v2, file);
    assert.equal(b.code, 0, b.stderr);
    assert.deepEqual(decisions(b), [['31', 'sent']]);
    assert.equal(b.record.actions[0].result, 'reverted AlreadySubmitted(3)');
    await setTime(t0 + 31 * 60);
    const before = await nonce();
    const c = crank('31 again', v2, file);
    const sentAgain = c.record.actions.filter((x) => x.decision === 'sent');
    assert.equal(await nonce(), before,
      `step 31 broadcast a second time (${sentAgain.map((x) => `${x.id} ${x.txHash.slice(0, 10)} ${x.result}`).join('; ')}); decisions ${JSON.stringify(decisions(c))}`);
  });

  it('deployments.json differs from SRA_ADDRESS/SWA_ADDRESS: a warning names both, and the send goes to the deployments address', async () => {
    const { swa, sra, file } = await deployMocks();
    const t = await fresh();
    const sched = writeSchedule([{ id: 'd1', step: 1, function: 'quarterlyGateCheck', args: [], gateQuarter: null, notBefore: iso(t), notAfter: iso(t + 3600), expect: 'pass', status: 'Pending' }]);
    const decoySra = getAddress('0x000000000000000000000000000000000000dead');
    const decoySwa = getAddress('0x000000000000000000000000000000000000beef');
    const r = crank('mismatch', sched, file, { SRA_ADDRESS: decoySra, SWA_ADDRESS: decoySwa });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /SRA in deployments\.json differs from the production config; rehearsal mode uses deployments\.json/);
    assert.match(r.stderr, /SWA in deployments\.json differs from the production config; rehearsal mode uses deployments\.json/);
    assert.ok(r.stderr.includes(decoySwa) && r.stderr.includes(await swa.getAddress()), 'the warning does not name both addresses');
    assert.deepEqual([r.record.contracts.sra, r.record.contracts.swa], [await sra.getAddress(), await swa.getAddress()]);
    const tx = await provider.getTransaction(r.record.actions[0].txHash);
    assert.equal(tx.to, await swa.getAddress());
  });

  it('no CRANKER_PRIVATE_KEY with CRANK_DRY_RUN: a labelled dry run, cranker null, nothing mined', async () => {
    const { file } = await deployMocks();
    const t = await fresh();
    const sched = writeSchedule([{ id: 'k1', step: 1, function: 'submitShares', args: [2], gateQuarter: null, notBefore: iso(t), notAfter: iso(t + 3600), expect: 'pass', status: 'Pending' }]);
    const block = await provider.getBlockNumber();
    const r = crank('keyless dry', sched, file, { CRANKER_PRIVATE_KEY: undefined, CRANK_DRY_RUN: '1' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.record.dryRun, true);
    assert.equal(r.record.cranker, null);
    assert.deepEqual(decisions(r), [['k1', 'dry-run']]);
    assert.match(r.stderr, /no CRANKER_PRIVATE_KEY/);
    assert.equal(await provider.getBlockNumber(), block, 'a block was mined');
  });

  it('no CRANKER_PRIVATE_KEY without CRANK_DRY_RUN: nothing sent; a labelled dry run, or at least an alert with the exit 1', async () => {
    const { file } = await deployMocks();
    const t = await fresh();
    const sched = writeSchedule([{ id: 'k2', step: 1, function: 'submitShares', args: [2], gateQuarter: null, notBefore: iso(t), notAfter: iso(t + 3600), expect: 'pass', status: 'Pending' }]);
    const block = await provider.getBlockNumber();
    const r = crank('keyless', sched, file, { CRANKER_PRIVATE_KEY: undefined });
    assert.equal(await provider.getBlockNumber(), block, 'a block was mined');
    assert.ok(r.record?.dryRun === true || (r.code === 1 && r.alerts.length > 0),
      `exit ${r.code}, record ${r.record ? 'printed' : 'none'}, alerts ${JSON.stringify(r.alerts)}; stderr: ${r.stderr.trim().split('\n').slice(-2).join(' / ')}`);
  });

  it('a dry run (with the key) pages nobody, even with the wallet below CRANK_MIN_BALANCE_FIL', async () => {
    const { file } = await deployMocks();
    const t = await fresh();
    const sched = writeSchedule([{ id: 'b1', step: 1, function: 'submitShares', args: [2], gateQuarter: null, notBefore: iso(t), notAfter: iso(t + 3600), expect: 'pass', status: 'Pending' }]);
    const r = crank('dry low balance', sched, file, { CRANK_DRY_RUN: '1', CRANK_MIN_BALANCE_FIL: '1000000' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.record.dryRun, true);
    assert.deepEqual(r.alerts, [], 'a dry run raised an alert');
  });

  it('a real run with the wallet low: the low-balance alert is the one alert allowed without exit 1', async () => {
    const { file } = await deployMocks();
    const t = await fresh();
    const sched = writeSchedule([{ id: 'b2', step: 1, function: 'submitShares', args: [2], gateQuarter: null, notBefore: iso(t), notAfter: iso(t + 3600), expect: 'pass', status: 'Pending' }]);
    const r = crank('low balance', sched, file, { CRANK_MIN_BALANCE_FIL: '1000000' });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(decisions(r), [['b2', 'sent']]);
    assert.deepEqual(r.alerts, ['warn: Solstice: cranker wallet is low on gas']);
  });

  it('every child run above: exit 1 came with an alert; an alert without exit 1 was only the low-balance one', () => {
    const bad = RUNS.filter((r) => (r.code === 1 && r.alerts.length === 0) || (r.code !== 1 && r.alerts.some((a) => !/low on gas/.test(a))));
    assert.deepEqual(bad, []);
  });
});
