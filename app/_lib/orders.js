// Limit orders, take profit / stop loss and price alerts.
//
// Orders are saved in this browser and run while Yapper is open in a tab:
// one tab (the runner) watches prices every few seconds and executes them;
// other tabs only show them. Every trigger is a market cap with a direction,
// e.g. "buy 0.2 SOL when the market cap falls to $8K".
//
// Kinds:
//   alert  speak up when the market cap crosses the target
//   buy    spend amountSol when it crosses
//   sell   sell percent of the holding when it crosses (take profit above,
//          stop loss below); orders in the same group cancel each other

import { useSyncExternalStore } from 'react';
import { executeTrade } from './trade';
import { loadHolding } from './holdings';
import { getState as walletState, signerKind, openWalletModal } from './wallets';
import { announce } from './voicebus';
import { getQuotes } from './quotes';
import { usd } from './format';

const KEY = 'yapper:orders:v1';
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_ACTIVE = 60;
const KEEP_DONE = 60;
const H = 3600 * 1000;
export const DEFAULT_EXPIRY = { buy: 24 * H, alert: 7 * 24 * H, sell: null };

const EMPTY = [];
let snapshot = EMPTY;
let loaded = false;
const listeners = new Set();

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function ensureLoaded() {
  if (loaded || typeof window === 'undefined') return;
  loaded = true;
  snapshot = read();
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    snapshot = read();
    listeners.forEach((fn) => fn());
  });
  // selling the whole position (anywhere in the app) retires its sell orders,
  // so an old stop loss can't fire on a coin you buy again later
  window.addEventListener('yapper:traded', (e) => {
    const d = e.detail || {};
    if (d.side === 'sell' && d.percent >= 100) {
      cancelOrdersWhere((o) => o.type === 'sell' && o.wallet === d.wallet && o.mint === d.mint, 'Position closed');
    }
  });
}

function write(list) {
  // keep every live order and the most recent finished ones
  const live = list.filter(isLive);
  const done = list.filter((o) => !isLive(o)).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, KEEP_DONE);
  const next = [...live, ...done].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
  snapshot = next;
  listeners.forEach((fn) => fn());
  return next;
}

// read-modify-write against the latest saved list (another tab may have changed it)
function mutate(fn) {
  ensureLoaded();
  const list = read();
  const next = fn(list.map((o) => ({ ...o })));
  return write(Array.isArray(next) ? next : list);
}

export const isLive = (o) => o.status === 'active' || o.status === 'executing';

export function getOrders() {
  ensureLoaded();
  return snapshot;
}

