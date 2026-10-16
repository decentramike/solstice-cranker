/**
 * src/filecoin/* -- addresses, CBOR, message CIDs and signatures.
 *
 * The strongest vectors here are real: a Claim the standalone tool sent on calibnet
 * (nonce 33 from t15gfg…qqki, landed at epoch 4158649), copied from the chain with
 * Filecoin.ChainGetBlockMessages. If the CIDs and the signature recovery match it, this code
 * builds byte-for-byte the messages Lotus accepts. No private key appears in this file; the
 * one signing test uses a fixed byte pattern that holds nothing on any chain.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addressToString,
  ethToF410,
  leb128,
  parseAddress,
  unleb128,
} from '../src/filecoin/address.mjs';
import { decode, decodeBigInt, encodeBigInt, toHex } from '../src/filecoin/cbor.mjs';
import { batch, candidateWallets, claimedThisPeriod, decodeStreamsState } from '../src/filecoin/f02.mjs';
import {
  addressOfKey,
  messageCid,
  parsePrivateKey,
  signMessage,
  signedMessageCid,
  verifySignedMessage,
} from '../src/filecoin/message.mjs';
import { claimParams, decodeClaimReturn, feeVerdict } from '../src/claim.mjs';

const ORCH_A = '0x97A90f5696be5E3C8d3752C92Adac287c2b4484e';
const KNOWN_GOOD_PARAMS = '82028156040a97a90f5696be5e3c8d3752c92adac287c2b4484e';

const REAL = {
  message: {
    Version: 0, To: 't02', From: 't15gfgbbmf5o6cu4lispfduvmvez3r4gvwomzqqki', Nonce: 33, Value: '0',
    GasLimit: 5882143, GasFeeCap: '118725', GasPremium: '117671', Method: 4045527845,
    Params: 'ggKBVgQKl6kPVpa+XjyNN1LJKtrCh8K0SE4=',
  },
  signature: { Type: 1, Data: 'vU8tMw7Q0r1HYSuGNhdn03RftlTBiosnsi/kyasolyZgyiDD23x3IVjBX9oXpqnZFVrXbfKGr8Pe296XPiezPgA=' },
  unsignedCid: 'bafy2bzacedykpyzozvh25dosntyza7lqbtvcjkpdqunkgndmq77qindyimtbk',
  signedCid: 'bafy2bzaceaziyktwmpawggwnv4z7ur323s4hwg66uypocqutzmfrwlhpth6g4',
};

/** A fixed byte pattern. Not a key anyone holds; never funded; used only to sign test bytes. */
const TEST_KEY_HEX = '0x' + '11'.repeat(32);

describe('Claim params', () => {
  it('match the old tool\'s known-good hex for Orchestrator A', () => {
    assert.equal(toHex(claimParams([parseAddress(ORCH_A, 't')])), KNOWN_GOOD_PARAMS);
  });

  it('are the same bytes on Mainnet: the f410 payload has no network prefix', () => {
    assert.equal(toHex(claimParams([parseAddress(ORCH_A, 'f')])), KNOWN_GOOD_PARAMS);
  });

  it('match the params of the real calibnet Claim', () => {
    assert.equal(Buffer.from(REAL.message.Params, 'base64').toString('hex'), KNOWN_GOOD_PARAMS);
  });

  it('encode an ID wallet the way f02 stores it', () => {
    // 163912 in LEB128 is c8 80 0a, so the wallet is the 4 bytes 00 c8 80 0a.
    assert.equal(toHex(claimParams([parseAddress('t0163912', 't')])), '820281440' + '0c8800a');
    const decoded = decode(claimParams([parseAddress('t0163912', 't'), parseAddress('t090', 't')]));
    assert.equal(decoded[0], 2n);
    assert.equal(addressToString(decoded[1][0], 't'), 't0163912');
    assert.equal(addressToString(decoded[1][1], 't'), 't090');
  });
});

