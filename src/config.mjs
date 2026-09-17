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

/** UTC weekday name, e.g. "Saturday". Pause rules are expressed in UTC because quarter boundaries are. */
function utcWeekday(date) {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][date.getUTCDay()];
}

/**
 * Decides whether this run is allowed to broadcast.
 *
 * Pausing exists for the rehearsal: quarters 5 and 6 fall on a weekend and deliberately
 * test what happens when nobody cranks. A paused run still reads chain state and reports,
 * so the logs stay continuous -- it just sends nothing.
 */
export function resolvePause(now = new Date(), env = process.env) {
  if (truthy(env.CRANK_PAUSED)) {
    return { paused: true, reason: 'CRANK_PAUSED is set' };
  }

  const days = (env.CRANK_DISABLED_DAYS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const today = now.toISOString().slice(0, 10);
  if (days.includes(today)) {
    return { paused: true, reason: `${today} is listed in CRANK_DISABLED_DAYS` };
  }

  const weekdays = (env.CRANK_DISABLED_WEEKDAYS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const weekday = utcWeekday(now);
  if (weekdays.some((w) => w.toLowerCase() === weekday.toLowerCase())) {
    return { paused: true, reason: `${weekday} (UTC) is listed in CRANK_DISABLED_WEEKDAYS` };
  }

  return { paused: false, reason: null };
}

/**
 * @param {object} env
 * @param {{requireKey?: boolean}} options
 *   `requireKey: false` loads a read-only configuration with no signer. The watchdog uses
 *   it: that job only reads chain state, and it runs in a workflow with `issues: write`.
 *   Handing a wallet key to the most privileged job in the repo to do work that needs no
 *   wallet is exactly the trade not to make.
 */
export function loadConfig(env = process.env, { requireKey = true } = {}) {
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
    privateKey = requiredEnv(
      env,
      'CRANKER_PRIVATE_KEY',
      'see docs/WALLET.md -- generate it yourself and store it as a GitHub Actions secret'
    );
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
      // Deliberately says nothing about the value itself, not even its length.
      throw new ConfigError(
        'CRANKER_PRIVATE_KEY is not a 0x-prefixed 32-byte hex key',
        'check for a stray newline or quote; see docs/WALLET.md'
      );
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
    maxGateCatchup,
    targetQuarter,

    dryRun: truthy(env.CRANK_DRY_RUN),
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

export { ConfigError, NETWORKS, truthy, safeHost };
