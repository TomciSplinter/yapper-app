// Trending Solana coins for the Discover page.
// GeckoTerminal trending pools first; DexScreener's top boosted tokens as a
// fallback. Cached for 60s so every visitor shares the same few upstream calls.

export const dynamic = 'force-dynamic';

const GT = 'https://api.geckoterminal.com/api/v2/networks/solana';
const DS = 'https://api.dexscreener.com';

// SOL and stablecoins trend constantly but aren't what people come here for
const SKIP = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function img(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u) && !/missing/i.test(u) ? u : null;
}

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' }, next: { revalidate: 60 } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function fromGecko() {
  const pages = await Promise.all(
    [1, 2].map((p) => getJson(`${GT}/trending_pools?include=base_token&page=${p}`).catch(() => null))
  );
  const rows = [];
  const seen = new Set();
  for (const j of pages) {
    if (!Array.isArray(j?.data)) continue;
    const tokens = new Map(
      (j.included || []).filter((x) => x?.type === 'token').map((x) => [x.id, x.attributes || {}])
    );
    for (const p of j.data) {
      const a = p?.attributes || {};
      const baseId = p?.relationships?.base_token?.data?.id || '';
      const t = tokens.get(baseId) || {};
      const mint = t.address || baseId.replace(/^solana_/, '');
      if (!mint || seen.has(mint) || SKIP.has(mint)) continue;
      seen.add(mint);
      const pairName = String(a.name || '').split(' / ')[0];
      const tx = a.transactions?.h24 || {};
      rows.push({
        mint,
        name: t.name || pairName || 'Unknown',
        symbol: t.symbol || pairName || '',
        imageUrl: img(t.image_url),
        pool: a.address || null,
        dex: p?.relationships?.dex?.data?.id || null,
        priceUsd: num(a.base_token_price_usd),
        marketCap: num(a.market_cap_usd) ?? num(a.fdv_usd),
        liquidity: num(a.reserve_in_usd),
        volume24h: num(a.volume_usd?.h24),
        change5m: num(a.price_change_percentage?.m5),
        change1h: num(a.price_change_percentage?.h1),
        change24h: num(a.price_change_percentage?.h24),
        buys24h: num(tx.buys),
        sells24h: num(tx.sells),
        createdAt: a.pool_created_at ? Date.parse(a.pool_created_at) || null : null,
      });
    }
  }
  return rows;
}

async function fromDexScreener() {
  const boosts = await getJson(`${DS}/token-boosts/top/v1`);
  const mints = [
    ...new Set(
      (Array.isArray(boosts) ? boosts : [])
        .filter((b) => b?.chainId === 'solana' && b.tokenAddress && !SKIP.has(b.tokenAddress))
        .map((b) => b.tokenAddress)
    ),
  ].slice(0, 30);
  if (!mints.length) return [];
  const pairs = await getJson(`${DS}/tokens/v1/solana/${mints.join(',')}`);
  const best = new Map();
  for (const p of Array.isArray(pairs) ? pairs : []) {
    const m = p?.baseToken?.address;
    if (!mints.includes(m)) continue;
    const cur = best.get(m);
    if (!cur || (p.liquidity?.usd || 0) > (cur.liquidity?.usd || 0)) best.set(m, p);
  }
  return mints
    .filter((m) => best.has(m))
    .map((m) => {
      const p = best.get(m);
      return {
        mint: m,
        name: p.baseToken?.name || 'Unknown',
        symbol: p.baseToken?.symbol || '',
        imageUrl: img(p.info?.imageUrl),
        pool: p.pairAddress || null,
        dex: p.dexId || null,
        priceUsd: num(p.priceUsd),
        marketCap: num(p.marketCap) ?? num(p.fdv),
        liquidity: num(p.liquidity?.usd),
        volume24h: num(p.volume?.h24),
        change5m: num(p.priceChange?.m5),
        change1h: num(p.priceChange?.h1),
        change24h: num(p.priceChange?.h24),
        buys24h: num(p.txns?.h24?.buys),
        sells24h: num(p.txns?.h24?.sells),
        createdAt: num(p.pairCreatedAt),
      };
    });
}

export async function GET() {
  let results = [];
  let source = 'geckoterminal';
  try {
    results = await fromGecko();
  } catch {}
  if (!results.length) {
    source = 'dexscreener';
    try {
      results = await fromDexScreener();
    } catch {}
  }
  if (!results.length) {
    return Response.json({ results: [], error: 'Trending data is unavailable right now' }, { status: 502 });
  }
  return Response.json(
    { results: results.slice(0, 40), source },
    { headers: { 'cache-control': 'public, s-maxage=30, stale-while-revalidate=60' } }
  );
}
