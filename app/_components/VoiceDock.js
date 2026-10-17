'use client';

// The orb. Hold it (or hold Space) and talk; release to send. A quick tap
// starts listening and a second tap sends. Hands-free mode listens for
// "Yapper". Anything that spends or sells shows a confirm card first and only
// runs after "yes" or a tap on Confirm.
//
// While you speak, the orb gathers what it may need to answer (coin lists for
// scans, your PnL, the open coin's safety facts and recent trades), and keeps
// the last few exchanges so follow-ups like "open the second one" work.

import { useCallback, useEffect, useRef, useState } from 'react';
import { extractMint, rpc, SOL_MINT } from '../_lib/chain';
import { fetchPair, fetchPairs } from '../_lib/markets';
import { executeTrade, saveTradeSettings } from '../_lib/trade';
import { loadHolding } from '../_lib/holdings';
import { signerKind } from '../_lib/wallets';
import { cachedFills, summarize } from '../_lib/fills';
import { holdingsWithPnl } from '../_lib/portfolio';
import {
  getOrders,
  isLive,
  createOrder,
  bracketAfterBuy,
  cancelOrder,
  cancelOrdersWhere,
  resolveTarget,
  alreadyHit,
  describeOrder,
  orderLabel,
  DEFAULT_EXPIRY,
} from '../_lib/orders';
import { getQuotes } from '../_lib/quotes';
import { useVoicePrefs, getPrefs, setPrefs, onAnnounce, settingsChanged } from '../_lib/voicebus';
import { speak as speakOut, stopSpeaking, onSpeaking, unlockAudio, installAudioUnlock } from '../_lib/speech';
import { createWake, wakeSupported } from '../_lib/wake';
import { gatherExtras, settleExtras, listInfo } from '../_lib/voicecontext';
import { amount as fmtAmount, sol as fmtSol, usd } from '../_lib/format';
import { Icon } from './Icons';
import { PendingCard, CoinCards, VoiceSettings } from './VoiceParts';

const MAX_MS = 15000;
const TAP_MS = 350;
const HISTORY_MS = 10 * 60 * 1000;
const QB_KEY = 'yapper:quick-buy';

const norm = (s) => String(s || '').toLowerCase().replace(/^\$/, '').replace(/[^a-z0-9]/g, '');
const r4 = (v) => Math.round(v * 1e4) / 1e4;

function pickMime() {
  if (typeof window === 'undefined' || !window.MediaRecorder) return '';
  const opts = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return opts.find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
}

function extFor(type) {
  if (/mp4|m4a|aac/.test(type)) return 'm4a';
  if (/ogg/.test(type)) return 'ogg';
  return 'webm';
}

function readQuickBuy() {
  try {
    const v = localStorage.getItem(QB_KEY);
    return v && Number(v) > 0 ? v : '0.1';
  } catch {
    return '0.1';
  }
}

const legText = (leg) => (leg.kind === 'multiple' ? `${leg.value}x` : leg.kind === 'percent' ? `${leg.value}%` : `${usd(leg.value)}`);

function pendingText(p) {
  if (!p) return null;
  if (p.kind === 'order') return `${p.label}: ${p.side === 'buy' ? `buy ${p.amountSol} SOL` : `sell ${p.percent}%`} of ${p.symbol} when MC ${p.dir === 'below' ? 'falls to' : 'rises to'} ${usd(p.targetMc)}`;
  if (p.kind === 'sell_many') return `Sell ${p.percent}% of ${p.items.map((i) => i.symbol).join(', ')}`;
  const extra = [p.tp && `take profit ${legText(p.tp)}`, p.sl && `stop loss ${legText(p.sl)}`].filter(Boolean).join(', ');
  return `${p.side === 'buy' ? `Buy ${p.amountSol} SOL of` : `Sell ${p.percent}% of`} ${p.symbol}${extra ? ` with ${extra}` : ''}`;
}

