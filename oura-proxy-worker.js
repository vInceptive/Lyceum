// Cloudflare Worker — CORS proxy for the Oura API v2.
// The browser gets its access token via Oura's OAuth flow and sends it in the
// Authorization header; this Worker forwards the request to Oura and adds the
// CORS headers the browser needs. No token is stored here.
//
// DEPLOY:
//   1. dash.cloudflare.com → Workers & Pages → Create → Worker.
//   2. Replace ALL default code with everything in this file → Deploy.
//   3. Copy your Worker URL (e.g. https://oura-proxy.YOURNAME.workers.dev).
//   4. Paste that URL into the Vitals tab (Proxy URL field) → Save & Sync.

const OURA_BASE = 'https://api.ouraring.com/v2/usercollection';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*, Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request) {
    // CORS preflight — must succeed before the browser sends the real GET.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    try {
      const url = new URL(request.url);
      // Forward /daily_sleep?start_date=… → Oura's usercollection endpoint.
      const target = OURA_BASE + url.pathname + url.search;
      const upstream = await fetch(target, {
        headers: { Authorization: request.headers.get('Authorization') || '' },
      });
      const body = await upstream.text();
      return new Response(body, {
        status: upstream.status,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ detail: 'proxy error: ' + err.message }), {
        status: 502,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
  },
};
