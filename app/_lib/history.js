// This wallet's trades, read from the chain and cached in this browser.
//
// Every transaction the wallet signed (or received coins in) is read once and
// turned into fills: which coin moved, how many, and what it cost or paid in
// SOL. Because it comes from the chain it works on any device and includes
// trades made in other apps.
//
// A trade's SOL includes every fee (network, priority, PumpPortal, pool) but
// not token-account rent, which you get back when the account closes.
// Transactions that move two coins at once (coin-to-coin swaps) are kept,
// but without a SOL price, so they don't distort PnL.

import { rpc, rpcBatchSettled, getTransactions, txAccountKeys, SOL_MINT } from './chain';
import { rememberCoins } from './known';

const KEY = (w) => `yapper:hist:v2:${w}`;
const SCAN_KEY = (w) => `yapper:histscan:v2:${w}`;
const MAX_CACHE = 2500;
const FIRST_SCAN = 25; // first look at a wallet: its latest transactions
const SCAN_EVERY = 15000; // incremental scans at most this often
const SIGS_PER_ACCOUNT = 50;
const MAX_NEW_PER_SYNC = 40;

const caches = new Map(); // wallet -> { sig: [fill, ...] } ([] = not a trade)
const listeners = new Set();

function cache(wallet) {
  if (!caches.has(wallet)) {
    let c = {};
    try {
      // older formats, replaced by this cache
      localStorage.removeItem(`yapper:fills:v1:${wallet}`);
      localStorage.removeItem(`yapper:scanned:v1:${wallet}`);
    } catch {}
    try {
      c = JSON.parse(localStorage.getItem(KEY(wallet)) || '{}') || {};
      if (typeof c !== 'object' || Array.isArray(c)) c = {};
    } catch {}
    caches.set(wallet, c);
  }
  return caches.get(wallet);
}

function save(wallet) {
  const c = cache(wallet);
  const keys = Object.keys(c);
  if (keys.length > MAX_CACHE) {
    const t = (k) => (c[k] && c[k][0] ? c[k][0].time : 0);
    keys
      .sort((a, b) => t(a) - t(b))
      .slice(0, keys.length - MAX_CACHE)
      .forEach((k) => delete c[k]);
  }
  try {
    localStorage.setItem(KEY(wallet), JSON.stringify(c));
  } catch {}
}

