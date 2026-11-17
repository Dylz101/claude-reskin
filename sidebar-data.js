'use strict';

/*
 * The data behind the app's sidebar: chat recents, starred chats and Claude
 * Code sessions, fetched the way claude.ai's own sidebar fetches them.
 *
 * Requests run inside a signed-in claude.ai pane through pageFetch, so they
 * carry the user's own session. Everything else here is plain Node with no
 * Electron, so test/sidebar-data.test.js can drive it with a fake pane.
 */

const PAGE = 30;            // chats per page, as claude.ai's sidebar loads them
const MAX_LOADED = 600;     // stop paging after this many recents
const STARRED_LIMIT = 200;
const ORG_TTL = 10 * 60 * 1000;
const CLAUDE = 'https://claude.ai';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_ID = /^session_[A-Za-z0-9]+$/;

// Marks the app's own requests, so watching claude.ai's traffic for the
// active organization ignores them. Only sent to claude.ai itself: a custom
// header on a cross-origin request would need a CORS preflight.
const OWN_HEADER = 'x-reskin-sidebar';

// Runs inside a claude.ai page (serialized with toString), so it must stay
// self-contained. Takes [{ url, headers }] and returns [{ status, body }].
async function pageFetch(reqs) {
  return Promise.all(reqs.map(async (q) => {
    try {
      const r = await fetch(q.url, {
        credentials: 'include',
        headers: Object.assign({ accept: 'application/json' }, q.headers || {})
      });
      let body = null;
      try { body = await r.json(); } catch (e) { body = null; }
      return { status: r.status, body };
    } catch (err) {
      return { status: 0, body: null, error: String(err && err.message ? err.message : err) };
    }
  }));
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
const listOf = (body) => {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  for (const k of ['data', 'conversations', 'sessions', 'items', 'results']) {
    if (Array.isArray(body[k])) return body[k];
  }
  return [];
};

// The organization claude.ai is using: the one its own requests name, then
// its lastActiveOrg cookie, then the first that can chat.
function pickOrg(orgs, preferred) {
  if (!Array.isArray(orgs) || !orgs.length) return null;
  const canChat = (o) => !Array.isArray(o.capabilities) || o.capabilities.includes('chat');
  for (const id of [].concat(preferred || [])) {
    const hit = id && orgs.find((o) => o && o.uuid === id);
    if (hit) return hit;
  }
  return orgs.find((o) => o && o.uuid && canChat(o)) || orgs.find((o) => o && o.uuid) || null;
}

function normalizeChat(c) {
  if (!c || typeof c !== 'object') return null;
  const id = c.uuid || c.id;
  if (typeof id !== 'string' || !UUID.test(id)) return null;
  return {
    id,
    title: String(c.name || c.title || '').trim() || 'untitled chat',
    updated: c.updated_at || c.created_at || '',
    starred: !!c.is_starred,
    project: c.project && c.project.name ? String(c.project.name) : ''
  };
}

function repoFrom(s) {
  const candidates = [];
  const ctx = s.session_context || s.context || {};
  [ctx.sources, s.sources, ctx.repositories, s.repositories].forEach((list) => {
    if (Array.isArray(list)) list.forEach((x) => candidates.push(x && (x.url || x.full_name || x.name || x)));
  });
  candidates.push(s.repo, s.repository, s.repo_full_name, ctx.repo);
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    const m = /(?:github\.com[/:])?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(c.trim());
    if (m && !/^https?:$/i.test(m[1].split('/')[0])) return m[1];
  }
  return '';
}

function normalizeSession(s) {
  if (!s || typeof s !== 'object') return null;
  const id = s.id || s.session_id;
  if (typeof id !== 'string' || !SESSION_ID.test(id)) return null;
  const status = String(s.session_status || s.status || '').toLowerCase();
  if (status === 'archived' || s.archived === true || s.is_archived === true) return null;
  return {
    id,
    title: String(s.title || s.name || '').trim() || 'untitled session',
    updated: s.updated_at || s.last_activity_at || s.last_event_at || s.created_at || '',
    status,
    repo: repoFrom(s)
  };
}

const newestFirst = (a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0);

function dedupe(items) {
  const seen = new Set();
  return items.filter((x) => (x && !seen.has(x.id) ? (seen.add(x.id), true) : false));
}

