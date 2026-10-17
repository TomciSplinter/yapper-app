// PnL across the wallet, for questions like "how am I doing today?" or
// "what was my best trade this week?". Built from the trade history in
// history.js (read from the chain) and live prices for what you hold.
//
// Per window (today, last 7 days) it counts:
//   realized   SOL made or lost on sells in the window (against your average
//              entry at the time)
//   unrealized what coins you bought in the window are up or down right now

import { allFills, historyCoverage, scanWallet, deepScan } from './history';
import { summarize } from './fills';
import { loadPositions, fetchPairs } from './markets';

const WEEK = 7 * 24 * 3600 * 1000;
const r4 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4);

const names = new Map(); // mint -> symbol

export async function portfolioSnapshot(wallet, solPrice, { positions } = {}) {
  if (!wallet) return null;
  await scanWallet(wallet).catch(() => []);
  const now = Date.now();
  // read further back in the background so "this week" fills in over time
  const cov = historyCoverage(wallet);
  if (!cov.complete && (!cov.since || cov.since > now - WEEK)) deepScan(wallet, now - WEEK).catch(() => {});

  const pos = positions || (await loadPositions(wallet).catch(() => []));
  const held = new Map(pos.map((p) => [p.mint, p]));
  for (const p of pos) if (p.symbol) names.set(p.mint, p.symbol);

  const byMint = new Map();
  for (const f of allFills(wallet)) {
    if (!byMint.has(f.mint)) byMint.set(f.mint, []);
    byMint.get(f.mint).push(f);
  }

  // names for coins you no longer hold
  const unnamed = [...byMint.keys()].filter((m) => !names.has(m)).slice(0, 30);
  if (unnamed.length) {
    const pairs = await fetchPairs(unnamed).catch(() => new Map());
    for (const [m, p] of pairs) if (p?.baseToken?.symbol) names.set(m, p.baseToken.symbol);
  }

  const coins = [];
  for (const [mint, fills] of byMint) {
    const h = held.get(mint);
    const priceSol = h ? h.priceNative || (solPrice && h.priceUsd ? h.priceUsd / solPrice : null) : null;
    const s = summarize(fills, h?.amount || 0, priceSol);
    if (!s) continue; // no buys we know of
    coins.push({ mint, symbol: names.get(mint) || `${mint.slice(0, 4)}…`, s, fills });
  }

  const windowStats = (t0) => {
    let realized = 0;
    let unrealized = 0;
    let buys = 0;
    let sells = 0;
    let spent = 0;
    let received = 0;
    const list = [];
    for (const c of coins) {
      const inWin = c.fills.filter((f) => f.time >= t0 && (f.side === 'buy' || f.side === 'sell'));
      if (!inWin.length) continue;
      const rz = c.s.sells.filter((x) => x.time >= t0).reduce((a, x) => a + x.realized, 0);
      const boughtIn = inWin.some((f) => f.side === 'buy');
      const ur = boughtIn && c.s.unrealized !== null ? c.s.unrealized : 0;
      realized += rz;
      unrealized += ur;
      for (const f of inWin) {
        if (f.side === 'buy') {
          buys++;
          spent += -f.sol;
        } else {
          sells++;
          received += f.sol;
        }
      }
      list.push({ symbol: c.symbol, mint: c.mint, pnl_sol: r4(rz + ur), pnl_pct: c.s.boughtSol > 0 ? Math.round(((rz + ur) / c.s.boughtSol) * 1000) / 10 : null });
    }
    list.sort((a, b) => b.pnl_sol - a.pnl_sol);
    const pnl = realized + unrealized;
    return {
      pnl_sol: r4(pnl),
      pnl_usd: solPrice ? Math.round(pnl * solPrice * 100) / 100 : null,
      realized_sol: r4(realized),
      unrealized_sol: r4(unrealized),
      sol_spent: r4(spent),
      sol_received: r4(received),
      buys,
      sells,
      coins_traded: list.length,
      best: list[0] || null,
      worst: list.length > 1 ? list[list.length - 1] : null,
    };
  };

  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const sinceCov = historyCoverage(wallet);
  return {
    history_since: sinceCov.complete ? 'all of this wallet' : sinceCov.since ? new Date(sinceCov.since).toISOString() : 'just the latest trades',
    today: windowStats(midnight.getTime()),
    last_7_days: windowStats(now - WEEK),
    coins: coins
      .sort((a, b) => (b.s.lastTrade || 0) - (a.s.lastTrade || 0))
      .slice(0, 12)
      .map((c) => ({
        symbol: c.symbol,
        mint: c.mint,
        bought_sol: r4(c.s.boughtSol),
        sold_sol: r4(c.s.soldSol),
        holding_value_sol: r4(c.s.value),
        realized_sol: r4(c.s.realized),
        unrealized_sol: r4(c.s.unrealized),
        pnl_sol: r4(c.s.pnl),
        pnl_pct: c.s.pnlPct === null ? null : Math.round(c.s.pnlPct * 10) / 10,
        last_trade_minutes_ago: c.s.lastTrade ? Math.round((now - c.s.lastTrade) / 60000) : null,
      })),
    holdings: pos.slice(0, 15).map((p) => ({
      symbol: p.symbol,
      mint: p.mint,
      value_usd: p.value === null ? null : Math.round(p.value * 100) / 100,
      change_24h_pct: p.change24h ?? null,
    })),
  };
}

// For "sell everything that's down 50%": every holding with its PnL when the
// entry is known.
export async function holdingsWithPnl(wallet, solPrice) {
  const pos = await loadPositions(wallet);
  const fills = allFills(wallet);
  return pos.map((p) => {
    const mine = fills.filter((f) => f.mint === p.mint);
    const priceSol = p.priceNative || (solPrice && p.priceUsd ? p.priceUsd / solPrice : null);
    const s = summarize(mine, p.amount, priceSol);
    // how far the price is from your average entry, in percent
    const fromEntryPct = s && s.avgEntry > 0 && priceSol > 0 ? (priceSol / s.avgEntry - 1) * 100 : null;
    return { ...p, pnlPct: s?.pnlPct ?? null, pnlSol: s?.pnl ?? null, fromEntryPct, known: !!s };
  });
}
