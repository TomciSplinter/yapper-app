'use client';

import { useEffect, useState } from 'react';
import { rpc, SOL_MINT } from '../_lib/chain';
import { amount as fmtAmount, sol as fmtSol, usd, pct } from '../_lib/format';
import { loadHolding } from '../_lib/holdings';
import { executeTrade, readTradeSettings, saveTradeSettings } from '../_lib/trade';
import { createOrder, bracketAfterBuy, parseMc, alreadyHit, DEFAULT_EXPIRY } from '../_lib/orders';
import { SETTINGS_EVENT } from '../_lib/voicebus';
import OrdersList from './Orders';

const BUY_PRESETS = ['0.1', '0.25', '0.5', '1'];
const SELL_PRESETS = ['25', '50', '75', '100'];

function clean(v) {
  return v.replace(',', '.').replace(/[^0-9.]/g, '');
}

export default function TradePanel({ mint, pair, side, onSideChange, wallet, solBal, tokenBal, tokenBalErr, position, supply, solPrice, onConnect, onTraded, toast, orders = [] }) {
  const [buyAmt, setBuyAmt] = useState('0.1');
  const [sellPct, setSellPct] = useState('50');
  const [slippage, setSlippage] = useState('10');
  const [prioFee, setPrioFee] = useState('0.0005');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState('market'); // market | limit
  const [trigger, setTrigger] = useState('');
  const [bracket, setBracket] = useState(false);
  const [tpX, setTpX] = useState('2');
  const [slPct, setSlPct] = useState('30');

  // remember trade settings in this browser
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const s = readTradeSettings();
    setSlippage(String(s.slippage));
    setPrioFee(String(s.prioFee));
    setBuyAmt(String(s.buyAmt));
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (loaded) saveTradeSettings({ slippage, prioFee, buyAmt });
  }, [loaded, slippage, prioFee, buyAmt]);

  useEffect(() => setError(''), [side, mint, mode]);
  useEffect(() => setTrigger(''), [side, mint]);

  // slippage or priority fee changed by voice
  useEffect(() => {
    const on = (e) => {
      if (e.detail?.slippage) setSlippage(String(e.detail.slippage));
      if (e.detail?.prioFee) setPrioFee(String(e.detail.prioFee));
    };
    window.addEventListener(SETTINGS_EVENT, on);
    return () => window.removeEventListener(SETTINGS_EVENT, on);
  }, []);

  const isBuy = side === 'buy';
  const sym = pair?.baseToken?.symbol || 'this coin';
  const quoteIsSol = pair?.quoteToken?.address === SOL_MINT;
  const priceNative = Number(pair?.priceNative);
  const priceUsd = Number(pair?.priceUsd);
  const buyNum = Number(buyAmt);
  const sellNum = Number(sellPct);

  // rough quote before fees and slippage
  let estimate = null;
  if (isBuy && buyNum > 0) {
    const tokens =
      quoteIsSol && priceNative > 0
        ? buyNum / priceNative
        : solPrice && priceUsd > 0
        ? (buyNum * solPrice) / priceUsd
        : null;
    if (tokens) estimate = `${fmtAmount(tokens)} ${sym}`;
  } else if (!isBuy && sellNum > 0 && tokenBal > 0) {
    const t = (tokenBal * Math.min(sellNum, 100)) / 100;
    const solOut =
      quoteIsSol && priceNative > 0 ? t * priceNative : solPrice && priceUsd > 0 ? (t * priceUsd) / solPrice : null;
    if (solOut) estimate = `${fmtSol(solOut)} SOL`;
  }
  const holdingUsd = tokenBal > 0 && priceUsd > 0 ? tokenBal * priceUsd : null;

  // limit orders trigger on market cap
  const mcNow = Number(pair?.marketCap ?? pair?.fdv) || null;
  const entryMc = position && position.avgEntry > 0 && solPrice && supply > 0 ? position.avgEntry * solPrice * supply : null;
  const targetMc = parseMc(trigger);
  const dir = targetMc && mcNow ? (targetMc >= mcNow ? 'above' : 'below') : null;
  const chips = isBuy
    ? [
        ['−20%', 0.8],
        ['−30%', 0.7],
        ['−50%', 0.5],
      ]
    : [
        ['2x', 2],
        ['3x', 3],
        ['5x', 5],
        ['−30%', 0.7],
      ];
  const chipBase = isBuy ? mcNow : entryMc || mcNow;
  const short = (v) => usd(v).replace('$', '');
  let limitHint = null;
  if (mode === 'limit' && targetMc && mcNow) {
    const verb = dir === 'below' ? 'falls to' : 'rises to';
    limitHint = isBuy
      ? `Buys ${buyNum || 0} SOL when the market cap ${verb} ${usd(targetMc)} (now ${usd(mcNow)}). Expires in 24h.`
      : `${dir === 'above' ? 'Take profit' : 'Stop loss'}: sells ${sellNum || 0}% when the market cap ${verb} ${usd(targetMc)} (now ${usd(mcNow)}).`;
  }

  async function placeLimit() {
    setError('');
    if (!wallet) return onConnect();
    if (isBuy && !(buyNum > 0 && buyNum <= 100)) return setError('Enter how much SOL to spend.');
    if (!isBuy && !(sellNum > 0 && sellNum <= 100)) return setError('Enter a percentage between 1 and 100.');
    if (!targetMc) return setError('Enter the market cap to trigger at, like 8K or 1.2M.');
    if (!mcNow) return setError("This coin's market cap isn't available yet.");
    if (Math.abs(targetMc / mcNow - 1) < 0.005) return setError('That is the current market cap. Use Market to trade now.');
    if (!isBuy) {
      let held = tokenBal;
      if (!(held > 0)) {
        try {
          held = (await loadHolding(wallet, mint)).amount;
        } catch {
          return setError(`Couldn't read your ${sym} balance. Try again in a moment.`);
        }
      }
      if (!(held > 0)) return setError(`You don't hold any ${sym}.`);
    } else if (solBal !== null && buyNum > solBal) {
      const fresh = await rpc('getBalance', [wallet, { commitment: 'confirmed' }])
        .then((x) => x.value / 1e9)
        .catch(() => solBal);
      if (buyNum > fresh) return setError(`Not enough SOL. You have ${fmtSol(fresh)} SOL.`);
    }
    try {
      const o = createOrder({
        wallet,
        mint,
        symbol: pair?.baseToken?.symbol,
        name: pair?.baseToken?.name,
        image: pair?.info?.imageUrl,
        type: isBuy ? 'buy' : 'sell',
        amountSol: isBuy ? buyNum : null,
        percent: isBuy ? null : sellNum,
        targetMc,
        dir,
        createdMc: mcNow,
        expiresInMs: isBuy ? DEFAULT_EXPIRY.buy : DEFAULT_EXPIRY.sell,
        slippage: Number(slippage),
        prioFee: Number(prioFee),
        source: 'panel',
      });
      setTrigger('');
      toast.show({ kind: 'success', title: `${o.type === 'buy' ? 'Limit buy' : dir === 'above' ? 'Take profit' : 'Stop loss'} placed`, detail: `${sym} at ${usd(targetMc)} market cap. Runs while Yapper is open.`, autoClose: 6000 });
    } catch (e) {
      setError(String(e?.message || "Couldn't place that order."));
    }
  }

  async function trade() {
    setError('');
    if (!wallet) {
      onConnect();
      return;
    }
    if (busy) return;
    if (isBuy) {
      if (!(buyNum > 0)) return setError('Enter how much SOL to spend.');
    } else {
      if (!(sellNum > 0) || sellNum > 100) return setError('Enter a percentage between 1 and 100.');
    }
    const slip = Number(slippage);
    if (!(slip >= 0.5) || slip > 50) return setError('Set slippage between 0.5% and 50%.');
    const fee = Number(prioFee);
    if (!(fee >= 0) || fee > 0.01) return setError('Set a priority fee between 0 and 0.01 SOL.');

    setBusy(true);
    try {
      if (!isBuy && !(tokenBal > 0)) {
        // the shown holding can lag a fresh buy, so ask the chain before saying no
        let fresh;
        try {
          fresh = (await loadHolding(wallet, mint)).amount;
        } catch (e) {
          return setError(`Couldn't read your ${sym} balance (${String(e?.message || 'unknown error').slice(0, 80)}). Try again in a moment.`);
        }
        if (!(fresh > 0)) return setError(`You don't hold any ${sym}.`);
        onTraded?.();
      }
      if (isBuy && solBal !== null && buyNum > solBal) {
        // the shown balance can lag a fresh deposit, so ask the chain before saying no
        const fresh = await rpc('getBalance', [wallet, { commitment: 'confirmed' }])
          .then((b) => b.value / 1e9)
          .catch(() => solBal);
        if (buyNum > fresh) return setError(`Not enough SOL. You have ${fmtSol(fresh)} SOL.`);
        onTraded?.();
      }
      const tp = isBuy && bracket && Number(tpX) > 1 ? { kind: 'multiple', value: Number(tpX) } : null;
      const sl = isBuy && bracket && Number(slPct) > 0 && Number(slPct) < 100 ? { kind: 'percent', value: -Number(slPct) } : null;
      if (isBuy && bracket && !tp && !sl) return setError('Set a take profit above 1x or a stop loss between 1% and 99%.');
      const res = await executeTrade({
        wallet,
        mint,
        side,
        amountSol: buyNum,
        percent: sellNum,
        symbol: pair?.baseToken?.symbol,
        slippage: slip,
        prioFee: fee,
        toast,
        onTraded,
        receiveHint: estimate,
      });
      if (tp || sl) {
        bracketAfterBuy(res, { wallet, mint, symbol: sym, name: pair?.baseToken?.name, image: pair?.info?.imageUrl, tp, sl, solPrice, fallbackMc: mcNow, source: 'panel' })
          .then((made) => {
            if (made.length) toast.show({ kind: 'success', title: 'Take profit / stop loss set', detail: made.map((o) => `${o.label} at ${usd(o.targetMc)}`).join(' · '), autoClose: 7000 });
          })
          .catch(() => {});
      }
    } finally {
      setBusy(false);
    }
  }

  const label = busy
    ? 'Processing…'
    : !wallet
    ? 'Connect wallet to trade'
    : mode === 'limit'
    ? isBuy
      ? `Place limit buy ${buyAmt || 0} SOL`
      : `Place ${dir === 'below' ? 'stop loss' : dir === 'above' ? 'take profit' : 'limit sell'} ${sellPct || 0}%`
    : isBuy
    ? `Buy ${buyAmt || 0} SOL`
    : `Sell ${sellPct || 0}%`;

  return (
    <section className="tp" aria-label="Trade">
      <div className="seg seg-trade" role="group" aria-label="Order side">
        <button type="button" className={isBuy ? 'on buy' : undefined} aria-pressed={isBuy} onClick={() => onSideChange('buy')}>
          Buy
        </button>
        <button type="button" className={!isBuy ? 'on sell' : undefined} aria-pressed={!isBuy} onClick={() => onSideChange('sell')}>
          Sell
        </button>
      </div>

      <div className="tp-modes" role="group" aria-label="Order type">
        {[
          ['market', 'Market'],
          ['limit', isBuy ? 'Limit' : 'TP / SL'],
        ].map(([id, text]) => (
          <button key={id} type="button" className={mode === id ? 'on' : undefined} aria-pressed={mode === id} onClick={() => setMode(id)}>
            {text}
          </button>
        ))}
      </div>

      <div className="tp-row">
        <label className="tp-label" htmlFor="tp-amount">
          {isBuy ? 'Amount' : 'Amount to sell'}
        </label>
        <span className="tp-bal">
          {isBuy ? (
            <>
              Balance <b>{solBal === null ? '—' : fmtSol(solBal)}</b> SOL
            </>
          ) : (
            <>
              Holding{' '}
              {tokenBal === null && tokenBalErr ? (
                <b className="tp-bal-err" title={tokenBalErr}>
                  can't read balance
                </b>
              ) : (
                <b>{tokenBal === null ? '—' : fmtAmount(tokenBal)}</b>
              )}{' '}
              {pair?.baseToken?.symbol || ''}
            </>
          )}
        </span>
      </div>

      <div className="field">
        <input
          id="tp-amount"
          inputMode="decimal"
          autoComplete="off"
          value={isBuy ? buyAmt : sellPct}
          onChange={(e) => {
            const v = clean(e.target.value);
            if (isBuy) setBuyAmt(v);
            else setSellPct(v);
            setError('');
          }}
        />
        <span className="field-suffix">{isBuy ? 'SOL' : '%'}</span>
      </div>

      <div className="presets">
        {(isBuy ? BUY_PRESETS : SELL_PRESETS).map((v) => {
          const on = isBuy ? buyAmt === v : sellPct === v;
          return (
            <button
              key={v}
              type="button"
              className={on ? 'on' : undefined}
              aria-pressed={on}
              onClick={() => {
                if (isBuy) setBuyAmt(v);
                else setSellPct(v);
                setError('');
              }}
            >
              {isBuy ? v : `${v}%`}
            </button>
          );
        })}
      </div>

      {mode === 'limit' && (
        <div className="tp-limit">
          <label className="tp-label" htmlFor="tp-trigger">
            {isBuy ? 'Buy when market cap reaches' : 'Sell when market cap reaches'}
          </label>
          <div className="field field-sm">
            <span className="field-suffix">$</span>
            <input
              id="tp-trigger"
              inputMode="decimal"
              autoComplete="off"
              placeholder={mcNow ? short(mcNow) : '8K'}
              value={trigger}
              onChange={(e) => {
                setTrigger(e.target.value.replace(/[^0-9.,kmbKMB]/g, '').slice(0, 12));
                setError('');
              }}
            />
            <span className="field-suffix">MC</span>
          </div>
          {chipBase ? (
            <div className="presets presets-sm">
              {chips.map(([text, mult]) => (
                <button key={text} type="button" onClick={() => setTrigger(short(chipBase * mult))} title={`${text} from ${!isBuy && entryMc ? 'your entry' : 'now'}`}>
                  {text}
                </button>
              ))}
            </div>
          ) : null}
          {!isBuy && <p className="tp-hint muted">{entryMc ? 'Multiples are from your average entry.' : 'Multiples are from the current market cap.'}</p>}
          {limitHint && <p className="tp-hint">{limitHint}</p>}
        </div>
      )}

      {mode === 'market' && isBuy && (
        <div className="tp-bracket">
          <label className="tp-check">
            <input type="checkbox" checked={bracket} onChange={(e) => setBracket(e.target.checked)} />
            Take profit / stop loss
          </label>
          {bracket && (
            <div className="tp-settings">
              <label className="mini-field">
                <span>TP</span>
                <input inputMode="decimal" value={tpX} onChange={(e) => setTpX(clean(e.target.value))} aria-label="Take profit multiple" />
                <span>x</span>
              </label>
              <label className="mini-field">
                <span>SL</span>
                <input inputMode="decimal" value={slPct} onChange={(e) => setSlPct(clean(e.target.value))} aria-label="Stop loss percent" />
                <span>% down</span>
              </label>
            </div>
          )}
        </div>
      )}

      <div className="tp-settings">
        <label className="mini-field">
          <span>Slippage</span>
          <input inputMode="decimal" value={slippage} onChange={(e) => setSlippage(clean(e.target.value))} />
          <span>%</span>
        </label>
        <label className="mini-field">
          <span>Priority</span>
          <input inputMode="decimal" value={prioFee} onChange={(e) => setPrioFee(clean(e.target.value))} />
          <span>SOL</span>
        </label>
      </div>

      {mode === 'market' && (
        <div className="tp-quote">
          <span>You get</span>
          <span>{estimate ? `≈ ${estimate}` : '—'}</span>
        </div>
      )}

      <button type="button" className={`btn btn-lg ${isBuy ? 'btn-buy' : 'btn-sell'}`} onClick={mode === 'limit' ? placeLimit : trade} disabled={busy}>
        {busy && <span className="spinner" aria-hidden="true" />}
        {label}
      </button>

      {error && (
        <p className="tp-error" role="alert">
          {error}
        </p>
      )}

      {wallet && (position || tokenBal > 0) && (
        <PositionCard position={position} tokenBal={tokenBal} holdingUsd={holdingUsd} symbol={pair?.baseToken?.symbol || ''} solPrice={solPrice} supply={supply} />
      )}

      {orders.length > 0 && (
        <div className="tp-orders">
          <span className="tp-label">Open orders</span>
          <OrdersList orders={orders} />
        </div>
      )}
    </section>
  );
}

