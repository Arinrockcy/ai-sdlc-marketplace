import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { redact, applyWaivers, readLockfile } from '../scripts/guardian.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '../scripts/guardian.mjs');
const fixture = (name) => fs.readFileSync(path.join(HERE, 'fixtures', name), 'utf8');

const REG = (name, version) => `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
const pkgEntry = (name, version, extra = {}) => [`node_modules/${name}`, { version, resolved: REG(name, version), ...extra }];

// A project with a lockfile, a fake npm and a log of what the scan ran. `packages` maps lockfile keys to entries.
function scanProject({ pkg = { name: 't', version: '1.0.0', dependencies: {} }, packages = {}, lockfile, fake = {}, config, files = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-scan-'));
  const bin = path.join(dir, '.bin');
  fs.mkdirSync(bin);
  fs.copyFileSync(path.join(HERE, 'fake-npm.mjs'), path.join(bin, 'npm'));
  fs.chmodSync(path.join(bin, 'npm'), 0o755);
  fs.writeFileSync(path.join(dir, 'fake.json'), JSON.stringify(fake));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  const lock = lockfile ?? { name: pkg.name, lockfileVersion: 3, requires: true, packages: { '': { name: pkg.name }, ...packages } };
  if (lock) fs.writeFileSync(path.join(dir, 'package-lock.json'), typeof lock === 'string' ? lock : JSON.stringify(lock));
  if (config) {
    fs.mkdirSync(path.join(dir, '.dependency-guardian'));
    fs.writeFileSync(path.join(dir, '.dependency-guardian/config.json'), JSON.stringify({ version: 1, ...config }));
  }
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  const log = path.join(dir, 'npm.log');
  const run = (...args) => {
    fs.rmSync(log, { force: true });
    const r = spawnSync(process.execPath, [SCRIPT, 'scan', ...args], {
      cwd: dir, encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_NPM: path.join(dir, 'fake.json'), FAKE_NPM_LOG: log },
    });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    return { ...r, calls, json: args.includes('--json') && r.stdout ? JSON.parse(r.stdout) : null };
  };
  return { dir, run, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const withProject = (opts, fn) => { const p = scanProject(opts); try { return fn(p); } finally { p.done(); } };
const audit = (vulns) => ({ stdout: JSON.stringify({ auditReportVersion: 2, vulnerabilities: vulns, metadata: {} }), code: Object.keys(vulns).length ? 1 : 0 });
const vuln = (name, severity, over = {}) => ({ name, severity, isDirect: true, via: [{ source: 1, name, title: `Bad ${name}`, url: `https://github.com/advisories/${name}`, severity }], effects: [], range: '*', nodes: [`node_modules/${name}`], fixAvailable: true, ...over });
const byRule = (r, rule) => r.json.findings.filter((f) => f.rule === rule);

test('scan: a real npm 11 audit report fails the scan, with the advisories and the fix as evidence', () => {
  const lock = JSON.parse(fixture('lock-minimist.json'));
  withProject({ pkg: { name: 't', dependencies: { minimist: '1.2.0' } }, lockfile: lock, fake: { audit: { stdout: fixture('audit-npm11-minimist.json'), code: 1 } } }, (p) => {
    const r = p.run('--json');
    assert.equal(r.status, 1, r.stderr);
    assert.deepEqual([r.json.schemaVersion, r.json.status, r.json.complete, r.json.summary.blocking], [1, 'fail', true, 1]);
    const [f] = byRule(r, 'GUARD-AUDIT');
    assert.deepEqual([f.package, f.version, f.relationship, f.dependencyType, f.severity, f.action, f.source], ['minimist', '1.2.0', 'direct', 'dependencies', 'critical', 'deny', 'npm-audit']);
    assert.match(f.evidence.join('\n'), /GHSA-xvch-5gv4-984h/);
    assert.deepEqual(f.remediation, ['npm install minimist@1.2.8']);
    assert.equal(f.waiver, null);
    assert.deepEqual(Object.keys(r.json).sort(), ['complete', 'errors', 'findings', 'offline', 'projectRoot', 'schemaVersion', 'status', 'summary', 'toolVersions']);
    assert.deepEqual(Object.keys(f).sort(), ['action', 'alternatives', 'dependencyType', 'evidence', 'id', 'package', 'relationship', 'remediation', 'rule', 'severity', 'source', 'version', 'waiver']);
    assert.deepEqual(r.json.toolVersions, { guardian: r.json.toolVersions.guardian, node: process.versions.node, npm: '11.0.0' });
    assert.ok(r.calls.some((a) => a.join(' ') === 'audit --json --audit-level=moderate'));
  });
});

