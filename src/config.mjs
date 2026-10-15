/**
 * Configuration loading and validation.
 *
 * Everything the cranker needs is resolved and checked here, before a single RPC call
 * goes out. A misconfigured run should fail on the first line with a sentence that says
 * what to fix, not three calls later with a decoding error.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAddress, getAddress, parseEther } from 'ethers';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const NETWORKS = JSON.parse(readFileSync(join(ROOT, 'config', 'networks.json'), 'utf8'));
export const STORAGE_SLOTS = JSON.parse(
  readFileSync(join(ROOT, 'config', 'storage-slots.json'), 'utf8')
);

class ConfigError extends Error {
  constructor(message, hint) {
    super(hint ? `${message}\n  -> ${hint}` : message);
    this.name = 'ConfigError';
    this.isConfigError = true;
  }
}

const truthy = (v) => v !== undefined && v !== '' && !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase());

// These take `env` explicitly. Reading process.env directly here would mean loadConfig(env)
// honoured its argument for some settings and silently ignored it for the three that matter
// most -- the key and the two addresses -- which is both a testing trap and a real one.
function requiredEnv(env, name, hint) {
  const v = env[name];
  if (!v) throw new ConfigError(`${name} is not set`, hint);
  return v;
}

function optionalAddress(env, name) {
  const v = env[name];
  if (!v) return null;
  if (!isAddress(v)) throw new ConfigError(`${name} is not a valid address: ${v}`);
  return getAddress(v);
}

/**
 * Decides whether this run is allowed to broadcast.
 *
 * CRANK_PAUSED is the one stop switch, and it stops everything that sends: the crank and the
 * Claim. A paused run still reads chain state and reports, so the logs stay continuous -- it
 * just sends nothing. The rehearsal's day and window pauses (CRANK_PAUSED_WINDOWS,
 * CRANK_DISABLED_DAYS, CRANK_DISABLED_WEEKDAYS) are gone: on Mainnet a pause that lifts by
 * itself on a date is a way to lose a quarter, not a feature.
 */
export function resolvePause(now = new Date(), rawEnv = process.env) {
  const env = withoutBlanks(rawEnv);
  if (truthy(env.CRANK_PAUSED)) {
    return { paused: true, reason: 'CRANK_PAUSED is set' };
  }
  return { paused: false, reason: null };
}

/**
 * Treats an empty string as "not set".
 *
 * GitHub Actions substitutes an undefined repository variable as the EMPTY STRING, not as
 * an absent key -- so `${{ vars.CRANK_MIN_BALANCE_FIL }}` on a repo that never defined it
 * arrives as `CRANK_MIN_BALANCE_FIL=""`. `??` does not fall back on that, and every
 * optional setting in this file would then take '' as a deliberate value: parseEther('')
 * throws, Number('') is 0, and an unset NETWORK becomes an unknown network.
 *
 * Nothing here has a meaningful empty-string value, so normalising once at the boundary is
 * both correct and the only place this has to be remembered.
 */
function withoutBlanks(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== '') out[k] = v;
  }
  return out;
}

/**
 * @param {object} env
 * @param {{requireKey?: boolean}} options
 *   `requireKey: false` loads a read-only configuration with no signer. The watchdog uses
 *   it: that job only reads chain state, and it runs in a workflow with `issues: write`.
 *   Handing a wallet key to the most privileged job in the repo to do work that needs no
 *   wallet is exactly the trade not to make.
 */