// short SOL amounts so four fit side by side: 0.0076, 0.202, 1.25, 12.4
const solTxt = (v) => {
  const a = Math.abs(v);
  const n = a === 0 ? '0' : a < 0.01 ? a.toFixed(4) : a < 1 ? a.toFixed(3) : a < 100 ? a.toFixed(2) : a.toFixed(0);
  return `${n} SOL`;
};
const signed = (v) => (v > 0 ? '+' : v < 0 ? '−' : '');

// Bought / Sold / Holding / PnL, plus your average entry
function PositionCard({ position: p, tokenBal, holdingUsd, symbol, solPrice, supply }) {
  const tone = p && p.pnl > 0 ? 'up' : p && p.pnl < 0 ? 'down' : '';
  const entryUsd = p && solPrice ? p.avgEntry * solPrice : null;
  return (
    <div className="tp-pos" aria-label="Your position">
      <div className="tp-pos-grid">
        <div>
          <span>Bought</span>
          <b className="up">{p ? solTxt(p.boughtSol) : '—'}</b>
        </div>
        <div>
          <span>Sold</span>
          <b className="down">{p ? solTxt(p.soldSol) : '—'}</b>
        </div>
        <div>
          <span>Holding</span>
          <b>{holdingUsd !== null ? usd(holdingUsd) : tokenBal > 0 ? fmtAmount(tokenBal) : '—'}</b>
        </div>
        <div>
          <span>PnL</span>
          <b className={tone}>
            {p ? `${signed(p.pnl)}${solPrice ? usd(Math.abs(p.pnl) * solPrice) : solTxt(p.pnl)}` : '—'}
            {p && p.pnlPct !== null && <small> {pct(p.pnlPct)}</small>}
          </b>
        </div>
      </div>
      <div className="tp-pos-foot">
        <span>
          Avg entry{' '}
          <b>
            {entryUsd !== null && supply > 0 ? `${usd(entryUsd * supply)} MC` : p ? `${p.avgEntry.toPrecision(3)} SOL` : '—'}
          </b>
        </span>
        <span>
          {tokenBal > 0 ? (
            <>
              <b>{fmtAmount(tokenBal)}</b> {symbol}
            </>
          ) : (
            'Position closed'
          )}
          {p && p.pnl !== 0 ? <span className={tone}> {signed(p.pnl)}{solTxt(p.pnl)}</span> : null}
        </span>
      </div>
    </div>
  );
}
