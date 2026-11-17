'use strict';
// Plain Node checks for theme.js: run with `npm test`.
const assert = require('node:assert/strict');
const T = require('../theme.js');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('ok', name); };

test('defaults fill missing keys', () => {
  const s = T.withDefaults({ primary: '#222222' });
  assert.equal(s.primary, '#222222');
  assert.equal(s.accent, '#ff4f00');
  assert.equal(s.textSize, 13);
});

test('triplet matches known HSL values', () => {
  assert.equal(T.triplet('#ffffff'), '0 0% 100%');
  assert.equal(T.triplet('#000000'), '0 0% 0%');
  assert.equal(T.triplet('#ff0000'), '0 100% 50%');
  assert.equal(T.triplet('#1e1e2e'), '240 21.1% 14.9%');
});

test('contrast of black on white is 21', () => {
  assert.equal(Math.round(T.contrast('#000000', '#ffffff')), 21);
});

test('sanitize rejects bad colours, fonts and sizes', () => {
  const out = T.sanitize({ primary: 'red', accent: '#ABCDEF', headFont: '"Foun"; } body { display:none', textSize: 99, mode: 'sepia' });
  assert.equal(out.primary, undefined);
  assert.equal(out.accent, '#abcdef');
  assert.ok(!/[;{}]/.test(out.headFont));
  assert.equal(out.textSize, undefined);
  assert.equal(out.mode, undefined);
});

test('quoteFamily strips characters that could break CSS', () => {
  assert.equal(T.quoteFamily('My "Font"; }'), '"My Font"');
});

test('palette text and accent pass contrast in both modes for every preset', () => {
  T.PALETTES.forEach((pal) => {
    const p = T.palette(pal);
    assert.ok(T.contrast(p.ink, p.panel) >= 7, pal.id + ' ink');
    assert.ok(T.contrast(p.mute, p.panel) >= 4.5, pal.id + ' muted text');
    assert.ok(T.contrast(p.accentInk, p.panel) >= 4.5, pal.id + ' accent text');
    assert.ok(T.contrast(p.sideInk, p.side) >= 4.5, pal.id + ' sidebar text');
    assert.ok(T.contrast(p.onPrimary, p.primary) >= 4.5, pal.id + ' button text');
  });
});

test('claude CSS maps the three colours onto claude.ai tokens', () => {
  const css = T.claudeCSS({ primary: '#0d4c4a', secondary: '#d3e6df', accent: '#ff6b4a' });
  assert.match(css, /--accent-main-100: 178\.1 70\.8% 17\.5% !important;/);
  assert.match(css, /--cds-fill-accent: #0d4c4a !important;/);
  assert.match(css, /--cds-clay: #ff6b4a !important;/);
  assert.match(css, /--df-sidebar-bg: #[0-9a-f]{6} !important;/);
  assert.match(css, /\[data-user-message-bubble="true"\]/);
  assert.match(css, /line-height: 1\.42 !important;/);
  assert.match(css, /font-size: 13px !important;/);
});

test('claude CSS uses the chosen fonts with fallbacks', () => {
  const css = T.claudeCSS({ headFont: '"Foun"', bodyFont: '"CS Genio Mono"' });
  assert.match(css, /--font-anthropic-serif: "CS Genio Mono", "Space Mono"/);
  assert.match(css, /font-family: "Foun", "Antonio"/);
});

test('claude sidebar hiding follows the setting', () => {
  assert.match(T.claudeCSS({ hideClaudeSidebar: true }), /\.dframe-sidebar, \.z-sidebar/);
  assert.doesNotMatch(T.claudeCSS({ hideClaudeSidebar: false }), /\.dframe-sidebar, \.z-sidebar/);
});

test('braces in generated CSS are balanced', () => {
  const css = T.claudeCSS({});
  assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length);
});

console.log(`\n${passed} checks passed`);
