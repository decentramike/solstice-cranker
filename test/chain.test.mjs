/**
 * src/chain.mjs -- storage decoding, probing and retry, with no chain.
 *
 * The storage reads are the part worth being paranoid about: a wrong byte offset does not
 * throw, it makes the cranker confidently wrong about whether a quarter was submitted. So the
 * words here are built the way solc packs them (first declared field in the LOW bytes) and one
 * fixture is a verbatim word read out of a live devnet deployment.
 *
 * Struct layouts under test:
 *   SraStorage.SraStorageQuarter    (vendor/solstice/src/lib/SraStorage.sol L27-L32)
 *     uint64 lastSubmittedQuarter; uint64 mirrorAQuarter; uint64 mirrorBQuarter; mapping ...
 *   GateParamsLibrary.GateParamsInfo (vendor/solstice/src/lib/GateParams.sol L26-L29)
 *     uint64 lastCheckedQuarter; GateParams { VolumeTarget { FixedU18 base; FixedU18 stepRatio; }
 *                                             uint64 steps; }
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  hasCode,
  isQuarterBound,
  observeLatestBoundQuarter,
  readSraQuarterState,
  readSwaGateState,
  withRetry,
} from '../src/chain.mjs';
import { ZERO_ADDRESS } from '../src/config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SLOTS = JSON.parse(readFileSync(join(ROOT, 'config', 'storage-slots.json'), 'utf8'));

const ADDR = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const hex = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');

/** A provider whose storage is a slot -> word map, keyed by normalised slot number. */
function storageProvider(words) {
  const byIndex = new Map(Object.entries(words).map(([k, v]) => [BigInt(k), BigInt(v)]));
  return {
    calls: [],
    async getStorage(address, slot) {
      this.calls.push({ address, slot });
      return hex(byIndex.get(BigInt(slot)) ?? 0n);
    },
  };
}

const sraSlot = BigInt(SLOTS.sraQuarter.slot);
const swaSlot = BigInt(SLOTS.swaGateParams.slot);

/** Packs the SraStorageQuarter word the way solc does: field 0 in the lowest bytes. */
const packSraQuarter = (lastSubmitted, tagA, tagB) =>
  BigInt(lastSubmitted) | (BigInt(tagA) << 64n) | (BigInt(tagB) << 128n);

describe('readSraQuarterState', () => {
  it('decodes a word captured from a live devnet deployment', async () => {
    // Read with eth_getStorageAt from the deployed SRA at devnet/.deployed.json:
    // lastSubmittedQuarter 4, mirror A tagged quarter 3, mirror B tagged quarter 4.
    const word = '0x0000000000000000000000000000000500000000000000040000000000000004';
    const provider = storageProvider({ [sraSlot]: word });
    assert.deepEqual(await readSraQuarterState(provider, ADDR), {
      lastSubmittedQuarter: 4,
      mirrorAQuarter: 3,
      mirrorBQuarter: 4,
    });
  });

  it('reads the namespaced base slot itself, not an offset from it', async () => {
    const provider = storageProvider({ [sraSlot]: packSraQuarter(9, 0, 0) });
    await readSraQuarterState(provider, ADDR);
    assert.equal(provider.calls.length, 1);
    assert.equal(BigInt(provider.calls[0].slot), sraSlot);
    assert.equal(provider.calls[0].address, ADDR);
  });

  it('keeps the three uint64 fields independent', async () => {
    const provider = storageProvider({ [sraSlot]: packSraQuarter(1, 2, 3) });
    const s = await readSraQuarterState(provider, ADDR);
    assert.equal(s.lastSubmittedQuarter, 1);
    assert.equal(s.mirrorAQuarter, 1); // tag 2 -> quarter 1
    assert.equal(s.mirrorBQuarter, 2); // tag 3 -> quarter 2
  });

  it('does not let a neighbouring field bleed across the 8-byte boundary', async () => {
    // Every field at its uint64 maximum: any shift or mask error shows up immediately.
    const max = (1n << 64n) - 1n;
    const provider = storageProvider({ [sraSlot]: packSraQuarter(max, max, max) });
    const s = await readSraQuarterState(provider, ADDR);
    assert.equal(s.lastSubmittedQuarter, Number(max));
    assert.equal(s.mirrorAQuarter, Number(max - 1n));
    assert.equal(s.mirrorBQuarter, Number(max - 1n));
  });

  it('treats a never-written mirror tag as null, not as quarter -1', async () => {
    // mirrorAQuarter/mirrorBQuarter store quarter + 1 precisely so 0 can mean "never written".
    const provider = storageProvider({ [sraSlot]: packSraQuarter(0, 0, 0) });
    const s = await readSraQuarterState(provider, ADDR);
    assert.equal(s.lastSubmittedQuarter, 0);
    assert.equal(s.mirrorAQuarter, null);
    assert.equal(s.mirrorBQuarter, null);
    assert.notEqual(s.mirrorAQuarter, -1);
  });

  it('decodes tag 1 as quarter 0, the reserved quarter, rather than as never-written', async () => {
    const provider = storageProvider({ [sraSlot]: packSraQuarter(0, 1, 2) });
    const s = await readSraQuarterState(provider, ADDR);
    assert.equal(s.mirrorAQuarter, 0);
    assert.equal(s.mirrorBQuarter, 1);
  });

  it('reports a fresh deployment as lastSubmittedQuarter 0', async () => {
    const provider = storageProvider({});
    const s = await readSraQuarterState(provider, ADDR);
    assert.equal(s.lastSubmittedQuarter, 0);
  });
});

