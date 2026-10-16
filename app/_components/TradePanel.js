'use client';

import { useEffect, useState } from 'react';
import { VersionedTransaction } from '@solana/web3.js';
import { rpc, getProvider, b64ToBytes, bytesToB64, waitForConfirm, SOL_MINT } from '../_lib/chain';
import { amount as fmtAmount, sol as fmtSol, usd } from '../_lib/format';

const BUY_PRESETS = ['0.1', '0.25', '0.5', '1'];
const SELL_PRESETS = ['25', '50', '75', '100'];
const SETTINGS_KEY = 'yapper:trade-settings';

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
  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      if (s.slippage) setSlippage(String(s.slippage));
      if (s.prioFee) setPrioFee(String(s.prioFee));
      if (s.buyAmt) setBuyAmt(String(s.buyAmt));
    } catch {}
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ slippage, prioFee, buyAmt }));
    } catch {}
  }, [slippage, prioFee, buyAmt]);

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
    const provider = getProvider();
    if (!provider) {
      onConnect();
      return;
    }
    if (isBuy) {
      if (!(buyNum > 0)) return setError('Enter how much SOL to spend.');
      if (solBal !== null && buyNum > solBal) return setError(`Not enough SOL. You have ${fmtSol(solBal)} SOL.`);
    } else {
      if (!(sellNum > 0) || sellNum > 100) return setError('Enter a percentage between 1 and 100.');
      if (!(tokenBal > 0)) return setError(`You don't hold any ${sym}.`);
    }
    const slip = Number(slippage);
    if (!(slip >= 0.5) || slip > 50) return setError('Set slippage between 0.5% and 50%.');
    const fee = Number(prioFee);
    if (!(fee >= 0) || fee > 0.01) return setError('Set a priority fee between 0 and 0.01 SOL.');

    setBusy(true);
    const id = toast.show({ kind: 'pending', title: isBuy ? `Buying ${sym}` : `Selling ${sym}`, detail: 'Preparing the transaction' });
    try {
      const r = await fetch('/api/trade', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          publicKey: wallet,
          mint,
          action: side,
          amount: isBuy ? buyNum : `${sellNum}%`,
          slippage: slip,
          priorityFee: fee,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.tx) throw new Error(j.error || 'Could not prepare the transaction. Try again.');

      const tx = VersionedTransaction.deserialize(b64ToBytes(j.tx));
      toast.update(id, { detail: 'Approve it in your wallet' });
      const signed = await provider.signTransaction(tx);

      toast.update(id, { detail: 'Sending to Solana' });
      const sig = await rpc('sendTransaction', [
        bytesToB64(signed.serialize()),
        { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 },
      ]);

      toast.update(id, { detail: 'Waiting for confirmation', sig });
      const ok = await waitForConfirm(sig);
      if (ok === true) {
        toast.update(id, {
          kind: 'success',
          title: isBuy ? `Bought ${sym}` : `Sold ${sellNum}% of ${sym}`,
          detail: isBuy ? `Spent ${buyNum} SOL` : estimate ? `Received about ${estimate}` : null,
          sig,
          autoClose: 8000,
        });
      } else if (ok === false) {
        toast.update(id, {
          kind: 'error',
          title: isBuy ? 'Buy failed' : 'Sell failed',
          detail: 'The price moved past your slippage limit. Raise slippage or try again.',
          sig,
          autoClose: 15000,
        });
      } else {
        toast.update(id, {
          kind: 'pending',
          title: 'Still confirming',
          detail: 'Solana is slow right now. Open the transaction to check its status.',
          sig,
          autoClose: 15000,
        });
      }
      onTraded();
    } catch (e) {
      const msg = String(e?.message || e);
      const cancelled = /reject|denied|cancel/i.test(msg);
      toast.update(id, {
        kind: cancelled ? 'info' : 'error',
        title: cancelled ? 'Transaction cancelled' : isBuy ? 'Buy failed' : 'Sell failed',
        detail: cancelled ? null : msg.slice(0, 180),
        autoClose: cancelled ? 4000 : 12000,
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
