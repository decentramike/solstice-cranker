/**
 * src/errors.mjs -- revert decoding and classification.
 *
 * Every revert here is built by ABI-encoding the real selector from abi/selectors.json, not by
 * asserting on a string. The selectors themselves are cross-checked against ethers' own
 * keccak of the signature, so a wrong entry in selectors.json fails here rather than in
 * production.
 *
 * The one assertion that matters more than the rest: NotLatestQuarter must come out
 * critical / missed-window. That revert means a quarter's share map is already gone.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Interface, id as keccakId } from 'ethers';

import {
  BENIGN_REVERTS,
  CLASSIFICATION,
  classifyRevert,
  extractRevertData,
  isTransportFailure,
} from '../src/errors.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SELECTORS = JSON.parse(readFileSync(join(ROOT, 'abi', 'selectors.json'), 'utf8'));

/** name -> { selector, signature, types } for every error the upstream contracts declare. */
const ERRORS = new Map();
for (const [selector, signature] of Object.entries(SELECTORS.errors)) {
  const name = signature.slice(0, signature.indexOf('('));
  const inner = signature.slice(signature.indexOf('(') + 1, -1);
  const types = inner === '' ? [] : inner.split(',');
  ERRORS.set(name, { selector, signature, types });
}

const IFACE = new Interface([...ERRORS.values()].map((e) => `error ${e.signature}`));

const SAMPLE = {
  uint64: 7n,
  int256: -13n,
  address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', // devnet account index 1
  bytes32: '0x' + 'ab'.repeat(32),
};

function sampleArgs(types) {
  return types.map((t) => {
    if (!(t in SAMPLE)) throw new Error(`no sample value for ABI type "${t}"`);
    return SAMPLE[t];
  });
}

/** The exact bytes an SRA/SWA revert puts on the wire. */
function encodeError(name) {
  const e = ERRORS.get(name);
  assert.ok(e, `abi/selectors.json has no error named ${name}`);
  return IFACE.encodeErrorResult(name, sampleArgs(e.types));
}

/**
 * The error shapes a provider actually hands us.
 *
 * ethers normalises most reverts into `err.revert`, but a Lotus node behind Glif nests the
 * payload differently depending on whether it came from eth_call, eth_estimateGas or a
 * receipt, so the decoder has to cope with all of them.
 */
function wrapperShapes(data, name, args) {
  const shapes = [
    ['{data}', { data }],
    ['{info:{error:{data}}}', { info: { error: { data } } }],
    ['{error:{data}}', { error: { data } }],
    ['{cause:{data}}', { code: 'CALL_EXCEPTION', cause: { data } }],
    [
      'ethers CallException',
      { code: 'CALL_EXCEPTION', action: 'call', data, reason: null, shortMessage: 'execution reverted' },
    ],
    [
      'ethers {revert:{name,args}}',
      { code: 'CALL_EXCEPTION', revert: { name, args, signature: `${name}(...)` }, data },
    ],
    // The decoded-revert path with no raw bytes at all: ethers can hand this back from a
    // contract call where it already consumed the data.
    ['{revert} only', { revert: { name, args } }],
  ];
  return shapes;
}

describe('abi/selectors.json', () => {
  it('every selector is the real keccak of its signature', () => {
    for (const [selector, signature] of Object.entries(SELECTORS.errors)) {
      assert.equal(keccakId(signature).slice(0, 10), selector, signature);
    }
  });

  it('carries the upstream commit the ABIs were generated from', () => {
    assert.match(SELECTORS.generatedFrom.ref, /^[0-9a-f]{40}$/);
    assert.match(SELECTORS.generatedFrom.repo, /solstice/);
  });

  it('declares every error the classification table names', () => {
    for (const name of Object.keys(CLASSIFICATION)) {
      assert.ok(ERRORS.has(name), `CLASSIFICATION has ${name} but abi/selectors.json does not`);
    }
  });
});

describe('classifyRevert over the whole CLASSIFICATION table', () => {
  for (const [name, rule] of Object.entries(CLASSIFICATION)) {
    const e = ERRORS.get(name);
    const args = sampleArgs(e.types);
    const data = encodeError(name);

    for (const [shapeName, err] of wrapperShapes(data, name, args)) {
      it(`${name} via ${shapeName} -> ${rule.kind}/${rule.outcome}/${rule.severity}`, () => {
        const v = classifyRevert(err);
        assert.equal(v.name, name);
        assert.equal(v.kind, rule.kind);
        assert.equal(v.outcome, rule.outcome);
        assert.equal(v.severity, rule.severity);
        assert.deepEqual(v.args, args.map(String));
        assert.equal(v.reason, args.length ? `${name}(${args.map(String).join(',')})` : `${name}()`);
        assert.equal(typeof v.message, 'string');
        assert.ok(v.message.length > 0);
      });
    }
  }
});

