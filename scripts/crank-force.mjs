#!/usr/bin/env node
/**
 * Sends exactly one named call WITHOUT the pre-send simulation. Manual use only.
 *
 * The cranker proper simulates every call and never broadcasts one it knows will revert --
 * which is right for a job that runs every ten minutes, and is also why it can never put a
 * failed message on chain. The rehearsal plan has rows that need precisely that: a call the
 * cranker is expected to send, and the watchtower is expected to show as "reverted". This is
 * how a person sends them, from the Run workflow button, with the cranker's own wallet.
 *
 *   CRANK_FORCE_CALL=quarterlyGateCheck
 *   CRANK_FORCE_CALL=submitShares  CRANK_FORCE_QUARTER=3
 *
 * Guardrails, all deliberate:
 *   - Only these two calls, both permissionless and non-payable. Anything else is refused.
 *   - Refuses to run from a scheduled trigger. The workflow never passes it one, and this
 *     checks again, so the cron can never fire it.
 *   - A reverted message is the expected result, so it exits 0 on revert as well as on
 *     success. It exits 1 only when nothing reached the chain.
 *   - With CRANK_DRY_RUN it prints exactly what it would send, and sends nothing.
 */
import { Interface } from 'ethers';

import sraAbi from '../abi/ServiceRewardsActor.json' with { type: 'json' };
import swaAbi from '../abi/StreamWeightActor.json' with { type: 'json' };
import { loadConfig, resolvePause } from '../src/config.mjs';
import { connect, readBalance } from '../src/chain.mjs';
import { classifyRevert } from '../src/errors.mjs';
import { log, writeJobSummary } from '../src/logger.mjs';

/**
 * The gas limit has to be explicit. Without one, ethers calls eth_estimateGas first, and
 * estimation reverts for exactly the calls this script exists to send -- so the message would
 * never be built.
 *
 * It cannot be measured with eth_call either: Lotus does not honour eth_call's gas parameter,
 * so a probe "reaches the revert" at any value down to the 21,000 intrinsic cost and proves
 * nothing. So the defaults come from real receipts instead, and differ by network because the
 * units do:
 *
 *   Filecoin (FEVM gas)  100,000,000. Real calls to these same SRA and SWA proxies on calibnet
 *                        used ~61,000,000 (Blockscout). A revert stops early and uses less. The
 *                        block limit is 10,000,000,000, and at calibnet's 100 attoFIL base fee
 *                        burning all 100M costs about 0.00000001 FIL.
 *   devnet (EVM gas)     10,000,000. Hardhat caps a single transaction at 2^24 = 16,777,216,
 *                        and quarterlyGateCheck() costs ~80,000 there.
 *
 * Too low is worse than too high: an under-gassed message still lands, but fails SYS_OUT_OF_GAS
 * instead of reverting for the reason the scenario is testing.
 */
const DEFAULT_GAS_LIMIT = { devnet: 10_000_000n, default: 100_000_000n };

const CALLS = {
  quarterlyGateCheck: { target: 'swa', abi: swaAbi, args: () => [] },
  submitShares: {
    target: 'sra',
    abi: sraAbi,
    args: (env) => {
      const q = Number(env.CRANK_FORCE_QUARTER);
      if (!Number.isInteger(q) || q < 1) {
        throw new Error('submitShares needs CRANK_FORCE_QUARTER, an integer >= 1');
      }
      return [q];
    },
  },
};

