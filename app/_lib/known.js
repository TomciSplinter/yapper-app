// Coins this wallet traded and the token accounts they landed in, remembered
// in this browser. Balance reads check these addresses directly, so a coin
// still shows up even if the RPC's token-account index misses it (or lists
// it late). Filled in by Yapper trades and by reading the wallet's own
// transactions (history.js), which also covers trades made in other apps.

const KEY = (w) => `yapper:known:v1:${w}`;
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

// entries: [[mint, [token account addresses]], ...] -> one write
export function rememberCoins(wallet, entries) {
  if (!wallet || !entries?.length) return;
  const all = read(wallet);
  const now = Date.now();
  for (const [mint, accounts = []] of entries) {
    if (!mint || mint === WSOL) continue;
    const cur = all[mint] || { at: 0, accounts: [] };
    const merged = [...new Set([...(cur.accounts || []), ...accounts.filter(Boolean)])].slice(-6);
    all[mint] = { at: now, accounts: merged };
  }
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

// mint -> { at: last seen, accounts: [token account addresses] }
export function rememberCoin(wallet, mint, accounts = []) {
  rememberCoins(wallet, [[mint, accounts]]);
}

export function knownAccounts(wallet, mint) {
  return (read(wallet)[mint]?.accounts || []).slice();
}

export function knownMints(wallet) {
  return Object.keys(read(wallet));
}