describe('NotLatestQuarter -- the revert that means a quarter is gone', () => {
  const data = encodeError('NotLatestQuarter');

  it('is critical / missed-window in every provider shape', () => {
    for (const [shapeName, err] of wrapperShapes(data, 'NotLatestQuarter', [7n])) {
      const v = classifyRevert(err);
      assert.equal(v.name, 'NotLatestQuarter', shapeName);
      assert.equal(v.kind, 'critical', `${shapeName}: kind must be critical`);
      assert.equal(v.outcome, 'missed-window', `${shapeName}: outcome must be missed-window`);
      assert.equal(v.severity, 'critical', `${shapeName}: severity must be critical`);
    }
  });

  it('is never in the benign set', () => {
    assert.equal(BENIGN_REVERTS.includes('NotLatestQuarter'), false);
  });

  it('exits 1 and says the loss is permanent', () => {
    const v = classifyRevert({ data });
    // crank.mjs maps kind critical|fault -> decision "failed", and any failed action -> exit 1.
    assert.ok(v.kind === 'critical' || v.kind === 'fault');
    assert.match(v.message, /permanently lost/);
    assert.match(v.message, /cannot be recovered/);
    // crank.mjs keys its loudest alert off this exact outcome string.
    assert.equal(v.outcome, 'missed-window');
  });

  it('decodes the quarter number so the alert can name it', () => {
    const v = classifyRevert({ data: IFACE.encodeErrorResult('NotLatestQuarter', [41n]) });
    assert.deepEqual(v.args, ['41']);
    assert.match(v.message, /quarter 41/);
  });
});

describe('expected reverts are non-failing', () => {
  for (const name of ['NotBound', 'AlreadySubmitted', 'StepsComplete', 'HoldUntil']) {
    it(`${name} does not fail the run`, () => {
      const v = classifyRevert({ data: encodeError(name) });
      assert.ok(['benign', 'retry'].includes(v.kind), `${name} classified ${v.kind}`);
      assert.notEqual(v.severity, 'critical');
      // crank.mjs: decision = (kind === 'critical' || kind === 'fault') ? 'failed' : 'skipped'
      const decision = v.kind === 'critical' || v.kind === 'fault' ? 'failed' : 'skipped';
      assert.equal(decision, 'skipped', `${name} would exit 1`);
      assert.ok(BENIGN_REVERTS.includes(name), `${name} missing from BENIGN_REVERTS`);
    });
  }

  it('BENIGN_REVERTS lists exactly the benign and retry rules', () => {
    const expected = Object.entries(CLASSIFICATION)
      .filter(([, v]) => v.kind === 'benign' || v.kind === 'retry')
      .map(([k]) => k);
    assert.deepEqual([...BENIGN_REVERTS].sort(), [...expected].sort());
  });
});

describe('unknown reverts fail loudly', () => {
  it('an unrecognised selector is a fault, not a silent pass', () => {
    const v = classifyRevert({ data: '0xdeadbeef' + '00'.repeat(32) });
    assert.equal(v.name, null);
    assert.equal(v.kind, 'fault');
    assert.equal(v.outcome, 'error');
    assert.equal(v.severity, 'critical');
    assert.notEqual(v.kind, 'benign');
  });

  it('a real upstream error with no classification rule is a fault', () => {
    // NotInPostingWindow is declared by the SRA but the cranker never expects to see it.
    const v = classifyRevert({ data: encodeError('NotInPostingWindow') });
    assert.equal(v.name, 'NotInPostingWindow');
    assert.equal(v.kind, 'fault');
    assert.equal(v.severity, 'critical');
  });

  it('a plain Error(string) revert is a fault and keeps the reason', () => {
    const v = classifyRevert({ reason: 'ONLY_OWNER', shortMessage: 'execution reverted: ONLY_OWNER' });
    assert.equal(v.name, 'Error');
    assert.equal(v.kind, 'fault');
    assert.equal(v.reason, 'ONLY_OWNER');
    assert.match(v.message, /ONLY_OWNER/);
  });

  it('a bare error with nothing decodable is still a fault', () => {
    const v = classifyRevert(new Error('something went sideways'));
    assert.equal(v.name, null);
    assert.equal(v.kind, 'fault');
    assert.equal(v.message, 'something went sideways');
  });
});

