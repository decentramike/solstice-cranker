/**
 * src/config.mjs -- pause resolution, key validation, and redaction.
 *
 * Two things must hold no matter what:
 *   - the pause rules are evaluated in UTC, because quarter boundaries are;
 *   - no code path ever emits the private key or the RPC URL's path/query.
 *
 * No real key is used anywhere in this file. The well-formed placeholder below is a fixed
 * byte pattern, it is never handed to a Wallet, and loadConfig only shape-checks it.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  ConfigError,
  NETWORKS,
  describeConfig,
  loadConfig,
  resolvePause,
  safeHost,
  truthy,
} from '../src/config.mjs';

/** A shape-valid placeholder, not a key: a fixed repeated byte, never used to sign anything. */
const PLACEHOLDER_KEY = '0x' + '11'.repeat(32);

const ENV_KEYS = [
  'NETWORK',
  'RPC_URL',
  'CRANKER_PRIVATE_KEY',
  'SRA_ADDRESS',
  'SWA_ADDRESS',
  'CRANK_PAUSED',
  'CRANK_DISABLED_DAYS',
  'CRANK_DISABLED_WEEKDAYS',
  'CRANK_DRY_RUN',
  'CRANK_MIN_BALANCE_FIL',
  'CRANK_MAX_GATE_CATCHUP',
  'CRANK_CONFIRMATIONS',
  'CRANK_STATE_DIR',
  'ALERT_TRANSPORT',
];

let saved;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const at = (iso) => new Date(iso);

