/*
 * Shared theme logic. Loaded by the main process (require) and by the shell
 * window (<script>), so it must stay plain JavaScript with no imports.
 *
 * Input: the user's settings (three colours, mode, fonts, text size).
 * Output: a palette for the app's own UI, and the stylesheet injected into
 * every claude.ai pane.
 *
 * The claude.ai hooks below come from community styles maintained against
 * the live site in 2026 (Catppuccin for Claude, Claude OLED theme). If
 * claude.ai renames them, only this file needs updating.
 */
(function (root) {
  'use strict';

  var DEFAULTS = {
    mode: 'light',
    primary: '#111111',
    secondary: '#d6d6d0',
    accent: '#ff4f00',
    headFont: '"Foun"',
    bodyFont: '"CS Genio Mono"',
    textSize: 13,
    hideClaudeSidebar: true
  };

  var PALETTES = [
    { id: 'te', name: 'te grey', mode: 'light', primary: '#111111', secondary: '#d6d6d0', accent: '#ff4f00' },
    { id: 'steel', name: 'steel', mode: 'light', primary: '#1d2733', secondary: '#c5ccd4', accent: '#2f6bff' },
    { id: 'clinic', name: 'clinic', mode: 'light', primary: '#0d4c4a', secondary: '#d3e6df', accent: '#ff6b4a' },
    { id: 'night', name: 'night', mode: 'dark', primary: '#ededea', secondary: '#55554f', accent: '#ff5a1f' }
  ];

  // Fallbacks are appended to whatever font the user picks, so a missing
  // font degrades to the bundled stand-ins instead of the browser default.
  var HEAD_FALLBACK = '"Antonio", "Arial Narrow", sans-serif';
  var BODY_FALLBACK = '"Space Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  var MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

  // ---- colour helpers ----------------------------------------------------
  function rgb(h) {
    h = String(h || '#000000').replace('#', '');
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    var n = parseInt(h, 16);
    if (isNaN(n)) n = 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function hex(r, g, b) {
    return '#' + [r, g, b].map(function (v) {
      v = Math.round(Math.max(0, Math.min(255, v)));
      return (v < 16 ? '0' : '') + v.toString(16);
    }).join('');
  }
  function mix(a, b, t) {
    var A = rgb(a), B = rgb(b);
    return hex(A[0] * t + B[0] * (1 - t), A[1] * t + B[1] * (1 - t), A[2] * t + B[2] * (1 - t));
  }
  function lum(h) {
    var w = [0.2126, 0.7152, 0.0722];
    return rgb(h).reduce(function (s, v, i) {
      v /= 255;
      return s + w[i] * (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    }, 0);
  }
  function contrast(a, b) {
    var x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  function on(c) { return contrast(c, '#ffffff') >= contrast(c, '#111111') ? '#ffffff' : '#111111'; }
  function readable(ink, bg) { return contrast(ink, bg) >= 4.5 ? ink : on(bg); }
  // Darken (or lighten) a colour toward the ink until it reaches `min` contrast.
  function ensure(c, bg, ink, min) {
    var out = c;
    for (var k = 1; k <= 12 && contrast(out, bg) < min; k++) out = mix(c, ink, 1 - k * 0.08);
    return out;
  }
  // claude.ai's legacy tokens are bare "H S% L%" triplets.
  function triplet(h) {
    var c = rgb(h).map(function (v) { return v / 255; });
    var r = c[0], g = c[1], b = c[2];
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var H = 0, S = 0, L = (max + min) / 2;
    if (max !== min) {
      var d = max - min;
      S = L > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) H = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) H = (b - r) / d + 2;
      else H = (r - g) / d + 4;
      H *= 60;
    }
    var f = function (v) { return Math.round(v * 10) / 10; };
    return f(H) + ' ' + f(S * 100) + '% ' + f(L * 100) + '%';
  }

  function withDefaults(s) {
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) { out[k] = s && s[k] !== undefined ? s[k] : DEFAULTS[k]; });
    return out;
  }

  // Values arrive from the shell window and end up inside injected CSS, so
  // only well-formed values are accepted.
  function sanitize(patch) {
    var out = {};
    if (!patch || typeof patch !== 'object') return out;
    ['primary', 'secondary', 'accent'].forEach(function (k) {
      if (typeof patch[k] === 'string' && /^#[0-9a-f]{6}$/i.test(patch[k])) out[k] = patch[k].toLowerCase();
    });
    if (patch.mode === 'light' || patch.mode === 'dark') out.mode = patch.mode;
    ['headFont', 'bodyFont'].forEach(function (k) {
      if (typeof patch[k] === 'string') {
        var v = patch[k].replace(/[;{}<>\\\n\r]/g, '').trim().slice(0, 160);
        if (v) out[k] = v;
      }
    });
    var size = Number(patch.textSize);
    if (size >= 11 && size <= 20) out.textSize = Math.round(size);
    if (typeof patch.hideClaudeSidebar === 'boolean') out.hideClaudeSidebar = patch.hideClaudeSidebar;
    return out;
  }

  // Wrap a bare font family name in quotes for CSS.
  function quoteFamily(name) {
    return '"' + String(name).replace(/["\\;{}<>]/g, '').trim() + '"';
  }

  function fontStacks(s) {
    return {
      head: (s.headFont ? s.headFont + ', ' : '') + HEAD_FALLBACK,
      body: (s.bodyFont ? s.bodyFont + ', ' : '') + BODY_FALLBACK,
      mono: MONO
    };
  }

  // ---- palette -------------------------------------------------------------
  function palette(settings) {
    var s = withDefaults(settings);
    var dark = s.mode === 'dark';
    var ground = dark ? '#141414' : '#ebebe7';
    var panel = dark ? '#1b1b1b' : '#f7f7f4';
    var raised = dark ? '#222222' : '#fcfcfa';
    var ink = dark ? '#ededea' : '#121212';
    var side = mix(s.secondary, ground, dark ? 0.28 : 0.5);
    var user = mix(s.secondary, panel, dark ? 0.35 : 0.62);
    var chip = mix(s.secondary, panel, dark ? 0.3 : 0.5);
    var sideInk = readable(ink, side);
    return {
      dark: dark, ground: ground, panel: panel, raised: raised, ink: ink,
      mute: mix(ink, panel, 0.64),
      faint: mix(ink, panel, 0.45),
      line: mix(ink, panel, 0.13),
      lineStrong: mix(ink, panel, 0.26),
      side: side, sideInk: sideInk, sideMute: ensure(mix(sideInk, side, 0.64), side, sideInk, 4.5),
      user: user, userInk: readable(ink, user),
      chip: chip, chipInk: readable(ink, chip),
      primary: s.primary, onPrimary: on(s.primary), primaryHover: mix(s.primary, ink === '#121212' ? '#ffffff' : '#000000', 0.86),
      secondary: s.secondary,
      accent: s.accent, onAccent: on(s.accent),
      accentInk: ensure(s.accent, panel, ink, 4.5),
      accentSideInk: ensure(s.accent, side, sideInk, 4.5),
      danger: ensure('#d4321c', panel, ink, 4.5),
      codeBg: dark ? '#0d0d0d' : '#151515', codeInk: '#e8e8e3', codeMute: '#8f8f8a',
      buttonContrast: contrast(on(s.primary), s.primary)
    };
  }

  // ---- stylesheet for claude.ai panes ---------------------------------------
  function claudeCSS(settings, fontFaceCSS) {
    var s = withDefaults(settings);
    var p = palette(s);
    var f = fontStacks(s);
    var size = Math.max(11, Math.min(20, Number(s.textSize) || 13));
    var L = [];
    var block = function (selector, decls) {
      L.push(selector + ' {');
      Object.keys(decls).forEach(function (k) { L.push('  ' + k + ': ' + decls[k] + ' !important;'); });
      L.push('}');
    };

    if (fontFaceCSS) L.push(fontFaceCSS);

    // 1. Legacy colour tokens (bare HSL triplets).
    var legacy = {
      '--bg-000': triplet(p.raised),
      '--bg-100': triplet(p.panel),
      '--bg-200': triplet(p.side),
      '--bg-300': triplet(p.chip),
      '--bg-400': triplet(mix(p.chip, p.ink, 0.92)),
      '--bg-500': triplet(mix(p.chip, p.ink, 0.86)),
      '--text-000': triplet(p.ink),
      '--text-100': triplet(p.ink),
      '--text-200': triplet(p.ink),
      '--text-300': triplet(p.mute),
      '--text-400': triplet(mix(p.ink, p.panel, 0.8)),
      '--text-500': triplet(p.mute),
      '--border-100': triplet(p.line),
      '--border-200': triplet(p.line),
      '--border-300': triplet(p.lineStrong),
      '--border-400': triplet(p.lineStrong),
      '--border-500': triplet(p.lineStrong),
      // Primary drives the send button and filled buttons.
      '--accent-main-000': triplet(p.primary),
      '--accent-main-100': triplet(p.primary),
      '--accent-main-200': triplet(p.primaryHover),
      '--accent-main-900': triplet(p.chip),
      '--oncolor-100': triplet(p.onPrimary),
      '--oncolor-200': triplet(p.onPrimary),
      // Accent drives brand marks, links and highlights.
      '--accent-brand': triplet(p.accent),
      '--accent-000': triplet(p.accentInk),
      '--accent-100': triplet(p.accentInk),
      '--accent-200': triplet(p.accent),
      '--accent-900': triplet(p.chip),
      '--accent-secondary-000': triplet(p.accentInk),
      '--accent-secondary-100': triplet(p.accentInk),
      '--accent-secondary-200': triplet(p.accent),
      '--accent-secondary-900': triplet(p.chip),
      '--accent-pro-000': triplet(p.accentInk),
      '--accent-pro-100': triplet(p.accent),
      '--accent-pro-200': triplet(p.accent),
      '--accent-pro-900': triplet(p.chip),
      '--brand-000': triplet(p.accent),
      '--brand-100': triplet(p.accent),
      '--brand-200': triplet(p.accent)
    };
    block(':root, :root[data-mode="light"], :root[data-mode="dark"]', legacy);

    // 2. Claude Design System tokens. <html> is itself a .cds-root.
    block(':root.cds-root, .cds-root', {
      '--cds-page-bg': p.panel,
      '--cds-surface-0': p.ground,
      '--cds-surface-1': p.side,
      '--cds-surface-2': p.panel,
      '--cds-surface-3': p.raised,
      '--cds-surface-panel': p.panel,
      '--cds-surface-popover': p.raised,
      '--cds-text-primary': p.ink,
      '--cds-text-secondary': mix(p.ink, p.panel, 0.8),
      '--cds-text-muted': p.mute,
      '--cds-text-accent': p.accentInk,
      '--cds-fill-accent': p.primary,
      '--cds-fill-accent-hover': p.primaryHover,
      '--cds-on-accent': p.onPrimary,
      '--cds-fill-primary': p.primary,
      '--cds-fill-primary-hover': p.primaryHover,
      '--cds-on-primary': p.onPrimary,
      '--cds-clay': p.accent,
      '--cds-clay-emphasized': p.accentInk,
      '--cds-border': p.line,
      '--cds-border-strong': p.lineStrong,
      '--cds-border-accent': p.accent,
      '--cds-fill-field': p.raised,
      '--cds-tooltip-bg': p.ink,
      '--cds-tooltip-fg': p.panel,
      '--cds-focus-shadow': '0 0 0 2px ' + p.accent,
      '--cds-font-sans': f.body
    });

    // 3. Sidebar and page frame.
    block('.dframe-root, .dframe-sidebar, .dframe-card', {
      '--df-bg-page-hsl': triplet(p.panel),
      '--df-sidebar-bg': p.side,
      '--df-web-sidebar-bg': p.side,
      '--df-web-sidebar-bg-image': 'none',
      '--df-surface-primary': p.side
    });

    // 4. Fonts.
    block(':root', {
      '--font-anthropic-serif': f.body,
      '--font-anthropic-sans': f.body,
      '--font-ui': f.body,
      '--font-ui-serif': f.body,
      '--font-mono': f.mono
    });
    block('body', { 'font-family': f.body });
    block('h1, h2, h3, .font-claude-response :is(h1, h2, h3)', {
      'font-family': f.head,
      'letter-spacing': '0.01em',
      'text-transform': 'uppercase'
    });
    block('code, pre, kbd, .code-block__code, .code-block__code *', { 'font-family': f.mono });

    // 5. Reading comfort: tighter leading, clearer paragraph breaks.
    block('.font-claude-response, .font-claude-response-body, [data-testid="user-message"]', {
      'font-size': size + 'px',
      'line-height': '1.42'
    });
    block('.font-claude-response p, .font-claude-response-body p', {
      'margin-top': '0',
      'margin-bottom': '1.35em',
      'line-height': '1.42'
    });
    block('.font-claude-response p:last-child, .font-claude-response-body p:last-child', { 'margin-bottom': '0' });
    block('[data-user-message-bubble="true"]', {
      'background-color': p.user,
      'color': p.userInk,
      'border-radius': '2px'
    });
    block('.code-block__code', { 'background': p.codeBg, 'border-radius': '2px' });
    block('*', { 'scrollbar-color': p.lineStrong + ' transparent' });

    // 6. The app has its own chat list, so claude.ai's sidebar can be hidden.
    //    Everything it offers is still reachable from the app's sidebar.
    if (s.hideClaudeSidebar) {
      block('.dframe-sidebar, .z-sidebar', { 'display': 'none' });
    }

    return L.join('\n');
  }

  var api = {
    DEFAULTS: DEFAULTS, PALETTES: PALETTES,
    HEAD_FALLBACK: HEAD_FALLBACK, BODY_FALLBACK: BODY_FALLBACK,
    rgb: rgb, hex: hex, mix: mix, lum: lum, contrast: contrast, on: on, triplet: triplet,
    withDefaults: withDefaults, sanitize: sanitize, quoteFamily: quoteFamily,
    fontStacks: fontStacks, palette: palette, claudeCSS: claudeCSS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ReskinTheme = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