async function main() {
  const name = (process.env.CRANK_FORCE_CALL ?? '').trim();
  const spec = CALLS[name];
  if (!spec) {
    throw new Error(`CRANK_FORCE_CALL must be one of ${Object.keys(CALLS).join(', ')}; got "${name}"`);
  }
  if (process.env.GITHUB_EVENT_NAME === 'schedule') {
    throw new Error('refusing to force-send from a scheduled run -- this is for manual use only');
  }

  const dryRun = Boolean(process.env.CRANK_DRY_RUN);
  const config = loadConfig(process.env, { requireKey: !dryRun });
  const args = spec.args(process.env);
  const to = config.addresses[spec.target];
  const iface = new Interface(spec.abi);
  const data = iface.encodeFunctionData(name, args);
  const gasLimit = BigInt(
    process.env.CRANK_FORCE_GAS_LIMIT || (DEFAULT_GAS_LIMIT[config.networkName] ?? DEFAULT_GAS_LIMIT.default)
  );
  const label = `${name}(${args.join(',')})`;

  log.section(`Forced send -- ${label} on ${config.label}`);
  log.warn('sending WITHOUT the pre-send simulation; a revert is the expected outcome');

  const pause = resolvePause(new Date());
  if (pause.paused) {
    // A person pressing the button overrides the schedule's pause: that is the point of it.
    log.warn(`note: the scheduled cranker is paused (${pause.reason}); a manual force is not`);
  }

  const { provider, wallet, address } = await connect(config);
  log.info('target', { call: label, to, from: address ?? '(dry run, no signer)', gasLimit: String(gasLimit) });

  if (dryRun) {
    log.info('CRANK_DRY_RUN is set: would send exactly this, and sent nothing', { data });
    return summary({ config, label, to, outcome: 'dry run -- not sent' });
  }

  const before = await readBalance(provider, address);

  // No staticCall, no estimateGas. That is the whole difference from scripts/crank.mjs.
  const tx = await wallet.sendTransaction({ to, data, gasLimit });
  log.info('broadcast', { tx: tx.hash });

  let receipt;
  try {
    receipt = await tx.wait(config.confirmations);
  } catch (err) {
    // ethers v6 throws on a status-0 receipt and attaches it; that is a landed revert.
    receipt = err?.receipt ?? null;
    if (!receipt) throw err;
  }

  let outcome;
  if (receipt.status === 1) {
    outcome = `landed in block ${receipt.blockNumber}`;
    log.info(outcome);
  } else {
    // A receipt carries no revert data. Replaying the call against the state it ran on gives
    // the reason back, and the reason is the thing worth reporting.
    let reason = 'reverted (reason not recoverable)';
    try {
      await provider.call({ from: address, to, data, gas: gasLimit, blockTag: receipt.blockNumber - 1 });
    } catch (err) {
      const v = classifyRevert(err);
      reason = v.reason ? `reverted ${v.reason}` : `reverted: ${v.message}`;
    }
    outcome = `${reason}, in block ${receipt.blockNumber}`;
    log.info(outcome);
  }

  const after = await readBalance(provider, address);
  const cost = before.wei - after.wei;
  log.info('cost', { attoFil: String(cost), gasUsed: String(receipt.gasUsed) });

  return summary({
    config, label, to, outcome, txHash: tx.hash, block: receipt.blockNumber,
    gasUsed: receipt.gasUsed, costAttoFil: cost,
  });
}

function summary({ config, label, to, outcome, txHash = null, block = null, gasUsed = null, costAttoFil = null }) {
  const explorer = txHash && config.explorerTxUrl ? `${config.explorerTxUrl}${txHash}` : null;
  const record = { mode: 'force', network: config.networkName, call: label, to, outcome, txHash, block,
    gasUsed: gasUsed === null ? null : String(gasUsed), costAttoFil: costAttoFil === null ? null : String(costAttoFil),
    explorer };
  process.stdout.write(JSON.stringify(record, null, 2) + '\n');
  writeJobSummary([
    `### Forced send — ${label}`,
    '',
    `**${outcome}**`,
    '',
    `- to \`${to}\``,
    txHash ? `- tx \`${txHash}\`${explorer ? ` — [view](${explorer})` : ''}` : '- not sent',
    gasUsed === null ? '' : `- gas used ${gasUsed}, cost ${costAttoFil} attoFIL`,
    '',
    'Sent without the pre-send simulation, so a revert is the expected result, not a failure.',
  ].join('\n'));
}

try {
  await main();
} catch (err) {
  log.error('forced send failed before anything reached the chain', { error: err.message });
  process.exitCode = 1;
}
