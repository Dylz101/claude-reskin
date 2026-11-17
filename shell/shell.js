/* App shell logic. Talks to the main process through window.reskin (preload.js). */
(function () {
  'use strict';

  var api = window.reskin;
  var T = window.ReskinTheme;
  var $ = function (id) { return document.getElementById(id); };
  var SVG = {
    back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"></path></svg>',
    reload: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.5-5.8"></path><path d="M4 4v5h5"></path></svg>',
    only: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"></path></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>',
    split: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14"></rect><path d="M12 5v14"></path></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>'
  };

  var HEAD_OPTIONS = [
    ['Foun', '"Foun"'],
    ['Antonio (bundled)', '"Antonio"'],
    ['System UI', 'system-ui'],
    ['Helvetica / Arial', '"Helvetica Neue", Helvetica, Arial'],
    ['Arial Narrow', '"Arial Narrow"'],
    ['Georgia', 'Georgia'],
    ['System mono', 'ui-monospace']
  ];
  var BODY_OPTIONS = [
    ['CS Genio Mono', '"CS Genio Mono"'],
    ['Space Mono (bundled)', '"Space Mono"'],
    ['System UI', 'system-ui'],
    ['Helvetica / Arial', '"Helvetica Neue", Helvetica, Arial'],
    ['Georgia', 'Georgia'],
    ['System mono', 'ui-monospace']
  ];

  var state = { panes: [], focus: null, max: 3, theme: T.withDefaults({}), ui: { sidebar: true, appearance: false } };
  var chats = { items: [], error: null, loaded: false };
  var fonts = [];          // fonts the main process knows about (bundled + added files)
  var systemFonts = [];    // installed families, once listed
  var paneEls = new Map(); // pane id -> { root, num, title, sub, dot, back, view }
  var query = '';

  var platform = new URLSearchParams(location.search).get('platform') || '';
  if (platform) document.body.classList.add('platform-' + platform);
  document.querySelector('#btn-new .kbd').textContent = platform === 'darwin' ? '⌘N' : 'Ctrl+N';

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function send(ch, data) { if (api) api.send(ch, data); }
  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else e.setAttribute(k, attrs[k]);
    });
    if (html) e.innerHTML = html;
    return e;
  }

  // ---------------------------------------------------------------------
  // Theme for the shell itself
  // ---------------------------------------------------------------------
  function applyShellTheme(theme) {
    var p = T.palette(theme);
    var f = T.fontStacks(theme);
    var vars = {
      '--ground': p.ground, '--panel': p.panel, '--raised': p.raised, '--ink': p.ink, '--mute': p.mute,
      '--line': p.line, '--line-strong': p.lineStrong, '--side': p.side, '--side-ink': p.sideInk, '--side-mute': p.sideMute,
      '--primary': p.primary, '--on-primary': p.onPrimary, '--accent': p.accent, '--on-accent': p.onAccent,
      '--accent-ink': p.accentInk, '--accent-side-ink': p.accentSideInk, '--chip': p.chip,
      '--head': f.head, '--body': f.body
    };
    Object.keys(vars).forEach(function (k) { document.documentElement.style.setProperty(k, vars[k]); });
    document.documentElement.style.colorScheme = p.dark ? 'dark' : 'light';
  }

  // ---------------------------------------------------------------------
  // Panes
  // ---------------------------------------------------------------------
  function paneSubtitle(url) {
    try {
      var path = new URL(url).pathname;
      if (/^\/new/.test(path)) return 'new chat';
      if (/^\/chat\//.test(path)) return 'chat';
      if (/^\/project\//.test(path)) return 'project';
      if (/^\/projects/.test(path)) return 'projects';
      if (/^\/recents/.test(path)) return 'chats';
      if (/^\/artifacts?/.test(path)) return 'artifacts';
      if (/^\/code/.test(path)) return 'code';
      if (/^\/settings/.test(path)) return 'settings';
      if (/^\/login/.test(path)) return 'sign in';
      return path.replace(/^\//, '') || 'claude.ai';
    } catch (e) { return ''; }
  }

  function makePane(id) {
    var root = el('section', { class: 'pane', 'data-id': String(id) });
    var head = el('div', { class: 'pane-head' });
    var num = el('span', { class: 'pane-num' });
    var titles = el('div', { class: 'pane-titles' });
    var title = el('h2');
    var subRow = el('span', { class: 'pane-sub' });
    var dot = el('span', { class: 'loading-dot', hidden: '' });
    var sub = el('span', { class: 'label' });
    subRow.append(dot, sub);
    titles.append(title, subRow);
    var back = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Back', title: 'Back (Ctrl/Cmd+[)' }, SVG.back);
    var reload = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Reload pane', title: 'Reload (Ctrl/Cmd+R)' }, SVG.reload);
    var only = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Show only this pane', title: 'Show only this pane' }, SVG.only);
    var close = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close pane', title: 'Close pane (Ctrl/Cmd+W)' }, SVG.close);
    head.append(num, titles, back, reload, only, close);
    var view = el('div', { class: 'pane-view' });
    root.append(head, view);

    // Focus on click, not mousedown, and never from the header buttons: moving
    // keyboard focus into the claude.ai view mid-press swallows the click.
    head.addEventListener('click', function (e) {
      if (e.target.closest('button')) return;
      send('pane:focus', id);
    });
    back.addEventListener('click', function () { send('pane:back', id); });
    reload.addEventListener('click', function () { send('pane:reload', id); });
    only.addEventListener('click', function () { send('pane:only', id); });
    close.addEventListener('click', function (e) { e.stopPropagation(); send('pane:close', id); });

    resizeObserver.observe(view);
    return { root: root, num: num, title: title, sub: sub, dot: dot, back: back, only: only, close: close, view: view };
  }

  var addPaneBtn = el('button', { type: 'button', class: 'add-pane', 'aria-label': 'Add a split pane', title: 'New split pane (Ctrl/Cmd+\\)' }, SVG.plus + '<span>add pane</span>');
  addPaneBtn.addEventListener('click', function () { send('pane:split'); });

  function renderPanes() {
    var host = $('panes');
    var ids = state.panes.map(function (p) { return p.id; });
    paneEls.forEach(function (els, id) {
      if (ids.indexOf(id) < 0) { resizeObserver.unobserve(els.view); els.root.remove(); paneEls.delete(id); }
    });
    state.panes.forEach(function (p, i) {
      var els = paneEls.get(p.id);
      if (!els) { els = makePane(p.id); paneEls.set(p.id, els); }
      els.num.textContent = pad(i + 1);
      els.title.textContent = p.title;
      els.sub.textContent = paneSubtitle(p.url);
      els.dot.hidden = !p.loading;
      els.back.disabled = !p.canGoBack;
      els.only.disabled = state.panes.length < 2;
      // Closing the last pane opens a fresh chat, so there's nothing to close
      // when the only pane is already an empty new chat.
      var lastAndEmpty = state.panes.length === 1 && paneSubtitle(p.url) === 'new chat';
      els.close.disabled = lastAndEmpty;
      els.close.title = lastAndEmpty ? 'This is the last pane' : (state.panes.length === 1 ? 'Close pane (opens a new chat)' : 'Close pane (Ctrl/Cmd+W)');
      els.root.classList.toggle('is-focused', p.id === state.focus);
      els.root.setAttribute('aria-label', 'Pane ' + (i + 1) + ': ' + p.title);
      host.appendChild(els.root); // keeps DOM order in step with state order
    });
    if (state.panes.length < state.max) host.appendChild(addPaneBtn);
    else if (addPaneBtn.parentNode) addPaneBtn.remove();

    $('pane-count').textContent = pad(state.panes.length) + '/' + pad(state.max);
    $('btn-split').disabled = state.panes.length >= state.max;
    $('btn-single').disabled = state.panes.length < 2;
    scheduleLayout();
  }

  // Tell the main process where each pane's claude.ai view belongs.
  var layoutQueued = false;
  function scheduleLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(function () {
      layoutQueued = false;
      var rects = [];
      paneEls.forEach(function (els, id) {
        var r = els.view.getBoundingClientRect();
        rects.push({ id: id, x: r.left, y: r.top, width: r.width, height: r.height });
      });
      send('pane:layout', rects);
    });
  }
  var resizeObserver = new ResizeObserver(scheduleLayout);
  resizeObserver.observe(document.body);
  window.addEventListener('resize', scheduleLayout);

  // ---------------------------------------------------------------------
  // Sidebar
  // ---------------------------------------------------------------------
  function chatIdFromUrl(url) {
    var m = /\/chat\/([0-9a-f-]{8,})/i.exec(url || '');
    return m ? m[1] : null;
  }

  function chatRow(c) {
    var openAt = -1, focused = false;
    state.panes.forEach(function (p, i) {
      if (chatIdFromUrl(p.url) === c.id) { openAt = i; if (p.id === state.focus) focused = true; }
    });
    var row = el('div', { class: 'chat-row' + (openAt >= 0 ? ' is-open' : '') + (focused ? ' is-focused' : '') });
    var open = el('button', { type: 'button', class: 'chat-open', title: c.project ? c.title + ' · ' + c.project : c.title });
    open.append(el('span', { class: 'badge', text: openAt >= 0 ? pad(openAt + 1) : '··' }), el('span', { class: 'title', text: c.title }));
    var full = state.panes.length >= state.max && openAt < 0;
    var split = el('button', {
      type: 'button', class: 'icon-btn chat-split',
      'aria-label': 'Open ' + c.title + ' in a split pane',
      title: full ? 'Close a pane first, or click the title to open it here' : 'Open in a split pane'
    }, SVG.split);
    if (full) split.disabled = true;
    open.addEventListener('click', function () { send('chat:open', { id: c.id, split: false }); });
    split.addEventListener('click', function () { send('chat:open', { id: c.id, split: true }); });
    row.append(open, split);
    return row;
  }

  function renderSidebar() {
    $('sidebar').hidden = !state.ui.sidebar;
    var q = query.trim().toLowerCase();
    var items = chats.items.filter(function (c) { return !q || c.title.toLowerCase().indexOf(q) >= 0 || (c.project || '').toLowerCase().indexOf(q) >= 0; });
    var starred = items.filter(function (c) { return c.starred; });
    var recents = items.filter(function (c) { return !c.starred; }).slice(0, 40);

    var ls = $('list-starred'), lr = $('list-recents');
    ls.replaceChildren.apply(ls, starred.map(chatRow));
    lr.replaceChildren.apply(lr, recents.map(chatRow));
    $('group-starred').hidden = !starred.length;

    var note = $('chats-note'), actions = $('chats-actions');
    note.hidden = true; actions.hidden = true;
    if (!chats.loaded && !chats.error) { note.hidden = false; note.textContent = 'loading your chats…'; }
    else if (chats.error === 'signed-out') {
      note.hidden = false; note.textContent = 'Sign in to claude.ai in the pane on the right. Your chats will appear here.';
      actions.hidden = false;
    } else if (chats.error) {
      note.hidden = false;
      note.textContent = 'Couldn\'t load your chat list (' + chats.error + '). claude.ai\'s own sidebar still works.';
      actions.hidden = false;
    } else if (q && !items.length) {
      note.hidden = false; note.textContent = 'No loaded chats match. Press Enter to search all chats.';
    } else if (!chats.items.length) {
      note.hidden = false; note.textContent = 'No chats yet.';
    }
    $('btn-native-sidebar').hidden = !state.theme.hideClaudeSidebar;
  }

  var chatTimer = null;
  var retries = 0;
  function loadChats() {
    if (!api) return;
    clearTimeout(chatTimer);
    api.invoke('chats:list').then(function (res) {
      if (res && res.items) { chats = { items: res.items, error: null, loaded: true }; retries = 0; }
      else {
        var err = (res && res.error) || 'unknown error';
        // Panes may still be loading on first launch; retry quietly a few times.
        if ((err === 'no-pane' || /Failed to fetch|http 5/.test(err)) && retries < 5) { retries++; chatTimer = setTimeout(loadChats, 3000); return; }
        chats = { items: chats.items, error: err === 'no-pane' ? 'no claude.ai pane open' : err, loaded: true };
      }
      renderSidebar();
      chatTimer = setTimeout(loadChats, 60000);
    });
  }

  // ---------------------------------------------------------------------
  // Appearance
  // ---------------------------------------------------------------------
  var themeSendTimer = null;
  function setTheme(patch, immediate) {
    Object.assign(state.theme, patch);
    applyShellTheme(state.theme);
    renderAppearance();
    clearTimeout(themeSendTimer);
    if (immediate) send('theme:set', patch);
    else {
      var snapshot = Object.assign({}, state.theme);
      themeSendTimer = setTimeout(function () { send('theme:set', snapshot); }, 90);
    }
  }

  function fillSelect(select, base, current) {
    var seen = {};
    select.replaceChildren();
    var addGroup = function (label, opts) {
      if (!opts.length) return;
      var g = el('optgroup', { label: label });
      opts.forEach(function (o) {
        if (seen[o[1]]) return;
        seen[o[1]] = true;
        var opt = el('option', { value: o[1], text: o[0] });
        g.appendChild(opt);
      });
      if (g.children.length) select.appendChild(g);
    };
    addGroup('suggested', base);
    var added = [];
    fonts.forEach(function (f) { if (!f.bundled) added.push([f.family, T.quoteFamily(f.family)]); });
    addGroup('your font files', added);
    addGroup('installed on this computer', systemFonts.map(function (fam) { return [fam, T.quoteFamily(fam)]; }));
    if (!seen[current]) addGroup('current', [[current.replace(/"/g, ''), current]]);
    select.value = current;
  }

  function renderPalettes() {
    var host = $('palettes');
    host.replaceChildren.apply(host, T.PALETTES.map(function (pal) {
      var th = state.theme;
      var on = th.mode === pal.mode && th.primary === pal.primary && th.secondary === pal.secondary && th.accent === pal.accent;
      var b = el('button', { type: 'button', class: 'palette', 'aria-pressed': on ? 'true' : 'false' });
      var sw = el('span', { class: 'swatches' });
      [pal.primary, pal.secondary, pal.accent].forEach(function (c) { var i = el('i'); i.style.background = c; sw.appendChild(i); });
      b.append(sw, el('span', { text: pal.name }));
      b.addEventListener('click', function () {
        setTheme({ mode: pal.mode, primary: pal.primary, secondary: pal.secondary, accent: pal.accent }, true);
      });
      return b;
    }));
  }

  function renderAppearance() {
    var th = state.theme;
    $('appearance').hidden = !state.ui.appearance;
    $('btn-appearance').setAttribute('aria-pressed', state.ui.appearance ? 'true' : 'false');
    renderPalettes();
    ['primary', 'secondary', 'accent'].forEach(function (k) {
      var input = $('pick-' + k);
      if (document.activeElement !== input) input.value = th[k];
      $('hex-' + k).textContent = th[k].toUpperCase();
    });
    var ratio = T.palette(th).buttonContrast;
    $('contrast-note').textContent = 'button text contrast ' + ratio.toFixed(1) + ':1' + (ratio >= 4.5 ? ', passes AA' : ', too low for small text');
    $('mode-light').setAttribute('aria-pressed', th.mode === 'light' ? 'true' : 'false');
    $('mode-dark').setAttribute('aria-pressed', th.mode === 'dark' ? 'true' : 'false');
    if (document.activeElement !== $('font-head')) fillSelect($('font-head'), HEAD_OPTIONS, th.headFont);
    if (document.activeElement !== $('font-body')) fillSelect($('font-body'), BODY_OPTIONS, th.bodyFont);
    $('text-size').value = String(th.textSize);
    $('hide-claude-sidebar').checked = !!th.hideClaudeSidebar;

    var host = $('custom-fonts');
    host.replaceChildren.apply(host, fonts.filter(function (f) { return !f.bundled; })
      .reduce(function (acc, f) { if (acc.indexOf(f.family) < 0) acc.push(f.family); return acc; }, [])
      .map(function (fam) {
        var row = el('div', { class: 'custom-font' });
        var name = el('span', { text: fam });
        name.style.fontFamily = T.quoteFamily(fam) + ', var(--body)';
        var rm = el('button', { type: 'button', text: 'remove', 'aria-label': 'Remove font ' + fam });
        rm.addEventListener('click', function () { api.invoke('fonts:remove', fam).then(setFonts); });
        row.append(name, rm);
        return row;
      }));
  }

  // Register added font files in the shell so menus and specimens can show them.
  function setFonts(list) {
    fonts = Array.isArray(list) ? list : [];
    fonts.filter(function (f) { return !f.bundled; }).forEach(function (f) {
      try {
        var face = new FontFace(f.family, 'url("' + f.url + '")', { weight: String(f.weight || '400'), style: f.style || 'normal' });
        face.load().then(function (loaded) { document.fonts.add(loaded); }).catch(function () {});
      } catch (e) { /* unsupported font file */ }
    });
    renderAppearance();
  }

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------
  function renderUpdate() {
    var u = state.update || { state: 'off' };
    var b = $('btn-update');
    var v = u.version ? 'v' + u.version : '';
    var text = v, title = 'Check for updates';
    if (u.state === 'off') { text = 'dev build'; title = 'Started without the updater (npm run dev)'; }
    else if (u.state === 'checking') text = 'checking…';
    else if (u.state === 'downloading') text = 'downloading v' + (u.remoteVersion || '') + '…';
    else if (u.state === 'updated') { text = 'updated to ' + v; title = 'Updated while running. Click to check again.'; }
    else if (u.state === 'restart') { text = 'restart to update'; title = 'v' + u.version + ' is downloaded. Your panes reopen after the restart.'; }
    else if (u.state === 'reinstall') { text = 'v' + (u.remoteVersion || '') + ' needs a reinstall'; title = 'This update changes the launcher. Download the app again from GitHub.'; }
    else if (u.state === 'error') { text = v + ' · check failed'; title = u.message || 'Update check failed'; }
    b.textContent = text;
    b.title = title;
    b.disabled = u.state === 'off' || u.state === 'checking' || u.state === 'downloading';
    b.classList.toggle('is-ready', u.state === 'restart');
    b.classList.toggle('is-news', u.state === 'updated' || u.state === 'reinstall');
  }

  function render() {
    applyShellTheme(state.theme);
    renderUpdate();
    renderPanes();
    renderSidebar();
    renderAppearance();
  }

  $('toggle-sidebar').addEventListener('click', function () { send('ui:set', { sidebar: !state.ui.sidebar }); });
  $('btn-update').addEventListener('click', function () {
    send((state.update && state.update.state === 'restart') ? 'update:restart' : 'update:check');
  });
  $('btn-appearance').addEventListener('click', function () { send('ui:set', { appearance: !state.ui.appearance }); });
  $('close-appearance').addEventListener('click', function () { send('ui:set', { appearance: false }); });
  $('btn-split').addEventListener('click', function () { send('pane:split'); });
  $('btn-single').addEventListener('click', function () { if (state.focus != null) send('pane:only', state.focus); });
  $('btn-new').addEventListener('click', function () { send('nav:go', 'new'); });
  document.querySelectorAll('[data-nav]').forEach(function (b) {
    b.addEventListener('click', function () { send('nav:go', b.getAttribute('data-nav')); });
  });
  $('search').addEventListener('input', function (e) { query = e.target.value; renderSidebar(); });
  $('search').addEventListener('keydown', function (e) { if (e.key === 'Enter') send('nav:go', 'chats'); });
  $('btn-retry').addEventListener('click', function () { retries = 0; chats.error = null; chats.loaded = false; renderSidebar(); loadChats(); });
  $('btn-native-sidebar').addEventListener('click', function () { setTheme({ hideClaudeSidebar: false }, true); });

  ['primary', 'secondary', 'accent'].forEach(function (k) {
    $('pick-' + k).addEventListener('input', function (e) { var p = {}; p[k] = e.target.value.toLowerCase(); setTheme(p); });
  });
  $('mode-light').addEventListener('click', function () { setTheme(modePatch('light'), true); });
  $('mode-dark').addEventListener('click', function () { setTheme(modePatch('dark'), true); });
  $('font-head').addEventListener('change', function (e) { setTheme({ headFont: e.target.value }, true); });
  $('font-body').addEventListener('change', function (e) { setTheme({ bodyFont: e.target.value }, true); });
  $('text-size').addEventListener('change', function (e) { setTheme({ textSize: Number(e.target.value) }, true); });
  $('hide-claude-sidebar').addEventListener('change', function (e) { setTheme({ hideClaudeSidebar: e.target.checked }, true); });
  $('btn-reset').addEventListener('click', function () { setTheme(T.withDefaults({}), true); });

  var useTyped = function (key) {
    var v = $('other-font').value.trim();
    if (!v) { $('other-font').focus(); return; }
    var patch = {}; patch[key] = T.quoteFamily(v);
    setTheme(patch, true);
  };
  $('use-head').addEventListener('click', function () { useTyped('headFont'); });
  $('use-body').addEventListener('click', function () { useTyped('bodyFont'); });

  $('btn-add-font').addEventListener('click', function () { if (api) api.invoke('fonts:add').then(setFonts); });
  $('btn-system-fonts').addEventListener('click', function () {
    var note = $('font-note');
    if (!('queryLocalFonts' in window)) { note.textContent = 'This system can\'t list fonts. Type a font name below instead.'; return; }
    window.queryLocalFonts().then(function (list) {
      var fams = {};
      list.forEach(function (f) { fams[f.family] = true; });
      systemFonts = Object.keys(fams).sort(function (a, b) { return a.localeCompare(b); });
      note.textContent = systemFonts.length + ' installed families added to both menus.';
      renderAppearance();
    }).catch(function () {
      note.textContent = 'Listing fonts wasn\'t allowed. Type a font name below instead.';
    });
  });

  // Keep the primary readable when switching modes, as the mockup does.
  function modePatch(mode) {
    var th = state.theme, p = { mode: mode };
    var panel = mode === 'dark' ? '#1b1b1b' : '#f7f7f4';
    if (T.contrast(th.primary, panel) < 3) p.primary = mode === 'dark' ? '#ededea' : '#111111';
    if (mode === 'dark' && T.lum(th.secondary) > 0.4) p.secondary = '#55554f';
    if (mode === 'light' && T.lum(th.secondary) < 0.2) p.secondary = '#d6d6d0';
    return p;
  }

  if (api) {
    api.on('state', function (s) {
      var prevPanes = JSON.stringify(state.panes.map(function (p) { return p.url; }));
      state = s;
      render();
      if (prevPanes !== JSON.stringify(s.panes.map(function (p) { return p.url; })) && !chats.loaded) loadChats();
    });
    api.on('chats-changed', loadChats);
    window.addEventListener('focus', function () { if (chats.loaded) loadChats(); });
    api.invoke('fonts:list').then(setFonts);
    send('shell:ready');
    setTimeout(loadChats, 2500);
  }
  render();
})();
