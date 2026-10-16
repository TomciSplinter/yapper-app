'use client';

// Small pieces shared by the Discover table and Pulse cards.

import { useState } from 'react';
import { count, safeUrl } from '../_lib/format';
import { Icon, TokenImage } from './Icons';

// Mini chart: market cap over time, green if it's up since the first point.
export function Sparkline({ points, width = 112, height = 36 }) {
  if (!points || points.length < 2) {
    return (
      <svg className="spark flat" viewBox={`0 0 ${width} ${height}`} width={width} height={height} preserveAspectRatio="none" aria-hidden="true">
        <path d={`M2,${height / 2}H${width - 2}`} />
      </svg>
    );
  }
  const t0 = points[0][0];
  const t1 = points[points.length - 1][0];
  const vs = points.map((p) => p[1]);
  let lo = Math.min(...vs);
  let hi = Math.max(...vs);
  if (hi - lo < hi * 0.002) {
    hi *= 1.01;
    lo *= 0.99;
  }
  const pad = 3;
  const x = (t) => pad + ((t - t0) / (t1 - t0 || 1)) * (width - pad * 2);
  const y = (v) => pad + (1 - (v - lo) / (hi - lo)) * (height - pad * 2);
  const line = points.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const area = `${line}L${x(t1).toFixed(1)},${height}L${x(t0).toFixed(1)},${height}Z`;
  const up = vs[vs.length - 1] >= vs[0];
  return (
    <svg
      className={`spark ${up ? 'up' : 'down'}`}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path className="spark-area" d={area} />
      <path className="spark-line" d={line} />
    </svg>
  );
}

// Coin image with its bonding curve progress along the bottom edge.
export function CoinAvatar({ row, size = 48 }) {
  const p = row.curve && row.progress !== null && row.progress !== undefined ? Math.max(2, Math.min(100, row.progress)) : null;
  return (
    <span className={`cav${row.curve ? '' : ' cav-done'}`} style={{ width: size, height: size }}>
      <TokenImage src={row.image} label={row.symbol || row.name} size={size} />
      {p !== null && (
        <span className="cav-bar" title={`Bonding curve ${Math.floor(row.progress)}%`}>
          <span style={{ width: `${p}%` }} />
        </span>
      )}
    </span>
  );
}

const stop = (e) => e.stopPropagation();

export function Socials({ socials, mint }) {
  const items = [
    socials?.twitter && { href: socials.twitter, icon: 'x', label: 'X' },
    socials?.telegram && { href: socials.telegram, icon: 'send', label: 'Telegram' },
    socials?.website && { href: socials.website, icon: 'globe', label: 'Website' },
    { href: `https://x.com/search?q=${mint}&f=live`, icon: 'search', label: 'Search this coin on X' },
  ].filter((it) => it && safeUrl(it.href));
  return (
    <span className="sx-row">
      {items.map((it) => (
        <a key={it.icon} className="sx" href={it.href} target="_blank" rel="noreferrer noopener" onClick={stop} title={it.label} aria-label={it.label}>
          <Icon name={it.icon} size={13} />
        </a>
      ))}
    </span>
  );
}

export function CopyCA({ mint }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="sx"
      title="Copy contract address"
      aria-label="Copy contract address"
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(mint);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {}
      }}
    >
      <Icon name={done ? 'check' : 'copy'} size={12} />
    </button>
  );
}

const pctText = (v) => `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}%`;

// Holders, top 10 share, dev share and bonding progress, when known.
export function TokenStats({ row, compact }) {
  const chips = [];
  if (row.holders !== null && row.holders !== undefined) chips.push({ k: 'h', icon: 'users', text: count(row.holders), title: 'Holders' });
  if (row.top10 !== null && row.top10 !== undefined) {
    chips.push({ k: 't', icon: 'pie', text: pctText(row.top10), title: 'Held by the top 10 wallets', tone: row.top10 > 30 ? 'down' : 'up' });
  }
  if (row.dev !== null && row.dev !== undefined) {
    chips.push({ k: 'd', icon: 'code', text: pctText(row.dev), title: 'Held by the creator', tone: row.dev > 5 ? 'down' : 'up' });
  }
  if (row.curve && row.progress !== null && row.progress !== undefined) {
    chips.push({ k: 'b', bar: Math.max(4, Math.min(100, row.progress)), text: `${Math.floor(row.progress)}%`, title: 'Bonding curve progress', tone: 'bond' });
  }
  if (!chips.length) return compact ? null : <span className="muted">—</span>;
  return (
    <span className={`stats${compact ? ' stats-compact' : ''}`}>
      {chips.map((c) => (
        <span key={c.k} className={`stat${c.tone ? ` ${c.tone}` : ''}`} title={c.title}>
          {c.bar ? (
            <span className="stat-bar" aria-hidden="true">
              <span style={{ width: `${c.bar}%` }} />
            </span>
          ) : (
            <Icon name={c.icon} size={12} />
          )}
          {c.text}
        </span>
      ))}
    </span>
  );
}

export function QuickBuyButton({ row, amount, onBuy, className = '' }) {
  const [busy, setBusy] = useState(false);
  const label = amount && Number(amount) > 0 ? amount : '0';
  return (
    <button
      type="button"
      className={`qb ${className}`}
      disabled={busy}
      aria-label={`Buy ${label} SOL of ${row.symbol || row.name || 'this coin'}`}
      title={`Buy ${label} SOL now`}
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (busy) return;
        setBusy(true);
        try {
          await onBuy(row);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="bolt" size={13} />}
      {label}
    </button>
  );
}

// "Quick buy [0.1] SOL": the amount every Buy button in the lists spends.
export function QuickBuyInput({ value, onChange }) {
  return (
    <label className="qbi" title="Amount each Buy button spends, right away">
      <Icon name="bolt" size={13} />
      <span className="qbi-label">Quick buy</span>
      <input inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Quick buy amount in SOL" />
      <span className="muted">SOL</span>
    </label>
  );
}
