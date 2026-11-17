/*
 * Browser-only stand-in for the Electron main process, for previewing the
 * shell without Electron: inject before shell.js loads (see dev/preview.js).
 * Draws a placeholder where each claude.ai pane would sit.
 */
(function () {
  'use strict';
  var listeners = { state: [], 'chats-changed': [] };
  var seq = 0;
  var CHATS = [
    { id: '1a2b3c4d-0000-4000-8000-000000000001', title: 'userstyle dark-mode scope', starred: true, project: 'reskin', updated: '2026-11-17T09:00:00Z' },
    { id: '1a2b3c4d-0000-4000-8000-000000000002', title: 'kitchen tiling quotes', starred: false, project: 'home reno', updated: '2026-11-17T08:00:00Z' },
    { id: '1a2b3c4d-0000-4000-8000-000000000003', title: 'cederberg hiking plan', starred: false, project: '', updated: '2026-11-16T08:00:00Z' },
    { id: '1a2b3c4d-0000-4000-8000-000000000004', title: 'explain css :has()', starred: false, project: '', updated: '2026-11-15T08:00:00Z' },
    { id: '1a2b3c4d-0000-4000-8000-000000000005', title: 'pane layout ideas', starred: true, project: 'reskin', updated: '2026-11-14T08:00:00Z' }
  ];
  var titleOf = function (url) {
    var c = CHATS.find(function (x) { return url.indexOf(x.id) >= 0; });
    return c ? c.title : (/\/new/.test(url) ? 'new chat' : 'claude');
  };
  var st = {
    panes: [
      { id: ++seq, url: 'https://claude.ai/chat/' + CHATS[0].id },
      { id: ++seq, url: 'https://claude.ai/chat/' + CHATS[1].id }
    ],
    focus: 2, max: 3,
    theme: { mode: 'light', primary: '#111111', secondary: '#d6d6d0', accent: '#ff4f00', headFont: '"Foun"', bodyFont: '"CS Genio Mono"', textSize: 13, hideClaudeSidebar: true },
    ui: { sidebar: true, appearance: true }
  };
  window.__previewLayout = [];

  function emit() {
    var payload = JSON.parse(JSON.stringify(st));
    payload.panes = st.panes.map(function (p) { return { id: p.id, url: p.url, title: titleOf(p.url), loading: false, canGoBack: true }; });
    setTimeout(function () { listeners.state.forEach(function (fn) { fn(payload); }); }, 0);
  }
  function open(url, split) {
    var hit = st.panes.find(function (p) { return p.url === url; });
    if (hit) { st.focus = hit.id; return emit(); }
    if (split && st.panes.length < st.max) { var p = { id: ++seq, url: url }; st.panes.push(p); st.focus = p.id; }
    else { var f = st.panes.find(function (p) { return p.id === st.focus; }) || st.panes[0]; f.url = url; }
    emit();
  }
  function drawLayout(rects) {
    window.__previewLayout = rects;
    var layer = document.getElementById('__preview-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = '__preview-layer';
      layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9999';
      document.body.appendChild(layer);
    }
    layer.replaceChildren();
    rects.forEach(function (r, i) {
      var d = document.createElement('div');
      d.style.cssText = 'position:absolute;left:' + r.x + 'px;top:' + r.y + 'px;width:' + r.width + 'px;height:' + r.height +
        'px;outline:1px dashed rgba(128,128,128,.5);outline-offset:-8px;display:grid;place-items:center;color:rgba(128,128,128,.8);font:12px monospace';
      d.textContent = 'claude.ai pane ' + (i + 1) + ' (' + Math.round(r.width) + '×' + Math.round(r.height) + ')';
      layer.appendChild(d);
    });
  }

  window.reskin = {
    send: function (ch, data) {
      if (ch === 'shell:ready') emit();
      else if (ch === 'pane:layout') drawLayout(data);
      else if (ch === 'pane:focus') { st.focus = data; emit(); }
      else if (ch === 'pane:close') {
        st.panes = st.panes.filter(function (p) { return p.id !== data; });
        if (!st.panes.length) st.panes.push({ id: ++seq, url: 'https://claude.ai/new' });
        if (!st.panes.some(function (p) { return p.id === st.focus; })) st.focus = st.panes[st.panes.length - 1].id;
        emit();
      }
      else if (ch === 'pane:only') { st.panes = st.panes.filter(function (p) { return p.id === data; }); st.focus = data; emit(); }
      else if (ch === 'pane:split') open('https://claude.ai/new?' + (++seq), true);
      else if (ch === 'chat:open') open('https://claude.ai/chat/' + data.id, data.split);
      else if (ch === 'nav:go') open('https://claude.ai/' + data, false);
      else if (ch === 'ui:set') { Object.assign(st.ui, data); emit(); }
      else if (ch === 'theme:set') { Object.assign(st.theme, data); emit(); }
    },
    invoke: function (ch) {
      if (ch === 'chats:list') return Promise.resolve({ items: CHATS });
      if (ch === 'fonts:list') return Promise.resolve([]);
      return Promise.resolve([]);
    },
    on: function (ch, fn) { (listeners[ch] = listeners[ch] || []).push(fn); return function () {}; }
  };
})();