test('scan: only audit, outdated, view and version are ever run, never anything that changes the project', () => {
  withProject({ pkg: { name: 't', dependencies: { a: '1.0.0' } }, packages: Object.fromEntries([pkgEntry('a', '1.0.0')]), config: { signatures: true } }, (p) => {
    const r = p.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const verbs = new Set(r.calls.map((a) => a[0]));
    assert.deepEqual([...verbs].sort(), ['--version', 'audit', 'outdated', 'view']);
    for (const a of r.calls) assert.ok(!a.some((x) => /^(install|i|add|update|ci|uninstall|exec|run)$/.test(x)), a.join(' '));
  });
});

test('scan: severities at or above the threshold block; lower ones are informational; the threshold is configurable', () => {
  const packages = Object.fromEntries([pkgEntry('lo', '1.0.0'), pkgEntry('mid', '1.0.0'), pkgEntry('hi', '1.0.0')]);
  const pkg = { name: 't', dependencies: { lo: '1', mid: '1', hi: '1' } };
  const fake = { audit: audit({ lo: vuln('lo', 'low'), mid: vuln('mid', 'moderate'), hi: vuln('hi', 'high') }) };
  withProject({ pkg, packages, fake }, (p) => {
    const r = p.run('--json');
    assert.equal(r.status, 1);
    const actions = Object.fromEntries(byRule(r, 'GUARD-AUDIT').map((f) => [f.package, f.action]));
    assert.deepEqual(actions, { lo: 'info', mid: 'deny', hi: 'deny' });
    assert.deepEqual([r.json.summary.blocking, r.json.summary.informational], [2, 1]);
  });
  withProject({ pkg, packages, fake, config: { auditLevel: 'high' } }, (p) => {
    const r = p.run('--json');
    assert.deepEqual(Object.fromEntries(byRule(r, 'GUARD-AUDIT').map((f) => [f.package, f.action])), { lo: 'info', mid: 'info', hi: 'deny' });
    assert.ok(r.calls.some((a) => a.includes('--audit-level=high')));
  });
  withProject({ pkg, packages, fake: { audit: audit({ lo: vuln('lo', 'low') }) } }, (p) => {
    const r = p.run();
    assert.equal(r.status, 0, 'a low finding alone passes');
    assert.match(r.stdout, /^dependency-guardian .*: PASS: 0 blocking, 0 warning\(s\), 1 informational/);
  });
});

test('scan: a transitive vulnerability names how it was reached, and the fix when npm has none', () => {
  const packages = Object.fromEntries([pkgEntry('top', '1.0.0'), pkgEntry('deep', '2.0.0')]);
  const fake = { audit: audit({ deep: vuln('deep', 'high', { isDirect: false, fixAvailable: false }), top: { ...vuln('top', 'high', { fixAvailable: true }), via: ['deep'] } }) };
  withProject({ pkg: { name: 't', dependencies: { top: '1' } }, packages, fake }, (p) => {
    const r = p.run('--json');
    const [deep] = byRule(r, 'GUARD-AUDIT').filter((f) => f.package === 'deep');
    const [top] = byRule(r, 'GUARD-AUDIT').filter((f) => f.package === 'top');
    assert.deepEqual([deep.relationship, deep.dependencyType, deep.version, deep.remediation], ['transitive', 'transitive', '2.0.0', ['No fix is available yet']]);
    assert.deepEqual([top.evidence, top.remediation], [['Through deep'], ['npm audit fix']]);
  });
});

