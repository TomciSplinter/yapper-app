// Everything the orb can talk about, gathered while you speak: the coin
// lists for scans, your PnL, the open coin's safety facts and recent trades.
// It starts when recording starts, so it's usually ready by the time the
// recording is sent.

import { rpc, b64ToBytes, TOKEN_2022_PROGRAM } from './chain';
import { loadLists } from './pump';
import { portfolioSnapshot } from './portfolio';
import { gt, withPool, parseTrades } from './markets';
import { PublicKey } from '@solana/web3.js';

const round = (v, d = 0) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 10 ** d) / 10 ** d);
const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : null);

/* ---------- coin lists (scans) ---------- */

function listRow(r, now) {
  const m5 = r.vol?.m5;
  const h1 = r.vol?.h1;
  return {
    mint: r.mint,
    sym: String(r.symbol || '').slice(0, 14),
    name: String(r.name || '').slice(0, 24),
    mc: round(r.mc),
    liq: round(r.liq),
    age_min: r.createdAt ? Math.max(0, Math.round((now - r.createdAt) / 60000)) : null,
    vol_m5: round(m5),
    vol_h1: round(h1),
    accel: h1 > 0 && m5 >= 0 ? round(m5 / (h1 / 12), 2) : null,
    chg_m5: round(r.chg?.m5, 1),
    chg_h1: round(r.chg?.h1, 1),
    buys_h1: r.txns?.h1?.b ?? null,
    sells_h1: r.txns?.h1?.s ?? null,
    progress: r.progress === null || r.progress === undefined ? null : Math.round(r.progress),
  };
}

let listsCache = { at: 0, data: null };
const listRows = new Map(); // mint -> row, for cards

export function listInfo(mint) {
  return listRows.get(mint) || null;
}

async function scanLists() {
  if (listsCache.data && Date.now() - listsCache.at < 20000) return listsCache.data;
  const lists = await loadLists(['curve', 'final', 'new', 'migrated']);
  const now = Date.now();
  for (const k of Object.keys(lists)) for (const r of lists[k] || []) listRows.set(r.mint, r);
  const byVol = (a, b) => (b.vol?.h1 || 0) - (a.vol?.h1 || 0);
  const data = {
    trending: [...(lists.curve || [])].sort(byVol).slice(0, 30).map((r) => listRow(r, now)),
    final_stretch: (lists.final || []).slice(0, 10).map((r) => listRow(r, now)),
    new_pairs: (lists.new || []).slice(0, 10).map((r) => listRow(r, now)),
    migrated: (lists.migrated || []).slice(0, 10).map((r) => listRow(r, now)),
  };
  listsCache = { at: Date.now(), data };
  return data;
}

/* ---------- safety facts for the open coin ---------- */

const EXT = {
  1: 'transfer fee',
  3: 'mint close authority',
  6: 'accounts frozen by default',
  9: 'non-transferable',
  12: 'permanent delegate (can move anyone’s coins)',
  14: 'transfer hook (custom code on every transfer)',
  26: 'pausable',
};
const NAMES = { 18: 'metadata pointer', 19: 'token metadata', 20: 'group pointer', 21: 'token group', 22: 'group member pointer', 23: 'group member', 25: 'scaled UI amount' };

const u32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;

export function parseMint(acc) {
  if (!acc?.data?.[0]) return null;
  const d = b64ToBytes(acc.data[0]);
  if (d.length < 82) return null;
  const t22 = acc.owner === TOKEN_2022_PROGRAM;
  const risky = [];
  const other = [];
  if (t22 && d.length > 166 && d[165] === 1) {
    let o = 166;
    while (o + 4 <= d.length) {
      const type = d[o] | (d[o + 1] << 8);
      const len = d[o + 2] | (d[o + 3] << 8);
      if (!type) break;
      if (EXT[type]) risky.push(EXT[type]);
      else if (NAMES[type]) other.push(NAMES[type]);
      o += 4 + len;
    }
  }
  return {
    mint_authority: u32(d, 0) === 1 ? `active (${short(new PublicKey(d.slice(4, 36)).toBase58())})` : 'revoked',
    freeze_authority: u32(d, 46) === 1 ? `active (${short(new PublicKey(d.slice(50, 82)).toBase58())})` : 'revoked',
    token_program: t22 ? 'Token-2022' : 'SPL Token',
    risky_extensions: risky,
    other_extensions: other,
  };
}

