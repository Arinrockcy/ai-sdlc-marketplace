#!/usr/bin/env node
// A stand-in for npm, put on PATH as `npm` by the tests. FAKE_NPM names a JSON file with the answers; every call is
// logged to FAKE_NPM_LOG so tests can check which commands ran and with which arguments.
import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync(process.env.FAKE_NPM, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_NPM_LOG, `${JSON.stringify(args)}\n`);

function answer(a) {
  if (a.stdout !== undefined) process.stdout.write(a.stdout);
  if (a.stderr) process.stderr.write(a.stderr);
  process.exit(a.code ?? 0);
}

const [cmd, sub] = args;
if (cmd === '--version') answer({ stdout: cfg.version ?? '11.0.0\n' });
if (cmd === 'audit' && sub === 'signatures') answer(cfg.signatures ?? { stdout: JSON.stringify({ invalid: [], missing: [] }) });
if (cmd === 'audit') answer(cfg.audit ?? { stdout: JSON.stringify({ auditReportVersion: 2, vulnerabilities: {} }) });
if (cmd === 'outdated') answer(cfg.outdated ?? { stdout: '' });
if (cmd === 'view') answer(cfg.views?.[args[1]] ?? { stdout: '' });
answer({ stderr: `unexpected npm command: ${args.join(' ')}`, code: 1 });
