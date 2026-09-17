#!/usr/bin/env node
/**
 * Reproduces vendor/solstice/script/Deploy.s.sol on the local devnet.
 *
 * Same recipe, same order, same constructor arguments: implementation, then an ERC1967Proxy
 * whose init calldata is initialize(). Two deviations, both deliberate:
 *
 *   1. activationEpoch is the current block rather than 0. Upstream's deployments.json uses 0
 *      because a real chain's epoch clock is already running; here the chain starts at block 0,
 *      so a 0 activation would put quarter 1's posting window at epoch 240 of a chain that has
 *      only just begun. Anchoring to now makes the deploy the activation.
 *   2. The FVM precompile is etched at 0xfe..05 before anything can reach it. Without it every
 *      path that talks to f02 -- a successful submitShares, a passing gate check -- reverts with
 *      EXIT_PRECOMPILE_FAILED, which looks exactly like a contract bug and is not one.
 *
 * Owners and the orchestrator come from the Hardhat test accounts by index, not from upstream's
 * deployments.json addresses: governance calls have to be drivable from here.
 *
 * Usage: node devnet/deploy.mjs [--precompile=success|failing|silent]
 */
import { ContractFactory } from 'ethers';

import { CHAIN_ID, RPC_URL, isMain, probe } from './node.mjs';
import {
  ACCOUNTS,
  addressOf,
  artifactOf,
  currentEpoch,
  etchPrecompile,
  provider,
  walletAt,
  writeDeployment,
} from './fixtures.mjs';

/** Quarter geometry for chainId 3141592, straight out of upstream's deployments.json. */
export const GEOMETRY = {
  epochsPerQuarter: 240,
  postPeriod: 120,
  verificationWindow: 40,
  hold: 40,
};

const INITIALIZE_SELECTOR = '0x8129fc1c'; // keccak256("initialize()")[0:4]