async function coinSafety(mint) {
  const [acc, info] = await Promise.all([
    rpc('getAccountInfo', [mint, { encoding: 'base64', commitment: 'confirmed' }]).catch(() => null),
    fetch(`/api/tokeninfo?mints=${mint}`)
      .then((r) => r.json())
      .then((j) => j?.info?.[mint] || null)
      .catch(() => null),
  ]);
  return {
    ...(parseMint(acc?.value) || {}),
    dev_holding_pct: info?.dev ?? null,
    holders_count: info?.holders ?? null,
    top10_pct_jupiter: info?.top10 ?? null,
    launchpad: info?.launchpad ?? null,
  };
}

/* ---------- recent trades for the open coin ---------- */

async function recentTrades(mint, pairAddress, supply, wallet, holderOwners) {
  const j = await withPool(mint, pairAddress, (pool) => gt(`/pools/${pool}/trades`));
  const trades = parseTrades(j?.data, mint);
  if (!trades.length) return { trades_seen: 0 };
  const now = Date.now();
  const win = (ms) => trades.filter((t) => now - t.time <= ms);
  const stats = (list) => {
    const b = list.filter((t) => t.side === 'buy');
    const s = list.filter((t) => t.side === 'sell');
    const sum = (x) => round(x.reduce((a, t) => a + (t.usd || 0), 0));
    return { buys: b.length, sells: s.length, buy_usd: sum(b), sell_usd: sum(s) };
  };
  const owners = new Set(holderOwners || []);
  const biggest = win(3600 * 1000)
    .slice()
    .sort((a, b) => (b.usd || 0) - (a.usd || 0))
    .slice(0, 6)
    .map((t) => ({
      side: t.side,
      usd: round(t.usd),
      sol: t.quoteIsSol ? round(t.quoteAmt, 3) : null,
      pct_of_supply: supply > 0 ? round((t.tokenAmt / supply) * 100, 2) : null,
      minutes_ago: Math.round((now - t.time) / 60000),
      trader: short(t.maker),
      is_you: !!wallet && t.maker === wallet,
      is_top_holder: owners.has(t.maker),
    }));
  const oldest = trades[trades.length - 1]?.time;
  return {
    trades_seen: trades.length,
    covers_minutes: oldest ? Math.round((now - oldest) / 60000) : null,
    last_5m: stats(win(5 * 60 * 1000)),
    last_15m: stats(win(15 * 60 * 1000)),
    last_60m: stats(win(60 * 60 * 1000)),
    biggest_last_hour: biggest,
  };
}

/* ---------- gathering it all ---------- */

// inputs: { wallet, mint, pairAddress, supply, solPrice, holderOwners }
// Returns { lists, portfolio, safety, recent_trades } promises, each settling to
// null on failure, so one slow source can't hold up the rest.
export function gatherExtras(inputs) {
  const { wallet, mint, pairAddress, supply, solPrice, holderOwners } = inputs || {};
  const safe = (p) => p.catch(() => null);
  return {
    lists: safe(scanLists()),
    portfolio: wallet ? safe(portfolioSnapshot(wallet, solPrice)) : Promise.resolve(null),
    safety: mint ? safe(coinSafety(mint)) : Promise.resolve(null),
    recent_trades: mint ? safe(recentTrades(mint, pairAddress, supply, wallet, holderOwners)) : Promise.resolve(null),
  };
}

// Wait for the extras, but no longer than `ms` in total: whatever isn't ready is left out.
export async function settleExtras(extras, ms = 2500) {
  if (!extras) return {};
  const timeout = new Promise((r) => setTimeout(() => r(undefined), ms));
  const keys = Object.keys(extras);
  const vals = await Promise.all(keys.map((k) => Promise.race([extras[k], timeout])));
  const out = {};
  keys.forEach((k, i) => {
    if (vals[i] !== undefined && vals[i] !== null) out[k] = vals[i];
  });
  return out;
}