export function loadConfig(rawEnv = process.env, { requireKey = true } = {}) {
  const env = withoutBlanks(rawEnv);
  const name = env.NETWORK ?? 'calibnet';
  const network = NETWORKS[name];
  if (!network) {
    throw new ConfigError(
      `unknown NETWORK "${name}"`,
      `known networks: ${Object.keys(NETWORKS).filter((k) => !k.startsWith('$')).join(', ')}`
    );
  }

  let privateKey = null;
  if (requireKey || env.CRANKER_PRIVATE_KEY) {
    // Trimmed, because the key almost always arrives with trailing whitespace: the WALLET.md
    // generator writes it with a final newline, `gh secret set NAME < file` uploads the file
    // byte for byte, and a key pasted into the GitHub UI often picks up a stray space. A hex
    // key has no meaningful whitespace, so stripping it is always safe -- and rejecting it
    // would fail every scheduled run with a key that is, in every way that matters, correct.
    privateKey = requiredEnv(
      env,
      'CRANKER_PRIVATE_KEY',
      'see docs/WALLET.md -- generate it yourself and store it as a GitHub Actions secret'
    ).trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
      // Deliberately says nothing about the value itself, not even its length.
      throw new ConfigError(
        'CRANKER_PRIVATE_KEY is not a 0x-prefixed 32-byte hex key',
        'check for a stray newline or quote; see docs/WALLET.md'
      );
    }
  }

  if (env.CRANKER_PRIVATE_KEY && env.CLAIM_PRIVATE_KEY) {
    const norm = (k) => String(k).trim().toLowerCase().replace(/^0x/, '');
    if (norm(env.CRANKER_PRIVATE_KEY) === norm(env.CLAIM_PRIVATE_KEY)) {
      throw new ConfigError('CRANKER_PRIVATE_KEY and CLAIM_PRIVATE_KEY are the same key', 'they must be two separate keys; see docs/WALLET.md');
    }
  }

  const sra = optionalAddress(env, 'SRA_ADDRESS') ?? getAddress(network.sra);
  const swa = optionalAddress(env, 'SWA_ADDRESS') ?? getAddress(network.swa);

  const minBalanceFil = env.CRANK_MIN_BALANCE_FIL ?? network.minBalanceFil;
  let minBalanceWei;
  try {
    minBalanceWei = parseEther(String(minBalanceFil));
  } catch {
    throw new ConfigError(`CRANK_MIN_BALANCE_FIL is not a number: ${minBalanceFil}`);
  }

  // Diagnostic override: force submitShares at a specific quarter instead of the one the
  // schedule resolves. The contract is the real guard here -- submitShares only ever
  // accepts the latest bound quarter, so a wrong value reverts rather than doing damage --
  // but a value left set in production would aim every run at a quarter that will never be
  // due again, so the crank warns loudly on every run and records it.
  let targetQuarter = null;
  if (env.CRANK_TARGET_QUARTER !== undefined && env.CRANK_TARGET_QUARTER !== '') {
    targetQuarter = Number(env.CRANK_TARGET_QUARTER);
    if (!Number.isInteger(targetQuarter) || targetQuarter < 1) {
      throw new ConfigError('CRANK_TARGET_QUARTER must be an integer >= 1 (quarter 0 is never submittable)');
    }
  }

  const maxGateCatchup = Number(env.CRANK_MAX_GATE_CATCHUP ?? 8);
  if (!Number.isInteger(maxGateCatchup) || maxGateCatchup < 1 || maxGateCatchup > 64) {
    throw new ConfigError('CRANK_MAX_GATE_CATCHUP must be an integer between 1 and 64');
  }

  return {
    networkName: name,
    label: network.label,
    chainId: BigInt(network.chainId),
    rpcUrl: env.RPC_URL ?? network.rpcUrl,
    privateKey,
    addresses: { sra, swa },
    deployed: sra !== ZERO_ADDRESS && swa !== ZERO_ADDRESS,

    // Quarter geometry. activationEpoch and epochsPerQuarter are re-read from chain at
    // runtime and these values are only a cross-check; postPeriod and verificationWindow
    // are private immutables upstream and can be known no other way.
    quarters: {
      activationEpoch: BigInt(network.activationEpoch),
      epochsPerQuarter: BigInt(network.epochsPerQuarter),
      postPeriod: BigInt(network.postPeriod),
      verificationWindow: BigInt(network.verificationWindow),
      hold: BigInt(network.hold),
    },
    epochSeconds: network.epochSeconds,
    confirmations: Number(env.CRANK_CONFIRMATIONS ?? network.confirmations ?? 1),
    explorerTxUrl: network.explorerTxUrl,

    minBalanceWei,
    minBalanceFil: String(minBalanceFil),

    // The Claim key's public address, so each crank run can warn when that wallet runs low
    // too. Only the address: the crank job never holds CLAIM_PRIVATE_KEY.
    claimAddress: env.CLAIM_ADDRESS ?? null,
    claimMinBalanceFil: String(env.CLAIM_MIN_BALANCE_FIL ?? network.claimMinBalanceFil ?? '0.1'),
    maxGateCatchup,
    targetQuarter,

    dryRun: truthy(env.CRANK_DRY_RUN) || mainnetSendsBlocked(name, env),
    dryRunReason: truthy(env.CRANK_DRY_RUN)
      ? 'CRANK_DRY_RUN is set'
      : mainnetSendsBlocked(name, env)
        ? 'NETWORK=mainnet and MAINNET_SEND_ENABLED is not set'
        : null,
    stateDir: env.CRANK_STATE_DIR ? resolve(env.CRANK_STATE_DIR) : null,

    alerts: {
      transports: (env.ALERT_TRANSPORT ?? 'console').split(',').map((s) => s.trim()).filter(Boolean),
      to: env.ALERT_EMAIL_TO ?? null,
      from: env.ALERT_EMAIL_FROM ?? 'cranker@fil.org',
      sendgridKey: env.SENDGRID_API_KEY ?? null,
      resendKey: env.RESEND_API_KEY ?? null,
      webhookUrl: env.ALERT_WEBHOOK_URL ?? null,
    },

    runUrl:
      env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        : null,
  };
}

