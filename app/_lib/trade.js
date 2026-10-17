// One trade path used by both the trade panel and voice commands.
// The server builds the transaction (PumpPortal). A built-in wallet checks
// and signs it right here; a wallet app shows its approval popup. We send it
// through our RPC proxy and report each step as a toast.

import { VersionedTransaction } from '@solana/web3.js';
import { rpc, b64ToBytes, bytesToB64, waitForConfirm } from './chain';
import { ensureUnlocked, getState, signAs, signerKind } from './wallets';
import { checkTrade } from './guard';
import { recordTrade } from './fills';
import { rememberCoin } from './known';
import { announce, getPrefs } from './voicebus';
import { amount as fmtAmount, sol as fmtSol } from './format';

const SETTINGS_KEY = 'yapper:trade-settings';
const DEFAULTS = { slippage: '10', prioFee: '0.0005', buyAmt: '0.1' };

export function readTradeSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveTradeSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...readTradeSettings(), ...s }));
  } catch {}
}

// The exact values sent to the server and checked by the guard (the server clamps the same way).
function cleanSlippage(v) {
  const n = Number(v);
  return n > 0 ? Math.min(Math.max(n, 0.5), 50) : Number(DEFAULTS.slippage);
}
function cleanPrioFee(v) {
  const n = v === '' || v === null || v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 0.01) : Number(DEFAULTS.prioFee);
}

// Say what a finished trade did ("Bought 1.8M QUENTRA for 0.1 SOL").
function speakFill(fill, { isBuy, sym, percent }) {
  const p = getPrefs();
  if (p.muted || !p.speakTrades || !fill || !(Math.abs(fill.tokens) > 0)) return;
  const text = isBuy
    ? `Bought ${fmtAmount(Math.abs(fill.tokens))} ${sym} for ${fmtSol(Math.abs(fill.sol))} SOL.`
    : `Sold ${percent ? `${percent}% of your ` : ''}${sym} for ${fmtSol(Math.abs(fill.sol))} SOL.`;
  announce({ kind: 'trade', text, mint: fill.mint, symbol: sym, quiet: true });
}

// side: 'buy' | 'sell'. Buys use amountSol, sells use percent (1-100).
// Returns { status: 'ok' | 'failed' | 'pending' | 'cancelled' | 'error', sig, error, fill }
// where `fill` is a promise for the trade as read back from the chain (or null).
export async function executeTrade({ wallet, mint, side, amountSol, percent, symbol, slippage, prioFee, toast, onTraded, receiveHint }) {
  const isBuy = side === 'buy';
  const sym = symbol || 'this coin';
  const settings = readTradeSettings();
  const slip = cleanSlippage(slippage ?? settings.slippage);
  const fee = cleanPrioFee(prioFee ?? settings.prioFee);
  const kind = signerKind(wallet);
  const local = kind === 'local';

  let sending = false; // past this point the trade may have reached the chain
  const id = toast.show({
    kind: 'pending',
    title: isBuy ? `Buying ${sym}` : `Selling ${sym}`,
    detail: local && !getState().unlocked ? 'Unlock your wallets to continue' : 'Preparing the transaction',
  });
  try {
    if (!wallet || !kind) throw new Error('Connect a wallet first.');
    if (local) {
      await ensureUnlocked();
      toast.update(id, { detail: 'Preparing the transaction' });
    }
    const r = await fetch('/api/trade', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        publicKey: wallet,
        mint,
        action: side,
        amount: isBuy ? Number(amountSol) : `${Number(percent)}%`,
        slippage: slip,
        priorityFee: fee,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.tx) throw new Error(j.error || 'Could not prepare the transaction. Try again.');

    const tx = VersionedTransaction.deserialize(b64ToBytes(j.tx));
    if (local) {
      toast.update(id, { detail: 'Checking the transaction' });
      await checkTrade(tx, { wallet, mint, side, amountSol, percent, slippage: slip, prioFee: fee });
    } else {
      toast.update(id, { detail: 'Approve it in your wallet' });
    }
    // signs only with the kind of wallet that was checked above
    const signed = await signAs(wallet, tx, kind);

    toast.update(id, { detail: 'Sending to Solana' });
    sending = true;
    const sig = await rpc('sendTransaction', [
      bytesToB64(signed.serialize()),
      // built-in wallets just simulated it in checkTrade, so skip the second simulation
      { encoding: 'base64', skipPreflight: local, preflightCommitment: 'confirmed', maxRetries: 3 },
    ]);

    rememberCoin(wallet, mint); // balance reads check this coin's accounts directly from now on
    toast.update(id, { detail: 'Waiting for confirmation', sig });
    const ok = await waitForConfirm(sig);
    onTraded?.();
    if (ok === true) {
      // read the confirmed trade from the chain: feeds avg entry, PnL and chart
      // markers, and catches the rare case where the coins didn't land here
      const fill = recordTrade(wallet, mint, sig)
        .then((f) => {
          onTraded?.();
          if (f && isBuy && !(f.tokens > 0)) {
            toast.show({
              kind: 'error',
              title: `The ${sym} buy confirmed, but no coins arrived in this wallet`,
              detail: 'Open the transaction to see where they went, and send it to support.',
              sig,
              autoClose: 30000,
            });
          } else if (f) {
            speakFill(f, { isBuy, sym, percent });
          }
          return f;
        })
        .catch(() => null);
      toast.update(id, {
        kind: 'success',
        title: isBuy ? `Bought ${sym}` : `Sold ${percent}% of ${sym}`,
        detail: isBuy ? `Spent ${amountSol} SOL` : receiveHint ? `Received about ${receiveHint}` : null,
        sig,
        autoClose: 8000,
      });
      try {
        window.dispatchEvent(new CustomEvent('yapper:traded', { detail: { wallet, mint, side, percent: isBuy ? null : Number(percent) } }));
      } catch {}
      return { status: 'ok', sig, fill };
    }
    if (ok === false) {
      toast.update(id, {
        kind: 'error',
        title: isBuy ? 'Buy failed' : 'Sell failed',
        detail: 'The price moved past your slippage limit. Raise slippage or try again.',
        sig,
        autoClose: 15000,
      });
      return { status: 'failed', sig, error: 'The price moved past the slippage limit', fill: Promise.resolve(null) };
    }
    toast.update(id, {
      kind: 'pending',
      title: 'Still confirming',
      detail: 'Solana is slow right now. Open the transaction to check its status.',
      sig,
      autoClose: 15000,
    });
    return { status: 'pending', sig, fill: Promise.resolve(null) };
  } catch (e) {
    const msg = String(e?.message || e);
    const cancelled = /reject|denied|cancel/i.test(msg);
    toast.update(id, {
      kind: cancelled ? 'info' : 'error',
      title: cancelled ? 'Transaction cancelled' : isBuy ? 'Buy failed' : 'Sell failed',
      detail: cancelled ? null : msg.slice(0, 180),
      autoClose: cancelled ? 4000 : 12000,
    });
    return { status: cancelled ? 'cancelled' : 'error', error: msg.slice(0, 180), maybeSent: sending && !cancelled && /Network error|Solana RPC error \(/.test(msg), fill: Promise.resolve(null) };
  }
}