describe('readSwaGateState', () => {
  it('decodes the four words captured from a live devnet deployment', async () => {
    const provider = storageProvider({
      [swaSlot]: '0x' + (4n).toString(16).padStart(64, '0'),
      [swaSlot + 1n]: '0xbdbc41e0348b300000',
      [swaSlot + 2n]: '0x257853b1dd8e0000',
      [swaSlot + 3n]: '0x02',
    });
    const g = await readSwaGateState(provider, ADDR);
    assert.equal(g.lastCheckedQuarter, 4);
    // GateParams.sol: VOL_TARGET_ENTRY = 3500 ether, VOL_TARGET_RATIO = 2.7 ether.
    assert.equal(g.targetBase, 3500n * 10n ** 18n);
    assert.equal(g.targetStepRatio, 27n * 10n ** 17n);
    assert.equal(g.steps, 2);
    assert.equal(g.gateSteps, 8);
    assert.equal(g.complete, false);
  });

  it('reads exactly base, base+1, base+2 and base+3', async () => {
    const provider = storageProvider({});
    await readSwaGateState(provider, ADDR);
    const read = provider.calls.map((c) => BigInt(c.slot) - swaSlot).sort();
    assert.deepEqual(read, [0n, 1n, 2n, 3n]);
  });

  it('a struct member starts a fresh slot, so lastCheckedQuarter never shares with base', async () => {
    // If the layout were packed rather than slot-aligned, a large base would corrupt the
    // quarter. Put a full-width FixedU18 in word 1 and check word 0 is untouched.
    const provider = storageProvider({
      [swaSlot]: 6n,
      [swaSlot + 1n]: (1n << 255n) - 1n,
      [swaSlot + 3n]: 3n,
    });
    const g = await readSwaGateState(provider, ADDR);
    assert.equal(g.lastCheckedQuarter, 6);
    assert.equal(g.steps, 3);
  });

  it('is complete at the 8-step cap and beyond, and not before', async () => {
    const at = async (steps) => {
      const provider = storageProvider({ [swaSlot + 3n]: BigInt(steps) });
      return (await readSwaGateState(provider, ADDR)).complete;
    };
    assert.equal(await at(0), false);
    assert.equal(await at(7), false);
    assert.equal(await at(8), true);
    assert.equal(await at(9), true);
  });

  it('config/storage-slots.json agrees with the hardcoded upstream constants', () => {
    // SraStorage.QUARTER_SLOT and GateParamsLibrary.GATE_PARAMS_SLOT.
    assert.equal(SLOTS.sraQuarter.slot, '0x347e624280399e1e720d839edbd7cd00c80c69bf34cd8ee59e27f691732af300');
    assert.equal(SLOTS.swaGateParams.slot, '0xf9abab00248d945495524c8caf6be2b837274c1becd1964fb3775f62fd6e4600');
    assert.equal(SLOTS.swaGateParams.gateSteps, 8); // GateParamsLibrary.GATE_STEPS
    // ERC-7201 slots are 256-byte aligned: the low byte is always zero.
    for (const s of [SLOTS.sraQuarter.slot, SLOTS.swaGateParams.slot]) {
      assert.equal(BigInt(s) % 256n, 0n, s);
    }
  });
});

describe('isQuarterBound', () => {
  const sraWith = (fn) => ({ aggregatedFilecoinPayVolume: fn });

  it('is true when the view returns', async () => {
    assert.equal(await isQuarterBound(sraWith(async () => 0n), 4), true);
  });

  it('is false on a NotBound revert', async () => {
    const err = Object.assign(new Error('revert'), {
      code: 'CALL_EXCEPTION',
      revert: { name: 'NotBound', args: [5n] },
    });
    assert.equal(await isQuarterBound(sraWith(async () => { throw err; }), 5), false);
  });

  it('rethrows a transport failure instead of reporting "not bound"', async () => {
    // A dropped RPC must never be readable as "this quarter is not bound yet".
    const err = Object.assign(new Error('connection reset'), { code: 'NETWORK_ERROR' });
    await assert.rejects(() => isQuarterBound(sraWith(async () => { throw err; }), 5), /connection reset/);
  });
});

