'use client';

import { useEffect, useRef, useState } from 'react';
import { gt, withPool, parseTrades } from '../_lib/markets';
import { useNow } from '../_lib/hooks';
import { usd, price, amount, sol, age, short } from '../_lib/format';
import { Icon, TableSkeleton } from './Icons';

export default function Trades({ mint, pairAddress, supply, wallet }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [fresh, setFresh] = useState(() => new Set());
  const seenRef = useRef(new Set());
  const now = useNow(5000);

  useEffect(() => {
    if (!mint) return;
    let cancelled = false;
    let timer;
    const isCancelled = () => cancelled;
    seenRef.current = new Set();
    setRows(null);
    setError('');

    async function load(first) {
      if (first || !document.hidden) {
        try {
          const j = await withPool(mint, pairAddress, (pool) => gt(`/pools/${pool}/trades`, isCancelled), isCancelled);
          if (cancelled) return;
          const list = parseTrades(j?.data, mint).slice(0, 100);
          const added = new Set();
          if (!first) for (const t of list) if (!seenRef.current.has(t.id)) added.add(t.id);
          seenRef.current = new Set(list.map((t) => t.id));
          setRows(list);
          setFresh(added);
          setError('');
        } catch (e) {
          if (cancelled || e?.cancelled) return;
          // keep showing the last trades we had; otherwise explain and retry
          if (!seenRef.current.size) {
            setRows([]);
            setError('Trades for this coin are not available yet. Retrying shortly.');
          }
        }
      }
      if (!cancelled) timer = setTimeout(() => load(false), 15000);
    }

    load(true);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mint, pairAddress]);

  if (rows === null) return <TableSkeleton cols={7} />;
  if (error) return <p className="empty-note">{error}</p>;
  if (!rows.length) return <p className="empty-note">No trades in the last 24 hours.</p>;

  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>Age</th>
          <th>Type</th>
          <th className="num">{supply ? 'Market cap' : 'Price'}</th>
          <th className="num">Amount</th>
          <th className="num hide-sm">SOL</th>
          <th className="num">Value</th>
          <th className="hide-sm">Trader</th>
          <th className="num">
            <span className="sr-only">Transaction</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((t) => {
          const buy = t.side === 'buy';
          const mine = !!wallet && t.maker === wallet;
          const cls = [fresh.has(t.id) ? (buy ? 'flash-buy' : 'flash-sell') : '', mine ? 'mine' : ''].filter(Boolean).join(' ');
          return (
            <tr key={t.id} className={cls || undefined}>
              <td className="muted">{age(t.time, now)}</td>
              <td className={buy ? 'up' : 'down'}>{buy ? 'Buy' : 'Sell'}</td>
              <td className="num">{supply ? usd(t.priceUsd * supply) : price(t.priceUsd)}</td>
              <td className="num">{amount(t.tokenAmt)}</td>
              <td className="num hide-sm">{t.quoteIsSol ? sol(t.quoteAmt) : '—'}</td>
              <td className={`num ${buy ? 'up' : 'down'}`}>{usd(t.usd)}</td>
              <td className="hide-sm">
                {t.maker ? (
                  <a className="mono" href={`https://solscan.io/account/${t.maker}`} target="_blank" rel="noreferrer">
                    {mine ? 'You' : short(t.maker)}
                  </a>
                ) : (
                  '—'
                )}
              </td>
              <td className="num">
                {t.tx && (
                  <a className="icon-btn" href={`https://solscan.io/tx/${t.tx}`} target="_blank" rel="noreferrer" aria-label="Open transaction on Solscan">
                    <Icon name="external" size={13} />
                  </a>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
