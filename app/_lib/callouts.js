// Callouts: the orb speaks up about your positions on its own (opt-in).
//   - a coin you hold reaches 2x, 3x, 5x, 10x or 20x your average entry, or
//     falls to half of it
//   - a coin you bought on the bonding curve graduates to PumpSwap
//   - someone sells 2% or more of the supply in one trade
// Runs in the same tab as orders (see orders.js), off the same price checks.

import { loadPositions, gt, withPool, parseTrades } from './markets';
import { cachedFills } from './fills';
import { ownSummary } from './portfolio';
import { announce, getPrefs } from './voicebus';
import { usd } from './format';

const KEY = (w) => `yapper:callouts:v1:${w}`;
const UPS = [2, 3, 5, 10, 20];
const POS_EVERY = 60 * 1000;
const TRADES_EVERY = 30 * 1000;
const BIG_SELL = 0.02; // share of supply
const SELL_COOLDOWN = 5 * 60 * 1000;

function readState(wallet) {
  try {
    const v = JSON.parse(localStorage.getItem(KEY(wallet)) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function saveState(wallet, st) {
  try {
    localStorage.setItem(KEY(wallet), JSON.stringify(st));
  } catch {}
}

export function createCallouts({ getWallet, getSolPrice }) {
  let wallet = null;
  let positions = [];
  let posAt = 0;
  let posLoading = false;
  let tradesAt = 0;

  const enabled = () => getPrefs().callouts && !!getWallet();

  function refreshPositions() {
    const w = getWallet();
    if (w !== wallet) {
      wallet = w;
      positions = [];
      posAt = 0;
    }
    if (!w || posLoading || Date.now() - posAt < POS_EVERY) return;
    posLoading = true;
    loadPositions(w)
      .then((rows) => {
        if (w === wallet) positions = rows;
        posAt = Date.now();
      })
      .catch(() => {
        posAt = Date.now() - POS_EVERY / 2;
      })
      .finally(() => {
        posLoading = false;
      });
  }

  // coins to price on each check
  function mints() {
    if (!enabled()) return [];
    refreshPositions();
    return positions.slice(0, 15).map((p) => p.mint);
  }

  async function check(quotes) {
    if (!enabled() || !positions.length) return;
    const w = wallet;
    const st = readState(w);
    const solPrice = getSolPrice();
    const say = (text, p) => announce({ kind: 'callout', text, mint: p.mint, symbol: p.symbol, toast: { kind: 'info', title: p.symbol || 'Your position', detail: text } });

    for (const p of positions.slice(0, 15)) {
      const q = quotes.get(p.mint);
      if (!q) continue;
      const s = (st[p.mint] = st[p.mint] || {});
      const sym = p.symbol || q.symbol || 'A coin you hold';

      // graduation
      if (q.curve) s.wasCurve = true;
      if ((q.migrated || q.curve === false) && s.wasCurve && !s.migrated) {
        s.migrated = true;
        say(`${sym} just graduated from the bonding curve to PumpSwap.`, p);
      }

      // multiples of your entry (only when your trades explain what you hold)
      const priceSol = q.priceSol || (solPrice && q.priceUsd ? q.priceUsd / solPrice : null);
      const { s: sum, known } = priceSol ? ownSummary(cachedFills(w, p.mint), p.amount, priceSol) : {};
      if (known && sum && sum.avgEntry > 0 && sum.held > 0) {
        const mult = priceSol / sum.avgEntry;
        const hit = UPS.filter((x) => mult >= x).pop() || 1;
        if (hit > (s.up || 1)) {
          s.up = hit;
          const worth = sum.value && solPrice ? ` Your bag is worth about ${usd(sum.value * solPrice)}.` : '';
          say(`${sym} is up ${hit}x from your entry.${worth}`, p);
        }
        if (mult <= 0.5 && !s.down) {
          s.down = true;
          say(`${sym} is down ${Math.round((1 - mult) * 100)}% from your entry.`, p);
        }
        if (mult >= 0.8) s.down = false;
      }
    }

    // big sells in your three biggest positions
    if (Date.now() - tradesAt >= TRADES_EVERY) {
      tradesAt = Date.now();
      for (const p of positions.slice(0, 3)) {
        const q = quotes.get(p.mint);
        if (!q?.supply) continue;
        const s = (st[p.mint] = st[p.mint] || {});
        try {
          const j = await withPool(p.mint, q.pool || p.pairAddress, (pool) => gt(`/pools/${pool}/trades`));
          const trades = parseTrades(j?.data, p.mint);
          const newest = trades[0]?.time || 0;
          if (!s.seen) {
            s.seen = newest || Date.now(); // first look: only trades from now on
            continue;
          }
          const big = trades
            .filter((t) => t.side === 'sell' && t.time > s.seen && t.maker !== w && t.tokenAmt / q.supply >= BIG_SELL)
            .sort((a, b) => b.tokenAmt - a.tokenAmt)[0];
          if (newest > s.seen) s.seen = newest;
          if (big && Date.now() - (s.sellAt || 0) > SELL_COOLDOWN) {
            s.sellAt = Date.now();
            const pct = (big.tokenAmt / q.supply) * 100;
            say(`Big sell on ${p.symbol || 'a coin you hold'}: ${pct.toFixed(1)}% of the supply, about ${usd(big.usd)}.`, p);
          }
        } catch {}
      }
    }
    saveState(w, st);
  }

  return { mints, check };
}
