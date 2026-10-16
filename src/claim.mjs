/**
 * The Claim sender: FIP-0118 `Claim(2, wallets)` on f02, as a native message.
 *
 * What it does, every run:
 *
 *   1. Proves where it is: the endpoint must refuse wallet methods, and StateNetworkName must
 *      match NETWORK (`mainnet` / `calibrationnet`).
 *   2. Discovers who is owed: reads f02's stream state and lists every wallet in stream 2's
 *      share map or payable rows (or its tombstone). No wallet list is configured anywhere.
 *   3. Asks the chain how much each is owed: one StateCall per batch. Only wallets with a
 *      positive amount go into the batches that may be sent.
 *   4. Sends a batch only when all the guards pass: it pays more than 0, its maximum fee is
 *      under CLAIM_MAX_FEE_FIL, that fee is at most 10% of what it pays, the sender has no
 *      message already pending, and fewer than CLAIM_MAX_MESSAGES have gone this run.
 *
 * Why those guards and no others: Claim pays only the wallets f02's tables name (FIP-0118
 * §2.4.5), so the sender cannot redirect funds, whatever the inputs. What can go wrong is
 * wasted gas (a Claim that pays nothing, or pays less than it costs) and a nonce collision
 * (two senders on one key). The workflow's concurrency group is the other half of the second.
 *
 * The key (CLAIM_PRIVATE_KEY) is parsed into bytes once, used to sign, and never logged,
 * returned or put in a record.
 */
import { randomBytes } from 'node:crypto';

import { AlertSink } from './alerts/index.mjs';
import { connect, readSraQuarterState, withRetry } from './chain.mjs';
import { addressToString, parseAddress } from './filecoin/address.mjs';
import { decode, decodeBigInt, encodeArray, encodeBytes, encodeUint, fromBase64, toBase64, toHex } from './filecoin/cbor.mjs';
import {
  CLAIM_METHOD,
  SERVICE_STREAM,
  batch,
  candidateWallets,
  claimedThisPeriod,
  describeWallet,
  f02For,
  readF02,
} from './filecoin/f02.mjs';
import { createLotusClient } from './filecoin/lotus.mjs';
import { addressOfKey, parsePrivateKey, signMessage, signedMessageCid } from './filecoin/message.mjs';
import { log, persistRun } from './logger.mjs';
import { bindingEpoch } from './schedule.mjs';

/** One day of epochs: a post-submit Claim waits this long after submitShares lands. */
export const POST_SUBMIT_DELAY_EPOCHS = 2880n;
/** eth_getLogs ranges are capped by Lotus (MaxFilterHeightRange 2880); stay under it. */
const LOG_CHUNK = 2000n;

export const fil = (atto) => {
  const neg = atto < 0n;
  const s = (neg ? -atto : atto).toString().padStart(19, '0');
  const frac = s.slice(-18).replace(/0+$/, '');
  return `${neg ? '-' : ''}${s.slice(0, -18)}${frac ? '.' + frac : ''}`;
};

/** Claim params: (stream id, [address bytes...]) as a CBOR tuple. */
export function claimParams(wallets, streamId = SERVICE_STREAM) {
  return encodeArray([encodeUint(streamId), encodeArray(wallets.map(encodeBytes))]);
}

/** ClaimReturn is a one-field tuple holding amounts[]. */
export function decodeClaimReturn(base64) {
  const decoded = decode(fromBase64(base64));
  if (!Array.isArray(decoded) || !Array.isArray(decoded[0])) throw new Error('Claim returned something other than ([amounts])');
  return decoded[0].map(decodeBigInt);
}

/**
 * The fee guards, as one pure decision. `maxFee` is GasLimit * GasFeeCap: the most this message
 * can cost, which is what a guard has to bound.
 */
export function feeVerdict({ payout, maxFee, maxFeeAtto, maxFeeRatioPercent = 10 }) {
  if (payout <= 0n) return { send: false, reason: 'pays nothing' };
  if (maxFee > maxFeeAtto) return { send: false, reason: `max fee ${fil(maxFee)} FIL is above the ${fil(maxFeeAtto)} FIL cap` };
  if (maxFee * 100n > payout * BigInt(maxFeeRatioPercent)) {
    return { send: false, reason: `max fee ${fil(maxFee)} FIL is more than ${maxFeeRatioPercent}% of the ${fil(payout)} FIL payout` };
  }
  return { send: true, reason: null };
}