describe('addresses, both prefixes', () => {
  it('0x -> f410/t410 matches the published form', () => {
    assert.equal(ethToF410(ORCH_A, 't'), 't410fs6uq6vuwxzpdzdjxklesvwwcq7bliscobcgdofa');
    assert.equal(ethToF410(ORCH_A, 'f'), 'f410fs6uq6vuwxzpdzdjxklesvwwcq7bliscobcgdofa');
  });

  for (const [t, f] of [
    ['t15gfgbbmf5o6cu4lispfduvmvez3r4gvwomzqqki', 'f15gfgbbmf5o6cu4lispfduvmvez3r4gvwomzqqki'],
    ['t17onisyvqkb5h6ix43jplk45x7xfpbydvs34encq', 'f17onisyvqkb5h6ix43jplk45x7xfpbydvs34encq'],
    ['t0163912', 'f0163912'],
    ['t02', 'f02'],
    ['t090', 'f090'],
  ]) {
    it(`${t} and ${f} are the same bytes and round-trip`, () => {
      const a = parseAddress(t, 't');
      const b = parseAddress(f, 'f');
      assert.deepEqual(a, b);
      assert.equal(addressToString(a, 't'), t);
      assert.equal(addressToString(b, 'f'), f);
    });
  }

  it('rejects the other network\'s prefix rather than guessing', () => {
    assert.throws(() => parseAddress('f15gfgbbmf5o6cu4lispfduvmvez3r4gvwomzqqki', 't'), /Mainnet address/);
    assert.throws(() => parseAddress('t15gfgbbmf5o6cu4lispfduvmvez3r4gvwomzqqki', 'f'), /testnet address/);
  });

  it('rejects a typo through the checksum', () => {
    assert.throws(() => parseAddress('t15gfgbbmf5o6cu4lispfduvmvez3r4gvwomzqqka', 't'), /checksum/);
    assert.throws(() => parseAddress('f410fs6uq6vuwxzpdzdjxklesvwwcq7bliscobcgdofb', 'f'), /checksum/);
  });

  it('rejects non-addresses and unknown prefixes', () => {
    assert.throws(() => parseAddress('hello', 't'), /not a Filecoin address/);
    assert.throws(() => parseAddress('t0abc', 't'), /digits/);
    assert.throws(() => parseAddress('t1abc', 'x'), /prefix/);
  });

  it('LEB128 round-trips across byte boundaries', () => {
    for (const n of [0n, 1n, 127n, 128n, 163912n, 2n ** 63n - 1n]) assert.equal(unleb128(leb128(n)), n);
  });
});

describe('CBOR', () => {
  it('TokenAmount round-trips, including zero and the sign byte', () => {
    for (const v of [0n, 1n, 255n, 256n, 10n ** 18n, 194159971037520389598662n]) assert.equal(decodeBigInt(encodeBigInt(v)), v);
    assert.equal(decodeBigInt(Uint8Array.of(1, 5)), -5n);
    assert.throws(() => encodeBigInt(-1n), /negative/);
  });

  it('decodes null, negatives, text and nested arrays; refuses trailing bytes', () => {
    // [null, -2, "a", [1]]
    assert.deepEqual(decode(Uint8Array.from([0x84, 0xf6, 0x21, 0x61, 0x61, 0x81, 0x01])), [null, -2n, 'a', [1n]]);
    assert.throws(() => decode(Uint8Array.from([0x01, 0x01])), /trailing/);
    assert.throws(() => decode(Uint8Array.from([0x82, 0x01])), /truncated/);
  });

  it('decodes a Claim return', () => {
    // ([0, 1000]) -> 81 82 40 43 00 03 e8
    const b64 = Buffer.from([0x81, 0x82, 0x40, 0x43, 0x00, 0x03, 0xe8]).toString('base64');
    assert.deepEqual(decodeClaimReturn(b64), [0n, 1000n]);
  });
});

describe('messages: CIDs and signatures against a real calibnet Claim', () => {
  it('computes the unsigned message CID Lotus reports', () => {
    assert.equal(messageCid(REAL.message, 't').string, REAL.unsignedCid);
  });

  it('computes the signed message CID MpoolPush returned', () => {
    assert.equal(signedMessageCid(REAL.message, REAL.signature, 't').string, REAL.signedCid);
  });

  it('recovers the real signature to the sender', () => {
    assert.equal(verifySignedMessage(REAL.message, REAL.signature, 't'), true);
    assert.equal(verifySignedMessage({ ...REAL.message, Nonce: 34 }, REAL.signature, 't'), false);
  });

  it('signs so that the signature recovers to the key\'s own address, on both prefixes', () => {
    const key = parsePrivateKey(TEST_KEY_HEX, 'TEST');
    for (const prefix of ['t', 'f']) {
      const from = addressOfKey(key, prefix);
      assert.match(from, new RegExp(`^${prefix}1`));
      const m = { ...REAL.message, To: `${prefix}02`, From: from };
      const sig = signMessage(m, key, prefix);
      assert.equal(sig.Type, 1);
      assert.equal(Buffer.from(sig.Data, 'base64').length, 65);
      assert.equal(verifySignedMessage(m, sig, prefix), true);
    }
  });

  it('rejects a malformed key without echoing it', () => {
    for (const bad of ['', '0x1234', 'zz'.repeat(32), '00'.repeat(32)]) {
      assert.throws(() => parsePrivateKey(bad, 'CLAIM_PRIVATE_KEY'), (err) => {
        assert.match(err.message, /CLAIM_PRIVATE_KEY/);
        if (bad.length > 4) assert.ok(!err.message.includes(bad));
        return true;
      });
    }
  });
});