test('scan: an audit that cannot finish, or output from an old npm, exits 2 and never passes', () => {
  const cases = [
    ['registry failure', { audit: { stdout: JSON.stringify({ message: 'request to https://r.test failed, reason: ECONNREFUSED', error: { summary: '' } }), code: 1 } }, /npm audit failed: request to https:\/\/r\.test failed/],
    ['not JSON', { audit: { stdout: 'oops', code: 1, stderr: 'npm error boom' } }, /npm audit failed/],
    ['npm 6 output', { audit: { stdout: JSON.stringify({ advisories: {}, metadata: {} }), code: 0 } }, /npm audit returned output this version cannot read/],
  ];
  for (const [name, fake, re] of cases) {
    withProject({ fake }, (p) => {
      const r = p.run('--json');
      assert.equal(r.status, 2, name);
      assert.equal(r.json.status, 'error', name);
      assert.match(r.json.errors.join() + r.json.error, re, name);
    });
  }
  withProject({ fake: cases[0][1] }, (p) => assert.match(p.run().stdout, /^dependency-guardian .*: ERROR/));
});

test('scan: credentials from npm output never reach the report', () => {
  assert.equal(redact('//registry.npmjs.org/:_authToken=abc123secret'), '//registry.npmjs.org/:_authToken=[redacted]');
  assert.equal(redact('GET https://user:pa55@registry.test/x failed'), 'GET https://[redacted]@registry.test/x failed');
  assert.equal(redact(`token npm_${'a'.repeat(30)} used`), 'token [redacted] used');
  withProject({
    files: { '.npmrc': '//registry.npmjs.org/:_authToken=npm_SECRETSECRETSECRETSECRET123\n' },
    fake: { audit: { stdout: JSON.stringify({ message: 'failed for //registry.npmjs.org/:_authToken=sekrit and https://bob:hunter2@r.test/', error: {} }), code: 1 } },
  }, (p) => {
    const r = p.run('--json');
    for (const secret of ['sekrit', 'hunter2', 'SECRETSECRET']) assert.ok(!(r.stdout + r.stderr).includes(secret), `${secret} leaked`);
    assert.match(r.stdout, /\[redacted\]/);
  });
});

test('scan: Moment.js is denied when direct and only a warning when transitive, with alternatives and sources', () => {
  withProject({ pkg: { name: 't', dependencies: { moment: '2.29.4' } }, packages: Object.fromEntries([pkgEntry('moment', '2.29.4')]) }, (p) => {
    const r = p.run('--json');
    assert.equal(r.status, 1);
    const [f] = byRule(r, 'NPM-MOMENT');
    assert.deepEqual([f.relationship, f.action, f.source], ['direct', 'deny', 'catalog']);
    assert.deepEqual(f.alternatives.map((a) => a.name), ['Intl and Date', 'Temporal', 'date-fns', 'Luxon', 'Day.js']);
    assert.ok(f.evidence.some((e) => e.startsWith('Source: https://momentjs.com/')));
    assert.match(p.run().stdout, /BLOCK  NPM-MOMENT moment@2\.29\.4 \(direct, dependencies, high\)[\s\S]*Alternatives: Intl and Date/);
  });
  withProject({ pkg: { name: 't', dependencies: { top: '1' } }, packages: Object.fromEntries([pkgEntry('top', '1.0.0'), ['node_modules/top/node_modules/moment', { version: '2.0.0', resolved: REG('moment', '2.0.0') }]]) }, (p) => {
    const r = p.run('--json');
    assert.equal(r.status, 0, 'a transitive Moment does not fail the scan');
    const [f] = byRule(r, 'NPM-MOMENT');
    assert.deepEqual([f.relationship, f.action, f.dependencyType, f.version], ['transitive', 'warn', 'transitive', '2.0.0']);
  });
});

test('scan: organization rules in the configuration apply like catalog rules', () => {
  const rule = { id: 'ORG-NOLEFTPAD', package: 'left-pad', direct: 'deny', transitive: 'warn', rationale: 'Use String.prototype.padStart.' };
  withProject({ pkg: { name: 't', dependencies: { 'left-pad': '1' } }, packages: Object.fromEntries([pkgEntry('left-pad', '1.3.0')]), config: { rules: [rule] } }, (p) => {
    const r = p.run('--json');
    assert.equal(r.status, 1);
    assert.deepEqual(byRule(r, 'ORG-NOLEFTPAD').map((f) => f.action), ['deny']);
  });
});

