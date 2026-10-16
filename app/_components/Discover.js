'use client';

import { useEffect, useMemo, useState } from 'react';
import { useNow } from '../_lib/hooks';
import { usd, pct, tone, age, count, dexLabel, isPumpCurve } from '../_lib/format';
import { TokenImage, TableSkeleton } from './Icons';

const SORTS = [
  { id: 'trending', label: 'Trending' },
  { id: 'volume', label: 'Volume' },
  { id: 'mcap', label: 'Market cap' },
  { id: 'gainers', label: '1h gainers' },
  { id: 'new', label: 'Newest' },
];

function sortRows(rows, sort) {
  const list = [...rows];
  const by = (f) => list.sort((a, b) => (f(b) ?? -Infinity) - (f(a) ?? -Infinity));
  if (sort === 'volume') by((r) => r.volume24h);
  else if (sort === 'mcap') by((r) => r.marketCap);
  else if (sort === 'gainers') by((r) => r.change1h);
  else if (sort === 'new') by((r) => r.createdAt);
  return list;
}

export default function Discover({ onOpenToken }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [sort, setSort] = useState('trending');
  const [updatedAt, setUpdatedAt] = useState(0);
  const now = useNow(5000);

  useEffect(() => {
    let cancelled = false;
    let timer;
    async function load(first) {
      if (first || !document.hidden) {
        try {
          const r = await fetch('/api/trending');
          const j = await r.json();
          if (!r.ok || !Array.isArray(j.results)) throw new Error('bad response');
          if (!cancelled) {
            setRows(j.results);
            setError('');
            setUpdatedAt(Date.now());
          }
        } catch {
          if (!cancelled && first) {
            setRows([]);
            setError('Trending coins did not load. Retrying in a minute.');
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
  }, []);

  const sorted = useMemo(() => (rows ? sortRows(rows, sort) : null), [rows, sort]);

  // the row handles plain clicks; the link keeps cmd/ctrl-click for new tabs
  const open = (mint) => (e) => {
    e.stopPropagation();
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    onOpenToken(mint);
  };

  return (
    <section className="view" aria-labelledby="ds-title">
      <header className="view-head">
        <div>
          <h1 className="view-title" id="ds-title">
            Trending on Solana
          </h1>
          <p className="view-sub">{updatedAt ? `Updated ${age(updatedAt, now)} ago` : 'Loading the latest coins'}</p>
        </div>
        <div className="seg" role="group" aria-label="Sort coins">
          {SORTS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={sort === s.id ? 'on' : undefined}
              aria-pressed={sort === s.id}
              onClick={() => setSort(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </header>

      <div className="view-body">
        {sorted === null && <TableSkeleton cols={9} rows={12} />}
        {sorted !== null && error && <p className="empty-note">{error}</p>}
        {sorted !== null && !error && (
          <table className="tbl tbl-roomy">
            <thead>
              <tr>
                <th className="rank">#</th>
                <th>Coin</th>
                <th className="num hide-sm">Age</th>
                <th className="num">Market cap</th>
                <th className="num hide-sm">Liquidity</th>
                <th className="num hide-md">Volume 24h</th>
                <th className="num hide-md">Trades 24h</th>
                <th className="num hide-sm">5m</th>
                <th className="num">1h</th>
                <th className="num hide-sm">24h</th>
                <th className="hide-md">Pool</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => (
                <tr key={r.mint} className="clickable" onClick={() => onOpenToken(r.mint)}>
                  <td className="rank muted">{i + 1}</td>
                  <td>
                    <a className="coin" href={`/?ca=${r.mint}`} onClick={open(r.mint)}>
                      <TokenImage src={r.imageUrl} label={r.symbol} size={28} />
                      <span className="coin-text">
                        <span className="coin-name">{r.name}</span>
                        <span className="coin-sym">{r.symbol}</span>
                      </span>
                    </a>
                  </td>
                  <td className="num muted hide-sm">{age(r.createdAt, now)}</td>
                  <td className="num">{usd(r.marketCap)}</td>
                  <td className="num hide-sm">{usd(r.liquidity)}</td>
                  <td className="num hide-md">{usd(r.volume24h)}</td>
                  <td className="num hide-md">
                    {r.buys24h === null && r.sells24h === null ? '—' : count((r.buys24h || 0) + (r.sells24h || 0))}
                  </td>
                  <td className={`num hide-sm ${tone(r.change5m)}`}>{pct(r.change5m)}</td>
                  <td className={`num ${tone(r.change1h)}`}>{pct(r.change1h)}</td>
                  <td className={`num hide-sm ${tone(r.change24h)}`}>{pct(r.change24h)}</td>
                  <td className="hide-md">
                    <span className={`chip${isPumpCurve(r.dex) ? ' chip-curve' : ''}`}>
                      {isPumpCurve(r.dex) ? 'Bonding curve' : dexLabel(r.dex) || '—'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