// fn(wallet, mints) whenever new fills arrive
export function onHistory(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(wallet, mints) {
  for (const fn of listeners) {
    try {
      fn(wallet, mints);
    } catch {}
  }
}

const rawOf = (b) => {
  try {
    return BigInt(b?.uiTokenAmount?.amount || '0');
  } catch {
    return 0n;
  }
};

// One confirmed transaction -> this wallet's fills (usually one), plus the
// coin accounts it touched: { fills: [...], accounts: [[mint, [addr]]] }.
export function parseTx(sig, tx, wallet) {
  const out = { fills: [], accounts: [] };
  const meta = tx?.meta;
  if (!meta || meta.err) return out;
  const keys = txAccountKeys(tx);
  const w = keys.indexOf(wallet);
  if (w < 0) return out;

  const per = new Map(); // mint -> { raw, dec, idx: Set }
  let wsol = 0n;
  for (const [list, sign] of [
    [meta.preTokenBalances || [], -1n],
    [meta.postTokenBalances || [], 1n],
  ]) {
    for (const b of list) {
      if (b?.owner !== wallet || !b.mint) continue;
      if (b.mint === SOL_MINT) {
        wsol += sign * rawOf(b);
        continue;
      }
      const e = per.get(b.mint) || { raw: 0n, dec: null, idx: new Set() };
      e.raw += sign * rawOf(b);
      e.idx.add(b.accountIndex);
      if (e.dec === null) e.dec = b.uiTokenAmount?.decimals ?? null;
      per.set(b.mint, e);
    }
  }
  for (const [mint, e] of per) out.accounts.push([mint, [...e.idx].map((i) => keys[i]).filter(Boolean)]);

  const changed = [...per].filter(([, e]) => e.raw !== 0n);
  if (!changed.length) return out;
  const time = (tx.blockTime || Math.floor(Date.now() / 1000)) * 1000;
  const lamBase = (meta.postBalances?.[w] || 0) - (meta.preBalances?.[w] || 0) + Number(wsol);

  for (const [mint, e] of changed) {
    const tokens = Number(e.raw) / 10 ** (e.dec ?? 6);
    const accounts = [...e.idx].map((i) => keys[i]).filter(Boolean);
    if (changed.length > 1) {
      out.fills.push({ sig, mint, side: tokens > 0 ? 'in' : 'out', time, tokens, sol: 0, accounts });
      continue;
    }
    let lamports = lamBase;
    // rent for this coin's token accounts isn't a trading cost
    for (const i of e.idx) lamports += (meta.postBalances?.[i] || 0) - (meta.preBalances?.[i] || 0);
    const side = tokens > 0 && lamports < 0 ? 'buy' : tokens < 0 && lamports > 0 ? 'sell' : tokens > 0 ? 'in' : 'out';
    out.fills.push({ sig, mint, side, time, tokens, sol: lamports / 1e9, accounts });
  }
  return out;
}

// Parse and store transactions; returns the mints that had fills.
function absorb(wallet, txs) {
  const c = cache(wallet);
  const mints = new Set();
  const learned = [];
  for (const [sig, tx] of txs) {
    const { fills, accounts } = parseTx(sig, tx, wallet);
    c[sig] = fills;
    for (const f of fills) mints.add(f.mint);
    learned.push(...accounts);
  }
  if (txs.size) {
    rememberCoins(wallet, learned);
    save(wallet);
    emit(wallet, [...mints]);
  }
  return [...mints];
}

export function fillsFor(wallet, mint) {
  const out = [];
  for (const list of Object.values(cache(wallet))) {
    for (const f of list || []) if (f.mint === mint) out.push(f);
  }
  return out.sort((a, b) => a.time - b.time);
}

export function allFills(wallet) {
  const out = [];
  for (const list of Object.values(cache(wallet))) for (const f of list || []) out.push(f);
  return out.sort((a, b) => a.time - b.time);
}

/* ---------- scanning the wallet's own transactions ---------- */

function readScan(wallet) {
  try {
    const v = JSON.parse(localStorage.getItem(SCAN_KEY(wallet)) || 'null');
    if (v && typeof v === 'object') return v;
  } catch {}
  return { newest: null, newestTime: 0, oldest: null, oldestTime: 0, complete: false };
}

function writeScan(wallet, st) {
  try {
    localStorage.setItem(SCAN_KEY(wallet), JSON.stringify(st));
  } catch {}
}

// How far back this browser has read the wallet: { since: ms | null, complete }
export function historyCoverage(wallet) {
  const st = readScan(wallet);
  return { since: st.complete ? 0 : st.oldestTime || null, complete: !!st.complete };
}

const sigTime = (s) => (s?.blockTime ? s.blockTime * 1000 : 0);

async function sigPage(wallet, opts) {
  const res = await rpc('getSignaturesForAddress', [wallet, { limit: 100, commitment: 'confirmed', ...opts }]);
  return Array.isArray(res) ? res : [];
}

async function readNew(wallet, sigs, gapMs = 0) {
  const c = cache(wallet);
  const fresh = [...new Set(sigs.filter((s) => s?.signature && !s.err && !(s.signature in c)).map((s) => s.signature))];
  if (!fresh.length) return [];
  return absorb(wallet, await getTransactions(fresh, { gapMs }));
}

// Newest transactions since the last look (the first look reads the latest 25).
// Throttled; concurrent callers share one run. Returns the mints that moved.
const lastScan = new Map();
const running = new Map();
export function scanWallet(wallet, { force = false } = {}) {
  if (!wallet) return Promise.resolve([]);
  if (running.has(wallet)) return running.get(wallet);
  if (!force && Date.now() - (lastScan.get(wallet) || 0) < SCAN_EVERY) return Promise.resolve([]);
  lastScan.set(wallet, Date.now());
  const job = (async () => {
    const st = readScan(wallet);
    let got = [];
    if (!st.newest) {
      got = (await sigPage(wallet, {})).slice(0, FIRST_SCAN);
      if (got.length) {
        st.oldest = got[got.length - 1].signature;
        st.oldestTime = sigTime(got[got.length - 1]);
        st.complete = got.length < FIRST_SCAN;
      } else {
        st.complete = true;
      }
    } else {
      let before;
      let capped = true;
      for (let page = 0; page < 3; page++) {
        const res = await sigPage(wallet, { until: st.newest, ...(before ? { before } : {}) });
        got.push(...res);
        if (res.length < 100) {
          capped = false;
          break;
        }
        before = res[res.length - 1].signature;
      }
      if (capped && got.length) {
        // too much happened since the last look: continue the backfill from
        // here, so deepScan fills the gap (already-read transactions are skipped)
        st.oldest = got[got.length - 1].signature;
        st.oldestTime = sigTime(got[got.length - 1]);
        st.complete = false;
      }
    }
    if (got.length) {
      st.newest = got[0].signature;
      st.newestTime = sigTime(got[0]) || Date.now();
    }
    const mints = await readNew(wallet, got);
    writeScan(wallet, st);
    return mints;
  })().finally(() => running.delete(wallet));
  running.set(wallet, job);
  return job;
}

// Read further back until `sinceMs` (or `maxTx` transactions), gently.
const deepRunning = new Map();
export function deepScan(wallet, sinceMs, maxTx = 300) {
  if (!wallet) return Promise.resolve();
  if (deepRunning.has(wallet)) return deepRunning.get(wallet);
  const job = (async () => {
    await scanWallet(wallet, { force: true }).catch(() => []);
    const st = readScan(wallet);
    let read = 0;
    while (!st.complete && st.oldest && (!st.oldestTime || st.oldestTime > sinceMs) && read < maxTx) {
      const res = await sigPage(wallet, { before: st.oldest });
      if (!res.length) {
        st.complete = true;
        break;
      }
      await readNew(wallet, res, 1100);
      read += res.length;
      st.oldest = res[res.length - 1].signature;
      st.oldestTime = sigTime(res[res.length - 1]) || st.oldestTime;
      if (res.length < 100) st.complete = true;
      writeScan(wallet, st);
    }
    writeScan(wallet, st);
  })().finally(() => deepRunning.delete(wallet));
  deepRunning.set(wallet, job);
  return job;
}

/* ---------- one coin ---------- */

// The coin's own token accounts' recent transactions (only ones not read yet).
export async function syncCoin(wallet, mint, accounts) {
  const list = [...new Set((accounts || []).filter(Boolean))];
  if (list.length) {
    const res = await rpcBatchSettled(list.map((a) => ['getSignaturesForAddress', [a, { limit: SIGS_PER_ACCOUNT, commitment: 'confirmed' }]]));
    const sigs = [];
    for (const r of res) if (r.ok) sigs.push(...(r.result || []));
    const c = cache(wallet);
    const fresh = sigs.filter((s) => s?.signature && !s.err && !(s.signature in c)).slice(0, MAX_NEW_PER_SYNC);
    await readNew(wallet, fresh);
  }
  return fillsFor(wallet, mint);
}

// Right after a Yapper trade confirms: read it and remember it.
// Returns this coin's fill (side 'none' if the coin didn't move), or null if
// the transaction couldn't be read.
export async function recordTrade(wallet, mint, sig) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const tx = (await getTransactions([sig])).get(sig);
    if (tx) {
      absorb(wallet, new Map([[sig, tx]]));
      const fill = (cache(wallet)[sig] || []).find((f) => f.mint === mint);
      return fill || { sig, mint, side: 'none', tokens: 0, sol: 0, time: Date.now(), accounts: [] };
    }
    await new Promise((r) => setTimeout(r, 1500 + attempt * 1000));
  }
  return null;
}
