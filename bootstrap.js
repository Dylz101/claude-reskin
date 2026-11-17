'use strict';

/*
 * Launcher. This is the only file that never updates itself, so keep it small.
 *
 * It picks the newest verified copy of the app code (downloaded updates live
 * in <userData>/payload/, the copy you installed lives next to this file),
 * starts it, and keeps checking GitHub for newer code.
 *
 * Every update is described by manifest.json: a build number and the SHA-256
 * of every file. Files are only used if their hash matches.
 */

const { app, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const LOADER_VERSION = 1;
const REPO = 'Dylz101/claude-reskin';
const BRANCH = 'main';
const RAW = 'https://raw.githubusercontent.com/' + REPO + '/' + BRANCH + '/';
const CHECK_EVERY_MS = 10 * 60 * 1000;

// Files that can be swapped while the app runs. Anything else needs a restart.
const isHotFile = (f) => /^(shell\/|fonts\/)/.test(f) || f === 'theme.js';

const bundledDir = __dirname;
const payloadRoot = () => path.join(app.getPath('userData'), 'payload');
const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const safeRel = (f) => typeof f === 'string' && !f.includes('..') && !path.isAbsolute(f) && /^[\w./ -]+$/.test(f);

function verified(dir, manifest) {
  if (!manifest || !manifest.files) return false;
  return Object.keys(manifest.files).every((f) => {
    try { return sha256(fs.readFileSync(path.join(dir, f))) === manifest.files[f]; } catch { return false; }
  });
}

function pickActive() {
  const bundled = readJSON(path.join(bundledDir, 'manifest.json')) || { build: 0, version: 'dev', files: {} };
  const ptr = readJSON(path.join(payloadRoot(), 'active.json'));
  if (ptr && typeof ptr.dir === 'string' && /^b\d+$/.test(ptr.dir)) {
    const dir = path.join(payloadRoot(), ptr.dir);
    const m = readJSON(path.join(dir, 'manifest.json'));
    if (m && m.build > bundled.build && (m.minLoader || 1) <= LOADER_VERSION && verified(dir, m)) return { dir, manifest: m };
  }
  return { dir: bundledDir, manifest: bundled };
}

class Updater extends EventEmitter {
  constructor(active) {
    super();
    this.dir = active.dir;
    this.running = active.manifest;   // code currently running
    this.ready = null;                // newest downloaded build, if any
    this.busy = false;
    this.timer = null;
  }

  get version() { return (this.ready || this.running).version; }

  start() {
    setTimeout(() => this.check(), 5000);
    this.timer = setInterval(() => this.check(), CHECK_EVERY_MS);
  }

  status(state, extra) { this.emit('status', Object.assign({ state, version: this.version }, extra)); }

  async fetchBuffer(url) {
    const res = await net.fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return Buffer.from(await res.arrayBuffer());
  }

  async check(manual) {
    if (this.busy) return;
    this.busy = true;
    try {
      if (manual) this.status('checking');
      const remote = JSON.parse((await this.fetchBuffer(RAW + 'manifest.json?t=' + Date.now())).toString('utf8'));
      const current = this.ready || this.running;
      if (!remote || !remote.files || !(remote.build > current.build)) {
        this.status(this.ready ? 'restart' : 'current');
        return;
      }
      if ((remote.minLoader || 1) > LOADER_VERSION) {
        this.status('reinstall', { remoteVersion: remote.version });
        return;
      }
      this.status('downloading', { remoteVersion: remote.version });
      const dir = await this.download(remote);
      this.ready = remote;
      const changed = this.diff(this.running, remote);
      const kind = changed.length && changed.every(isHotFile) ? 'hot' : 'restart';
      this.emit('ready', { kind, dir, manifest: remote, changed });
      this.cleanup(path.basename(dir));
    } catch (err) {
      if (manual) this.status('error', { message: String(err && err.message ? err.message : err) });
      else this.status(this.ready ? 'restart' : 'current');
    } finally {
      this.busy = false;
    }
  }

  diff(a, b) {
    const files = new Set(Object.keys(a.files || {}).concat(Object.keys(b.files || {})));
    return [...files].filter((f) => (a.files || {})[f] !== (b.files || {})[f]);
  }

  async download(remote) {
    const name = 'b' + Number(remote.build);
    const target = path.join(payloadRoot(), name);
    const staging = target + '.part';
    fs.rmSync(staging, { recursive: true, force: true });
    const have = this.ready ? { dir: path.join(payloadRoot(), 'b' + this.ready.build), m: this.ready } : { dir: this.dir, m: this.running };

    for (const f of Object.keys(remote.files)) {
      if (!safeRel(f)) throw new Error('Unsafe path in manifest: ' + f);
      const want = remote.files[f];
      let buf = null;
      if ((have.m.files || {})[f] === want) {
        try { buf = fs.readFileSync(path.join(have.dir, f)); } catch { buf = null; }
      }
      if (!buf || sha256(buf) !== want) buf = await this.fetchBuffer(RAW + f.split('/').map(encodeURIComponent).join('/') + '?h=' + want.slice(0, 12));
      if (sha256(buf) !== want) throw new Error('Checksum mismatch for ' + f + ' (GitHub may still be publishing; will retry)');
      fs.mkdirSync(path.dirname(path.join(staging, f)), { recursive: true });
      fs.writeFileSync(path.join(staging, f), buf);
    }
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(remote, null, 2));
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
    fs.writeFileSync(path.join(payloadRoot(), 'active.json'), JSON.stringify({ dir: name }));
    return target;
  }

  // Keep the running copy and the newest download; remove the rest.
  cleanup(keepName) {
    const runningName = path.basename(this.dir);
    try {
      fs.readdirSync(payloadRoot()).forEach((d) => {
        if (/^b\d+(\.part)?$/.test(d) && d !== keepName && d !== runningName) {
          fs.rmSync(path.join(payloadRoot(), d), { recursive: true, force: true });
        }
      });
    } catch { /* nothing to clean */ }
  }

  // Called by the app after it swaps in hot files, so later diffs compare
  // against what is really running.
  markApplied(manifest, dir) {
    this.running = manifest;
    this.dir = dir;
    this.ready = null;
  }
}

const active = pickActive();
const updater = new Updater(active);
global.reskinUpdater = updater;
global.reskinLoaderVersion = LOADER_VERSION;
app.whenReady().then(() => updater.start());

require(path.join(active.dir, 'main.js'));
