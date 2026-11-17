'use strict';
/*
 * Checks sidebar-data.js against a fake claude.ai: which organization it
 * reads, starred and recents, paging, the older endpoint, and learning the
 * Claude Code session list from claude.ai's own request.
 * Run with `node test/sidebar-data.test.js`.
 */
const assert = require('node:assert/strict');
const S = require('../sidebar-data.js');

const ORG_PERSONAL = '11111111-1111-4111-8111-111111111111';
const ORG_TEAM = '22222222-2222-4222-8222-222222222222';
const uuid = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const iso = (n) => new Date(Date.UTC(2026, 10, 17) - n * 60000).toISOString();

// 75 team chats, newest first; every tenth one starred. 5 personal chats.
function makeChats(org, n) {
  return Array.from({ length: n }, (_, i) => ({
    uuid: uuid((org === ORG_TEAM ? 1000 : 0) + i), name: (org === ORG_TEAM ? 'team ' : 'personal ') + i,
    updated_at: iso(i), is_starred: i % 10 === 3, project: i === 5 ? { name: 'reskin' } : null
  }));
}

function fakeClaude({ v2 = true, ignoreOffset = false, sessionsPath = '/v1/code/sessions' } = {}) {
  const db = { [ORG_PERSONAL]: makeChats(ORG_PERSONAL, 5), [ORG_TEAM]: makeChats(ORG_TEAM, 75) };
  const log = [];
  const handle = ({ url, headers }) => {
    log.push({ url, headers });
    const u = new URL(url, 'https://claude.ai');
    if (u.pathname === '/api/organizations') {
      return { status: 200, body: [
        { uuid: ORG_PERSONAL, name: 'personal', capabilities: ['chat', 'claude_pro'] },
        { uuid: ORG_TEAM, name: 'team', capabilities: ['chat', 'raven'] }
      ] };
    }
    const m = /^\/api\/organizations\/([^/]+)\/(chat_conversations(?:_v2)?)$/.exec(u.pathname);
    if (m) {
      if (m[2] === 'chat_conversations_v2' && !v2) return { status: 404, body: { error: 'not found' } };
      const all = db[m[1]] || [];
      const limit = Number(u.searchParams.get('limit'));
      const offset = ignoreOffset ? 0 : Number(u.searchParams.get('offset'));
      if (m[2] === 'chat_conversations') return { status: 200, body: all.slice(offset, offset + limit) };
      const starred = u.searchParams.get('starred') === 'true';
      const list = all.filter((c) => c.is_starred === starred);
      return { status: 200, body: { data: list.slice(offset, offset + limit), has_more: offset + limit < list.length } };
    }
    if (u.pathname === sessionsPath) {
      if (headers['anthropic-beta'] !== 'ccr-test') return { status: 400, body: { error: 'missing beta' } };
      return { status: 200, body: { data: [
        { id: 'session_old', title: 'old work', updated_at: iso(50), session_status: 'idle' },
        { id: 'session_new', title: 'new work', updated_at: iso(1), session_status: 'running',
          session_context: { sources: [{ url: 'https://github.com/Dylz101/claude-reskin' }] } },
        { id: 'session_gone', title: 'archived', updated_at: iso(2), session_status: 'archived' }
      ], has_more: false } };
    }
    return { status: 404, body: null };
  };
  return { db, log, request: async (reqs) => reqs.map(handle) };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('reads the organization named by the lastActiveOrg cookie', async () => {
  const f = fakeClaude();
  const store = new S.SidebarData({ request: f.request, getCookieOrg: async () => ORG_TEAM });
  const r = await store.chats();
  assert.equal(r.error, undefined);
  assert.equal(r.org, ORG_TEAM);
  assert.equal(r.recents[0].title, 'team 0');
});

test('without the cookie, follows the organization claude.ai itself is requesting', async () => {
  const f = fakeClaude();
  const store = new S.SidebarData({ request: f.request });
  store.observeRequest({ method: 'GET', url: 'https://claude.ai/api/organizations/' + ORG_TEAM + '/projects', headers: {} });
  assert.equal((await store.chats()).org, ORG_TEAM);
});

test('ignores its own requests when watching for the organization', async () => {
  const store = new S.SidebarData({ request: async () => [] });
  store.observeRequest({ method: 'GET', url: 'https://claude.ai/api/organizations/' + ORG_TEAM + '/x', headers: { [S.OWN_HEADER]: '1' } });
  assert.equal(store.trafficOrg, null);
});

test('lists every starred chat apart from recents, in claude.ai order', async () => {
  const f = fakeClaude();
  const store = new S.SidebarData({ request: f.request, getCookieOrg: async () => ORG_TEAM });
  const r = await store.chats();
  assert.equal(r.starred.length, 8); // 3, 13, ... 73: older than the first page too
  assert.ok(r.starred.every((c) => c.starred));
  assert.equal(r.recents.length, 30);
  assert.ok(r.recents.every((c) => !c.starred));
  assert.ok(r.recents.every((c, i, a) => i === 0 || a[i - 1].updated >= c.updated));
  assert.equal(r.recents.find((c) => c.title === 'team 5').project, 'reskin');
  assert.equal(r.hasMore, true);
});

test('loads further pages, then stops at the end', async () => {
  const f = fakeClaude();
  const store = new S.SidebarData({ request: f.request, getCookieOrg: async () => ORG_TEAM });
  await store.chats();
  let r = await store.chats({ more: true });
  assert.equal(r.recents.length, 60);
  r = await store.chats({ more: true });
  assert.equal(r.recents.length, 67); // 75 chats, 8 starred
  assert.equal(r.hasMore, false);
  assert.equal(new Set(r.recents.map((c) => c.id)).size, 67);
});

test('a refresh keeps as many chats loaded and picks up new ones at the top', async () => {
  const f = fakeClaude();
  const store = new S.SidebarData({ request: f.request, getCookieOrg: async () => ORG_TEAM });
  await store.chats();
  await store.chats({ more: true });
  f.db[ORG_TEAM].unshift({ uuid: uuid(9999), name: 'brand new', updated_at: iso(-1), is_starred: false });
  const r = await store.chats();
  assert.equal(r.recents[0].title, 'brand new');
  assert.equal(r.recents.length, 60);
});

test('stops paging if the server keeps returning the same page', async () => {
  const f = fakeClaude({ ignoreOffset: true });
  const store = new S.SidebarData({ request: f.request, getCookieOrg: async () => ORG_TEAM });
  await store.chats();
  const r = await store.chats({ more: true });
  assert.equal(r.hasMore, false);
  assert.equal(r.recents.length, 30);
});

test('falls back to the older list endpoint, offsetting past starred chats', async () => {
  const f = fakeClaude({ v2: false });
  const store = new S.SidebarData({ request: f.request, getCookieOrg: async () => ORG_TEAM });
  let r = await store.chats();
  assert.equal(r.error, undefined);
  assert.equal(r.recents.length, 27);
  assert.equal(r.starred.length, 3);
  r = await store.chats({ more: true });
  r = await store.chats({ more: true });
  assert.equal(r.recents.length + r.starred.length, 75);
  assert.equal(new Set(r.recents.map((c) => c.id)).size, r.recents.length);
  // Remembers which endpoint works.
  const before = f.log.length;
  await store.chats();
  assert.ok(f.log.slice(before).every((q) => !/_v2/.test(q.url)));
});

test('switching organization in claude.ai resets the list', async () => {
  const f = fakeClaude();
  let cookie = ORG_TEAM;
  const store = new S.SidebarData({ request: f.request, getCookieOrg: async () => cookie });
  await store.chats();
  await store.chats({ more: true });
  cookie = ORG_PERSONAL;
  const r = await store.chats();
  assert.equal(r.org, ORG_PERSONAL);
  assert.deepEqual(r.recents.map((c) => c.title).slice(0, 2), ['personal 0', 'personal 1']);
  assert.equal(r.hasMore, false);
});

test('reports signed-out on 401/403', async () => {
  const store = new S.SidebarData({ request: async (reqs) => reqs.map(() => ({ status: 401, body: null })) });
  assert.equal((await store.chats()).error, 'signed-out');
});

test('reports a missing pane so the shell can retry', async () => {
  const store = new S.SidebarData({ request: async () => { throw new Error('no-pane'); } });
  assert.equal((await store.chats()).error, 'no-pane');
});

test('learns the Code session list from claude.ai and remembers it without credentials', async () => {
  const f = fakeClaude();
  const saved = [];
  const store = new S.SidebarData({ request: f.request, getCookieOrg: async () => ORG_TEAM, onEndpoint: (ep) => saved.push(ep) });
  assert.equal((await store.sessions()).error, 'open-code');

  const seen = { method: 'GET', url: 'https://claude.ai/v1/code/sessions', pagePath: '/code',
    headers: { 'anthropic-beta': 'ccr-test', 'anthropic-version': '2023-06-01', Cookie: 'secret', 'User-Agent': 'x', Authorization: 'Bearer tok' } };
  // Requests from other pages are not the session list.
  store.observeRequest(Object.assign({}, seen, { pagePath: '/settings' }));
  assert.equal(store.candidate, null);
  store.observeRequest(seen);
  const r = await store.sessions();
  assert.equal(r.error, undefined);
  assert.deepEqual(r.items.map((s) => s.id), ['session_new', 'session_old']);
  assert.equal(r.items[0].repo, 'Dylz101/claude-reskin');
  assert.equal(r.items[0].status, 'running');
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].headers, { 'anthropic-beta': 'ccr-test', 'anthropic-version': '2023-06-01' });
  assert.equal(saved[0].needsAuth, true);
  const last = f.log[f.log.length - 1];
  assert.equal(last.headers.authorization, 'Bearer tok');
  assert.equal(last.headers.cookie, undefined);

  // A later run starts from the saved request but needs claude.ai's token again.
  const next = new S.SidebarData({ request: f.request, getCookieOrg: async () => ORG_TEAM, savedEndpoint: saved[0] });
  assert.equal((await next.sessions()).error, 'unavailable');
  next.observeRequest(seen);
  assert.equal((await next.sessions()).items.length, 2);
});

