/**
 * Classification of errors as the provider ACTUALLY throws them.
 *
 * Every shape here comes from test/fixtures/provider-errors.json, which
 * test/fixtures/capture-provider-errors.mjs records by calling quarterlyGateCheck() through
 * ethers v6: once against Lotus on calibnet, and once each against local stubs that fail the
 * way a sick node does. Nothing in this file is a hand-written guess at an error object.
 *
 * Why it matters: on 1 Oct 2026 a healthy run went red because a real, benign revert arrived
 * with a selector the ABI did not know, and two more went red on a race at a binding boundary.
 * The cranker's judgement depends on reading these shapes correctly, so they are pinned.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AbiCoder } from 'ethers';

import { classifyRevert, extractRevertData, isTransportFailure } from '../src/errors.mjs';
import { redactRpcUrl } from '../src/config.mjs';
import { compareWithChain, isBindingRace, bindingEpoch, BINDING_RACE_MARGIN_EPOCHS } from '../src/schedule.mjs';

const FIXTURES = JSON.parse(readFileSync(new URL('./fixtures/provider-errors.json', import.meta.url), 'utf8'));
const shape = (label) => {
  const f = FIXTURES.find((o) => o.label === label);
  assert.ok(f?.threw, `fixture ${label} missing -- re-run test/fixtures/capture-provider-errors.mjs`);
  return structuredClone(f.error);
};

/** The real Lotus revert shape, carrying a different payload: what ethers gives for any revert. */
const lotusRevertWith = (data) => {
  const e = shape('lotus-notbound');
  e.data = data;
  return e;
};

const abi = AbiCoder.defaultAbiCoder();

describe('the shapes a sick node produces are transport failures, not contract faults', () => {
  for (const label of ['http-429', 'http-503']) {
    it(`${label}: SERVER_ERROR with no data -> transport (retry, never alert as a fault)`, () => {
      const e = shape(label);
      assert.equal(e.code, 'SERVER_ERROR');
      assert.equal(isTransportFailure(e), true);
    });
  }

  // All three arrive identically -- CALL_EXCEPTION, "missing revert data", data/revert/reason null.
  for (const label of ['revert-no-data', 'rpc-rate-limit-200', 'lotus-no-payload']) {
    it(`${label}: CALL_EXCEPTION with no revert information at all -> transport`, () => {
      const e = shape(label);
      assert.equal(e.code, 'CALL_EXCEPTION');
      assert.equal(e.shortMessage, 'missing revert data');
      assert.equal(e.data ?? null, null);
      assert.equal(isTransportFailure(e), true, 'no data means nothing was learned about the contract');
    });
  }
});

