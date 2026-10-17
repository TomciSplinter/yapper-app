// Coin lists for Discover and Pulse (and the coin search), built from
// GeckoTerminal's free API.
//   curve     pump.fun coins still on the bonding curve, with recent trading
//   new       the newest pump.fun coins
//   final     bonding-curve coins close to graduating
//   migrated  coins that graduated to PumpSwap in the last two days
//   top       trending pools across all of Solana
// GeckoTerminal refreshes its free data about once a minute, and every
// upstream call here is cached, so all visitors share the same few calls.

import { curveProgress, FINAL_STRETCH } from '../_lib/bonding';

const GT = 'https://api.geckoterminal.com/api/v2/networks/solana';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SKIP = new Set([
  SOL_MINT,
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);
export const LISTS = ['curve', 'new', 'final', 'migrated', 'top'];
const MIGRATED_WINDOW = 48 * 3600 * 1000;

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function img(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u) && !/missing/i.test(u) ? u : null;
}

export async function gt(path, ttl = 60) {
  const r = await fetch(GT + path, { headers: { accept: 'application/json' }, next: { revalidate: ttl } });
  if (!r.ok) {
    const e = new Error(`GeckoTerminal ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

// GeckoTerminal's ids for pump.fun and PumpSwap. If the usual ids stop
// working, look them up by name in the dex list (cached for a day).
const dexIds = { pump: 'pump-fun', swap: 'pumpswap' };
let lookup = null;

function lookupDexIds() {
  lookup ||= (async () => {
    for (let page = 1; page <= 10; page++) {
      const j = await gt(`/dexes?page=${page}`, 86400).catch(() => null);
      const list = Array.isArray(j?.data) ? j.data : [];
      if (!list.length) break;
      for (const d of list) {
        const name = String(d?.attributes?.name || '').toLowerCase().replace(/[^a-z]/g, '');
        if (name === 'pumpfun') dexIds.pump = d.id;
        if (name === 'pumpswap' || name === 'pumpfunamm') dexIds.swap = d.id;
      }
    }
  })();
  return lookup;
}

async function dexPools(kind, page, sort = 'h24_tx_count_desc') {
  const path = () => `/dexes/${dexIds[kind]}/pools?include=base_token&page=${page}&sort=${sort}`;
  try {
    return await gt(path());
  } catch (e) {
    if (e.status !== 404) throw e;
    const before = dexIds[kind];
    await lookupDexIds();
    if (dexIds[kind] === before) throw e;
    return gt(path());
  }
}

const settle = (promises) => Promise.all(promises.map((p) => p.catch(() => null)));

function windows(o, map) {
  const out = {};
  for (const k of ['m5', 'm15', 'm30', 'h1', 'h6', 'h24']) {
    const v = map(o?.[k]);
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

// One GeckoTerminal pools response -> plain rows.
export function rows(j) {
  if (!Array.isArray(j?.data)) return [];
  const tokens = new Map((j.included || []).filter((x) => x?.type === 'token').map((x) => [x.id, x.attributes || {}]));
  const out = [];
  for (const p of j.data) {
    const a = p?.attributes || {};
    const baseId = p?.relationships?.base_token?.data?.id || '';
    const t = tokens.get(baseId) || {};
    const mint = t.address || baseId.replace(/^solana_/, '');
    if (!mint || SKIP.has(mint)) continue;
    const dex = p?.relationships?.dex?.data?.id || '';
    const curve = dex === dexIds.pump;
    const priceSol = num(a.base_token_price_native_currency);
    const pairName = String(a.name || '').split(' / ')[0];
    out.push({
      mint,
      pool: a.address || null,
      dex,
      curve,
      name: t.name || pairName || 'Unknown',
      symbol: t.symbol || pairName || '',
      image: img(t.image_url),
      createdAt: a.pool_created_at ? Date.parse(a.pool_created_at) || null : null,
      priceUsd: num(a.base_token_price_usd),
      priceSol,
      mc: num(a.market_cap_usd) ?? num(a.fdv_usd),
      liq: num(a.reserve_in_usd),
      vol: windows(a.volume_usd, num),
      // b/s: buys and sells; u: different buyers
      txns: windows(a.transactions, (x) => (x ? { b: num(x.buys) || 0, s: num(x.sells) || 0, u: num(x.buyers) } : null)),
      chg: windows(a.price_change_percentage, num),
      progress: curve ? curveProgress(priceSol) : null,
    });
  }
  return out;
}

function merge(...groups) {
  const seen = new Map();
  for (const g of groups) for (const r of g) if (!seen.has(r.mint)) seen.set(r.mint, r);
  return [...seen.values()];
}

const traded = (r, w) => (r.txns?.[w]?.b || 0) + (r.txns?.[w]?.s || 0) > 0;
const onCurve = (r) => r.curve && (r.progress === null || r.progress < 99.5);

export async function buildLists(wanted) {
  const need = (...names) => names.some((n) => wanted.has(n));
  const curvePages = need('curve', 'final') ? settle([1, 2, 3, 4, 5].map((p) => dexPools('pump', p))) : Promise.resolve([]);
  const hotPages = need('curve', 'final') ? settle([1, 2].map((p) => gt(`/trending_pools?include=base_token&duration=5m&page=${p}`))) : Promise.resolve([]);
  const newPages = need('curve', 'new', 'migrated') ? settle([1, 2, 3].map((p) => gt(`/new_pools?include=base_token&page=${p}`))) : Promise.resolve([]);
  const swapPages = need('migrated') ? settle([1, 2, 3].map((p) => dexPools('swap', p))) : Promise.resolve([]);
  const topPages = need('top') ? settle([1, 2].map((p) => gt(`/trending_pools?include=base_token&page=${p}`))) : Promise.resolve([]);

  const [curveRaw, hotRaw, newRaw, swapRaw, topRaw] = await Promise.all([curvePages, hotPages, newPages, swapPages, topPages]);
  const curveRows = merge(...curveRaw.map(rows), ...hotRaw.map(rows)).filter(onCurve);
  const newRows = merge(...newRaw.map(rows));
  const now = Date.now();
  const lists = {};

  if (wanted.has('curve')) {
    // everything still on the curve that traded in the last hour; Discover filters by market cap
    lists.curve = merge(curveRows, newRows.filter(onCurve)).filter((r) => traded(r, 'h1'));
  }
  if (wanted.has('final')) {
    lists.final = curveRows
      .filter((r) => r.progress !== null && r.progress >= FINAL_STRETCH && traded(r, 'h6'))
      .sort((a, b) => b.progress - a.progress)
      .slice(0, 40);
  }
  if (wanted.has('new')) {
    lists.new = newRows
      .filter(onCurve)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 40);
  }
  if (wanted.has('migrated')) {
    lists.migrated = merge(...swapRaw.map(rows), newRows)
      .filter((r) => r.dex === dexIds.swap && r.createdAt && now - r.createdAt < MIGRATED_WINDOW)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 40);
  }
  if (wanted.has('top')) lists.top = merge(...topRaw.map(rows)).slice(0, 40);

  const failed = [curveRaw, hotRaw, newRaw, swapRaw, topRaw].flat().filter((x) => x === null).length;
  return { lists, failed };
}
