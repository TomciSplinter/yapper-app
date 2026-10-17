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
//   sell   sell percent of the position when it crosses (take profit above,
//          stop loss below); orders in the same group cancel each other
//
// Never twice: the order list is what the screens show, but whether an order
// may run is decided by its own state record (yapper:order-state:<id>),
// written before anything is sent. A stale copy of the list written by
// another tab can't bring a running or finished order back to life.

import { useSyncExternalStore } from 'react';
import { executeTrade } from './trade';
import { loadHolding } from './holdings';
import { getState as walletState, signerKind, openWalletModal } from './wallets';
import { announce } from './voicebus';
import { getQuotes } from './quotes';
import { signatureStates, blockhashValid } from './chain';
import { fetchSolPrice } from './markets';
import { recordTrade } from './history';
import { usd } from './format';

const KEY = 'yapper:orders:v1';
const STATE = 'yapper:order-state:';
const INTENTS = 'yapper:bracket-intents:v1';
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_ACTIVE = 60;
const KEEP_DONE = 60;
const H = 3600 * 1000;
const DROPPED_MS = 150 * 1000; // a sent trade not seen by then never landed (its blockhash expired)
const EMPTY_CHECK_MS = 30 * 1000;
export const DEFAULT_EXPIRY = { buy: 24 * H, alert: 7 * 24 * H, sell: null };

const LIVE = new Set(['active', 'executing', 'unconfirmed']);
const FINAL = new Set(['done', 'failed', 'cancelled', 'expired']);
export const isLive = (o) => LIVE.has(o.status);

const EMPTY = [];
let snapshot = EMPTY;
let loaded = false;
const listeners = new Set();

class StorageError extends Error {}

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/* ---------- per-order state (the source of truth for running) ---------- */

function getMark(id) {
  try {
    return JSON.parse(localStorage.getItem(STATE + id) || 'null');
  } catch {
    return null;
  }
}

function setMark(id, mark) {
  try {
    localStorage.setItem(STATE + id, JSON.stringify({ ...mark, at: mark.at || Date.now() }));
  } catch {
    throw new StorageError("Couldn't save the order: this browser's storage is full.");
  }
}

function clearMark(id) {
  try {
    localStorage.removeItem(STATE + id);
  } catch {}
}

/* ---------- the list ---------- */

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
  // state records of orders that are gone from the list
  try {
    const ids = new Set(snapshot.map((o) => o.id));
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(STATE) && !ids.has(k.slice(STATE.length))) localStorage.removeItem(k);
    }
  } catch {}
}

function write(list) {
  // keep every live order and the most recent finished ones
  const live = list.filter(isLive);
  const done = list.filter((o) => !isLive(o)).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, KEEP_DONE);
  const next = [...live, ...done].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    throw new StorageError("Couldn't save your orders: this browser's storage is full.");
  }
  const kept = new Set(next.map((o) => o.id));
  for (const o of list) if (!kept.has(o.id)) clearMark(o.id);
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

// for list updates that must not throw (the state record already holds the truth)
function mutateQuietly(fn) {
  try {
    mutate(fn);
  } catch {}
}

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

// "8k", "1.2m", "$45,000" -> 8000, 1200000, 45000
export function parseMc(text) {
  const m = String(text || '').trim().toLowerCase().replace(/[$,\s]/g, '').match(/^(\d*\.?\d+)([kmb])?$/);
  if (!m) return null;
  const v = Number(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : m[2] === 'b' ? 1e9 : 1);
  return v > 0 && Number.isFinite(v) ? v : null;
}

/* ---------- creating and cancelling ---------- */

const rid = () => Math.random().toString(36).slice(2, 7);
const newId = () => `o_${Date.now().toString(36)}${rid()}`;

export function openSlots() {
  return MAX_ACTIVE - getOrders().filter(isLive).length;
}

