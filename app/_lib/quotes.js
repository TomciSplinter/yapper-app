// Live market caps for a handful of coins (orders, alerts, callouts).
// DexScreener first; coins it doesn't list yet (brand-new pump.fun coins)
// are priced straight from their bonding curve on the chain.

import { PublicKey } from '@solana/web3.js';
import { rpc, b64ToBytes } from './chain';
import { dexPatch } from './pump';
import { progressFromReserves, PUMP_SUPPLY } from './bonding';

const DS = 'https://api.dexscreener.com';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const u64 = (d, o) => {
  let v = 0;
  for (let i = 7; i >= 0; i--) v = v * 256 + d[o + i];
  return v;
};

export function curveAddress(mint) {
  try {
    return PublicKey.findProgramAddressSync([new TextEncoder().encode('bonding-curve'), new PublicKey(mint).toBytes()], new PublicKey(PUMP))[0].toBase58();
  } catch {
    return null;
  }
}

// mint -> { mc, priceUsd, priceSol, supply, curve, migrated, progress, symbol, name, image, pool, dex }
export async function getQuotes(mints, solPrice) {
  const list = [...new Set(mints.filter((m) => B58.test(m)))];
  const out = new Map();
  for (let i = 0; i < list.length; i += 30) {
    const chunk = list.slice(i, i + 30);
    try {
      const r = await fetch(`${DS}/tokens/v1/solana/${chunk.join(',')}`, { headers: { accept: 'application/json' } });
      if (!r.ok) continue;
      const arr = await r.json();
      for (const m of chunk) {
        const p = dexPatch(arr, m);
        if (p && p.mc > 0) {
          out.set(m, { ...p, supply: p.priceUsd > 0 ? p.mc / p.priceUsd : null });
        }
      }
    } catch {}
  }

  // not on DexScreener yet: read the pump.fun curve itself
  const missing = list.filter((m) => !out.has(m));
  if (missing.length && solPrice > 0) {
    const addrs = missing.map(curveAddress);
    try {
      const r = await rpc('getMultipleAccounts', [addrs.filter(Boolean), { encoding: 'base64', commitment: 'confirmed' }]);
      const vals = r?.value || [];
      let k = 0;
      missing.forEach((m, i) => {
        if (!addrs[i]) return;
        const a = vals[k++];
        if (!a || a.owner !== PUMP || !a.data?.[0]) return;
        const d = b64ToBytes(a.data[0]);
        if (d.length < 49) return;
        const vTokens = u64(d, 8);
        const vSol = u64(d, 16);
        const complete = d[48] === 1;
        if (!(vTokens > 0) || !(vSol > 0) || complete) return;
        const priceSol = vSol / 1e9 / (vTokens / 1e6);
        const priceUsd = priceSol * solPrice;
        out.set(m, {
          mc: priceUsd * PUMP_SUPPLY,
          priceUsd,
          priceSol,
          supply: PUMP_SUPPLY,
          curve: true,
          migrated: false,
          progress: progressFromReserves(vTokens / 1e6),
          symbol: null,
          name: null,
          image: null,
          pool: addrs[i],
          dex: 'pumpfun',
        });
      });
    } catch {}
  }
  return out;
}
