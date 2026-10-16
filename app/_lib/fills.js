// Your trades in a coin, read from the chain: what each trade spent or
// received in SOL and how many coins moved. Because it comes from the chain
// it works on any device and includes trades made in other apps.
//
// A trade's SOL includes every fee (network, priority, PumpPortal, pool),
// but not token-account rent, which you get back when the account closes.
// Parsed transactions never change, so they're cached in this browser.

import { useEffect, useState } from 'react';
import { rpcBatchSettled, getTransactions, txAccountKeys, SOL_MINT } from './chain';
import { loadHolding } from './holdings';
import { rememberCoin } from './known';

const KEY = (w) => `yapper:fills:v1:${w}`;
const MAX_CACHE = 3000;
const SIGS_PER_ACCOUNT = 50;
const MAX_NEW_PER_SYNC = 40;

const caches = new Map(); // wallet -> { sig: fill | 0 }
const listeners = new Set();

function cache(wallet) {
  if (!caches.has(wallet)) {
    let c = {};
    try {
      c = JSON.parse(localStorage.getItem(KEY(wallet)) || '{}') || {};
    } catch {}
    caches.set(wallet, c);
  }
  return caches.get(wallet);
}

function save(wallet) {
  const c = cache(wallet);
  const keys = Object.keys(c);
  if (keys.length > MAX_CACHE) {
    // drop the oldest non-trades first, then the oldest trades
    keys
      .sort((a, b) => (c[a] ? c[a].time : 0) - (c[b] ? c[b].time : 0))
      .slice(0, keys.length - MAX_CACHE)
      .forEach((k) => delete c[k]);
  }
  try {
    localStorage.setItem(KEY(wallet), JSON.stringify(c));
  } catch {}
}

function emit(wallet, mint) {
  for (const fn of listeners) fn(wallet, mint);
}

const rawOf = (b) => {
  try {
    return BigInt(b?.uiTokenAmount?.amount || '0');
  } catch {
    return 0n;
  }
};

// One confirmed transaction -> this wallet's trade in `mint`, or null.
export function parseFill(sig, tx, wallet, mint) {
  const meta = tx?.meta;
  if (!meta || meta.err) return null;
  const keys = txAccountKeys(tx);
  const w = keys.indexOf(wallet);
  if (w < 0) return null;

  const pre = meta.preTokenBalances || [];
  const post = meta.postTokenBalances || [];
  let decimals = null;
  let coin = 0n;
  let wsol = 0n;
  const coinAccounts = new Set();
  for (const [list, sign] of [
    [pre, -1n],
    [post, 1n],
  ]) {
    for (const b of list) {
      if (b.owner !== wallet) continue;
      if (b.mint === mint) {
        coin += sign * rawOf(b);
        coinAccounts.add(b.accountIndex);
        if (decimals === null) decimals = b.uiTokenAmount?.decimals ?? null;
      } else if (b.mint === SOL_MINT) {
        wsol += sign * rawOf(b);
      }
    }
  }
  if (coin === 0n) return null;

  let lamports = (meta.postBalances?.[w] || 0) - (meta.preBalances?.[w] || 0) + Number(wsol);
  // rent for this coin's token accounts isn't a trading cost
  for (const i of coinAccounts) lamports += (meta.postBalances?.[i] || 0) - (meta.preBalances?.[i] || 0);

  const dec = decimals ?? 6;
  const tokens = Number(coin) / 10 ** dec;
  const side = tokens > 0 && lamports < 0 ? 'buy' : tokens < 0 && lamports > 0 ? 'sell' : tokens > 0 ? 'in' : 'out';
  return {
    sig,
    mint,
    side,
    time: (tx.blockTime || Math.floor(Date.now() / 1000)) * 1000,
    tokens, // + received, - sent
    sol: lamports / 1e9, // + received, - spent
    accounts: [...coinAccounts].map((i) => keys[i]).filter(Boolean), // where the coin sits
  };
}

const fetchTxs = getTransactions;

export function cachedFills(wallet, mint) {
  return fillsFor(wallet, mint);
}

function fillsFor(wallet, mint) {
  const c = cache(wallet);
  return Object.values(c)
    .filter((f) => f && f.mint === mint)
    .sort((a, b) => a.time - b.time);
}

// Read this wallet's history in the coin from the chain (only new transactions).
export async function syncFills(wallet, mint, holding) {
  const h = holding || (await loadHolding(wallet, mint));
  const accounts = [...new Set([...(h.accounts || []), ...(h.atas || [])])];
  if (!accounts.length) return fillsFor(wallet, mint);
  const res = await rpcBatchSettled(
    accounts.map((a) => ['getSignaturesForAddress', [a, { limit: SIGS_PER_ACCOUNT, commitment: 'confirmed' }]])
  );
  const c = cache(wallet);
  const sigs = [];
  for (const r of res) {
    if (!r.ok) continue;
    for (const s of r.result || []) {
      if (s?.signature && !s.err && !(s.signature in c) && !sigs.includes(s.signature)) sigs.push(s.signature);
    }
  }
  if (sigs.length) {
    const txs = await fetchTxs(sigs.slice(0, MAX_NEW_PER_SYNC));
    for (const [sig, tx] of txs) {
      const f = parseFill(sig, tx, wallet, mint);
      c[sig] = f || 0;
      if (f?.accounts?.length) rememberCoin(wallet, mint, f.accounts);
    }
    save(wallet);
    emit(wallet, mint);
  }
  return fillsFor(wallet, mint);
}

// Right after a Yapper trade confirms: read it and remember it.
// Returns the fill, or null if the transaction couldn't be read.
export async function recordTrade(wallet, mint, sig) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const tx = (await fetchTxs([sig])).get(sig);
    if (tx) {
      const fill = parseFill(sig, tx, wallet, mint);
      cache(wallet)[sig] = fill || 0;
      if (fill?.accounts?.length) rememberCoin(wallet, mint, fill.accounts);
      save(wallet);
      emit(wallet, mint);
      return fill || { sig, mint, side: 'none', tokens: 0, sol: 0, time: Date.now() };
    }
    await new Promise((r) => setTimeout(r, 1500 + attempt * 1000));
  }
  return null;
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
    const onChange = (w, m) => {
      if (!cancelled && w === wallet && m === mint) setFills(fillsFor(wallet, mint));
    };
    listeners.add(onChange);
    syncFills(wallet, mint)
      .then((f) => !cancelled && setFills(f))
      .catch(() => {});
    return () => {
      cancelled = true;
      listeners.delete(onChange);
    };
  }, [wallet, mint, refreshKey]);
  return fills;
}