describe('f02 state decoding and discovery', () => {
  // A streams block as calibnet held it on 2026-10-15: stream 1 implicit, stream 2 with two
  // equal shares, nothing payable, both wallets already claimed this period.
  const id = (n) => parseAddress(`t0${n}`, 't');
  const enc = (v) => {
    // tiny encoder for the fixture only
    const { encodeArray, encodeBytes, encodeUint, concat } = CB;
    if (v === null) return Uint8Array.of(0xf6);
    if (typeof v === 'bigint' || typeof v === 'number') return encodeUint(v);
    if (v instanceof Uint8Array) return encodeBytes(v);
    if (Array.isArray(v)) return encodeArray(v.map(enc));
    throw new Error('fixture');
  };
  let CB;
  const fixture = async (overrides = {}) => {
    CB = await import('../src/filecoin/cbor.mjs');
    const weight = [0n, 0n, 0n, 0n, 0n];
    const shares = overrides.shares ?? [[id(90), 500000000000000000n], [id(163912), 500000000000000000n]];
    const payable = overrides.payable ?? [];
    const claimed = overrides.claimed ?? [[id(90), encodeBigInt(5n)], [id(163912), encodeBigInt(5n)]];
    const tombstones = overrides.tombstones ?? [];
    return CB.concat(enc([[[1n, weight, null], [2n, weight, [id(200116), shares, payable, claimed]]], tombstones, []]));
  };

  it('finds stream 2\'s share-map wallets and knows it was claimed this period', async () => {
    const s = decodeStreamsState(await fixture());
    assert.deepEqual(candidateWallets(s).map((w) => addressToString(w, 't')), ['t090', 't0163912']);
    assert.equal(claimedThisPeriod(s), true);
  });

  it('adds payable rows, deduplicates, and includes a tombstone for stream 2', async () => {
    const s = decodeStreamsState(await fixture({
      payable: [[id(163912), encodeBigInt(7n)], [id(555), encodeBigInt(9n)]],
      claimed: [],
      tombstones: [[2n, [[id(777), encodeBigInt(1n)]]], [3n, [[id(888), encodeBigInt(1n)]]]],
    }));
    assert.deepEqual(candidateWallets(s).map((w) => addressToString(w, 't')), ['t090', 't0163912', 't0555', 't0777']);
    assert.equal(claimedThisPeriod(s), false, 'empty claimed_period: nobody claimed since the last fold');
  });

  it('batches at most 64 wallets per Claim', () => {
    const wallets = Array.from({ length: 130 }, (_, i) => id(1000 + i));
    assert.deepEqual(batch(wallets).map((b) => b.length), [64, 64, 2]);
    assert.throws(() => batch(wallets, 65), /1\.\.64/);
  });
});

describe('fee guards', () => {
  const FIL = 10n ** 18n;
  const cap = 5n * 10n ** 16n; // 0.05 FIL

  it('never sends a Claim that pays nothing', () => {
    assert.deepEqual(feeVerdict({ payout: 0n, maxFee: 1n, maxFeeAtto: cap }), { send: false, reason: 'pays nothing' });
  });

  it('refuses a max fee above the cap, however large the payout', () => {
    const v = feeVerdict({ payout: 1000n * FIL, maxFee: cap + 1n, maxFeeAtto: cap });
    assert.equal(v.send, false);
    assert.match(v.reason, /above the 0\.05 FIL cap/);
  });

  it('allows exactly the cap', () => {
    assert.equal(feeVerdict({ payout: 1000n * FIL, maxFee: cap, maxFeeAtto: cap }).send, true);
  });

  it('refuses a fee above 10% of the payout, and allows exactly 10%', () => {
    assert.equal(feeVerdict({ payout: 100n, maxFee: 11n, maxFeeAtto: cap }).send, false);
    assert.match(feeVerdict({ payout: 100n, maxFee: 11n, maxFeeAtto: cap }).reason, /more than 10%/);
    assert.equal(feeVerdict({ payout: 100n, maxFee: 10n, maxFeeAtto: cap }).send, true);
  });
});