describe('observeLatestBoundQuarter', () => {
  /** A chain whose quarters 1..latest are bound. */
  const chainWith = (latest, { onProbe } = {}) => ({
    probed: [],
    async aggregatedFilecoinPayVolume(q) {
      this.probed.push(q);
      onProbe?.(q);
      if (q < 1 || q > latest) {
        throw Object.assign(new Error('revert'), {
          code: 'CALL_EXCEPTION',
          revert: { name: 'NotBound', args: [BigInt(q)] },
        });
      }
      return 0n;
    },
  });

  it('confirms a correct candidate in two probes', async () => {
    const sra = chainWith(6);
    const r = await observeLatestBoundQuarter(sra, 6);
    assert.equal(r.quarter, 6);
    assert.equal(r.probes, 2);
    assert.deepEqual(sra.probed, [6, 7]);
  });

  it('corrects a candidate that is one quarter behind', async () => {
    assert.equal((await observeLatestBoundQuarter(chainWith(6), 5)).quarter, 6);
  });

  it('corrects a candidate that is one quarter ahead', async () => {
    assert.equal((await observeLatestBoundQuarter(chainWith(6), 7)).quarter, 6);
  });

  it('corrects a candidate two quarters out, in both directions', async () => {
    assert.equal((await observeLatestBoundQuarter(chainWith(6), 4)).quarter, 6);
    assert.equal((await observeLatestBoundQuarter(chainWith(6), 8)).quarter, 6);
  });

  it('is null on a chain with nothing bound', async () => {
    assert.equal((await observeLatestBoundQuarter(chainWith(0), null)).quarter, null);
    assert.equal((await observeLatestBoundQuarter(chainWith(0), 3)).quarter, null);
  });

  it('never probes quarter 0 or below', async () => {
    const sra = chainWith(3);
    await observeLatestBoundQuarter(sra, 1);
    assert.ok(sra.probed.every((q) => q >= 1), `probed ${sra.probed}`);
  });

  it('is bounded: at most 2 + 4 * spread probes', async () => {
    const sra = chainWith(0);
    const r = await observeLatestBoundQuarter(sra, 40, { spread: 2 });
    assert.ok(r.probes <= 10, `made ${r.probes} probes`);
  });

  it('refuses to read an unreadable probe as "not bound"', async () => {
    // Regression for the defect where isQuarterBound turned EVERY non-transport error into
    // "not bound". One bad eth_call on the candidate made the search settle on candidate - 1,
    // whose window has already closed, and the cranker then sent a guaranteed
    // NotLatestQuarter and alerted critically on a perfectly healthy chain.
    let failOnce = true;
    const sra = chainWith(6, {
      onProbe(q) {
        if (q === 6 && failOnce) {
          failOnce = false;
          throw Object.assign(new Error('bad gateway'), { code: 'BAD_DATA' });
        }
      },
    });
    await assert.rejects(
      () => observeLatestBoundQuarter(sra, 6),
      /neither a value nor NotBound/,
      'an undecodable answer must propagate, never be silently read as a negative'
    );
  });

  it('still reads a genuine NotBound as not bound', async () => {
    const sra = chainWith(6);
    const r = await observeLatestBoundQuarter(sra, 6);
    assert.equal(r.quarter, 6);
  });

  it('answers null rather than a quarter its own probes disproved', async () => {
    // When every probed pair comes back (bound, bound) the true latest is beyond the search,
    // and the largest quarter probed is the one answer positively known to be wrong -- its
    // successor was observed bound. Unreachable while assertGeometry holds, but "I do not
    // know" is the only honest reply.
    const sra = chainWith(50);
    const r = await observeLatestBoundQuarter(sra, 5);
    assert.equal(r.quarter, null, 'must not name a quarter whose successor it saw bound');
    assert.equal(r.exhausted, true);
  });
});

describe('withRetry', () => {
  it('returns the first success without sleeping', async () => {
    let calls = 0;
    const v = await withRetry(async () => { calls++; return 'ok'; }, { attempts: 3, baseMs: 1 });
    assert.equal(v, 'ok');
    assert.equal(calls, 1);
  });

  it('retries a transport failure and succeeds', async () => {
    let calls = 0;
    const v = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
        return 'ok';
      },
      { attempts: 4, baseMs: 1, what: 'test' }
    );
    assert.equal(v, 'ok');
    assert.equal(calls, 3);
  });

  it('gives up after the attempt budget and rethrows the last error', async () => {
    let calls = 0;
    await assert.rejects(
      () => withRetry(async () => { calls++; throw Object.assign(new Error('down'), { code: 'NETWORK_ERROR' }); },
        { attempts: 3, baseMs: 1 }),
      /down/
    );
    assert.equal(calls, 3);
  });

  it('never retries a revert -- it is an answer, not a failure', async () => {
    let calls = 0;
    await assert.rejects(
      () => withRetry(async () => {
        calls++;
        throw Object.assign(new Error('revert'), { code: 'CALL_EXCEPTION', revert: { name: 'NotBound', args: [1n] } });
      }, { attempts: 4, baseMs: 1 }),
      /revert/
    );
    assert.equal(calls, 1);
  });
});

