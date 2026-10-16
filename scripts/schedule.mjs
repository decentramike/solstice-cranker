#!/usr/bin/env node
/**
 * npm run schedule -- writes config/schedule.<network>.json from the chain.
 *
 * Each quarter's binding time, deadline and window for the next 8 quarters (or --quarters=N).
 * The workflows' gate step reads that file and nothing else to decide whether a run has work.
 *
 * Refuses to write -- exit 1, file untouched -- when any of these disagree:
 *   - config/networks.json against the chain: activationEpoch (quarterStart(0)) and
 *     EPOCHS_PER_QUARTER(), the two values the SRA exposes;
 *   - config/networks.json against upstream deployments.json: every geometry field and both
 *     addresses (postPeriod and verificationWindow can be checked nowhere else);
 *   - after activation, the chain's own latest bound quarter against the computed one.
 *
 * Read-only on chain. No key is loaded.
 *
 *   NETWORK=mainnet npm run schedule
 *   npm run schedule -- --network=calibnet --quarters=8 [--offline-upstream]
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NETWORKS, loadConfig } from '../src/config.mjs';
import { connect, currentEpoch, observeLatestBoundQuarter, readChainGeometry } from '../src/chain.mjs';
import { latestBoundQuarter } from '../src/schedule.mjs';
import { buildScheduleFile, scheduleMarkdown } from '../src/windows.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UPSTREAM = 'https://raw.githubusercontent.com/filecoin-project/solstice/main/deployments.json';
const CHAIN_IDS = { mainnet: 314, calibnet: 314159, devnet: 3141592 };

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const network = arg('network') ?? process.env.NETWORK ?? 'mainnet';
const count = Number(arg('quarters') ?? 8);
const out = arg('out') ?? join(ROOT, 'config', `schedule.${network}.json`);

const problems = [];
const fail = () => {
  process.stderr.write(`\nconfig/schedule.${network}.json NOT written. ${problems.length} disagreement(s):\n`);
  for (const p of problems) process.stderr.write(`  - ${p}\n`);
  process.stderr.write('\nFix config/networks.json (npm run sync:deployments) or find out why the chain differs. Do not hand-edit the schedule.\n');
  process.exit(1);
};

const config = loadConfig({ ...process.env, NETWORK: network, CRANKER_PRIVATE_KEY: '' }, { requireKey: false });
const net = NETWORKS[network];

// ---- upstream deployments.json -------------------------------------------------
let upstreamNote = 'skipped (--offline-upstream)';
if (!process.argv.includes('--offline-upstream') && network !== 'devnet') {
  const res = await fetch(UPSTREAM, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`could not fetch ${UPSTREAM}: HTTP ${res.status}`);
  const up = (await res.json())[String(CHAIN_IDS[network])];
  if (!up) problems.push(`upstream deployments.json has no entry for chain ${CHAIN_IDS[network]}`);
  else {
    for (const k of ['activationEpoch', 'epochsPerQuarter', 'postPeriod', 'verificationWindow', 'hold']) {
      if (Number(up[k]) !== Number(net[k])) problems.push(`${k}: config/networks.json ${net[k]}, upstream deployments.json ${up[k]}`);
    }
    for (const k of ['sra', 'swa']) {
      if (String(up[k]).toLowerCase() !== String(net[k]).toLowerCase()) problems.push(`${k}: config ${net[k]}, upstream ${up[k]}`);
    }
  }
  upstreamNote = UPSTREAM;
}

// ---- the chain -------------------------------------------------------------------
const { provider, sra } = await connect(config);
const head = await currentEpoch(provider);
const chainGeometry = await readChainGeometry(sra);
if (chainGeometry.activationEpoch !== BigInt(net.activationEpoch)) {
  problems.push(`activationEpoch: config ${net.activationEpoch}, chain quarterStart(0) ${chainGeometry.activationEpoch}`);
}
if (chainGeometry.epochsPerQuarter !== BigInt(net.epochsPerQuarter)) {
  problems.push(`epochsPerQuarter: config ${net.epochsPerQuarter}, chain EPOCHS_PER_QUARTER() ${chainGeometry.epochsPerQuarter}`);
}

const geometryBig = {
  activationEpoch: chainGeometry.activationEpoch,
  epochsPerQuarter: chainGeometry.epochsPerQuarter,
  postPeriod: BigInt(net.postPeriod),
  verificationWindow: BigInt(net.verificationWindow),
};
// After the first binding the chain can confirm postPeriod + verificationWindow too.
const computed = latestBoundQuarter(geometryBig, head);
let boundNote = 'no quarter bound yet; postPeriod/verificationWindow checked against upstream only';
if (computed !== null) {
  const observed = await observeLatestBoundQuarter(sra, computed);
  if (observed.quarter !== computed) problems.push(`latest bound quarter: computed ${computed}, chain ${observed.quarter ?? 'unknown'}`);
  boundNote = `latest bound quarter ${computed} confirmed with aggregatedFilecoinPayVolume()`;
}

if (problems.length) fail();

const file = buildScheduleFile({
  network,
  geometry: {
    activationEpoch: Number(chainGeometry.activationEpoch),
    epochsPerQuarter: Number(chainGeometry.epochsPerQuarter),
    postPeriod: net.postPeriod,
    verificationWindow: net.verificationWindow,
  },
  genesisUnix: net.genesisUnix,
  epochSeconds: net.epochSeconds,
  addresses: { sra: config.addresses.sra, swa: config.addresses.swa },
  headEpoch: Number(head),
  count,
  generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  sources: {
    chain: `quarterStart(0) and EPOCHS_PER_QUARTER() read from ${config.addresses.sra} at epoch ${head} (chain ${config.chainId})`,
    upstream: upstreamNote,
    boundCheck: boundNote,
  },
});

writeFileSync(out, JSON.stringify(file, null, 2) + '\n');
process.stderr.write(`wrote ${out} (as of epoch ${head})\n\n`);
process.stdout.write(scheduleMarkdown(file) + '\n');
