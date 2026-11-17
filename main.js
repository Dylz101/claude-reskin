'use strict';

/*
 * claude-reskin: a desktop shell for claude.ai.
 *
 * Every pane is a real claude.ai page in its own WebContentsView, so all of
 * claude.ai's features keep working. The shell window (shell/) draws the top
 * bar, the chat sidebar and the appearance panel, and tells this process
 * where each pane should sit.
 */

const {
  app, BaseWindow, WebContentsView, ipcMain, Menu, nativeTheme, session, shell, dialog, clipboard
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

// APP_DIR is where the running copy of the app's files lives. It changes when
// an update is swapped in while the app runs (see hotSwap below).
let APP_DIR = __dirname;
let Theme = require('./theme.js');
const updater = global.reskinUpdater || null; // set by bootstrap.js
let update = { state: updater ? 'current' : 'off', version: updater ? updater.version : 'dev' };

const CLAUDE = 'https://claude.ai';
const MAX_PANES = 3;
const IS_MAC = process.platform === 'darwin';

// Hosts a pane may navigate to without leaving the app (sign-in and billing).
const IN_APP_HOSTS = [
  'claude.ai', 'claude.com', 'accounts.google.com', 'appleid.apple.com',
  'checkout.stripe.com', 'billing.stripe.com', 'js.stripe.com'
];

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const userFile = (...p) => path.join(app.getPath('userData'), ...p);
let settings = {};
let saveTimer = null;

function loadSettings() {
  try { settings = JSON.parse(fs.readFileSync(userFile('settings.json'), 'utf8')) || {}; }
  catch { settings = {}; }
  settings.theme = Theme.withDefaults(Theme.sanitize(settings.theme));
  settings.ui =Object.assign({ sidebar: true, appearance: false }, settings.ui);
  settings.panes = Array.isArray(settings.panes) && settings.panes.length ? settings.panes.slice(0, MAX_PANES) : [CLAUDE + '/new'];
  settings.focus = Number.isInteger(settings.focus) ? settings.focus : 0;
  settings.fonts = Array.isArray(settings.fonts) ? settings.fonts : [];
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}
function saveNow() {
  clearTimeout(saveTimer);
  if (win && !win.isDestroyed()) {
    settings.bounds = win.getNormalBounds ? win.getNormalBounds() : win.getBounds();
    settings.panes = panes.map((p) => p.url || CLAUDE + '/new');
    settings.focus = Math.max(0, panes.findIndex((p) => p.id === focusId));
  }
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(userFile('settings.json'), JSON.stringify(settings, null, 2));
  } catch (err) { console.error('Could not save settings:', err); }
}

// ---------------------------------------------------------------------------
// Fonts: bundled stand-ins plus any files the user adds
// ---------------------------------------------------------------------------
const bundledFonts = () => [
  { family: 'Antonio', file: path.join(APP_DIR, 'fonts', 'antonio.woff2'), weight: '100 900' },
  { family: 'Space Mono', file: path.join(APP_DIR, 'fonts', 'space-mono-400.woff2'), weight: '400' },
  { family: 'Space Mono', file: path.join(APP_DIR, 'fonts', 'space-mono-700.woff2'), weight: '700' }
];
const FONT_TYPES = { '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf' };
let fontFaceCache = null;

