// Which coin does a name mean? Shared by the search box (on the server) and
// voice (in the browser), so both land on the same coin.
//
// First, how well the name fits: the exact ticker or name, then a near miss
// (speech to text writes "low fi" for LOFI), then names that only contain it.
//
// Then, among equally good fits ("best"):
//   1. coins from the last week that are trading right now, scored by their
//      trading with a big head start for the last hour: a coin launched in the
//      last hour that already has holders comes first, unless a slightly older
//      coin of the same name is clearly the one everyone is trading
//   2. older coins that still trade
//   3. everything else (dead launches, pools nobody trades)
// A two-year-old coin doesn't win just for having the bigger market cap.
//
// Other orders: newest first, biggest first (market cap, real trading only),
// or closest to a market cap the user named ("the one at 25K").

export const SORTS = ['best', 'new', 'mc'];

const HOUR = 3600 * 1000;
const RECENT_MS = 7 * 24 * HOUR;

/* ---------- names ---------- */

// lowercase letters and digits of any script ("$Pepe Coin" -> "pepecoin")
export function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

// "thepepecoin" -> "pepe": the words people add around a ticker
function core(s) {
  let t = s;
  if (t.startsWith('the') && t.length > 5) t = t.slice(3);
  for (const end of ['memecoin', 'coin', 'token']) {
    if (t.endsWith(end) && t.length - end.length >= 2) {
      t = t.slice(0, -end.length);
      break;
    }
  }
  return t;
}

// rough sound-alike spelling for speech-to-text slips
function sound(s) {
  return s
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/q/g, 'k')
    .replace(/z/g, 's')
    .replace(/y/g, 'i')
    .replace(/(.)\1+/g, '$1');
}

// edit distance with swaps (Damerau), stopping early past `max`
function dist(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2 = new Array(b.length + 1).fill(0);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < best) best = v;
    }
    for (let j = 0; j <= b.length; j++) prev2[j] = prev[j];
    prev = cur;
    if (best > max) return max + 1;
  }
  return prev[b.length];
}

// one slip in a 5-7 letter name, two from 8 letters; shorter names only
// when they sound the same ("pepe" isn't "pipe")
function near(a, b) {
  if (!a || !b || a.length < 3 || b.length < 3) return false;
  if (sound(a).length >= 3 && sound(a) === sound(b)) return true;
  const n = Math.max(a.length, b.length);
  const lim = n >= 8 ? 2 : n >= 5 ? 1 : 0;
  return lim > 0 && dist(a, b, lim) <= lim;
}

const words = (s) =>
  String(s ?? '')
    .split(/[^\p{L}\p{N}]+/u)
    .map(norm)
    .filter(Boolean);

// 5 exact ticker or name, 4 the same apart from "the"/"coin"/"token",
// 3 a near miss (only when fuzzy), 2 a whole word or the start, 1 contains it, 0 no
export function matchLevel(c, q, { fuzzy = false } = {}) {
  const nq = norm(q);
  if (!nq) return 0;
  const sym = norm(c?.symbol);
  const name = norm(c?.name);
  if (nq === sym || nq === name) return 5;
  const cq = core(nq);
  if (cq.length >= 2 && (cq === core(sym) || cq === core(name))) return 4;
  if (fuzzy && (near(nq, sym) || near(nq, name) || near(cq, core(sym)) || near(cq, core(name)))) return 3;
  if (words(c?.name).includes(nq) || words(c?.symbol).includes(nq)) return 2;
  if (sym.startsWith(nq) || name.startsWith(nq)) return 2;
  if (nq.length >= 3 && (sym.includes(nq) || name.includes(nq))) return 1;
  return 0;
}

// strong: exact (4-5); near: 3; loose: 1-2
export const matchClass = (level) => (level >= 4 ? 0 : level === 3 ? 1 : 2);

/* ---------- how alive a coin is ---------- */

const n = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const lg = (v) => Math.log10(1 + Math.max(0, n(v) || 0));

export function ageMinutes(c, now = Date.now()) {
  return c?.createdAt ? Math.max(0, (now - c.createdAt) / 60000) : null;
}

// has people in it: holders, or several different traders in the last hour
export function hasHolders(c) {
  return (n(c?.holders) || 0) >= 10 || (n(c?.traders1h) || 0) >= 8 || (n(c?.buys1h) || 0) >= 10;
}

// trading right now, even a little (a launch's own first buy doesn't count)
export function isAlive(c, now = Date.now()) {
  if (c?.lastTradeAt && now - c.lastTradeAt < HOUR && (!c.createdAt || c.lastTradeAt - c.createdAt > 2 * 60000)) return true;
  if (n(c?.vol1h) !== null || n(c?.trades1h) !== null || n(c?.traders1h) !== null) {
    return (n(c.vol1h) || 0) >= 50 || (n(c.trades1h) || 0) >= 5 || (n(c.traders1h) || 0) >= 3;
  }
  return (n(c?.vol24h) || 0) >= 1000;
}

// launched in the last hour and already has holders
export function isFresh(c, now = Date.now()) {
  const a = ageMinutes(c, now);
  return a !== null && a <= 60 && hasHolders(c);
}

// coins that look like someone actually trades them (fake pools show a big
// market cap with no volume and almost no holders)
export function isReal(c) {
  return (n(c?.vol24h) || 0) >= 1000 || (n(c?.holders) || 0) >= 200 || !!c?.verified;
}