test('drops a learned request that returns something other than sessions', async () => {
  const f = fakeClaude({ sessionsPath: '/nowhere' });
  const store = new S.SidebarData({ request: f.request, getCookieOrg: async () => ORG_TEAM });
  store.observeRequest({ method: 'GET', url: 'https://claude.ai/v1/code/sessions', pagePath: '/code/session_x', headers: {} });
  assert.equal((await store.sessions()).error, 'open-code');
  assert.equal(store.candidate, null);
  assert.equal(store.endpoint, null);
});

const orgsReply = { status: 200, body: [{ uuid: ORG_TEAM, capabilities: ['chat'] }] };
const sessionsOnly = (reply) => async (reqs) => reqs.map((q) => (q.url === '/api/organizations' ? orgsReply : reply(q)));
const seenCode = { method: 'GET', url: 'https://claude.ai/v1/code/sessions', pagePath: '/code', headers: { 'anthropic-beta': 'x' } };

test('a 200 reply with no list in it is not "no sessions"', async () => {
  const store = new S.SidebarData({ request: sessionsOnly(() => ({ status: 200, body: { type: 'ok' } })), getCookieOrg: async () => ORG_TEAM });
  store.observeRequest(seenCode);
  assert.equal((await store.sessions()).error, 'open-code');
  assert.equal(store.endpoint, null, 'must not remember an endpoint that never returned a list');
});

