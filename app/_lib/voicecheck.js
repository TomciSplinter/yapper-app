// Checks the orb makes on its own before acting on what the assistant
// understood: is a reply really a plain yes, do take profit / stop loss levels
// make sense, which settings need a confirm. Kept apart so they can be tested.

import { usd } from './format';

// A confirm card waits this long; after that the price may have moved too much.
export const PENDING_MS = { trade: 60000, sell_many: 60000, order: 5 * 60000, setting: 5 * 60000, cancel_orders: 5 * 60000 };

// Settings that change what every trade does: changed only after a confirm.
export const RISKY = { slippage: 20, quick_buy: 1, priority_fee: 0.002 };

// The server decides a reply means "confirm"; this checks it here too. A yes
// is a few words from this list and nothing else, so a long sentence (or text
// hidden in a coin's name steering the assistant) can't confirm a trade.
const AFFIRM = new Set(
  ('yes yeah yep yup yea ya y sure ok okay okey k confirm confirmed go send approve approved absolutely definitely ' +
    'correct right alright bet fine igen mehet persze rendben oké oke csináld csinald jöhet johet ' +
    'sí si oui da tak sim evet ja jo jó hai はい 是 好 对').split(' ')
);
const FILLER = new Set(
  ('it please now ahead lets let us do just that the trade order for thanks thank you sir bro man mate yapper all hell ' +
    'buy sell place vedd add meg kérem kerem kérlek kerlek légyszi legyszi és es').split(' ')
);
export function isAffirmative(said) {
  const words = String(said || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length || words.length > 6) return false;
  return words.every((w) => AFFIRM.has(w) || FILLER.has(w)) && words.some((w) => AFFIRM.has(w));
}

// Names and tickers come from whoever made the coin: keep them short and plain
// before they go anywhere near the assistant or the screen.
export const plain = (s, n = 24) =>
  String(s || '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, '')
    .replace(/[<>{}[\]`"\\]/g, '')
    .trim()
    .slice(0, n);

// take profit has to be above the price now, stop loss below it
export function checkLeg(leg, isTp, mcNow, supply) {
  if (!leg) return { leg: null };
  const name = isTp ? 'take profit' : 'stop loss';
  const v = Number(leg.value);
  if (leg.value === null || leg.value === undefined || !Number.isFinite(v)) return { leg: null, why: `the ${name} needs a number` };
  if (leg.kind === 'multiple') return (isTp ? v > 1 : v > 0 && v < 1) ? { leg } : { leg: null, why: `the ${name} has to be ${isTp ? 'above 1x' : 'below 1x'}` };
  if (leg.kind === 'percent') return (isTp ? v > 0 : v < 0 && v > -100) ? { leg } : { leg: null, why: `the ${name} has to be ${isTp ? 'a gain' : 'a loss under 100%'}` };
  const target = leg.kind === 'price' ? (supply > 0 ? v * supply : null) : v;
  if (!(mcNow > 0) || !(target > 0)) return { leg: null, why: `I couldn't check the ${name} against the price` };
  if (isTp ? target > mcNow : target < mcNow) return { leg };
  return { leg: null, why: `the ${name} has to be ${isTp ? 'above' : 'below'} the market cap now (${usd(mcNow)})` };
}
