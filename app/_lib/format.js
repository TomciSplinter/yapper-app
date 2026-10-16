// Number and text formatting shared across the terminal.

const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉';

function finite(n) {
  if (n === null || n === undefined || n === '') return null;
  const v = typeof n === 'number' ? n : Number(n);
  return Number.isFinite(v) ? v : null;
}

// $273.95M, $12.4K, $3.21
export function usd(n) {
  const v = finite(n);
  if (v === null) return '—';
  const a = Math.abs(v);
  const s = v < 0 ? '−' : '';
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}K`;
  if (a === 0) return '$0';
  return `${s}$${a.toFixed(a >= 0.01 ? 2 : 4)}`;
}

// Token prices. Tiny prices use subscript zeros: 0.00001234 → $0.0₄1234
export function price(n) {
  const v = finite(n);
  if (v === null || v <= 0) return '—';
  if (v >= 1000) return `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (v >= 1) return `$${v.toFixed(v >= 100 ? 2 : 4)}`;
  if (v >= 0.001) return `$${Number(v.toPrecision(4))}`;
  const m = v.toFixed(20).match(/^0\.(0+)(\d{1,4})/);
  if (!m) return `$${v.toPrecision(3)}`;
  const digits = m[2].replace(/0+$/, '') || '0';
  const sub = String(m[1].length)
    .split('')
    .map((d) => SUBSCRIPT[Number(d)])
    .join('');
  return `$0.0${sub}${digits}`;
}

// +12.4%, −3.21%
export function pct(n, digits) {
  const v = finite(n);
  if (v === null) return '—';
  const a = Math.abs(v);
  const d = digits ?? (a >= 100 ? 0 : a >= 10 ? 1 : 2);
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${a.toFixed(d)}%`;
}

// Token amounts: 1.23B, 45.60M, 12.30K, 3.14
export function amount(n) {
  const v = finite(n);
  if (v === null) return '—';
  const a = Math.abs(v);
  if (a >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  if (a >= 1) return v.toFixed(2);
  if (a === 0) return '0';
  return Number(v.toPrecision(3)).toString();
}

// SOL amounts
export function sol(n) {
  const v = finite(n);
  if (v === null) return '—';
  const a = Math.abs(v);
  if (a >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(3);
  return v.toFixed(4);
}

export function count(n) {
  const v = finite(n);
  return v === null ? '—' : Math.round(v).toLocaleString('en-US');
}

export function short(a, n = 4) {
  return a ? `${a.slice(0, n)}…${a.slice(-n)}` : '';
}

// 12s, 5m, 3h, 2d, 4mo, 1y
export function age(ms, now = Date.now()) {
  const t = finite(ms);
  if (!t) return '—';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(d / 365)}y`;
}

export function tone(n) {
  const v = finite(n);
  if (v === null) return '';
  return v > 0 ? 'up' : v < 0 ? 'down' : '';
}

// DexScreener / GeckoTerminal dex ids → names people know
export function dexLabel(id) {
  const raw = String(id || '');
  const k = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!k) return '';
  if (k === 'pumpfun') return 'Pump.fun';
  if (k === 'pumpswap' || k === 'pumpamm') return 'PumpSwap';
  if (k.includes('launchlab')) return 'LaunchLab';
  if (k.startsWith('raydium')) return 'Raydium';
  if (k.startsWith('meteora')) return 'Meteora';
  if (k.startsWith('orca')) return 'Orca';
  if (k.includes('bonk')) return 'Bonk.fun';
  if (k.includes('moonshot')) return 'Moonshot';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

export function isPumpCurve(dexId) {
  return String(dexId || '').toLowerCase().replace(/[^a-z]/g, '') === 'pumpfun';
}

// Only let http(s) links from third-party data into hrefs
export function safeUrl(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null;
}
