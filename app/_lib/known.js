// Coins this wallet traded and the token accounts they landed in, remembered
// in this browser. Balance reads check these addresses directly, so a coin
// still shows up even if the RPC's token-account index misses it (or lists
// it late). Learned from Yapper trades and from the wallet's own recent
// transactions (scanWallet), which also covers trades made in other apps.

import { rpc, getTransactions, txAccountKeys } from './chain';

const KEY = (w) => `yapper:known:v1:${w}`;
const SCAN_KEY = (w) => `yapper:scanned:v1:${w}`;
const SCAN_EVERY = 20000;
const SCAN_DEPTH = 25;
const MAX_MINTS = 300;
const WSOL = 'So11111111111111111111111111111111111111112';

function read(wallet) {
  try {
    const v = JSON.parse(localStorage.getItem(KEY(wallet)) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

// mint -> { at: last trade time, accounts: [token account addresses] }
export function rememberCoin(wallet, mint, accounts = []) {
  if (!wallet || !mint) return;
  const all = read(wallet);
  const cur = all[mint] || { at: 0, accounts: [] };
  const merged = [...new Set([...(cur.accounts || []), ...accounts.filter(Boolean)])].slice(-6);
  all[mint] = { at: Date.now(), accounts: merged };
  const mints = Object.keys(all);
  if (mints.length > MAX_MINTS) {
    mints
      .sort((a, b) => (all[a].at || 0) - (all[b].at || 0))
      .slice(0, mints.length - MAX_MINTS)
      .forEach((m) => delete all[m]);
  }
  try {
    localStorage.setItem(KEY(wallet), JSON.stringify(all));
  } catch {}
}

export function knownAccounts(wallet, mint) {
  return (read(wallet)[mint]?.accounts || []).slice();
}

export function knownMints(wallet) {
  return Object.keys(read(wallet));
}

// Read the wallet's latest transactions (only ones not seen before) and
// remember every coin account they touched. Returns the mints it learned.
const lastScan = new Map();
const running = new Map();
export function scanWallet(wallet) {
  if (!wallet) return Promise.resolve([]);
  if (running.has(wallet)) return running.get(wallet);
  if (Date.now() - (lastScan.get(wallet) || 0) < SCAN_EVERY) return Promise.resolve([]);
  lastScan.set(wallet, Date.now());
  const job = (async () => {
    let seen = [];
    try {
      seen = JSON.parse(localStorage.getItem(SCAN_KEY(wallet)) || '[]');
      if (!Array.isArray(seen)) seen = [];
    } catch {}
    const sigs = (await rpc('getSignaturesForAddress', [wallet, { limit: SCAN_DEPTH, commitment: 'confirmed' }])) || [];
    const fresh = sigs.filter((x) => x?.signature && !x.err && !seen.includes(x.signature)).map((x) => x.signature);
    const learned = new Set();
    if (fresh.length) {
      const txs = await getTransactions(fresh);
      for (const [sig, tx] of txs) {
        const keys = txAccountKeys(tx);
        const byMint = new Map();
        for (const b of [...(tx?.meta?.preTokenBalances || []), ...(tx?.meta?.postTokenBalances || [])]) {
          if (b?.owner !== wallet || !b.mint || b.mint === WSOL || !keys[b.accountIndex]) continue;
          if (!byMint.has(b.mint)) byMint.set(b.mint, new Set());
          byMint.get(b.mint).add(keys[b.accountIndex]);
        }
        for (const [m, accs] of byMint) {
          rememberCoin(wallet, m, [...accs]);
          learned.add(m);
        }
        seen.push(sig);
      }
      try {
        localStorage.setItem(SCAN_KEY(wallet), JSON.stringify(seen.slice(-200)));
      } catch {}
    }
    return [...learned];
  })().finally(() => running.delete(wallet));
  running.set(wallet, job);
  return job;
}
