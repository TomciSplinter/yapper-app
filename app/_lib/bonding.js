// pump.fun bonding curve math, shared by the server lists and the browser.
//
// The curve is a constant product of 30 virtual SOL and 1.073B virtual
// tokens. It completes (and the coin migrates to PumpSwap) once 793.1M real
// tokens have been sold, at a market cap of about 411 SOL. Every pump.fun
// coin has a supply of 1B tokens.

export const PUMP_SUPPLY = 1e9;
const V_SOL = 30;
const V_TOKENS = 1_073_000_000;
const REAL_TOKENS = 793_100_000;
const K = V_SOL * V_TOKENS;

// price in SOL per token when a coin launches
export const LAUNCH_PRICE_SOL = V_SOL / V_TOKENS;

// 0-100 from the virtual token reserves on the curve (PumpPortal sends these)
export function progressFromReserves(vTokens) {
  const v = Number(vTokens);
  if (!(v > 0)) return null;
  return Math.min(100, Math.max(0, ((V_TOKENS - v) / REAL_TOKENS) * 100));
}

// 0-100 from the coin's price in SOL per token
export function curveProgress(priceSol) {
  const p = Number(priceSol);
  if (!(p > 0)) return null;
  return progressFromReserves(Math.sqrt(K / p));
}

// coins at or above this are about to graduate
export const FINAL_STRETCH = 70;
