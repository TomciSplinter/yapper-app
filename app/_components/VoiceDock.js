'use client';

// The orb. Hold it (or hold Space) and talk; release to send. A quick tap
// starts listening and a second tap sends. Every trade shows a confirm card
// first and only runs after "yes" or a tap on Confirm.

import { useCallback, useEffect, useRef, useState } from 'react';
import { extractMint, rpc, SOL_MINT } from '../_lib/chain';
import { fetchPair } from '../_lib/markets';
import { executeTrade } from '../_lib/trade';
import { signerKind } from '../_lib/wallets';
import { amount as fmtAmount, sol as fmtSol, usd } from '../_lib/format';
import { Icon, TokenImage } from './Icons';

const MAX_MS = 15000;
const TAP_MS = 350;
const MUTE_KEY = 'yapper:voice-muted';

const norm = (s) => String(s || '').toLowerCase().replace(/^\$/, '').replace(/[^a-z0-9]/g, '');

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

let speechUnlocked = false;

// Pick a voice in the reply's language. Without this the browser falls back
// to the computer's language, so on a Hungarian computer English replies
// were read by a Hungarian voice. Prefer the natural-sounding voices.
const voiceCache = new Map();
let voicesListening = false;
function pickVoice(lang = 'en') {
  try {
    const synth = window.speechSynthesis;
    const want = String(lang || 'en').toLowerCase().split(/[-_]/)[0];
    if (voiceCache.has(want)) return voiceCache.get(want);
    const all = synth.getVoices() || [];
    if (!all.length && !voicesListening) {
      voicesListening = true;
      synth.addEventListener?.('voiceschanged', () => voiceCache.clear());
    }
    const voices = all.filter((v) => String(v.lang || '').toLowerCase().split(/[-_]/)[0] === want);
    if (!voices.length) return null;
    const score = (v) => {
      const code = String(v.lang || '').replace('_', '-').toLowerCase();
      const name = v.name || '';
      let s = 0;
      if (code === 'en-us') s += 4;
      else if (code === 'en-gb') s += 3;
      if (/natural|neural|online|premium|enhanced/i.test(name)) s += 3;
      if (/google/i.test(name)) s += 2;
      if (/^(samantha|aria|jenny|guy|ava|allison)\b/i.test(name)) s += 1;
      return s;
    };
    const best = voices.slice().sort((a, b) => score(b) - score(a))[0];
    voiceCache.set(want, best);
    return best;
  } catch {
    return null;
  }
}