function guessWeight(name) {
  const n = name.toLowerCase();
  if (/black|heavy/.test(n)) return '900';
  if (/extrabold|ultrabold/.test(n)) return '800';
  if (/semibold|demibold/.test(n)) return '600';
  if (/bold/.test(n)) return '700';
  if (/medium/.test(n)) return '500';
  if (/light/.test(n)) return '300';
  if (/thin|hairline/.test(n)) return '200';
  return '400';
}
// "CSGenioMono-Regular.otf" -> "CS Genio Mono", "Foun Bold.ttf" -> "Foun".
function familyFromFile(file) {
  const base = path.basename(file, path.extname(file));
  const fam = base.split(/[-_]/)[0]
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b(Regular|Bold|Italic|Light|Medium|Semi ?Bold|Extra ?Bold|Black|Thin|Heavy|Book|Oblique|Demo|Free|Personal ?Use)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return fam || base;
}
function allFonts() {
  const user = settings.fonts
    .map((f) => ({ family: f.family, file: userFile('fonts', f.file), weight: f.weight || '400', style: f.style || 'normal' }))
    .filter((f) => fs.existsSync(f.file));
  return bundledFonts().concat(user);
}
function fontFaceCSS() {
  if (fontFaceCache !== null) return fontFaceCache;
  fontFaceCache = allFonts().map((f) => {
    const ext = path.extname(f.file).toLowerCase();
    const data = fs.readFileSync(f.file).toString('base64');
    return `@font-face { font-family: "${f.family}"; src: url(data:${FONT_TYPES[ext] || 'font/woff2'};base64,${data}); font-weight: ${f.weight}; font-style: ${f.style || 'normal'}; font-display: swap; }`;
  }).join('\n');
  return fontFaceCache;
}
function fontListForShell() {
  return allFonts().map((f) => ({
    family: f.family, weight: f.weight, style: f.style || 'normal',
    url: pathToFileURL(f.file).href, bundled: f.file.startsWith(path.join(APP_DIR, 'fonts'))
  }));
}

// claude.ai's Content-Security-Policy may not allow data: fonts, which the
// injected @font-face rules use. Add data: to font-src for claude.ai only.
function patchCSP(value) {
  const parts = String(value).split(';').map((s) => s.trim()).filter(Boolean);
  let found = false;
  const out = parts.map((p) => {
    if (/^font-src\b/i.test(p)) { found = true; return /\sdata:/.test(p) ? p : p + ' data:'; }
    return p;
  });
  const def = out.find((p) => /^default-src\b/i.test(p));
  if (!found && def) out.push('font-src ' + def.replace(/^default-src\s*/i, '') + ' data:');
  return out.join('; ');
}

// ---------------------------------------------------------------------------
// Window and panes
// ---------------------------------------------------------------------------
let win = null;
let shellView = null;
let panes = [];          // { id, view, url, title, cssKey }
let focusId = null;
let seq = 0;

function isClaudeUrl(u) {
  try { const h = new URL(u).hostname; return h === 'claude.ai' || h.endsWith('.claude.ai'); } catch { return false; }
}
function isInAppHost(u) {
  try {
    const h = new URL(u).hostname;
    return IN_APP_HOSTS.some((allowed) => h === allowed || h.endsWith('.' + allowed));
  } catch { return false; }
}
function sameChat(a, b) {
  try {
    const A = new URL(a), B = new URL(b);
    return A.hostname === B.hostname && A.pathname.replace(/\/$/, '') === B.pathname.replace(/\/$/, '') && !/^\/new\/?$/.test(A.pathname);
  } catch { return false; }
}
const paneById = (id) => panes.find((p) => p.id === id);
const focusedPane = () => paneById(focusId) || panes[panes.length - 1];

function createWindow() {
  const b = settings.bounds || {};
  win = new BaseWindow({
    width: b.width || 1440, height: b.height || 900, x: b.x, y: b.y,
    minWidth: 720, minHeight: 520,
    title: 'Claude Reskin',
    backgroundColor: Theme.palette(settings.theme).ground,
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    trafficLightPosition: IS_MAC ? { x: 14, y: 18 } : undefined
  });

  createShellView();
  win.on('resize', () => { fitShell(); saveSoon(); });
  win.on('move', saveSoon);
  win.on('close', saveNow);
  win.on('closed', () => {
    panes.forEach((p) => { if (!p.view.webContents.isDestroyed()) p.view.webContents.close(); });
    if (shellView && !shellView.webContents.isDestroyed()) shellView.webContents.close();
    win = null; shellView = null; panes = [];
  });

  settings.panes.forEach((url) => addPane(url));
  const f = panes[Math.min(settings.focus, panes.length - 1)];
  focusId = f ? f.id : null;
}

function fitShell() {
  if (!win || !shellView) return;
  const { width, height } = win.getContentBounds();
  shellView.setBounds({ x: 0, y: 0, width, height });
}

