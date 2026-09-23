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
 * Parses CRANK_PAUSED_WINDOWS: comma-separated ISO 8601 intervals, `start/end`, half-open.
 *
 *   2026-10-03T19:00:00Z/2026-10-05T13:25:00Z
 *
 * Each end MUST carry an explicit timezone (Z or ±hh:mm). A bare "2026-10-03T19:00" is
 * local time in whatever zone the runner happens to be in, which is exactly the ambiguity
 * that turns a correct pause into one six hours off. A malformed window throws rather than
 * being skipped: silently not pausing would break the scenario the window exists to protect,
 * and a run that fails on config is visible the moment the variable is set.
 */
function parsePauseWindows(raw) {
  if (!raw) return [];
  const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split('/');
      if (parts.length !== 2 || !ZONED.test(parts[0]) || !ZONED.test(parts[1])) {
        throw new ConfigError(
          `CRANK_PAUSED_WINDOWS entry "${entry}" is not start/end with explicit timezones`,
          'use e.g. 2026-10-03T19:00:00Z/2026-10-05T13:25:00Z'
        );
      }
      const start = new Date(parts[0]);
      const end = new Date(parts[1]);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
        throw new ConfigError(`CRANK_PAUSED_WINDOWS entry "${entry}" must end after it starts`);
      }
      return { start, end, raw: entry };
    });
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
export function resolvePause(now = new Date(), rawEnv = process.env) {
  const env = withoutBlanks(rawEnv);
  if (truthy(env.CRANK_PAUSED)) {
    return { paused: true, reason: 'CRANK_PAUSED is set' };
  }

  // Exact-instant windows, for when a whole calendar day is the wrong shape. The rehearsal
  // needed this: the no-crank weekend has to start the moment Q5 binds (Saturday 19:00, so a
  // late Q4 is not stranded -- its deadline is that same instant) and end after Monday's
  // temporary stream takes effect (13:00), or the scripted "gate check reverts for lack of
  // headroom" would instead run at 00:00 before the stream exists, and might pass.
  for (const window of parsePauseWindows(env.CRANK_PAUSED_WINDOWS)) {
    if (now >= window.start && now < window.end) {
      return {
        paused: true,
        reason: `inside CRANK_PAUSED_WINDOWS ${window.raw} (until ${window.end.toISOString()})`,
      };
    }
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

  // Validated here as well as when it is used, so a malformed window fails the run on its
  // first line with a sentence that says what to fix -- not mid-run, after state was read.
  parsePauseWindows(env.CRANK_PAUSED_WINDOWS);

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
