'use client';

import { useEffect, useState } from 'react';
import { loadPositions } from '../_lib/markets';
import { usd, price, pct, tone, amount } from '../_lib/format';
import { TokenImage, TableSkeleton } from './Icons';

export default function Positions({ wallet, refreshKey, onOpenToken, onConnect }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!wallet) {
      setRows(null);
      return;
    }
    let cancelled = false;
    let timer;

    async function load(first) {
      if (first || !document.hidden) {
        try {
          const list = await loadPositions(wallet);
          if (!cancelled) {
            setRows(list);
            setError('');
          }
        } catch {
          if (!cancelled && first) {
            setRows([]);
            setError('Could not load your positions. Check your connection and try again.');
          }
        }
      }
      if (!cancelled) timer = setTimeout(() => load(false), 30000);
    }

    load(true);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [wallet, refreshKey]);

  if (!wallet) {
    return (
      <div className="empty-state">
        <p>Connect your wallet to see the coins you hold.</p>
        <button type="button" className="btn btn-primary" onClick={onConnect}>
          Connect wallet
        </button>
      </div>
    );
  }
  if (rows === null) return <TableSkeleton cols={6} rows={5} />;
  if (error && !rows.length) return <p className="empty-note">{error}</p>;
  if (!rows.length) return <p className="empty-note">No coins in this wallet yet. Search for a coin to make your first trade.</p>;

  const total = rows.reduce((s, r) => s + r.value, 0);

  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>Coin</th>
          <th className="num">Balance</th>
          <th className="num hide-sm">Price</th>
          <th className="num">Value</th>
          <th className="num">24h</th>
          <th className="num">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.mint}>
            <td>
              <a
                className="coin"
                href={`/?ca=${r.mint}`}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                  e.preventDefault();
                  onOpenToken(r.mint);
                }}
              >
                <TokenImage src={r.imageUrl} label={r.symbol} size={28} />
                <span className="coin-text">
                  <span className="coin-name">{r.name}</span>
                  <span className="coin-sym">{r.symbol}</span>
                </span>
              </a>
            </td>
            <td className="num">{amount(r.amount)}</td>
            <td className="num hide-sm">{price(r.priceUsd)}</td>
            <td className="num">{usd(r.value)}</td>
            <td className={`num ${tone(r.change24h)}`}>{pct(r.change24h)}</td>
            <td className="num">
              <button type="button" className="btn btn-ghost btn-xs" onClick={() => onOpenToken(r.mint, 'sell')}>
                Sell
              </button>
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td>Total</td>
          <td />
          <td className="hide-sm" />
          <td className="num">{usd(total)}</td>
          <td />
          <td />
        </tr>
      </tfoot>
    </table>
  );
}
