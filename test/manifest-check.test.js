'use strict';
/*
 * Checks `release.js --check`, which fails when manifest.json doesn't match
 * the app's files. Works on a throwaway copy of the project.
 * Run with `node test/manifest-check.test.js`.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reskin-manifest-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function fresh() {
  const dir = path.join(tmp, 'p' + (++n));
  fs.mkdirSync(dir);
  ['main.js', 'preload.js', 'theme.js', 'sidebar-data.js', 'package.json', 'shell', 'fonts', 'scripts'].forEach((f) => {
    fs.cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });
  });
  run(dir, []); // a proper release: the manifest now matches
  return dir;
}
function run(dir, args) {
  return spawnSync(process.execPath, [path.join(dir, 'scripts', 'release.js'), ...args], { cwd: dir, encoding: 'utf8' });
}
const check = (dir) => run(dir, ['--check']);
const append = (dir, f, text) => fs.appendFileSync(path.join(dir, f), text);

const tests = [
  ['passes right after a release', () => {
    const r = check(fresh());
    assert.equal(r.status, 0, r.stderr);
  }],
  ['fails when an app file changes without a release, and names it', () => {
    const dir = fresh();
    append(dir, 'theme.js', '\n// edited\n');
    const r = check(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /theme\.js has changed/);
    assert.match(r.stderr, /npm run release/);
  }],
  ['fails for each changed file, shell files included', () => {
    const dir = fresh();
    append(dir, 'shell/shell.css', '\n/* x */\n');
    append(dir, 'shell/index.html', '\n<!-- x -->\n');
    const r = check(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /shell\/shell\.css has changed/);
    assert.match(r.stderr, /shell\/index\.html has changed/);
  }],
  ['fails when a new app file is not in the manifest', () => {
    const dir = fresh();
    fs.writeFileSync(path.join(dir, 'shell', 'extra.js'), '// new\n');
    const r = check(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /shell\/extra\.js is not in manifest\.json/);
  }],
  ['fails when a listed file is deleted', () => {
    const dir = fresh();
    fs.rmSync(path.join(dir, 'preload.js'));
    const r = check(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /preload\.js is in manifest\.json but no longer exists/);
  }],
  ['fails when the version in package.json was bumped without a release', () => {
    const dir = fresh();
    const p = path.join(dir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
    pkg.version = '9.9.9';
    fs.writeFileSync(p, JSON.stringify(pkg, null, 2));
    const r = check(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /manifest\.json says v.* but package\.json says v9\.9\.9/);
  }],
  ['fails when manifest.json is missing or broken', () => {
    const dir = fresh();
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{ not json');
    assert.equal(check(dir).status, 1);
    fs.rmSync(path.join(dir, 'manifest.json'));
    assert.equal(check(dir).status, 1);
  }],
  ['ignores files that are not downloaded by the app', () => {
    const dir = fresh();
    append(dir, 'scripts/release.js', '\n// not part of an update\n');
    fs.writeFileSync(path.join(dir, 'README.md'), 'changed');
    assert.equal(check(dir).status, 0);
  }],
  ['--check changes nothing', () => {
    const dir = fresh();
    append(dir, 'theme.js', '\n// edited\n');
    const before = ['manifest.json', 'package.json'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
    check(dir);
    assert.deepEqual(['manifest.json', 'package.json'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8')), before);
  }],
  ['the real project passes', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'release.js'), '--check'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }]
];

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log('ok   ' + name); }
  catch (err) { failed++; console.log('FAIL ' + name + '\n     ' + String(err.message).split('\n').slice(0, 3).join('\n     ')); }
}
console.log(`\nmanifest check: ${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
