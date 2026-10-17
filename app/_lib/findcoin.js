// Which coin a spoken name means, looked for the way a person would:
//   1. the coins on your screen (Discover, Pulse, your positions)
//   2. coins the last few answers named
//   3. coins you hold or traded, then your own orders
//   4. a search across Solana, ranked by coinrank.js: a coin launched in the
//      last hour that has holders, or a recent coin with real trading, comes
//      before an old coin with a bigger market cap
// "the PEPE at 25K" (mc) takes the closest market cap; "the newest" and
// "the biggest" (pick) change the order of the search.

import { matchLevel, pickCoin } from './coinrank';

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// within 2x of the market cap they said
export const nearMc = (c, mc) => !mc || (num(c?.mc) > 0 && Math.abs(Math.log(c.mc / mc)) <= Math.log(2));

// a /api/search result -> the shape coinrank.js ranks
export function fromSearch(r) {
  if (!r?.mint) return null;
  return {
    mint: r.mint,
    name: r.name || '',
    symbol: r.symbol || '',
    image: r.imageUrl || null,
    mc: num(r.marketCap),
    liq: num(r.liquidity),
    priceUsd: num(r.priceUsd),
    vol1h: num(r.volume1h),
    vol24h: num(r.volume24h),
    trades1h: num(r.trades1h),
    buys1h: num(r.buys1h),
    traders1h: num(r.traders1h),
    holders: num(r.holders),
    chg1h: num(r.change1h),
    chg24h: num(r.change24h),
    createdAt: num(r.createdAt),
    lastTradeAt: num(r.lastTradeAt),
    dex: r.dexId || null,
    curve: typeof r.onCurve === 'boolean' ? r.onCurve : null,
    verified: !!r.verified,
  };
}

// q: the name as said. Returns { coin, others, exact, near, from } or null.
export async function findCoin(q, { mc = null, pick = null, screen = [], recent = [], held = [], orders = [], search = null, now = Date.now() } = {}) {
  const hint = num(mc) > 0 ? num(mc) : null;
  const fits = (c, min) => matchLevel(c, q, { fuzzy: true }) >= min;

  // 1. on screen: the exact name, or a near miss (speech to text slips)
  if (!pick) {
    const seen = screen.filter((c) => fits(c, 3) && nearMc(c, hint));
    const p = seen.length ? pickCoin(seen, { q, mc: hint, now }) : null;
    if (p) return { ...p, from: 'screen' };
  }

  // 2-3. a coin you just talked about, hold, traded or have orders on
  if (!pick && !hint) {
    for (const [list, from] of [
      [recent, 'recent'],
      [held, 'held'],
      [orders, 'orders'],
    ]) {
      const hit = list.find((c) => c?.mint && fits(c, 4));
      if (hit) return { coin: hit, others: [], exact: true, near: false, from };
    }
  }

  // 4. everywhere else, together with what's on screen
  let found = [];
  if (search) {
    try {
      found = (await search(q, { sort: pick === 'newest' ? 'new' : pick === 'biggest' ? 'mc' : 'best', mc: hint })).filter(Boolean);
    } catch {
      found = [];
    }
  }
  const p = pickCoin([...found, ...screen], { q, mc: hint, pick, now });
  if (p) return { ...p, from: found.some((c) => c.mint === p.coin.mint) ? 'search' : 'screen' };
  return null;
}
