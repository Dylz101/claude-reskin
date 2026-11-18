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

test('a chosen background sets the mode and stays readable', () => {
  assert.equal(T.sanitize({ background: '#0b2545', mode: 'light' }).mode, 'dark');
  assert.equal(T.sanitize({ background: '#FDF0D5' }).background, '#fdf0d5');
  assert.equal(T.sanitize({ background: '#FDF0D5' }).mode, 'light');
  assert.equal(T.sanitize({ background: 'red' }).background, undefined);
  assert.equal(T.sanitize({ background: '' }).background, '');
  ['#0b2545', '#2b1d3a', '#fdf0d5', '#dfe7e2', '#9a9a9a', '#5c5c5c'].forEach((bg) => {
    const s = Object.assign({}, T.DEFAULTS, T.sanitize({ background: bg }));
    const p = T.palette(s);
    assert.equal(p.panel, bg, bg + ' used as the pane colour');
    assert.ok(T.contrast(p.ink, p.panel) >= 4.5, bg + ' ink');
    assert.ok(T.contrast(p.mute, p.panel) >= 4.5, bg + ' muted text');
    assert.ok(T.contrast(p.accentInk, p.panel) >= 4.5, bg + ' accent text');
  });
  // A saturated mid-tone can't give muted text 4.5:1, but body text still reads.
  const red = T.palette(Object.assign({}, T.DEFAULTS, T.sanitize({ background: '#e63946' })));
  assert.ok(T.contrast(red.ink, red.panel) >= 4.5, 'red ink');
});

test('a background that does not suit the mode is ignored', () => {
  assert.equal(T.palette(T.withDefaults({ mode: 'light', background: '#101010' })).panel, '#f7f7f4');
});

test('no background keeps the original surfaces', () => {
  const l = T.palette(T.withDefaults({})), d = T.palette(T.withDefaults({ mode: 'dark' }));
  assert.deepEqual([l.ground, l.panel, l.raised], ['#ebebe7', '#f7f7f4', '#fcfcfa']);
  assert.deepEqual([d.ground, d.panel, d.raised], ['#141414', '#1b1b1b', '#222222']);
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
  assert.match(T.claudeCSS({ hideClaudeSidebar: true }), /:not\(\[data-reskin-code\]\).*\.dframe-sidebar, \.z-sidebar/);
  assert.doesNotMatch(T.claudeCSS({ hideClaudeSidebar: false }), /\.dframe-sidebar, \.z-sidebar/);
});

test('braces in generated CSS are balanced', () => {
  const css = T.claudeCSS({});
  assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length);
});

test('coloursOf keeps colours only and fills mode and background', () => {
  assert.deepEqual(T.coloursOf({ primary: '#111111', secondary: '#D6D6D0', accent: '#ff4f00', headFont: '"Foun"', textSize: 16 }),
    { mode: 'light', background: '', primary: '#111111', secondary: '#d6d6d0', accent: '#ff4f00' });
  assert.equal(T.coloursOf({ primary: '#111111', secondary: 'red', accent: '#ff4f00' }), null);
  // A chosen background decides the mode.
  assert.equal(T.coloursOf({ mode: 'light', background: '#101820', primary: '#ededea', secondary: '#55554f', accent: '#ff5a1f' }).mode, 'dark');
});

test('findSaved spots presets and saved combinations, ignoring fonts', () => {
  const theme = T.withDefaults({ headFont: 'Georgia', textSize: 16 });
  assert.equal(T.findSaved([], theme).id, 'te');
  const saved = [{ id: 'p1', name: 'mine', mode: 'light', background: '#fdf6e3', primary: '#073642', secondary: '#eee8d5', accent: '#cb4b16' }];
  assert.equal(T.findSaved(saved, Object.assign({}, theme, saved[0])).id, 'p1');
  assert.equal(T.findSaved(saved, Object.assign({}, theme, saved[0], { background: '' })), null);
});

test('addSaved stores a named colour combination once', () => {
  const colours = { mode: 'light', background: '#fdf6e3', primary: '#073642', secondary: '#eee8d5', accent: '#cb4b16', headFont: 'x' };
  let list = T.addSaved([], '  solar  ', colours, 'p1');
  assert.deepEqual(list, [{ id: 'p1', name: 'solar', mode: 'light', background: '#fdf6e3', primary: '#073642', secondary: '#eee8d5', accent: '#cb4b16' }]);
  assert.equal(T.addSaved(list, 'again', colours, 'p2').length, 1, 'same colours are not saved twice');
  assert.equal(T.addSaved(list, 'preset', T.PALETTES[0], 'p3').length, 1, 'a preset is not saved again');
  assert.equal(T.addSaved(list, 'bad id', Object.assign({}, colours, { accent: '#000001' }), 'P 4').length, 1);
  list = T.addSaved(list, '', Object.assign({}, colours, { accent: '#2f6bff' }), 'p5');
  assert.equal(list[1].name, 'my colours 01');
  assert.equal(T.nextSavedName(list), 'my colours 02');
});

test('addSaved stops at the limit', () => {
  let list = [];
  for (let i = 0; i < T.MAX_SAVED + 3; i++) {
    list = T.addSaved(list, 'n' + i, { mode: 'light', primary: '#111111', secondary: '#d6d6d0', accent: '#' + (0x100000 + i).toString(16) }, 'p' + i);
  }
  assert.equal(list.length, T.MAX_SAVED);
});

test('renameSaved and removeSaved change only the named combination', () => {
  const base = [
    { id: 'p1', name: 'one', mode: 'light', background: '', primary: '#111111', secondary: '#d6d6d0', accent: '#2f6bff' },
    { id: 'p2', name: 'two', mode: 'dark', background: '', primary: '#ededea', secondary: '#55554f', accent: '#2f6bff' }
  ];
  const renamed = T.renameSaved(base, 'p2', 'night blue<script>');
  assert.equal(renamed[1].name, 'night bluescript');
  assert.equal(renamed[0].name, 'one');
  assert.deepEqual(T.renameSaved(base, 'p2', '   ').map((p) => p.name), ['one', 'two'], 'an empty name is ignored');
  assert.deepEqual(T.removeSaved(base, 'p1').map((p) => p.id), ['p2']);
  assert.deepEqual(T.removeSaved(base, 'nope').map((p) => p.id), ['p1', 'p2']);
});

test('sanitizeSaved drops broken entries and repeated ids', () => {
  const ok = { id: 'p1', name: 'one', mode: 'light', primary: '#111111', secondary: '#d6d6d0', accent: '#2f6bff' };
  const list = T.sanitizeSaved([ok, ok, null, { id: 'p2', name: '', primary: '#111111', secondary: '#d6d6d0', accent: '#2f6bff' },
    { id: 'p3', name: 'bad', primary: 'url(x)', secondary: '#d6d6d0', accent: '#2f6bff' }, { id: '../x', name: 'x', primary: '#111111', secondary: '#d6d6d0', accent: '#2f6bff' }]);
  assert.deepEqual(list.map((p) => p.id), ['p1']);
  assert.equal(list[0].background, '');
  assert.deepEqual(T.sanitizeSaved('nope'), []);
});

console.log(`\n${passed} checks passed`);