function baseMessage(config, from, wallets) {
  return {
    Version: 0,
    To: f02For(config.prefix),
    From: from,
    Nonce: 0,
    Value: '0',
    GasLimit: 0,
    GasFeeCap: '0',
    GasPremium: '0',
    Method: CLAIM_METHOD,
    Params: toBase64(claimParams(wallets)),
  };
}

/** Simulates a Claim from `from`. Returns per-wallet amounts, or throws with the exit code. */
async function simulate(lotus, msg) {
  const res = await lotus.call('StateCall', [msg, null]);
  const rct = res?.MsgRct;
  if (!rct || rct.ExitCode !== 0) {
    throw new Error(`simulation exit code ${rct?.ExitCode ?? 'unknown'}${res?.Error ? `: ${res.Error}` : ''}`);
  }
  return decodeClaimReturn(rct.Return);
}

/**
 * When did submitShares(q) land? The epoch of its SharesSubmitted event, or null when there is
 * none in [binding(q), head] -- an all-zero quarter submits without one, and pays nothing new.
 */
async function sharesSubmittedEpoch(ctx, geometry, q, head) {
  const { provider, sra } = ctx;
  const topic = sra.interface.getEvent('SharesSubmitted').topicHash;
  const qTopic = '0x' + BigInt(q).toString(16).padStart(64, '0');
  for (let from = bindingEpoch(geometry, q); from <= head; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - 1n < head ? from + LOG_CHUNK - 1n : head;
    const logs = await withRetry(
      () => provider.getLogs({ address: ctx.sraAddress, topics: [topic, qTopic], fromBlock: Number(from), toBlock: Number(to) }),
      { what: 'eth_getLogs SharesSubmitted' }
    );
    if (logs.length) return BigInt(logs[0].blockNumber);
  }
  return null;
}

async function waitForReceipt(lotus, cid, config) {
  for (let t = 0; t < config.pollAttempts; t++) {
    await new Promise((r) => setTimeout(r, config.pollMs));
    let found = null;
    try {
      found = await lotus.call('StateSearchMsg', [[], { '/': cid }, 200, true]);
    } catch {
      found = null; // not indexed yet
    }
    if (found) return found;
  }
  return null;
}

async function readBalanceAtto(lotus, address) {
  try {
    return BigInt(await lotus.call('WalletBalance', [address]));
  } catch {
    return null;
  }
}

function action(fields) {
  return {
    call: 'Claim', stream: SERVICE_STREAM, wallets: [], payoutFil: null, maxFeeFil: null,
    decision: 'skipped', outcome: null, cid: null, severity: 'info', message: '', ...fields,
  };
}

/**
 * One pass. Returns { record, exitCode, alerts }.
 * @param {object} config from loadClaimConfig
 * @param {object} [deps] test seams: { lotus, chain }
 */
