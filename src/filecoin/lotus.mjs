/**
 * A Lotus JSON-RPC client for the native (f02) side, over plain fetch.
 *
 * Three guards live here rather than in the callers:
 *
 *   1. An allowlist. Only the methods the Claim path needs can be called. Nothing here can
 *      ask a node to sign, export a key or touch a wallet, even by mistake.
 *   2. A wallet-method probe (`assertNoWalletAccess`). A node that answers `WalletList` is an
 *      authenticated or admin endpoint; the cranker signs locally and never needs one, so it
 *      refuses to talk to it at all.
 *   3. A network-name check. StateNetworkName must be `mainnet` for NETWORK=mainnet and
 *      `calibrationnet` for NETWORK=calibnet. The f02 address and the f/t prefix are the same
 *      shape on both chains, so this is the check that proves which chain a Claim goes to.
 *
 * Transport failures (connection errors, HTTP 429/5xx) are retried with backoff. An RPC
 * error object is an answer, not a transport failure, and is thrown at once.
 */
import { safeHost } from '../config.mjs';

// devnet: the local stand-in, devnet/fake-lotus.mjs. No public node reports this name.
export const NETWORK_NAMES = { mainnet: 'mainnet', calibnet: 'calibrationnet', devnet: 'devnet' };

const ALLOWED = new Set([
  'ChainHead',
  'ChainReadObj',
  'EthGetLogs',
  'GasEstimateMessageGas',
  'MpoolGetNonce',
  'MpoolPush',
  'StateCall',
  'StateGetActor',
  'StateLookupID',
  'StateNetworkName',
  'StateReadState',
  'StateSearchMsg',
  'WalletBalance',
]);

export class RpcError extends Error {
  constructor(method, error) {
    super(`${method}: ${error?.message ?? 'RPC error'}`);
    this.name = 'RpcError';
    this.method = method;
    this.code = error?.code;
  }
}

export class TransportError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'TransportError';
    this.isTransport = true;
  }
}

export function createLotusClient(rpcUrl, { attempts = 4, baseMs = 750, fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  let id = 0;
  const host = safeHost(rpcUrl);

  async function post(method, params) {
    let res;
    try {
      res = await fetchImpl(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: `Filecoin.${method}`, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // The fetch error can carry the URL; report the host only.
      throw new TransportError(`${method}: no answer from ${host} (${err?.name ?? 'error'})`, err);
    }
    // GLIF answers an RPC-level error (unknown method, a revert in StateCall) with HTTP 500 and
    // a JSON-RPC error body. That is an answer, not an outage, so read the body before deciding.
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (body?.error) throw new RpcError(method, body.error);
    if (res.status === 429 || res.status >= 500) {
      throw new TransportError(`${method}: HTTP ${res.status} from ${host}`);
    }
    if (!res.ok) throw new RpcError(method, { message: `HTTP ${res.status} from ${host}` });
    if (!body || !('result' in body)) throw new TransportError(`${method}: unreadable response from ${host}`);
    return body.result;
  }

  async function call(method, params = []) {
    if (!ALLOWED.has(method)) throw new Error(`Filecoin.${method} is not on the cranker's RPC allowlist`);
    let last;
    for (let i = 0; i < attempts; i++) {
      try {
        return await post(method, params);
      } catch (err) {
        last = err;
        if (!err.isTransport || i === attempts - 1) throw err;
        await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
      }
    }
    throw last;
  }

  /**
   * Refuses an endpoint that will run wallet methods for us. WalletList is read-only even on
   * a node that has it, so probing with it changes nothing; the answer is what matters. A
   * public endpoint rejects it (permission error) or does not know it.
   */
  async function assertNoWalletAccess() {
    try {
      await post('WalletList', []);
    } catch (err) {
      if (err instanceof RpcError) return;
      throw err;
    }
    throw new Error(
      `the RPC endpoint at ${host} answered Filecoin.WalletList, so it exposes wallet methods. ` +
        'Use a public or rate-limited endpoint; the cranker signs locally and never needs one.'
    );
  }

  async function assertNetwork(networkName) {
    const expected = NETWORK_NAMES[networkName];
    if (!expected) throw new Error(`no Filecoin network name is known for NETWORK=${networkName}`);
    const actual = await call('StateNetworkName');
    if (actual !== expected) {
      throw new Error(
        `RPC at ${host} is on "${actual}", but NETWORK=${networkName} expects "${expected}". ` +
          'RPC_URL and NETWORK disagree. Nothing was sent.'
      );
    }
    return actual;
  }

  return { call, assertNoWalletAccess, assertNetwork, host };
}