test('scan: a direct deprecated version is denied by default, a warning when configured, and the lockfile covers transitive ones', () => {
  const pkg = { name: 't', dependencies: { old: '1' } };
  const packages = Object.fromEntries([pkgEntry('old', '1.0.0'), pkgEntry('dep', '3.0.0', { deprecated: 'dep is no longer supported' })]);
  const fake = { views: { 'old@1.0.0': { stdout: JSON.stringify('old has been deprecated, use new') } } };
  withProject({ pkg, packages, fake }, (p) => {
    const r = p.run('--json');
    assert.equal(r.status, 1);
    const found = Object.fromEntries(byRule(r, 'GUARD-DEPRECATED').map((f) => [f.package, f]));
    assert.deepEqual([found.old.action, found.old.source, found.old.relationship], ['deny', 'npm-view', 'direct']);
    assert.deepEqual(found.old.evidence, ['old has been deprecated, use new']);
    assert.deepEqual([found.dep.action, found.dep.source, found.dep.relationship], ['warn', 'lockfile', 'transitive']);
    assert.ok(r.calls.some((a) => a.join(' ') === 'view old@1.0.0 deprecated --json'));
  });
  withProject({ pkg, packages, fake, config: { deprecated: 'warn' } }, (p) => {
    const r = p.run('--json');
    assert.equal(r.status, 0);
    assert.equal(byRule(r, 'GUARD-DEPRECATED').find((f) => f.package === 'old').action, 'warn');
  });
  // The registry saying nothing means "not deprecated"; an error means the assessment is incomplete.
  withProject({ pkg, packages: Object.fromEntries([pkgEntry('old', '1.0.0')]), fake: { views: { 'old@1.0.0': { stdout: JSON.stringify({ error: { code: 'E404', summary: 'Not Found' } }), code: 1 } } } }, (p) => {
    const r = p.run('--json');
    assert.deepEqual([r.status, r.json.status], [2, 'error']);
    assert.match(r.json.errors[0], /npm view old@1\.0\.0 failed: Not Found/);
  });
});

test('scan: outdated direct dependencies warn by default, can block, and can be turned off', () => {
  const pkg = { name: 't', dependencies: { a: '1' } };
  const packages = Object.fromEntries([pkgEntry('a', '1.0.0')]);
  const fake = { outdated: { stdout: JSON.stringify({ a: { current: '1.0.0', wanted: '1.2.0', latest: '2.0.0' }, ghost: { wanted: '1', latest: '2' } }), code: 1 } };
  withProject({ pkg, packages, fake }, (p) => {
    const r = p.run('--json');
    assert.equal(r.status, 0);
    const [f] = byRule(r, 'GUARD-OUTDATED');
    assert.deepEqual([f.action, f.version, f.evidence[0]], ['warn', '1.0.0', '1.0.0 is installed; the latest is 2.0.0 (1.2.0 satisfies the range)']);
    assert.equal(byRule(r, 'GUARD-OUTDATED').length, 1, 'packages that are not direct dependencies are ignored');
  });
  withProject({ pkg, packages, fake, config: { outdated: 'deny' } }, (p) => assert.equal(p.run().status, 1));
  withProject({ pkg, packages, fake, config: { outdated: 'off' } }, (p) => {
    const r = p.run('--json');
    assert.equal(byRule(r, 'GUARD-OUTDATED').length, 0);
    assert.ok(!r.calls.some((a) => a[0] === 'outdated'));
  });
  // Without node_modules npm gives no current version; the lockfile has it.
  withProject({ pkg, packages, fake: { outdated: { stdout: JSON.stringify({ a: { wanted: '1.0.0', latest: '1.0.1' } }), code: 1 } } }, (p) => assert.equal(byRule(p.run('--json'), 'GUARD-OUTDATED')[0].version, '1.0.0'));
});

