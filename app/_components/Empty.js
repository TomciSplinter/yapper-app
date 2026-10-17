'use client';

// One look for every empty, failed or not-yet state: an icon in a soft ring,
// a line saying what's going on, and what to do about it.

import { Icon } from './Icons';

export default function Empty({ icon = 'info', title, children, action, compact = false }) {
  return (
    <div className={`empty${compact ? ' compact' : ''}`}>
      <span className="empty-icon" aria-hidden="true">
        <Icon name={icon} size={18} />
      </span>
      {title && <p className="empty-title">{title}</p>}
      {children && <p className="empty-sub">{children}</p>}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}
