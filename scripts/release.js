'use strict';
/*
 * Prepares an update: bumps the patch version, then writes manifest.json with
 * a build number and the SHA-256 of every file the app downloads.
 * Run `npm run release`, then commit and push. Running apps pick it up within
 * ten minutes, or straight away from File › Check for updates.
 *
 *   node scripts/release.js --check    changes nothing; exits 1 if manifest.json
 *                                      doesn't match the files (see below)
 *   node scripts/release.js --no-bump  rewrites the manifest, keeps the version
 *
 * Running apps refuse an update when any file fails its checksum, so a change
 * to an app file that reaches main without a release behind it stops every
 * app from updating. `npm run check:manifest` (also run on GitHub for each
 * push and pull request) catches that.
 *
 * bootstrap.js is not in the manifest: it is the launcher and only changes
 * with a reinstall. Raise MIN_LOADER here when an update needs a newer one.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const MIN_LOADER = 1;
const PAYLOAD = ['main.js', 'preload.js', 'theme.js', 'sidebar-data.js', 'shell', 'fonts'];

function walk(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return []; // a deleted file: --check reports it, a release just leaves it out
  if (fs.statSync(abs).isDirectory()) {
    return fs.readdirSync(abs).sort().flatMap((name) => walk(path.posix.join(rel, name)));
  }
  return [rel];
}

function hashFiles() {
  const files = {};
  PAYLOAD.flatMap(walk).forEach((f) => {
    files[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');
  });
  return files;
}

const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

// Compares manifest.json with the files on disk and package.json's version.
function problems() {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')); }
  catch (err) { return ['manifest.json is missing or is not valid JSON (' + err.message + ')']; }
  const have = hashFiles();
  const listed = manifest.files || {};
  const out = [];
  Object.keys(have).forEach((f) => {
    if (!(f in listed)) out.push(f + ' is not in manifest.json (a new file)');
    else if (listed[f] !== have[f]) out.push(f + ' has changed since manifest.json was written');
  });
  Object.keys(listed).filter((f) => !(f in have)).forEach((f) => out.push(f + ' is in manifest.json but no longer exists'));
  if (manifest.version !== pkg.version) {
    out.push('manifest.json says v' + manifest.version + ' but package.json says v' + pkg.version);
  }
  return out;
}

if (process.argv.includes('--check')) {
  const found = problems();
  if (!found.length) {
    console.log('manifest.json matches every app file (v' + pkg.version + ').');
    process.exit(0);
  }
  console.error('manifest.json is out of date, so running apps would refuse to update to this commit:');
  found.forEach((p) => console.error('  - ' + p));
  console.error('Run `npm run release`, then commit manifest.json and package.json with the change.');
  process.exit(1);
}

if (!process.argv.includes('--no-bump')) {
  const [maj, min, patch] = pkg.version.split('.').map(Number);
  pkg.version = [maj, min, patch + 1].join('.');
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

const now = new Date();
const build = Number(now.toISOString().replace(/\D/g, '').slice(0, 14)); // YYYYMMDDHHMMSS, always increasing
const files = hashFiles();

const manifest = { version: pkg.version, build, minLoader: MIN_LOADER, published: now.toISOString(), files };
fs.writeFileSync(path.join(ROOT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`manifest.json: v${manifest.version}, build ${build}, ${Object.keys(files).length} files`);