test('an empty list from a guess is not trusted, from claude.ai\'s own request it is', async () => {
  const empty = sessionsOnly(() => ({ status: 200, body: { data: [], has_more: false } }));
  const guessing = new S.SidebarData({ request: empty, getCookieOrg: async () => ORG_TEAM });
  assert.equal((await guessing.sessions()).error, 'open-code');
  const learned = new S.SidebarData({ request: empty, getCookieOrg: async () => ORG_TEAM });
  learned.observeRequest(seenCode);
  assert.deepEqual(await learned.sessions(), { items: [] });
});

test('reads the real status values and drops archived sessions', async () => {
  const body = { data: [
    { id: 'session_01Aaaa', title: 'a', session_status: 'SESSION_STATUS_RUNNING', updated_at: iso(1) },
    { id: 'session_01Bbbb', title: 'b', session_status: 'SESSION_STATUS_IDLE', updated_at: iso(2) },
    { id: 'session_01Cccc', title: 'c', session_status: 'SESSION_STATUS_ARCHIVED', updated_at: iso(3) }
  ] };
  const store = new S.SidebarData({ request: sessionsOnly(() => ({ status: 200, body })), getCookieOrg: async () => ORG_TEAM });
  store.observeRequest(seenCode);
  const r = await store.sessions();
  assert.deepEqual(r.items.map((x) => [x.id, x.status]), [['session_01Aaaa', 'running'], ['session_01Bbbb', 'idle']]);
});

