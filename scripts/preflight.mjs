#!/usr/bin/env node
/**
 * Preflight: everything that can be checked without sending a transaction.
 *
 * Run this after configuring secrets and before trusting the schedule -- on a new
 * deployment, after an RPC change, and as the first thing to reach for when a run fails.
 * It sends nothing and costs nothing.
 */
import { loadConfig, describeConfig, resolvePause, ZERO_ADDRESS } from '../src/config.mjs';
import {
  connect, currentEpoch, hasCode, observeLatestBoundQuarter,
  readBalance, readChainGeometry, readSraQuarterState, readSwaGateState,
} from '../src/chain.mjs';
import { buildSchedule, compareWithChain, epochsToDuration } from '../src/schedule.mjs';
import { log } from '../src/logger.mjs';

const checks = [];
const record = (name, ok, detail, fatal = true) => {
  checks.push({ name, ok, detail, fatal });
  const mark = ok ? 'pass' : fatal ? 'FAIL' : 'warn';
  process.stdout.write(`  [${mark}] ${name}${detail ? ` -- ${detail}` : ''}\n`);
  return ok;
};

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stdout.write(`  [FAIL] configuration\n         ${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  log.section('Preflight');
  process.stdout.write(`\nConfiguration\n`);
  for (const [k, v] of Object.entries(describeConfig(config))) {
    process.stdout.write(`  ${k.padEnd(16)} ${v}\n`);
  }

  process.stdout.write('\nChecks\n');

  record('NETWORK is known', true, `${config.networkName} (chain ${config.chainId})`);
  record(
    'CRANKER_PRIVATE_KEY is well-formed',
    true,
    'present and correctly shaped (the value is never printed)'
  );

  if (config.addresses.sra === ZERO_ADDRESS || config.addresses.swa === ZERO_ADDRESS) {
    record(
      'contract addresses configured',
      false,
      'SRA and/or SWA is the zero address. The Solstice contracts are not deployed on this ' +
        'network yet (filecoin-project/solstice#51). Run `npm run sync:deployments` once they are.',
      false
    );
    process.stdout.write('\nStopping here: there is nothing to talk to yet.\n');
    process.exitCode = 0;
    return;
  }
  record('contract addresses configured', true, `SRA ${config.addresses.sra}  SWA ${config.addresses.swa}`);

  let connection;
  try {
    connection = await connect(config);
  } catch (err) {
    record('RPC reachable and on the expected chain', false, err.message);
    process.exitCode = 1;
    return;
  }
  const { provider, sra, swa, address } = connection;
  record('RPC reachable and on the expected chain', true, `chain ${config.chainId}`);

  const epoch = await currentEpoch(provider);
  record('chain head readable', true, `epoch ${epoch}`);

  const [sraCode, swaCode] = await Promise.all([
    hasCode(provider, config.addresses.sra),
    hasCode(provider, config.addresses.swa),
  ]);
  record('SRA has contract code', sraCode, sraCode ? null : `nothing deployed at ${config.addresses.sra}`);
  record('SWA has contract code', swaCode, swaCode ? null : `nothing deployed at ${config.addresses.swa}`);
  if (!sraCode || !swaCode) {
    process.exitCode = 1;
    return;
  }

  // Calling a known view through the shipped ABI proves the selectors match the deployment.
  let geometry;
  try {
    geometry = await readChainGeometry(sra);
    record(
      'shipped ABI matches the deployed contract',
      true,
      `quarterStart(0)=${geometry.activationEpoch}  EPOCHS_PER_QUARTER=${geometry.epochsPerQuarter}`
    );
  } catch (err) {
    record(
      'shipped ABI matches the deployed contract',
      false,
      `${err.shortMessage ?? err.message} -- regenerate with \`npm run contracts:build && npm run abi:generate\``
    );
    process.exitCode = 1;
    return;
  }

  for (const key of ['activationEpoch', 'epochsPerQuarter']) {
    // 0 is the committed placeholder, not a disagreement -- see the note in src/crank.mjs.
    if (config.quarters[key] === 0n) {
      record(`config ${key} agrees with chain`, true, `not pinned in config; chain says ${geometry[key]}`, false);
      continue;
    }
    const same = config.quarters[key] === geometry[key];
    record(
      `config ${key} agrees with chain`,
      same,
      same ? String(geometry[key]) : `config ${config.quarters[key]}, chain ${geometry[key]}`,
      false
    );
  }

  const balance = await readBalance(provider, address);
  const funded = balance.wei >= config.minBalanceWei;
  record(
    'cranker wallet funded',
    funded,
    `${address} holds ${balance.fil} FIL (threshold ${config.minBalanceFil})` +
      (funded ? '' : ' -- see docs/WALLET.md'),
    false
  );

  const [sraState, gateState] = await Promise.all([
    readSraQuarterState(provider, config.addresses.sra),
    readSwaGateState(provider, config.addresses.swa),
  ]);

  const full = {
    activationEpoch: geometry.activationEpoch,
    epochsPerQuarter: geometry.epochsPerQuarter,
    postPeriod: config.quarters.postPeriod,
    verificationWindow: config.quarters.verificationWindow,
  };
  const schedule = buildSchedule(full, epoch, {
    lastSubmittedQuarter: sraState.lastSubmittedQuarter,
    lastCheckedQuarter: gateState.lastCheckedQuarter,
    gateComplete: gateState.complete,
  });

  const observed = await observeLatestBoundQuarter(sra, schedule.dueQuarter);
  const comparison = compareWithChain(schedule.dueQuarter, observed.quarter);
  record(
    'computed schedule agrees with the chain',
    comparison.agrees,
    comparison.agrees
      ? `latest bound quarter ${observed.quarter ?? 'none'}`
      : comparison.message,
    comparison.severity === 'critical'
  );

  const pause = resolvePause();
  record('cranker is not paused', !pause.paused, pause.reason ?? null, false);

  // ---- picture -------------------------------------------------------------
  process.stdout.write('\nWhere we are\n');
  const line = (k, v) => process.stdout.write(`  ${k.padEnd(24)} ${v}\n`);
  line('current quarter', `${schedule.currentQuarter} (${schedule.phase})`);
  line('next phase in', `${schedule.epochsUntilNextPhase} epochs (${epochsToDuration(schedule.epochsUntilNextPhase, config.epochSeconds)})`);
  line('latest bound quarter', observed.quarter ?? 'none');
  line('last submitted quarter', sraState.lastSubmittedQuarter);
  line('gate', `${gateState.steps}/${gateState.gateSteps} steps, last checked Q${gateState.lastCheckedQuarter}${gateState.complete ? ' (closed)' : ''}`);
  if (schedule.submit.expiresAtEpoch !== null) {
    line('submitShares window ends', `epoch ${schedule.submit.expiresAtEpoch} (${epochsToDuration(schedule.submit.marginEpochs, config.epochSeconds)} left)`);
  }

  const fatalFailures = checks.filter((c) => !c.ok && c.fatal);
  const warnings = checks.filter((c) => !c.ok && !c.fatal);

  process.stdout.write(
    `\n${checks.filter((c) => c.ok).length}/${checks.length} checks passed` +
      (warnings.length ? `, ${warnings.length} warning${warnings.length > 1 ? 's' : ''}` : '') +
      (fatalFailures.length ? `, ${fatalFailures.length} failed` : '') +
      '\n'
  );
  process.exitCode = fatalFailures.length ? 1 : 0;
}

await main();
