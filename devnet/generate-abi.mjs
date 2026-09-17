#!/usr/bin/env node
/**
 * Extracts the ABI fragments the cranker needs from the compiled upstream artifacts
 * and writes them to abi/ as committed, reviewable JSON.
 *
 * Why commit generated ABIs: the production cranker must run from `npm ci --omit=dev`
 * on a GitHub runner with no Solidity toolchain, no vendored sources and no network
 * access beyond the RPC. Regenerate with `npm run contracts:build && npm run abi:generate`
 * and diff the result -- a change here means the contract interface moved.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { id as keccakId } from 'ethers';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ART = join(HERE, 'artifacts', 'contracts');

const TARGETS = [
  { name: 'ServiceRewardsActor', path: 'solstice/ServiceRewardsActor.sol/ServiceRewardsActor.json' },
  { name: 'StreamWeightActor', path: 'solstice/StreamWeightActor.sol/StreamWeightActor.json' },
];

const upstream = JSON.parse(readFileSync(join(HERE, 'contracts', 'UPSTREAM.json'), 'utf8'));

function canonicalType(input) {
  if (input.type.startsWith('tuple')) {
    const inner = input.components.map(canonicalType).join(',');
    return `(${inner})${input.type.slice('tuple'.length)}`;
  }
  return input.type;
}

function signatureOf(frag) {
  return `${frag.name}(${(frag.inputs ?? []).map(canonicalType).join(',')})`;
}

const selectors = { errors: {}, functions: {}, events: {} };
const summary = [];

for (const target of TARGETS) {
  const file = join(ART, target.path);
  if (!existsSync(file)) throw new Error(`missing artifact: ${file} -- run "npm run contracts:build" first`);
  const artifact = JSON.parse(readFileSync(file, 'utf8'));
  const abi = artifact.abi;

  writeFileSync(join(ROOT, 'abi', `${target.name}.json`), JSON.stringify(abi, null, 2) + '\n');

  let errs = 0, fns = 0, evs = 0;
  for (const frag of abi) {
    const sig = frag.name ? signatureOf(frag) : null;
    if (!sig) continue;
    if (frag.type === 'error') { selectors.errors[keccakId(sig).slice(0, 10)] = sig; errs++; }
    if (frag.type === 'function') { selectors.functions[keccakId(sig).slice(0, 10)] = sig; fns++; }
    if (frag.type === 'event') { selectors.events[keccakId(sig)] = sig; evs++; }
  }
  summary.push(`${target.name}: ${fns} functions, ${errs} errors, ${evs} events`);
}

// The FVM precompile mock's log topic, so the devnet dashboard can decode f02 traffic.
selectors.events[keccakId('FvmActorCall(bytes)')] = 'FvmActorCall(bytes)';

writeFileSync(
  join(ROOT, 'abi', 'selectors.json'),
  JSON.stringify({ generatedFrom: upstream, ...selectors }, null, 2) + '\n'
);

console.log(summary.join('\n'));
console.log(`upstream ref: ${upstream.ref}`);
