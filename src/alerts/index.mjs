/**
 * Alerting.
 *
 * Transports are plain `fetch` against each provider's REST API rather than their SDKs, so
 * the production dependency list stays at exactly one package (ethers). A cron job that
 * holds a private key should pull in as little third-party code as it can.
 *
 * Delivery is best-effort and never throws into the caller: an alert that fails to send
 * must not turn a successful crank into a failed one, and must not mask the original
 * problem it was trying to report.
 */
import { log } from '../logger.mjs';

const SEVERITY_RANK = { info: 0, warn: 1, critical: 2 };

function renderText(alert) {
  const lines = [
    alert.body,
    '',
    `Network:  ${alert.context.network} (chain ${alert.context.chainId})`,
    `Cranker:  ${alert.context.cranker}`,
    `Epoch:    ${alert.context.epoch}`,
    `Balance:  ${alert.context.balanceFil} FIL`,
  ];
  if (alert.context.txHash) lines.push(`Tx:       ${alert.context.txHash}`);
  if (alert.context.explorerUrl) lines.push(`Explorer: ${alert.context.explorerUrl}`);
  if (alert.context.runUrl) lines.push(`Run log:  ${alert.context.runUrl}`);
  if (alert.detail) lines.push('', '---', alert.detail);
  return lines.join('\n');
}

async function sendConsole(alert) {
  const line = `[ALERT ${alert.severity}] ${alert.title}`;
  (alert.severity === 'info' ? log.info : alert.severity === 'warn' ? log.warn : log.error)(line);
  process.stderr.write(renderText(alert) + '\n');
  return { transport: 'console', ok: true };
}

async function post(url, headers, body, transport) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Trimmed: a provider error body can echo back request headers.
    throw new Error(`${transport} responded ${res.status}: ${text.slice(0, 200)}`);
  }
  return { transport, ok: true };
}

async function sendSendgrid(alert, config) {
  const { sendgridKey, to, from } = config.alerts;
  if (!sendgridKey) throw new Error('SENDGRID_API_KEY is not set');
  if (!to) throw new Error('ALERT_EMAIL_TO is not set');
  return post(
    'https://api.sendgrid.com/v3/mail/send',
    { authorization: `Bearer ${sendgridKey}` },
    {
      personalizations: [{ to: to.split(',').map((e) => ({ email: e.trim() })) }],
      from: { email: from, name: 'Solstice Cranker' },
      subject: `[${alert.severity}] ${alert.title}`,
      content: [{ type: 'text/plain', value: renderText(alert) }],
    },
    'sendgrid'
  );
}

async function sendResend(alert, config) {
  const { resendKey, to, from } = config.alerts;
  if (!resendKey) throw new Error('RESEND_API_KEY is not set');
  if (!to) throw new Error('ALERT_EMAIL_TO is not set');
  return post(
    'https://api.resend.com/emails',
    { authorization: `Bearer ${resendKey}` },
    {
      from: `Solstice Cranker <${from}>`,
      to: to.split(',').map((e) => e.trim()),
      subject: `[${alert.severity}] ${alert.title}`,
      text: renderText(alert),
    },
    'resend'
  );
}

async function sendWebhook(alert, config) {
  const url = config.alerts.webhookUrl;
  if (!url) throw new Error('ALERT_WEBHOOK_URL is not set');
  return post(url, {}, { ...alert, text: renderText(alert) }, 'webhook');
}

const TRANSPORTS = {
  console: sendConsole,
  sendgrid: sendSendgrid,
  resend: sendResend,
  webhook: sendWebhook,
};

/**
 * Collects alerts for a run and flushes them at the end.
 *
 * Batching matters: a catch-up run can raise the same warning several times, and eight
 * near-identical emails is how an inbox filter gets written. Duplicates are folded by
 * title and only the highest severity is reported.
 */
export class AlertSink {
  constructor(config) {
    this.config = config;
    this.alerts = [];
  }

  raise({ severity = 'warn', title, body, detail = null, context = {} }) {
    const existing = this.alerts.find((a) => a.title === title);
    if (existing) {
      if (SEVERITY_RANK[severity] > SEVERITY_RANK[existing.severity]) existing.severity = severity;
      existing.occurrences += 1;
      return existing;
    }
    const alert = {
      at: new Date().toISOString(),
      severity,
      title,
      body,
      detail,
      occurrences: 1,
      context: {
        network: this.config.networkName,
        chainId: Number(this.config.chainId),
        runUrl: this.config.runUrl,
        ...context,
      },
    };
    this.alerts.push(alert);
    return alert;
  }

  get worst() {
    return this.alerts.reduce(
      (acc, a) => (SEVERITY_RANK[a.severity] > SEVERITY_RANK[acc] ? a.severity : acc),
      'info'
    );
  }

  /** Sends everything raised at or above `minSeverity`. Never throws. */
  async flush({ minSeverity = 'warn' } = {}) {
    const due = this.alerts.filter((a) => SEVERITY_RANK[a.severity] >= SEVERITY_RANK[minSeverity]);
    if (due.length === 0) return [];

    const names = this.config.alerts.transports.length ? this.config.alerts.transports : ['console'];
    const results = [];

    for (const alert of due) {
      for (const name of names) {
        const transport = TRANSPORTS[name];
        if (!transport) {
          log.warn('unknown alert transport, skipping', { transport: name });
          results.push({ transport: name, ok: false, error: 'unknown transport' });
          continue;
        }
        try {
          results.push(await transport(alert, this.config));
        } catch (err) {
          // Reported, never rethrown -- see the note at the top of this file.
          log.error('alert delivery failed', { transport: name, error: err.message });
          results.push({ transport: name, ok: false, error: err.message });
          if (name !== 'console') await sendConsole(alert).catch(() => {});
        }
      }
    }
    return results;
  }
}