export async function runClaim(config, deps = {}) {
  const runId = `${new Date().toISOString()}-${randomBytes(2).toString('hex')}`;
  const startedAt = new Date();
  const alerts = new AlertSink(config);
  const actions = [];
  const record = {
    kind: 'claim', runId, startedAt: startedAt.toISOString(), network: config.networkName,
    mode: config.mode, dryRun: config.dryRun, dryRunReason: config.dryRunReason, paused: config.paused,
    sender: null, senderBalanceFil: null, crankerBalanceFil: null, actions, exitCode: 0, finishedAt: null,
  };
  const finish = (exitCode) => {
    record.exitCode = exitCode;
    record.finishedAt = new Date().toISOString();
    persistRun(record);
    return { record, exitCode, alerts };
  };

  log.section(`Solstice Claim -- ${config.label}`);

  // ---- where are we --------------------------------------------------------
  const lotus = deps.lotus ?? createLotusClient(config.rpcUrl);
  await lotus.assertNoWalletAccess();
  await lotus.assertNetwork(config.networkName);

  // ---- who sends -------------------------------------------------------------
  let privateKey = null;
  let from = null;
  if (config.rawKey) {
    privateKey = parsePrivateKey(config.rawKey);
    from = addressOfKey(privateKey, config.prefix);
    if (config.claimAddress && config.claimAddress !== from) {
      throw new Error(
        `CLAIM_PRIVATE_KEY is the key of ${from}, but CLAIM_ADDRESS says ${config.claimAddress}. ` +
          'One of the two is wrong. Nothing was sent.'
      );
    }
  } else if (config.claimAddress) {
    parseAddress(config.claimAddress, config.prefix); // right network, right checksum
    from = config.claimAddress;
  }
  record.sender = from;

  // ---- balances: this key, and the cranker's -----------------------------------
  const ctxAlert = () => ({ epoch: '—', cranker: from ?? '—', balanceFil: record.senderBalanceFil ?? '—' });
  if (from) {
    const bal = await readBalanceAtto(lotus, from);
    record.senderBalanceFil = bal === null ? 'unknown' : fil(bal);
    if (bal !== null && bal < config.claimMinBalanceWei) {
      alerts.raise({
        severity: 'warn',
        title: 'Solstice: Claim wallet is low on gas',
        body: `${from} holds ${fil(bal)} FIL, below the ${config.claimMinBalanceFil} FIL threshold. Top it up; see docs/WALLET.md.`,
        context: ctxAlert(),
      });
    }
  }
  if (config.crankerAddress) {
    const cr = config.crankerAddress.startsWith('0x')
      ? addressToString(parseAddress(config.crankerAddress, config.prefix), config.prefix)
      : config.crankerAddress;
    const bal = await readBalanceAtto(lotus, cr);
    record.crankerBalanceFil = bal === null ? 'unknown' : fil(bal);
    if (bal !== null && bal < config.minBalanceWei) {
      alerts.raise({
        severity: 'warn',
        title: 'Solstice: cranker wallet is low on gas',
        body: `${config.crankerAddress} holds ${fil(bal)} FIL, below the ${config.minBalanceFil} FIL threshold. Top it up before the next quarter binds; see docs/WALLET.md.`,
        context: ctxAlert(),
      });
    }
  }
  log.info('connected', { network: config.networkName, sender: from ?? '(none)', balance: record.senderBalanceFil ?? '-', mode: config.mode });
  if (config.dryRun) log.warn(`dry run: ${config.dryRunReason}; simulating only`);

  if (config.paused) {
    log.warn('paused: CRANK_PAUSED is set; reading state but sending nothing');
    actions.push(action({ outcome: 'paused', message: 'CRANK_PAUSED is set' }));
    return finish(0);
  }

  // ---- what f02 holds ---------------------------------------------------------
  const state = await readF02(lotus, config.prefix);
  if (!state) {
    log.info('f02 has no stream state yet (before Solstice activation); nothing to claim');
    actions.push(action({ outcome: 'not-due', message: 'f02 has no stream state yet (before activation)' }));
    return finish(0);
  }

  // ---- post-submit: 24 hours after submitShares(q) lands, once ----------------------
  if (config.mode === 'post-submit') {
    const chain = deps.chain ?? (await (async () => {
      const c = await connect({ ...config, privateKey: null });
      return { provider: c.provider, sra: c.sra, sraAddress: config.addresses.sra };
    })());
    const head = BigInt(await chain.provider.getBlockNumber());
    const q = config.postSubmitQuarter;
    if (q === null) throw new Error('CLAIM_MODE=post-submit needs CLAIM_QUARTER');
    const sraState = await readSraQuarterState(chain.provider, chain.sraAddress);
    if (sraState.lastSubmittedQuarter < q) {
      actions.push(action({ outcome: 'not-due', message: `submitShares(${q}) has not landed yet (last submitted ${sraState.lastSubmittedQuarter})` }));
      log.info(actions.at(-1).message);
      return finish(0);
    }
    const geometry = {
      activationEpoch: config.quarters.activationEpoch, epochsPerQuarter: config.quarters.epochsPerQuarter,
      postPeriod: config.quarters.postPeriod, verificationWindow: config.quarters.verificationWindow,
    };
    const landed = sraState.lastSubmittedQuarter === q ? await sharesSubmittedEpoch(chain, geometry, q, head) : null;
    if (landed === null) {
      actions.push(action({ outcome: 'not-due', message: `no SharesSubmitted(${q}) event to time from; the weekly Claim covers this quarter` }));
      log.info(actions.at(-1).message);
      return finish(0);
    }
    if (head < landed + POST_SUBMIT_DELAY_EPOCHS) {
      actions.push(action({ outcome: 'not-due', message: `submitShares(${q}) landed at epoch ${landed}; the post-submit Claim is due at ${landed + POST_SUBMIT_DELAY_EPOCHS}` }));
      log.info(actions.at(-1).message);
      return finish(0);
    }
    // The fold that submitShares triggers clears claimed_period. Anything in it now was claimed
    // after that fold, so the post-submit Claim has already happened (ours or anyone's).
    if (claimedThisPeriod(state)) {
      actions.push(action({ outcome: 'already-done', message: `stream 2 has been claimed since submitShares(${q}) folded the period` }));
      log.info(actions.at(-1).message);
      return finish(0);
    }
  }

  // ---- who is owed what --------------------------------------------------------
  const candidates = candidateWallets(state);
  log.info('stream 2 candidates', { wallets: candidates.map((w) => describeWallet(w, config.prefix)).join(',') || 'none' });
  if (!candidates.length) {
    actions.push(action({ outcome: 'not-due', message: 'stream 2 has no share-map or payable wallets' }));
    return finish(0);
  }
  if (!from) {
    actions.push(action({ outcome: 'not-due', severity: 'warn', message: 'no CLAIM_PRIVATE_KEY and no CLAIM_ADDRESS: nothing to simulate from' }));
    log.warn(actions.at(-1).message);
    return finish(0);
  }

  const owed = [];
  for (const group of batch(candidates, config.batchSize)) {
    let amounts;
    try {
      amounts = await simulate(lotus, baseMessage(config, from, group));
    } catch (err) {
      actions.push(action({ wallets: group.map((w) => describeWallet(w, config.prefix)), outcome: 'error', severity: 'warn', message: `discovery: ${err.message}` }));
      log.warn(actions.at(-1).message);
      continue;
    }
    group.forEach((w, i) => {
      if ((amounts[i] ?? 0n) > 0n) owed.push({ wallet: w, amount: amounts[i] });
    });
  }
  const total = owed.reduce((s, o) => s + o.amount, 0n);
  log.info('owed in stream 2', { wallets: owed.length, totalFil: fil(total) });
  if (!owed.length) {
    actions.push(action({ outcome: 'not-due', message: 'nothing is owed to any stream 2 wallet right now' }));
    return finish(0);
  }

  // Largest payouts first, so the message cap drops the least valuable work.
  const batches = batch(owed.sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0)), config.batchSize);
  let sent = 0;
  let exitCode = 0;
  for (const group of batches) {
    const wallets = group.map((o) => o.wallet);
    const names = wallets.map((w) => describeWallet(w, config.prefix));
    if (sent >= config.maxMessages) {
      actions.push(action({ wallets: names, outcome: 'capped', message: `CLAIM_MAX_MESSAGES (${config.maxMessages}) reached; the next run continues` }));
      log.warn(actions.at(-1).message);
      continue;
    }

    // Nonce discipline: refuse while this sender has anything in the mpool. A pending message
    // means another sender on this key, or a stuck one of ours; a second message now would
    // either collide or queue behind it.
    const actor = await lotus.call('StateGetActor', [from, null]).catch(() => null);
    const nonce = await lotus.call('MpoolGetNonce', [from]);
    if (actor && Number(actor.Nonce) !== Number(nonce)) {
      actions.push(action({
        wallets: names, outcome: 'pending-nonce', severity: 'warn',
        message: `${from} has ${Number(nonce) - Number(actor.Nonce)} message(s) pending in the mpool; not sending on top of them`,
      }));
      log.warn(actions.at(-1).message);
      alerts.raise({ severity: 'warn', title: 'Solstice: Claim sender has a pending message', body: actions.at(-1).message, context: ctxAlert() });
      break;
    }

    const msg = { ...baseMessage(config, from, wallets), Nonce: Number(nonce) };
    let estimated;
    try {
      estimated = await lotus.call('GasEstimateMessageGas', [msg, { MaxFee: config.maxFeeAtto.toString() }, null]);
    } catch (err) {
      actions.push(action({ wallets: names, outcome: 'error', severity: 'warn', message: `gas estimate failed, nothing sent: ${err.message}` }));
      log.warn(actions.at(-1).message);
      continue;
    }
    const final = { ...msg, GasLimit: Number(estimated.GasLimit), GasFeeCap: String(estimated.GasFeeCap), GasPremium: String(estimated.GasPremium) };
    const maxFee = BigInt(final.GasLimit) * BigInt(final.GasFeeCap);

    // Re-simulate the exact batch: state may have moved since discovery.
    let amounts;
    try {
      amounts = await simulate(lotus, final);
    } catch (err) {
      actions.push(action({ wallets: names, outcome: 'error', severity: 'warn', message: `re-simulation failed, nothing sent: ${err.message}` }));
      log.warn(actions.at(-1).message);
      continue;
    }
    const payout = amounts.reduce((s, a) => s + a, 0n);
    const verdict = feeVerdict({ payout, maxFee, maxFeeAtto: config.maxFeeAtto, maxFeeRatioPercent: config.maxFeeRatioPercent });
    const base = { wallets: names, payoutFil: fil(payout), maxFeeFil: fil(maxFee) };
    if (!verdict.send) {
      actions.push(action({ ...base, outcome: 'fee-guard', message: `not sent: ${verdict.reason}` }));
      log.info(actions.at(-1).message);
      continue;
    }
    if (config.dryRun) {
      actions.push(action({ ...base, decision: 'dry-run', outcome: 'would-send', message: `would send (${config.dryRunReason}); params ${toHex(claimParams(wallets))}` }));
      log.info(`Claim(2, ${names.length} wallet(s)): would pay ${fil(payout)} FIL for at most ${fil(maxFee)} FIL`);
      sent += 1; // a dry run spends the same budget a real run would
      continue;
    }

    const signature = signMessage(final, privateKey, config.prefix);
    const localCid = signedMessageCid(final, signature, config.prefix).string;
    const pushed = await lotus.call('MpoolPush', [{ Message: final, Signature: signature }]);
    const cid = pushed['/'];
    sent += 1;
    log.info(`Claim(2, ${names.length} wallet(s)): sent`, { cid, payoutFil: fil(payout), maxFeeFil: fil(maxFee) });
    if (cid !== localCid) log.warn('node CID differs from the locally computed CID', { node: cid, local: localCid });

    const found = await waitForReceipt(lotus, cid, config);
    if (!found) {
      actions.push(action({ ...base, decision: 'sent', outcome: 'unconfirmed', cid, severity: 'warn', message: 'sent but not seen on chain yet; check the CID before any resend' }));
      alerts.raise({ severity: 'warn', title: 'Solstice: Claim sent but not confirmed', body: `${cid} was pushed and has not landed. Check it before anything else is sent from ${from}.`, context: ctxAlert() });
      break; // the next message would queue behind this nonce
    }
    const { ExitCode, Return } = found.Receipt;
    if (ExitCode !== 0) {
      exitCode = 1;
      actions.push(action({ ...base, decision: 'failed', outcome: 'error', cid, severity: 'critical', message: `landed at epoch ${found.Height} with exit code ${ExitCode}` }));
      alerts.raise({ severity: 'critical', title: 'Solstice: Claim failed on chain', body: `${cid} exited ${ExitCode} after a successful simulation.`, context: ctxAlert() });
      break;
    }
    const paid = Return ? decodeClaimReturn(Return).reduce((s, a) => s + a, 0n) : 0n;
    actions.push(action({ ...base, decision: 'sent', outcome: 'landed', cid, payoutFil: fil(paid), message: `landed at epoch ${found.Height}, paid ${fil(paid)} FIL` }));
    log.info(actions.at(-1).message);
  }

  if (alerts.worst === 'critical') exitCode = 1;
  return finish(exitCode);
}