function subscribe(fn) {
  ensureLoaded();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useOrders() {
  return useSyncExternalStore(subscribe, getOrders, () => EMPTY);
}

/* ---------- describing orders ---------- */

export function orderLabel(o) {
  if (o.label) return o.label;
  if (o.type === 'alert') return 'Alert';
  if (o.type === 'buy') return 'Limit buy';
  return o.dir === 'above' ? 'Take profit' : 'Stop loss';
}

export function describeOrder(o, { withCoin = true } = {}) {
  const coin = withCoin ? ` ${o.symbol || 'coin'}` : '';
  const when = `${o.dir === 'below' ? 'falls to' : 'rises to'} ${usd(o.targetMc)} MC`;
  if (o.type === 'alert') return `Alert when${coin} ${when}`;
  if (o.type === 'buy') return `Buy ${o.amountSol} SOL${coin ? ` of${coin}` : ''} when it ${when}`;
  return `Sell ${o.percent}%${coin ? ` of${coin}` : ''} when it ${when}`;
}

/* ---------- targets ---------- */

// Turn a spoken or typed trigger into a market cap and a direction.
//   kind: 'market_cap' (USD) | 'price' (USD per coin) | 'multiple' (x of the
//         base) | 'percent' (change from the base, -30 = 30% lower)
//   dir:  'above' | 'below' | null (decided from the current market cap)
//   base: the market cap multiples and percents are measured from (your
//         entry for sells when it's known, otherwise the current one)
export function resolveTarget({ kind, value, dir }, { mcNow, supply, baseMc }) {
  const v = Number(value);
  if (!Number.isFinite(v)) return { error: 'I need a number for the trigger.' };
  const base = baseMc > 0 ? baseMc : mcNow;
  let target = null;
  if (kind === 'market_cap') target = v;
  else if (kind === 'price') target = supply > 0 ? v * supply : null;
  else if (kind === 'multiple') target = v > 0 ? base * v : null;
  else if (kind === 'percent') target = base * (1 + v / 100);
  if (!(target > 0) || !Number.isFinite(target)) return { error: "That trigger doesn't work for this coin." };
  const d = dir === 'above' || dir === 'below' ? dir : target >= mcNow ? 'above' : 'below';
  return { targetMc: target, dir: d };
}

// already past the trigger?
export function alreadyHit(dir, targetMc, mcNow) {
  return dir === 'below' ? mcNow <= targetMc : mcNow >= targetMc;
}

/* ---------- creating and cancelling ---------- */

const newId = () => `o_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

// o: { wallet, mint, symbol, name?, image?, type, amountSol?, percent?, targetMc, dir,
//      label?, group?, expiresInMs? (null = never), createdMc?, slippage?, prioFee?, source? }
export function createOrder(o) {
  if (!o || !B58.test(o.mint || '')) throw new Error('Unknown coin.');
  if (!['alert', 'buy', 'sell'].includes(o.type)) throw new Error('Unknown order type.');
  if (o.type !== 'alert' && !B58.test(o.wallet || '')) throw new Error('Set up or connect a wallet first.');
  if (!(o.targetMc > 0) || !Number.isFinite(o.targetMc)) throw new Error('Set a market cap to trigger at.');
  if (o.dir !== 'above' && o.dir !== 'below') throw new Error('Set whether it triggers above or below.');
  if (o.type === 'buy' && !(o.amountSol > 0 && o.amountSol <= 100)) throw new Error('Set how much SOL to spend (up to 100).');
  if (o.type === 'sell' && !(o.percent > 0 && o.percent <= 100)) throw new Error('Set what percent to sell (1 to 100).');
  if (getOrders().filter(isLive).length >= MAX_ACTIVE) throw new Error(`You already have ${MAX_ACTIVE} open orders. Cancel some first.`);
  const now = Date.now();
  const expiresIn = o.expiresInMs === undefined ? DEFAULT_EXPIRY[o.type] : o.expiresInMs;
  const order = {
    id: newId(),
    wallet: o.wallet || null,
    mint: o.mint,
    symbol: String(o.symbol || '').slice(0, 16),
    name: String(o.name || '').slice(0, 40),
    image: o.image || null,
    type: o.type,
    label: o.label || null,
    amountSol: o.type === 'buy' ? Math.round(o.amountSol * 1e4) / 1e4 : null,
    percent: o.type === 'sell' ? Math.round(o.percent * 100) / 100 : null,
    targetMc: o.targetMc,
    dir: o.dir,
    group: o.group || null,
    createdMc: o.createdMc || null,
    slippage: o.slippage ?? null,
    prioFee: o.prioFee ?? null,
    source: o.source || 'panel',
    createdAt: now,
    expiresAt: expiresIn ? now + expiresIn : null,
    status: 'active',
    note: null,
  };
  mutate((list) => [...list, order]);
  return order;
}

// Take profit and/or stop loss after a buy; they cancel each other.
//   tp/sl: { kind, value, percent? } as for resolveTarget; entryMc: market cap at the fill
export function createBracket({ wallet, mint, symbol, name, image, entryMc, mcNow, supply, tp, sl, source }) {
  const group = tp && sl ? `g_${Date.now().toString(36)}` : null;
  const made = [];
  for (const [leg, label, dir] of [
    [tp, 'Take profit', 'above'],
    [sl, 'Stop loss', 'below'],
  ]) {
    if (!leg) continue;
    const r = resolveTarget({ kind: leg.kind, value: leg.value, dir }, { mcNow: mcNow || entryMc, supply, baseMc: entryMc });
    if (r.error) continue;
    made.push(
      createOrder({
        wallet, mint, symbol, name, image, type: 'sell', percent: leg.percent || 100,
        targetMc: r.targetMc, dir, label, group, createdMc: entryMc, source,
      })
    );
  }
  return made;
}

// After a buy confirms: place its take profit / stop loss, measured from the
// price the buy actually got (read back from the chain). Returns the orders.
export async function bracketAfterBuy(res, { wallet, mint, symbol, name, image, tp, sl, solPrice, fallbackMc, source }) {
  if (res?.status !== 'ok' || (!tp && !sl)) return [];
  const fill = await Promise.race([res.fill, new Promise((r) => setTimeout(() => r(null), 15000))]);
  const q = (await getQuotes([mint], solPrice).catch(() => new Map())).get(mint);
  let entryMc = q?.mc || fallbackMc;
  if (fill && fill.tokens > 0 && q?.priceSol > 0 && q?.mc) entryMc = q.mc * (Math.abs(fill.sol) / fill.tokens / q.priceSol);
  if (!(entryMc > 0)) return [];
  return createBracket({ wallet, mint, symbol, name, image, entryMc, mcNow: q?.mc || entryMc, supply: q?.supply, tp, sl, source });
}

// "8k", "1.2m", "$45,000" -> 8000, 1200000, 45000
export function parseMc(text) {
  const m = String(text || '').trim().toLowerCase().replace(/[$,\s]/g, '').match(/^(\d*\.?\d+)([kmb])?$/);
  if (!m) return null;
  const v = Number(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : m[2] === 'b' ? 1e9 : 1);
  return v > 0 && Number.isFinite(v) ? v : null;
}

export function cancelOrder(id, note = 'Cancelled') {
  let found = false;
  mutate((list) =>
    list.map((o) => {
      if (o.id !== id || o.status !== 'active') return o;
      found = true;
      return { ...o, status: 'cancelled', note, doneAt: Date.now() };
    })
  );
  return found;
}

// cancels live orders matching pred; returns how many
export function cancelOrdersWhere(pred, note = 'Cancelled') {
  let n = 0;
  mutate((list) =>
    list.map((o) => {
      if (o.status !== 'active' || !pred(o)) return o;
      n++;
      return { ...o, status: 'cancelled', note, doneAt: Date.now() };
    })
  );
  return n;
}

export function clearFinished() {
  mutate((list) => list.filter(isLive));
}

function finish(id, status, extra = {}) {
  mutate((list) => list.map((o) => (o.id === id ? { ...o, status, doneAt: Date.now(), ...extra } : o)));
}

function reactivate(id, extra = {}) {
  mutate((list) => list.map((o) => (o.id === id && o.status === 'executing' ? { ...o, status: 'active', ...extra } : o)));
}

/* ---------- the runner ---------- */

// A timer in a worker: background tabs throttle normal timers to once a minute.
function makeTicker(fn) {
  let worker = null;
  let interval = null;
  try {
    const src = 'let t=null;onmessage=(e)=>{clearInterval(t);t=null;if(e.data>0)t=setInterval(()=>postMessage(0),e.data)}';
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    worker.onmessage = fn;
  } catch {
    worker = null;
  }
  let current = 0;
  return {
    set(ms) {
      if (ms === current) return;
      current = ms;
      if (worker) worker.postMessage(ms);
      else {
        clearInterval(interval);
        interval = ms > 0 ? setInterval(fn, ms) : null;
      }
    },
    stop() {
      worker?.terminate();
      clearInterval(interval);
    },
  };
}

// Only one tab runs orders. Web Locks hand the job to another tab when this
// one closes; without them, a heartbeat in localStorage does the same.
function lead(onLead) {
  let stopped = false;
  let release = null;
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    navigator.locks
      .request('yapper-order-runner', () => {
        if (stopped) return null;
        onLead();
        return new Promise((res) => {
          release = res;
        });
      })
      .catch(() => {});
    return () => {
      stopped = true;
      release?.();
    };
  }
  const HB = 'yapper:orders-runner';
  const me = Math.random().toString(36).slice(2);
  let leading = false;
  const beat = () => {
    if (stopped) return;
    let cur = null;
    try {
      cur = JSON.parse(localStorage.getItem(HB) || 'null');
    } catch {}
    if (!cur || cur.id === me || Date.now() - cur.at > 8000) {
      try {
        localStorage.setItem(HB, JSON.stringify({ id: me, at: Date.now() }));
      } catch {}
      if (!leading) {
        leading = true;
        onLead();
      }
    }
  };
  beat();
  const t = setInterval(beat, 3000);
  return () => {
    stopped = true;
    clearInterval(t);
  };
}

// deps: { getToast, getOnTraded, getSolPrice, extraMints?: () => [mint], onQuotes?: async (quotes) => void, watchEvery?: () => ms }
export function startOrderEngine(deps) {
  ensureLoaded();
  let busy = false;
  let leading = false;
  const noticeAt = new Map(); // order id -> last "can't run yet" notice

  // returns true when it actually spoke up (at most every 10 minutes per order)
  const notice = (o, text) => {
    const last = noticeAt.get(o.id) || 0;
    if (Date.now() - last < 10 * 60 * 1000) return false;
    noticeAt.set(o.id, Date.now());
    announce({ kind: 'order', text, mint: o.mint, symbol: o.symbol, toast: { kind: 'info', title: `${orderLabel(o)} waiting`, detail: text } });
    return true;
  };

  async function fire(o, q) {
    // claim it: only one execution, even if a tick overlaps
    let claimed = false;
    mutate((list) =>
      list.map((x) => {
        if (x.id !== o.id || x.status !== 'active') return x;
        claimed = true;
        return { ...x, status: 'executing', firedAt: Date.now(), firedMc: q.mc };
      })
    );
    if (!claimed) return;
    const sym = o.symbol || q.symbol || 'the coin';

    if (o.type === 'alert') {
      finish(o.id, 'done', { note: `Hit ${usd(q.mc)} MC` });
      announce({
        kind: 'alert',
        text: `${sym} just ${o.dir === 'below' ? 'fell to' : 'hit'} ${usd(q.mc)} market cap.`,
        mint: o.mint,
        symbol: sym,
        toast: { kind: 'info', title: `${sym} alert`, detail: `Market cap ${usd(q.mc)} (your alert: ${usd(o.targetMc)})` },
      });
      return;
    }

    const kind = signerKind(o.wallet);
    if (!kind) {
      reactivate(o.id);
      notice(o, `Your ${orderLabel(o).toLowerCase()} for ${sym} triggered, but its wallet isn't connected. Connect it to run the order.`);
      return;
    }
    if (kind === 'local' && !walletState().unlocked) {
      reactivate(o.id);
      const spoke = notice(o, `Your ${orderLabel(o).toLowerCase()} for ${sym} triggered, but your wallets are locked. Unlock them and it runs right away.`);
      if (spoke && !document.hidden) openWalletModal('unlock');
      return;
    }
    if (o.type === 'sell') {
      let held = null;
      try {
        held = (await loadHolding(o.wallet, o.mint)).amount;
      } catch {
        reactivate(o.id);
        return; // try again next tick
      }
      if (!(held > 0)) {
        finish(o.id, 'cancelled', { note: "You don't hold it anymore" });
        cancelOrdersWhere((x) => x.wallet === o.wallet && x.mint === o.mint && x.type === 'sell', "You don't hold it anymore");
        return;
      }
    }

    announce({
      kind: 'order',
      text:
        o.type === 'buy'
          ? `${orderLabel(o)} for ${sym} triggered at ${usd(q.mc)} market cap. Buying ${o.amountSol} SOL.`
          : `${orderLabel(o)} for ${sym} triggered at ${usd(q.mc)} market cap. Selling ${o.percent}%.`,
      mint: o.mint,
      symbol: sym,
    });
    const toast = deps.getToast();
    const res = await executeTrade({
      wallet: o.wallet,
      mint: o.mint,
      side: o.type,
      amountSol: o.amountSol,
      percent: o.percent,
      symbol: sym,
      slippage: o.slippage ?? undefined,
      prioFee: o.prioFee ?? undefined,
      toast,
      onTraded: deps.getOnTraded(),
    });
    if (res.status === 'ok' || res.status === 'pending') {
      finish(o.id, 'done', { sig: res.sig || null, note: res.status === 'pending' ? 'Sent, still confirming' : `Filled at about ${usd(q.mc)} MC` });
      if (o.group) cancelOrdersWhere((x) => x.group === o.group && x.id !== o.id, 'The other side filled');
      if (o.type === 'sell' && o.percent >= 100) {
        cancelOrdersWhere((x) => x.wallet === o.wallet && x.mint === o.mint && x.type === 'sell', 'Position closed');
      }
    } else if (res.status === 'cancelled') {
      finish(o.id, 'cancelled', { note: 'Rejected in your wallet' });
    } else {
      // a failed trade spent nothing; try again while the price is still past
      // the trigger (stop losses in a fast dump often need a second go)
      const attempts = (o.attempts || 0) + 1;
      if (res.maybeSent) {
        // the send itself errored: it may still have landed, so never send it twice
        finish(o.id, 'failed', { attempts, note: 'The send failed partway. Check your wallet before placing it again.' });
        announce({ kind: 'order', text: `The ${orderLabel(o).toLowerCase()} for ${sym} may not have gone through. Check your wallet.`, mint: o.mint, symbol: sym });
        return;
      }
      if (attempts < (o.type === 'sell' ? 3 : 2)) {
        reactivate(o.id, { attempts, note: `Retrying: ${res.error || 'the trade failed'}` });
        return;
      }
      finish(o.id, 'failed', { sig: res.sig || null, attempts, note: res.error || 'The trade failed' });
      announce({ kind: 'order', text: `The ${orderLabel(o).toLowerCase()} for ${sym} didn't go through. ${res.error || ''}`.trim(), mint: o.mint, symbol: sym });
    }
  }

  async function tick() {
    if (busy || !leading) return;
    busy = true;
    try {
      const now = Date.now();
      // orders left mid-run by a closed tab: never retry a trade blindly
      const stale = getOrders().filter((o) => o.status === 'executing' && now - (o.firedAt || 0) > 3 * 60 * 1000);
      for (const o of stale) finish(o.id, 'failed', { note: 'Interrupted. Check your wallet before placing it again.' });
      // expiry
      const expired = getOrders().filter((o) => o.status === 'active' && o.expiresAt && o.expiresAt <= now);
      for (const o of expired) finish(o.id, 'expired', { note: 'Expired' });

      const live = getOrders().filter((o) => o.status === 'active');
      const extra = deps.extraMints?.() || [];
      const mints = [...new Set([...live.map((o) => o.mint), ...extra])];
      ticker.set(live.length ? 3000 : extra.length ? deps.watchEvery?.() || 15000 : 15000);
      if (!mints.length) return;
      const quotes = await getQuotes(mints, deps.getSolPrice());
      for (const o of live) {
        const q = quotes.get(o.mint);
        if (!q?.mc) continue;
        if (!alreadyHit(o.dir, o.targetMc, q.mc)) continue;
        // re-read: it may have been cancelled meanwhile
        const cur = getOrders().find((x) => x.id === o.id);
        if (cur?.status !== 'active') continue;
        await fire(cur, q);
      }
      if (deps.onQuotes) await deps.onQuotes(quotes);
    } catch {
      // network hiccup: next tick
    } finally {
      busy = false;
    }
  }

  const ticker = makeTicker(() => tick());
  // a new or cancelled order: look right away instead of waiting for the timer
  let kick = null;
  let activeCount = getOrders().filter((o) => o.status === 'active').length;
  const offStore = subscribe(() => {
    const n = getOrders().filter((o) => o.status === 'active').length;
    const grew = n > activeCount;
    activeCount = n;
    if (!leading || kick || !grew) return;
    kick = setTimeout(() => {
      kick = null;
      tick();
    }, 400);
  });
  const stopLead = lead(() => {
    leading = true;
    ticker.set(3000);
    tick();
  });
  return () => {
    leading = false;
    offStore();
    clearTimeout(kick);
    stopLead();
    ticker.stop();
  };
}
