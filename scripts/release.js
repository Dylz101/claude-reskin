'use strict';
/*
 * Prepares an update: bumps the patch version, then writes manifest.json with
 * a build number and the SHA-256 of every file the app downloads.
 * Run `npm run release`, then commit and push. Running apps pick it up within
 * ten minutes, or straight away from File › Check for updates.
 *
 * bootstrap.js is not in the manifest: it is the launcher and only changes
 * with a reinstall. Raise MIN_LOADER here when an update needs a newer one.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const MIN_LOADER = 1;
const PAYLOAD = ['main.js', 'preload.js', 'theme.js', 'shell', 'fonts'];

function walk(rel) {
  const abs = path.join(ROOT, rel);
  if (fs.statSync(abs).isDirectory()) {
    return fs.readdirSync(abs).sort().flatMap((name) => walk(path.posix.join(rel, name)));
  }
  return [rel];
}

const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
if (!process.argv.includes('--no-bump')) {
  const [maj, min, patch] = pkg.version.split('.').map(Number);
  pkg.version = [maj, min, patch + 1].join('.');
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

const now = new Date();
const build = Number(now.toISOString().replace(/\D/g, '').slice(0, 14)); // YYYYMMDDHHMMSS, always increasing
const files = {};
PAYLOAD.flatMap(walk).forEach((f) => {
  files[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');
});

const manifest = { version: pkg.version, build, minLoader: MIN_LOADER, published: now.toISOString(), files };
fs.writeFileSync(path.join(ROOT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`manifest.json: v${manifest.version}, build ${build}, ${Object.keys(files).length} files`);
