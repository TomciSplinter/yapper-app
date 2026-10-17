'use client';

import { usd, amount, short } from '../_lib/format';
import { TableSkeleton } from './Icons';
import Empty from './Empty';

export default function Holders({ holders, wallet, priceUsd }) {
  if (!holders || (holders.loading && !holders.rows)) return <TableSkeleton cols={5} />;
  if (holders.error && !holders.rows) {
    return (
      <Empty icon="users" title="Holders aren't available yet" compact>
        {holders.error}
      </Empty>
    );
  }
  const rows = holders.rows || [];
  if (!rows.length) {
    return (
      <Empty icon="users" title="No holders found" compact>
        This coin's holders will show up once it has some.
      </Empty>
    );
  }
  // bars are scaled to the largest holder so small differences stay visible
  const maxPct = Math.max(...rows.map((r) => r.pct || 0), 0.0001);

  return (
    <table className="tbl">
      <thead>
        <tr>
          <th className="rank">#</th>
          <th>Wallet</th>
          <th className="num">Share of supply</th>
          <th className="num">Amount</th>
          <th className="num hide-sm">Value</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((h, i) => {
          const mine = !!wallet && h.owner === wallet;
          const who = h.owner || h.account;
          return (
            <tr key={h.account} className={mine ? 'mine' : undefined}>
              <td className="rank muted">{i + 1}</td>
              <td>
                <span className="holder">
                  <a className="mono" href={`https://solscan.io/account/${who}`} target="_blank" rel="noreferrer">
                    {mine ? 'You' : short(who)}
                  </a>
                  {h.kind === 'pool' && <span className="chip chip-sm">Liquidity pool</span>}
                  {h.kind === 'program' && <span className="chip chip-sm">Program</span>}
                </span>
              </td>
              <td className="num">
                <span className="share">
                  <span className="share-track" aria-hidden="true">
                    <span className="share-fill" style={{ width: `${Math.min(100, ((h.pct || 0) / maxPct) * 100)}%` }} />
                  </span>
                  {h.pct === null ? '—' : `${h.pct.toFixed(2)}%`}
                </span>
              </td>
              <td className="num">{amount(h.amount)}</td>
              <td className="num hide-sm">{priceUsd > 0 ? usd(h.amount * priceUsd) : '—'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
