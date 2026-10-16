// Market data clients.
// DexScreener: token stats and pairs. GeckoTerminal: candles and trades.
// Both are called from the viewer's browser, so free rate limits apply per
// user rather than to the whole site.

import { rpc, SOL_MINT, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from './chain';

const DS = 'https://api.dexscreener.com';
const GT = 'https://api.geckoterminal.com/api/v2/networks/solana';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) {
    const e = new Error(`HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

/* ---------- DexScreener ---------- */

function bestPairFor(pairs, mint) {
  const own = (Array.isArray(pairs) ? pairs : []).filter(
    (p) => p?.chainId === 'solana' && p.baseToken?.address === mint
  );
  own.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  return own[0] || null;
}

// The most liquid pair where this token is the base token, or null.
export async function fetchPair(mint) {
  return bestPairFor(await getJson(`${DS}/tokens/v1/solana/${mint}`), mint);
}

// Best pair for many tokens at once (DexScreener takes 30 per call).
export async function fetchPairs(mints) {
  const out = new Map();
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    try {
      const arr = await getJson(`${DS}/tokens/v1/solana/${chunk.join(',')}`);
      for (const m of chunk) {
        const best = bestPairFor(arr, m);
        if (best) out.set(m, best);
      }
    } catch {}
  }
  return out;
}

export async function fetchSolPrice() {
  const arr = await getJson(`${DS}/tokens/v1/solana/${SOL_MINT}`);
  const list = (Array.isArray(arr) ? arr : []).filter(
    (p) => p?.baseToken?.address === SOL_MINT && /^(USDC|USDT)$/i.test(p?.quoteToken?.symbol || '')
  );
  list.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const v = Number(list[0]?.priceUsd);
  return v > 0 ? v : null;
}

/* ---------- GeckoTerminal (free tier: about 10 calls a minute) ---------- */

const stamps = [];
const LIMIT = 9;
const WINDOW = 61000;

async function gtSlot(isCancelled) {
  for (;;) {
    if (isCancelled?.()) throw Object.assign(new Error('cancelled'), { cancelled: true });
    const now = Date.now();
    while (stamps.length && now - stamps[0] > WINDOW) stamps.shift();
    if (stamps.length < LIMIT) {
      stamps.push(now);
      return;
    }
    await sleep(Math.min(5000, WINDOW - (now - stamps[0]) + 50));
  }
}

// Browsers try GeckoTerminal directly first (each viewer has their own rate
// limit). If the browser blocks that request, we remember it for a day and go
// through our own cached /api/gt route instead.
const DIRECT_FLAG = 'yapper:gt-direct-blocked';
let directState = null; // null = unknown, 'ok', 'blocked'

function directBlocked() {
  if (directState === null) {
    try {
      const t = Number(localStorage.getItem(DIRECT_FLAG));
      if (t && Date.now() - t < 86400000) directState = 'blocked';
    } catch {}
  }
  return directState === 'blocked';
}

function blockDirect() {
  directState = 'blocked';
  try {
    localStorage.setItem(DIRECT_FLAG, String(Date.now()));
  } catch {}
}

export async function gt(path, isCancelled) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (isCancelled?.()) throw Object.assign(new Error('cancelled'), { cancelled: true });
    let r = null;

    if (!directBlocked()) {
      await gtSlot(isCancelled);
      try {
        r = await fetch(GT + path, { headers: { accept: 'application/json' } });
        directState = 'ok';
      } catch {
        // blocked by the browser (CORS) or a network blip
        if (directState !== 'ok') blockDirect();
        r = null;
      }
      if (r && r.status === 429) r = null; // this viewer is rate limited: try our cache
    }

    if (!r) {
      try {
        r = await fetch(`/api/gt?path=${encodeURIComponent(path)}`, { headers: { accept: 'application/json' } });
      } catch {
        await sleep(1500);
        continue;
      }
    }

    if (r.status === 429 || r.status === 503) {
      await sleep(4000);
      continue;
    }
    if (!r.ok) {
      const e = new Error(`HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return r.json();
  }
  throw new Error('Market data is busy. Retrying shortly.');
}

// GeckoTerminal usually knows a pool by the same address DexScreener uses.
// If it doesn't, look the token's top pool up once and remember it.
const goodPool = new Map();
const lookups = new Map();

function lookupPool(mint, isCancelled) {
  if (!lookups.has(mint)) {
    const p = gt(`/tokens/${mint}/pools?page=1`, isCancelled).then((j) => {
      const pool = j?.data?.[0]?.attributes?.address;
      if (!pool) throw new Error('No pool found');
      return pool;
    });
    lookups.set(mint, p);
    p.catch(() => lookups.delete(mint));
  }
  return lookups.get(mint);
}

export async function withPool(mint, pairAddress, fn, isCancelled) {
  const known = goodPool.get(mint);
  if (known) return fn(known);
  if (pairAddress) {
    try {
      const out = await fn(pairAddress);
      goodPool.set(mint, pairAddress);
      return out;
    } catch (e) {
      if (e?.status !== 404) throw e;
    }
  }
  const pool = await lookupPool(mint, isCancelled);
  const out = await fn(pool);
  goodPool.set(mint, pool);
  return out;
}

/* ---------- wallet positions ---------- */

export async function loadPositions(wallet) {
  const opts = { encoding: 'jsonParsed', commitment: 'confirmed' };
  const [classic, t22] = await Promise.all([
    rpc('getParsedTokenAccountsByOwner', [wallet, { programId: TOKEN_PROGRAM }, opts]),
    rpc('getParsedTokenAccountsByOwner', [wallet, { programId: TOKEN_2022_PROGRAM }, opts]).catch(() => ({ value: [] })),
  ]);

  const balances = new Map();
  for (const acc of [...(classic?.value || []), ...(t22?.value || [])]) {
    const info = acc?.account?.data?.parsed?.info;
    const m = info?.mint;
    const amt = Number(info?.tokenAmount?.uiAmountString ?? info?.tokenAmount?.uiAmount) || 0;
    if (!m || !(amt > 0) || m === SOL_MINT) continue;
    balances.set(m, (balances.get(m) || 0) + amt);
  }

  const mints = [...balances.keys()].slice(0, 150);
  const pairs = await fetchPairs(mints);
  const rows = [];
  for (const m of mints) {
    const p = pairs.get(m);
    if (!p) continue;
    const priceUsd = Number(p.priceUsd) || 0;
    const amt = balances.get(m);
    const value = amt * priceUsd;
    if (value < 0.01) continue;
    rows.push({
      mint: m,
      name: p.baseToken?.name || 'Unknown',
      symbol: p.baseToken?.symbol || '',
      imageUrl: p.info?.imageUrl || null,
      amount: amt,
      priceUsd,
      value,
      change24h: p.priceChange?.h24 ?? null,
      pairAddress: p.pairAddress,
    });
  }
  rows.sort((a, b) => b.value - a.value);
  return rows;
}
