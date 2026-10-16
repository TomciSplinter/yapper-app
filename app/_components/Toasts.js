'use client';

import { Icon } from './Icons';

const ICON = { success: 'check', error: 'alert', info: 'info' };

export default function Toasts({ items, onDismiss }) {
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind || 'info'}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <span className="toast-icon" aria-hidden="true">
            {t.kind === 'pending' ? <span className="spinner" /> : <Icon name={ICON[t.kind] || 'info'} size={16} />}
          </span>
          <div className="toast-body">
            <p className="toast-title">{t.title}</p>
            {t.detail && <p className="toast-detail">{t.detail}</p>}
            {t.sig && (
              <a className="toast-link" href={`https://solscan.io/tx/${t.sig}`} target="_blank" rel="noreferrer">
                View transaction
              </a>
            )}
          </div>
          <button type="button" className="icon-btn" onClick={() => onDismiss(t.id)} aria-label="Dismiss notification">
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
