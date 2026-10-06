#!/usr/bin/env node
/**
 * Builds config/rehearsal-schedule.json from the runbook's Schedule tab.
 *
 *   RUNBOOK_SHEET_ID=<id> npm run rehearsal:schedule     # fetch the runbook's CSV export
 *   npm run rehearsal:schedule -- --csv runbook.csv      # or a CSV you downloaded yourself
 *   npm run rehearsal:schedule -- --sheet <id> --check   # exit 1 if the committed file is stale
 *
 * The sheet id is deliberately not in this file. The runbook is shared by link, and this
 * repository is public: writing the id here would publish the whole runbook. Pass it with
 * --sheet or RUNBOOK_SHEET_ID; it is not recorded in the output either.
 *
 * Reads the sheet only. It issues one HTTP GET to the sheet's CSV export URL and nothing else;
 * there is no credential here and no code path that writes to Google. The output is a file in
 * this repository, which goes through review like any other change.
 *
 * Every Actor = "Cranker" row becomes one entry per call it sends. The Action column is prose, so
 * the parse is printed for a person to check, along with every assumption it made.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildScheduleFromCsv, callLabel, DEFAULT_GRACE_MINUTES } from '../src/rehearsal/schedule.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The Schedule tab's gid. Meaningless without the sheet id, which is supplied at run time. */
const SCHEDULE_TAB_GID = '112555194';

function args(argv) {
  const out = { csv: null, sheet: process.env.RUNBOOK_SHEET_ID || null, gid: process.env.RUNBOOK_SHEET_GID || SCHEDULE_TAB_GID, out: join(ROOT, 'config', 'rehearsal-schedule.json'), grace: DEFAULT_GRACE_MINUTES, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--csv') out.csv = next();
    else if (a === '--sheet') out.sheet = next();
    else if (a === '--gid') out.gid = next();
    else if (a === '--out') out.out = resolve(next());
    else if (a === '--grace-minutes') out.grace = Number(next());
    else if (a === '--check') out.check = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write('usage: build-rehearsal-schedule [--csv FILE | --sheet ID --gid GID] [--out FILE] [--grace-minutes N] [--check]\n');
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!Number.isFinite(out.grace) || out.grace < 0) throw new Error('--grace-minutes must be a number >= 0');
  return out;
}

async function readCsv(opts) {
  if (opts.csv) return { text: readFileSync(opts.csv, 'utf8'), source: { from: 'csv file' } };
  if (!opts.sheet) throw new Error('pass --csv FILE, or the runbook sheet id with --sheet ID or RUNBOOK_SHEET_ID');
  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(opts.sheet)}/export?format=csv&gid=${encodeURIComponent(opts.gid)}`;
  const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok || !type.includes('text/csv')) {
    throw new Error(`could not read the sheet's CSV export (HTTP ${res.status}, ${type || 'no content type'}). ` +
      'If it is not link-shared, download File -> Download -> CSV yourself and pass --csv.');
  }
  return { text: await res.text(), source: { from: 'runbook csv export', gid: opts.gid } };
}

async function main() {
  const opts = args(process.argv.slice(2));
  const { text, source } = await readCsv(opts);
  const { doc, warnings } = buildScheduleFromCsv(text, { graceMinutes: opts.grace });
  const json = JSON.stringify(doc, null, 2) + '\n';

  process.stderr.write(`${doc.entries.length} cranker call(s) from the ${source.from}\n\n`);
  for (const e of doc.entries) {
    const gate = e.gateQuarter === null ? '' : ` [gate must be at Q${e.gateQuarter}]`;
    process.stderr.write(`  ${e.id.padEnd(6)} ${e.notBefore}  ${callLabel(e).padEnd(22)} expect ${e.expect.padEnd(32)} ${e.status}${gate}\n`);
  }
  if (warnings.length) {
    process.stderr.write(`\nCheck these by hand -- the Action column is prose:\n`);
    for (const w of warnings) process.stderr.write(`  - ${w}\n`);
  }

  if (opts.check) {
    let current = '';
    try {
      current = readFileSync(opts.out, 'utf8');
    } catch {
      // missing counts as stale
    }
    if (current !== json) {
      process.stderr.write(`\n${opts.out} is out of date with the runbook. Rebuild it and review the diff.\n`);
      process.exitCode = 1;
    } else {
      process.stderr.write(`\n${opts.out} matches the runbook.\n`);
    }
    return;
  }
  writeFileSync(opts.out, json);
  process.stderr.write(`\nwrote ${opts.out}\n`);
}

main().catch((err) => {
  process.stderr.write(`build-rehearsal-schedule: ${err.message}\n`);
  process.exitCode = 1;
});