function parseArgs(argv) {
  const out = { precompile: 'success' };
  for (const arg of argv) {
    const m = /^--precompile=(.+)$/.exec(arg);
    if (m) out.precompile = m[1];
    else if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`);
  }
  return out;
}

async function deployFrom(name, signer, args) {
  const artifact = artifactOf(name);
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract.target;
}

/** Implementation + ERC1967Proxy(initialize()), the two-step upstream calls initializeProxy. */
async function behindProxy(implementation, signer) {
  return deployFrom('ERC1967Proxy', signer, [implementation, INITIALIZE_SELECTOR]);
}

export async function deploy({ precompile = 'success', quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(...a);

  const chain = await probe();
  if (chain === null) throw new Error(`nothing on ${RPC_URL} -- start it with "npm run devnet"`);
  if (chain !== CHAIN_ID) throw new Error(`${RPC_URL} is chainId ${chain}, expected ${CHAIN_ID}`);

  const deployer = walletAt(ACCOUNTS.deployer);

  // Etch before deploying: initialize() itself never reaches f02, but nothing downstream has to
  // remember that, and a half-etched devnet is a confusing thing to hand someone.
  const etched = await etchPrecompile(precompile);
  log(`[deploy] precompile ${etched.address} <- ${etched.name} (${etched.bytes} bytes, "${precompile}")`);

  // Read the clock before the implementation's constructor bakes it in. +1 because that
  // constructor runs in the *next* block, so this is the epoch the SRA is born in -- and on a
  // chain that has only just started it is never 0, which an activation epoch must never be:
  // ACTIVATION_EPOCH == 0 makes _quarterOf treat the whole of history as quarter 0.
  const activationEpoch = (await currentEpoch()) + 1;
  log(`[deploy] activationEpoch = ${activationEpoch} (the epoch the SRA implementation lands in)`);

  const sraArgs = [
    addressOf(ACCOUNTS.sraOwner1),
    addressOf(ACCOUNTS.sraOwner2),
    addressOf(ACCOUNTS.orchestrator),
    addressOf(ACCOUNTS.orchestrator),
    GEOMETRY.epochsPerQuarter,
    GEOMETRY.postPeriod,
    GEOMETRY.verificationWindow,
    activationEpoch,
    GEOMETRY.hold,
  ];
  const sraImpl = await deployFrom('ServiceRewardsActor', deployer, sraArgs);
  log(`[deploy] ServiceRewardsActor impl  ${sraImpl}`);
  const sra = await behindProxy(sraImpl, deployer);
  log(`[deploy] ServiceRewardsActor proxy ${sra}`);

  const swaImpl = await deployFrom('StreamWeightActor', deployer, [
    addressOf(ACCOUNTS.swaOwner1),
    addressOf(ACCOUNTS.swaOwner2),
    GEOMETRY.hold,
    sra,
  ]);
  log(`[deploy] StreamWeightActor impl    ${swaImpl}`);
  const swa = await behindProxy(swaImpl, deployer);
  log(`[deploy] StreamWeightActor proxy   ${swa}`);

  const deployedAtBlock = await currentEpoch();

  const record = {
    chainId: CHAIN_ID,
    sra,
    swa,
    sraImplementation: sraImpl,
    swaImplementation: swaImpl,
    activationEpoch,
    epochsPerQuarter: GEOMETRY.epochsPerQuarter,
    postPeriod: GEOMETRY.postPeriod,
    verificationWindow: GEOMETRY.verificationWindow,
    hold: GEOMETRY.hold,
    deployedAtBlock,
    precompile: { address: etched.address, variant: precompile, mock: etched.name },
    accounts: {
      deployer: addressOf(ACCOUNTS.deployer),
      cranker: addressOf(ACCOUNTS.cranker),
      orchestrator: addressOf(ACCOUNTS.orchestrator),
    },
    accountIndexes: { ...ACCOUNTS },
    deployedAt: new Date().toISOString(),
  };
  writeDeployment(record);

  await verify(record, log);
  return record;
}

/**
 * Reads the geometry back off the chain rather than trusting what we passed in. A mismatch here
 * means the deployed bytecode is not the contract we think it is, and every downstream schedule
 * would be quietly wrong -- so it throws instead of warning.
 */
export async function verify(record, log = console.log) {
  const { Contract } = await import('ethers');
  const c = new Contract(record.sra, artifactOf('ServiceRewardsActor').abi, provider());

  const problems = [];

  const qs0 = Number(await c.quarterStart(0));
  if (qs0 !== record.activationEpoch) {
    problems.push(`quarterStart(0) = ${qs0}, expected activationEpoch ${record.activationEpoch}`);
  }

  const epq = Number(await c.EPOCHS_PER_QUARTER());
  if (epq !== record.epochsPerQuarter) {
    problems.push(`EPOCHS_PER_QUARTER() = ${epq}, expected ${record.epochsPerQuarter}`);
  }

  // A proxy that answers but was never initialized would leave the orchestrator unseated and
  // every postVolume reverting NotAdmitted -- a failure that shows up 200 blocks later.
  const seated = await c.isAdmitted(record.accounts.orchestrator);
  if (!seated) problems.push(`initial orchestrator ${record.accounts.orchestrator} is not admitted`);

  const qs1 = Number(await c.quarterStart(1));
  if (qs1 !== record.activationEpoch + record.epochsPerQuarter) {
    problems.push(`quarterStart(1) = ${qs1}, expected ${record.activationEpoch + record.epochsPerQuarter}`);
  }

  if (problems.length) {
    throw new Error(`post-deploy verification failed:\n  - ${problems.join('\n  - ')}`);
  }

  log(
    `[deploy] verified: quarterStart(0)=${qs0}, quarterStart(1)=${qs1}, ` +
      `EPOCHS_PER_QUARTER=${epq}, orchestrator seated`
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const record = await deploy(args);
  console.log(`\n[deploy] wrote devnet/.deployed.json`);
  console.log(`  SRA ${record.sra}`);
  console.log(`  SWA ${record.swa}`);
  console.log(`  quarter 1 posting window opens at epoch ${record.activationEpoch + record.epochsPerQuarter}`);
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[deploy] ${err.message}`);
    process.exit(1);
  });
}
