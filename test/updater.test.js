'use strict';
/*
 * Exercises bootstrap.js's updater without Electron: `electron` is replaced
 * by a stub whose net.fetch serves files from a local "remote" folder in
 * place of GitHub. Run with `node test/updater.test.js`.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reskin-updater-'));
const bundled = path.join(tmp, 'bundled');
const remote = path.join(tmp, 'remote');
const userData = path.join(tmp, 'userData');
const RAW = 'https://raw.githubusercontent.com/Dylz101/claude-reskin/main/';

function copyProject(dest) {
  ['bootstrap.js', 'main.js', 'preload.js', 'theme.js', 'package.json', 'shell', 'fonts', 'scripts'].forEach((f) => {
    fs.cpSync(path.join(ROOT, f), path.join(dest, f), { recursive: true });
  });
}
function release(dir) {
  execFileSync(process.execPath, [path.join(dir, 'scripts', 'release.js')], { cwd: dir, stdio: 'ignore' });
  return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stub electron. main.js is loaded by bootstrap; refusing the single-instance
// lock makes it quit immediately instead of opening windows.
const stub = {
  app: {
    getPath: () => userData,
    whenReady: () => new Promise(() => {}), // never: we drive the updater by hand
    requestSingleInstanceLock: () => false,
    quit: () => {}, on: () => {}
  },
  net: {
    fetch: async (url) => {
      const rel = decodeURIComponent(url.replace(RAW, '').replace(/\?.*$/, ''));
      try {
        const buf = fs.readFileSync(path.join(remote, rel));
        return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
      } catch { return { ok: false, status: 404 }; }
    }
  }
};
['BaseWindow', 'WebContentsView', 'ipcMain', 'Menu', 'nativeTheme', 'session', 'shell', 'dialog', 'clipboard'].forEach((k) => { stub[k] = {}; });
const origLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'electron' ? stub : origLoad.call(this, request, ...rest); };

function loadBootstrap() {
  delete global.reskinUpdater;
  Object.keys(require.cache).filter((k) => k.startsWith(tmp)).forEach((k) => delete require.cache[k]);
  require(path.join(bundled, 'bootstrap.js'));
  return global.reskinUpdater;
}
function nextReady(updater) {
  return new Promise((resolve, reject) => {
    updater.once('ready', resolve);
    updater.once('status', (s) => { if (s.state === 'error') reject(new Error(s.message)); });
  });
}

(async () => {
  let passed = 0;
  const ok = (name) => { passed++; console.log('ok', name); };

  copyProject(bundled);
  const base = release(bundled);
  await sleep(1100); // builds are timestamped to the second
  copyProject(remote);

  // 1. Up to date: nothing happens.
  fs.cpSync(path.join(bundled, 'manifest.json'), path.join(remote, 'manifest.json'));
  let u = loadBootstrap();
  assert.equal(u.dir, bundled);
  const statuses = [];
  u.on('status', (s) => statuses.push(s.state));
  await u.check(true);
  assert.equal(statuses.pop(), 'current');
  ok('reports current when GitHub has nothing newer');

  // 2. A shell-only change is a hot update.
  fs.appendFileSync(path.join(remote, 'shell', 'shell.css'), '\n/* hot change */\n');
  const hot = release(remote);
  let ready = nextReady(u);
  await u.check(true);
  let info = await ready;
  assert.equal(info.kind, 'hot');
  assert.deepEqual(info.changed, ['shell/shell.css']);
  assert.equal(path.basename(info.dir), 'b' + hot.build);
  assert.match(fs.readFileSync(path.join(info.dir, 'shell', 'shell.css'), 'utf8'), /hot change/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'payload', 'active.json'), 'utf8')).dir, 'b' + hot.build);
  u.markApplied(info.manifest, info.dir);
  ok('shell-only change downloads, verifies and is marked hot');

  // 3. A main.js change needs a restart.
  await sleep(1100);
  fs.appendFileSync(path.join(remote, 'main.js'), '\n// restart change\n');
  const cold = release(remote);
  ready = nextReady(u);
  await u.check(true);
  info = await ready;
  assert.equal(info.kind, 'restart');
  assert.ok(info.changed.includes('main.js'));
  ok('main.js change is marked restart');

  // 4. On the next launch the newest verified download runs.
  u = loadBootstrap();
  assert.equal(path.basename(u.dir), 'b' + cold.build);
  assert.equal(u.running.version, cold.version);
  ok('next launch runs the downloaded copy');

  // 5. Old copies are cleaned up, the running one and the newest are kept.
  const dirs = fs.readdirSync(path.join(userData, 'payload')).filter((d) => d.startsWith('b')).sort();
  assert.deepEqual(dirs, ['b' + cold.build, 'b' + hot.build].sort());
  ok('keeps only the running and newest copies');

  // 6. A tampered file is rejected and the active copy stays put.
  await sleep(1100);
  fs.appendFileSync(path.join(remote, 'theme.js'), '\n// real change\n');
  release(remote);
  fs.appendFileSync(path.join(remote, 'theme.js'), '\n// tampered after release\n');
  const before = fs.readFileSync(path.join(userData, 'payload', 'active.json'), 'utf8');
  const errs = [];
  u.on('status', (s) => { if (s.state === 'error') errs.push(s.message); });
  await u.check(true);
  assert.match(errs[0] || '', /Checksum mismatch for theme\.js/);
  assert.equal(fs.readFileSync(path.join(userData, 'payload', 'active.json'), 'utf8'), before);
  ok('rejects a file whose checksum does not match');

  // 7. A corrupted download on disk is ignored at launch.
  fs.appendFileSync(path.join(userData, 'payload', 'b' + cold.build, 'main.js'), '\n// corrupted\n');
  u = loadBootstrap();
  assert.equal(u.dir, bundled);
  assert.equal(u.running.build, base.build);
  ok('falls back when the downloaded copy is corrupted');

  // 8. An update that needs a newer launcher asks for a reinstall.
  await sleep(1100);
  fs.cpSync(path.join(ROOT, 'theme.js'), path.join(remote, 'theme.js'));
  const m = release(remote);
  m.minLoader = 99;
  fs.writeFileSync(path.join(remote, 'manifest.json'), JSON.stringify(m));
  const seen = [];
  u.on('status', (s) => seen.push(s.state));
  await u.check(true);
  assert.ok(seen.includes('reinstall'));
  ok('asks for a reinstall when the launcher is too old');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} updater checks passed`);
})().catch((err) => { console.error(err); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(1); });