describe('resolvePause', () => {
  it('is not paused with no pause environment at all', () => {
    assert.deepEqual(resolvePause(at('2026-09-17T12:00:00Z')), { paused: false, reason: null });
  });

  describe('CRANK_PAUSED', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on', 'paused']) {
      it(`pauses on ${JSON.stringify(v)}`, () => {
        process.env.CRANK_PAUSED = v;
        const r = resolvePause(at('2026-09-17T12:00:00Z'));
        assert.equal(r.paused, true);
        assert.match(r.reason, /CRANK_PAUSED/);
      });
    }

    for (const v of ['', '0', 'false', 'FALSE', 'no', 'off']) {
      it(`does not pause on ${JSON.stringify(v)}`, () => {
        process.env.CRANK_PAUSED = v;
        assert.equal(resolvePause(at('2026-09-17T12:00:00Z')).paused, false);
      });
    }

    it('wins over the other rules', () => {
      process.env.CRANK_PAUSED = '1';
      process.env.CRANK_DISABLED_DAYS = '2026-09-27';
      const r = resolvePause(at('2026-09-27T12:00:00Z'));
      assert.match(r.reason, /CRANK_PAUSED/);
    });
  });

  describe('CRANK_DISABLED_DAYS -- the rehearsal weekend', () => {
    // The rehearsal has TWO no-crank weekends, from the rehearsal plan (activation
    // Wed 2026-09-23 13:00 UTC, one quarter per day):
    //   Q3  binds Sat 2026-09-26 19:00 -- "weekend post, no cranks"
    //   Q4  binds Sun 2026-09-27 19:00 -- "weekend fail, no action"
    //   Q10 binds Sat 2026-10-03 19:00 -- "weekend post, no cranks"
    //   Q11 binds Sun 2026-10-04 19:00 -- "weekend, no action"
    // Quarters bind at 19:00 (the 13:00 boundary + POST 2h + VERIFY 4h), so pausing on
    // those calendar dates is what suppresses the cranks for those quarters.
    const REHEARSAL = '2026-09-26,2026-09-27,2026-10-03,2026-10-04';

    for (const day of ['2026-09-26', '2026-09-27', '2026-10-03', '2026-10-04']) {
      it(`${day} pauses`, () => {
        process.env.CRANK_DISABLED_DAYS = REHEARSAL;
        for (const t of ['00:00:00', '11:30:00', '23:59:59']) {
          const r = resolvePause(at(`${day}T${t}Z`));
          assert.equal(r.paused, true, `${day}T${t}Z`);
          assert.match(r.reason, new RegExp(day));
        }
      });
    }

    it('the days on either side do not pause', () => {
      process.env.CRANK_DISABLED_DAYS = REHEARSAL;
      // Friday 25th: Q2 must still be cranked.
      assert.equal(resolvePause(at('2026-09-25T23:59:59Z')).paused, false);
      // Monday 28th: the Q5 cycle and the catch-up for Q3/Q4 happen on this day.
      assert.equal(resolvePause(at('2026-09-28T00:00:00Z')).paused, false);
      // Friday 2nd and Monday 5th, either side of the second weekend.
      assert.equal(resolvePause(at('2026-10-02T23:59:59Z')).paused, false);
      assert.equal(resolvePause(at('2026-10-05T00:00:00Z')).paused, false);
    });

    it('the crank that binds at 19:00 on each no-crank day is suppressed', () => {
      process.env.CRANK_DISABLED_DAYS = REHEARSAL;
      // Binding time is the moment that matters: 13:00 boundary + POST 2h + VERIFY 4h.
      for (const day of ['2026-09-26', '2026-09-27', '2026-10-03', '2026-10-04']) {
        assert.equal(resolvePause(at(`${day}T19:00:00Z`)).paused, true, `${day} 19:00Z`);
      }
    });

    it('does NOT suppress the Monday catch-ups', () => {
      process.env.CRANK_DISABLED_DAYS = REHEARSAL;
      // The plan schedules these for 13:15 onward, actor "Any".
      assert.equal(resolvePause(at('2026-09-28T13:15:00Z')).paused, false);
      assert.equal(resolvePause(at('2026-10-05T13:30:00Z')).paused, false);
    });

    it('the boundary is UTC midnight, not local midnight', () => {
      process.env.CRANK_DISABLED_DAYS = '2026-09-28';
      // 23:30Z on the 27th is already the 28th in UTC+1..+12 and still the 27th in UTC.
      assert.equal(resolvePause(at('2026-09-27T23:30:00Z')).paused, false);
      assert.equal(resolvePause(at('2026-09-28T00:00:00Z')).paused, true);
      // 00:30Z on the 29th is still the 28th in UTC-1..-12 but is the 29th in UTC.
      assert.equal(resolvePause(at('2026-09-29T00:30:00Z')).paused, false);
      assert.equal(resolvePause(at('2026-09-28T23:59:59Z')).paused, true);
    });

    it('tolerates spaces and trailing commas in the list', () => {
      process.env.CRANK_DISABLED_DAYS = ' 2026-09-26 , 2026-09-27 ,';
      assert.equal(resolvePause(at('2026-09-26T06:00:00Z')).paused, true);
      assert.equal(resolvePause(at('2026-09-27T06:00:00Z')).paused, true);
    });

    it('an empty list pauses nothing', () => {
      process.env.CRANK_DISABLED_DAYS = '';
      assert.equal(resolvePause(at('2026-09-27T06:00:00Z')).paused, false);
      process.env.CRANK_DISABLED_DAYS = ' , , ';
      assert.equal(resolvePause(at('2026-09-27T06:00:00Z')).paused, false);
    });
  });

  describe('CRANK_DISABLED_WEEKDAYS', () => {
    it('matches the UTC weekday, case-insensitively', () => {
      process.env.CRANK_DISABLED_WEEKDAYS = 'saturday,SUNDAY';
      assert.equal(resolvePause(at('2026-09-26T12:00:00Z')).paused, true); // Saturday
      assert.equal(resolvePause(at('2026-09-27T12:00:00Z')).paused, true); // Sunday
      assert.equal(resolvePause(at('2026-09-28T12:00:00Z')).paused, false); // Monday
      assert.match(resolvePause(at('2026-09-27T12:00:00Z')).reason, /Sunday \(UTC\)/);
    });

    it('uses the UTC weekday even when the local weekday differs', () => {
      process.env.CRANK_DISABLED_WEEKDAYS = 'Sunday';
      // 2026-09-28T00:30:00Z is Monday UTC but Sunday in every negative offset.
      assert.equal(resolvePause(at('2026-09-28T00:30:00Z')).paused, false);
      // 2026-09-27T23:30:00Z is Sunday UTC but Monday in every positive offset.
      assert.equal(resolvePause(at('2026-09-27T23:30:00Z')).paused, true);
    });

    it('does not cover the whole rehearsal window on its own', () => {
      // 2026-09-27 is a Sunday but 2026-09-28 is a Monday, so a Sat/Sun weekday rule leaves
      // the second rehearsal day unpaused. CRANK_DISABLED_DAYS is the one that covers it.
      process.env.CRANK_DISABLED_WEEKDAYS = 'Saturday,Sunday';
      assert.equal(resolvePause(at('2026-09-27T12:00:00Z')).paused, true);
      assert.equal(resolvePause(at('2026-09-28T12:00:00Z')).paused, false);
    });

    it('tolerates spaces', () => {
      process.env.CRANK_DISABLED_WEEKDAYS = ' Sunday , Saturday ';
      assert.equal(resolvePause(at('2026-09-27T12:00:00Z')).paused, true);
    });
  });

  it('defaults to now when called with no argument', () => {
    assert.equal(typeof resolvePause().paused, 'boolean');
  });
});

