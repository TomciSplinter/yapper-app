// Solana helpers: addresses, RPC through our server proxy, wallet provider.

export const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// Accepts a bare CA or a pump.fun / dexscreener / solscan URL and returns the CA.
export function extractMint(input) {
  const s = (input || '').trim();
  if (B58.test(s)) return s;
  const parts = s.split(/[/?#&=]/).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) if (B58.test(parts[i])) return parts[i];
  return null;
}

/* RPC health, shown in the status bar */

const health = { latency: null, okAt: 0, errAt: 0 };
const listeners = new Set();

function emit() {
  const snap = { ...health };
  for (const fn of listeners) fn(snap);
}

export function getRpcHealth() {
  return { ...health };
}

export function onRpcHealth(fn) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export async function rpc(method, params) {
  const t0 = nowMs();
  let r;
  try {
    r = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  } catch {
    health.errAt = Date.now();
    emit();
    throw new Error('Network error. Check your internet connection.');
  }
  let j = null;
  try {
    j = await r.json();
  } catch {}
  if (r.status >= 500 || !j) {
    health.errAt = Date.now();
    emit();
    throw new Error(j?.error?.message || `Solana RPC error (${r.status})`);
  }
  health.latency = Math.round(nowMs() - t0);
  health.okAt = Date.now();
  emit();
  if (j.error) {
    // the node answered and refused (for sendTransaction: nothing was sent)
    const err = new Error(j.error.message || 'Solana RPC error');
    err.code = j.error.code;
    err.rejected = true;
    throw err;
  }
  return j.result;
}

// Several RPC calls in one request, answered from the same moment on the node.
// calls: [[method, params], ...]. Returns the results in the same order.
export async function rpcBatch(calls) {
  const t0 = nowMs();
  let r;
  try {
    r = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(calls.map(([method, params], id) => ({ jsonrpc: '2.0', id, method, params }))),
    });
  } catch {
    health.errAt = Date.now();
    emit();
    throw new Error('Network error. Check your internet connection.');
  }
  let j = null;
  try {
    j = await r.json();
  } catch {}
  if (r.status >= 500 || !Array.isArray(j)) {
    health.errAt = Date.now();
    emit();
    throw new Error(j?.error?.message || `Solana RPC error (${r.status})`);
  }
  health.latency = Math.round(nowMs() - t0);
  health.okAt = Date.now();
  emit();
  return calls.map((_, i) => {
    const item = j.find((x) => x && x.id === i);
    if (!item || item.error) throw new Error(item?.error?.message || 'Solana RPC error');
    return item.result;
  });
}

// Like rpcBatch, but one failed call doesn't fail the rest:
// returns [{ ok: true, result } | { ok: false, error }, ...].
export async function rpcBatchSettled(calls) {
  const r = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(calls.map(([method, params], id) => ({ jsonrpc: '2.0', id, method, params }))),
  }).catch(() => null);
  if (!r) throw new Error('Network error. Check your internet connection.');
  const j = await r.json().catch(() => null);
  if (!Array.isArray(j)) throw new Error(j?.error?.message || `Solana RPC error (${r.status})`);
  return calls.map((_, i) => {
    const item = j.find((x) => x && x.id === i);
    return item && !item.error ? { ok: true, result: item.result } : { ok: false, error: item?.error?.message || 'Solana RPC error' };
  });
}

// Confirmed transactions by signature (10 per request); missing ones are left out.
// gapMs spaces the requests out for long backfills (RPC rate limits).
export async function getTransactions(sigs, { gapMs = 0 } = {}) {
  const out = new Map();
  for (let i = 0; i < sigs.length; i += 10) {
    if (i && gapMs) await new Promise((r) => setTimeout(r, gapMs));
    const chunk = sigs.slice(i, i + 10);
    const res = await rpcBatchSettled(
      chunk.map((s) => ['getTransaction', [s, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]])
    ).catch(() => chunk.map(() => ({ ok: false })));
    res.forEach((r, j) => {
      if (r.ok && r.result) out.set(chunk[j], r.result);
    });
  }
  return out;
}

// All account addresses of a transaction from getTransaction (json encoding)
export function txAccountKeys(tx) {
  const msg = tx?.transaction?.message || {};
  const meta = tx?.meta || {};
  return [
    ...(msg.accountKeys || []).map((k) => (typeof k === 'string' ? k : k?.pubkey)),
    ...(meta.loadedAddresses?.writable || []),
    ...(meta.loadedAddresses?.readonly || []),
  ];
}

export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function getProvider() {
  if (typeof window === 'undefined') return null;
  if (window.phantom?.solana?.isPhantom) return window.phantom.solana;
  if (window.solana?.isPhantom) return window.solana;
  if (window.solflare?.isSolflare) return window.solflare;
  if (window.backpack?.solana) return window.backpack.solana;
  return null;
}

// Polls a signature. Returns true (confirmed), false (failed) or null (timed out).
// true = confirmed, false = landed but failed, null = not seen within timeoutMs
export async function waitForConfirm(sig, timeoutMs = 60000, { history = false } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: history }]);
      const s = r?.value?.[0];
      if (s) {
        if (s.err) return false;
        if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') return true;
      }
    } catch {}
    await new Promise((res) => setTimeout(res, 1500));
  }
  return null;
}

// Status of several sent transactions:
//   sig -> 'ok' | 'failed' | 'landing' (in a block, not confirmed yet) | 'unknown' (not seen)
export async function signatureStates(sigs) {
  const out = new Map();
  const list = [...new Set(sigs.filter(Boolean))];
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    const r = await rpc('getSignatureStatuses', [chunk, { searchTransactionHistory: true }]);
    (r?.value || []).forEach((st, j) => {
      const ok = st && !st.err && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized');
      out.set(chunk[j], st?.err ? 'failed' : ok ? 'ok' : st ? 'landing' : 'unknown');
    });
  }
  return out;
}

// Can a transaction built on this blockhash still land? false means never.
export async function blockhashValid(blockhash) {
  const r = await rpc('isBlockhashValid', [blockhash, { commitment: 'confirmed' }]);
  return r?.value === true;
}
