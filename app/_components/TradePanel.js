'use client';

import { useEffect, useState } from 'react';
import { rpc, SOL_MINT } from '../_lib/chain';
import { amount as fmtAmount, sol as fmtSol, usd } from '../_lib/format';
import { executeTrade, readTradeSettings, saveTradeSettings } from '../_lib/trade';

const BUY_PRESETS = ['0.1', '0.25', '0.5', '1'];
const SELL_PRESETS = ['25', '50', '75', '100'];

function clean(v) {
  return v.replace(',', '.').replace(/[^0-9.]/g, '');
}

export default function TradePanel({ mint, pair, side, onSideChange, wallet, solBal, tokenBal, solPrice, onConnect, onTraded, toast }) {
  const [buyAmt, setBuyAmt] = useState('0.1');
  const [sellPct, setSellPct] = useState('50');
  const [slippage, setSlippage] = useState('10');
  const [prioFee, setPrioFee] = useState('0.0005');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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

  useEffect(() => setError(''), [side, mint]);

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
      if (!(tokenBal > 0)) return setError(`You don't hold any ${sym}.`);
    }
    const slip = Number(slippage);
    if (!(slip >= 0.5) || slip > 50) return setError('Set slippage between 0.5% and 50%.');
    const fee = Number(prioFee);
    if (!(fee >= 0) || fee > 0.01) return setError('Set a priority fee between 0 and 0.01 SOL.');

    setBusy(true);
    try {
      if (isBuy && solBal !== null && buyNum > solBal) {
        // the shown balance can lag a fresh deposit, so ask the chain before saying no
        const fresh = await rpc('getBalance', [wallet, { commitment: 'confirmed' }])
          .then((b) => b.value / 1e9)
          .catch(() => solBal);
        if (buyNum > fresh) return setError(`Not enough SOL. You have ${fmtSol(fresh)} SOL.`);
        onTraded?.();
      }
      await executeTrade({
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
    } finally {
      setBusy(false);
    }
  }

  const label = busy
    ? 'Processing…'
    : !wallet
    ? 'Connect wallet to trade'
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
              Holding <b>{tokenBal === null ? '—' : fmtAmount(tokenBal)}</b> {pair?.baseToken?.symbol || ''}
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

      <div className="tp-quote">
        <span>You get</span>
        <span>{estimate ? `≈ ${estimate}` : '—'}</span>
      </div>

      <button type="button" className={`btn btn-lg ${isBuy ? 'btn-buy' : 'btn-sell'}`} onClick={trade} disabled={busy}>
        {busy && <span className="spinner" aria-hidden="true" />}
        {label}
      </button>

      {error && (
        <p className="tp-error" role="alert">
          {error}
        </p>
      )}

      {wallet && tokenBal > 0 && (
        <div className="tp-position">
          <span>Your position</span>
          <span>
            <b>{fmtAmount(tokenBal)}</b> {pair?.baseToken?.symbol || ''}
            {holdingUsd !== null && <span className="muted"> {usd(holdingUsd)}</span>}
          </span>
        </div>
      )}
    </section>
  );
}