test('the sidebar report holds no titles, ids, tokens or organization ids', async () => {
  const body = { data: [{ id: 'session_01SecretId', title: 'private plans', session_status: 'SESSION_STATUS_IDLE', updated_at: iso(1) }] };
  const store = new S.SidebarData({ request: sessionsOnly(() => ({ status: 200, body })), getCookieOrg: async () => ORG_TEAM });
  store.observeRequest(Object.assign({}, seenCode, { url: 'https://claude.ai/v1/code/sessions?org=' + ORG_TEAM + '&limit=20',
    headers: { 'anthropic-beta': 'x', Authorization: 'Bearer TOKEN123', Cookie: 'c=1' } }));
  await store.sessions();
  const text = store.report();
  for (const secret of ['private plans', 'SecretId', 'TOKEN123', ORG_TEAM, 'c=1']) assert.ok(!text.includes(secret), 'leaked ' + secret);
  const rep = JSON.parse(text);
  assert.equal(rep.code.attempts[0].rawCount, 1);
  assert.equal(rep.code.attempts[0].listKey, 'data');
  assert.deepEqual(rep.code.attempts[0].firstItemKeys, ['id', 'title', 'session_status', 'updated_at']);
});

test('mutationKind spots chat and session changes, never reads', () => {
  assert.equal(S.mutationKind('POST', 'https://claude.ai/api/organizations/o/chat_conversations/abc/completion'), 'chats');
  assert.equal(S.mutationKind('PUT', 'https://claude.ai/api/organizations/o/chat_conversations/abc'), 'chats');
  assert.equal(S.mutationKind('DELETE', 'https://claude.ai/api/organizations/o/chat_conversations/abc'), 'chats');
  assert.equal(S.mutationKind('POST', 'https://claude.ai/api/organizations/o/chat_conversations'), 'chats');
  assert.equal(S.mutationKind('GET', 'https://claude.ai/api/organizations/o/chat_conversations_v2?limit=30'), null);
  assert.equal(S.mutationKind('POST', 'https://claude.ai/v1/sessions/session_1/events'), 'code');
  assert.equal(S.mutationKind('POST', 'https://claude.ai/api/auth/sessions'), null);
  assert.equal(S.mutationKind('POST', 'https://claude.ai/api/organizations/o/projects'), null);
});

test('pickOrg prefers the named organization, then one that can chat', () => {
  const orgs = [{ uuid: 'a', capabilities: ['api'] }, { uuid: 'b', capabilities: ['chat'] }, { uuid: 'c', capabilities: ['chat'] }];
  assert.equal(S.pickOrg(orgs, ['c']).uuid, 'c');
  assert.equal(S.pickOrg(orgs, [null, 'zzz']).uuid, 'b');
  assert.equal(S.pickOrg([], ['c']), null);
});

test('pageFetch runs in a page with the session cookie and reports failures', async () => {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url === '/boom') throw new TypeError('Failed to fetch');
    if (url === '/text') return { status: 200, json: async () => { throw new SyntaxError('bad json'); } };
    return { status: 200, json: async () => ({ ok: true }) };
  };
  // Serialised and re-evaluated, as main.js does, to prove it is self-contained.
  const fn = new Function('return (' + S.pageFetch.toString() + ')')();
  const res = await fn([{ url: '/a', headers: { 'x-a': '1' } }, { url: '/boom' }, { url: '/text' }]);
  assert.deepEqual(res[0], { status: 200, body: { ok: true } });
  assert.equal(res[1].status, 0);
  assert.match(res[1].error, /Failed to fetch/);
  assert.deepEqual(res[2], { status: 200, body: null });
  assert.equal(calls[0].init.credentials, 'include');
  assert.equal(calls[0].init.headers['x-a'], '1');
  delete global.fetch;
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('ok   ' + name); }
    catch (err) { failed++; console.log('FAIL ' + name + '\n     ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n     ') : err)); }
  }
  console.log(`\nsidebar-data: ${tests.length - failed}/${tests.length} passed`);
  if (failed) process.exit(1);
})();