test('scan: a package that is not installed from a registry cannot be assessed and is denied', () => {
  const packages = Object.fromEntries([
    ['node_modules/gitdep', { version: '1.0.0', resolved: 'git+ssh://git@github.com/o/r.git#abc' }],
    ['node_modules/tarball', { version: '1.0.0', resolved: 'https://example.test/pkg.tgz' }],
    ['node_modules/private', { version: '1.0.0', resolved: 'https://npm.corp.test/private/-/private-1.0.0.tgz' }],
    ['node_modules/nores', { version: '1.0.0' }],
  ]);
  withProject({ pkg: { name: 't', dependencies: { gitdep: '1', tarball: '1', private: '1', nores: '1' } }, packages }, (p) => {
    const r = p.run('--json');
    assert.equal(r.status, 1);
    assert.deepEqual(byRule(r, 'GUARD-SOURCE').map((f) => f.package).sort(), ['gitdep', 'tarball']);
    assert.ok(byRule(r, 'GUARD-SOURCE').every((f) => f.action === 'deny'));
  });
});

test('waivers: an active one makes a finding non-blocking and stays visible, scoped to its rule and package', () => {
  const pkg = { name: 't', dependencies: { moment: '2', 'left-pad': '1' } };
  const packages = Object.fromEntries([pkgEntry('moment', '2.29.4'), pkgEntry('left-pad', '1.3.0')]);
  const rule = { id: 'ORG-NOLEFTPAD', package: 'left-pad', direct: 'deny', transitive: 'warn', rationale: 'Use padStart.' };
  const waiver = { ruleId: 'NPM-MOMENT', package: 'moment', owner: 'team-a', reason: 'Migration tracked in PLAT-12', expiresAt: '2999-01-01' };
  withProject({ pkg, packages, config: { rules: [rule], waivers: [waiver] } }, (p) => {
    const r = p.run('--json');
    const moment = byRule(r, 'NPM-MOMENT')[0];
    assert.deepEqual(moment.waiver, { state: 'active', owner: 'team-a', reason: 'Migration tracked in PLAT-12', expiresAt: '2999-01-01' });
    assert.equal(r.json.summary.waived, 1);
    assert.equal(byRule(r, 'ORG-NOLEFTPAD')[0].waiver, null, 'another package is not covered');
    assert.equal(r.status, 1);
    assert.match(p.run().stdout, /WAIVED NPM-MOMENT moment@2\.29\.4[\s\S]*Waiver: active, owner team-a, until 2999-01-01/);
  });
  // A waiver for another rule on the same package does not apply.
  withProject({ pkg, packages, config: { waivers: [{ ...waiver, ruleId: 'GUARD-AUDIT' }] } }, (p) => assert.equal(p.run().status, 1));
  withProject({ pkg: { name: 't', dependencies: { moment: '2' } }, packages: Object.fromEntries([pkgEntry('moment', '2.29.4')]), config: { waivers: [waiver] } }, (p) => assert.equal(p.run().status, 0));
});

test('waivers: an expired one blocks again, with a finding of its own, and applyWaivers honours the expiry boundary', () => {
  const waiver = { ruleId: 'NPM-MOMENT', package: 'moment', owner: 'team-a', reason: 'Migration', expiresAt: '2020-01-01' };
  withProject({ pkg: { name: 't', dependencies: { moment: '2' } }, packages: Object.fromEntries([pkgEntry('moment', '2.29.4')]), config: { waivers: [waiver] } }, (p) => {
    const r = p.run('--json');
    assert.equal(r.status, 1);
    assert.equal(byRule(r, 'NPM-MOMENT')[0].waiver.state, 'expired');
    assert.match(byRule(r, 'GUARD-WAIVER')[0].evidence[0], /waiver of NPM-MOMENT for moment \(owner team-a\) expired on 2020-01-01/);
  });
  // The waiver covers no package at all any more, and still fails the scan.
  withProject({ config: { waivers: [waiver] } }, (p) => assert.equal(p.run().status, 1));
  const f = () => [{ id: 'x', rule: 'NPM-MOMENT', package: 'moment', action: 'deny', waiver: null }];
  const w = { ...waiver, expiresAt: '2026-10-07' };
  assert.equal(applyWaivers(f(), [w], new Date('2026-10-07T23:59:59Z'))[0].waiver.state, 'active');
  assert.equal(applyWaivers(f(), [w], new Date('2026-10-08T00:00:00Z'))[0].waiver.state, 'expired');
  // A waiver of the waiver rule is refused when the configuration is read.
  withProject({ config: { waivers: [{ ...waiver, ruleId: 'GUARD-WAIVER', expiresAt: '2999-01-01' }] } }, (p) => assert.match(p.run().stderr, /GUARD-WAIVER cannot be waived/));
});

