// Live data for the coin lists (Discover and Pulse).
//   - lists come from our cached /api/pump route (GeckoTerminal)
//   - coins on screen refresh from DexScreener every few seconds
//   - brand-new coins and migrations stream in from PumpPortal's free websocket
//   - holder stats come from /api/tokeninfo (Jupiter) when it's available
// Mini charts are drawn from each coin's price changes over the last hour plus
// every price we've seen since the page opened.

import { useEffect, useRef, useState } from 'react';
import { SOL_MINT } from './chain';
import { isPumpCurve } from './format';
import { curveProgress, progressFromReserves, LAUNCH_PRICE_SOL, PUMP_SUPPLY } from './bonding';
import { SETTINGS_EVENT } from './voicebus';

const DS = 'https://api.dexscreener.com';
const FEED_URL = 'wss://pumpportal.fun/api/data';
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const link = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
const text = (s, max = 48) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/* ---------- lists ---------- */

export async function loadLists(names) {
  const r = await fetch(`/api/pump?lists=${names.join(',')}`, { headers: { accept: 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && !j?.lists) throw new Error(j?.error || 'Coin data is unavailable right now');
  return j.lists || {};
}

/* ---------- price history for mini charts ---------- */

const history = new Map(); // mint -> [[time, marketCap], ...]
const HISTORY_MS = 2 * 3600 * 1000;

export function record(mint, mc, t = Date.now()) {
  if (!mint || !(mc > 0)) return;
  const h = history.get(mint) || [];
  const last = h[h.length - 1];
  if (last && t - last[0] < 4000) last[1] = mc;
  else h.push([t, mc]);
  while (h.length && (h.length > 150 || t - h[0][0] > HISTORY_MS)) h.shift();
  history.set(mint, h);
}

// Points for a coin's mini chart: market cap 1h, 30m, 15m and 5m ago (from its
// price changes), its launch price if it's younger than an hour, everything
// seen live, and now.
export function sparkPoints(row, now = Date.now()) {
  const mc = row?.mc;
  if (!(mc > 0)) return [];
  const born = row.createdAt || 0;
  const pts = [];
  const add = (t, v) => {
    if (v > 0 && Number.isFinite(v) && t <= now && (!born || t >= born - 1000)) pts.push([t, v]);
  };
  const back = (mins, pct) => {
    if (pct === null || pct === undefined || !(pct > -100)) return;
    add(now - mins * 60000, mc / (1 + pct / 100));
  };
  back(60, row.chg?.h1);
  back(30, row.chg?.m30);
  back(15, row.chg?.m15);
  back(5, row.chg?.m5);
  if (row.curve && born && now - born < 3600000 && row.priceSol > 0) add(born, (mc * LAUNCH_PRICE_SOL) / row.priceSol);
  for (const [t, v] of history.get(row.mint) || []) add(t, v);
  add(now, mc);
  pts.sort((a, b) => a[0] - b[0]);
  // keep the later of points that land within 15 seconds of each other
  const out = [];
  for (const p of pts) {
    if (out.length && p[0] - out[out.length - 1][0] < 15000) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

/* ---------- DexScreener refresh ---------- */

function windows(o, map) {
  const out = {};
  for (const k of ['m5', 'h1', 'h6', 'h24']) {
    const v = map(o?.[k]);
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

// What DexScreener knows about one coin: its bonding curve pair until it
// graduates, then its most liquid pool.
export function dexPatch(pairs, mint) {
  const own = (Array.isArray(pairs) ? pairs : []).filter((p) => p?.chainId === 'solana' && p.baseToken?.address === mint);
  if (!own.length) return null;
  const curvePair = own.find((p) => isPumpCurve(p.dexId));
  const pools = own.filter((p) => p !== curvePair).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const p = pools.find((x) => (x.liquidity?.usd || 0) > 0) || curvePair || pools[0];
  const info = p.info || curvePair?.info || {};
  const socials = {};
  for (const s of Array.isArray(info.socials) ? info.socials : []) {
    if (s?.type === 'twitter' && link(s.url)) socials.twitter = s.url;
    if (s?.type === 'telegram' && link(s.url)) socials.telegram = s.url;
  }
  const site = Array.isArray(info.websites) ? info.websites.map((w) => link(w?.url)).find(Boolean) : null;
  if (site) socials.website = site;
  const curve = isPumpCurve(p.dexId);
  const priceSol = p.quoteToken?.address === SOL_MINT ? num(p.priceNative) : null;
  return {
    name: text(p.baseToken?.name) || null,
    symbol: text(p.baseToken?.symbol, 16) || null,
    dex: p.dexId || null,
    pool: p.pairAddress || null,
    curve,
    migrated: !!curvePair && !curve,
    pairCreatedAt: num(p.pairCreatedAt),
    priceUsd: num(p.priceUsd),
    priceSol,
    mc: num(p.marketCap) ?? num(p.fdv),
    liq: num(p.liquidity?.usd),
    vol: windows(p.volume, num),
    txns: windows(p.txns, (x) => (x ? { b: num(x.buys) || 0, s: num(x.sells) || 0 } : null)),
    chg: windows(p.priceChange, num),
    image: link(info.imageUrl),
    socials,
    progress: curve ? curveProgress(priceSol) : null,
  };
}

// Merge a list row with its live data and holder stats.
export function liveRow(row, patch, info) {
  let r = row;
  if (patch) {
    r = {
      ...row,
      ...patch,
      name: row.name || patch.name,
      symbol: row.symbol || patch.symbol,
      createdAt: row.createdAt,
      image: row.image || patch.image,
      vol: { ...row.vol, ...patch.vol },
      txns: { ...row.txns, ...patch.txns },
      chg: { ...row.chg, ...patch.chg },
      socials: { ...row.socials, ...patch.socials },
      mc: patch.mc ?? row.mc,
      liq: patch.liq ?? row.liq,
      priceSol: patch.priceSol ?? row.priceSol,
      progress: patch.progress ?? (patch.curve === false ? null : row.progress),
    };
  }
  if (info) {
    r = {
      ...r,
      holders: info.holders,
      top10: info.top10,
      dev: info.dev,
      image: r.image || info.icon,
      socials: { twitter: info.twitter, telegram: info.telegram, website: info.website, ...r.socials },
    };
  }
  return r;
}

// Refreshes the given coins from DexScreener every `every` ms (30 per call),
// reading the latest list each time so new arrivals are picked up on the next
// tick without extra calls.
export function useLive(mints, every = 12000) {
  const ref = useRef(mints);
  ref.current = mints;
  const [patches, setPatches] = useState(() => new Map());
  const enabled = mints.length > 0;

  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    let timer;
    const tick = async () => {
      if (!document.hidden) {
        const list = [...new Set(ref.current.filter((m) => B58.test(m)))].slice(0, 120);
        const found = new Map();
        for (let i = 0; i < list.length && !stop; i += 30) {
          const chunk = list.slice(i, i + 30);
          try {
            const r = await fetch(`${DS}/tokens/v1/solana/${chunk.join(',')}`, { headers: { accept: 'application/json' } });
            if (!r.ok) continue;
            const arr = await r.json();
            for (const m of chunk) {
              const p = dexPatch(arr, m);
              if (p) found.set(m, p);
            }
          } catch {}
        }
        if (!stop && found.size) {
          const t = Date.now();
          for (const [m, p] of found) record(m, p.mc, t);
          const keep = new Set(ref.current);
          setPatches((prev) => {
            const next = new Map();
            for (const [m, p] of prev) if (keep.has(m)) next.set(m, p);
            for (const [m, p] of found) next.set(m, p);
            return next;
          });
        }
      }
      if (!stop) timer = setTimeout(tick, every);
    };
    timer = setTimeout(tick, 400);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [enabled, every]);

  return patches;
}

// Holder stats from /api/tokeninfo, refreshed every minute. Stops asking if
// the server says the source isn't available.
let infoUnavailable = false;

export function useTokenInfo(mints, every = 60000) {
  const ref = useRef(mints);
  ref.current = mints;
  const [info, setInfo] = useState({});
  const enabled = mints.length > 0;

  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    let timer;
    const tick = async () => {
      if (!document.hidden && !infoUnavailable) {
        const list = [...new Set(ref.current.filter((m) => B58.test(m)))].slice(0, 100);
        try {
          const r = await fetch(`/api/tokeninfo?mints=${list.join(',')}`);
          const j = await r.json();
          if (j?.unavailable) infoUnavailable = true;
          if (!stop && j?.info) setInfo((prev) => ({ ...prev, ...j.info }));
        } catch {}
      }
      if (!stop && !infoUnavailable) timer = setTimeout(tick, every);
    };
    timer = setTimeout(tick, 1500);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [enabled, every]);

  return info;
}

/* ---------- coin metadata (image and socials for brand-new coins) ---------- */

const metaCache = new Map();
let metaActive = 0;
const metaQueue = [];

function nextMeta() {
  while (metaActive < 3 && metaQueue.length) {
    const job = metaQueue.shift();
    metaActive++;
    job().finally(() => {
      metaActive--;
      nextMeta();
    });
  }
}

export function coinMeta(uri) {
  if (!link(uri)) return Promise.resolve(null);
  if (!metaCache.has(uri)) {
    metaCache.set(
      uri,
      new Promise((resolve) => {
        metaQueue.push(async () => {
          const ctl = new AbortController();
          const t = setTimeout(() => ctl.abort(), 7000);
          try {
            const r = await fetch(uri, { signal: ctl.signal });
            const j = await r.json();
            resolve({
              image: link(j?.image),
              socials: { twitter: link(j?.twitter), telegram: link(j?.telegram), website: link(j?.website) },
            });
          } catch {
            resolve(null);
          } finally {
            clearTimeout(t);
          }
        });
        nextMeta();
      })
    );
  }
  return metaCache.get(uri);
}

/* ---------- PumpPortal websocket ---------- */

// A list row for a coin created a moment ago.
export function rowFromCreate(m, solPrice) {
  const vSol = num(m.vSolInBondingCurve);
  const vTok = num(m.vTokensInBondingCurve);
  const priceSol = vSol && vTok ? vSol / vTok : num(m.marketCapSol) ? num(m.marketCapSol) / PUMP_SUPPLY : null;
  const mcSol = num(m.marketCapSol) ?? (priceSol ? priceSol * PUMP_SUPPLY : null);
  return {
    mint: m.mint,
    pool: typeof m.bondingCurveKey === 'string' ? m.bondingCurveKey : null,
    dex: 'pumpfun',
    curve: true,
    name: text(m.name) || 'New coin',
    symbol: text(m.symbol, 16),
    image: null,
    uri: link(m.uri),
    createdAt: Date.now(),
    priceSol,
    priceUsd: priceSol && solPrice ? priceSol * solPrice : null,
    mc: mcSol && solPrice ? mcSol * solPrice : null,
    liq: null,
    vol: {},
    txns: {},
    chg: {},
    progress: vTok ? progressFromReserves(vTok) : curveProgress(priceSol),
    devBuySol: num(m.solAmount),
    live: true,
  };
}

// New pump.fun coins and migrations as they happen (both free on PumpPortal).
// One connection per open Pulse page, reconnecting with backoff.
export function usePumpFeed(enabled, handlers) {
  const ref = useRef(handlers);
  ref.current = handlers;
  const [status, setStatus] = useState('off'); // off | connecting | live | retrying

  useEffect(() => {
    if (!enabled || typeof WebSocket === 'undefined') return;
    let ws = null;
    let stopped = false;
    let timer = 0;
    let attempt = 0;

    const schedule = () => {
      if (stopped) return;
      attempt++;
      setStatus('retrying');
      timer = setTimeout(open, Math.min(30000, 1500 * 2 ** Math.min(attempt, 5)));
    };
    function open() {
      setStatus(attempt ? 'retrying' : 'connecting');
      try {
        ws = new WebSocket(FEED_URL);
      } catch {
        schedule();
        return;
      }
      ws.onopen = () => {
        attempt = 0;
        setStatus('live');
        ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
        ws.send(JSON.stringify({ method: 'subscribeMigration' }));
      };
      ws.onmessage = (e) => {
        let m;
        try {
          m = JSON.parse(e.data);
        } catch {
          return;
        }
        if (!m || typeof m !== 'object' || !B58.test(String(m.mint || ''))) return;
        const kind = String(m.txType || m.type || '').toLowerCase();
        if (kind === 'create') {
          if (!m.pool || m.pool === 'pump') ref.current.onCreate?.(m);
        } else if (kind.includes('migrat')) {
          ref.current.onMigrate?.(m);
        }
      };
      ws.onclose = () => schedule();
      ws.onerror = () => {
        try {
          ws.close();
        } catch {}
      };
    }

    open();
    return () => {
      stopped = true;
      clearTimeout(timer);
      if (ws) {
        ws.onclose = null;
        try {
          ws.close();
        } catch {}
      }
      setStatus('off');
    };
  }, [enabled]);

  return status;
}

/* ---------- quick buy amount ---------- */

const QB_KEY = 'yapper:quick-buy';

export function useQuickBuy() {
  const [amount, setAmount] = useState('0.1');
  useEffect(() => {
    const load = () => {
      try {
        const v = localStorage.getItem(QB_KEY);
        if (v && Number(v) > 0) setAmount(v);
      } catch {}
    };
    load();
    // changed by voice ("set quick buy to 0.5") or in another tab
    const onSettings = (e) => {
      if (e.detail?.quickBuy) load();
    };
    const onStorage = (e) => {
      if (e.key === QB_KEY) load();
    };
    window.addEventListener(SETTINGS_EVENT, onSettings);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(SETTINGS_EVENT, onSettings);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  const save = (v) => {
    const clean = String(v).replace(',', '.').replace(/[^0-9.]/g, '').slice(0, 8);
    setAmount(clean);
    try {
      if (Number(clean) > 0) localStorage.setItem(QB_KEY, clean);
    } catch {}
  };
  return [amount, save];
}