// The shell sits underneath the panes (index 0). It is rebuilt from APP_DIR
// on a live update so its preload and pages all come from the new copy.
function createShellView() {
  const old = shellView;
  shellView = new WebContentsView({
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false
    }
  });
  win.contentView.addChildView(shellView, 0);
  shellView.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  shellView.webContents.on('will-navigate', (e) => e.preventDefault());
  shellView.webContents.loadFile(path.join(APP_DIR, 'shell', 'index.html'), { query: { platform: process.platform } });
  fitShell();
  if (old) {
    win.contentView.removeChildView(old);
    if (!old.webContents.isDestroyed()) old.webContents.close();
  }
}

// ---------------------------------------------------------------------------
// Updates (see bootstrap.js). Shell, theme and font changes swap in live;
// anything else waits for a restart, which reopens the same panes.
// ---------------------------------------------------------------------------
function setUpdate(patch) {
  update = Object.assign({}, update, patch);
  pushState();
  buildMenu();
}

function hotSwap(info) {
  APP_DIR = info.dir;
  Theme = require(path.join(info.dir, 'theme.js'));
  settings.theme = Theme.withDefaults(Theme.sanitize(settings.theme));
  fontFaceCache = null;
  updater.markApplied(info.manifest, info.dir);
  if (win) createShellView(); // the new shell asks for state when it loads
  applyThemeAll();
  setUpdate({ state: 'updated', version: info.manifest.version });
}

function restartToUpdate() {
  saveNow();
  app.relaunch();
  app.exit(0);
}

function wireUpdater() {
  if (!updater) return;
  updater.on('status', (s) => setUpdate(s));
  updater.on('ready', (info) => {
    if (info.kind === 'hot' && win) hotSwap(info);
    else setUpdate({ state: 'restart', version: info.manifest.version });
  });
}

function addPane(url) {
  const view = new WebContentsView({
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true }
  });
  view.setVisible(false); // shown once the shell reports where it goes
  const pane = { id: ++seq, view, url, title: '', cssKey: null };
  panes.push(pane);
  win.contentView.addChildView(view);
  wirePane(pane);
  view.webContents.loadURL(url);
  return pane;
}

function wirePane(pane) {
  const wc = pane.view.webContents;

  wc.on('dom-ready', () => { pane.cssKey = null; applyTheme(pane); });
  wc.on('page-title-updated', (_e, title) => { pane.title = cleanTitle(title); pushState(); });
  const onNav = (_e, url) => { pane.url = url; saveSoon(); pushState(); notifyChatsChanged(); };
  wc.on('did-navigate', onNav);
  wc.on('did-navigate-in-page', onNav);
  wc.on('did-start-loading', pushState);
  wc.on('did-stop-loading', pushState);
  wc.on('focus', () => { if (focusId !== pane.id) { focusId = pane.id; saveSoon(); pushState(); } });
  wc.on('render-process-gone', () => setTimeout(() => { if (!wc.isDestroyed()) wc.reload(); }, 800));

  // Links that want a new window: claude.ai pages open as a split pane,
  // sign-in pop-ups open as small windows, everything else in the browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (isClaudeUrl(url)) { openChat(url, 'split'); return { action: 'deny' }; }
    if (isInAppHost(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true } };
    }
    openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (!isInAppHost(url)) { e.preventDefault(); openExternal(url); }
  });

  wc.on('context-menu', (_e, params) => showContextMenu(pane, params));
}

function cleanTitle(t) {
  return String(t || '').replace(/\s*[-–|]\s*Claude\s*$/i, '').trim() || 'Claude';
}

async function applyTheme(pane) {
  const wc = pane.view.webContents;
  if (wc.isDestroyed()) return;
  const css = Theme.claudeCSS(settings.theme, fontFaceCSS());
  try {
    if (pane.cssKey) await wc.removeInsertedCSS(pane.cssKey);
    pane.cssKey = await wc.insertCSS(css, { cssOrigin: 'user' });
  } catch (err) { console.error('Theme injection failed:', err); }
}
function applyThemeAll() {
  nativeTheme.themeSource = settings.theme.mode === 'dark' ? 'dark' : 'light';
  if (win) win.setBackgroundColor(Theme.palette(settings.theme).ground);
  panes.forEach(applyTheme);
}