export default function VoiceDock({ getContext, openToken, navigate, wallet, connect, solBal, solPrice, toast, onTraded }) {
  const [phase, setPhaseRaw] = useState('idle'); // idle | starting | listening | thinking | reply | error
  const [tapMode, setTapMode] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [reply, setReply] = useState('');
  const [pending, setPending] = useState(null);
  const [open, setOpen] = useState(false);
  const [muted, setMuted] = useState(false);
  const [typed, setTyped] = useState('');

  const orbRef = useRef(null);
  const recRef = useRef(null);
  const phaseRef = useRef('idle');
  const pendingRef = useRef(null);
  const stopAfterStart = useRef(false);
  const press = useRef({ t: 0, ignoreUp: false });
  const closeTimer = useRef(null);

  const setPhase = useCallback((p) => {
    phaseRef.current = p;
    setPhaseRaw(p);
  }, []);

  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  useEffect(() => {
    try {
      setMuted(localStorage.getItem(MUTE_KEY) === '1');
    } catch {}
    if (typeof window !== 'undefined' && window.speechSynthesis) pickVoice('en'); // voices load late in Chrome

  }, []);

  /* ---------- speech out ---------- */

  const speak = useCallback(
    (text, lang = 'en') => {
      try {
        if (muted || !text || !window.speechSynthesis) return;
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        const v = pickVoice(lang);
        if (v) {
          u.voice = v;
          u.lang = v.lang;
        } else {
          u.lang = lang === 'en' ? 'en-US' : lang;
        }
        u.rate = 1.05;
        window.speechSynthesis.speak(u);
      } catch {}
    },
    [muted]
  );

  // iOS only lets a page speak after speech was started from a tap
  const unlockSpeech = () => {
    try {
      if (speechUnlocked || !window.speechSynthesis) return;
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      window.speechSynthesis.speak(u);
      speechUnlocked = true;
    } catch {}
  };

  const scheduleClose = useCallback((ms) => {
    clearTimeout(closeTimer.current);
    if (ms) {
      closeTimer.current = setTimeout(() => {
        if (!pendingRef.current && (phaseRef.current === 'reply' || phaseRef.current === 'error')) {
          setOpen(false);
          setPhase('idle');
        }
      }, ms);
    }
  }, [setPhase]);

  const say = useCallback(
    (text, lang) => {
      setReply(text || '');
      setPhase('reply');
      setOpen(true);
      speak(text, lang);
      scheduleClose(pendingRef.current ? 0 : 9000);
    },
    [setPhase, speak, scheduleClose]
  );

  const fail = useCallback(
    (text) => {
      setReply(text);
      setPhase('error');
      setOpen(true);
      speak(text);
      scheduleClose(9000);
    },
    [setPhase, speak, scheduleClose]
  );

  /* ---------- commands ---------- */

  const resolveCoin = useCallback(
    async (cmd) => {
      const ctx = getContext();
      const cur = ctx.coin?.mint ? { mint: ctx.coin.mint, symbol: ctx.coin.symbol, name: ctx.coin.name, imageUrl: ctx.coin.image } : null;
      if (cmd.coin_is_current || !cmd.coin) return cur;
      if (cur && norm(cmd.coin) && (norm(cmd.coin) === norm(cur.symbol) || norm(cmd.coin) === norm(cur.name))) return cur;
      const m = extractMint(cmd.coin);
      if (m) {
        const p = await fetchPair(m).catch(() => null);
        return { mint: m, symbol: p?.baseToken?.symbol || '', name: p?.baseToken?.name || '', imageUrl: p?.info?.imageUrl || null };
      }
      const r = await fetch(`/api/search?q=${encodeURIComponent(cmd.coin)}`);
      const j = await r.json().catch(() => ({}));
      const t = j?.results?.[0];
      return t ? { mint: t.mint, symbol: t.symbol, name: t.name, imageUrl: t.imageUrl } : null;
    },
    [getContext]
  );

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

      if (side === 'buy') {
        let amt = cmd.amount_sol ?? (cmd.amount_usd && solPrice ? cmd.amount_usd / solPrice : null);
        if (!amt) return say(`How much SOL should I spend on ${sym}? For example, buy 0.5 SOL.`);
        amt = Math.round(amt * 10000) / 10000;
        if (solBal !== null && amt > solBal) {
          // the shown balance can lag a fresh deposit, so ask the chain before saying no
          const fresh = await rpc('getBalance', [wallet, { commitment: 'confirmed' }])
            .then((b) => b.value / 1e9)
            .catch(() => solBal);
          if (amt > fresh) return fail(`Not enough SOL. You have ${fmtSol(fresh)} SOL.`);
        }
        const tokens = quoteIsSol && pn > 0 ? amt / pn : solPrice && pu > 0 ? (amt * solPrice) / pu : null;
        setPending({
          side,
          mint: coin.mint,
          symbol: sym,
          name: coin.name || pair?.baseToken?.name || '',
          imageUrl: coin.imageUrl || pair?.info?.imageUrl || null,
          amountSol: amt,
          percent: null,
          estimate: tokens ? `${fmtAmount(tokens)} ${sym}` : null,
          marketCap: pair?.marketCap ?? pair?.fdv ?? null,
        });
        return say(`Buy ${amt} SOL of ${sym}? Say yes or tap Confirm.`);
      }

      const pct = cmd.percent;
      if (!pct) return say(`How much ${sym} should I sell? Say a percentage, like sell half.`);
      let held = 0;
      try {
        const r = await rpc('getParsedTokenAccountsByOwner', [wallet, { mint: coin.mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
        held = (r?.value || []).reduce((s, a) => {
          const t = a?.account?.data?.parsed?.info?.tokenAmount;
          return s + (Number(t?.uiAmountString ?? t?.uiAmount) || 0);
        }, 0);
      } catch {}
      if (!(held > 0)) return fail(`You don't hold any ${sym}.`);
      const part = (held * pct) / 100;
      const solOut = quoteIsSol && pn > 0 ? part * pn : solPrice && pu > 0 ? (part * pu) / solPrice : null;
      setPending({
        side,
        mint: coin.mint,
        symbol: sym,
        name: coin.name || pair?.baseToken?.name || '',
        imageUrl: coin.imageUrl || pair?.info?.imageUrl || null,
        amountSol: null,
        percent: pct,
        holding: held,
        estimate: solOut ? `${fmtSol(solOut)} SOL` : null,
        marketCap: pair?.marketCap ?? pair?.fdv ?? null,
      });
      return say(`Sell ${pct}% of your ${sym}? Say yes or tap Confirm.`);
    },
    [wallet, connect, fail, say, resolveCoin, getContext, openToken, solPrice, solBal]
  );

  const confirmTrade = useCallback(async () => {
    const t = pendingRef.current;
    if (!t) return;
    setPending(null);
    pendingRef.current = null;
    const approve = signerKind(wallet) === 'external' ? ' Approve it in your wallet.' : '';
    setReply(t.side === 'buy' ? `Buying ${t.symbol}.${approve}` : `Selling ${t.percent}% of ${t.symbol}.${approve}`);
    setPhase('reply');
    scheduleClose(6000);
    await executeTrade({
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
  }, [wallet, toast, onTraded, setPhase, scheduleClose]);

  const cancelTrade = useCallback(() => {
    setPending(null);
    pendingRef.current = null;
    say('Cancelled.');
  }, [say]);

  const handle = useCallback(
    async (cmd) => {
      switch (cmd.action) {
        case 'confirm':
          if (pendingRef.current) return confirmTrade();
          return say(cmd.reply || 'There is nothing to confirm.', cmd.reply ? cmd.lang : 'en');
        case 'cancel':
          if (pendingRef.current) return cancelTrade();
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
        default:
          return say(cmd.reply || 'Try saying: buy 0.1 SOL of this, sell half, or what is the market cap.', cmd.reply ? cmd.lang : 'en');
      }
    },
    [confirmTrade, cancelTrade, navigate, resolveCoin, openToken, prepareTrade, say, fail]
  );

  const send = useCallback(
    async ({ audio, text }) => {
      setPhase('thinking');
      setOpen(true);
      setReply('');
      if (text) setTranscript(text);
      try {
        const fd = new FormData();
        if (audio) fd.append('audio', audio, `voice.${extFor(audio.type)}`);
        if (text) fd.append('text', text);
        const ctx = getContext();
        const p = pendingRef.current;
        fd.append(
          'context',
          JSON.stringify({
            ...ctx,
            pending_trade: p ? { side: p.side, coin: p.symbol, amount_sol: p.amountSol, percent: p.percent } : null,
          })
        );
        const r = await fetch('/api/voice', { method: 'POST', body: fd });
        const j = await r.json().catch(() => ({}));
        if (j.transcript) setTranscript(j.transcript);
        if (!r.ok || !j.command) return fail(j.error || 'Voice is not responding. Try again.');
        await handle(j.command);
      } catch {
        fail('Voice is not responding. Check your connection and try again.');
      }
    },
    [getContext, handle, fail, setPhase]
  );

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
    unlockSpeech();
    try {
      window.speechSynthesis?.cancel();
    } catch {}
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      return fail('Voice is not supported in this browser. Type your command below instead.');
    }
    stopAfterStart.current = false;
    setTranscript('');
    setReply('');
    setOpen(true);
    setPhase('starting');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      return fail('Microphone access is blocked. Allow the microphone for this site, or type your command below.');
    }
    const mime = pickMime();
    let recorder;
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch {
      stream.getTracks().forEach((t) => t.stop());
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
  }, [fail, setPhase, stopAndSend]);

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
    },
    []
  );

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    try {
      localStorage.setItem(MUTE_KEY, next ? '1' : '0');
      if (next) window.speechSynthesis?.cancel();
    } catch {}
  };

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
    }
    setPending(null);
    setOpen(false);
    setPhase('idle');
    try {
      window.speechSynthesis?.cancel();
    } catch {}
  };

  const submitTyped = (e) => {
    e.preventDefault();
    const t = typed.trim();
    if (!t || phaseRef.current === 'thinking') return;
    setTyped('');
    send({ text: t });
  };

  const listening = phase === 'listening' || phase === 'starting';
  const stateLabel =
    phase === 'starting'
      ? 'Starting the microphone…'
      : phase === 'listening'
      ? tapMode
        ? 'Listening. Tap the orb to send.'
        : 'Listening. Release to send.'
      : phase === 'thinking'
      ? 'Thinking…'
      : null;

  return (
    <>
      <button
        ref={orbRef}
        type="button"
        className={`orb${listening ? ' listening' : ''}${phase === 'thinking' ? ' thinking' : ''}`}
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
        <img src="/orb.png" alt="" width="50" height="50" draggable="false" />
      </button>
      <span className="sb-voice-note">
        Hold to talk <kbd>Space</kbd>
      </span>

      {open && (
        <div className="vp" role="dialog" aria-label="Voice assistant" aria-live="polite">
          <div className="vp-head">
            <span className="vp-state">
              {stateLabel ? (
                <>
                  <span className={`vp-dot${phase === 'thinking' ? ' slow' : ''}`} aria-hidden="true" />
                  {stateLabel}
                </>
              ) : (
                'Yapper'
              )}
            </span>
            <span className="vp-tools">
              <button type="button" className="vp-link" onClick={toggleMute} aria-pressed={muted}>
                {muted ? 'Voice replies off' : 'Voice replies on'}
              </button>
              <button type="button" className="icon-btn" onClick={close} aria-label="Close voice panel">
                <Icon name="close" size={14} />
              </button>
            </span>
          </div>

          {transcript && <p className="vp-you">“{transcript}”</p>}
          {reply && <p className={`vp-reply${phase === 'error' ? ' err' : ''}`}>{reply}</p>}

          {pending && (
            <div className="vp-card">
              <div className="vp-coin">
                <TokenImage src={pending.imageUrl} label={pending.symbol} size={36} />
                <div className="vp-coin-text">
                  <span className="vp-coin-name">
                    {pending.name || pending.symbol} <span className="muted">{pending.symbol}</span>
                  </span>
                  <span className="vp-coin-sub mono">
                    {pending.mint.slice(0, 4)}…{pending.mint.slice(-4)}
                    {pending.marketCap ? <span className="muted"> MC {usd(pending.marketCap)}</span> : null}
                  </span>
                </div>
              </div>
              <dl className="vp-facts">
                <div>
                  <dt>{pending.side === 'buy' ? 'Spend' : 'Sell'}</dt>
                  <dd>{pending.side === 'buy' ? `${pending.amountSol} SOL` : `${pending.percent}% of ${fmtAmount(pending.holding)}`}</dd>
                </div>
                <div>
                  <dt>You get</dt>
                  <dd>{pending.estimate ? `≈ ${pending.estimate}` : '—'}</dd>
                </div>
              </dl>
              <div className="vp-actions">
                <button type="button" className="btn btn-ghost" onClick={cancelTrade}>
                  Cancel
                </button>
                <button type="button" className={`btn ${pending.side === 'buy' ? 'btn-buy' : 'btn-sell'}`} onClick={confirmTrade}>
                  {pending.side === 'buy' ? `Confirm buy` : `Confirm sell`}
                </button>
              </div>
            </div>
          )}

          {!pending && phase !== 'listening' && phase !== 'starting' && phase !== 'thinking' && (
            <form className="vp-form" onSubmit={submitTyped}>
              <label htmlFor="vp-text" className="sr-only">
                Type a command
              </label>
              <input
                id="vp-text"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder="Or type: buy 0.1 SOL of this"
                autoComplete="off"
              />
              <button type="submit" className="btn btn-ghost" disabled={!typed.trim()}>
                Send
              </button>
            </form>
          )}
        </div>
      )}
    </>
  );
}