/** A redacted view, safe to log or serialise. The key never appears. */
export function describeConfig(config) {
  return {
    network: config.networkName,
    chainId: Number(config.chainId),
    rpcHost: safeHost(config.rpcUrl),
    sra: config.addresses.sra,
    swa: config.addresses.swa,
    deployed: config.deployed,
    dryRun: config.dryRun,
    targetQuarter: config.targetQuarter ?? '(auto)',
    alertTransports: config.alerts.transports.join(','),
  };
}

/** Hostname only: an RPC URL can carry an API key in its path or query. */
function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '<unparseable RPC_URL>';
  }
}

/**
 * Strips the RPC URL out of text bound for a log or an alert.
 *
 * ethers writes the full request URL into `err.message` and `err.stack` for a SERVER_ERROR (a 429,
 * a 5xx), so an API key in RPC_URL's path or query lands in whatever prints them. Actions masks the
 * secret in its own log, but not in an email or a webhook body. Only `shortMessage` is clean.
 */
function redactRpcUrl(text, rpcUrl) {
  if (text === null || text === undefined) return text;
  let out = String(text);
  if (rpcUrl) out = out.split(rpcUrl).join(`<RPC_URL ${safeHost(rpcUrl)}>`);
  // Whatever form the URL took in the error -- normalised, re-encoded -- never pass a requestUrl on.
  return out.replace(/("?requestUrl"?\s*[:=]\s*)"(?!<RPC_URL )[^"]*"/g, '$1"<redacted>"');
}

/**
 * Mainnet sends are off until an operator turns them on.
 *
 * NETWORK=mainnet with MAINNET_SEND_ENABLED unset (or falsy) forces every run -- crank and
 * Claim, scheduled or manual -- into a dry run: it reads, decides, simulates and reports, and
 * broadcasts nothing. The switch is a repository variable, so turning Mainnet on is one
 * visible, reversible change, not a code edit.
 */
export function mainnetSendsBlocked(networkName, rawEnv = process.env) {
  const env = withoutBlanks(rawEnv);
  return networkName === 'mainnet' && !truthy(env.MAINNET_SEND_ENABLED);
}

function parseFil(value, name) {
  try {
    const wei = parseEther(String(value));
    if (wei < 0n) throw new Error('negative');
    return wei;
  } catch {
    throw new ConfigError(`${name} is not a FIL amount: ${value}`);
  }
}

function intIn(env, name, fallback, lo, hi) {
  const v = Number(env[name] ?? fallback);
  if (!Number.isInteger(v) || v < lo || v > hi) throw new ConfigError(`${name} must be an integer between ${lo} and ${hi}`);
  return v;
}

/**
 * Configuration for the native Claim sender.
 *
 * The key is CLAIM_PRIVATE_KEY: an f1 (secp256k1) key, separate from CRANKER_PRIVATE_KEY.
 * They are never the same key -- loading refuses that outright -- because the two jobs hold
 * different secrets and a leak of one should not reach the other.
 *
 * CLAIM_ADDRESS is the public f1 address of that key. It is optional with a key (and must then
 * match it: the watchtower found a secret holding the wrong key on 2026-10-12), and it is what
 * a keyless dry run simulates from.
 */
