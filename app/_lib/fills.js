// Your position in a coin from your trades on the chain (see history.js):
// average entry, bought, sold, realized and unrealized PnL.

import { useEffect, useState } from 'react';
import { loadHolding } from './holdings';
import { fillsFor, onHistory, syncCoin, recordTrade as record } from './history';

export const recordTrade = record;

export function cachedFills(wallet, mint) {
  return fillsFor(wallet, mint);
}

// Average-cost position summary.
//   held: coins in the wallet now; priceSol: SOL per coin now
export function summarize(fills, held, priceSol) {
  let qty = 0;
  let cost = 0; // SOL still invested in the coins held
  let bought = 0;
  let boughtSol = 0;
  let sold = 0;
  let soldSol = 0;
  let realized = 0;
  const sells = []; // { time, realized } per sell
  for (const f of fills) {
    if (f.side === 'buy') {
      qty += f.tokens;
      cost += -f.sol;
      bought += f.tokens;
      boughtSol += -f.sol;
    } else if (f.side === 'sell') {
      const t = -f.tokens;
      const frac = qty > 0 ? Math.min(1, t / qty) : 0;
      const basis = cost * frac;
      realized += f.sol - basis;
      sells.push({ time: f.time, realized: f.sol - basis, sol: f.sol });
      cost -= basis;
      qty = Math.max(0, qty - t);
      sold += t;
      soldSol += f.sol;
    }
  }
  if (!(bought > 0)) return null;
  const avgEntry = qty > 0 ? cost / qty : boughtSol / bought; // SOL per coin
  const h = Number(held) > 0 ? Number(held) : 0;
  const value = priceSol > 0 ? h * priceSol : null;
  const unrealized = value !== null ? value - avgEntry * h : null;
  const pnl = unrealized !== null ? realized + unrealized : realized;
  return {
    avgEntry,
    bought,
    boughtSol,
    sold,
    soldSol,
    held: h,
    value,
    realized,
    unrealized,
    pnl,
    pnlPct: boughtSol > 0 ? (pnl / boughtSol) * 100 : null,
    sells,
    firstBuy: fills.find((f) => f.side === 'buy')?.time ?? null,
    lastTrade: fills.length ? fills[fills.length - 1].time : null,
  };
}

// fills for the open coin, kept in sync with the chain and with new trades
export function useFills(wallet, mint, refreshKey) {
  const [fills, setFills] = useState([]);
  useEffect(() => {
    if (!wallet || !mint) {
      setFills([]);
      return;
    }
    let cancelled = false;
    setFills(fillsFor(wallet, mint));
    const off = onHistory((w, mints) => {
      if (!cancelled && w === wallet && mints.includes(mint)) setFills(fillsFor(wallet, mint));
    });
    (async () => {
      const h = await loadHolding(wallet, mint);
      const f = await syncCoin(wallet, mint, [...(h.accounts || []), ...(h.atas || [])]);
      if (!cancelled) setFills(f);
    })().catch(() => {});
    return () => {
      cancelled = true;
      off();
    };
  }, [wallet, mint, refreshKey]);
  return fills;
}