export default function VoiceDock({ getContext, getInputs, openToken, navigate, wallet, connect, solBal, solPrice, toast, onTraded, onQuickBuy }) {
  const prefs = useVoicePrefs();
  const [phase, setPhaseRaw] = useState('idle'); // idle | starting | listening | wake | thinking | reply | error
  const [tapMode, setTapMode] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [reply, setReply] = useState('');
  const [pending, setPendingState] = useState(null);
  const [cards, setCards] = useState([]);
  const [extra, setExtra] = useState(null); // { type: 'copy' | 'share', ... }
  const [open, setOpen] = useState(false);
  const [view, setView] = useState('main'); // main | settings
  const [typed, setTyped] = useState('');
  const [speaking, setSpeaking] = useState(false);
  const [wakeState, setWakeState] = useState('off');
  const [wakeOk, setWakeOk] = useState(false);

  const orbRef = useRef(null);
  const recRef = useRef(null);
  const phaseRef = useRef('idle');
  const pendingRef = useRef(null);
  const stopAfterStart = useRef(false);
  const press = useRef({ t: 0, ignoreUp: false });
  const closeTimer = useRef(null);
  const wakeTimer = useRef(null);
  const extrasRef = useRef(null);
  const historyRef = useRef([]);
  const turnRef = useRef({ reply: '', coin: null, listed: [] });
  const wakeRef = useRef(null);
  const queueRef = useRef(Promise.resolve());
  const genRef = useRef(0);
  const sendRef = useRef(null);
  const speakingRef = useRef(false);

  const setPhase = useCallback((p) => {
    phaseRef.current = p;
    setPhaseRaw(p);
  }, []);

  const setPending = useCallback((p) => {
    pendingRef.current = p;
    setPendingState(p);
    wakeRef.current?.expectReply(!!p);
  }, []);

  useEffect(() => {
    installAudioUnlock();
    setWakeOk(wakeSupported());
    return onSpeaking(setSpeaking);
  }, []);

  /* ---------- speech out ---------- */

  // replies interrupt; announcements wait their turn
  const talk = useCallback((text, lang = 'en', { interrupt = true } = {}) => {
    const p = getPrefs();
    if (p.muted || !text) return;
    if (interrupt) {
      genRef.current++;
      stopSpeaking();
      queueRef.current = Promise.resolve();
    }
    const gen = genRef.current;
    const run = () => (gen === genRef.current ? speakOut(text, { lang, natural: getPrefs().natural }) : undefined);
    queueRef.current = queueRef.current.then(run, run);
  }, []);

  const scheduleClose = useCallback(
    (ms) => {
      clearTimeout(closeTimer.current);
      if (ms) {
        closeTimer.current = setTimeout(() => {
          if (!pendingRef.current && (phaseRef.current === 'reply' || phaseRef.current === 'error')) {
            setOpen(false);
            setPhase('idle');
          }
        }, ms);
      }
    },
    [setPhase]
  );

  const say = useCallback(
    (text, lang = 'en') => {
      turnRef.current.reply = text || '';
      setReply(text || '');
      setPhase('reply');
      setOpen(true);
      talk(text, lang);
      scheduleClose(pendingRef.current ? 0 : 12000);
    },
    [setPhase, talk, scheduleClose]
  );

  const fail = useCallback(
    (text) => {
      turnRef.current.reply = text;
      setReply(text);
      setPhase('error');
      setOpen(true);
      talk(text);
      scheduleClose(10000);
    },
    [setPhase, talk, scheduleClose]
  );

  // the model's reply in the user's language, or our exact English wording
  const pickText = (cmd, english) => (cmd.lang && cmd.lang !== 'en' && cmd.reply ? cmd.reply : english);

  /* ---------- messages from orders, alerts, callouts and trades ---------- */

  useEffect(
    () =>
      onAnnounce((m) => {
        if (m.toast) toast.show({ kind: m.toast.kind || 'info', title: m.toast.title, detail: m.toast.detail, autoClose: 10000 });
        if (m.kind !== 'trade') {
          const busy = pendingRef.current || ['starting', 'listening', 'wake', 'thinking'].includes(phaseRef.current);
          if (!busy) {
            setTranscript('');
            setCards([]);
            setExtra(null);
            setView('main');
            setReply(m.text);
            setPhase('reply');
            setOpen(true);
            scheduleClose(12000);
          }
        }
        talk(m.text, m.lang || 'en', { interrupt: false });
      }),
    [toast, talk, setPhase, scheduleClose]
  );

  /* ---------- context ---------- */

  const beginExtras = useCallback(() => {
    const inputs = getInputs?.() || {};
    const cur = extrasRef.current;
    if (cur && Date.now() - cur.at < 15000 && cur.mint === inputs.mint && cur.wallet === inputs.wallet) return;
    extrasRef.current = { at: Date.now(), mint: inputs.mint || null, wallet: inputs.wallet || null, data: gatherExtras(inputs) };
  }, [getInputs]);

  const buildContext = useCallback(
    async (waitMs) => {
      beginExtras();
      const ex = await settleExtras(extrasRef.current?.data, waitMs);
      const ctx = getContext();
      const p = getPrefs();
      let ts = {};
      try {
        ts = JSON.parse(localStorage.getItem('yapper:trade-settings') || '{}') || {};
      } catch {}
      return {
        ...ctx,
        coin: ctx.coin ? { ...ctx.coin, safety: ex.safety || null, recent_trades: ex.recent_trades || null } : null,
        pending: pendingRef.current ? { kind: pendingRef.current.kind, text: pendingText(pendingRef.current) } : null,
        orders: getOrders()
          .filter(isLive)
          .slice(0, 20)
          .map((o) => ({ id: o.id, coin: o.symbol, mint: o.mint, label: orderLabel(o), text: describeOrder(o) })),
        portfolio: ex.portfolio || null,
        lists: ex.lists || null,
        settings: {
          slippage_pct: Number(ts.slippage) || 10,
          priority_fee_sol: Number(ts.prioFee) || 0.0005,
          quick_buy_sol: Number(readQuickBuy()),
          spoken_replies: !p.muted,
          natural_voice: p.natural,
          wake_word: p.wake,
          callouts: p.callouts,
          trade_summaries: p.speakTrades,
        },
      };
    },
    [beginExtras, getContext]
  );

  /* ---------- coins ---------- */

  const remember = (coin) => {
    if (coin) turnRef.current.coin = { mint: coin.mint, symbol: coin.symbol || '' };
    return coin;
  };

  const resolveCoin = useCallback(
    async (cmd) => {
      const ctx = getContext();
      const cur = ctx.coin?.mint ? { mint: ctx.coin.mint, symbol: ctx.coin.symbol, name: ctx.coin.name, imageUrl: ctx.coin.image } : null;
      if (cmd.coin_is_current || !cmd.coin) return remember(cur);
      if (cur && norm(cmd.coin) && (norm(cmd.coin) === norm(cur.symbol) || norm(cmd.coin) === norm(cur.name))) return remember(cur);
      const m = extractMint(cmd.coin);
      if (m) {
        const li = listInfo(m);
        if (li) return remember({ mint: m, symbol: li.symbol || '', name: li.name || '', imageUrl: li.image || null });
        const p = await fetchPair(m).catch(() => null);
        return remember({ mint: m, symbol: p?.baseToken?.symbol || '', name: p?.baseToken?.name || '', imageUrl: p?.info?.imageUrl || null });
      }
      // a coin from your orders or recent answers, by ticker
      const o = getOrders().find((x) => norm(x.symbol) && norm(x.symbol) === norm(cmd.coin));
      if (o) return remember({ mint: o.mint, symbol: o.symbol, name: o.name, imageUrl: o.image });
      for (const t of [...historyRef.current].reverse()) {
        const hit = [t.coin, ...(t.listed || [])].find((c) => c && norm(c.symbol) && norm(c.symbol) === norm(cmd.coin));
        if (hit) return resolveCoin({ coin: hit.mint });
      }
      const r = await fetch(`/api/search?q=${encodeURIComponent(cmd.coin)}`);
      const j = await r.json().catch(() => ({}));
      const t = j?.results?.[0];
      return remember(t ? { mint: t.mint, symbol: t.symbol, name: t.name, imageUrl: t.imageUrl } : null);
    },
    [getContext]
  );

  const quoteOf = useCallback(async (mint) => (await getQuotes([mint], solPrice).catch(() => new Map())).get(mint) || null, [solPrice]);

  // your average entry as a market cap, when your trades are known
  const entryMcOf = useCallback(
    (mint, q) => {
      if (!wallet || !q?.supply || !solPrice) return null;
      const s = summarize(cachedFills(wallet, mint), 1, null);
      return s && s.avgEntry > 0 ? s.avgEntry * solPrice * q.supply : null;
    },
    [wallet, solPrice]
  );

  const showCards = useCallback(async (mints) => {
    const list = [...new Set(mints)].slice(0, 5);
    const base = list.map((m) => {
      const li = listInfo(m);
      return { mint: m, symbol: li?.symbol || '', name: li?.name || '', image: li?.image || null, mc: li?.mc ?? null, chg: li?.chg?.h1 ?? null };
    });
    turnRef.current.listed = base.map((c) => ({ mint: c.mint, symbol: c.symbol }));
    setCards(base);
    const missing = base.filter((c) => !c.symbol).map((c) => c.mint);
    if (missing.length) {
      const pairs = await fetchPairs(missing).catch(() => new Map());
      setCards((cur) =>
        cur.map((c) => {
          const p = pairs.get(c.mint);
          return p
            ? { ...c, symbol: p.baseToken?.symbol || c.symbol, name: p.baseToken?.name || c.name, image: p.info?.imageUrl || c.image, mc: p.marketCap ?? p.fdv ?? c.mc, chg: p.priceChange?.h1 ?? c.chg }
            : c;
        })
      );
    }
  }, []);

  /* ---------- trades now ---------- */

  const prepareTrade = useCallback(
    async (cmd) => {
      const side = cmd.action;
      if (!wallet) {
        connect();
        return fail('Set up or connect a wallet first, then say it again.');
      }
      const coin = await resolveCoin(cmd);
      if (!coin) return fail(cmd.coin ? `I couldn't find a Solana coin called ${cmd.coin}.` : 'Open a coin first, or say which coin you mean.');
      const ctx = getContext();
      if (coin.mint !== ctx.coin?.mint) openToken(coin.mint, side);
      const pair = await fetchPair(coin.mint).catch(() => null);
      const sym = coin.symbol || pair?.baseToken?.symbol || 'this coin';
      const quoteIsSol = pair?.quoteToken?.address === SOL_MINT;
      const pn = Number(pair?.priceNative);
      const pu = Number(pair?.priceUsd);
      const mc = pair?.marketCap ?? pair?.fdv ?? null;
      const card = { kind: 'trade', side, mint: coin.mint, symbol: sym, name: coin.name || pair?.baseToken?.name || '', imageUrl: coin.imageUrl || pair?.info?.imageUrl || null, marketCap: mc };

      if (side === 'buy') {
        let amt = cmd.amount_sol ?? (cmd.amount_usd && solPrice ? cmd.amount_usd / solPrice : null);
        if (!amt) return say(`How much SOL should I spend on ${sym}? For example, buy 0.5 SOL.`);
        amt = r4(amt);
        if (solBal !== null && amt > solBal) {
          // the shown balance can lag a fresh deposit, so ask the chain before saying no
          const fresh = await rpc('getBalance', [wallet, { commitment: 'confirmed' }])
            .then((b) => b.value / 1e9)
            .catch(() => solBal);
          if (amt > fresh) return fail(`Not enough SOL. You have ${fmtSol(fresh)} SOL.`);
        }
        // take profit above the entry, stop loss below it; anything else is dropped
        const okTp = (l) => l && l.value !== null && (l.kind === 'multiple' ? l.value > 1 : l.kind === 'percent' ? l.value > 0 : !mc || l.value > mc);
        const okSl = (l) => l && l.value !== null && (l.kind === 'multiple' ? l.value < 1 : l.kind === 'percent' ? l.value < 0 && l.value > -100 : !mc || l.value < mc);
        const tp = cmd.take_profit_kind ? { kind: cmd.take_profit_kind, value: cmd.take_profit_value } : null;
        const sl = cmd.stop_loss_kind ? { kind: cmd.stop_loss_kind, value: cmd.stop_loss_value } : null;
        const tokens = quoteIsSol && pn > 0 ? amt / pn : solPrice && pu > 0 ? (amt * solPrice) / pu : null;
        const p = { ...card, amountSol: amt, percent: null, estimate: tokens ? `${fmtAmount(tokens)} ${sym}` : null, tp: okTp(tp) ? tp : null, sl: okSl(sl) ? sl : null };
        setPending(p);
        const brackets = [p.tp && `take profit at ${legText(p.tp)}`, p.sl && `stop loss at ${legText(p.sl)}`].filter(Boolean).join(' and ');
        return say(pickText(cmd, `Buy ${amt} SOL of ${sym}${brackets ? `, with ${brackets}` : ''}? Say yes or tap Confirm.`), cmd.lang);
      }

      const pctAmt = cmd.percent;
      if (!pctAmt) return say(`How much ${sym} should I sell? Say a percentage, like sell half.`);
      let held = 0;
      try {
        held = (await loadHolding(wallet, coin.mint)).amount;
      } catch {
        return fail("I couldn't read your balance right now. Try again in a moment.");
      }
      if (!(held > 0)) return fail(`You don't hold any ${sym}.`);
      const part = (held * pctAmt) / 100;
      const solOut = quoteIsSol && pn > 0 ? part * pn : solPrice && pu > 0 ? (part * pu) / solPrice : null;
      setPending({ ...card, amountSol: null, percent: pctAmt, holding: held, estimate: solOut ? `${fmtSol(solOut)} SOL` : null });
      return say(pickText(cmd, `Sell ${pctAmt}% of your ${sym}? Say yes or tap Confirm.`), cmd.lang);
    },
    [wallet, connect, fail, say, resolveCoin, getContext, openToken, solPrice, solBal, setPending]
  );

  const runTrade = useCallback(
    async (t) => {
      const approve = signerKind(wallet) === 'external' ? ' Approve it in your wallet.' : '';
      setReply(t.side === 'buy' ? `Buying ${t.symbol}.${approve}` : `Selling ${t.percent}% of ${t.symbol}.${approve}`);
      setPhase('reply');
      scheduleClose(6000);
      const res = await executeTrade({
        wallet,
        mint: t.mint,
        side: t.side,
        amountSol: t.amountSol,
        percent: t.percent,
        symbol: t.symbol,
        toast,
        onTraded,
        receiveHint: t.estimate,
      });
      if (res.status === 'ok' && t.side === 'buy' && (t.tp || t.sl)) {
        // measured from the price this buy actually got
        const made = await bracketAfterBuy(res, {
          wallet, mint: t.mint, symbol: t.symbol, name: t.name, image: t.imageUrl,
          tp: t.tp, sl: t.sl, solPrice, fallbackMc: t.marketCap, source: 'voice',
        }).catch(() => []);
        if (!made.length) return fail("The buy went through, but I couldn't set take profit and stop loss. Set them in the trade panel.");
        say(`Set: ${made.map((o) => `${o.label.toLowerCase()} at ${usd(o.targetMc)}`).join(' and ')}. ${made.length > 1 ? 'Whichever hits first cancels the other.' : ''}`.trim());
      }
    },
    [wallet, toast, onTraded, setPhase, scheduleClose, solPrice, say, fail]
  );

  /* ---------- orders and alerts ---------- */

  const prepareOrder = useCallback(
    async (cmd) => {
      if (!wallet) {
        connect();
        return fail('Set up or connect a wallet first, then say it again.');
      }
      const side = cmd.side || (cmd.percent ? 'sell' : 'buy');
      if (!cmd.trigger_kind || cmd.trigger_value === null) {
        return say(side === 'buy' ? 'When should it buy? For example: buy 0.2 SOL if it dips to 8K.' : 'When should it sell? For example: sell half at 2x.');
      }
      const coin = await resolveCoin(cmd);
      if (!coin) return fail(cmd.coin ? `I couldn't find a Solana coin called ${cmd.coin}.` : 'Open a coin first, or say which coin you mean.');
      const q = await quoteOf(coin.mint);
      const sym = coin.symbol || q?.symbol || 'this coin';
      if (!q?.mc) return fail(`I can't get a market cap for ${sym} right now, so I can't set that.`);

      let amountSol = null;
      let percent = null;
      let base = q.mc;
      let note = null;
      if (side === 'buy') {
        amountSol = cmd.amount_sol ?? (cmd.amount_usd && solPrice ? cmd.amount_usd / solPrice : null);
        if (!amountSol) return say(`How much SOL should the limit buy spend on ${sym}?`);
        amountSol = r4(amountSol);
        if (solBal !== null && amountSol > solBal) {
          // the shown balance can lag a fresh deposit, so ask the chain before saying no
          const fresh = await rpc('getBalance', [wallet, { commitment: 'confirmed' }])
            .then((x) => x.value / 1e9)
            .catch(() => solBal);
          if (amountSol > fresh) return fail(`Not enough SOL for that. You have ${fmtSol(fresh)} SOL.`);
        }
      } else {
        let held = 0;
        try {
          held = (await loadHolding(wallet, coin.mint)).amount;
        } catch {
          return fail("I couldn't read your balance right now. Try again in a moment.");
        }
        if (!(held > 0)) return fail(`You don't hold any ${sym}.`);
        percent = cmd.percent || 100;
        const entry = entryMcOf(coin.mint, q);
        if (entry) base = entry;
        else if (cmd.trigger_kind === 'multiple' || cmd.trigger_kind === 'percent') note = "I don't know your entry for this coin, so it's measured from the current market cap.";
      }
      const r = resolveTarget({ kind: cmd.trigger_kind, value: cmd.trigger_value, dir: cmd.trigger_dir }, { mcNow: q.mc, supply: q.supply, baseMc: base });
      if (r.error) return fail(r.error);
      if (alreadyHit(r.dir, r.targetMc, q.mc)) {
        return say(
          `${sym} is already ${r.dir === 'below' ? 'below' : 'above'} ${usd(r.targetMc)}: it's at ${usd(q.mc)} now. ${side === 'buy' ? 'Say "buy now" if you want in at this price.' : 'Say "sell now" if you want out.'}`
        );
      }
      const label = side === 'buy' ? 'Limit buy' : r.dir === 'above' ? 'Take profit' : 'Stop loss';
      const expiresInMs = cmd.expires_minutes ? cmd.expires_minutes * 60000 : DEFAULT_EXPIRY[side];
      setPending({
        kind: 'order', side, mint: coin.mint, symbol: sym, name: coin.name || q.name || '', imageUrl: coin.imageUrl || q.image || null,
        amountSol, percent, targetMc: r.targetMc, dir: r.dir, mcNow: q.mc, expiresInMs, label, note,
      });
      const what = side === 'buy' ? `buy ${amountSol} SOL of ${sym}` : `sell ${percent === 100 ? 'all' : `${percent}%`} of your ${sym}`;
      return say(pickText(cmd, `${label}: ${what} when the market cap ${r.dir === 'below' ? 'falls to' : 'rises to'} ${usd(r.targetMc)}. It's ${usd(q.mc)} now. Say yes or tap Confirm.`), cmd.lang);
    },
    [wallet, connect, fail, say, resolveCoin, quoteOf, solPrice, solBal, entryMcOf, setPending]
  );

  const placeOrder = useCallback(
    (t) => {
      try {
        createOrder({
          wallet, mint: t.mint, symbol: t.symbol, name: t.name, image: t.imageUrl, type: t.side,
          amountSol: t.amountSol, percent: t.percent, targetMc: t.targetMc, dir: t.dir, label: t.label,
          createdMc: t.mcNow, expiresInMs: t.expiresInMs, source: 'voice',
        });
      } catch (e) {
        return fail(String(e?.message || "Couldn't place that order."));
      }
      say(`Done. ${t.label} placed at ${usd(t.targetMc)}. It runs while Yapper is open in a tab.`);
    },
    [wallet, fail, say]
  );

  const makeAlert = useCallback(
    async (cmd) => {
      if (!cmd.trigger_kind || cmd.trigger_value === null) return say('At what market cap? For example: tell me when this hits 50K.');
      const coin = await resolveCoin(cmd);
      if (!coin) return fail(cmd.coin ? `I couldn't find a Solana coin called ${cmd.coin}.` : 'Open a coin first, or say which coin you mean.');
      const q = await quoteOf(coin.mint);
      const sym = coin.symbol || q?.symbol || 'this coin';
      if (!q?.mc) return fail(`I can't get a market cap for ${sym} right now.`);
      const r = resolveTarget({ kind: cmd.trigger_kind, value: cmd.trigger_value, dir: cmd.trigger_dir }, { mcNow: q.mc, supply: q.supply, baseMc: q.mc });
      if (r.error) return fail(r.error);
      if (alreadyHit(r.dir, r.targetMc, q.mc)) return say(`${sym} is already there: it's at ${usd(q.mc)} now.`);
      try {
        createOrder({
          wallet: wallet || null, mint: coin.mint, symbol: sym, name: coin.name || q.name || '', image: coin.imageUrl || q.image || null,
          type: 'alert', targetMc: r.targetMc, dir: r.dir, createdMc: q.mc,
          expiresInMs: cmd.expires_minutes ? cmd.expires_minutes * 60000 : undefined, source: 'voice',
        });
      } catch (e) {
        return fail(String(e?.message || "Couldn't set that alert."));
      }
      return say(pickText(cmd, `Alert set. I'll tell you when ${sym} ${r.dir === 'below' ? 'falls to' : 'hits'} ${usd(r.targetMc)}. It's ${usd(q.mc)} now.`), cmd.lang);
    },
    [wallet, say, fail, resolveCoin, quoteOf]
  );

  const cancelOrdersCmd = useCallback(
    async (cmd) => {
      let n = 0;
      if (cmd.order_ids?.length) {
        for (const id of cmd.order_ids) if (cancelOrder(id)) n++;
      } else if (cmd.coin_is_current || cmd.coin) {
        const coin = await resolveCoin(cmd);
        if (!coin) return fail("I couldn't tell which coin's orders to cancel.");
        n = cancelOrdersWhere((o) => o.mint === coin.mint);
      } else {
        n = cancelOrdersWhere(() => true);
      }
      return say(n ? `Cancelled ${n} order${n > 1 ? 's' : ''}.` : 'There were no open orders to cancel.');
    },
    [resolveCoin, say, fail]
  );

  /* ---------- selling several coins ---------- */

  const prepareSellMany = useCallback(
    async (cmd) => {
      if (!wallet) {
        connect();
        return fail('Set up or connect a wallet first, then say it again.');
      }
      let rows;
      try {
        rows = await holdingsWithPnl(wallet, solPrice);
      } catch {
        return fail("I couldn't read your positions right now. Try again in a moment.");
      }
      const f = cmd.filter || 'all';
      const th = cmd.filter_pct;
      let picked;
      let skipped = 0;
      if (f === 'all') {
        picked = rows.filter((r) => r.value === null || r.value >= 0.5);
      } else {
        const known = rows.filter((r) => r.fromEntryPct !== null);
        skipped = rows.length - known.length;
        picked =
          f === 'losing'
            ? known.filter((r) => r.fromEntryPct < 0 && r.fromEntryPct <= -(th || 0))
            : known.filter((r) => r.fromEntryPct > 0 && r.fromEntryPct >= (th || 0));
      }
      picked = picked.slice(0, 12);
      const skipNote = skipped ? ` I skipped ${skipped} coin${skipped > 1 ? 's' : ''} without a known entry.` : '';
      if (!picked.length) {
        return say(
          f === 'all' ? "You don't hold any coins to sell." : `None of your coins are ${f === 'losing' ? 'down' : 'up'}${th ? ` more than ${th}%` : ''} from your entry.${skipNote}`
        );
      }
      const percent = cmd.percent || 100;
      const items = picked.map((r) => ({ mint: r.mint, symbol: r.symbol, name: r.name, imageUrl: r.imageUrl, amount: r.amount, valueUsd: r.value, fromEntryPct: r.fromEntryPct }));
      setPending({ kind: 'sell_many', percent, items });
      const total = items.reduce((s, it) => s + (it.valueUsd || 0), 0) * (percent / 100);
      const names = items.slice(0, 4).map((i) => i.symbol).join(', ') + (items.length > 4 ? ` and ${items.length - 4} more` : '');
      return say(
        pickText(cmd, `Sell ${percent === 100 ? 'all' : `${percent}%`} of ${items.length} coin${items.length > 1 ? 's' : ''}: ${names}, worth about ${usd(total)}?${skipNote} Say yes or tap Confirm.`),
        cmd.lang
      );
    },
    [wallet, connect, fail, say, solPrice, setPending]
  );

  const runSellMany = useCallback(
    async (t) => {
      setReply(`Selling ${t.items.length} coin${t.items.length > 1 ? 's' : ''}…`);
      setPhase('reply');
      let ok = 0;
      const failed = [];
      for (const it of t.items) {
        const res = await executeTrade({ wallet, mint: it.mint, side: 'sell', percent: t.percent, symbol: it.symbol, toast, onTraded });
        if (res.status === 'ok' || res.status === 'pending') ok++;
        else failed.push(it.symbol);
      }
      say(`Sold ${ok} of ${t.items.length}.${failed.length ? ` ${failed.join(', ')} didn't go through.` : ''}`);
    },
    [wallet, toast, onTraded, setPhase, say]
  );

  /* ---------- settings, copy, share ---------- */

  const applySetting = useCallback(
    (cmd) => {
      const v = cmd.setting_value;
      const on = cmd.setting_on;
      switch (cmd.setting) {
        case 'slippage':
          if (!(v >= 0.5 && v <= 50)) return fail('Slippage can be between 0.5% and 50%.');
          saveTradeSettings({ slippage: String(v) });
          settingsChanged({ slippage: String(v) });
          return say(`Slippage set to ${v}%.`);
        case 'priority_fee':
          if (!(v >= 0 && v <= 0.01)) return fail('The priority fee can be between 0 and 0.01 SOL.');
          saveTradeSettings({ prioFee: String(v) });
          settingsChanged({ prioFee: String(v) });
          return say(`Priority fee set to ${v} SOL.`);
        case 'quick_buy':
          if (!(v > 0 && v <= 100)) return fail('Quick buy can be up to 100 SOL.');
          try {
            localStorage.setItem(QB_KEY, String(v));
          } catch {}
          settingsChanged({ quickBuy: String(v) });
          return say(`Quick buy set to ${v} SOL. Every Buy button in the lists spends that now.`);
        case 'callouts':
        case 'wake_word':
        case 'natural_voice':
        case 'trade_summaries':
        case 'voice_replies': {
          const key = { callouts: 'callouts', wake_word: 'wake', natural_voice: 'natural', trade_summaries: 'speakTrades', voice_replies: 'muted' }[cmd.setting];
          const cur = getPrefs()[key];
          // "on" means the feature is on; for spoken replies that's muted = false
          const want = on === null ? !cur : key === 'muted' ? !on : on;
          if (key === 'wake' && want && !wakeSupported()) return fail("This browser can't listen for a wake word. Chrome and Edge can.");
          if (key === 'muted' && want) {
            setPrefs({ muted: true });
            stopSpeaking();
            return say('Okay, no more spoken replies. Say "turn voice back on" to undo.');
          }
          setPrefs({ [key]: want });
          const names = {
            callouts: want ? "Callouts on. I'll speak up when a coin you hold hits 2x, graduates or gets a big sell." : 'Callouts off.',
            wake: want ? 'Hands-free on. Say "Yapper" and then your command.' : 'Hands-free off.',
            natural: want ? 'Natural voice on.' : "Switched to your browser's voice.",
            speakTrades: want ? "I'll read out your trades." : "I'll stop reading out trades.",
            muted: 'Spoken replies are back on.',
          };
          return say(names[key]);
        }
        default:
          return say(cmd.reply || 'I can change slippage, priority fee, quick buy, callouts, hands-free mode and the voice.');
      }
    },
    [say, fail]
  );

  const copyAddress = useCallback(
    async (cmd) => {
      const coin = await resolveCoin(cmd);
      if (!coin) return fail('Open a coin first, or say which coin you mean.');
      const sym = coin.symbol || 'the coin';
      try {
        await navigator.clipboard.writeText(coin.mint);
        return say(`Copied ${sym}'s contract address.`);
      } catch {
        setExtra({ type: 'copy', mint: coin.mint, symbol: sym });
        return say(`Tap Copy to copy ${sym}'s contract address.`);
      }
    },
    [resolveCoin, say, fail]
  );

  const shareCoin = useCallback(
    async (cmd) => {
      const coin = await resolveCoin(cmd);
      if (!coin) return fail('Open a coin first, or say which coin you mean.');
      const sym = coin.symbol || 'this coin';
      const link = `${window.location.origin}/?ca=${coin.mint}`;
      const text = `$${sym} on Yapper`;
      const url = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(link)}`;
      setExtra({ type: 'share', url, symbol: sym });
      return say(`Ready to share ${sym}. Tap Share on X.`);
    },
    [resolveCoin, say, fail]
  );

  /* ---------- confirm / cancel ---------- */

  const confirmPending = useCallback(async () => {
    const t = pendingRef.current;
    if (!t) return;
    setPending(null);
    if (t.kind === 'order') return placeOrder(t);
    if (t.kind === 'sell_many') return runSellMany(t);
    return runTrade(t);
  }, [setPending, placeOrder, runSellMany, runTrade]);

  const cancelPending = useCallback(() => {
    setPending(null);
    say('Cancelled.');
  }, [say, setPending]);

  /* ---------- one command ---------- */

  const handle = useCallback(
    async (cmd, said = '') => {
      setCards([]);
      setExtra(null);
      if (cmd.listed?.length) showCards(cmd.listed);
      switch (cmd.action) {
        case 'confirm':
          if (!pendingRef.current) return say(cmd.reply || 'There is nothing to confirm.', cmd.reply ? cmd.lang : 'en');
          // a yes is short; a long sentence read as "confirm" is more likely a
          // misunderstanding (or text in a coin name steering the assistant)
          if (said.trim().split(/\s+/).length > 7) return say('To go ahead, say yes or tap Confirm.');
          return confirmPending();
        case 'cancel':
          if (pendingRef.current) return cancelPending();
          return say(cmd.reply || 'Okay.', cmd.reply ? cmd.lang : 'en');
        case 'navigate':
          navigate(cmd.target || 'discover');
          return say(
            cmd.reply ||
              (cmd.target === 'positions' ? 'Here are your positions.' : cmd.target === 'pulse' ? 'Here is Pulse, with the newest coins.' : 'Here is what is trending.'),
            cmd.reply ? cmd.lang : 'en'
          );
        case 'open': {
          const coin = await resolveCoin(cmd);
          if (!coin) return fail(cmd.coin ? `I couldn't find a Solana coin called ${cmd.coin}.` : 'Which coin should I open?');
          openToken(coin.mint);
          return say(`Opening ${coin.symbol || coin.name || 'that coin'}.`);
        }
        case 'buy':
        case 'sell':
          return prepareTrade(cmd);
        case 'order':
          return prepareOrder(cmd);
        case 'alert':
          return makeAlert(cmd);
        case 'cancel_orders':
          return cancelOrdersCmd(cmd);
        case 'sell_many':
          return prepareSellMany(cmd);
        case 'settings':
          return applySetting(cmd);
        case 'copy_address':
          return copyAddress(cmd);
        case 'share':
          return shareCoin(cmd);
        default:
          return say(cmd.reply || 'Try saying: buy 0.1 SOL of this, sell half at 2x, or find me something on the curve.', cmd.reply ? cmd.lang : 'en');
      }
    },
    [showCards, confirmPending, cancelPending, say, fail, navigate, resolveCoin, openToken, prepareTrade, prepareOrder, makeAlert, cancelOrdersCmd, prepareSellMany, applySetting, copyAddress, shareCoin]
  );

  const send = useCallback(
    async ({ audio, text }) => {
      clearTimeout(wakeTimer.current);
      setPhase('thinking');
      setOpen(true);
      setView('main');
      setReply('');
      if (text) setTranscript(text);
      wakeRef.current?.pause();
      turnRef.current = { reply: '', coin: null, listed: [] };
      let said = text || '';
      try {
        const context = await buildContext(audio ? 1500 : 2500);
        const fd = new FormData();
        if (audio) fd.append('audio', audio, `voice.${extFor(audio.type)}`);
        if (text) fd.append('text', text);
        fd.append('context', JSON.stringify(context));
        const recent = historyRef.current.filter((t) => Date.now() - t.at < HISTORY_MS);
        fd.append('history', JSON.stringify(recent.map(({ at, ...t }) => t)));
        const r = await fetch('/api/voice', { method: 'POST', body: fd });
        const j = await r.json().catch(() => ({}));
        if (j.transcript) {
          said = j.transcript;
          setTranscript(j.transcript);
        }
        if (!r.ok || !j.command) return fail(j.error || 'Voice is not responding. Try again.');
        await handle(j.command, said);
        historyRef.current = [
          ...recent,
          { at: Date.now(), said, reply: turnRef.current.reply, action: j.command.action, coin: turnRef.current.coin, listed: turnRef.current.listed },
        ].slice(-6);
      } catch {
        fail('Voice is not responding. Check your connection and try again.');
      } finally {
        extrasRef.current = null; // fresh data next time
        if (!speakingRef.current) wakeRef.current?.resume();
      }
    },
    [buildContext, handle, fail, setPhase]
  );
  sendRef.current = send;

  /* ---------- hands-free ---------- */

  useEffect(() => {
    speakingRef.current = speaking;
    const w = wakeRef.current;
    if (!w) return;
    // don't let it hear its own voice
    if (speaking) w.pause();
    else if (!recRef.current && phaseRef.current !== 'thinking') w.resume();
  }, [speaking]);

  useEffect(() => {
    if (!prefs.wake) {
      setWakeState('off');
      return;
    }
    if (!wakeSupported()) {
      setWakeState('unsupported');
      return;
    }
    const w = createWake({
      lang: 'en-US',
      onState: setWakeState,
      onWake: () => {
        if (['thinking', 'listening', 'starting'].includes(phaseRef.current)) return;
        stopSpeaking();
        beginExtras();
        setTranscript('');
        setReply('');
        setCards([]);
        setExtra(null);
        setView('main');
        setOpen(true);
        setPhase('wake');
        clearTimeout(wakeTimer.current);
        wakeTimer.current = setTimeout(() => {
          if (phaseRef.current === 'wake') {
            setPhase('idle');
            if (!pendingRef.current) setOpen(false);
          }
        }, 8000);
      },
      onCommand: (text) => {
        if (phaseRef.current === 'thinking') return;
        sendRef.current?.({ text });
      },
    });
    wakeRef.current = w;
    w.start();
    if (pendingRef.current) w.expectReply(true);
    return () => {
      w.stop();
      if (wakeRef.current === w) wakeRef.current = null;
    };
  }, [prefs.wake, beginExtras, setPhase]);

  /* ---------- recording ---------- */

  const stopAndSend = useCallback(() => {
    const r = recRef.current;
    if (!r) {
      if (phaseRef.current === 'starting') stopAfterStart.current = true;
      return;
    }
    recRef.current = null;
    clearTimeout(r.timeout);
    cancelAnimationFrame(r.raf);
    orbRef.current?.style.setProperty('--lvl', '0');
    r.recorder.onstop = () => {
      r.stream.getTracks().forEach((t) => t.stop());
      try {
        r.ctx?.close();
      } catch {}
      const type = r.recorder.mimeType || r.mime || 'audio/webm';
      const blob = new Blob(r.chunks, { type });
      if (Date.now() - r.startedAt < 500 || blob.size < 1200) {
        fail("I didn't catch that. Hold the orb while you talk, or tap once to start and again to send.");
        wakeRef.current?.resume();
        return;
      }
      send({ audio: blob });
    };
    try {
      r.recorder.stop();
    } catch {
      r.recorder.onstop();
    }
  }, [send, fail]);

  const startListening = useCallback(async () => {
    if (phaseRef.current === 'starting' || phaseRef.current === 'listening' || phaseRef.current === 'thinking') return;
    clearTimeout(closeTimer.current);
    clearTimeout(wakeTimer.current);
    unlockAudio();
    genRef.current++;
    stopSpeaking();
    queueRef.current = Promise.resolve();
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      return fail('Voice is not supported in this browser. Type your command below instead.');
    }
    wakeRef.current?.pause();
    beginExtras();
    stopAfterStart.current = false;
    setTranscript('');
    setReply('');
    setCards([]);
    setExtra(null);
    setView('main');
    setOpen(true);
    setPhase('starting');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      wakeRef.current?.resume();
      return fail('Microphone access is blocked. Allow the microphone for this site, or type your command below.');
    }
    const mime = pickMime();
    let recorder;
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      wakeRef.current?.resume();
      return fail('Recording is not supported in this browser. Type your command below instead.');
    }
    const rec = { recorder, stream, mime, chunks: [], startedAt: Date.now(), raf: 0, ctx: null, timeout: 0 };
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) rec.chunks.push(e.data);
    };
    recorder.start(250);

    // mic level drives the orb
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      rec.ctx = ctx;
      const tick = () => {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const lvl = Math.min(1, Math.sqrt(sum / buf.length) * 5);
        orbRef.current?.style.setProperty('--lvl', lvl.toFixed(3));
        rec.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch {}

    rec.timeout = setTimeout(() => stopAndSend(), MAX_MS);
    recRef.current = rec;
    setPhase('listening');
    if (stopAfterStart.current) {
      stopAfterStart.current = false;
      stopAndSend();
    }
  }, [fail, setPhase, stopAndSend, beginExtras]);

  // hold = talk, quick tap = toggle
  const pressDown = useCallback(() => {
    if (phaseRef.current === 'thinking') return;
    if (recRef.current || phaseRef.current === 'starting') {
      press.current.ignoreUp = true;
      setTapMode(false);
      stopAndSend();
      return;
    }
    press.current = { t: Date.now(), ignoreUp: false };
    setTapMode(false);
    startListening();
  }, [startListening, stopAndSend]);

  const pressUp = useCallback(() => {
    if (press.current.ignoreUp) {
      press.current.ignoreUp = false;
      return;
    }
    if (!press.current.t) return;
    const held = Date.now() - press.current.t;
    press.current.t = 0;
    if (held < TAP_MS || phaseRef.current === 'starting') {
      setTapMode(true); // keep listening until the next tap
      return;
    }
    stopAndSend();
  }, [stopAndSend]);

  // hold Space anywhere (outside text fields) to talk
  useEffect(() => {
    const typing = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
    const inDialog = () => !!document.querySelector('[aria-modal="true"]');
    const down = (e) => {
      if (e.code !== 'Space' || e.repeat || typing(e.target) || inDialog() || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      pressDown();
    };
    const up = (e) => {
      if (e.code !== 'Space' || typing(e.target) || (inDialog() && !recRef.current)) return;
      e.preventDefault();
      pressUp();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [pressDown, pressUp]);

  // release the mic if the page goes away mid-recording
  useEffect(
    () => () => {
      const r = recRef.current;
      if (r) {
        r.stream.getTracks().forEach((t) => t.stop());
        cancelAnimationFrame(r.raf);
      }
      clearTimeout(closeTimer.current);
      clearTimeout(wakeTimer.current);
    },
    []
  );

  const close = () => {
    if (recRef.current) {
      const r = recRef.current;
      recRef.current = null;
      r.recorder.onstop = null;
      try {
        r.recorder.stop();
      } catch {}
      r.stream.getTracks().forEach((t) => t.stop());
      cancelAnimationFrame(r.raf);
      wakeRef.current?.resume();
    }
    setPending(null);
    setOpen(false);
    setPhase('idle');
    setView('main');
    genRef.current++;
    stopSpeaking();
  };

  const submitTyped = (e) => {
    e.preventDefault();
    const t = typed.trim();
    if (!t || phaseRef.current === 'thinking') return;
    setTyped('');
    send({ text: t });
  };

  const openSettings = () => {
    clearTimeout(closeTimer.current);
    setView((v) => (v === 'settings' && open ? 'main' : 'settings'));
    setOpen(true);
    if (!['listening', 'starting', 'thinking'].includes(phaseRef.current)) setPhase('idle');
  };

  const listening = phase === 'listening' || phase === 'starting';
  const handsFree = prefs.wake && wakeState === 'listening';
  const stateLabel =
    phase === 'starting'
      ? 'Starting the microphone…'
      : phase === 'listening'
      ? tapMode
        ? 'Listening. Tap the orb to send.'
        : 'Listening. Release to send.'
      : phase === 'wake'
      ? 'Listening. Say your command.'
      : phase === 'thinking'
      ? 'Thinking…'
      : null;

  const quickAmount = readQuickBuy();

  return (
    <>
      <button
        ref={orbRef}
        type="button"
        className={`orb${listening || phase === 'wake' ? ' listening' : ''}${phase === 'thinking' ? ' thinking' : ''}${speaking ? ' speaking' : ''}${handsFree ? ' handsfree' : ''}`}
        aria-label={listening ? 'Stop and send voice command' : 'Hold to talk'}
        aria-pressed={listening}
        onPointerDown={(e) => {
          if (e.button !== undefined && e.button !== 0) return;
          e.preventDefault();
          pressDown();
        }}
        onPointerUp={pressUp}
        onPointerCancel={pressUp}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (listening) stopAndSend();
            else {
              setTapMode(true);
              startListening();
            }
          }
        }}
      >
        <img src="/orb.png" alt="" width="86" height="86" draggable="false" />
      </button>
      <span className="sb-voice-note">
        {handsFree ? (
          <>
            Say <b>&ldquo;Yapper&rdquo;</b> or hold <kbd>Space</kbd>
          </>
        ) : (
          <>
            Hold to talk <kbd>Space</kbd>
          </>
        )}
        <button type="button" className="icon-btn sb-voice-set" onClick={openSettings} aria-label="Voice settings" title="Voice settings">
          <Icon name="sliders" size={14} />
        </button>
      </span>
      <button type="button" className="icon-btn sb-voice-gear" onClick={openSettings} aria-label="Voice settings">
        <Icon name="sliders" size={15} />
      </button>

      {open && (
        <div className="vp" role="dialog" aria-label="Voice assistant" aria-live="polite">
          <div className="vp-head">
            <span className="vp-state">
              {view === 'settings' ? (
                'Voice settings'
              ) : stateLabel ? (
                <>
                  <span className={`vp-dot${phase === 'thinking' ? ' slow' : ''}`} aria-hidden="true" />
                  {stateLabel}
                </>
              ) : (
                <>
                  Yapper
                  {handsFree && <span className="vp-hf">hands-free</span>}
                </>
              )}
            </span>
            <span className="vp-tools">
              <button
                type="button"
                className="icon-btn"
                onClick={() => {
                  const next = !prefs.muted;
                  setPrefs({ muted: next });
                  if (next) stopSpeaking();
                }}
                aria-pressed={!prefs.muted}
                aria-label={prefs.muted ? 'Turn spoken replies on' : 'Turn spoken replies off'}
                title={prefs.muted ? 'Spoken replies off' : 'Spoken replies on'}
              >
                <Icon name={prefs.muted ? 'mute' : 'volume'} size={15} />
              </button>
              <button
                type="button"
                className={`icon-btn${view === 'settings' ? ' on' : ''}`}
                onClick={() => setView((v) => (v === 'settings' ? 'main' : 'settings'))}
                aria-pressed={view === 'settings'}
                aria-label="Voice settings"
              >
                <Icon name="sliders" size={15} />
              </button>
              <button type="button" className="icon-btn" onClick={close} aria-label="Close voice panel">
                <Icon name="close" size={14} />
              </button>
            </span>
          </div>

          {view === 'settings' ? (
            <VoiceSettings prefs={prefs} onChange={(patch) => setPrefs(patch)} wakeState={wakeState} wakeOk={wakeOk} />
          ) : (
            <>
              {transcript && <p className="vp-you">“{transcript}”</p>}
              {reply && <p className={`vp-reply${phase === 'error' ? ' err' : ''}`}>{reply}</p>}

              <CoinCards
                cards={cards}
                quickAmount={quickAmount}
                onOpen={(m) => openToken(m)}
                onBuy={onQuickBuy ? (c) => onQuickBuy({ mint: c.mint, symbol: c.symbol, name: c.name }, quickAmount) : null}
              />

              {extra?.type === 'copy' && (
                <button
                  type="button"
                  className="btn btn-ghost vp-extra"
                  onClick={() => {
                    navigator.clipboard?.writeText(extra.mint).then(
                      () => setReply(`Copied ${extra.symbol}'s contract address.`),
                      () => setReply(extra.mint)
                    );
                  }}
                >
                  <Icon name="copy" size={14} /> Copy {extra.symbol} address
                </button>
              )}
              {extra?.type === 'share' && (
                <a className="btn btn-ghost vp-extra" href={extra.url} target="_blank" rel="noreferrer">
                  <Icon name="x" size={14} /> Share {extra.symbol} on X
                </a>
              )}

              {pending && <PendingCard pending={pending} onConfirm={confirmPending} onCancel={cancelPending} />}

              {!['listening', 'starting', 'thinking', 'wake'].includes(phase) && (
                <form className="vp-form" onSubmit={submitTyped}>
                  <label htmlFor="vp-text" className="sr-only">
                    Type a command
                  </label>
                  <input
                    id="vp-text"
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    onFocus={beginExtras}
                    placeholder={pending ? 'Or type: yes, or a change' : 'Or type: sell half at 2x'}
                    autoComplete="off"
                  />
                  <button type="submit" className="btn btn-ghost" disabled={!typed.trim()}>
                    Send
                  </button>
                </form>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
