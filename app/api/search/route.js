// Coin search by name or ticker ("bonk", "$WIF"), for the search box and voice.
// No single source knows every coin, so several are asked at once:
//   Jupiter         any Solana coin, with holders and the last hour's trading
//   DexScreener     established coins and their pools
//   GeckoTerminal   pools by name, bonding curve included
//   our coin lists  pump.fun coins trading right now (shared and cached)
// Whatever answers in time is merged into one entry per coin, coins missing
// holder counts are filled in from Jupiter, and the list is ordered by
// ../../_lib/coinrank.js:
//   ?sort=best  (default) fresh coins with holders and real trading first
//   ?sort=new   newest first
//   ?sort=mc    biggest first
//   ?mc=25000   closest to that market cap ("the one at 25K")
//   ?fuzzy=1    let near misses in (spoken names)

import { rankCoins, matchLevel, SORTS } from '../../_lib/coinrank';
import { buildLists, rows as poolRows } from '../_lists';

export const maxDuration = 15;

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SKIP = new Set([
  SOL_MINT,
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOURCE_MS = 2500;

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};
const sum = (...v) => (v.some((x) => num(x) !== null) ? v.reduce((a, x) => a + (num(x) || 0), 0) : null);
const time = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) && t > 0 ? t : null;
};
const img = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) && !/missing/i.test(u) ? u : null);
const text = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// one upstream call, given up after `ms`
async function getJson(url, { ms = SOURCE_MS, ttl = 15, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: ctrl.signal, next: { revalidate: ttl } });
    if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// any promise, given up after `ms`
const within = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);

/* ---------- sources ---------- */

function jupiter() {
  const key = process.env.JUPITER_API_KEY;
  return { base: key ? 'https://api.jup.ag' : 'https://lite-api.jup.ag', headers: key ? { 'x-api-key': key } : {} };
}

function fromJupiter(t) {
  if (!t?.id || !B58.test(t.id)) return null;
  const h1 = t.stats1h || {};
  const d1 = t.stats24h || {};
  const curve = t.graduatedPool ? false : /pump/i.test(String(t.launchpad || '')) ? true : null;
  return {
    mint: t.id,
    name: text(t.name, 60),
    symbol: text(t.symbol, 24),
    image: img(t.icon),
    mc: num(t.mcap) ?? num(t.fdv),
    liq: num(t.liquidity),
    priceUsd: num(t.usdPrice),
    vol1h: sum(h1.buyVolume, h1.sellVolume),
    vol24h: sum(d1.buyVolume, d1.sellVolume),
    trades1h: sum(h1.numBuys, h1.numSells),
    buys1h: num(h1.numBuys),
    traders1h: num(h1.numTraders),
    holders: num(t.holderCount),
    chg1h: num(h1.priceChange),
    chg24h: num(d1.priceChange),
    createdAt: time(t.firstPool?.createdAt) ?? time(t.createdAt),
    launchpad: typeof t.launchpad === 'string' ? text(t.launchpad, 24) : null,
    curve,
    verified: t.isVerified === true,
  };
}

async function searchJupiter(q) {
  const { base, headers } = jupiter();
  const list = await getJson(`${base}/tokens/v2/search?query=${encodeURIComponent(q)}`, { headers });
  return (Array.isArray(list) ? list : []).map(fromJupiter).filter(Boolean);
}

// holders and trading for coins the other sources found (up to 100 at once)
async function jupiterByMint(mints) {
  if (!mints.length) return [];
  const { base, headers } = jupiter();
  const list = await getJson(`${base}/tokens/v2/search?query=${mints.slice(0, 100).join(',')}`, { headers, ttl: 30, ms: 2000 });
  return (Array.isArray(list) ? list : []).map(fromJupiter).filter(Boolean);
}

