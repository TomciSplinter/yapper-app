// One trade path used by both the trade panel and voice commands.
// The server builds the transaction (PumpPortal), the user's wallet signs it,
// we send it through our RPC proxy and report each step as a toast.

import { VersionedTransaction } from '@solana/web3.js';
import { rpc, getProvider, b64ToBytes, bytesToB64, waitForConfirm } from './chain';

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

// side: 'buy' | 'sell'. Buys use amountSol, sells use percent (1-100).
// Returns 'ok' | 'failed' | 'pending' | 'cancelled' | 'error'.
export async function executeTrade({ wallet, mint, side, amountSol, percent, symbol, slippage, prioFee, toast, onTraded, receiveHint }) {
  const isBuy = side === 'buy';
  const sym = symbol || 'this coin';
  const settings = readTradeSettings();
  const slip = Number(slippage ?? settings.slippage);
  const fee = Number(prioFee ?? settings.prioFee);
  const provider = getProvider();

  const id = toast.show({ kind: 'pending', title: isBuy ? `Buying ${sym}` : `Selling ${sym}`, detail: 'Preparing the transaction' });
  try {
    if (!provider || !wallet) throw new Error('Connect your wallet first.');
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
    toast.update(id, { detail: 'Approve it in your wallet' });
    const signed = await provider.signTransaction(tx);

    toast.update(id, { detail: 'Sending to Solana' });
    const sig = await rpc('sendTransaction', [
      bytesToB64(signed.serialize()),
      { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 },
    ]);

    toast.update(id, { detail: 'Waiting for confirmation', sig });
    const ok = await waitForConfirm(sig);
    onTraded?.();
    if (ok === true) {
      toast.update(id, {
        kind: 'success',
        title: isBuy ? `Bought ${sym}` : `Sold ${percent}% of ${sym}`,
        detail: isBuy ? `Spent ${amountSol} SOL` : receiveHint ? `Received about ${receiveHint}` : null,
        sig,
        autoClose: 8000,
      });
      return 'ok';
    }
    if (ok === false) {
      toast.update(id, {
        kind: 'error',
        title: isBuy ? 'Buy failed' : 'Sell failed',
        detail: 'The price moved past your slippage limit. Raise slippage or try again.',
        sig,
        autoClose: 15000,
      });
      return 'failed';
    }
    toast.update(id, {
      kind: 'pending',
      title: 'Still confirming',
      detail: 'Solana is slow right now. Open the transaction to check its status.',
      sig,
      autoClose: 15000,
    });
    return 'pending';
  } catch (e) {
    const msg = String(e?.message || e);
    const cancelled = /reject|denied|cancel/i.test(msg);
    toast.update(id, {
      kind: cancelled ? 'info' : 'error',
      title: cancelled ? 'Transaction cancelled' : isBuy ? 'Buy failed' : 'Sell failed',
      detail: cancelled ? null : msg.slice(0, 180),
      autoClose: cancelled ? 4000 : 12000,
    });
    return cancelled ? 'cancelled' : 'error';
  }
}