// mode: 'replace' loads into the focused pane, 'split' adds a pane when there is room.
function openChat(url, mode) {
  if (!win) return;
  const existing = panes.find((p) => sameChat(p.url, url));
  if (existing) { setFocus(existing.id, true); return; }
  if (mode === 'split' && panes.length < MAX_PANES) {
    const p = addPane(url);
    setFocus(p.id, true);
    return;
  }
  const target = focusedPane();
  if (!target) { const p = addPane(url); setFocus(p.id, true); return; }
  target.url = url;
  target.view.webContents.loadURL(url);
  setFocus(target.id, true);
}

function setFocus(id, focusContents) {
  const p = paneById(id);
  if (!p) return;
  focusId = id;
  if (focusContents && !p.view.webContents.isDestroyed()) p.view.webContents.focus();
  saveSoon();
  pushState();
}

function closePane(id) {
  const i = panes.findIndex((p) => p.id === id);
  if (i < 0) return;
  const [p] = panes.splice(i, 1);
  win.contentView.removeChildView(p.view);
  if (!p.view.webContents.isDestroyed()) p.view.webContents.close();
  if (!panes.length) addPane(CLAUDE + '/new');
  if (focusId === id) focusId = panes[Math.min(i, panes.length - 1)].id;
  saveSoon();
  pushState();
}

function onlyPane(id) {
  panes.filter((p) => p.id !== id).forEach((p) => closePane(p.id));
  setFocus(id, true);
}

function layoutPanes(rects) {
  const seen = new Set();
  (rects || []).forEach((r) => {
    const p = paneById(r.id);
    if (!p) return;
    seen.add(p.id);
    p.view.setBounds({
      x: Math.round(r.x), y: Math.round(r.y),
      width: Math.max(0, Math.round(r.width)), height: Math.max(0, Math.round(r.height))
    });
    p.view.setVisible(r.width > 0 && r.height > 0);
  });
  panes.forEach((p) => { if (!seen.has(p.id)) p.view.setVisible(false); });
}

function pushState() {
  if (!shellView || shellView.webContents.isDestroyed()) return;
  shellView.webContents.send('state', {
    panes: panes.map((p) => ({
      id: p.id, title: p.title || 'loading…', url: p.url,
      loading: !p.view.webContents.isDestroyed() && p.view.webContents.isLoading(),
      canGoBack: !p.view.webContents.isDestroyed() && p.view.webContents.navigationHistory.canGoBack()
    })),
    focus: focusId, max: MAX_PANES, theme: settings.theme, ui: settings.ui,
    platform: process.platform, update
  });
}

let chatsTimer = null;
function notifyChatsChanged() {
  clearTimeout(chatsTimer);
  chatsTimer = setTimeout(() => {
    if (shellView && !shellView.webContents.isDestroyed()) shellView.webContents.send('chats-changed');
  }, 1500);
}

// Runs inside a claude.ai page, with the user's own session, to list chats
// for the app's sidebar. These are the same requests claude.ai's sidebar makes.
async function chatFetcher() {
  const get = async (u) => {
    const r = await fetch(u, { credentials: 'include', headers: { accept: 'application/json' } });
    if (r.status === 401 || r.status === 403) throw new Error('signed-out');
    if (!r.ok) throw new Error('http ' + r.status);
    return r.json();
  };
  try {
    const orgs = await get('/api/organizations');
    if (!Array.isArray(orgs) || !orgs.length) return { error: 'signed-out' };
    const org = orgs.find((o) => Array.isArray(o.capabilities) && o.capabilities.includes('chat')) || orgs[0];
    const raw = await get('/api/organizations/' + org.uuid + '/chat_conversations?limit=60');
    const list = Array.isArray(raw) ? raw : (raw && raw.data) || [];
    const items = list.map((c) => ({
      id: c.uuid,
      title: c.name || 'untitled chat',
      updated: c.updated_at || c.created_at || '',
      starred: !!c.is_starred,
      project: c.project && c.project.name ? c.project.name : ''
    }));
    items.sort((a, b) => (a.updated < b.updated ? 1 : -1));
    return { items };
  } catch (err) {
    return { error: String(err && err.message ? err.message : err) };
  }
}