describe('a real revert stays a contract outcome, however Lotus wraps it', () => {
  it('Lotus-wrapped NotBound(4), as captured live on calibnet, decodes as benign', () => {
    const e = shape('lotus-notbound');
    // ethers itself calls this "unknown custom error": NotBound is an SRA error raised THROUGH
    // the SWA, so the SWA's own ABI cannot name it. The combined decoder can.
    assert.equal(e.shortMessage, 'execution reverted (unknown custom error)');
    assert.equal(isTransportFailure(e), false);
    const v = classifyRevert(e);
    assert.equal(v.name, 'NotBound');
    assert.equal(v.kind, 'benign');
    assert.equal(v.reason, 'NotBound(4)');
  });

  it('Lotus via eth_estimateGas: payload nested in info.error and in the message text, still NotBound', () => {
    const e = shape('lotus-estimategas-notbound');
    assert.match(e.info.error.message, /exit=\[33\], revert reason=\[0x3461d1f0/);
    assert.equal(isTransportFailure(e), false);
    assert.equal(classifyRevert(e).reason, 'NotBound(4)');
  });

  it('the same Lotus revert with the payload ONLY in its message text is still read, not retried', () => {
    // If ethers or a gateway ever stops hoisting the bytes into `data`, a real revert must not
    // fall into "no revert data", which now means "ask the node again".
    const e = shape('lotus-estimategas-notbound');
    delete e.data;
    delete e.info.error.data;
    assert.equal(extractRevertData(e), '0x3461d1f0' + '0'.repeat(62) + '04');
    assert.equal(isTransportFailure(e), false);
    assert.equal(classifyRevert(e).name, 'NotBound');
  });

  it('an explicit EMPTY revert (data "0x") is the contract answering -- a fault, not a retry', () => {
    // What a wrong address or a function the target lacks looks like. ethers keeps it apart
    // from a missing payload: "no data present" against "missing revert data".
    const e = shape('empty-revert');
    assert.equal(e.data, '0x');
    assert.equal(isTransportFailure(e), false);
    assert.equal(classifyRevert(e).kind, 'fault');
  });

  it('a status-0 receipt thrown by tx.wait() is the chain answering, not a sick node', () => {
    // ethers v6, providers/provider.js checkReceipt(): CALL_EXCEPTION, data/reason/revert null,
    // with the receipt attached. Not capturable without broadcasting on a live network; the
    // devnet integration suite produces the real thing.
    const e = Object.assign(new Error('transaction execution reverted'), {
      code: 'CALL_EXCEPTION', action: 'sendTransaction', data: null, reason: null, invocation: null, revert: null,
      shortMessage: 'transaction execution reverted', receipt: { status: 0, hash: '0x' + '11'.repeat(32) },
    });
    assert.equal(isTransportFailure(e), false);
  });

  it('a decoded revert with no raw data is still the contract answering, not a sick node', () => {
    const e = Object.assign(new Error('revert'), { code: 'CALL_EXCEPTION', revert: { name: 'NotBound', args: [4n] } });
    assert.equal(isTransportFailure(e), false);
  });

  it('an undecodable selector WITH data is still a fault -- that is how ABI drift is noticed', () => {
    const e = lotusRevertWith('0xdeadbeef' + '00'.repeat(32));
    assert.equal(isTransportFailure(e), false, 'data present: the contract answered');
    const v = classifyRevert(e);
    assert.equal(v.kind, 'fault');
    assert.equal(v.severity, 'critical');
    assert.equal(v.reason, '0xdeadbeef');
    assert.match(v.message, /does not match the shipped ABI/);
  });
});

describe('run 192: the gate-check guard reverts are deferrals, not failures', () => {
  // The exact failure of 1 Oct 21:15 UTC: the real Lotus revert shape, carrying 0xebb58efd --
  // PendingGateParams(bytes32) -- during the rehearsal's "SWA objection". With the ABI built
  // from the pinned 87fd57c this decoded to nothing and became a critical fault.
  const TASK = '0x' + 'ab'.repeat(32);
  const pendingGateParams = '0xebb58efd' + abi.encode(['bytes32'], [TASK]).slice(2);

  it('PendingGateParams decodes, and is a retry: exit 0, the next run tries again', () => {
    const v = classifyRevert(lotusRevertWith(pendingGateParams));
    assert.equal(v.name, 'PendingGateParams');
    assert.equal(v.kind, 'retry');
    assert.equal(v.outcome, 'not-due');
    assert.equal(v.severity, 'info');
    assert.match(v.message, /executed or vetoed/);
  });

  it('PendingWeightWrite decodes, is a retry, and says when it clears', () => {
    const data = '0x453dc930' + abi.encode(['uint64'], [4125000n]).slice(2);
    const v = classifyRevert(lotusRevertWith(data));
    assert.equal(v.name, 'PendingWeightWrite');
    assert.equal(v.kind, 'retry');
    assert.match(v.message, /until epoch 4125000/);
  });
});

describe('a one-quarter disagreement at a binding boundary is the clock moving, not config drift', () => {
  // Calibnet's real geometry.
  const g = { activationEpoch: 4109134n, epochsPerQuarter: 2880n, postPeriod: 240n, verificationWindow: 480n };

  it('reproduces 30 Sep 19:00:15: head read at 4115613, one epoch before Q2 bound, probe saw Q2', () => {
    assert.equal(bindingEpoch(g, 2), 4115614n);
    assert.equal(isBindingRace(g, 4115613n, 1, 2), true);
    const c = compareWithChain(1, 2, { geometry: g, epoch: 4115613n });
    assert.equal(c.agrees, true, 'must not raise "config is too large"');
    assert.equal(c.race, true);
  });

  it('reproduces 1 Oct 19:00:14 the same way, for Q3', () => {
    assert.equal(bindingEpoch(g, 3), 4118494n);
    assert.equal(compareWithChain(2, 3, { geometry: g, epoch: 4118493n }).agrees, true);
  });

  it('also covers the other direction -- a lagging node reporting one quarter fewer', () => {
    assert.equal(compareWithChain(2, 1, { geometry: g, epoch: 4115615n }).agrees, true);
  });

  it('still flags real drift: the same disagreement well away from any boundary', () => {
    const far = bindingEpoch(g, 2) + BINDING_RACE_MARGIN_EPOCHS + 100n;
    const c = compareWithChain(1, 2, { geometry: g, epoch: far });
    assert.equal(c.agrees, false);
    assert.equal(c.severity, 'critical');
  });

  it('still flags a disagreement of more than one quarter, even at a boundary', () => {
    assert.equal(compareWithChain(1, 3, { geometry: g, epoch: 4115613n }).agrees, false);
  });

  it('without context it behaves exactly as before', () => {
    assert.equal(compareWithChain(1, 2).agrees, false);
  });
});

describe('an RPC URL never reaches a log line or an alert', () => {
  const RPC = 'https://rpc.example.com/v1/YOUR_API_KEY_HERE?token=YOUR_API_KEY_HERE';

  it('scrubs the configured URL from an ethers SERVER_ERROR message, keeping the host', () => {
    // The shape of ethers' own message for a 503: the request URL is spelled out in full.
    const message =
      'server response 503 Service Unavailable (request={  }, response={  }, error=null, ' +
      `info={ "requestUrl": "${RPC}", "responseBody": "Service Unavailable", "responseStatus": "503" }, code=SERVER_ERROR)`;
    const out = redactRpcUrl(message, RPC);
    assert.ok(!out.includes('YOUR_API_KEY_HERE'), out);
    assert.match(out, /rpc\.example\.com/);
    assert.match(out, /503 Service Unavailable/);
  });

  it('scrubs a requestUrl even when it is not spelled exactly like the configured one', () => {
    const out = redactRpcUrl('info={ "requestUrl": "https://other.example/key/abc" }', RPC);
    assert.ok(!out.includes('/key/abc'), out);
  });

  it('passes null and undefined through, so an error with no stack stays that way', () => {
    assert.equal(redactRpcUrl(null, RPC), null);
    assert.equal(redactRpcUrl(undefined, RPC), undefined);
  });
});
