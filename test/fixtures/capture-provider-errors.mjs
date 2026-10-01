// Captures the REAL shapes ethers v6 throws, so the tests encode observed errors, not guesses.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { Contract, JsonRpcProvider } from 'ethers';

const swaAbi = JSON.parse(readFileSync('abi/StreamWeightActor.json', 'utf8'));
const SWA = '0x66C11A9F6dfEC3c1557958cF9f575a023EB01421';
const FROM = '0x170356558bd57623d3dF9877319014ec9de6E263';

// Keep only plain data: drop functions, cycles, and anything URL-shaped (no RPC URL may leak).
function serialise(err) {
  const seen = new WeakSet();
  return JSON.parse(JSON.stringify(err, (k, v) => {
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'function') return undefined;
    if (v && typeof v === 'object') { if (seen.has(v)) return undefined; seen.add(v); }
    if (k === 'url' || k === 'request' || k === 'response' || k === 'payload') return undefined;
    // An RPC URL can carry a key in its path or query; never let one into a committed fixture.
    if (typeof v === 'string') return v.replace(/https?:\/\/[^\s"')]+/g, '<url>');
    return v;
  }));
}

async function capture(label, provider, how = 'staticCall') {
  const swa = new Contract(SWA, swaAbi, provider);
  try { await swa.quarterlyGateCheck[how]({ from: FROM }); return { label, threw: false }; }
  catch (err) { return { label, threw: true, error: serialise(err) }; }
}

function stub(handler) {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      let body = ''; req.on('data', (c) => (body += c));
      req.on('end', () => handler(JSON.parse(body), res));
    });
    s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }));
  });
}
const rpcOk = (id, result) => JSON.stringify({ jsonrpc: '2.0', id, result });

const out = [];
const opts = { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 };

// 1. The real thing: Lotus on calibnet, reverting NotBound(4) right now -- through eth_call, and
// through eth_estimateGas, where Lotus nests the payload and writes it into its message as well.
const glif = new JsonRpcProvider('https://api.calibration.node.glif.io/rpc/v1', 314159, opts);
out.push(await capture('lotus-notbound', glif));
out.push(await capture('lotus-estimategas-notbound', glif, 'estimateGas'));

// 2-8. Stubs that answer eth_chainId normally and fail eth_call the way a sick node does.
for (const [label, fail] of [
  ['http-429', (req, res) => { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32005, message: 'rate limit exceeded' } })); }],
  ['http-503', (req, res) => { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('Service Unavailable'); }],
  // An explicit EMPTY revert -- what calling a function the target does not have looks like.
  ['empty-revert', (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: 3, message: 'execution reverted', data: '0x' } })); }],
  ['revert-no-data', (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: 3, message: 'execution reverted' } })); }],
  // A rate limit some providers return as a JSON-RPC error inside an HTTP 200, not as a 429.
  ['rpc-rate-limit-200', (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32005, message: 'rate limit exceeded, please retry later' } })); }],
  // Lotus failing a call for a non-revert reason: same JSON-RPC code as a real revert (1), but an
  // exit code other than 33 and no revert data to decode.
  ['lotus-no-payload', (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: 1, message: 'message execution failed (exit=[7], vm error=[out of gas])' } })); }],
]) {
  const { s, url } = await stub((req, res) => {
    if (req.method === 'eth_chainId') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(rpcOk(req.id, '0x4cb2f')); }
    return fail(req, res);
  });
  // ethers retries 429 internally; cap the slot so the capture does not stall.
  const p = new JsonRpcProvider(url, 314159, opts);
  out.push(await capture(label, p));
  s.close();
}
writeFileSync('test/fixtures/provider-errors.json', JSON.stringify(out, null, 2) + '\n');
for (const o of out) console.log(o.label.padEnd(15), o.threw ? `code=${o.error.code}  short="${o.error.shortMessage}"  data=${o.error.data ?? o.error?.info?.error?.data ?? 'null'}`.slice(0, 150) : 'did not throw');
