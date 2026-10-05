/**
 * Rehearsal mode end to end: the real entrypoint (scripts/crank.mjs, CRANK_MODE=rehearsal) as a
 * child process, against a local Hardhat chain that reports calibnet's chain id, with mock SRA/SWA
 * contracts that revert on demand with the real contracts' errors.
 *
 * This is the "local mock RPC" the work was tested on. No test here talks to calibnet; the
 * chain is started by this file on 127.0.0.1 and stopped at the end.
 *
 * The key the cranker signs with is account 1 of the public Hardhat test mnemonic, derived here and
 * passed to the child in its environment. It is never printed and holds nothing anywhere real.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContractFactory, HDNodeWallet, JsonRpcProvider, Mnemonic } from 'ethers';

import { tagGasLimit } from '../../src/rehearsal/engine.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CHAIN_DIR = join(ROOT, 'test', 'rehearsal-chain');
const CONFIG = join(CHAIN_DIR, 'hardhat.config.cjs');
const MNEMONIC = 'test test test test test test test test test test test junk';
const HARDHAT = join(ROOT, 'node_modules', '.bin', 'hardhat');

const CALIB = { port: 8547, chainId: 314159 };
const OTHER = { port: 8548, chainId: 31337 };

function startNode({ port, chainId }) {
  const child = spawn(HARDHAT, ['node', '--config', CONFIG, '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: CHAIN_DIR,
    env: { ...process.env, REHEARSAL_TEST_CHAIN_ID: String(chainId) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  return child;
}

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

describe('rehearsal mode against a local chain with calibnet\'s chain id', { skip: !spawnSync(HARDHAT, ['--version'], { cwd: ROOT }).stdout?.length && 'hardhat not installed' }, () => {
  const nodes = [];
  let provider;
  let sra;
  let swa;
  let crankerAddress;
  let crankerKey;
  let tmp;
  let deploymentsFile;

  before(async () => {
    const compiled = spawnSync(HARDHAT, ['compile', '--quiet', '--config', CONFIG], { cwd: CHAIN_DIR, encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.stderr);
    nodes.push(startNode(CALIB), startNode(OTHER));
    assert.equal(await waitFor(`http://127.0.0.1:${CALIB.port}`), CALIB.chainId);
    assert.equal(await waitFor(`http://127.0.0.1:${OTHER.port}`), OTHER.chainId);

    provider = new JsonRpcProvider(`http://127.0.0.1:${CALIB.port}`, CALIB.chainId, { staticNetwork: true, cacheTimeout: -1 });
    const deployer = wallet(0, provider);
    const art = (name) => JSON.parse(readFileSync(join(CHAIN_DIR, 'artifacts', 'contracts', 'RehearsalMocks.sol', `${name}.json`), 'utf8'));
    swa = await (await new ContractFactory(art('MockSWA').abi, art('MockSWA').bytecode, deployer).deploy()).waitForDeployment();
    sra = await (await new ContractFactory(art('MockSRA').abi, art('MockSRA').bytecode, deployer).deploy()).waitForDeployment();
    await (await swa.setLastChecked(6)).wait(); // the gate's next quarter is Q7, as on calibnet tonight

    const cranker = wallet(1, provider);
    crankerAddress = cranker.address;
    crankerKey = cranker.privateKey;

    tmp = mkdtempSync(join(tmpdir(), 'rehearsal-it-'));
    deploymentsFile = join(tmp, 'deployments.json');
    writeFileSync(deploymentsFile, JSON.stringify({ 314159: { sra: await sra.getAddress(), swa: await swa.getAddress() } }));
  });

  after(() => {
    for (const n of nodes) n.kill('SIGTERM');
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString().replace(/\.\d+Z$/, 'Z');
  const nonce = (p = provider, a = crankerAddress) => p.getTransactionCount(a, 'latest');
  const mineNow = () => provider.send('evm_mine', []);

  /**
   * A window that opens after every earlier send. quarterlyGateCheck() is byte-identical every
   * time, so an entry whose window covered a previous test's gate check would -- correctly -- count
   * that check as its own send. Wait past the last block's second, open the window, mine a block.
   */
  //
  // Hardhat stamps every block at least a second after the previous one, so a burst of blocks runs
  // its clock ahead of the wall clock; Lotus epochs do not drift like that. Open the window after
  // both clocks, then wait for the wall clock to reach it.
  let opensAt;
  async function freshWindow() {
    const head = await provider.getBlock('latest');
    const t = Math.max(Math.floor(Date.now() / 1000), head.timestamp) + 1;
    while (Date.now() < t * 1000 + 50) await new Promise((r) => setTimeout(r, 50));
    opensAt = new Date(t * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
    await mineNow();
    return opensAt;
  }

  let n = 0;
  function writeSchedule(entries) {
    const f = join(tmp, `schedule-${++n}.json`);
    writeFileSync(f, JSON.stringify({ network: 'calibnet', chainId: 314159, entries }));
    return f;
  }
  const gateEntry = (over = {}) => ({
    id: `g${n}`, step: 80, function: 'quarterlyGateCheck', args: [], gateQuarter: 7,
    notBefore: opensAt, notAfter: iso(3_600_000), expect: 'pass', status: 'Pending', ...over,
  });

  /** Runs the real entrypoint. Never inherits a real key or RPC from the developer's shell. */
  function crank(scheduleFile, extraEnv = {}) {
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NETWORK: 'calibnet',
      RPC_URL: `http://127.0.0.1:${CALIB.port}`,
      CRANKER_PRIVATE_KEY: crankerKey,
      CRANK_MODE: 'rehearsal',
      CRANK_SCHEDULE_FILE: scheduleFile,
      SOLSTICE_DEPLOYMENTS: deploymentsFile,
      CRANK_REHEARSAL_GAS_LIMIT: '5000000', // Hardhat caps one transaction at 2^24 gas
      CRANK_PAUSE_FILE: join(tmp, 'PAUSED'),
      CRANK_CONFIRMATIONS: '1',
      ALERT_TRANSPORT: 'console',
      ...extraEnv,
    };
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'crank.mjs')], { cwd: ROOT, env, encoding: 'utf8', timeout: 120_000 });
    assert.ok(!r.stderr.includes(crankerKey.slice(2)), 'the signing key reached the log');
    assert.ok(!r.stdout.includes(crankerKey.slice(2)), 'the signing key reached the run record');
    let record = null;
    try {
      record = JSON.parse(r.stdout);
    } catch {
      // aborted runs print no record
    }
    return { code: r.status, record, stderr: r.stderr };
  }

  it('too early: exits 0 and sends nothing', async () => {
    await freshWindow();
    const before = await nonce();
    const r = crank(writeSchedule([gateEntry({ notBefore: iso(3_600_000), notAfter: iso(7_200_000) })]));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(await nonce(), before);
    assert.equal(r.record.next.notBefore !== null, true);
  });

  it('expected revert: sent without a pre-check, lands on chain reverted, decoded and matched', async () => {
    await (await swa.setMode(2)).wait(); // StepWeightRecordsFailed(16), like step 80
    await freshWindow();
    const before = await nonce();
    const file = writeSchedule([gateEntry({ expect: 'revert:StepWeightRecordsFailed' })]);
    const r = crank(file);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(await nonce(), before + 1, 'exactly one message sent');
    const a = r.record.actions[0];
    assert.equal(a.decision, 'sent');
    assert.equal(a.result, 'reverted StepWeightRecordsFailed(16)');
    assert.equal(a.match, true);
    const receipt = await provider.getTransactionReceipt(a.txHash);
    assert.equal(receipt.status, 0, 'the revert is on chain');
    assert.equal(a.epoch, receipt.blockNumber);
    const tx = await provider.getTransaction(a.txHash);
    assert.equal(tx.gasLimit, tagGasLimit(5_000_000n, a.id), 'the explicit limit, not an estimate, its last digits naming the step');
    assert.match(r.stderr, new RegExp(`rehearsal step=${a.id} fn=quarterlyGateCheck\\(\\) tx=${a.txHash} epoch=${a.epoch} decision=sent result="reverted StepWeightRecordsFailed\\(16\\)" expect=revert:StepWeightRecordsFailed match=yes`));

    // ...and a second run in the same window does not send it again.
    await mineNow();
    const again = crank(file);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(await nonce(), before + 1, 'sent twice');
    assert.equal(again.record.actions[0].decision, 'already-sent');
    assert.equal(again.record.actions[0].txHash, a.txHash);
  });

  it('unexpected revert: expected to land, reverted -- sent anyway, flagged, exit 1', async () => {
    await (await sra.setLatestBound(7)).wait();
    await freshWindow();
    const before = await nonce();
    const r = crank(writeSchedule([{ ...gateEntry(), id: 'u1', function: 'submitShares', args: [8], gateQuarter: null, expect: 'pass' }]));
    assert.equal(r.code, 1);
    assert.equal(await nonce(), before + 1, 'the scheduled call was sent');
    const a = r.record.actions[0];
    assert.equal(a.decision, 'sent');
    assert.equal(a.result, 'reverted NotBound(8)');
    assert.equal(a.match, false);
    assert.match(r.stderr, /did not do what the plan expected/);
  });

  it('"fail": a gate check that lands with passed = false matches', async () => {
    await (await swa.setMode(1)).wait();
    await freshWindow();
    const r = crank(writeSchedule([gateEntry({ expect: 'fail' })]));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.record.actions[0].result, 'landed, gate failed for Q7 (steps 0)');
    assert.equal(r.record.actions[0].match, true);
  });

  it('the gate is not at the quarter the plan names: held, not sent', async () => {
    await freshWindow(); // the gate is now at Q8 after the previous test
    const before = await nonce();
    const r = crank(writeSchedule([gateEntry({ gateQuarter: 5 })]));
    assert.equal(await nonce(), before);
    assert.equal(r.record.actions[0].decision, 'blocked');
    assert.equal(r.code, 1);
  });

  it('paused by variable or by file: nothing is sent', async () => {
    await (await swa.setMode(0)).wait();
    await freshWindow();
    const before = await nonce();
    const file = writeSchedule([gateEntry({ gateQuarter: 8 })]);
    const byVar = crank(file, { CRANK_PAUSED: '1' });
    assert.equal(byVar.code, 0, byVar.stderr);
    assert.equal(byVar.record.actions[0].decision, 'paused');
    writeFileSync(join(tmp, 'PAUSED'), '');
    try {
      const byFile = crank(file);
      assert.equal(byFile.code, 0, byFile.stderr);
      assert.equal(byFile.record.actions[0].decision, 'paused');
    } finally {
      rmSync(join(tmp, 'PAUSED'));
    }
    assert.equal(await nonce(), before);
  });

  it('dry run: decides, sends nothing', async () => {
    await freshWindow();
    const before = await nonce();
    const r = crank(writeSchedule([gateEntry({ gateQuarter: 8 })]), { CRANK_DRY_RUN: '1' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.record.actions[0].decision, 'dry-run');
    assert.equal(await nonce(), before);
  });

  it('refuses to start on any chain but calibnet', async () => {
    await freshWindow();
    const file = writeSchedule([gateEntry({ gateQuarter: 8 })]);
    // NETWORK=devnet: refused before the node is touched.
    const devnet = crank(file, { NETWORK: 'devnet' });
    assert.equal(devnet.code, 1);
    assert.match(devnet.stderr, /rehearsal mode is calibnet-only/);
    // NETWORK=calibnet but the endpoint is another chain: refused, and nothing sent there.
    const other = new JsonRpcProvider(`http://127.0.0.1:${OTHER.port}`, OTHER.chainId, { staticNetwork: true });
    const before = await nonce(other);
    const wrong = crank(file, { RPC_URL: `http://127.0.0.1:${OTHER.port}` });
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /reports chain 31337/);
    assert.equal(await nonce(other), before);
  });

  it('production mode is untouched: without CRANK_MODE nothing reads the schedule', async () => {
    const r = crank(join(tmp, 'does-not-exist.json'), { CRANK_MODE: '', CRANK_DRY_RUN: '1', NETWORK: 'calibnet', SRA_ADDRESS: await sra.getAddress(), SWA_ADDRESS: await swa.getAddress() });
    assert.doesNotMatch(r.stderr, /REHEARSAL mode/);
    assert.doesNotMatch(r.stderr, /rehearsal schedule/);
  });
});
