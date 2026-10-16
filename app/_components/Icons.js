'use client';

import { useEffect, useState } from 'react';

const PATHS = {
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  external: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4 11 13" />
      <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18" />
    </>
  ),
  at: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
    </>
  ),
  send: (
    <>
      <path d="M21 3 10 14" />
      <path d="m21 3-7 18-4-7-7-4z" />
    </>
  ),
  link: (
    <>
      <path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
    </>
  ),
  chevronDown: <path d="m6 9 6 6 6-6" />,
  close: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5" />
      <path d="M12 16.5h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5" />
      <path d="M12 7.5h.01" />
    </>
  ),
  logout: (
    <>
      <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
      <path d="m10 17 5-5-5-5" />
      <path d="M15 12H4" />
    </>
  ),
};

export function Icon({ name, size = 16, ...rest }) {
  const p = PATHS[name];
  if (!p) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {p}
    </svg>
  );
}

// Token logo, or the ticker's first letter when there is no usable image.
export function TokenImage({ src, label, size = 32 }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const usable = !!src && !failed && (/^https?:\/\//i.test(src) || src.startsWith('/'));
  const style = { width: size, height: size };
  if (usable) {
    return (
      <img
        className="timg"
        src={src}
        alt=""
        width={size}
        height={size}
        style={style}
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }
  const letter = String(label || '?').replace(/^\$/, '').charAt(0).toUpperCase() || '?';
  return (
    <span className="timg timg-fallback" style={{ ...style, fontSize: Math.round(size * 0.42) }} aria-hidden="true">
      {letter}
    </span>
  );
}

export function TableSkeleton({ rows = 8, cols = 6 }) {
  return (
    <div className="skel" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, r) => (
        <div className="skel-row" key={r}>
          {Array.from({ length: cols }, (_, c) => (
            <span key={c} className="skel-bar" style={{ width: c === 0 ? '28%' : `${8 + ((r * 7 + c * 13) % 10)}%` }} />
          ))}
        </div>
      ))}
    </div>
  );
}