// Which list a finished claude.ai request may have changed, if any. Reads
// never count, so the app's own refreshes can't trigger more refreshes.
function mutationKind(method, url) {
  if (/^(GET|HEAD|OPTIONS)$/i.test(method || 'GET')) return null;
  let p;
  try { p = new URL(url).pathname; } catch { return null; }
  if (/\/chat_conversations(\/|_v2|$)/.test(p)) return 'chats';
  if (/\/sessions(\/|$)/.test(p) && !/\/auth\//.test(p)) return 'code';
  return null;
}

// The organization a claude.ai request is for, from its path.
function orgFromUrl(url) {
  const m = /\/api\/organizations\/([0-9a-f-]{36})(\/|$)/i.exec(url || '');
  return m && UUID.test(m[1]) ? m[1] : null;
}

// Request headers worth replaying when the app asks for the session list the
// way claude.ai's Code page did. Cookies and browser-set headers are left out.
const REPLAY_HEADER = /^(anthropic-[\w-]+|x-[\w-]+|authorization|content-type)$/i;
function replayHeaders(headers) {
  const out = {};
  Object.keys(headers || {}).forEach((k) => {
    if (REPLAY_HEADER.test(k) && k.toLowerCase() !== OWN_HEADER && !/^x-forwarded/i.test(k)) {
      out[k.toLowerCase()] = String(headers[k]);
    }
  });
  return out;
}

// A request claude.ai's Code page made for its session list, or null.
function sessionListRequest(method, url, headers) {
  if (String(method || '').toUpperCase() !== 'GET') return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/(^|\.)claude\.ai$|(^|\.)anthropic\.com$/i.test(u.hostname)) return null;
  if (!/\/sessions\/?$/.test(u.pathname) || /\/auth\//.test(u.pathname)) return null;
  return { url: u.href, headers: replayHeaders(headers) };
}

// ---------------------------------------------------------------------------
// The store the main process talks to
// ---------------------------------------------------------------------------
class SidebarData {
  /**
   * request(reqs): runs pageFetch in a claude.ai pane; throws 'no-pane' if none.
   * getCookieOrg(): resolves to claude.ai's lastActiveOrg cookie, or null.
   * savedEndpoint: a session-list request remembered from an earlier run.
   * onEndpoint(ep): called when a working session-list request is learned.
   */
  constructor({ request, getCookieOrg, savedEndpoint, onEndpoint, now } = {}) {
    this.request = request;
    this.getCookieOrg = getCookieOrg || (async () => null);
    this.onEndpoint = onEndpoint || (() => {});
    this.now = now || Date.now;
    this.trafficOrg = null;
    this.orgs = null;
    this.orgsAt = 0;
    this.chatApi = null;        // 'v2' or 'v1', once one has worked
    this.chatState = { org: null, recents: [], starred: [], hasMore: false, fetched: 0 };
    this.endpoint = savedEndpoint && savedEndpoint.url ? savedEndpoint : null;
    this.authHeader = null;     // kept in memory only, never saved
    this.candidate = null;      // a session-list request seen but not yet tried
    this.onOrgChange = null;    // set by the caller: claude.ai switched organization
    this.onCandidate = null;    // set by the caller: a new session-list request was seen
    this.queue = { chats: Promise.resolve(), code: Promise.resolve() };
  }

  // Watches claude.ai's own requests (from webRequest.onSendHeaders).
  observeRequest({ method, url, headers, pagePath }) {
    const h = headers || {};
    const own = Object.keys(h).some((k) => k.toLowerCase() === OWN_HEADER);
    if (own) return;
    const org = orgFromUrl(url);
    if (org && org !== this.trafficOrg) {
      this.trafficOrg = org;
      // Switching organization in claude.ai: refresh, which re-reads the cookie.
      if (this.chatState.org && org !== this.chatState.org && this.onOrgChange) this.onOrgChange();
    }
    // Only learn the session list from claude.ai's Code pages.
    if (typeof pagePath !== 'string' || !/^\/code(\/|$)/.test(pagePath)) return;
    const ep = sessionListRequest(method, url, h);
    if (!ep) return;
    const auth = ep.headers.authorization;
    delete ep.headers.authorization;
    const same = this.endpoint && this.endpoint.url === ep.url && JSON.stringify(this.endpoint.headers) === JSON.stringify(ep.headers);
    this.candidate = { url: ep.url, headers: ep.headers, needsAuth: !!auth };
    if (auth) this.authHeader = auth;
    if (!same) this.onCandidate && this.onCandidate();
  }

  serial(kind, fn) {
    const run = this.queue[kind].then(fn, fn);
    this.queue[kind] = run.catch(() => {});
    return run;
  }

  async get(reqs) {
    const res = await this.request(reqs.map((q) => {
      const sameSite = q.url.startsWith('/') || q.url.startsWith(CLAUDE + '/');
      return { url: q.url, headers: Object.assign({}, q.headers, sameSite ? { [OWN_HEADER]: '1' } : {}) };
    }));
    if (!Array.isArray(res) || res.length !== reqs.length) throw new Error('bad pane response');
    return res;
  }

  async org() {
    const fresh = this.orgs && this.now() - this.orgsAt < ORG_TTL;
    if (!fresh) {
      const [r] = await this.get([{ url: '/api/organizations' }]);
      if (r.status === 401 || r.status === 403) throw new Error('signed-out');
      if (r.status === 0) throw new Error(r.error || 'Failed to fetch');
      if (r.status < 200 || r.status >= 300) throw new Error('http ' + r.status);
      this.orgs = Array.isArray(r.body) ? r.body : listOf(r.body);
      this.orgsAt = this.now();
    }
    let cookie = null;
    try { cookie = await this.getCookieOrg(); } catch { cookie = null; }
    const org = pickOrg(this.orgs, [cookie, this.trafficOrg]);
    if (!org) throw new Error('signed-out');
    return org.uuid;
  }

  chatUrl(api, org, { offset, limit, starred }) {
    const base = '/api/organizations/' + org;
    if (api === 'v1') return base + '/chat_conversations?limit=' + limit + '&offset=' + offset;
    return base + '/chat_conversations_v2?limit=' + limit + '&offset=' + offset +
      '&starred=' + (starred ? 'true' : 'false') + '&consistency=eventual';
  }

  // Fetches recents (and starred) for one organization. With more, adds the
  // next page; otherwise refreshes as many as are loaded, so the list keeps
  // its length and order matches claude.ai's.
  chats({ more = false } = {}) {
    return this.serial('chats', async () => {
      try {
        const org = await this.org();
        if (this.chatState.org !== org) this.chatState = { org, recents: [], starred: [], hasMore: false, fetched: 0 };
        const st = this.chatState;
        // fetched counts list positions, which is what offset counts: with the
        // v1 endpoint that includes starred chats, with v2 it doesn't.
        const offset = more ? st.fetched : 0;
        const count = more ? PAGE : Math.max(PAGE, Math.min(st.fetched, MAX_LOADED));
        const result = await this.fetchChats(org, offset, count);
        const known = new Set(st.recents.concat(st.starred).map((c) => c.id));
        // A page that adds nothing new means the end, even if the server says
        // otherwise; this stops the sidebar asking for the same page forever.
        const grew = !more || result.items.some((c) => !known.has(c.id));
        const recents = more ? dedupe(st.recents.concat(result.recents)) : result.recents;
        this.chatState = {
          org,
          recents,
          starred: result.starred,
          fetched: offset + result.positions,
          hasMore: result.hasMore && grew && offset + result.positions < MAX_LOADED
        };
        return this.chatsView();
      } catch (err) {
        return { error: errText(err), ...this.chatsView() };
      }
    });
  }

  chatsView() {
    const s = this.chatState;
    return { org: s.org, starred: s.starred, recents: s.recents, hasMore: s.hasMore };
  }

  async fetchChats(org, offset, count) {
    const offsets = [];
    for (let o = offset; o < offset + count; o += PAGE) offsets.push(o);
    const tryApi = async (api) => {
      const reqs = offsets.map((o) => ({ url: this.chatUrl(api, org, { offset: o, limit: PAGE, starred: false }) }));
      const wantStarred = api === 'v2' && offset === 0;
      if (wantStarred) reqs.push({ url: this.chatUrl(api, org, { offset: 0, limit: STARRED_LIMIT, starred: true }) });
      const res = await this.get(reqs);
      const bad = res.find((r) => r.status < 200 || r.status >= 300);
      if (bad) return { status: bad.status, error: bad.error };
      const pages = res.slice(0, offsets.length);
      const items = dedupe(pages.flatMap((r) => listOf(r.body).map(normalizeChat)));
      const positions = pages.reduce((n, r) => n + listOf(r.body).length, 0);
      const last = pages[pages.length - 1].body;
      const lastLen = listOf(last).length;
      const hasMore = last && typeof last.has_more === 'boolean' ? last.has_more : lastLen >= PAGE;
      if (api === 'v2') {
        let starred = this.chatState.starred;
        if (wantStarred) {
          // Trust is_starred when the server sends it, in case it ignored the filter.
          const raw = listOf(res[res.length - 1].body);
          const flagged = raw.some((c) => c && typeof c.is_starred === 'boolean');
          starred = dedupe(raw.filter((c) => !flagged || c.is_starred).map(normalizeChat))
            .map((c) => Object.assign(c, { starred: true }));
        }
        return { items, positions, recents: items.filter((c) => !c.starred), starred, hasMore };
      }
      // v1 lists starred and unstarred chats together.
      const known = offset === 0 ? [] : this.chatState.starred;
      return {
        items,
        positions,
        recents: items.filter((c) => !c.starred),
        starred: dedupe(known.concat(items.filter((c) => c.starred))),
        hasMore
      };
    };

    const order = this.chatApi === 'v1' ? ['v1'] : ['v2', 'v1'];
    let lastErr = null;
    for (const api of order) {
      const r = await tryApi(api);
      if (r.recents) { this.chatApi = api; return r; }
      if (r.status === 401 || r.status === 403) throw new Error('signed-out');
      lastErr = r.status === 0 ? (r.error || 'Failed to fetch') : 'http ' + r.status;
      // Only fall back when the newer endpoint is missing or rejects its query.
      if (![400, 404, 405, 410, 422].includes(r.status)) break;
    }
    throw new Error(lastErr || 'unknown error');
  }

  // Claude Code sessions, from the request claude.ai's Code page makes for its
  // own list. Until the app has seen that request it tries the usual one.
  sessions() {
    return this.serial('code', async () => {
      try {
        const org = await this.org();
        const tries = [];
        if (this.candidate) tries.push({ ep: this.candidate, learned: true });
        if (this.endpoint && (!this.candidate || this.endpoint.url !== this.candidate.url)) tries.push({ ep: this.endpoint });
        if (!tries.length) {
          tries.push({ ep: { url: CLAUDE + '/v1/sessions', headers: { 'anthropic-version': '2023-06-01', 'x-organization-uuid': org } }, guess: true });
        }
        for (const t of tries) {
          if (t.ep.needsAuth && !this.authHeader) continue;
          const headers = Object.assign({}, t.ep.headers, t.ep.needsAuth ? { authorization: this.authHeader } : {});
          if (headers['x-organization-uuid']) headers['x-organization-uuid'] = org;
          const [r] = await this.get([{ url: t.ep.url, headers }]);
          if (r.status < 200 || r.status >= 300) continue;
          const raw = listOf(r.body);
          const items = raw.map(normalizeSession).filter(Boolean);
          // An empty list proves nothing about the endpoint unless it answered
          // with a list; anything without session ids is some other endpoint.
          const looksRight = items.length > 0 || (raw.length === 0 && r.body && typeof r.body === 'object');
          if (!looksRight) continue;
          if (t.learned) {
            this.candidate = null;
            this.endpoint = t.ep;
            this.onEndpoint({ url: t.ep.url, headers: t.ep.headers, needsAuth: !!t.ep.needsAuth });
          } else if (t.guess && items.length) {
            this.endpoint = t.ep;
            this.onEndpoint({ url: t.ep.url, headers: t.ep.headers, needsAuth: false });
          }
          return { items: dedupe(items).sort(newestFirst) };
        }
        // A learned request that didn't work is dropped, so the next visit to
        // Code can teach a better one. 'open-code' asks the user for that visit.
        if (tries[0] && tries[0].learned) this.candidate = null;
        return { error: this.endpoint ? 'unavailable' : 'open-code' };
      } catch (err) {
        return { error: errText(err) };
      }
    });
  }
}

function errText(err) {
  return String(err && err.message ? err.message : err || 'unknown error');
}

module.exports = {
  SidebarData, pageFetch, pickOrg, normalizeChat, normalizeSession, mutationKind,
  orgFromUrl, sessionListRequest, replayHeaders, listOf, PAGE, OWN_HEADER
};