// o: { wallet, mint, symbol, name?, image?, type, amountSol?, percent?, targetMc, dir,
//      label?, group?, expiresInMs? (null = never), createdMc?, heldAtCreate?, slippage?, prioFee?, source? }
// Throws with a readable message when it can't be placed.
export function createOrder(o) {
  if (!o || !B58.test(o.mint || '')) throw new Error('Unknown coin.');
  if (!['alert', 'buy', 'sell'].includes(o.type)) throw new Error('Unknown order type.');
  if (o.type !== 'alert' && !B58.test(o.wallet || '')) throw new Error('Set up or connect a wallet first.');
  if (!(o.targetMc > 0) || !Number.isFinite(o.targetMc)) throw new Error('Set a market cap to trigger at.');
  if (o.dir !== 'above' && o.dir !== 'below') throw new Error('Set whether it triggers above or below.');
  if (o.type === 'buy' && !(o.amountSol > 0 && o.amountSol <= 100)) throw new Error('Set how much SOL to spend (up to 100).');
  if (o.type === 'sell' && !(o.percent > 0 && o.percent <= 100)) throw new Error('Set what percent to sell (1 to 100).');
  if (openSlots() <= 0) throw new Error(`You already have ${MAX_ACTIVE} open orders. Cancel some first.`);
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
    // a sell never sells more than this share of the position it was made for
    heldAtCreate: o.type === 'sell' && o.heldAtCreate > 0 ? o.heldAtCreate : null,
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

// Take profit and/or stop loss on a position; they cancel each other.
//   tp/sl: { kind, value, percent? } as for resolveTarget; entryMc: market cap at the entry
// Returns { made: [orders], skipped: [reasons] }.
export function createBracket({ wallet, mint, symbol, name, image, entryMc, mcNow, supply, held, tp, sl, source }) {
  const legs = [
    [tp, 'Take profit', 'above'],
    [sl, 'Stop loss', 'below'],
  ].filter(([leg]) => leg);
  const now = mcNow || entryMc;
  const ready = [];
  const skipped = [];
  for (const [leg, label, dir] of legs) {
    const r = resolveTarget({ kind: leg.kind, value: leg.value, dir }, { mcNow: now, supply, baseMc: entryMc });
    if (r.error) skipped.push(`${label}: ${r.error}`);
    // a leg that's already past its trigger would sell at once
    else if (alreadyHit(dir, r.targetMc, now)) skipped.push(`${label} at ${usd(r.targetMc)}: the market cap is already ${dir === 'above' ? 'above' : 'below'} that (${usd(now)})`);
    else ready.push({ leg, label, dir, targetMc: r.targetMc });
  }
  if (ready.length > openSlots()) return { made: [], skipped: [`You already have ${MAX_ACTIVE} open orders. Cancel some first.`] };
  const group = ready.length > 1 ? `g_${Date.now().toString(36)}${rid()}` : null;
  const made = [];
  for (const x of ready) {
    try {
      made.push(
        createOrder({
          wallet, mint, symbol, name, image, type: 'sell', percent: x.leg.percent || 100,
          targetMc: x.targetMc, dir: x.dir, label: x.label, group, createdMc: entryMc, heldAtCreate: held, source,
        })
      );
    } catch (e) {
      skipped.push(`${x.label}: ${e.message}`);
    }
  }
  // half a bracket is worse than none: undo if the second leg failed
  if (group && made.length === 1) {
    cancelOrder(made[0].id, 'The other side could not be placed');
    return { made: [], skipped };
  }
  return { made, skipped };
}

/* ---------- take profit / stop loss after a buy ---------- */

// The plan is saved before the buy is sent, so it survives a closed tab. The
// tab that bought places it once the buy confirms; if that tab is gone (or the
// buy was very slow), the runner does, but only after giving that tab time, so
// it's never placed twice.
const HANDOFF_MS = 5 * 60 * 1000;
const NEVER_LANDED_MS = 10 * 60 * 1000;

function readIntents() {
  try {
    const v = JSON.parse(localStorage.getItem(INTENTS) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function writeIntents(list) {
  try {
    localStorage.setItem(INTENTS, JSON.stringify(list.slice(-20)));
  } catch {}
}
export function saveBracketIntent(intent) {
  const id = `b_${Date.now().toString(36)}${rid()}`;
  writeIntents([...readIntents(), { ...intent, id, at: Date.now() }]);
  return id;
}
function updateIntent(id, patch) {
  writeIntents(readIntents().map((x) => (x.id === id ? { ...x, ...patch } : x)));
}
function dropIntent(id) {
  writeIntents(readIntents().filter((x) => x.id !== id));
}

// Remember the buy's transaction as it's sent.
export function bracketIntentSent(id, sig) {
  if (id && sig) updateIntent(id, { sig, sentAt: Date.now() });
}

// Take a plan for this tab: false when it's gone or another tab has it.
function claimIntent(id) {
  const cur = readIntents().find((x) => x.id === id);
  if (!cur || (cur.taken && Date.now() - cur.taken < HANDOFF_MS)) return false;
  updateIntent(id, { taken: Date.now() });
  return true;
}

// entry market cap from the fill: the swap price (network fee left out), scaled
// to market cap with a fresh quote
export function entryFromFill(fill, q, solPrice) {
  const priceSol = q?.priceSol > 0 ? q.priceSol : q?.priceUsd > 0 && solPrice > 0 ? q.priceUsd / solPrice : null;
  if (!fill || !(fill.tokens > 0) || !(priceSol > 0) || !(q?.mc > 0)) return null;
  const spent = Math.max(0, Math.abs(fill.sol) - (fill.fee || 0));
  return spent > 0 ? q.mc * (spent / fill.tokens / priceSol) : null;
}

async function placeFromFill(fill, { wallet, mint, symbol, name, image, tp, sl, solPrice, fallbackMc, source }) {
  const q = (await getQuotes([mint], solPrice).catch(() => new Map())).get(mint);
  const entryMc = entryFromFill(fill, q, solPrice) || q?.mc || fallbackMc;
  if (!(entryMc > 0)) return { made: [], skipped: ["couldn't read the price"] };
  let held = null;
  try {
    held = (await loadHolding(wallet, mint)).amount;
  } catch {}
  return createBracket({ wallet, mint, symbol, name, image, entryMc, mcNow: q?.mc || entryMc, supply: q?.supply, held, tp, sl, source });
}

const legsText = (made) => made.map((o) => o.label.toLowerCase()).join(' and ');

// After executeTrade: place the take profit / stop loss, measured from the
// price the buy actually got. Waits for a slow confirmation.
// Returns { made, reason, handled, later, buyFailed }: reason says why nothing
// (or not everything) was placed; handled means another tab is on it; later
// means the buy hasn't confirmed yet and they'll be placed if it does;
// buyFailed means the slow buy turned out to have failed.
export async function bracketAfterBuy(res, opts) {
  const { intentId } = opts;
  if (intentId && !claimIntent(intentId)) return { made: [], reason: null, handled: true };
  let keep = false;
  try {
    if (res?.status === 'pending' && res.sig) {
      // not confirmed yet: give it the time a transaction can still land
      const deadline = Date.now() + DROPPED_MS;
      let st = 'unknown';
      while (Date.now() < deadline && (st === 'unknown' || st === 'landing')) {
        await new Promise((r) => setTimeout(r, 4000));
        const states = await signatureStates([res.sig]).catch(() => null);
        if (states) st = states.get(res.sig) || 'unknown';
      }
      if (st === 'failed') return { made: [], reason: 'the buy failed', buyFailed: true };
      if (st !== 'ok') {
        // still not known: the runner keeps checking and places them if it lands
        keep = !!intentId;
        return { made: [], reason: keep ? "the buy hasn't confirmed yet. They'll be set if it goes through" : "the buy wasn't confirmed", later: keep };
      }
      const fill = await recordTrade(opts.wallet, opts.mint, res.sig).catch(() => null);
      const r = await placeFromFill(fill, opts);
      return { made: r.made, reason: r.skipped.join('; ') || null };
    }
    if (res?.status !== 'ok') return { made: [], reason: 'the buy did not go through' };
    const fill = await Promise.race([res.fill, new Promise((r) => setTimeout(() => r(null), 15000))]);
    const r = await placeFromFill(fill, opts);
    return { made: r.made, reason: r.skipped.join('; ') || null };
  } finally {
    if (intentId) {
      if (keep) updateIntent(intentId, { taken: 0 });
      else dropIntent(intentId);
    }
  }
}

// Plans the tab that bought didn't get to (closed, or the buy was slow):
// placed here, and what happened is always said.
async function resumeIntents(solPrice) {
  const tell = (it, text, kind) =>
    announce({ kind: 'order', text, mint: it.mint, symbol: it.symbol, toast: { kind, title: `${it.symbol || 'Your buy'}: take profit / stop loss`, detail: text } });
  for (const it of readIntents()) {
    const buy = it.symbol ? `${it.symbol} buy` : 'buy';
    const forWhat = it.symbol || 'your buy';
    const now = Date.now();
    if (it.taken && now - it.taken < HANDOFF_MS) continue; // a tab is on it
    if (!it.sig) {
      if (now - it.at > NEVER_LANDED_MS) dropIntent(it.id); // never sent
      continue;
    }
    if (now - (it.sentAt || it.at) < HANDOFF_MS) continue; // the tab that bought has it
    const states = await signatureStates([it.sig]).catch(() => null);
    if (!states) continue; // can't tell right now: keep it
    const st = states.get(it.sig) || 'unknown';
    if (st === 'unknown' || st === 'landing') {
      if (st === 'unknown' && Date.now() - (it.sentAt || it.at) > NEVER_LANDED_MS) {
        dropIntent(it.id);
        tell(it, `The ${buy} never confirmed, so no take profit or stop loss was set.`, 'info');
      }
      continue;
    }
    if (!claimIntent(it.id)) continue;
    if (st === 'failed') {
      dropIntent(it.id);
      tell(it, `The ${buy} failed, so no take profit or stop loss was set.`, 'info');
      continue;
    }
    let r;
    try {
      const fill = await recordTrade(it.wallet, it.mint, it.sig).catch(() => null);
      r = await placeFromFill(fill, { ...it, solPrice, source: 'restored' });
    } catch (e) {
      const tries = (it.tries || 0) + 1;
      if (tries < 3) {
        updateIntent(it.id, { taken: 0, tries }); // again next round
        continue;
      }
      r = { made: [], skipped: [String(e?.message || 'something went wrong')] };
    }
    dropIntent(it.id);
    const why = r.skipped.join('; ');
    if (r.made.length && !why) tell(it, `Placed the ${legsText(r.made)} for ${forWhat}.`, 'success');
    else if (r.made.length) tell(it, `Placed the ${legsText(r.made)} for ${forWhat}. Not placed: ${why}.`, 'info');
    else tell(it, `Couldn't place the take profit or stop loss for ${forWhat}: ${why || 'unknown reason'}.`, 'error');
  }
}

/* ---------- cancelling ---------- */

// An order can be cancelled until its trade is sent (the runner checks right
// before sending); after that it's up to the chain. Its own record decides,
// not the list (which another tab may have overwritten with an old copy).
function cancellable(o) {
  const m = getMark(o.id);
  if (m) return m.state === 'retry' || (m.state === 'executing' && !m.sig);
  return isLive(o);
}

export function cancelOrder(id, note = 'Cancelled') {
  const o = read().find((x) => x.id === id);
  if (!o || !cancellable(o)) return false;
  try {
    setMark(id, { state: 'cancelled' });
  } catch {
    return false;
  }
  mutateQuietly((list) => list.map((x) => (x.id === id && isLive(x) ? { ...x, status: 'cancelled', note, doneAt: Date.now() } : x)));
  return true;
}

// cancels live orders matching pred; returns how many
export function cancelOrdersWhere(pred, note = 'Cancelled') {
  let n = 0;
  for (const o of read()) {
    if (pred(o) && cancelOrder(o.id, note)) n++;
  }
  return n;
}

export function clearFinished() {
  mutateQuietly((list) => list.filter(isLive));
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
// one closes; without them, a heartbeat in localStorage does the same, and a
// tab steps down as soon as it sees another tab holding a fresh heartbeat.
function lead(onLead, onLose) {
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
    const mine = cur && cur.id === me;
    const free = !cur || Date.now() - cur.at > 8000;
    if (mine || free) {
      try {
        localStorage.setItem(HB, JSON.stringify({ id: me, at: Date.now() }));
      } catch {}
      if (!leading) {
        leading = true;
        onLead();
      }
    } else if (leading) {
      leading = false;
      onLose();
    }
  };
  beat();
  const t = setInterval(beat, 2000);
  return () => {
    stopped = true;
    clearInterval(t);
  };
}

// deps: { getToast, getOnTraded, getSolPrice, extraMints?: () => [mint], onQuotes?: async (quotes) => void, watchEvery?: () => ms }
export function startOrderEngine(deps) {
  ensureLoaded();
  const me = `t_${Math.random().toString(36).slice(2, 10)}`; // this tab, in the records it claims
  let leading = false;
  let ticking = false;
  let calloutsBusy = false;
  const inflight = new Set(); // ids being executed by this tab
  const holdUntil = new Map(); // id -> no new attempt before this time
  const emptyCheckAt = new Map(); // wallet:mint -> last empty-position check
  const noticeAt = new Map(); // id -> last "can't run yet" notice
  const zeroSince = new Map(); // wallet:mint -> first empty read
  let solPrice = null;
  let solAt = 0;
  let intentsAt = 0;
  let intentsBusy = false;

  // returns true when it actually spoke up (at most every 10 minutes per order)
  const notice = (o, text) => {
    const last = noticeAt.get(o.id) || 0;
    if (Date.now() - last < 10 * 60 * 1000) return false;
    noticeAt.set(o.id, Date.now());
    announce({ kind: 'order', text, mint: o.mint, symbol: o.symbol, toast: { kind: 'info', title: `${orderLabel(o)} waiting`, detail: text } });
    return true;
  };

  const getSol = () => solPrice || deps.getSolPrice();

  const setStatus = (id, status, extra = {}) =>
    mutateQuietly((list) => list.map((o) => (o.id === id ? { ...o, status, ...(FINAL.has(status) ? { doneAt: Date.now() } : {}), ...extra } : o)));

  // Back to waiting for the trigger, without a new attempt for `ms` (unless it
  // was cancelled meanwhile). Only drops a claim that's this tab's, or one left
  // behind by a tab that went away (takeOver).
  const release = (o, ms, extra = {}, { takeOver = false } = {}) => {
    const m = getMark(o.id);
    if (m && FINAL.has(m.state)) return setStatus(o.id, m.state);
    if (m && m.state === 'executing' && !m.sig && (m.owner === me || takeOver)) {
      try {
        if (m.attempts) setMark(o.id, { state: 'retry', attempts: m.attempts });
        else clearMark(o.id);
      } catch {}
    }
    holdUntil.set(o.id, Date.now() + ms);
    setStatus(o.id, 'active', { sig: null, ...extra });
  };

  // A balance can read 0 for a moment (a lagging node): an order only gives up
  // on a position after two empty reads at least 15 seconds apart.
  const reallyEmpty = (wallet, mint, amount) => {
    const k = `${wallet}:${mint}`;
    if (amount > 0) {
      zeroSince.delete(k);
      return false;
    }
    const first = zeroSince.get(k);
    if (!first) zeroSince.set(k, Date.now());
    return !!first && Date.now() - first >= 15000;
  };
  const retireSells = (wallet, mint, note) =>
    cancelOrdersWhere((x) => x.wallet === wallet && x.mint === mint && x.type === 'sell', note);

  const finishDone = (o, sig, note) => {
    try {
      setMark(o.id, { state: 'done', sig });
    } catch {}
    setStatus(o.id, 'done', { sig: sig || null, note });
    if (o.group) cancelOrdersWhere((x) => x.group === o.group && x.mint === o.mint && x.id !== o.id, 'The other side filled');
    if (o.type === 'sell' && o.effectivePercent >= 100) retireSells(o.wallet, o.mint, 'Position closed');
  };

  const finishFailed = (o, note, sig, text) => {
    try {
      setMark(o.id, { state: 'failed', sig });
    } catch {}
    setStatus(o.id, 'failed', { sig: sig || null, note });
    announce({
      kind: 'order',
      text: text || `The ${orderLabel(o).toLowerCase()} for ${o.symbol || 'the coin'} didn't go through. ${note || ''}`.trim(),
      mint: o.mint,
      symbol: o.symbol,
      toast: { kind: 'error', title: `${orderLabel(o)} failed`, detail: note || undefined },
    });
  };

  // A trade that spent nothing: try again while the price is still past the
  // trigger. Sells keep at it longer, backing off (a stop loss mustn't give up
  // after a few seconds of slippage in a crash); buys try twice.
  const MAX_TRIES = { buy: 2, sell: 8 };
  const retryOrFail = (o, note, attempts) => {
    if (attempts < (MAX_TRIES[o.type] || 2)) {
      try {
        setMark(o.id, { state: 'retry', attempts });
      } catch {}
      holdUntil.set(o.id, Date.now() + (o.type === 'sell' ? Math.min(30000, 2000 * 2 ** (attempts - 1)) : 2000));
      setStatus(o.id, 'active', { attempts, sig: null, note: `Retrying: ${note}` });
      if (o.type === 'sell' && attempts === 2) {
        notice(o, `The ${orderLabel(o).toLowerCase()} for ${o.symbol || 'the coin'} didn't fill (${note}). I'll keep trying while the price is past the trigger.`);
      }
    } else {
      finishFailed(o, note);
    }
  };

  async function fire(o) {
    if (inflight.has(o.id)) return;
    // claim it through its own record; a stale list can't override this
    const m = getMark(o.id);
    if (m && m.state !== 'retry') {
      if (FINAL.has(m.state)) setStatus(o.id, m.state);
      return;
    }
    const attempts = m?.attempts || 0;
    try {
      setMark(o.id, { state: 'executing', attempts, owner: me });
    } catch {
      holdUntil.set(o.id, Date.now() + 30000);
      return;
    }
    inflight.add(o.id);
    try {
      setStatus(o.id, 'executing', { firedAt: Date.now() });
      // the price right now, not the one from the start of this check
      const q = (await getQuotes([o.mint], getSol()).catch(() => new Map())).get(o.mint);
      if (!q?.mc || !alreadyHit(o.dir, o.targetMc, q.mc)) return release(o, 3000);
      const sym = o.symbol || q.symbol || 'the coin';

      if (o.type === 'alert') {
        finishDone(o, null, `Hit ${usd(q.mc)} MC`);
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
        notice(o, `Your ${orderLabel(o).toLowerCase()} for ${sym} triggered, but its wallet isn't connected. Connect it to run the order.`);
        return release(o, 15000);
      }
      if (kind === 'local' && !walletState().unlocked) {
        const spoke = notice(o, `Your ${orderLabel(o).toLowerCase()} for ${sym} triggered, but your wallets are locked. Unlock them and it runs right away.`);
        if (spoke && !document.hidden) openWalletModal('unlock');
        return release(o, 5000);
      }

      let percent = o.percent;
      if (o.type === 'sell') {
        let held;
        try {
          held = (await loadHolding(o.wallet, o.mint)).amount;
        } catch {
          return release(o, 10000);
        }
        if (!(held > 0)) {
          if (!reallyEmpty(o.wallet, o.mint, held)) return release(o, 15000);
          try {
            setMark(o.id, { state: 'cancelled' });
          } catch {}
          setStatus(o.id, 'cancelled', { note: "You don't hold it anymore" });
          retireSells(o.wallet, o.mint, "You don't hold it anymore");
          return;
        }
        reallyEmpty(o.wallet, o.mint, held);
        // bought more since the order was made: sell only the original share
        if (o.heldAtCreate > 0 && held > o.heldAtCreate * 1.001) {
          percent = Math.max(1, Math.min(100, Math.floor(((o.percent * o.heldAtCreate) / held) * 100) / 100));
        }
      }

      // cancelled, or taken over by another tab, while we looked?
      const before = getMark(o.id);
      if (before && FINAL.has(before.state)) return setStatus(o.id, before.state);
      if (!before || before.state !== 'executing' || before.owner !== me) return;

      let storageFull = false;
      announce({
        kind: 'order',
        text:
          o.type === 'buy'
            ? `${orderLabel(o)} for ${sym} triggered at ${usd(q.mc)} market cap. Buying ${o.amountSol} SOL.`
            : `${orderLabel(o)} for ${sym} triggered at ${usd(q.mc)} market cap. Selling ${percent}%.`,
        mint: o.mint,
        symbol: sym,
      });
      const res = await executeTrade({
        wallet: o.wallet,
        mint: o.mint,
        side: o.type,
        amountSol: o.amountSol,
        percent,
        symbol: sym,
        slippage: o.slippage ?? undefined,
        prioFee: o.prioFee ?? undefined,
        toast: deps.getToast(),
        onTraded: deps.getOnTraded(),
        // last moment to stop: only this tab's live claim goes out, and the
        // record holds the transaction before it does
        beforeSend: (sig, info) => {
          const cur = getMark(o.id);
          if (!cur || cur.state !== 'executing' || cur.sig || cur.owner !== me) return false;
          try {
            setMark(o.id, { ...cur, sig, sentAt: Date.now(), effectivePercent: percent, blockhash: info?.blockhash || null });
          } catch {
            storageFull = true;
            return false;
          }
          mutateQuietly((list) => list.map((x) => (x.id === o.id ? { ...x, sig } : x)));
          return true;
        },
      });
      const done = { ...o, effectivePercent: percent };
      if (res.status === 'ok') return finishDone(done, res.sig, `Filled at about ${usd(q.mc)} MC`);
      if (res.status === 'pending') {
        // sent but not confirmed: decided on later checks, never sent again
        const cur = getMark(o.id);
        try {
          setMark(o.id, { ...cur, state: 'unconfirmed', sig: res.sig, sentAt: cur?.sentAt || Date.now(), attempts, effectivePercent: percent });
        } catch {}
        return setStatus(o.id, 'unconfirmed', { sig: res.sig || null, note: 'Sent, waiting for confirmation' });
      }
      const cur = getMark(o.id);
      if (res.status === 'cancelled') {
        if (storageFull) {
          announce({ kind: 'order', text: `Couldn't run the ${orderLabel(o).toLowerCase()} for ${sym}: this browser's storage is full.`, mint: o.mint, symbol: sym });
          return release(o, 60000);
        }
        if (cur && FINAL.has(cur.state)) return setStatus(o.id, cur.state); // cancelled by you meanwhile
        if (!cur || cur.state !== 'executing' || cur.sig || cur.owner !== me) return; // another tab has it now
        try {
          setMark(o.id, { state: 'cancelled' });
        } catch {}
        return setStatus(o.id, 'cancelled', { note: 'Rejected in your wallet' });
      }
      // 'failed' (landed, did nothing) or 'error' (never sent): nothing was spent
      if (cur && cur.owner && cur.owner !== me) return; // another tab has it now
      return retryOrFail(o, res.error || 'the trade failed', attempts + 1);
    } finally {
      inflight.delete(o.id);
    }
  }

  // sent orders whose confirmation is still open
  async function settleUnconfirmed(list) {
    const waiting = list.filter((o) => {
      if (inflight.has(o.id)) return false;
      const m = getMark(o.id);
      return m && m.sig && (m.state === 'unconfirmed' || m.state === 'executing');
    });
    if (!waiting.length) return;
    const marks = new Map(waiting.map((o) => [o.id, getMark(o.id)]));
    const states = await signatureStates(waiting.map((o) => marks.get(o.id).sig)).catch(() => null);
    if (!states) return;
    for (const o of waiting) {
      const m = marks.get(o.id);
      const now = getMark(o.id);
      if (!now || now.sig !== m.sig || FINAL.has(now.state)) continue; // settled meanwhile
      const st = states.get(m.sig) || 'unknown';
      const sym = o.symbol || 'the coin';
      if (st === 'ok') {
        finishDone({ ...o, effectivePercent: m.effectivePercent ?? o.percent }, m.sig, 'Filled');
        recordTrade(o.wallet, o.mint, m.sig)
          .catch(() => null)
          .finally(() => deps.getOnTraded()?.());
        announce({
          kind: 'order',
          text: `The ${orderLabel(o).toLowerCase()} for ${sym} went through.`,
          mint: o.mint,
          symbol: o.symbol,
          toast: { kind: 'success', title: `${orderLabel(o)} filled`, detail: `${sym}: the trade confirmed.` },
        });
      } else if (st === 'failed') {
        retryOrFail(o, 'the trade failed on chain', (m.attempts || 0) + 1);
      } else if (st === 'unknown') {
        const age = Date.now() - (m.sentAt || m.at || 0);
        if (age < DROPPED_MS) continue;
        // only tried again once it can never land: its blockhash has expired
        let gone = null;
        if (m.blockhash) gone = await blockhashValid(m.blockhash).then((ok) => !ok, () => null);
        else if (age > 5 * 60 * 1000) gone = true; // no blockhash on record: by time alone
        if (gone === true) retryOrFail(o, 'the network dropped the trade', (m.attempts || 0) + 1);
        else if (gone === null && age > 10 * 60 * 1000) {
          finishFailed(o, "Couldn't confirm whether it went through", m.sig, `I couldn't confirm whether the ${orderLabel(o).toLowerCase()} for ${sym} went through. Check your wallet before trying again.`);
        }
      }
      // 'landing': in a block and confirming: keep waiting
    }
  }

  // sell orders for a position that's gone (sold elsewhere, e.g. in another app)
  async function retireEmpty(list) {
    const sells = list.filter((o) => o.type === 'sell' && waitingForTrigger(o));
    const seen = new Set();
    for (const o of sells) {
      const k = `${o.wallet}:${o.mint}`;
      if (seen.has(k) || Date.now() - (emptyCheckAt.get(k) || 0) < EMPTY_CHECK_MS) continue;
      seen.add(k);
      emptyCheckAt.set(k, Date.now());
      try {
        const h = await loadHolding(o.wallet, o.mint);
        if (reallyEmpty(o.wallet, o.mint, h.amount)) retireSells(o.wallet, o.mint, 'Position closed');
        else if (!(h.amount > 0)) emptyCheckAt.set(k, Date.now() - EMPTY_CHECK_MS + 16000); // look again soon
      } catch {}
    }
  }

  // waiting for its trigger, by its own record (the list's status is only what
  // you see, and a failed or stale list write mustn't stop an order)
  const waitingForTrigger = (o) => {
    if (!isLive(o) || inflight.has(o.id)) return false;
    const m = getMark(o.id);
    return !m || m.state === 'retry';
  };

  // the list (what you see) catches up with each order's own record
  function reconcile(now) {
    for (const o of getOrders().filter(isLive)) {
      if (inflight.has(o.id)) continue;
      const m = getMark(o.id);
      if (m && FINAL.has(m.state)) {
        if (o.status !== m.state) setStatus(o.id, m.state);
      } else if (m && m.state === 'unconfirmed') {
        if (o.status !== 'unconfirmed') setStatus(o.id, 'unconfirmed', { sig: m.sig });
      } else if (!m || m.state === 'retry') {
        // waiting for its trigger (a list write failed, or an old copy came in)
        if (o.status !== 'active') setStatus(o.id, 'active', { sig: null });
      } else if (m.state === 'executing' && m.sig) {
        if (o.status === 'active') setStatus(o.id, 'executing', { sig: m.sig });
      } else if (m.state === 'executing' && now - (m.at || 0) > 3 * 60 * 1000) {
        // claimed by a tab that went away before sending: free again
        release(o, 0, { note: 'Interrupted before sending; waiting again' }, { takeOver: true });
      }
    }
  }

  async function tick() {
    if (ticking || !leading) return;
    ticking = true;
    try {
      const now = Date.now();
      if (now - solAt > 60000) {
        solAt = now;
        fetchSolPrice()
          .then((p) => {
            if (p > 0) solPrice = p;
          })
          .catch(() => {});
      }
      reconcile(now);
      await settleUnconfirmed(getOrders().filter(isLive));
      // expiry (never while it's running or sent)
      for (const o of getOrders().filter((x) => waitingForTrigger(x) && x.expiresAt && x.expiresAt <= now)) {
        try {
          setMark(o.id, { state: 'expired' });
        } catch {}
        setStatus(o.id, 'expired', { note: 'Expired' });
      }
      await retireEmpty(getOrders());
      if (now - intentsAt > 60000 && !intentsBusy) {
        intentsAt = now;
        intentsBusy = true;
        resumeIntents(getSol())
          .catch(() => {})
          .finally(() => {
            intentsBusy = false;
          });
      }

      const live = getOrders().filter(waitingForTrigger);
      const extra = deps.extraMints?.() || [];
      const mints = [...new Set([...live.map((o) => o.mint), ...extra])];
      ticker.set(live.length || getOrders().some((o) => isLive(o) && o.status !== 'active') ? 3000 : extra.length ? deps.watchEvery?.() || 15000 : 15000);
      if (!mints.length) return;
      const quotes = await getQuotes(mints, getSol());
      for (const o of live) {
        const q = quotes.get(o.mint);
        if (!q?.mc || !alreadyHit(o.dir, o.targetMc, q.mc)) continue;
        if ((holdUntil.get(o.id) || 0) > Date.now()) continue;
        // each order runs on its own: one waiting for a wallet popup doesn't hold up the rest
        fire(o).catch(() => {});
      }
      if (deps.onQuotes && !calloutsBusy) {
        calloutsBusy = true;
        Promise.resolve(deps.onQuotes(quotes))
          .catch(() => {})
          .finally(() => {
            calloutsBusy = false;
          });
      }
    } catch {
      // network hiccup: next tick
    } finally {
      ticking = false;
    }
  }

  const ticker = makeTicker(() => tick());
  // a new order: look right away instead of waiting for the timer
  let kick = null;
  const knownIds = new Set(getOrders().map((o) => o.id));
  const offStore = subscribe(() => {
    let fresh = false;
    for (const o of getOrders()) {
      if (!knownIds.has(o.id)) {
        knownIds.add(o.id);
        if (o.status === 'active') fresh = true;
      }
    }
    if (!leading || kick || !fresh) return;
    kick = setTimeout(() => {
      kick = null;
      tick();
    }, 400);
  });
  const stopLead = lead(
    () => {
      leading = true;
      ticker.set(3000);
      tick(); // also places take profits / stop losses left by a closed tab
    },
    () => {
      leading = false;
      ticker.set(0);
    }
  );
  return () => {
    leading = false;
    offStore();
    clearTimeout(kick);
    stopLead();
    ticker.stop();
  };
}