describe('connect: the provider ethers gives us', () => {
  /** A minimal JSON-RPC endpoint that counts what it is asked. */
  async function rpcStub(handlers) {
    const { createServer } = await import('node:http');
    const counts = {};
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const { id, method } = JSON.parse(body);
        counts[method] = (counts[method] ?? 0) + 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result: handlers[method] }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { counts, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
  }

  it('reads the nonce afresh for every transaction', async () => {
    // AbstractProvider coalesces identical performs for `cacheTimeout` ms (default 250),
    // keyed by method + args -- getTransactionCount included. Leave that default on and the
    // second transaction of the gate catch-up loop is populated with the first one's nonce;
    // the node rejects it ("nonce has already been used"), it classifies as a fault, the loop
    // breaks and a healthy catch-up exits 1. connect() must pass cacheTimeout: -1.
    const { connect } = await import('../src/chain.mjs');
    const stub = await rpcStub({
      eth_chainId: '0x7a69',
      eth_getTransactionCount: '0x5',
    });
    try {
      const { provider, wallet } = await connect({
        rpcUrl: `http://127.0.0.1:${stub.port}`,
        chainId: 31337n,
        networkName: 'stub',
        // Shape-valid placeholder, never used to sign; nothing is broadcast in this test.
        privateKey: '0x' + '11'.repeat(32),
        addresses: { sra: ADDR, swa: ADDR },
      });

      await provider.getTransactionCount(wallet.address, 'pending');
      await provider.getTransactionCount(wallet.address, 'pending');

      assert.equal(
        stub.counts.eth_getTransactionCount,
        2,
        'the second nonce read was served from cache -- connect() needs cacheTimeout: -1, ' +
          'or every gate transaction after the first is rejected as a used nonce'
      );
    } finally {
      await stub.close();
    }
  });

  it('actually asks the node which chain it is, and refuses a mismatch', async () => {
    // Regression: connect() passed an explicit network AND staticNetwork: true, so ethers
    // answered getNetwork() from the constructor argument and issued no eth_chainId at all.
    // The guard compared the configured chain id with itself and always agreed, so an
    // RPC_URL pointed at the wrong network sailed through and preflight reported a pass it
    // had never checked.
    const { connect } = await import('../src/chain.mjs');
    const stub = await rpcStub({ eth_chainId: '0x1' }); // the node says chain 1
    try {
      await assert.rejects(
        () =>
          connect({
            rpcUrl: `http://127.0.0.1:${stub.port}`,
            chainId: 314n, // ... and we claim Filecoin mainnet
            networkName: 'mainnet',
            privateKey: '0x' + '11'.repeat(32),
            addresses: { sra: ADDR, swa: ADDR },
          }),
        /reports chain 1.*expects 314/s,
        'a wrong RPC_URL must be refused, not accepted'
      );
      assert.ok(stub.counts.eth_chainId >= 1, 'the node must actually be asked');
    } finally {
      await stub.close();
    }
  });

  it('accepts a node that reports the configured chain', async () => {
    const { connect } = await import('../src/chain.mjs');
    const stub = await rpcStub({ eth_chainId: '0x13a' }); // 314
    try {
      const { provider, readOnly } = await connect({
        rpcUrl: `http://127.0.0.1:${stub.port}`,
        chainId: 314n,
        networkName: 'mainnet',
        privateKey: null,
        addresses: { sra: ADDR, swa: ADDR },
      });
      assert.ok(provider);
      assert.equal(readOnly, true, 'no key means a provider-only session that cannot sign');
    } finally {
      await stub.close();
    }
  });

});

describe('hasCode', () => {
  it('is false for the zero address without touching the provider', async () => {
    const provider = { getCode: async () => { throw new Error('should not be called'); } };
    assert.equal(await hasCode(provider, ZERO_ADDRESS), false);
  });

  it('is false for an address with no code and true for one with code', async () => {
    assert.equal(await hasCode({ getCode: async () => '0x' }, ADDR), false);
    assert.equal(await hasCode({ getCode: async () => '0x60806040' }, ADDR), true);
  });
});
