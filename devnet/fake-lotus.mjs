/**
 * A stand-in for the native half of a Filecoin node: f02 after FIP-0118, the mpool, and the
 * few Filecoin.* methods the Claim sender calls.
 *
 * Hardhat has no f02, so the devnet cannot exercise Claim on its own. This fake does, closely
 * enough to fail the sender in the ways a real node would:
 *   - MpoolPush verifies the secp256k1 signature against From and rejects a wrong nonce;
 *   - Claim pays live + payable per wallet, records claimed_period, and returns ([amounts]);
 *     a duplicate or unknown wallet gets 0, as FIP-0118 §2.4.5 says;
 *   - fold() is what SetShares does on submitShares: live becomes payable, claimed_period clears;
 *   - the streams block is real DAG-CBOR in the §2.4.2 layout, so the sender's decoder is
 *     tested against bytes, not against a shortcut.
 *
 * Use in-process (`createFakeLotus().client`) for unit tests, or as an HTTP server
 * (`serveFakeLotus`) that answers Filecoin.* itself and forwards eth_* to the hardhat devnet,
 * which is how the devnet lifecycle drives scripts/claim.mjs end to end.
 */
import { createServer } from 'node:http';

import { parseAddress } from '../src/filecoin/address.mjs';
import { decode, encodeArray, encodeBigInt, encodeBytes, encodeUint, fromBase64, toBase64, toHex } from '../src/filecoin/cbor.mjs';
import { CLAIM_METHOD, SERVICE_STREAM } from '../src/filecoin/f02.mjs';
import { NETWORK_NAMES } from '../src/filecoin/lotus.mjs';
import { signedMessageCid, verifySignedMessage } from '../src/filecoin/message.mjs';

class RpcFail extends Error {}

