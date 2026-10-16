import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { rpc } from './chain';

// Re-renders every `ms` so relative times ("12s") stay fresh.
export function useNow(ms) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// Toast notifications. Returns [items, api]; api is stable across renders.
export function useToasts() {
  const [items, setItems] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setItems((xs) => xs.filter((t) => t.id !== id));
  }, []);

  const schedule = useCallback(
    (id, ms) => {
      clearTimeout(timers.current.get(id));
      timers.current.delete(id);
      if (ms) timers.current.set(id, setTimeout(() => dismiss(id), ms));
    },
    [dismiss]
  );

  const show = useCallback(
    (t) => {
      const id = Math.random().toString(36).slice(2);
      setItems((xs) => [...xs.slice(-3), { id, ...t }]);
      schedule(id, t.autoClose);
      return id;
    },
    [schedule]
  );

  const update = useCallback(
    (id, patch) => {
      setItems((xs) => xs.map((t) => (t.id === id ? { ...t, ...patch } : t)));
      schedule(id, patch.autoClose);
    },
    [schedule]
  );

  const api = useMemo(() => ({ show, update, dismiss }), [show, update, dismiss]);
  return [items, api];
}

// Token accounts owned by these program authorities are liquidity pool vaults.
const POOL_AUTHORITIES = new Set([
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium AMM v4
  'GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL', // Raydium CPMM
]);

function isProgramOwned(owner) {
  try {
    return !PublicKey.isOnCurve(new PublicKey(owner).toBytes());
  } catch {
    return false;
  }
}

// Top 20 holders of a token, with pools and program accounts labelled.
export function useHolders(mint, pairAddress, enabled) {
  const [state, setState] = useState({ loading: true, rows: null, top10Pct: null, error: '' });

  useEffect(() => {
    // clear the previous coin's holders straight away
    setState({ loading: true, rows: null, top10Pct: null, error: '' });
    if (!mint || !enabled) return;
    let cancelled = false;
    let timer;

    async function load(first) {
      if (first || !document.hidden) {
        try {
          const [largest, supply] = await Promise.all([
            rpc('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]),
            rpc('getTokenSupply', [mint, { commitment: 'confirmed' }]),
          ]);
          const accs = (largest?.value || []).filter((a) => Number(a.uiAmountString ?? a.uiAmount) > 0);
          const total = Number(supply?.value?.uiAmountString ?? supply?.value?.uiAmount) || 0;
          let owners = [];
          if (accs.length) {
            const info = await rpc('getMultipleAccounts', [
              accs.map((a) => a.address),
              { encoding: 'jsonParsed', commitment: 'confirmed' },
            ]);
            owners = (info?.value || []).map((v) => v?.data?.parsed?.info?.owner || null);
          }
          if (cancelled) return;
          const rows = accs.map((a, i) => {
            const amt = Number(a.uiAmountString ?? a.uiAmount) || 0;
            const owner = owners[i] || null;
            let kind = null;
            if (owner && (owner === pairAddress || POOL_AUTHORITIES.has(owner))) kind = 'pool';
            else if (owner && isProgramOwned(owner)) kind = 'program';
            return { account: a.address, owner, amount: amt, pct: total ? (amt / total) * 100 : null, kind };
          });
          const top10 = rows
            .filter((r) => !r.kind)
            .slice(0, 10)
            .reduce((s, r) => s + (r.pct || 0), 0);
          setState({ loading: false, rows, top10Pct: total ? top10 : null, error: '' });
        } catch {
          if (!cancelled) {
            setState((s) => ({ ...s, loading: false, error: s.rows ? '' : 'Holder data is not available right now.' }));
          }
        }
      }
      if (!cancelled) timer = setTimeout(() => load(false), 60000);
    }

    load(true);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mint, pairAddress, enabled]);

  return state;
}