describe('truthy', () => {
  it('treats the usual off values as off and everything else as on', () => {
    for (const v of [undefined, '', '0', 'false', 'FALSE', 'no', 'NO', 'off', 'OFF']) {
      assert.equal(truthy(v), false, JSON.stringify(v));
    }
    for (const v of ['1', 'true', 'yes', 'on', 'anything']) {
      assert.equal(truthy(v), true, JSON.stringify(v));
    }
  });
});

describe('CRANKER_PRIVATE_KEY validation', () => {
  /** Nothing derived from `value` may appear in `message`. */
  function assertNoLeak(message, value) {
    assert.ok(!message.includes(value), 'the whole value leaked into the error message');
    const stripped = value.replace(/^0x/, '');
    for (let i = 0; i + 4 <= stripped.length; i++) {
      const fragment = stripped.slice(i, i + 4);
      assert.ok(
        !message.includes(fragment),
        `the error message contains a 4-character fragment of the value ("${fragment}")`
      );
    }
  }

  const MALFORMED = [
    ['not hex at all', 'cafef00dbaadf00ddeadbeefsentinelvaluefeedfacefeedfacefeedfaceabc'],
    ['one char short', '0x' + 'ab'.repeat(31) + 'c'],
    ['one char long', '0x' + 'ab'.repeat(32) + 'c'],
    ['missing 0x prefix', 'ab'.repeat(32)],
    // Not a trailing newline: that is trimmed and accepted, because it is how the key
    // actually arrives (see "the key survives the whitespace it actually arrives with").
    // A newline in the MIDDLE is a real paste error that trimming cannot repair.
    ['split across two lines', PLACEHOLDER_KEY.slice(0, 34) + '\n' + PLACEHOLDER_KEY.slice(34)],
    ['quoted', `"${PLACEHOLDER_KEY}"`],
  ];

  for (const [label, value] of MALFORMED) {
    it(`rejects a ${label} key without echoing any of it`, () => {
      process.env.NETWORK = 'devnet';
      process.env.CRANKER_PRIVATE_KEY = value;

      let err;
      try {
        loadConfig(process.env);
      } catch (e) {
        err = e;
      }

      assert.ok(err, 'a malformed key was accepted');
      assert.ok(err instanceof ConfigError || err.isConfigError, 'not a ConfigError');
      assert.match(err.message, /CRANKER_PRIVATE_KEY/);
      assertNoLeak(err.message, value);
      assertNoLeak(String(err.stack ?? ''), value);
    });
  }

  it('rejects an absent key and points at the runbook', () => {
    process.env.NETWORK = 'devnet';
    let err;
    try {
      loadConfig(process.env);
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.match(err.message, /CRANKER_PRIVATE_KEY is not set/);
    assert.match(err.message, /WALLET\.md/);
  });

  it('accepts a shape-valid key', () => {
    process.env.NETWORK = 'devnet';
    process.env.CRANKER_PRIVATE_KEY = PLACEHOLDER_KEY;
    assert.doesNotThrow(() => loadConfig(process.env));
  });
});

describe('loadConfig', () => {
  beforeEach(() => {
    process.env.CRANKER_PRIVATE_KEY = PLACEHOLDER_KEY;
  });

  it('rejects an unknown NETWORK and lists the known ones', () => {
    process.env.NETWORK = 'mainnetz';
    assert.throws(() => loadConfig(process.env), (err) => {
      assert.match(err.message, /unknown NETWORK "mainnetz"/);
      assert.match(err.message, /devnet/);
      assert.match(err.message, /calibnet/);
      assert.match(err.message, /mainnet/);
      assert.ok(!err.message.includes('$comment'), 'the $comment key leaked into the hint');
      return true;
    });
  });

  it('carries the quarter geometry as BigInt', () => {
    process.env.NETWORK = 'calibnet';
    const c = loadConfig(process.env);
    for (const k of ['activationEpoch', 'epochsPerQuarter', 'postPeriod', 'verificationWindow', 'hold']) {
      assert.equal(typeof c.quarters[k], 'bigint', k);
      assert.equal(c.quarters[k], BigInt(NETWORKS.calibnet[k]), k);
    }
    assert.equal(typeof c.chainId, 'bigint');
  });

  it('marks a zero-address deployment as not deployed', () => {
    process.env.NETWORK = 'devnet';
    const c = loadConfig(process.env);
    assert.equal(c.deployed, false);
  });

  it('an SRA_ADDRESS/SWA_ADDRESS override makes it deployed', () => {
    process.env.NETWORK = 'devnet';
    process.env.SRA_ADDRESS = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
    process.env.SWA_ADDRESS = '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9';
    const c = loadConfig(process.env);
    assert.equal(c.deployed, true);
    assert.equal(c.addresses.sra, '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512');
  });

  it('rejects a malformed address override', () => {
    process.env.NETWORK = 'devnet';
    process.env.SRA_ADDRESS = '0xnope';
    assert.throws(() => loadConfig(process.env), /SRA_ADDRESS is not a valid address/);
  });

  it('bounds CRANK_MAX_GATE_CATCHUP', () => {
    process.env.NETWORK = 'devnet';
    for (const bad of ['0', '-1', '65', 'eight', '2.5']) {
      process.env.CRANK_MAX_GATE_CATCHUP = bad;
      assert.throws(() => loadConfig(process.env), /CRANK_MAX_GATE_CATCHUP/, `accepted ${bad}`);
    }
    process.env.CRANK_MAX_GATE_CATCHUP = '12';
    assert.equal(loadConfig(process.env).maxGateCatchup, 12);
    delete process.env.CRANK_MAX_GATE_CATCHUP;
    assert.equal(loadConfig(process.env).maxGateCatchup, 8);
  });

  it('rejects a non-numeric CRANK_MIN_BALANCE_FIL', () => {
    process.env.NETWORK = 'devnet';
    process.env.CRANK_MIN_BALANCE_FIL = 'lots';
    assert.throws(() => loadConfig(process.env), /CRANK_MIN_BALANCE_FIL/);
  });

  it('reads every setting from the `env` argument, including the secrets', () => {
    // Regression: requiredEnv/optionalAddress read process.env directly, so loadConfig(env)
    // honoured its argument for NETWORK and RPC_URL but silently ignored it for the three
    // settings that matter most -- the key and the two addresses.
    process.env.NETWORK = 'devnet';
    process.env.SRA_ADDRESS = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
    process.env.CRANKER_PRIVATE_KEY = PLACEHOLDER_KEY;

    const c = loadConfig({
      NETWORK: 'calibnet',
      CRANKER_PRIVATE_KEY: PLACEHOLDER_KEY,
      SRA_ADDRESS: '0x1111111111111111111111111111111111111111',
      SWA_ADDRESS: '0x2222222222222222222222222222222222222222',
    });

    assert.equal(c.networkName, 'calibnet');
    assert.equal(c.addresses.sra, '0x1111111111111111111111111111111111111111');
    assert.equal(c.addresses.swa, '0x2222222222222222222222222222222222222222');
  });

  it('finds a key passed in the argument even with requireKey false', () => {
    const c = loadConfig({ NETWORK: 'calibnet', CRANKER_PRIVATE_KEY: PLACEHOLDER_KEY }, { requireKey: false });
    assert.equal(c.privateKey, PLACEHOLDER_KEY);
  });

  it('does not pick up a key from process.env when the argument omits it', () => {
    process.env.CRANKER_PRIVATE_KEY = PLACEHOLDER_KEY;
    const c = loadConfig({ NETWORK: 'calibnet' }, { requireKey: false });
    assert.equal(c.privateKey, null, 'the argument is the whole environment, ambient state is not');
  });
});

describe('an unset GitHub Actions variable arrives as the empty string', () => {
  // This is not hypothetical. `${{ vars.FOO }}` on a repo that never defined FOO is
  // substituted as FOO="" -- not as an absent key -- so every optional setting used to take
  // '' as a deliberate value. It broke the very first scheduled run on calibnet:
  //   error CRANK_MIN_BALANCE_FIL is not a number:
  // Local tests never caught it because they either set a variable or deleted it, and never
  // set it to blank. This reproduces the real workflow environment.
  const CI_BLANKS = {
    SRA_ADDRESS: '', SWA_ADDRESS: '', CRANK_PAUSED: '', CRANK_DISABLED_DAYS: '',
    CRANK_DISABLED_WEEKDAYS: '', CRANK_MAX_GATE_CATCHUP: '', CRANK_MIN_BALANCE_FIL: '',
    CRANK_CONFIRMATIONS: '', CRANK_LOG_LEVEL: '', CRANK_TARGET_QUARTER: '',
    ALERT_TRANSPORT: '', ALERT_EMAIL_TO: '', ALERT_EMAIL_FROM: '',
    SENDGRID_API_KEY: '', RESEND_API_KEY: '', ALERT_WEBHOOK_URL: '', CRANK_STATE_DIR: '',
  };

  it('loads with every optional variable blank, exactly as the workflow passes them', () => {
    const config = loadConfig({ NETWORK: 'calibnet', CRANKER_PRIVATE_KEY: PLACEHOLDER_KEY, ...CI_BLANKS });

    assert.equal(config.networkName, 'calibnet');
    assert.equal(config.minBalanceFil, '0.1', 'blank must fall back to the network default');
    assert.equal(config.maxGateCatchup, 8);
    assert.equal(config.confirmations, 1);
    assert.equal(config.targetQuarter, null, 'blank must not become a forced target');
    assert.equal(config.stateDir, null);
    assert.equal(config.alerts.to, null);
    assert.deepEqual(config.alerts.transports, ['console']);
    // Blank addresses must fall through to the committed, deployed ones.
    assert.notEqual(config.addresses.sra, '0x0000000000000000000000000000000000000000');
    assert.equal(config.deployed, true);
  });

  it('a blank RPC_URL falls back to the network default rather than an empty URL', () => {
    const config = loadConfig({ NETWORK: 'calibnet', CRANKER_PRIVATE_KEY: PLACEHOLDER_KEY, RPC_URL: '' });
    assert.match(config.rpcUrl, /^https:\/\//);
  });

  it('a blank NETWORK is the default network, not an unknown one', () => {
    const config = loadConfig({ NETWORK: '', CRANKER_PRIVATE_KEY: PLACEHOLDER_KEY });
    assert.equal(config.networkName, 'calibnet');
  });

  it('blank pause variables do not pause', () => {
    const r = resolvePause(new Date('2026-09-24T19:00:00Z'), {
      CRANK_PAUSED: '', CRANK_DISABLED_DAYS: '', CRANK_DISABLED_WEEKDAYS: '',
    });
    assert.equal(r.paused, false);
  });
});

describe('the key survives the whitespace it actually arrives with', () => {
  // The WALLET.md generator writes the key with a final newline, and the obvious upload --
  // `gh secret set CRANKER_PRIVATE_KEY < ~/.solstice/cranker-calibnet.key` -- copies that
  // file byte for byte. A strict validator therefore rejected a correct key on every run.
  // Caught by checking the real file's length (67 bytes: 66 characters and a newline)
  // before uploading, not after a day of red runs.
  const KEY = PLACEHOLDER_KEY;

  for (const [label, value] of [
    ['a trailing newline', KEY + '\n'],
    ['a trailing CRLF', KEY + '\r\n'],
    ['a trailing space', KEY + ' '],
    ['surrounding spaces', ' ' + KEY + ' '],
  ]) {
    it(`accepts a key with ${label}, and stores it trimmed`, () => {
      const c = loadConfig({ NETWORK: 'calibnet', CRANKER_PRIVATE_KEY: value });
      assert.equal(c.privateKey, KEY);
    });
  }

  it('still rejects a key that is actually wrong', () => {
    assert.throws(() => loadConfig({ NETWORK: 'calibnet', CRANKER_PRIVATE_KEY: KEY.slice(0, -2) + '\n' }));
    assert.throws(() => loadConfig({ NETWORK: 'calibnet', CRANKER_PRIVATE_KEY: 'x' + KEY.slice(1) }));
  });
});

describe('CRANK_PAUSED_WINDOWS', () => {
  const W = '2026-10-03T19:00:00Z/2026-10-05T13:25:00Z';

  it('is half-open: paused from the start instant, running again at the end instant', () => {
    assert.equal(resolvePause(new Date('2026-10-03T19:00:00Z'), { CRANK_PAUSED_WINDOWS: W }).paused, true);
    assert.equal(resolvePause(new Date('2026-10-05T13:25:00Z'), { CRANK_PAUSED_WINDOWS: W }).paused, false);
  });

  it('names the window and its end in the reason, so the log says when it will resume', () => {
    const r = resolvePause(new Date('2026-10-04T12:00:00Z'), { CRANK_PAUSED_WINDOWS: W });
    assert.match(r.reason, /2026-10-05T13:25:00\.000Z/);
  });

  it('accepts several windows, and explicit offsets as well as Z', () => {
    const env = { CRANK_PAUSED_WINDOWS: `${W}, 2026-10-10T00:00:00+02:00/2026-10-10T06:00:00+02:00` };
    assert.equal(resolvePause(new Date('2026-10-09T23:00:00Z'), env).paused, true, '01:00 +02:00');
    assert.equal(resolvePause(new Date('2026-10-10T05:00:00Z'), env).paused, false, '07:00 +02:00');
  });

  for (const [label, bad] of [
    ['no timezone -- runner-local time is exactly the ambiguity to refuse', '2026-10-03T19:00/2026-10-05T13:25'],
    ['only one end', '2026-10-03T19:00:00Z'],
    ['end before start', '2026-10-05T13:25:00Z/2026-10-03T19:00:00Z'],
    ['a date with no time', '2026-10-03/2026-10-05'],
  ]) {
    it(`refuses ${label}, loudly, at config load`, () => {
      assert.throws(
        () => loadConfig({ NETWORK: 'calibnet', CRANKER_PRIVATE_KEY: PLACEHOLDER_KEY, CRANK_PAUSED_WINDOWS: bad }),
        /CRANK_PAUSED_WINDOWS/
      );
    });
  }

  it('a blank value, as GitHub passes an unset variable, pauses nothing', () => {
    assert.equal(resolvePause(new Date('2026-10-04T12:00:00Z'), { CRANK_PAUSED_WINDOWS: '' }).paused, false);
  });
});

describe('describeConfig never leaks a secret', () => {
  const SECRET_PATH_SEGMENT = 'sk-live-abcdef0123456789';
  const SECRET_QUERY_VALUE = 'qk-live-9876543210fedcba';

  beforeEach(() => {
    process.env.NETWORK = 'calibnet';
    process.env.CRANKER_PRIVATE_KEY = PLACEHOLDER_KEY;
    process.env.RPC_URL = `https://rpc.example.com/v1/${SECRET_PATH_SEGMENT}?apiKey=${SECRET_QUERY_VALUE}`;
  });

  it('omits the private key entirely', () => {
    const described = describeConfig(loadConfig(process.env));
    const serialised = JSON.stringify(described);
    assert.ok(!serialised.includes(PLACEHOLDER_KEY));
    assert.ok(!serialised.includes(PLACEHOLDER_KEY.slice(2)));
    assert.ok(!serialised.includes('1111'));
    assert.ok(!Object.keys(described).some((k) => /key|secret|private/i.test(k)));
    for (const v of Object.values(described)) {
      assert.notEqual(v, PLACEHOLDER_KEY);
    }
  });

  it('reduces the RPC URL to a host, dropping path and query', () => {
    const described = describeConfig(loadConfig(process.env));
    const serialised = JSON.stringify(described);
    assert.equal(described.rpcHost, 'rpc.example.com');
    assert.ok(!serialised.includes(SECRET_PATH_SEGMENT), 'the RPC path leaked');
    assert.ok(!serialised.includes(SECRET_QUERY_VALUE), 'the RPC query leaked');
    assert.ok(!serialised.includes('apiKey'));
    assert.ok(!serialised.includes('/v1/'));
  });

  it('keeps the alert API keys out of it too', () => {
    process.env.SENDGRID_API_KEY = 'SG.leak-me-not';
    try {
      const serialised = JSON.stringify(describeConfig(loadConfig(process.env)));
      assert.ok(!serialised.includes('SG.leak-me-not'));
    } finally {
      delete process.env.SENDGRID_API_KEY;
    }
  });

  it('describes the fields the operator needs and nothing secret-shaped', () => {
    const described = describeConfig(loadConfig(process.env));
    for (const key of ['network', 'chainId', 'rpcHost', 'sra', 'swa', 'deployed', 'dryRun']) {
      assert.ok(key in described, `describeConfig no longer reports ${key}`);
    }
    // Deliberately a property rather than a fixed key list: a new field is fine, a field that
    // looks like a credential is not, and neither is a nested object -- that is how a whole
    // config object ends up in a log by accident.
    for (const [key, value] of Object.entries(described)) {
      assert.ok(!/key|secret|private|password|token|mnemonic/i.test(key), `suspicious field: ${key}`);
      assert.notEqual(typeof value, 'object', `${key} is not a scalar`);
      assert.notEqual(typeof value, 'function', `${key} is not a scalar`);
    }
  });
});

describe('safeHost', () => {
  it('returns the host with its port and nothing else', () => {
    assert.equal(safeHost('https://api.node.glif.io/rpc/v1'), 'api.node.glif.io');
    assert.equal(safeHost('http://127.0.0.1:8545'), '127.0.0.1:8545');
    assert.equal(safeHost('https://user:pw@h.example.com/p?q=1#f'), 'h.example.com');
  });

  it('never throws, and never echoes an unparseable value', () => {
    for (const bad of ['', 'not a url', undefined, null]) {
      const out = safeHost(bad);
      assert.equal(out, '<unparseable RPC_URL>');
    }
  });
});