test('scan: a missing or unreadable lockfile is an error with the safe command to create one', () => {
  withProject({ lockfile: null }, (p) => {
    fs.rmSync(path.join(p.dir, 'package-lock.json'), { force: true });
    const r = p.run();
    assert.equal(r.status, 2);
    assert.match(r.stderr, /package-lock\.json is missing[\s\S]*npm install --package-lock-only --ignore-scripts/);
    assert.equal(p.run('--json').json.status, 'error');
  });
  withProject({ lockfile: { lockfileVersion: 1, dependencies: {} } }, (p) => assert.match(p.run().stderr, /lockfileVersion 1, which this version cannot read/));
  withProject({ lockfile: '{broken' }, (p) => assert.match(p.run().stderr, /package-lock\.json is not valid JSON/));
  assert.throws(() => readLockfile(os.tmpdir() + '/nowhere-' + process.pid), /package-lock\.json is missing/);
});

test('scan: an offline scan runs no npm at all, reports what it skipped, and can never pass strict CI', () => {
  const pkg = { name: 't', dependencies: { moment: '2', ok: '1' } };
  const packages = Object.fromEntries([pkgEntry('moment', '2.29.4'), pkgEntry('ok', '1.0.0', { deprecated: 'ok is deprecated' })]);
  withProject({ pkg, packages }, (p) => {
    const r = p.run('--offline', '--json');
    assert.deepEqual(p.calls ?? [], []);
    assert.deepEqual([r.status, r.json.offline, r.json.complete, r.calls.length], [1, true, false, 0]);
    assert.ok(byRule(r, 'GUARD-DEPRECATED').length, 'the lockfile still reports deprecations');
    assert.match(p.run('--offline').stdout, /Offline: only the catalog and the lockfile were checked/);
  });
  withProject({ pkg: { name: 't', dependencies: { ok: '1' } }, packages: Object.fromEntries([pkgEntry('ok', '1.0.0')]) }, (p) => {
    const loose = p.run('--offline', '--json');
    assert.deepEqual([loose.status, loose.json.status, loose.json.complete], [0, 'pass', false]);
    const strict = p.run('--offline', '--ci', '--json');
    assert.deepEqual([strict.status, strict.json.status], [2, 'error']);
    assert.match(strict.json.errors[0], /cannot pass strict CI/);
  });
});