async function searchDexScreener(q) {
  const j = await getJson(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`);
  const by = new Map();
  for (const p of Array.isArray(j?.pairs) ? j.pairs : []) {
    const mint = p?.baseToken?.address;
    if (p?.chainId !== 'solana' || !mint || !B58.test(mint) || SKIP.has(mint)) continue;
    const liq = num(p.liquidity?.usd) || 0;
    const h1 = p.txns?.h1;
    const row = {
      mint,
      name: text(p.baseToken.name, 60),
      symbol: text(p.baseToken.symbol, 24),
      image: img(p.info?.imageUrl),
      mc: num(p.marketCap) ?? num(p.fdv),
      liq,
      priceUsd: num(p.priceUsd),
      vol1h: num(p.volume?.h1),
      vol24h: num(p.volume?.h24),
      trades1h: h1 ? sum(h1.buys, h1.sells) : null,
      buys1h: num(h1?.buys),
      chg1h: num(p.priceChange?.h1),
      chg24h: num(p.priceChange?.h24),
      createdAt: time(p.pairCreatedAt),
      dex: text(p.dexId, 24) || null,
      curve: String(p.dexId || '').toLowerCase() === 'pumpfun',
      pairAddress: p.pairAddress || null,
      _best: liq,
    };
    const cur = by.get(mint);
    if (!cur) {
      by.set(mint, row);
      continue;
    }
    // the same coin in several pools: add up, keep the deepest pool's price
    cur.liq += liq;
    cur.vol1h = sum(cur.vol1h, row.vol1h);
    cur.vol24h = sum(cur.vol24h, row.vol24h);
    cur.trades1h = sum(cur.trades1h, row.trades1h);
    cur.buys1h = sum(cur.buys1h, row.buys1h);
    if (row.createdAt && (!cur.createdAt || row.createdAt < cur.createdAt)) cur.createdAt = row.createdAt;
    cur.image ||= row.image;
    if (liq > cur._best) Object.assign(cur, { _best: liq, mc: row.mc ?? cur.mc, priceUsd: row.priceUsd, chg1h: row.chg1h, chg24h: row.chg24h, dex: row.dex, curve: row.curve, pairAddress: row.pairAddress });
  }
  return [...by.values()].map(({ _best, ...c }) => c);
}

function fromPoolRow(r) {
  if (!r?.mint || SKIP.has(r.mint)) return null;
  const t1 = r.txns?.h1;
  return {
    mint: r.mint,
    name: text(r.name, 60),
    symbol: text(r.symbol, 24),
    image: r.image || null,
    mc: num(r.mc),
    liq: num(r.liq),
    priceUsd: num(r.priceUsd),
    vol1h: num(r.vol?.h1),
    vol24h: num(r.vol?.h24),
    trades1h: t1 ? sum(t1.b, t1.s) : null,
    buys1h: num(t1?.b),
    traders1h: num(t1?.u),
    chg1h: num(r.chg?.h1),
    chg24h: num(r.chg?.h24),
    createdAt: num(r.createdAt),
    dex: r.dex || null,
    curve: typeof r.curve === 'boolean' ? r.curve : null,
    pairAddress: r.pool || null,
  };
}

async function searchGecko(q) {
  const j = await getJson(`https://api.geckoterminal.com/api/v2/search/pools?query=${encodeURIComponent(q)}&network=solana&include=base_token&page=1`, { ttl: 30 });
  return poolRows(j).map(fromPoolRow).filter(Boolean);
}

// the pump.fun coins on Discover and Pulse right now (cached upstream calls)
async function searchLists(q, fuzzy) {
  const { lists } = await buildLists(new Set(['curve', 'new', 'final', 'migrated']));
  const all = Object.values(lists).flat();
  return all.filter((r) => matchLevel(r, q, { fuzzy })).map(fromPoolRow).filter(Boolean);
}

/* ---------- one entry per coin ---------- */

const FIELDS = [
  'name', 'symbol', 'image', 'mc', 'liq', 'priceUsd', 'vol1h', 'vol24h', 'trades1h', 'buys1h', 'traders1h', 'holders',
  'chg1h', 'chg24h', 'launchpad', 'curve', 'dex', 'pairAddress', 'lastTradeAt', 'verified',
];

// sources in order of trust: the first one with a value wins, except the
// launch time, where the earliest anyone saw is the real one
function mergeAll(groups) {
  const by = new Map();
  for (const g of groups) {
    for (const c of g) {
      if (!c?.mint || SKIP.has(c.mint)) continue;
      const cur = by.get(c.mint);
      if (!cur) {
        by.set(c.mint, { ...c });
        continue;
      }
      for (const k of FIELDS) if ((cur[k] === null || cur[k] === undefined || cur[k] === '') && c[k] !== null && c[k] !== undefined) cur[k] = c[k];
      if (c.createdAt && (!cur.createdAt || c.createdAt < cur.createdAt)) cur.createdAt = c.createdAt;
    }
  }
  return [...by.values()];
}

// Jupiter's numbers replace the others' (they cover every pool of the coin)
function fillFrom(coins, extra) {
  const by = new Map(extra.map((c) => [c.mint, c]));
  return coins.map((c) => {
    const j = by.get(c.mint);
    if (!j) return c;
    const out = { ...c };
    for (const k of ['mc', 'liq', 'vol1h', 'vol24h', 'trades1h', 'buys1h', 'traders1h', 'holders', 'chg1h', 'chg24h', 'verified']) {
      if (j[k] !== null && j[k] !== undefined) out[k] = j[k];
    }
    out.image ||= j.image;
    out.launchpad ||= j.launchpad;
    if (j.createdAt && (!out.createdAt || j.createdAt < out.createdAt)) out.createdAt = j.createdAt;
    if (out.curve === null || out.curve === undefined) out.curve = j.curve;
    return out;
  });
}

function shape(c) {
  return {
    mint: c.mint,
    name: c.name || '',
    symbol: c.symbol || '',
    imageUrl: c.image || null,
    priceUsd: c.priceUsd ?? null,
    marketCap: c.mc ?? null,
    liquidity: c.liq ?? null,
    volume1h: c.vol1h ?? null,
    volume24h: c.vol24h ?? null,
    trades1h: c.trades1h ?? null,
    buys1h: c.buys1h ?? null,
    traders1h: c.traders1h ?? null,
    holders: c.holders ?? null,
    change1h: c.chg1h ?? null,
    change24h: c.chg24h ?? null,
    createdAt: c.createdAt ?? null,
    lastTradeAt: c.lastTradeAt ?? null,
    dexId: c.dex || null,
    onCurve: typeof c.curve === 'boolean' ? c.curve : null,
    launchpad: c.launchpad || null,
    verified: !!c.verified,
    pairAddress: c.pairAddress || null,
    match: c.match,
  };
}

export async function GET(req) {
  const u = new URL(req.url);
  const q = (u.searchParams.get('q') || '').trim().replace(/^\$/, '').slice(0, 64);
  const sort = SORTS.includes(u.searchParams.get('sort')) ? u.searchParams.get('sort') : 'best';
  const mc = num(u.searchParams.get('mc'));
  const fuzzy = u.searchParams.get('fuzzy') === '1';
  const limit = Math.min(Math.max(Number(u.searchParams.get('limit')) || 12, 1), 30);
  if (q.length < 2) return Response.json({ results: [] });

  const t0 = Date.now();
  const names = ['jupiter', 'dexscreener', 'geckoterminal', 'lists'];
  const took = {};
  const timed = (name, p) => p.finally(() => (took[name] = Date.now() - t0));
  const jobs = [
    timed('jupiter', searchJupiter(q)),
    timed('dexscreener', searchDexScreener(q)),
    timed('geckoterminal', q.length >= 3 ? searchGecko(q) : Promise.resolve([])),
    timed('lists', within(searchLists(q, fuzzy), SOURCE_MS)),
  ];
  const settled = await Promise.allSettled(jobs);
  // how each source did, for checking the search from outside: count (or failed) and ms
  const sources = {};
  const groups = settled.map((s, i) => {
    sources[names[i]] = `${s.status === 'fulfilled' ? s.value.length : 'failed'} in ${took[names[i]]}ms`;
    return s.status === 'fulfilled' ? s.value : [];
  });
  // the lists can come back empty without failing, so they don't count here
  if (groups.every((g) => !g.length) && settled.slice(0, 3).every((s) => s.status === 'rejected')) {
    return Response.json({ results: [], sources, error: 'Search is unavailable right now' }, { status: 502, headers: { 'cache-control': 'no-store' } });
  }

  const now = Date.now();
  let coins = mergeAll(groups);
  // only what fits the name; then fill in holders for the likely picks
  let ranked = rankCoins(coins, { q, sort, mc: mc > 0 ? mc : null, fuzzy, now });
  const need = ranked
    .slice(0, 60)
    .filter((c) => c.holders === null || c.holders === undefined)
    .map((c) => c.mint);
  if (need.length) {
    try {
      const extra = await jupiterByMint(need);
      sources.filled = `${extra.length} of ${need.length}`;
      coins = fillFrom(ranked, extra);
      ranked = rankCoins(coins, { q, sort, mc: mc > 0 ? mc : null, fuzzy, now });
    } catch {
      sources.filled = 'failed';
    }
  }

  return Response.json(
    { results: ranked.slice(0, limit).map(shape), sources },
    { headers: { 'cache-control': 'public, s-maxage=10, stale-while-revalidate=30' } }
  );
}