export function createFakeLotus({ networkName = 'calibrationnet', prefix = 't', activated = true } = {}) {
  const f02 = `${prefix}02`;
  const wallets = new Map(); // hex(address bytes) -> { bytes, share, live, payable, claimed }
  const actors = new Map(); // address string -> { balance, nonce }
  const pending = []; // pushed, not yet applied
  const receipts = new Map(); // cid -> { Height, Receipt }
  const log = { pushed: [], calls: [] };
  const knobs = {
    gasLimit: 6_000_000,
    baseFeeCap: 100_000n, // attoFIL per gas
    premium: 99_000n,
    failStateCall: null, // exit code to return from StateCall
    failOnChain: null, // exit code a landed Claim gets
    autoApply: true, // apply a pushed message on the next StateSearchMsg
    ignoreMaxFee: false, // a node that does not honour MessageSendSpec.MaxFee
    exposeWallet: false,
  };
  let height = 1000;

  const ensure = (bytes) => {
    const k = toHex(bytes);
    if (!wallets.has(k)) wallets.set(k, { bytes, share: 0n, live: 0n, payable: 0n, claimed: 0n });
    return wallets.get(k);
  };

  const fake = {
    knobs,
    log,
    get height() {
      return height;
    },
    activated,
    setShares(map) {
      // map: [[address string, share]]; a fold first, as SetShares does
      fake.fold();
      for (const w of wallets.values()) w.share = 0n;
      for (const [a, s] of map) ensure(parseAddress(a, prefix)).share = BigInt(s);
    },
    accrue(amountPerWallet) {
      for (const w of wallets.values()) if (w.share > 0n) w.live += BigInt(amountPerWallet);
    },
    fold() {
      for (const w of wallets.values()) {
        w.payable += w.live;
        w.live = 0n;
        w.claimed = 0n;
      }
    },
    fund(address, balance) {
      actors.set(address, { balance: BigInt(balance), nonce: actors.get(address)?.nonce ?? 0 });
    },
    /** Zero one wallet's entitlement, as if someone else had just claimed for it. */
    clear(address) {
      const w = wallets.get(toHex(parseAddress(address, prefix)));
      if (w) {
        w.claimed += w.live;
        w.live = 0n;
        w.payable = 0n;
      }
    },
    /** A message from `address` sitting in the mpool that this run did not send. */
    phantomPending(address) {
      pending.push({ msg: { From: address, phantom: true }, cid: 'phantom' });
    },
    owed(address) {
      const w = wallets.get(toHex(parseAddress(address, prefix)));
      return w ? w.live + w.payable : 0n;
    },
    applyPending() {
      while (pending.length) {
        const { msg, cid } = pending.shift();
        if (msg.phantom) {
          actors.get(msg.From).nonce += 1;
          continue;
        }
        height += 1;
        const actor = actors.get(msg.From);
        actor.nonce += 1;
        const fee = BigInt(msg.GasLimit) * BigInt(msg.GasFeeCap) / 2n; // pays some of the cap
        actor.balance -= fee;
        if (knobs.failOnChain !== null) {
          receipts.set(cid, { Height: height, Receipt: { ExitCode: knobs.failOnChain, Return: null, GasUsed: 1 } });
          continue;
        }
        const amounts = claim(decode(fromBase64(msg.Params)), true);
        receipts.set(cid, { Height: height, Receipt: { ExitCode: 0, Return: claimReturn(amounts), GasUsed: knobs.gasLimit / 2 } });
      }
    },
  };

  function claim(params, commit) {
    const [id, list] = params;
    const seen = new Set();
    return list.map((bytes) => {
      const k = toHex(bytes);
      if (Number(id) !== SERVICE_STREAM || seen.has(k) || !wallets.has(k)) {
        seen.add(k);
        return 0n;
      }
      seen.add(k);
      const w = wallets.get(k);
      const amount = w.live + w.payable;
      if (commit) {
        w.claimed += w.live;
        w.live = 0n;
        w.payable = 0n;
      }
      return amount;
    });
  }

  const claimReturn = (amounts) => toBase64(encodeArray([encodeArray(amounts.map((a) => encodeBytes(encodeBigInt(a))))]));

  function streamsBlock() {
    const all = [...wallets.values()];
    const row = (w, v) => encodeArray([encodeBytes(w.bytes), encodeBytes(encodeBigInt(v))]);
    const weight = encodeArray([encodeUint(0), encodeUint(0), encodeUint(0), encodeUint(0), encodeUint(0)]);
    const dist = encodeArray([
      encodeBytes(parseAddress(`${prefix}0200116`, prefix)),
      encodeArray(all.filter((w) => w.share > 0n).map((w) => encodeArray([encodeBytes(w.bytes), encodeUint(w.share)]))),
      encodeArray(all.filter((w) => w.payable > 0n).map((w) => row(w, w.payable))),
      encodeArray(all.filter((w) => w.claimed > 0n).map((w) => row(w, w.claimed))),
    ]);
    const stream1 = encodeArray([encodeUint(1), weight, Uint8Array.of(0xf6)]);
    const stream2 = encodeArray([encodeUint(2), weight, dist]);
    return encodeArray([encodeArray([stream1, stream2]), encodeArray([]), encodeArray([])]);
  }

  const methods = {
    StateNetworkName: () => networkName,
    StateReadState: ([addr]) => {
      if (addr !== f02) throw new RpcFail(`fake: StateReadState only knows ${f02}`);
      return { State: fake.activated ? { StreamsRoot: { '/': 'bafyfakestreams' }, Accrued: [] } : { Epoch: height } };
    },
    ChainReadObj: () => toBase64(streamsBlock()),
    WalletBalance: ([addr]) => String(actors.get(addr)?.balance ?? 0n),
    StateGetActor: ([addr]) => {
      const a = actors.get(addr);
      if (!a) throw new RpcFail('actor not found');
      return { Nonce: a.nonce, Balance: String(a.balance) };
    },
    MpoolGetNonce: ([addr]) => {
      const a = actors.get(addr);
      if (!a) throw new RpcFail('actor not found');
      return a.nonce + pending.filter((p) => p.msg.From === addr).length;
    },
    StateCall: ([msg]) => {
      if (msg.To !== f02 || msg.Method !== CLAIM_METHOD) throw new RpcFail('fake: StateCall only simulates Claim');
      if (!actors.has(msg.From)) throw new RpcFail('actor not found');
      if (knobs.failStateCall !== null) return { MsgRct: { ExitCode: knobs.failStateCall, Return: null }, Error: 'fake failure' };
      return { MsgRct: { ExitCode: 0, Return: claimReturn(claim(decode(fromBase64(msg.Params)), false)) }, Error: '' };
    },
    GasEstimateMessageGas: ([msg, spec]) => {
      if (!actors.has(msg.From)) throw new RpcFail('actor not found');
      if (knobs.failStateCall !== null) throw new RpcFail(`estimating gas: exit ${knobs.failStateCall}`);
      let feeCap = knobs.baseFeeCap;
      const maxFee = BigInt(spec?.MaxFee ?? 0);
      if (!knobs.ignoreMaxFee && maxFee > 0n && feeCap * BigInt(knobs.gasLimit) > maxFee) feeCap = maxFee / BigInt(knobs.gasLimit);
      return { ...msg, GasLimit: knobs.gasLimit, GasFeeCap: String(feeCap), GasPremium: String(knobs.premium < feeCap ? knobs.premium : feeCap) };
    },
    MpoolPush: ([signed]) => {
      const { Message: msg, Signature: sig } = signed;
      if (!verifySignedMessage(msg, sig, prefix)) throw new RpcFail('fake: signature does not recover to From');
      const expected = methods.MpoolGetNonce([msg.From]);
      if (msg.Nonce !== expected) throw new RpcFail(`fake: nonce ${msg.Nonce}, expected ${expected}`);
      const cid = signedMessageCid(msg, sig, prefix).string;
      pending.push({ msg, cid });
      log.pushed.push({ msg, cid });
      return { '/': cid };
    },
    StateSearchMsg: ([, cidObj]) => {
      if (knobs.autoApply) fake.applyPending();
      return receipts.get(cidObj['/']) ?? null;
    },
  };

  async function call(method, params = []) {
    log.calls.push(method);
    const fn = methods[method];
    if (!fn) throw new Error(`fake lotus: ${method} not implemented`);
    try {
      return fn(params);
    } catch (err) {
      if (err instanceof RpcFail) {
        const e = new Error(`${method}: ${err.message}`);
        e.name = 'RpcError';
        throw e;
      }
      throw err;
    }
  }

  const client = {
    call,
    host: 'fake-lotus',
    async assertNoWalletAccess() {
      if (knobs.exposeWallet) throw new Error('the RPC endpoint at fake-lotus answered Filecoin.WalletList, so it exposes wallet methods.');
    },
    async assertNetwork(n) {
      const expected = NETWORK_NAMES[n];
      if (networkName !== expected) throw new Error(`RPC at fake-lotus is on "${networkName}", but NETWORK=${n} expects "${expected}". Nothing was sent.`);
    },
  };

  return { fake, client, methods };
}

