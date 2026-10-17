// One trade path used by both the trade panel and voice commands.
// The server builds the transaction (PumpPortal). A built-in wallet checks
// and signs it right here; a wallet app shows its approval popup. We send it
// through our RPC proxy and report each step as a toast.

import { VersionedTransaction } from '@solana/web3.js';
import { rpc, b64ToBytes, bytesToB64, waitForConfirm } from './chain';
import { ensureUnlocked, getState, signAs, signerKind, b58encode } from './wallets';
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
// Returns { status, sig, error, fill }:
//   ok        confirmed on chain; `fill` is a promise for the trade as read back
//   failed    landed on chain but failed (usually slippage); nothing was bought or sold
//   pending   sent, but not confirmed yet (may still land; check `sig` later)
//   cancelled the user said no (wallet popup or unlock)
//   error     never sent (nothing can have happened)
// beforeSend(sig, { blockhash }) runs right before the signed transaction goes
// out (sig is its id; once the blockhash expires it can never land); returning
// false stops it there, with nothing sent.
export async function executeTrade({ wallet, mint, side, amountSol, percent, symbol, slippage, prioFee, toast, onTraded, receiveHint, beforeSend }) {
  const isBuy = side === 'buy';
  const sym = symbol || 'this coin';
  const settings = readTradeSettings();
  const slip = cleanSlippage(slippage ?? settings.slippage);
  const fee = cleanPrioFee(prioFee ?? settings.prioFee);
  const kind = signerKind(wallet);
  const local = kind === 'local';

  let stage = 'prepare'; // prepare | unlock | sign | send
  let sig = null;
  const id = toast.show({
    kind: 'pending',
    title: isBuy ? `Buying ${sym}` : `Selling ${sym}`,
    detail: local && !getState().unlocked ? 'Unlock your wallets to continue' : 'Preparing the transaction',
  });

  const succeeded = () => {
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
  };
  const landedButFailed = () => {
    toast.update(id, {
      kind: 'error',
      title: isBuy ? 'Buy failed' : 'Sell failed',
      detail: 'The price moved past your slippage limit. Raise slippage or try again.',
      sig,
      autoClose: 15000,
    });
    return { status: 'failed', sig, error: 'The price moved past the slippage limit', fill: Promise.resolve(null) };
  };
  const notYetConfirmed = () => {
    toast.update(id, {
      kind: 'pending',
      title: 'Still confirming',
      detail: 'Solana is slow right now. Open the transaction to check its status before trying again.',
      sig,
      autoClose: 15000,
    });
    return { status: 'pending', sig, fill: Promise.resolve(null) };
  };

  try {
    if (!wallet || !kind) throw new Error('Connect a wallet first.');
    if (local) {
      stage = 'unlock';
      await ensureUnlocked();
      stage = 'prepare';
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
    stage = 'sign';
    const signed = await signAs(wallet, tx, kind);
    // the signature is the transaction's id: known before it's sent
    sig = b58encode(signed.signatures[0]);

    if (beforeSend && beforeSend(sig, { blockhash: signed.message?.recentBlockhash || tx.message?.recentBlockhash || null }) === false) throw new Error('Cancelled before sending');
    toast.update(id, { detail: 'Sending to Solana' });
    stage = 'send';
    rememberCoin(wallet, mint); // balance reads check this coin's accounts directly from now on
    await rpc('sendTransaction', [
      bytesToB64(signed.serialize()),
      // built-in wallets just simulated it in checkTrade, so skip the second simulation
      { encoding: 'base64', skipPreflight: local, preflightCommitment: 'confirmed', maxRetries: 3 },
    ]);

    toast.update(id, { detail: 'Waiting for confirmation', sig });
    const ok = await waitForConfirm(sig);
    onTraded?.();
    if (ok === true) return succeeded();
    if (ok === false) return landedButFailed();
    return notYetConfirmed();
  } catch (e) {
    const msg = String(e?.message || e);
    if (stage === 'send' && sig && !e?.rejected) {
      // the send errored, but it may still have reached the network: look it up
      // before calling it failed, so nobody sends the same trade twice
      // (a node that answered with an error refused it, so that's a plain error)
      toast.update(id, { detail: 'Checking whether it went through', sig });
      const ok = await waitForConfirm(sig, 75000, { history: true });
      onTraded?.();
      if (ok === true) return succeeded();
      if (ok === false) return landedButFailed();
      return notYetConfirmed();
    }
    // only the wallet popup or the unlock prompt can be "cancelled"
    const cancelled = (stage === 'sign' || stage === 'unlock') && /reject|denied|declin|cancel/i.test(msg);
    toast.update(id, {
      kind: cancelled ? 'info' : 'error',
      title: cancelled ? 'Transaction cancelled' : isBuy ? 'Buy failed' : 'Sell failed',
      detail: cancelled ? null : msg.slice(0, 180),
      autoClose: cancelled ? 4000 : 12000,
    });
    return { status: cancelled ? 'cancelled' : 'error', error: msg.slice(0, 180), fill: Promise.resolve(null) };
  }
}
