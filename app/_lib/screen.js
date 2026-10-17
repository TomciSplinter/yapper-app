// The coins on your screen right now: Discover's table, Pulse's columns and
// your positions. Voice looks here first, so "open LOFI" while a LOFI is on
// the screen opens that one, not another coin with the same name.

import { useEffect } from 'react';
import { fromListRow } from './coinrank';

const shown = new Map(); // id -> { where, rows }

export function setOnScreen(id, where, rows) {
  if (rows && rows.length) shown.set(id, { where, rows });
  else shown.delete(id);
}

// [{ ...coin, where: 'Trending', pos }] in screen order
export function onScreen() {
  const out = [];
  for (const { where, rows } of shown.values()) {
    rows.forEach((r, pos) => {
      const c = fromListRow(r);
      if (c) out.push({ ...c, where, pos });
    });
  }
  return out;
}

// what the page is showing, for the voice assistant: names only
export function screenSummary(max = 40) {
  const where = [...new Set([...shown.values()].map((s) => s.where))];
  const tickers = [];
  for (const c of onScreen()) {
    const t = String(c.symbol || c.name || '').trim().slice(0, 16);
    if (t && !tickers.includes(t)) tickers.push(t);
    if (tickers.length >= max) break;
  }
  return { showing: where, tickers };
}

export function useOnScreen(id, where, rows) {
  useEffect(() => {
    setOnScreen(id, where, rows);
  }, [id, where, rows]);
  useEffect(() => () => setOnScreen(id, null, null), [id]);
}