test('scan: workspaces are classified from each workspace\'s own package.json and can be selected', () => {
  const dir0 = { name: 't', workspaces: ['packages/*'] };
  const lockfile = {
    lockfileVersion: 3, packages: {
      '': { name: 't', workspaces: ['packages/*'] },
      'packages/api': { name: 'api', version: '1.0.0', dependencies: { moment: '2' } },
      'packages/web': { name: 'web', version: '1.0.0', dependencies: { 'left-pad': '1' } },
      'node_modules/api': { resolved: 'packages/api', link: true },
      'node_modules/web': { resolved: 'packages/web', link: true },
      ...Object.fromEntries([pkgEntry('moment', '2.29.4'), pkgEntry('left-pad', '1.3.0')]),
    },
  };
  const rule = { id: 'ORG-NOLEFTPAD', package: 'left-pad', direct: 'deny', transitive: 'warn', rationale: 'Use padStart.' };
  const files = { 'packages/api/package.json': JSON.stringify({ name: 'api', dependencies: { moment: '2' } }), 'packages/web/package.json': JSON.stringify({ name: 'web', dependencies: { 'left-pad': '1' } }) };
  const make = (extra = {}) => { const p = scanProject({ pkg: dir0, lockfile, config: { rules: [rule] }, ...extra }); for (const [n, c] of Object.entries(files)) { fs.mkdirSync(path.join(p.dir, path.dirname(n)), { recursive: true }); fs.writeFileSync(path.join(p.dir, n), c); } return p; };
  let p = make();
  try {
    const r = p.run('--json');
    assert.deepEqual([r.json.summary.direct, r.json.summary.packages], [2, 2]);
    assert.deepEqual([byRule(r, 'NPM-MOMENT')[0].action, byRule(r, 'ORG-NOLEFTPAD')[0].action], ['deny', 'deny']);
    const api = p.run('--workspace', 'api', '--json');
    assert.equal(api.json.summary.direct, 1);
    assert.deepEqual([byRule(api, 'NPM-MOMENT')[0].action, byRule(api, 'ORG-NOLEFTPAD')[0].action], ['deny', 'warn'], 'left-pad is outside the selected workspace');
    assert.ok(api.calls.some((a) => a[0] === 'audit' && a.includes('--workspace=api')));
    assert.ok(api.calls.some((a) => a[0] === 'outdated' && a.includes('--workspace=api')));
    assert.match(p.run('--workspace', 'nope').stderr, /Unknown workspace "nope". Workspaces: api, web/);
    assert.match(p.run('--workspace').stderr, /--workspace needs a value/);
  } finally { p.done(); }
  p = make({ config: { rules: [rule], workspaces: ['web'] } });
  try { assert.equal(byRule(p.run('--json'), 'NPM-MOMENT')[0].action, 'warn', 'the configured selection applies without the flag'); } finally { p.done(); }
});

test('scan: signatures are checked only when asked for; invalid ones block, missing ones warn unless enforced', () => {
  const pkg = { name: 't', dependencies: { a: '1', b: '1' } };
  const packages = Object.fromEntries([pkgEntry('a', '1.0.0'), pkgEntry('b', '1.0.0')]);
  const fake = { signatures: { stdout: JSON.stringify({ invalid: [{ name: 'a', version: '1.0.0' }], missing: [{ name: 'b', version: '1.0.0' }] }), code: 1 } };
  withProject({ pkg, packages, fake }, (p) => {
    assert.ok(!p.run('--json').calls.some((a) => a[1] === 'signatures'), 'not run by default');
    const r = p.run('--signatures', '--json');
    assert.equal(r.status, 1);
    assert.deepEqual(Object.fromEntries(byRule(r, 'GUARD-SIGNATURE').map((f) => [f.package, f.action])), { a: 'deny', b: 'warn' });
    assert.ok(r.calls.some((a) => a.join(' ') === 'audit signatures --json'));
  });
  withProject({ pkg, packages, fake, config: { signatures: true } }, (p) => {
    const r = p.run('--json');
    assert.deepEqual(Object.fromEntries(byRule(r, 'GUARD-SIGNATURE').map((f) => [f.package, f.action])), { a: 'deny', b: 'deny' }, 'enforced by the configuration');
  });
  withProject({ pkg, packages, fake: { signatures: { stdout: 'nope', code: 1 } } }, (p) => assert.equal(p.run('--signatures', '--json').json.status, 'error'));
});

test('scan: a blocking finding wins over an incomplete assessment, and --ci --json combine', () => {
  withProject({ pkg: { name: 't', dependencies: { moment: '2' } }, packages: Object.fromEntries([pkgEntry('moment', '2.29.4')]), fake: { audit: { stdout: 'broken', code: 1 } } }, (p) => {
    const r = p.run('--ci', '--json');
    assert.deepEqual([r.status, r.json.status, r.json.complete], [1, 'fail', false]);
    assert.equal(r.json.errors.length, 1, 'the failed audit is still reported');
  });
});

test('scan: with --json a scan that cannot start still answers in JSON, with exit 2', () => {
  withProject({ lockfile: null }, (p) => {
    fs.rmSync(path.join(p.dir, 'package-lock.json'), { force: true });
    const r = p.run('--json');
    const out = JSON.parse(r.stdout);
    assert.deepEqual([r.status, out.schemaVersion, out.status, out.findings], [2, 1, 'error', []]);
    assert.match(out.error, /package-lock\.json is missing/);
  });
});
