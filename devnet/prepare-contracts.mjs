#!/usr/bin/env node
/**
 * Vendors the real Solstice contract sources into devnet/contracts/ so the local
 * devnet runs the same bytecode the rehearsal will.
 *
 * Nothing here is committed: vendor/ and devnet/contracts/ are gitignored, and the
 * upstream sources keep their own licence in their own repo. This script reproduces
 * the tree from a pinned upstream ref.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const VENDOR = join(ROOT, 'vendor', 'solstice');
const OUT = join(HERE, 'contracts');

const UPSTREAM = 'https://github.com/filecoin-project/solstice.git';

// Pinning matters for CI: the ABI-drift job compares the committed abi/ against a fresh
// build, and following upstream's moving default branch would make that job fail on any
// unrelated upstream commit. Set SOLSTICE_REF to track a different ref, or 'main' to
// deliberately check for interface drift.
const REF = process.env.SOLSTICE_REF ?? '87fd57cda91f24dc3db3fd5695f4d4939befa452';

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

if (!existsSync(join(VENDOR, 'src', 'ServiceRewardsActor.sol'))) {
  console.log(`[prepare] cloning ${UPSTREAM} -> vendor/solstice`);
  mkdirSync(join(ROOT, 'vendor'), { recursive: true });
  rmSync(VENDOR, { recursive: true, force: true });
  sh('git', ['clone', '--quiet', '--recurse-submodules', '--shallow-submodules', UPSTREAM, VENDOR]);
  sh('git', ['checkout', '--quiet', REF], VENDOR);
  sh('git', ['submodule', 'update', '--init', '--recursive', '--depth', '1'], VENDOR);
} else {
  console.log('[prepare] using existing vendor/solstice');
}

const ref = sh('git', ['rev-parse', 'HEAD'], VENDOR);
if (REF !== 'main' && !ref.startsWith(REF) && REF !== ref) {
  console.warn(
    `[prepare] WARNING: vendor/solstice is at ${ref.slice(0, 12)} but SOLSTICE_REF pins ` +
      `${REF.slice(0, 12)}. Delete vendor/solstice and re-run to get the pinned tree.`
  );
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// The contracts under test, verbatim from upstream.
cpSync(join(VENDOR, 'src'), join(OUT, 'solstice'), { recursive: true });

// Devnet-only mocks (ours, committed) staged alongside them.
cpSync(join(HERE, 'mocks'), join(OUT, 'mocks'), { recursive: true });

// fvm-solidity is imported as a bare specifier ("fvm-solidity/FVMActor.sol"), which
// Hardhat resolves out of node_modules. Materialise it there as a local package.
const FVM_PKG = join(ROOT, 'node_modules', 'fvm-solidity');
rmSync(FVM_PKG, { recursive: true, force: true });
mkdirSync(FVM_PKG, { recursive: true });
cpSync(join(VENDOR, 'lib', 'fvm-solidity', 'src'), FVM_PKG, { recursive: true });
writeFileSync(
  join(FVM_PKG, 'package.json'),
  JSON.stringify({ name: 'fvm-solidity', version: '0.0.0-vendored', private: true }, null, 2) + '\n'
);

writeFileSync(
  join(OUT, 'UPSTREAM.json'),
  JSON.stringify({ repo: UPSTREAM, ref, vendoredAt: new Date().toISOString() }, null, 2) + '\n'
);

console.log(`[prepare] solstice src vendored at ${ref.slice(0, 12)}`);
console.log(`[prepare] fvm-solidity materialised at node_modules/fvm-solidity`);