/**
 * HTTP JSON-RPC: Filecoin.* answered by the fake, everything else forwarded to `upstream`
 * (the hardhat devnet). Returns { url, close }.
 */
export async function serveFakeLotus(fakeBundle, { upstream, port = 0 } = {}) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const send = (obj, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      let reqObj;
      try {
        reqObj = JSON.parse(body);
      } catch {
        return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400);
      }
      const { id, method, params } = reqObj;
      if (typeof method === 'string' && method.startsWith('Filecoin.')) {
        const name = method.slice('Filecoin.'.length);
        if (name === 'WalletList') {
          return fakeBundle.fake.knobs.exposeWallet
            ? send({ jsonrpc: '2.0', id, result: [] })
            : send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method '${method}' not found` } }, 500);
        }
        if (!fakeBundle.methods[name]) return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method '${method}' not found` } }, 500);
        try {
          return send({ jsonrpc: '2.0', id, result: await fakeBundle.client.call(name, params) });
        } catch (err) {
          return send({ jsonrpc: '2.0', id, error: { code: 1, message: err.message } }, 500);
        }
      }
      if (!upstream) return send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'no upstream' } }, 500);
      try {
        const r = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(await r.text());
      } catch (err) {
        send({ jsonrpc: '2.0', id, error: { code: -32000, message: `upstream: ${err.message}` } }, 502);
      }
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
