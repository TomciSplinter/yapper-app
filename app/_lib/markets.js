// Market data clients.
// DexScreener: token stats and pairs. GeckoTerminal: candles and trades.
// Both are called from the viewer's browser, so free rate limits apply per
// user rather than to the whole site.

import { rpc, rpcBatchSettled, SOL_MINT, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from './chain';
import { readTokenAccount, readMintDecimals, toUi, ataAddress } from './holdings';
import { knownMints, knownAccounts, scanWallet } from './known';

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

// All pools GeckoTerminal knows for a token, most active first.
export async function listPools(mint, isCancelled) {
  const j = await gt(`/tokens/${mint}/pools?page=1`, isCancelled);
  return (j?.data || []).map((p) => p?.attributes?.address).filter(Boolean);
}

// Remember the pool that actually has data so trades use the same one.
export function rememberPool(mint, pool) {
  goodPool.set(mint, pool);
}

export function knownPool(mint) {
  return goodPool.get(mint) || null;
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

// Every coin the wallet holds. Token accounts are read raw from both token
// programs (classic and Token-2022) and decimals from each mint, so a coin
// can't go missing because of how an RPC parses it. Coins traded through
// Yapper are also read by address, in case the RPC's index misses them.
// Coins DexScreener doesn't list yet still show, just without a price.
export async function loadPositions(wallet) {
  const cfg = { encoding: 'base64', commitment: 'confirmed' };
  await scanWallet(wallet).catch(() => []); // learn coins from recent transactions
  const [classic, t22] = await rpcBatchSettled([
    ['getTokenAccountsByOwner', [wallet, { programId: TOKEN_PROGRAM }, cfg]],
    ['getTokenAccountsByOwner', [wallet, { programId: TOKEN_2022_PROGRAM }, cfg]],
  ]);
  if (!classic.ok) console.warn('[yapper] token accounts (classic) failed:', classic.error);
  if (!t22.ok) console.warn('[yapper] token accounts (Token-2022) failed:', t22.error);

  const seen = new Set(); // token account addresses already counted
  const raw = new Map(); // mint -> BigInt
  const add = (addr, t) => {
    if (!t || t.owner !== wallet || t.mint === SOL_MINT || t.raw === 0n || seen.has(addr)) return;
    seen.add(addr);
    raw.set(t.mint, (raw.get(t.mint) || 0n) + t.raw);
  };
  for (const r of [classic, t22]) {
    if (!r.ok) continue;
    for (const it of r.result?.value || []) add(it.pubkey, readTokenAccount(it.account));
  }

  // coins traded here: read their accounts by address too
  const direct = [];
  for (const m of knownMints(wallet)) {
    for (const a of [ataAddress(wallet, m, TOKEN_PROGRAM), ataAddress(wallet, m, TOKEN_2022_PROGRAM), ...knownAccounts(wallet, m)]) {
      if (a && !seen.has(a) && !direct.includes(a)) direct.push(a);
    }
  }
  let directOk = false;
  for (let i = 0; i < direct.length; i += 100) {
    const chunk = direct.slice(i, i + 100);
    try {
      const r = await rpc('getMultipleAccounts', [chunk, cfg]);
      (r?.value || []).forEach((a, j) => add(chunk[j], readTokenAccount(a)));
      directOk = true;
    } catch (e) {
      console.warn('[yapper] reading traded coins failed:', e?.message);
    }
  }
  // nothing could be read at all: say so instead of showing an empty wallet
  if (!classic.ok && !t22.ok && !directOk) throw new Error(classic.error);
  const mints = [...raw.keys()].slice(0, 150);
  if (!mints.length) return [];

  const decimals = new Map();
  for (let i = 0; i < mints.length; i += 100) {
    const chunk = mints.slice(i, i + 100);
    try {
      const r = await rpc('getMultipleAccounts', [chunk, cfg]);
      (r?.value || []).forEach((a, j) => {
        const d = readMintDecimals(a);
        if (d !== null) decimals.set(chunk[j], d);
      });
    } catch {}
  }

  const pairs = await fetchPairs(mints);
  const rows = [];
  for (const m of mints) {
    const p = pairs.get(m);
    const amt = toUi(raw.get(m), decimals.get(m) ?? 6);
    const priceUsd = p ? Number(p.priceUsd) || 0 : null;
    const value = priceUsd !== null ? amt * priceUsd : null;
    if (value !== null && value < 0.01) continue; // dust
    if (!p && !decimals.has(m)) continue;
    rows.push({
      mint: m,
      name: p?.baseToken?.name || 'Unknown coin',
      symbol: p?.baseToken?.symbol || `${m.slice(0, 4)}…${m.slice(-4)}`,
      imageUrl: p?.info?.imageUrl || null,
      amount: amt,
      priceUsd,
      priceNative: p && p.quoteToken?.address === SOL_MINT ? Number(p.priceNative) || null : null,
      value,
      change24h: p?.priceChange?.h24 ?? null,
      pairAddress: p?.pairAddress || null,
    });
  }
  rows.sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  return rows;
}
