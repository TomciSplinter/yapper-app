'use client';

import { usd, count, amount, dexLabel } from '../_lib/format';

function Fact({ label, value, toneClass }) {
  return (
    <div className="tf-fact">
      <dt>{label}</dt>
      <dd className={toneClass || undefined}>{value}</dd>
    </div>
  );
}

export default function TokenFacts({ pair, holders }) {
  const t24 = pair?.txns?.h24;
  const t1 = pair?.txns?.h1;
  const buys = t24?.buys ?? null;
  const sells = t24?.sells ?? null;
  const total = (buys || 0) + (sells || 0);
  const buyShare = total ? (buys / total) * 100 : 50;
  const supply = pair?.marketCap && Number(pair?.priceUsd) > 0 ? pair.marketCap / Number(pair.priceUsd) : null;
  const top10 = holders?.top10Pct;
  const top10Text = top10 === null || top10 === undefined ? (holders?.loading ? '…' : '—') : `${top10.toFixed(1)}%`;

  return (
    <section className="tf" aria-label="Coin info">
      <h2 className="pane-title">Coin info</h2>

      <div className="tf-pressure">
        <div className="tf-pressure-head">
          <span>
            Buys <b className="up">{count(buys)}</b>
          </span>
          <span>Last 24h</span>
          <span>
            Sells <b className="down">{count(sells)}</b>
          </span>
        </div>
        <div
          className="tf-bar"
          role="img"
          aria-label={total ? `${Math.round(buyShare)}% of trades in the last 24 hours were buys` : 'No trades in the last 24 hours'}
        >
          <span style={{ width: `${buyShare}%` }} />
        </div>
      </div>

      <dl className="tf-grid">
        <Fact label="Top 10 holders" value={top10Text} toneClass={top10 > 30 ? 'warn' : undefined} />
        <Fact label="Volume 1h" value={usd(pair?.volume?.h1)} />
        <Fact label="Trades 1h" value={t1 ? count((t1.buys || 0) + (t1.sells || 0)) : '—'} />
        <Fact label="FDV" value={usd(pair?.fdv)} />
        <Fact label="Supply" value={supply ? amount(supply) : '—'} />
        <Fact label="Pool" value={pair ? dexLabel(pair.dexId) : '—'} />
      </dl>
    </section>
  );
}