describe('extractRevertData', () => {
  const data = encodeError('NotBound');

  it('finds the payload at every nesting the providers use', () => {
    for (const [shapeName, err] of wrapperShapes(data, 'NotBound', [7n])) {
      if (shapeName === '{revert} only') continue; // no raw bytes by construction
      assert.equal(extractRevertData(err), data, shapeName);
    }
    assert.equal(extractRevertData({ body: { error: { data } } }), data);
    assert.equal(extractRevertData({ info: { error: { returnData: data } } }), data);
  });

  it('ignores 0x and other too-short values', () => {
    assert.equal(extractRevertData({ data: '0x' }), null);
    assert.equal(extractRevertData({ data: '0x1234' }), null);
    assert.equal(extractRevertData({ data: 'not hex at all' }), null);
    assert.equal(extractRevertData({}), null);
    assert.equal(extractRevertData(null), null);
    assert.equal(extractRevertData('a string'), null);
  });

  it('terminates on a cyclic error object', () => {
    const err = { code: 'CALL_EXCEPTION' };
    err.cause = err;
    err.info = { error: err };
    assert.equal(extractRevertData(err), null);
    assert.equal(classifyRevert(err).kind, 'fault');
  });
});

describe('isTransportFailure', () => {
  it('is true for the node being unreachable or slow', () => {
    for (const code of ['NETWORK_ERROR', 'TIMEOUT', 'SERVER_ERROR', 'UNKNOWN_ERROR']) {
      assert.equal(isTransportFailure({ code, message: 'boom' }), true, code);
    }
  });

  it('is false for a revert, however it is wrapped', () => {
    const data = encodeError('NotBound');
    assert.equal(isTransportFailure({ code: 'CALL_EXCEPTION', data }), false);
    assert.equal(isTransportFailure({ code: 'SERVER_ERROR', info: { error: { data } } }), false);
    assert.equal(isTransportFailure({ code: 'CALL_EXCEPTION', revert: { name: 'NotBound', args: [7n] } }), false);
  });

  it('is false for errors that are neither', () => {
    assert.equal(isTransportFailure({ code: 'INVALID_ARGUMENT' }), false);
    assert.equal(isTransportFailure(new Error('plain')), false);
    assert.equal(isTransportFailure(null), false);
    assert.equal(isTransportFailure(undefined), false);
  });

  it('a transport failure classifies as a fault, never as not-due', () => {
    // A dropped RPC must not read as "nothing to crank".
    const v = classifyRevert({ code: 'NETWORK_ERROR', message: 'connection reset' });
    assert.equal(v.kind, 'fault');
    assert.equal(v.outcome, 'error');
    assert.notEqual(v.outcome, 'not-due');
  });
});

describe('the classification table itself', () => {
  it('uses only the kinds, outcomes and severities the data contract allows', () => {
    // docs/DATA-CONTRACT.md fixes these vocabularies; the dashboard switches on them.
    const kinds = new Set(['benign', 'retry', 'critical', 'fault']);
    const outcomes = new Set(['landed', 'not-due', 'already-done', 'gate-closed', 'missed-window', 'error']);
    const severities = new Set(['info', 'warn', 'critical']);

    for (const [name, rule] of Object.entries(CLASSIFICATION)) {
      assert.ok(kinds.has(rule.kind), `${name} kind=${rule.kind}`);
      assert.ok(outcomes.has(rule.outcome), `${name} outcome=${rule.outcome}`);
      assert.ok(severities.has(rule.severity), `${name} severity=${rule.severity}`);
      assert.equal(typeof rule.explain, 'function', name);
    }
  });

  it('no benign or retry rule is severity critical', () => {
    for (const [name, rule] of Object.entries(CLASSIFICATION)) {
      if (rule.kind === 'benign' || rule.kind === 'retry') {
        assert.notEqual(rule.severity, 'critical', name);
      }
    }
  });

  it('explain never throws on the arity the ABI declares', () => {
    for (const name of Object.keys(CLASSIFICATION)) {
      const args = sampleArgs(ERRORS.get(name).types).map(String);
      assert.doesNotThrow(() => CLASSIFICATION[name].explain(args), name);
    }
  });
});
