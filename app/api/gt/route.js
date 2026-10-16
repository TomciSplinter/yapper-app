// Same-origin proxy for the few GeckoTerminal endpoints the terminal uses
// (candles, trades, pool lookup). Browsers that can't call GeckoTerminal
// directly come through here. Responses are cached so every visitor looking
// at the same coin shares one upstream call.

const GT = 'https://api.geckoterminal.com/api/v2/networks/solana';
const ADDR = '[1-9A-HJ-NP-Za-km-z]{32,44}';
const OHLCV = new RegExp(`^/pools/(${ADDR})/ohlcv/(minute|hour|day)$`);
const TRADES = new RegExp(`^/pools/(${ADDR})/trades$`);
const POOLS = new RegExp(`^/tokens/(${ADDR})/pools$`);
const AGG = { minute: [1, 5, 15], hour: [1, 4, 12], day: [1] };

// Only rebuild known request shapes; never forward arbitrary paths or params.
function target(raw) {
  let u;
  try {
    u = new URL(raw, 'https://placeholder.invalid');
  } catch {
    return null;
  }
  const p = u.pathname;
  const q = u.searchParams;
  let m;
  if ((m = p.match(OHLCV))) {
    const tf = m[2];
    const agg = Number(q.get('aggregate') || 1);
    if (!AGG[tf].includes(agg)) return null;
    const limit = Math.min(Math.max(Number(q.get('limit')) || 300, 1), 1000);
    return {
      url: `${GT}/pools/${m[1]}/ohlcv/${tf}?aggregate=${agg}&limit=${limit}&currency=usd&token=base`,
      ttl: tf === 'minute' ? 15 : tf === 'hour' ? 60 : 300,
    };
  }
  if ((m = p.match(TRADES))) return { url: `${GT}/pools/${m[1]}/trades`, ttl: 10 };
  if ((m = p.match(POOLS))) return { url: `${GT}/tokens/${m[1]}/pools?page=1`, ttl: 3600 };
  return null;
}

function json(obj, status, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export async function GET(req) {
  const t = target(new URL(req.url).searchParams.get('path') || '');
  if (!t) return json({ error: 'Unsupported market data request' }, 400);

  let r;
  try {
    r = await fetch(t.url, { headers: { accept: 'application/json' }, next: { revalidate: t.ttl } });
  } catch {
    return json({ error: 'Market data is unreachable right now' }, 502, { 'cache-control': 'no-store' });
  }

  if (!r.ok) {
    if (r.status === 404) return json({ error: 'Not found' }, 404, { 'cache-control': 'public, s-maxage=120' });
    if (r.status === 429) return json({ error: 'Market data is busy' }, 503, { 'cache-control': 'no-store', 'retry-after': '10' });
    return json({ error: `Market data error ${r.status}` }, 502, { 'cache-control': 'no-store' });
  }

  return new Response(await r.text(), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': `public, s-maxage=${t.ttl}, stale-while-revalidate=${t.ttl * 4}`,
    },
  });
}
