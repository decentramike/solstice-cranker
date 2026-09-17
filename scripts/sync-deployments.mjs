#!/usr/bin/env node
/**
 * Pulls contract addresses and quarter geometry from the upstream solstice repo.
 *
 * `deployments.json` in filecoin-project/solstice is the source of truth for both. As of
 * writing, `sra` and `swa` are still the zero address on calibnet (314159) and mainnet
 * (314) -- the contracts are not deployed yet. Re-run this the moment they are, and the
 * cranker is live without a code change.
 *
 * Read-only against the network; the only thing it writes is config/networks.json, and it
 * prints a diff and asks for --write before doing so.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'config', 'networks.json');
const SOURCE = 'https://raw.githubusercontent.com/filecoin-project/solstice/main/deployments.json';

const ZERO = '0x0000000000000000000000000000000000000000';
const BY_CHAIN_ID = { 314: 'mainnet', 314159: 'calibnet', 3141592: 'devnet' };
const GEOMETRY = ['epochsPerQuarter', 'postPeriod', 'verificationWindow', 'activationEpoch', 'hold'];

const write = process.argv.includes('--write');

const res = await fetch(SOURCE, { signal: AbortSignal.timeout(20_000) });
if (!res.ok) throw new Error(`could not fetch ${SOURCE}: HTTP ${res.status}`);
const upstream = await res.json();

const local = JSON.parse(readFileSync(TARGET, 'utf8'));
const changes = [];

for (const [chainId, up] of Object.entries(upstream)) {
  const name = BY_CHAIN_ID[Number(chainId)];
  if (!name || !local[name]) continue;

  // The devnet's addresses are written by our own deploy script each run; upstream's
  // placeholder would only overwrite them with zeros.
  const fields = name === 'devnet' ? GEOMETRY : ['sra', 'swa', ...GEOMETRY];

  for (const field of fields) {
    if (up[field] === undefined) continue;
    const before = local[name][field];
    const after = up[field];
    if (String(before).toLowerCase() === String(after).toLowerCase()) continue;

    changes.push({ network: name, field, before, after });
    local[name][field] = after;
  }
}

if (changes.length === 0) {
  process.stdout.write('config/networks.json already matches upstream deployments.json\n');
  process.exit(0);
}

process.stdout.write(`\n${changes.length} difference(s) against upstream:\n\n`);
for (const c of changes) {
  const note = c.field === 'sra' || c.field === 'swa'
    ? c.after === ZERO ? '  (still undeployed upstream)' : '  <- DEPLOYED'
    : '';
  process.stdout.write(`  ${c.network}.${c.field}\n    - ${c.before}\n    + ${c.after}${note}\n`);
}

const nowLive = changes.filter((c) => (c.field === 'sra' || c.field === 'swa') && c.after !== ZERO);
if (nowLive.length) {
  process.stdout.write(
    '\nContracts have been deployed. After writing:\n' +
      '  1. npm run preflight        confirm the ABI and schedule match the deployment\n' +
      '  2. npm run crank:dry        simulate a full run without broadcasting\n' +
      '  3. trigger Solstice Crank from the Actions tab with dry_run enabled, then without\n'
  );
}

if (!write) {
  process.stdout.write('\nNothing written. Re-run with --write to apply.\n');
  process.exit(0);
}

writeFileSync(TARGET, JSON.stringify(local, null, 2) + '\n');
process.stdout.write(`\nwrote ${TARGET}\n`);
