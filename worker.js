// Cloudflare Worker: read-only proxy to the Companies House API for company 14230172.
// Companies House sends no CORS headers, so the PWA cannot call it directly.
// Setup: create a free API key at https://developer.company-information.service.gov.uk/ (REST key),
// then in the Worker settings add secret CH_API_KEY and variable ALLOW_ORIGIN (e.g. https://wlpreynolds.github.io).
// UNTESTED against the live API (the build environment has no route to Companies House): test via the Setup tab.
const COMPANY = '14230172';
const API = 'https://api.company-information.service.gov.uk';
const DOCAPI = 'https://document-api.company-information.service.gov.uk/document/';

export default {
  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
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
