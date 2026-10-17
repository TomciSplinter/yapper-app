'use client';

import { useState } from 'react';
import Trades from './Trades';
import Holders from './Holders';
import Positions from './Positions';
import { TableSkeleton } from './Icons';

const TABS = [
  { id: 'trades', label: 'Trades' },
  { id: 'holders', label: 'Top holders' },
  { id: 'positions', label: 'Your positions' },
];

export default function DataTabs({ mint, pair, pairReady, supply, wallet, holders, positionsKey, onOpenToken, onConnect }) {
  const [tab, setTab] = useState('trades');

  return (
    <section className="dt" aria-label="Coin activity">
      <div className="dt-tabs" role="tablist" aria-label="Coin activity">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`dt-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="dt-panel"
            className={tab === t.id ? 'on' : undefined}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="dt-body" role="tabpanel" id="dt-panel" aria-labelledby={`dt-tab-${tab}`}>
        {tab === 'trades' &&
          (pairReady ? (
            <Trades key={mint} mint={mint} pairAddress={pair?.pairAddress} supply={supply} wallet={wallet} />
          ) : (
            <TableSkeleton cols={7} />
          ))}
        {tab === 'holders' && <Holders holders={holders} wallet={wallet} priceUsd={Number(pair?.priceUsd)} />}
        {tab === 'positions' && (
          <Positions wallet={wallet} refreshKey={positionsKey} onOpenToken={onOpenToken} onConnect={onConnect} />
        )}
      </div>
    </section>
  );
}