function headStart(c, now) {
  const a = ageMinutes(c, now);
  if (a === null) return 0;
  if (a <= 60) return hasHolders(c) ? 2 : 0;
  if (a <= 360) return 1;
  if (a <= 1440) return 0.5;
  if (a <= 3 * 1440) return 0;
  return -0.5;
}

const people = (c) => n(c.holders) ?? (n(c.traders1h) !== null ? n(c.traders1h) * 2 : null) ?? 0;
const activity = (c) => lg(c.vol1h ?? (n(c.vol24h) !== null ? n(c.vol24h) / 24 : 0)) + 0.6 * lg(people(c));
const realness = (c) => lg(c.vol24h) + 0.5 * lg(c.holders) + 0.25 * lg(c.liq) + (c.verified ? 1 : 0);

function bestKey(c, now) {
  const alive = isAlive(c, now);
  const a = ageMinutes(c, now);
  const recent = a !== null && a * 60000 <= RECENT_MS;
  if (alive && recent) return [0, activity(c) + headStart(c, now)];
  if (alive) return [1, realness(c)];
  return [2, realness(c) + lg(c.mc) * 0.1];
}

/* ---------- ordering ---------- */

const desc = (x, y) => (y ?? -Infinity) - (x ?? -Infinity);

function sortBest(list, now) {
  const keyed = list.map((c) => ({ c, k: bestKey(c, now) }));
  keyed.sort((a, b) => a.k[0] - b.k[0] || b.k[1] - a.k[1] || desc(a.c.mc, b.c.mc));
  return keyed.map((x) => x.c);
}

function sortClosest(list, mc, now) {
  const far = (c) => {
    const v = n(c.mc);
    if (!(v > 0)) return Infinity;
    return Math.abs(Math.log(v / mc)) + (isAlive(c, now) ? 0 : 0.5);
  };
  return list.slice().sort((a, b) => far(a) - far(b) || desc(activity(a), activity(b)));
}

function sortNew(list) {
  return list.slice().sort((a, b) => desc(a.createdAt, b.createdAt) || b.match - a.match);
}

function sortBig(list) {
  return list.slice().sort((a, b) => Number(isReal(b)) - Number(isReal(a)) || desc(n(a.mc), n(b.mc)));
}

// Every coin that fits the name, in order. `sort` is best | new | mc;
// `mc` (a market cap in USD) orders by closeness to it instead.
// `fuzzy` lets near misses in (voice); typed searches leave it off.
export function rankCoins(list, { q, sort = 'best', mc = null, fuzzy = false, now = Date.now() } = {}) {
  const seen = new Set();
  const hits = [];
  for (const c of list || []) {
    if (!c?.mint || seen.has(c.mint)) continue;
    const match = matchLevel(c, q, { fuzzy });
    if (!match) continue;
    seen.add(c.mint);
    hits.push({ ...c, match });
  }
  const hint = n(mc) > 0 ? n(mc) : null;
  if (!hint && sort === 'new') return sortNew(hits);
  if (!hint && sort === 'mc') return sortBig(hits);
  const groups = [[], [], []];
  for (const c of hits) groups[matchClass(c.match)].push(c);
  return groups.flatMap((g) => (hint ? sortClosest(g, hint, now) : sortBest(g, now)));
}

// The one coin a spoken name most likely means, and the other good fits.
// "newest" skips launches nobody has traded yet when there's a choice.
export function pickCoin(list, { q, mc = null, pick = null, now = Date.now() } = {}) {
  const sort = pick === 'newest' ? 'new' : pick === 'biggest' ? 'mc' : 'best';
  let ranked = rankCoins(list, { q, sort, mc, fuzzy: true, now });
  if (!ranked.length) return null;
  // the best kind of fit decides who's in the running
  const top = Math.min(...ranked.map((c) => matchClass(c.match)));
  ranked = ranked.filter((c) => matchClass(c.match) === top);
  if (pick === 'newest' && !mc) {
    const live = ranked.find((c) => isAlive(c, now) || hasHolders(c));
    if (live) ranked = [live, ...ranked.filter((c) => c !== live)];
  }
  return { coin: ranked[0], others: ranked.slice(1, 4), exact: top === 0, near: top === 1 };
}

/* ---------- one shape for coins from anywhere ---------- */

const sum = (...v) => (v.some((x) => n(x) !== null) ? v.reduce((a, x) => a + (n(x) || 0), 0) : null);

// a row from our coin lists (Discover, Pulse, /api/pump)
export function fromListRow(r) {
  if (!r?.mint) return null;
  const t1 = r.txns?.h1;
  return {
    mint: r.mint,
    name: r.name || '',
    symbol: r.symbol || '',
    image: r.image || r.imageUrl || null,
    mc: n(r.mc ?? r.marketCap),
    liq: n(r.liq),
    priceUsd: n(r.priceUsd),
    vol1h: n(r.vol?.h1),
    vol24h: n(r.vol?.h24),
    trades1h: t1 ? sum(t1.b, t1.s) : null,
    buys1h: t1 ? n(t1.b) : null,
    traders1h: t1 ? n(t1.u) : null,
    holders: n(r.holders),
    chg1h: n(r.chg?.h1),
    chg24h: n(r.chg?.h24),
    createdAt: n(r.createdAt),
    dex: r.dex || null,
    curve: typeof r.curve === 'boolean' ? r.curve : null,
    pairAddress: r.pool || null,
  };
}
