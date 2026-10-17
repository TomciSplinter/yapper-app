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

const isCache = (v) => v && typeof v === 'object' && !Array.isArray(v);

// another tab read new transactions: take them in
let listening = false;
function listen() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('storage', (e) => {
    if (!e.key || !e.newValue || !e.key.startsWith('yapper:hist:v2:')) return;
    const wallet = e.key.slice('yapper:hist:v2:'.length);
    const c = caches.get(wallet);
    if (!c) return; // read fresh when first needed
    let next = null;
    try {
      next = JSON.parse(e.newValue);
    } catch {}
    if (!isCache(next)) return;
    const mints = new Set();
    for (const [sig, fills] of Object.entries(next)) {
      if (sig in c || !Array.isArray(fills)) continue;
      c[sig] = fills;
      for (const f of fills) mints.add(f.mint);
    }
    if (mints.size) emit(wallet, [...mints]);
  });
}

function cache(wallet) {
  listen();
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

// Returns false when the browser refused to store it (storage full); the
// wallet then stays "unsaved" and scans don't move forward until it's stored.
const unsaved = new Set();
function save(wallet) {
  const c = cache(wallet);
  // keep what other tabs saved meanwhile
  try {
    const stored = JSON.parse(localStorage.getItem(KEY(wallet)) || '{}');
    if (isCache(stored)) for (const [sig, fills] of Object.entries(stored)) if (!(sig in c) && Array.isArray(fills)) c[sig] = fills;
  } catch {}
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
    unsaved.delete(wallet);
    return true;
  } catch {
    unsaved.add(wallet);
    return false;
  }
}
const stored = (wallet) => !unsaved.has(wallet) || save(wallet);

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
  const time = (tx.blockTime || Math.floor(Date.now() / 1000)) * 1000;
  for (const [mint, e] of per) out.accounts.push([mint, [...e.idx].map((i) => keys[i]).filter(Boolean), time]);

  const changed = [...per].filter(([, e]) => e.raw !== 0n);
  if (!changed.length) return out;
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
    // the network fee (base + priority) when this wallet paid it: part of the
    // cost, but not of the price the swap got
    const fee = w === 0 ? (meta.fee || 0) / 1e9 : 0;
    out.fills.push({ sig, mint, side, time, tokens, sol: lamports / 1e9, fee, accounts });
  }
  return out;
}

// Parse and store transactions: { mints that had fills, saved }
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
  let saved = true;
  if (txs.size) {
    rememberCoins(wallet, learned);
    saved = save(wallet);
    emit(wallet, [...mints]);
  }
  return { mints: [...mints], saved };
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

// Reads the transactions not seen yet: { mints, missing: sigs that didn't
// load (retried on the next scan, up to a few times), saved }
const loadFails = new Map(); // sig -> failed loads this session
async function readNew(wallet, sigs, gapMs = 0) {
  const c = cache(wallet);
  const fresh = [...new Set(sigs.filter((s) => s?.signature && !s.err && !(s.signature in c)).map((s) => s.signature))];
  if (!fresh.length) return { mints: [], missing: [], saved: true };
  const txs = await getTransactions(fresh, { gapMs });
  const { mints, saved } = absorb(wallet, txs);
  const missing = fresh.filter((s) => {
    if (txs.has(s)) return false;
    const n = (loadFails.get(s) || 0) + 1;
    loadFails.set(s, n);
    return n < 4; // after that, give up on it
  });
  return { mints, missing, saved };
}

// the scan may move past `got` (newest first) only up to the oldest
// transaction that failed to load; returns the new `newest` or undefined to
// keep the old one
function newestReadable(got, missing) {
  if (!missing.length) return got[0];
  const miss = new Set(missing);
  let last = -1;
  got.forEach((s, i) => {
    if (miss.has(s.signature)) last = i;
  });
  return last >= 0 && last + 1 < got.length ? got[last + 1] : undefined;
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
    const firstLook = !st.newest;
    const { mints, missing, saved } = await readNew(wallet, got);
    if (got.length) {
      // transactions that failed to load are read again next time
      const upTo = newestReadable(got, missing);
      if (upTo) {
        st.newest = upTo.signature;
        st.newestTime = sigTime(upTo) || Date.now();
      } else if (firstLook) {
        st.newest = null;
      }
    }
    // not stored (storage full): don't remember having read them either
    if (saved && stored(wallet)) writeScan(wallet, st);
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
      const { missing, saved } = await readNew(wallet, res, 1100);
      read += res.length;
      // stop where a transaction failed to load (or storage is full); the next
      // run picks up from there
      if (missing.length || !saved || !stored(wallet)) break;
      st.oldest = res[res.length - 1].signature;
      st.oldestTime = sigTime(res[res.length - 1]) || st.oldestTime;
      if (res.length < 100) st.complete = true;
      writeScan(wallet, st);
    }
    if (st.complete) writeScan(wallet, st);
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
