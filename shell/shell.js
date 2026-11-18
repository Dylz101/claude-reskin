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
  var chats = { starred: [], recents: [], hasMore: false, loadingMore: false, error: null, loaded: false };
  var code = { items: [], error: null, loaded: false };
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
    titles.append(num, title, subRow);
    var back = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Back', title: 'Back (Ctrl/Cmd+[)' }, SVG.back);
    var reload = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Reload pane', title: 'Reload (Ctrl/Cmd+R)' }, SVG.reload);
    var only = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Show only this pane', title: 'Show only this pane' }, SVG.only);
    var close = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close pane', title: 'Close pane (Ctrl/Cmd+W)' }, SVG.close);
    head.append(titles, back, reload, only, close);
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
  // The sidebar follows the focused pane, as the desktop app's does: Claude
  // Code sessions while that pane is in Code, chats everywhere else.
  function sidebarMode() {
    var p = state.panes.find(function (x) { return x.id === state.focus; });
    return p && /^\/code(\/|$)/.test(pathOf(p.url)) ? 'code' : 'chats';
  }
  function pathOf(url) { try { return new URL(url).pathname; } catch (e) { return ''; } }
  function chatIdFromUrl(url) {
    var m = /^\/chat\/([0-9a-f-]{8,})/i.exec(pathOf(url));
    return m ? m[1] : null;
  }
  function sessionIdFromUrl(url) {
    var m = /^\/code\/(session_[A-Za-z0-9]+)/.exec(pathOf(url));
    return m ? m[1] : null;
  }

  var LIVE_STATUS = /^(running|working|active|in_progress|requires_action|waiting|pending|starting)$/;

  // kind: 'chat' or 'session'. Rows show the pane number a chat is open in.
  function listRow(c, kind) {
    var idOf = kind === 'session' ? sessionIdFromUrl : chatIdFromUrl;
    var openAt = -1, focused = false;
    state.panes.forEach(function (p, i) {
      if (idOf(p.url) === c.id) { openAt = i; if (p.id === state.focus) focused = true; }
    });
    var live = kind === 'session' && LIVE_STATUS.test(c.status || '');
    var row = el('div', { class: 'chat-row' + (openAt >= 0 ? ' is-open' : '') + (focused ? ' is-focused' : '') + (live ? ' is-live' : '') });
    var tip = [c.title, c.project, c.repo, c.status ? c.status.replace(/_/g, ' ') : ''].filter(Boolean).join(' · ');
    var open = el('button', { type: 'button', class: 'chat-open', title: tip });
    open.append(el('span', { class: 'badge', text: openAt >= 0 ? pad(openAt + 1) : (live ? '●' : '··') }), el('span', { class: 'title', text: c.title }));
    var full = state.panes.length >= state.max && openAt < 0;
    var split = el('button', {
      type: 'button', class: 'icon-btn chat-split',
      'aria-label': 'Open ' + c.title + ' in a split pane',
      title: full ? 'Close a pane first, or click the title to open it here' : 'Open in a split pane'
    }, SVG.split);
    if (full) split.disabled = true;
    var channel = kind === 'session' ? 'session:open' : 'chat:open';
    open.addEventListener('click', function () { send(channel, { id: c.id, split: false }); });
    split.addEventListener('click', function () { send(channel, { id: c.id, split: true }); });
    row.append(open, split);
    return row;
  }

  function matches(q) {
    return function (c) {
      return !q || [c.title, c.project, c.repo].some(function (s) { return (s || '').toLowerCase().indexOf(q) >= 0; });
    };
  }

  var lastMode = null;
  function renderSidebar() {
    $('sidebar').hidden = !state.ui.sidebar;
    var mode = sidebarMode();
    if (mode !== lastMode) {
      lastMode = mode;
      if (mode === 'code') loadCode();
    }
    var isCode = mode === 'code';
    $('sidebar').setAttribute('data-mode', mode);
    $('btn-new').querySelector('span').textContent = isCode ? 'new session' : 'new chat';
    $('search').placeholder = isCode ? 'search sessions' : 'search chats';
    $('search').setAttribute('aria-label', isCode ? 'Search sessions' : 'Search chats');
    $('recents-label').textContent = isCode ? 'sessions' : 'recents';
    document.querySelectorAll('[data-nav]').forEach(function (b) {
      var where = b.getAttribute('data-nav');
      b.classList.toggle('is-current', isCode ? where === 'code' : where === 'chats' && /^\/recents/.test(pathOf((state.panes.find(function (p) { return p.id === state.focus; }) || {}).url)));
    });

    var q = query.trim().toLowerCase();
    var src = isCode ? code : chats;
    var starred = isCode ? [] : chats.starred.filter(matches(q));
    var list = (isCode ? code.items : chats.recents).filter(matches(q));
    var ls = $('list-starred'), lr = $('list-recents');
    ls.replaceChildren.apply(ls, starred.map(function (c) { return listRow(c, 'chat'); }));
    lr.replaceChildren.apply(lr, list.map(function (c) { return listRow(c, isCode ? 'session' : 'chat'); }));
    $('group-starred').hidden = !starred.length;

    var more = $('btn-more');
    more.hidden = isCode || !chats.hasMore || !!chats.error;
    more.disabled = chats.loadingMore;
    more.textContent = chats.loadingMore ? 'loading…' : 'load more';

    var note = $('chats-note'), actions = $('chats-actions');
    note.hidden = true; actions.hidden = true;
    $('btn-open-code').hidden = true;
    var empty = !list.length && !starred.length;
    var say = function (text) { note.hidden = false; note.textContent = text; };
    if (!src.loaded && !src.error) say(isCode ? 'loading your sessions…' : 'loading your chats…');
    else if (src.error === 'signed-out') { say('Sign in to claude.ai in the pane on the right. Your ' + (isCode ? 'sessions' : 'chats') + ' will appear here.'); actions.hidden = false; }
    else if (isCode && src.error === 'open-code') {
      say('Open code in a pane once so the app can read your session list. claude.ai\'s own sidebar there lists them too.');
      actions.hidden = false; $('btn-open-code').hidden = false;
    } else if (src.error && empty) {
      say('Couldn\'t load your ' + (isCode ? 'sessions' : 'chat list') + ' (' + src.error + '). claude.ai\'s own sidebar still works.');
      actions.hidden = false;
    } else if (q && empty) say(isCode ? 'No sessions match.' : (chats.hasMore ? 'No loaded chats match. Press Enter to search all chats.' : 'No chats match. Press Enter to search on claude.ai.'));
    else if (src.loaded && !src.error && empty && !q) say(isCode ? 'No sessions yet.' : 'No chats yet.');
    $('btn-native-sidebar').hidden = !state.theme.hideClaudeSidebar || isCode;
    fillIfShort();
  }

  // Load the next page when the list is scrolled near its end, or when it is
  // too short to scroll at all, the way claude.ai's recents list does.
  function nearEnd() {
    var s = $('sidebar');
    return s.scrollHeight - s.scrollTop - s.clientHeight < 240;
  }
  function fillIfShort() {
    if (sidebarMode() === 'chats' && !query.trim() && chats.hasMore && !chats.loadingMore && !chats.error && state.ui.sidebar && nearEnd()) {
      requestAnimationFrame(function () { if (nearEnd()) loadMoreChats(); });
    }
  }

  var chatTimer = null, codeTimer = null;
  var retries = 0, codeRetries = 0;
  var REFRESH_FOCUSED = 30000, REFRESH_IDLE = 120000;
  var refreshIn = function () { return document.hasFocus() ? REFRESH_FOCUSED : REFRESH_IDLE; };
  var chatSeq = 0;

  // Panes may still be loading on first launch; retry quietly a few times.
  var transient = function (err) { return err === 'no-pane' || /Failed to fetch|http 5|bad pane response/.test(err); };

  function applyChats(res) {
    chats.starred = res.starred || chats.starred;
    chats.recents = res.recents || chats.recents;
    chats.hasMore = !!res.hasMore;
  }

  function loadChats() {
    if (!api) return;
    clearTimeout(chatTimer);
    var mySeq = ++chatSeq;
    api.invoke('chats:list', { more: false }).then(function (res) {
      if (mySeq !== chatSeq) return; // a newer load has started
      res = res || { error: 'unknown error' };
      if (res.error && transient(res.error) && retries < 5) { retries++; chatTimer = setTimeout(loadChats, 3000); return; }
      if (!res.error) retries = 0;
      applyChats(res);
      chats.error = res.error ? (res.error === 'no-pane' ? 'no claude.ai pane open' : res.error) : null;
      chats.loaded = true;
      renderSidebar();
      chatTimer = setTimeout(loadChats, refreshIn());
    });
  }

  function loadMoreChats() {
    if (!api || chats.loadingMore || !chats.hasMore) return;
    chats.loadingMore = true;
    renderSidebar();
    api.invoke('chats:list', { more: true }).then(function (res) {
      chats.loadingMore = false;
      res = res || {};
      if (!res.error) applyChats(res);
      else chats.hasMore = chats.hasMore && transient(res.error);
      renderSidebar();
    });
  }

  function loadCode() {
    if (!api) return;
    clearTimeout(codeTimer);
    api.invoke('code:list').then(function (res) {
      res = res || { error: 'unknown error' };
      if (res.error && transient(res.error) && codeRetries < 5) { codeRetries++; codeTimer = setTimeout(loadCode, 3000); return; }
      if (!res.error) codeRetries = 0;
      if (res.items) code.items = res.items;
      code.error = res.error ? (res.error === 'no-pane' ? 'no claude.ai pane open' : res.error) : null;
      code.loaded = true;
      renderSidebar();
      // Sessions only refresh on a timer while the sidebar shows them.
      if (sidebarMode() === 'code') codeTimer = setTimeout(loadCode, refreshIn());
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
      var on = !th.background && th.mode === pal.mode && th.primary === pal.primary && th.secondary === pal.secondary && th.accent === pal.accent;
      var b = el('button', { type: 'button', class: 'palette', 'aria-pressed': on ? 'true' : 'false' });
      var sw = el('span', { class: 'swatches' });
      [pal.primary, pal.secondary, pal.accent].forEach(function (c) { var i = el('i'); i.style.background = c; sw.appendChild(i); });
      b.append(sw, el('span', { text: pal.name }));
      b.addEventListener('click', function () {
        setTheme({ mode: pal.mode, background: '', primary: pal.primary, secondary: pal.secondary, accent: pal.accent }, true);
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
    var panel = T.palette(th).panel;
    if (document.activeElement !== $('pick-background')) $('pick-background').value = panel;
    $('hex-background').textContent = panel.toUpperCase();
    $('reset-background').hidden = !th.background;
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
  // One click on the version button updates to the newest build. Updates to
  // the look apply in place; anything else restarts the app straight away,
  // reopening the same panes. Background checks never restart on their own:
  // they only download and show "restart to update".
  var updateAsked = null; // { from: state when clicked, seen: the check has started }
  var restarting = false;

  function renderUpdate() {
    var u = state.update || { state: 'off' };
    var b = $('btn-update');
    var v = u.version ? 'v' + u.version : '';
    if (updateAsked && (u.state === 'checking' || u.state === 'downloading')) updateAsked.seen = true;
    if (updateAsked && updateAsked.seen) {
      // The check found a build that needs a restart, or confirmed the one
      // already downloaded is the newest.
      if (u.state === 'restart') {
        updateAsked = null;
        restarting = true;
        send('update:restart');
      } else if (u.state === 'current' || u.state === 'updated' || u.state === 'error' || u.state === 'reinstall') {
        updateAsked = null;
      }
    }
    var text = v, title = 'Update to the latest version';
    if (u.state === 'off') { text = 'dev build'; title = 'Started without the updater (npm run dev)'; }
    else if (restarting) { text = 'restarting…'; title = 'Restarting into ' + v + '. Your panes reopen.'; }
    else if (u.state === 'checking') text = 'checking…';
    else if (u.state === 'downloading') text = 'downloading v' + (u.remoteVersion || '') + '…';
    else if (u.state === 'current') title = v + ' is the latest version. Click to check again.';
    else if (u.state === 'updated') { text = 'updated to ' + v; title = 'Updated while running. Click to check again.'; }
    else if (u.state === 'restart') { text = 'restart to update'; title = 'v' + u.version + ' is downloaded. Click to restart into it; your panes reopen.'; }
    else if (u.state === 'reinstall') { text = 'v' + (u.remoteVersion || '') + ' needs a reinstall'; title = 'This update changes the launcher. Download the app again from GitHub.'; }
    else if (u.state === 'error') { text = v + ' · check failed'; title = (u.message || 'Update check failed') + '. Click to try again.'; }
    b.textContent = text;
    b.title = title;
    b.disabled = u.state === 'off' || u.state === 'checking' || u.state === 'downloading' || restarting;
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
    var u = state.update || { state: 'off' };
    if (u.state === 'off' || restarting) return;
    // Check first even when a build is already downloaded, so the restart
    // lands on the newest one.
    var asked = updateAsked = { from: u.state, seen: false };
    send('update:check');
    // A background check already running won't announce 'checking'; act on
    // whatever it settles on.
    setTimeout(function () { if (updateAsked === asked && !asked.seen) { asked.seen = true; renderUpdate(); } }, 4000);
  });
  $('btn-appearance').addEventListener('click', function () { send('ui:set', { appearance: !state.ui.appearance }); });
  $('close-appearance').addEventListener('click', function () { send('ui:set', { appearance: false }); });
  $('btn-split').addEventListener('click', function () { send('pane:split'); });
  $('btn-single').addEventListener('click', function () { if (state.focus != null) send('pane:only', state.focus); });
  $('btn-new').addEventListener('click', function () { send('nav:go', sidebarMode() === 'code' ? 'code' : 'new'); });
  document.querySelectorAll('[data-nav]').forEach(function (b) {
    b.addEventListener('click', function () { send('nav:go', b.getAttribute('data-nav')); });
  });
  $('search').addEventListener('input', function (e) { query = e.target.value; renderSidebar(); });
  $('search').addEventListener('keydown', function (e) { if (e.key === 'Enter' && sidebarMode() === 'chats') send('nav:go', 'chats'); });
  $('sidebar').addEventListener('scroll', function () { if (nearEnd()) fillIfShort(); }, { passive: true });
  $('btn-more').addEventListener('click', loadMoreChats);
  $('btn-open-code').addEventListener('click', function () { send('nav:go', 'code'); });
  $('btn-retry').addEventListener('click', function () {
    if (sidebarMode() === 'code') { codeRetries = 0; code.error = null; code.loaded = false; renderSidebar(); loadCode(); }
    else { retries = 0; chats.error = null; chats.loaded = false; renderSidebar(); loadChats(); }
  });
  $('btn-native-sidebar').addEventListener('click', function () { setTheme({ hideClaudeSidebar: false }, true); });

  ['primary', 'secondary', 'accent'].forEach(function (k) {
    $('pick-' + k).addEventListener('input', function (e) { var p = {}; p[k] = e.target.value.toLowerCase(); setTheme(p); });
  });
  $('pick-background').addEventListener('input', function (e) {
    var c = e.target.value.toLowerCase();
    var p = modePatch(T.isDark(c) ? 'dark' : 'light'); // also keeps primary and secondary readable
    p.background = c;
    setTheme(p);
  });
  $('reset-background').addEventListener('click', function () { setTheme({ background: '' }, true); });
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
    var th = state.theme, p = { mode: mode, background: '' };
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
    api.on('code-changed', function () { if (sidebarMode() === 'code' || code.loaded) loadCode(); });
    window.addEventListener('focus', function () {
      if (chats.loaded) loadChats();
      if (sidebarMode() === 'code') loadCode();
    });
    api.invoke('fonts:list').then(setFonts);
    send('shell:ready');
    setTimeout(loadChats, 2500);
  }
  render();
})();
