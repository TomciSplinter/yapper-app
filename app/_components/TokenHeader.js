'use client';

import { useState } from 'react';
import { usd, price, pct, tone, age, short, dexLabel, isPumpCurve, safeUrl } from '../_lib/format';
import { Icon, TokenImage } from './Icons';

function socialLinks(info) {
  const out = [];
  for (const w of info?.websites || []) {
    const url = safeUrl(w?.url);
    if (url) out.push({ url, label: 'Website', icon: 'globe' });
  }
  for (const s of info?.socials || []) {
    const type = String(s?.type || s?.platform || '').toLowerCase();
    let url = safeUrl(s?.url);
    if (!url && s?.handle) {
      if (type === 'twitter') url = `https://x.com/${s.handle}`;
      else if (type === 'telegram') url = `https://t.me/${s.handle}`;
    }
    if (!url) continue;
    if (type === 'twitter') out.push({ url, label: 'X (Twitter)', icon: 'at' });
    else if (type === 'telegram') out.push({ url, label: 'Telegram', icon: 'send' });
    else out.push({ url, label: type ? type.charAt(0).toUpperCase() + type.slice(1) : 'Link', icon: 'link' });
  }
  const seen = new Set();
  return out.filter((l) => !seen.has(l.url) && seen.add(l.url)).slice(0, 4);
}

function Stat({ label, value, toneClass, big }) {
  return (
    <div className={`th-stat${big ? ' big' : ''}`}>
      <dt>{label}</dt>
      <dd className={toneClass || undefined}>{value}</dd>
    </div>
  );
}

export default function TokenHeader({ mint, pair, pairState }) {
  const [copied, setCopied] = useState(false);
  const base = pair?.baseToken;
  const loading = pairState === 'loading' && !pair;
  const onCurve = isPumpCurve(pair?.dexId);
  const links = socialLinks(pair?.info);
  const showPump = mint.endsWith('pump') || /pump/i.test(pair?.dexId || '');
  const ch = pair?.priceChange || {};

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(mint);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  return (
    <section className="th" aria-label="Coin overview">
      <div className="th-id">
        <TokenImage src={pair?.info?.imageUrl} label={base?.symbol} size={40} />
        <div className="th-names">
          <div className="th-line1">
            <h1 className="th-name">{base?.name || (loading ? 'Loading…' : 'Unknown coin')}</h1>
            {base?.symbol && <span className="th-sym">{base.symbol}</span>}
            {pair?.dexId && <span className={`chip${onCurve ? ' chip-curve' : ''}`}>{onCurve ? 'Bonding curve' : dexLabel(pair.dexId)}</span>}
          </div>
          <div className="th-line2">
            <button type="button" className="th-ca" onClick={copy} title="Copy contract address">
              <span className="mono">{short(mint, 5)}</span>
              <Icon name={copied ? 'check' : 'copy'} size={13} />
              <span className="sr-only">{copied ? 'Copied' : 'Copy contract address'}</span>
            </button>
            {links.map((l) => (
              <a key={l.url} className="icon-btn" href={l.url} target="_blank" rel="noreferrer" aria-label={l.label} title={l.label}>
                <Icon name={l.icon} size={14} />
              </a>
            ))}
            <span className="th-sep" aria-hidden="true" />
            <a className="th-ext" href={`https://solscan.io/token/${mint}`} target="_blank" rel="noreferrer">
              Solscan
            </a>
            <a className="th-ext" href={`https://dexscreener.com/solana/${pair?.pairAddress || mint}`} target="_blank" rel="noreferrer">
              DexScreener
            </a>
            {showPump && (
              <a className="th-ext" href={`https://pump.fun/coin/${mint}`} target="_blank" rel="noreferrer">
                Pump.fun
              </a>
            )}
          </div>
        </div>
      </div>

      {pairState === 'none' ? (
        <p className="th-nodata">No market data yet. New coins can take a minute to appear. You can still trade it.</p>
      ) : (
        <dl className="th-stats">
          <Stat label="Market cap" value={usd(pair?.marketCap ?? pair?.fdv)} big />
          <Stat label="Price" value={price(pair?.priceUsd)} />
          <Stat label="Liquidity" value={usd(pair?.liquidity?.usd)} />
          <Stat label="Volume 24h" value={usd(pair?.volume?.h24)} />
          <Stat label="5m" value={pct(ch.m5)} toneClass={tone(ch.m5)} />
          <Stat label="1h" value={pct(ch.h1)} toneClass={tone(ch.h1)} />
          <Stat label="6h" value={pct(ch.h6)} toneClass={tone(ch.h6)} />
          <Stat label="24h" value={pct(ch.h24)} toneClass={tone(ch.h24)} />
          <Stat label="Age" value={age(pair?.pairCreatedAt)} />
        </dl>
      )}
    </section>
  );
}