async function listChats() {
  const candidates = panes.filter((p) => !p.view.webContents.isDestroyed() && isClaudeUrl(p.view.webContents.getURL()));
  const p = candidates.find((c) => !c.view.webContents.isLoading()) || candidates[0];
  if (!p) return { error: 'no-pane' };
  try {
    return await p.view.webContents.executeJavaScript('(' + chatFetcher.toString() + ')()', true);
  } catch (err) {
    return { error: String(err && err.message ? err.message : err) };
  }
}

function openExternal(url) {
  try {
    const u = new URL(url);
    if (['https:', 'http:', 'mailto:'].includes(u.protocol)) shell.openExternal(url);
  } catch { /* ignore malformed links */ }
}

// ---------------------------------------------------------------------------
// Context menu (spelling, copy/paste, links) for claude.ai panes
// ---------------------------------------------------------------------------
function showContextMenu(pane, params) {
  const wc = pane.view.webContents;
  const items = [];
  if (params.misspelledWord) {
    (params.dictionarySuggestions || []).slice(0, 5).forEach((s) => items.push({ label: s, click: () => wc.replaceMisspelling(s) }));
    items.push({ label: 'Add to dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
    items.push({ type: 'separator' });
  }
  if (params.linkURL) {
    if (isClaudeUrl(params.linkURL)) {
      items.push({ label: 'Open in new pane', enabled: panes.length < MAX_PANES, click: () => openChat(params.linkURL, 'split') });
      items.push({ label: 'Open in this pane', click: () => { setFocus(pane.id); openChat(params.linkURL, 'replace'); } });
    } else {
      items.push({ label: 'Open in browser', click: () => openExternal(params.linkURL) });
    }
    items.push({ label: 'Copy link', click: () => clipboard.writeText(params.linkURL) });
    items.push({ type: 'separator' });
  }
  if (params.isEditable) {
    items.push({ role: 'cut', enabled: params.editFlags.canCut });
    items.push({ role: 'copy', enabled: params.editFlags.canCopy });
    items.push({ role: 'paste', enabled: params.editFlags.canPaste });
    items.push({ role: 'selectAll' });
  } else if (params.selectionText) {
    items.push({ role: 'copy' });
  }
  if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' });
  items.push({ label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() });
  items.push({ label: 'Reload pane', click: () => wc.reload() });
  items.push({ label: 'Inspect element', click: () => wc.inspectElement(params.x, params.y) });
  Menu.buildFromTemplate(items).popup({ window: win });
}

// ---------------------------------------------------------------------------
// Application menu and shortcuts
// ---------------------------------------------------------------------------
function withFocused(fn) { const p = focusedPane(); if (p && !p.view.webContents.isDestroyed()) fn(p.view.webContents, p); }
function setUi(patch) { Object.assign(settings.ui, patch); saveSoon(); pushState(); }

function buildMenu() {
  const template = [
    ...(IS_MAC ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New chat', accelerator: 'CmdOrCtrl+N', click: () => openChat(CLAUDE + '/new', 'replace') },
        { label: 'New split pane', accelerator: 'CmdOrCtrl+\\', click: () => { if (panes.length < MAX_PANES) openChat(CLAUDE + '/new', 'split'); } },
        { label: 'Show only this pane', accelerator: 'CmdOrCtrl+Shift+\\', click: () => withFocused((_wc, p) => onlyPane(p.id)) },
        { type: 'separator' },
        { label: 'Close pane', accelerator: 'CmdOrCtrl+W', click: () => withFocused((_wc, p) => closePane(p.id)) },
        { type: 'separator' },
        { label: 'Check for updates', enabled: !!updater, click: () => updater && updater.check(true) },
        { label: 'Restart to update', enabled: update.state === 'restart', click: restartToUpdate },
        ...(IS_MAC ? [] : [{ type: 'separator' }, { role: 'quit' }])
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle sidebar', accelerator: 'CmdOrCtrl+B', click: () => setUi({ sidebar: !settings.ui.sidebar }) },
        { label: 'Appearance', accelerator: 'CmdOrCtrl+,', click: () => setUi({ appearance: !settings.ui.appearance }) },
        { type: 'separator' },
        { label: 'Focus pane 1', accelerator: 'CmdOrCtrl+1', click: () => panes[0] && setFocus(panes[0].id, true) },
        { label: 'Focus pane 2', accelerator: 'CmdOrCtrl+2', click: () => panes[1] && setFocus(panes[1].id, true) },
        { label: 'Focus pane 3', accelerator: 'CmdOrCtrl+3', click: () => panes[2] && setFocus(panes[2].id, true) },
        { type: 'separator' },
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => withFocused((wc) => wc.navigationHistory.canGoBack() && wc.navigationHistory.goBack()) },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => withFocused((wc) => wc.navigationHistory.canGoForward() && wc.navigationHistory.goForward()) },
        { label: 'Reload pane', accelerator: 'CmdOrCtrl+R', click: () => withFocused((wc) => wc.reload()) },
        { type: 'separator' },
        { label: 'Zoom in', accelerator: 'CmdOrCtrl+=', click: () => withFocused((wc) => wc.setZoomLevel(wc.getZoomLevel() + 0.5)) },
        { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: () => withFocused((wc) => wc.setZoomLevel(wc.getZoomLevel() - 0.5)) },
        { label: 'Actual size', accelerator: 'CmdOrCtrl+0', click: () => withFocused((wc) => wc.setZoomLevel(0)) },
        { type: 'separator' },
        { label: 'Developer tools for pane', accelerator: IS_MAC ? 'Alt+Cmd+I' : 'Ctrl+Shift+I', click: () => withFocused((wc) => wc.toggleDevTools()) },
        { label: 'Developer tools for app shell', click: () => shellView && shellView.webContents.toggleDevTools() },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    // Built by hand: the stock Window menu on Windows and Linux has its own
    // Close with Ctrl+W, which would shut the whole window instead of a pane.
    {
      label: 'Window',
      submenu: IS_MAC
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }, { label: 'Close window', accelerator: 'Alt+F4', click: () => win && win.close() }]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// IPC from the shell
// ---------------------------------------------------------------------------
const NAV_PATHS = { new: '/new', chats: '/recents', projects: '/projects', artifacts: '/artifacts', code: '/code', settings: '/settings' };

function registerIpc() {
  ipcMain.on('shell:ready', pushState);
  ipcMain.on('pane:layout', (_e, rects) => layoutPanes(rects));
  ipcMain.on('pane:focus', (_e, id) => setFocus(id, true));
  ipcMain.on('pane:close', (_e, id) => closePane(id));
  ipcMain.on('pane:only', (_e, id) => onlyPane(id));
  ipcMain.on('pane:back', (_e, id) => { const p = paneById(id); if (p && p.view.webContents.navigationHistory.canGoBack()) p.view.webContents.navigationHistory.goBack(); });
  ipcMain.on('pane:reload', (_e, id) => { const p = paneById(id); if (p) p.view.webContents.reload(); });
  ipcMain.on('pane:split', () => { if (panes.length < MAX_PANES) openChat(CLAUDE + '/new', 'split'); });
  ipcMain.on('chat:open', (_e, { id, split }) => {
    if (typeof id !== 'string' || !/^[0-9a-f-]{8,}$/i.test(id)) return;
    openChat(CLAUDE + '/chat/' + id, split ? 'split' : 'replace');
  });
  ipcMain.on('nav:go', (_e, where) => { if (NAV_PATHS[where]) openChat(CLAUDE + NAV_PATHS[where], 'replace'); });
  ipcMain.on('ui:set', (_e, patch) => setUi({
    ...(typeof patch.sidebar === 'boolean' ? { sidebar: patch.sidebar } : {}),
    ...(typeof patch.appearance === 'boolean' ? { appearance: patch.appearance } : {})
  }));
  ipcMain.on('theme:set', (_e, patch) => {
    settings.theme = Theme.withDefaults(Object.assign({}, settings.theme, Theme.sanitize(patch)));
    applyThemeAll();
    saveSoon();
    pushState();
  });
  ipcMain.on('theme:reset', () => { settings.theme = Theme.withDefaults({}); applyThemeAll(); saveSoon(); pushState(); });

  ipcMain.on('update:check', () => { if (updater) updater.check(true); });
  ipcMain.on('update:restart', () => { if (update.state === 'restart') restartToUpdate(); });

  ipcMain.handle('chats:list', listChats);
  ipcMain.handle('fonts:list', () => fontListForShell());
  ipcMain.handle('fonts:add', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Add font files', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Fonts', extensions: ['woff2', 'woff', 'ttf', 'otf'] }]
    });
    if (res.canceled) return fontListForShell();
    fs.mkdirSync(userFile('fonts'), { recursive: true });
    res.filePaths.forEach((src) => {
      const ext = path.extname(src).toLowerCase();
      if (!FONT_TYPES[ext]) return;
      const name = path.basename(src);
      fs.copyFileSync(src, userFile('fonts', name));
      settings.fonts = settings.fonts.filter((f) => f.file !== name);
      settings.fonts.push({
        family: familyFromFile(name), file: name,
        weight: guessWeight(name), style: /italic|oblique/i.test(name) ? 'italic' : 'normal'
      });
    });
    fontFaceCache = null;
    saveSoon();
    applyThemeAll();
    return fontListForShell();
  });
  ipcMain.handle('fonts:remove', (_e, family) => {
    settings.fonts.filter((f) => f.family === family).forEach((f) => {
      try { fs.unlinkSync(userFile('fonts', f.file)); } catch { /* already gone */ }
    });
    settings.fonts = settings.fonts.filter((f) => f.family !== family);
    fontFaceCache = null;
    saveSoon();
    applyThemeAll();
    return fontListForShell();
  });
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
function setupSession() {
  const ses = session.defaultSession;

  // Present as plain Chrome so sign-in providers treat the app like a browser.
  app.userAgentFallback = app.userAgentFallback
    .replace(/\sElectron\/\S+/g, '')
    .replace(/\s(?:claude-reskin|Claude ?Reskin)\/\S+/gi, '');

  ses.webRequest.onHeadersReceived({ urls: ['https://claude.ai/*'] }, (details, callback) => {
    const headers = details.responseHeaders || {};
    Object.keys(headers).forEach((k) => {
      if (k.toLowerCase() === 'content-security-policy') headers[k] = headers[k].map(patchCSP);
    });
    callback({ responseHeaders: headers });
  });

  const CLAUDE_PERMS = new Set(['media', 'clipboard-read', 'clipboard-sanitized-write', 'notifications', 'fullscreen']);
  const SHELL_PERMS = new Set(['local-fonts']);
  const allowed = (url, permission) => {
    if (url && url.startsWith('file://')) return SHELL_PERMS.has(permission);
    return isClaudeUrl(url) && CLAUDE_PERMS.has(permission);
  };
  ses.setPermissionRequestHandler((wc, permission, cb, details) => cb(allowed(details.requestingUrl || wc.getURL(), permission)));
  ses.setPermissionCheckHandler((_wc, permission, origin) => allowed(origin, permission));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    loadSettings();
    nativeTheme.themeSource = settings.theme.mode === 'dark' ? 'dark' : 'light';
    setupSession();
    registerIpc();
    buildMenu();
    createWindow();
    wireUpdater();

    app.on('activate', () => { if (!win) { loadSettings(); createWindow(); } });
  });

  app.on('before-quit', saveNow);
  app.on('window-all-closed', () => { if (!IS_MAC) app.quit(); });
}