export function loadClaimConfig(rawEnv = process.env, { requireKey = true } = {}) {
  const env = withoutBlanks(rawEnv);
  const base = loadConfig({ ...env, CRANKER_PRIVATE_KEY: undefined }, { requireKey: false });
  const network = NETWORKS[base.networkName];
  if (!network.addressPrefix) {
    throw new ConfigError(`NETWORK=${base.networkName} has no native Filecoin side; Claim runs on calibnet and mainnet only`);
  }

  const rawKey = env.CLAIM_PRIVATE_KEY ?? null;
  if (requireKey && !rawKey) {
    throw new ConfigError('CLAIM_PRIVATE_KEY is not set', 'see docs/WALLET.md, "The Claim key"; a dry run needs only CLAIM_ADDRESS');
  }
  if (rawKey && env.CRANKER_PRIVATE_KEY) {
    const norm = (k) => String(k).trim().toLowerCase().replace(/^0x/, '');
    if (norm(rawKey) === norm(env.CRANKER_PRIVATE_KEY)) {
      throw new ConfigError('CLAIM_PRIVATE_KEY and CRANKER_PRIVATE_KEY are the same key', 'generate a separate f1 key for Claim; see docs/WALLET.md');
    }
  }

  const dryRunAsked = truthy(env.CLAIM_DRY_RUN);
  const mainnetBlocked = mainnetSendsBlocked(base.networkName, env);
  const mode = env.CLAIM_MODE ?? 'manual';
  if (!['weekly', 'post-submit', 'manual'].includes(mode)) {
    throw new ConfigError(`CLAIM_MODE must be weekly, post-submit or manual, not "${mode}"`);
  }
  let postSubmitQuarter = null;
  if (env.CLAIM_QUARTER !== undefined) {
    postSubmitQuarter = Number(env.CLAIM_QUARTER);
    if (!Number.isInteger(postSubmitQuarter) || postSubmitQuarter < 1) throw new ConfigError('CLAIM_QUARTER must be an integer >= 1');
  }

  return {
    ...base,
    prefix: network.addressPrefix,
    rawKey,
    claimAddress: env.CLAIM_ADDRESS ?? null,
    crankerAddress: env.CRANKER_ADDRESS ?? null,
    maxFeeAtto: parseFil(env.CLAIM_MAX_FEE_FIL ?? '0.05', 'CLAIM_MAX_FEE_FIL'),
    maxFeeFil: String(env.CLAIM_MAX_FEE_FIL ?? '0.05'),
    maxMessages: intIn(env, 'CLAIM_MAX_MESSAGES', 3, 1, 20),
    batchSize: intIn(env, 'CLAIM_BATCH_SIZE', 64, 1, 64),
    // Never pay more than a tenth of what a Claim moves. Below that, waiting is cheaper.
    maxFeeRatioPercent: 10,
    claimMinBalanceWei: parseFil(env.CLAIM_MIN_BALANCE_FIL ?? network.claimMinBalanceFil ?? '0.1', 'CLAIM_MIN_BALANCE_FIL'),
    claimMinBalanceFil: String(env.CLAIM_MIN_BALANCE_FIL ?? network.claimMinBalanceFil ?? '0.1'),
    pollMs: intIn(env, 'CLAIM_POLL_MS', 15_000, 10, 120_000),
    pollAttempts: intIn(env, 'CLAIM_POLL_ATTEMPTS', 40, 1, 400),
    mode,
    postSubmitQuarter,
    paused: resolvePause(new Date(), env).paused,
    dryRun: dryRunAsked || mainnetBlocked || !rawKey,
    dryRunReason: dryRunAsked
      ? 'CLAIM_DRY_RUN is set'
      : mainnetBlocked
        ? 'NETWORK=mainnet and MAINNET_SEND_ENABLED is not set'
        : !rawKey
          ? 'no CLAIM_PRIVATE_KEY'
          : null,
  };
}

export { ConfigError, NETWORKS, truthy, safeHost, redactRpcUrl, withoutBlanks };
