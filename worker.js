// Cloudflare Worker: read-only proxy to the Companies House API for company 14230172.
// Companies House sends no CORS headers, so the PWA cannot call it directly.
// Setup: create a free application at https://developer.company-information.service.gov.uk/manage-applications (live), then add a key of type REST (not Streaming or Web); leave Restricted IPs and JavaScript domains blank.
// then in the Worker settings add secret CH_API_KEY and variable ALLOW_ORIGIN (e.g. https://wlpreynolds.github.io).
// UNTESTED against the live API (the build environment has no route to Companies House): test via the Setup tab.
// /company/{number}/watch serves the Day Board. Tested against mock responses only, not the live API.
const COMPANY = '14230172';
const API = 'https://api.company-information.service.gov.uk';
const DOCAPI = 'https://document-api.company-information.service.gov.uk/document/';
const SITE = 'https://find-and-update.company-information.service.gov.uk';
const WATCH_INCLUDE_FORMER_OFFICERS = true; // matches the app; false = current officers only
const WATCH_MAX_CALLS = 45; // Cloudflare's free plan allows 50 outbound calls per request
const MN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export default {
  async fetch(req, env) {
    // ALLOW_ORIGIN may be a comma-separated list; the header itself may only carry one origin,
    // so echo back the caller's origin when it is on the list.
    const allowed = (env.ALLOW_ORIGIN || '*').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
    const origin = req.headers.get('Origin') || '';
    const allowOrigin = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : allowed[0]);
    const cors = {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Vary': 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });
    const url = new URL(req.url);
    const auth = 'Basic ' + btoa((env.CH_API_KEY || '') + ':');
    const p = url.pathname;
    const json = (body, status = 200) => new Response(body, { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    // iXBRL accounts: /document?meta=<document_metadata url from filing history>
    if (p === '/document') {
      const meta = url.searchParams.get('meta') || '';
      if (!meta.startsWith(DOCAPI) && !meta.startsWith('/document/')) return json('{"error":"bad meta"}', 400);
      const base = meta.startsWith('/document/') ? DOCAPI + meta.slice('/document/'.length) : meta;
      let r = await fetch(base + '/content', { headers: { Authorization: auth, Accept: 'application/xhtml+xml' }, redirect: 'manual' });
      if (r.status >= 300 && r.status < 400) r = await fetch(r.headers.get('Location')); // pre-signed URL: no auth header
      return new Response(r.body, { status: r.status, headers: { ...cors, 'Content-Type': 'application/xhtml+xml' } });
    }

    // Day Board feed: read-only and stateless, all or nothing.
    if (p === `/company/${COMPANY}/watch`) {
      const send = (body, status) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
      try {
        return send(await buildWatch(auth), 200);
      } catch (e) {
        const code = e.code || 'upstream_failed';
        return send({ error: { code, message: e.message || 'Companies House lookup failed' } }, code === 'rate_limited' ? 429 : 502);
      }
    }

    const ok =
      p === `/company/${COMPANY}` ||
      p === `/company/${COMPANY}/officers` ||
      p === `/company/${COMPANY}/filing-history` ||
      p === `/company/${COMPANY}/persons-with-significant-control` ||
      /^\/officers\/[A-Za-z0-9_-]{20,40}\/appointments$/.test(p);
    if (!ok) return json('{"error":"path not allowed"}', 403);

    const r = await fetch(API + p + url.search, { headers: { Authorization: auth }, cf: { cacheTtl: 900, cacheEverything: true } });
    return new Response(r.body, { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
  },
};

/* ---------- Day Board feed: /company/{number}/watch ---------- */
const fail = (code, message) => Object.assign(new Error(message), { code });
const iso = d => d.toISOString().slice(0, 10);
const d0 = s => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const fmtD = s => { const d = d0(s); return `${d.getUTCDate()} ${MN[d.getUTCMonth()].slice(0, 3)} ${d.getUTCFullYear()}`; };
const fmtDL = s => { const d = d0(s); return `${d.getUTCDate()} ${MN[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const words = s => (s || '').replace(/-/g, ' ');
function parseLongDate(t) {
  const m = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(t || ''); if (!m) return null;
  const i = MN.findIndex(x => x.toLowerCase() === m[2].toLowerCase());
  return i < 0 ? null : iso(new Date(Date.UTC(+m[3], i, +m[1])));
}
function cleanDesc(f) { // same wording as the app
  const dv = f.description_values || {};
  if (dv.description) return dv.description;
  let d = (f.description || '').replace(/\{(\w+)\}/g, (m, k) => dv[k] || m).replace(/-/g, ' ');
  d = d.charAt(0).toUpperCase() + d.slice(1);
  if (dv.made_up_date && !/made up to/i.test(d)) d += ' made up to ' + fmtDL(dv.made_up_date);
  return d || f.type || '';
}

async function buildWatch(auth) {
  let calls = 0;
  const get = async path => {
    if (++calls > WATCH_MAX_CALLS) throw fail('upstream_failed', 'Too many Companies House lookups for one request');
    let r;
    try { r = await fetch(API + path, { headers: { Authorization: auth } }); }
    catch (e) { throw fail('upstream_failed', `Could not reach Companies House for ${path}`); }
    if (r.status === 429) throw fail('rate_limited', 'Companies House rate limit reached');
    if (r.status === 404) throw fail('not_found', `Companies House has no record at ${path}`);
    if (!r.ok) throw fail('upstream_failed', `Companies House returned ${r.status} for ${path}`);
    try { return await r.json(); }
    catch (e) { throw fail('upstream_failed', `Unreadable response for ${path}`); }
  };
  const getAll = async (path, size) => { // every page, or an error
    const all = [];
    for (let total = Infinity; all.length < total;) {
      const page = await get(`${path}?items_per_page=${size}&start_index=${all.length}`);
      const items = page.items || [];
      const count = page.total_results ?? page.total_count;
      total = count == null ? all.length + items.length : count;
      if (!items.length && all.length < total) throw fail('upstream_failed', `Incomplete list from ${path}`);
      all.push(...items);
    }
    return all;
  };

  const profile = await get(`/company/${COMPANY}`);
  const officers = await getAll(`/company/${COMPANY}/officers`, 100);
  const filings = await getAll(`/company/${COMPANY}/filing-history`, 100);
  const items = [];
  const filingsLink = `${SITE}/company/${COMPANY}/filing-history`;

  // Accounts: every accounts filing, no figures. AA01 shares the category but only changes the accounting date.
  for (const f of filings.filter(x => x.category === 'accounts' && x.type !== 'AA01')) {
    const dv = f.description_values || {};
    const end = dv.made_up_date || parseLongDate(dv.description || cleanDesc(f));
    items.push({
      id: `accounts:${f.transaction_id}`, kind: 'accounts', title: 'New accounts filed',
      detail: end ? `Period ending ${fmtD(end)}, filed ${fmtD(f.date)}` : `Filed ${fmtD(f.date)}`,
      date: f.date, link: filingsLink, severity: 'info', state: '',
    });
  }

  // Unusual filings: the app's rules, its 400-day window and its grouping of same-day replacements.
  const cutoff = iso(new Date(Date.now() - 400 * 864e5));
  const unusual = filings
    .map(f => ({ f, desc: cleanDesc(f) }))
    .filter(({ f, desc }) => (/GAZ|DISS|SOAS|STRIKE/.test(f.type || '') || /replacement/i.test(desc)) && f.date >= cutoff);
  const groups = {};
  for (const x of unusual) (groups[x.f.date + x.f.type] = groups[x.f.date + x.f.type] || []).push(x);
  for (const g of Object.values(groups)) {
    const { f } = g[0];
    if (g.length > 1 && g.every(x => /^replacement/i.test(x.desc))) {
      const ids = g.map(x => x.f.transaction_id).sort(); // one item, so the ID uses the first transaction in sort order
      const years = g.map(x => (/(\d{4})\s*$/.exec(x.desc) || [])[1]).filter(Boolean).sort().join(', ');
      items.push({
        id: `filing:${ids[0]}`, kind: 'filing', title: `${g.length} replacement confirmation statements filed on one day`,
        detail: `Filed ${fmtD(f.date)} (${f.type}), covering ${years}`, date: f.date, link: filingsLink, severity: 'warn', state: '',
      });
    } else {
      for (const x of g) items.push({
        id: `filing:${x.f.transaction_id}`, kind: 'filing', title: x.desc,
        detail: `Filed ${fmtD(x.f.date)} (${x.f.type})`, date: x.f.date, link: filingsLink, severity: 'warn', state: '',
      });
    }
  }

  // Other appointments: one item per officer per other company.
  const people = new Map(); // someone can appear twice at Langdon, e.g. director and secretary
  for (const o of officers) {
    const id = ((o.links && o.links.officer && o.links.officer.appointments) || '').split('/')[2];
    if (!id) throw fail('upstream_failed', `No officer ID for ${o.name}`);
    if (!people.has(id)) people.set(id, { id, name: o.name, current: false });
    if (!o.resigned_on) people.get(id).current = true;
  }
  const generatedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  for (const person of people.values()) {
    if (!WATCH_INCLUDE_FORMER_OFFICERS && !person.current) continue;
    const appts = await getAll(`/officers/${person.id}/appointments`, 50);
    const best = {};
    for (const a of appts) {
      const n = a.appointed_to && a.appointed_to.company_number;
      if (!n || n === COMPANY) continue;
      // Several roles at one company share an ID, so always pick the same one: active first, then latest.
      const rank = x => `${x.resigned_on ? 0 : 1}|${x.appointed_on || x.appointed_before || ''}|${x.officer_role || ''}`;
      if (!best[n] || rank(a) > rank(best[n])) best[n] = a;
    }
    for (const [n, a] of Object.entries(best)) {
      const status = a.appointed_to.company_status || '';
      const on = a.appointed_on || a.appointed_before;
      const dated = on ? `Appointed ${fmtD(on)}` : 'Appointment date not given';
      const bad = /dissolved|liquidation|receivership|administration|insolvency|struck|removed/.test(status);
      items.push({
        id: `appt:${person.id}:${n}`, kind: 'appointment',
        title: `${person.name} \u2013 ${words(a.officer_role)} at ${a.appointed_to.company_name || n}`,
        detail: dated + (a.resigned_on ? `, resigned ${fmtD(a.resigned_on)}` : '') + (status && status !== 'active' ? `. Company status: ${words(status)}` : ''),
        date: a.resigned_on || on || generatedAt.slice(0, 10), link: `${SITE}/company/${n}`,
        severity: bad ? 'alert' : 'warn',
        state: `${a.officer_role || ''}|${a.appointed_on || ''}|${a.resigned_on || ''}|${status}`,
      });
    }
  }

  return { version: 1, company: { number: COMPANY, name: profile.company_name || '' }, generatedAt, items };
}
