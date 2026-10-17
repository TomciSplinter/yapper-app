'use client';

// Open orders and alerts, with a cancel button each. Used under the trade
// panel (one coin) and on the Positions page (every coin).

import { cancelOrder, orderLabel, isLive } from '../_lib/orders';
import { usd } from '../_lib/format';
import { useNow } from '../_lib/hooks';
import { Icon, TokenImage } from './Icons';

function left(ms) {
  if (ms <= 0) return 'expiring';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m left`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h left`;
  return `${Math.round(h / 24)}d left`;
}

const STATUS = { done: 'Done', failed: 'Failed', cancelled: 'Cancelled', expired: 'Expired', executing: 'Running…', unconfirmed: 'Confirming…' };

export default function OrdersList({ orders, showCoin = false, onOpenToken, empty }) {
  const now = useNow(30000);
  if (!orders.length) return empty ? <p className="empty-note">{empty}</p> : null;
  return (
    <ul className="ol">
      {orders.map((o) => {
        const live = isLive(o);
        const running = o.status === 'executing' || o.status === 'unconfirmed';
        // can be stopped until its trade is sent
        const canCancel = live && !o.sig && o.status !== 'unconfirmed';
        const kind = o.type === 'alert' ? 'alert' : o.type === 'buy' ? 'buy' : o.dir === 'above' ? 'tp' : 'sl';
        return (
          <li key={o.id} className={`ol-row${live ? '' : ' done'}`}>
            <span className={`ol-tag ${kind}`}>
              <Icon name={o.type === 'alert' ? 'bell' : 'target'} size={12} />
              {orderLabel(o)}
            </span>
            {showCoin && (
              <button type="button" className="ol-coin" onClick={() => onOpenToken?.(o.mint)}>
                <TokenImage src={o.image} label={o.symbol} size={18} />
                {o.symbol || `${o.mint.slice(0, 4)}…`}
              </button>
            )}
            <span className="ol-what">
              {o.type === 'buy' ? `${o.amountSol} SOL` : o.type === 'sell' ? `${o.percent}%` : ''}
              <span className="muted">
                {o.type === 'alert' ? '' : ' at '}
                {o.dir === 'below' ? '≤' : '≥'} {usd(o.targetMc)}
              </span>
            </span>
            <span className="ol-meta muted" title={o.note || undefined}>
              {live ? (running ? STATUS[o.status] : o.expiresAt ? left(o.expiresAt - now) : 'No expiry') : STATUS[o.status] || o.status}
            </span>
            {canCancel ? (
              <button type="button" className="icon-btn ol-x" onClick={() => cancelOrder(o.id)} aria-label={`Cancel ${orderLabel(o)} for ${o.symbol || 'this coin'}`}>
                <Icon name="close" size={13} />
              </button>
            ) : (
              <span className="ol-x" />
            )}
          </li>
        );
      })}
    </ul>
  );
}

// Positions page: every open order and alert, plus the most recent finished ones
export function OrdersSection({ orders, onOpenToken }) {
  const live = orders.filter(isLive);
  const done = orders
    .filter((o) => !isLive(o))
    .sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0))
    .slice(0, 8);
  return (
    <section className="os" aria-labelledby="os-title">
      <header className="os-head">
        <h2 className="os-title" id="os-title">
          Orders and alerts
        </h2>
        <span className="muted">Run while Yapper is open in a tab</span>
      </header>
      <OrdersList orders={live} showCoin onOpenToken={onOpenToken} empty='No open orders. Set one in a coin’s trade panel or say "buy 0.2 if it dips to 8K".' />
      {done.length > 0 && (
        <details className="os-done">
          <summary>Recent ({done.length})</summary>
          <OrdersList orders={done} showCoin onOpenToken={onOpenToken} />
        </details>
      )}
    </section>
  );
}
