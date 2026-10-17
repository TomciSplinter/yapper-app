'use client';

// Discover: a coin table in the style of the big terminals.
//   Trending  pump.fun coins still on the bonding curve with trading right now,
//             $5K to $40K market cap by default (adjustable)
//   Top       the most active pools on all of Solana
// Rows refresh from DexScreener every few seconds. While the pointer is over
// the rows their order holds still, so a Buy click always hits the coin you see.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNow } from '../_lib/hooks';
import { usd, pct, tone, age, count, dexLabel } from '../_lib/format';
import { loadLists, useLive, useTokenInfo, liveRow, sparkPoints, useQuickBuy } from '../_lib/pump';
import { Icon, TableSkeleton } from './Icons';
import Empty from './Empty';
import { Sparkline, CoinAvatar, Socials, CopyCA, TokenStats, QuickBuyButton, QuickBuyInput } from './CoinBits';

const TABS = [
  { id: 'trending', label: 'Trending', list: 'curve', sort: 'vol', sub: 'Pump.fun coins still on the bonding curve, trading right now' },
  { id: 'top', label: 'Top', list: 'top', sort: 'rank', sub: 'The most active pools on Solana' },
];
const FRAMES = [
  { id: 'm5', label: '5m' },
  { id: 'h1', label: '1h' },
  { id: 'h6', label: '6h' },
  { id: 'h24', label: '24h' },
];
const FILTER_KEY = 'yapper:discover-filter';
const DEFAULT_FILTER = { mcMin: 5000, mcMax: 40000, volMin: 500 };

const txTotal = (r, w) => (r.txns?.[w]?.b || 0) + (r.txns?.[w]?.s || 0);
const VALUE = {
  rank: (r) => -r.rank,
  mc: (r) => r.mc,
  liq: (r) => r.liq,
  vol: (r, w) => r.vol?.[w],
  tx: (r, w) => txTotal(r, w),
  age: (r) => r.createdAt,
};

function readFilter() {
  try {
    const f = JSON.parse(localStorage.getItem(FILTER_KEY) || 'null');
    if (f && f.mcMin >= 0 && f.mcMax > 0 && f.volMin >= 0) return { ...DEFAULT_FILTER, ...f };
  } catch {}
  return DEFAULT_FILTER;
}

const kUsd = (n) => (n >= 1000 ? `$${+(n / 1000).toFixed(1)}K` : `$${n}`);

function FilterMenu({ filter, onChange }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const down = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false);
    };
    const key = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const start = () => {
    setDraft({ mcMin: String(filter.mcMin / 1000), mcMax: String(filter.mcMax / 1000), volMin: String(filter.volMin) });
    setOpen((o) => !o);
  };
  const clean = (v) => v.replace(',', '.').replace(/[^0-9.]/g, '');
  const apply = (e) => {
    e.preventDefault();
    const mcMin = Math.max(0, Number(draft.mcMin) || 0) * 1000;
    const mcMax = Math.max(mcMin + 1000, (Number(draft.mcMax) || 0) * 1000);
    const volMin = Math.max(0, Number(draft.volMin) || 0);
    onChange({ mcMin, mcMax, volMin });
    setOpen(false);
  };

  return (
    <div className="fm" ref={ref}>
      <button type="button" className="fm-btn" aria-expanded={open} aria-haspopup="dialog" onClick={start}>
        <Icon name="sliders" size={14} />
        MC {kUsd(filter.mcMin)} to {kUsd(filter.mcMax)}
      </button>
      {open && draft && (
        <form className="fm-panel" role="dialog" aria-label="Filters" onSubmit={apply}>
          <div className="fm-row">
            <label>
              <span>Market cap from</span>
              <span className="fm-input">
                <i>$</i>
                <input inputMode="decimal" value={draft.mcMin} onChange={(e) => setDraft({ ...draft, mcMin: clean(e.target.value) })} autoFocus />
                <i>K</i>
              </span>
            </label>
            <label>
              <span>to</span>
              <span className="fm-input">
                <i>$</i>
                <input inputMode="decimal" value={draft.mcMax} onChange={(e) => setDraft({ ...draft, mcMax: clean(e.target.value) })} />
                <i>K</i>
              </span>
            </label>
          </div>
          <label>
            <span>Minimum volume in the timeframe</span>
            <span className="fm-input">
              <i>$</i>
              <input inputMode="decimal" value={draft.volMin} onChange={(e) => setDraft({ ...draft, volMin: clean(e.target.value) })} />
            </span>
          </label>
          <div className="fm-actions">
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={() => {
                onChange(DEFAULT_FILTER);
                setOpen(false);
              }}
            >
              Reset
            </button>
            <button type="submit" className="btn btn-primary btn-xs">
              Apply
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export default function Discover({ onOpenToken, onQuickBuy }) {
  const [tab, setTab] = useState('trending');
  const [frame, setFrame] = useState('h1');
  const [sorts, setSorts] = useState({ trending: { key: 'vol', dir: -1 }, top: { key: 'rank', dir: -1 } });
  const [lists, setLists] = useState({});
  const [errors, setErrors] = useState({});
  const [updated, setUpdated] = useState({});
  const [filter, setFilterState] = useState(DEFAULT_FILTER);
  const [qb, setQb] = useQuickBuy();
  const [hover, setHover] = useState(false);
  const frozen = useRef(null);
  const touchTimer = useRef(0);
  const now = useNow(5000);

  const def = TABS.find((t) => t.id === tab);
  const sort = sorts[tab];

  useEffect(() => setFilterState(readFilter()), []);
  const setFilter = (f) => {
    setFilterState(f);
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify(f));
    } catch {}
  };

  // the active tab's list from our cached route, refreshed every 45s
  useEffect(() => {
    let cancelled = false;
    let timer;
    const name = def.list;
    async function load(first) {
      if (first || !document.hidden) {
        try {
          const got = await loadLists([name]);
          if (!cancelled && Array.isArray(got[name])) {
            setLists((prev) => ({ ...prev, [name]: got[name].map((r, i) => ({ ...r, rank: i })) }));
            setErrors((prev) => ({ ...prev, [name]: '' }));
            setUpdated((prev) => ({ ...prev, [name]: Date.now() }));
          }
        } catch (e) {
          if (!cancelled && first) {
            setLists((prev) => ({ ...prev, [name]: prev[name] || [] }));
            setErrors((prev) => ({ ...prev, [name]: 'Coins did not load. Retrying shortly.' }));
          }
        }
      }
      if (!cancelled) timer = setTimeout(() => load(false), 45000);
    }
    load(true);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [def.list]);

  const base = lists[def.list] || null;
  const [liveMints, setLiveMints] = useState([]);
  const patches = useLive(liveMints, 12000);
  const info = useTokenInfo(liveMints);

  const shown = useMemo(() => {
    if (!base) return null;
    const merged = base.map((r) => liveRow(r, patches.get(r.mint), info[r.mint]));
    const filtered =
      tab === 'trending'
        ? merged.filter((r) => r.curve && r.mc >= filter.mcMin && r.mc <= filter.mcMax && (r.vol?.[frame] || 0) >= filter.volMin)
        : merged;
    const v = VALUE[sort.key];
    return filtered
      .slice()
      .sort((a, b) => ((v(b, frame) ?? -Infinity) - (v(a, frame) ?? -Infinity)) * -sort.dir)
      .slice(0, 60);
  }, [base, patches, info, tab, filter, frame, sort]);

  // keep the coins on screen live
  const shownKey = shown ? shown.map((r) => r.mint).join(',') : '';
  useEffect(() => {
    setLiveMints(shownKey ? shownKey.split(',') : []);
  }, [shownKey]);

  // hold the order while the pointer is over the rows
  let rows = shown;
  if (hover && frozen.current && shown) {
    const byMint = new Map(shown.map((r) => [r.mint, r]));
    const merged = new Map((base || []).map((r) => [r.mint, liveRow(r, patches.get(r.mint), info[r.mint])]));
    rows = frozen.current.map((m) => byMint.get(m) || merged.get(m)).filter(Boolean);
  }

  const setSort = (key) => {
    setSorts((prev) => {
      const cur = prev[tab];
      const dir = cur.key === key ? -cur.dir : -1;
      return { ...prev, [tab]: { key, dir } };
    });
  };

  const sortButton = (k, label, className = '') => (
    <button
      type="button"
      className={`dc-sort ${className}${sort.key === k ? ' on' : ''}`}
      aria-label={`Sort by ${label.toLowerCase()}`}
      aria-pressed={sort.key === k}
      onClick={() => setSort(k)}
    >
      {label}
      {sort.key === k && <Icon name="chevronDown" size={12} className={sort.dir < 0 ? 'dc-dir' : 'dc-dir asc'} />}
    </button>
  );
  const sortHead = (k, label, className = '') => (
    <span className={`dc-h ${className}`} role="columnheader" aria-sort={sort.key === k ? (sort.dir < 0 ? 'descending' : 'ascending') : 'none'}>
      {sortButton(k, label)}
    </span>
  );

  const open = (mint) => (e) => {
    e.stopPropagation();
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    onOpenToken(mint);
  };

  const error = errors[def.list];
  const stamp = updated[def.list];

  return (
    <section className="view dc" aria-labelledby="dc-title">
      <header className="dc-top">
        <div className="dc-tabs" role="tablist" aria-label="Coin lists">
          <h1 className="sr-only" id="dc-title">
            Discover
          </h1>
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : undefined} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="dc-tools">
          <div className="pills" role="group" aria-label="Timeframe">
            {FRAMES.map((f) => (
              <button key={f.id} type="button" className={frame === f.id ? 'on' : undefined} aria-pressed={frame === f.id} onClick={() => setFrame(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
          {tab === 'trending' && <FilterMenu filter={filter} onChange={setFilter} />}
          <QuickBuyInput value={qb} onChange={setQb} />
        </div>
        <p className="dc-sub">
          {def.sub}
          {shown && stamp ? <span className="muted">. {shown.length} coins, updated {age(stamp, now)} ago</span> : null}
        </p>
      </header>

      <div className="dc-table" role="table" aria-label={`${def.label} coins`}>
        <div className="dc-head" role="row">
          <span className="dc-h dc-coin-h" role="columnheader" aria-sort={sort.key === 'age' ? (sort.dir < 0 ? 'descending' : 'ascending') : 'none'}>
            <span>Coin</span>
            {sortButton('age', 'Age', 'dc-sort-age')}
          </span>
          <span className="dc-h dc-chart-h" role="columnheader">
            Chart
          </span>
          {sortHead('mc', 'Market cap')}
          {sortHead('liq', 'Liquidity', 'hide-sm')}
          {sortHead('vol', 'Volume')}
          {sortHead('tx', 'Txns', 'hide-sm')}
          <span className="dc-h hide-md" role="columnheader">
            Token info
          </span>
          <span className="dc-h dc-buy-h" role="columnheader">
            <span className="sr-only">Quick buy</span>
          </span>
        </div>

        {shown === null && <TableSkeleton cols={7} rows={10} />}
        {shown !== null && error && !shown.length && (
          <Empty icon="alert" title="Coins didn't load">
            {error}
          </Empty>
        )}
        {shown !== null && !error && !shown.length && (
          <Empty
            icon="search"
            title={tab === 'trending' ? 'Nothing matches your filter' : 'No coins to show right now'}
            action={
              tab === 'trending' ? (
                <button type="button" className="btn btn-ghost" onClick={() => setFilter({ ...filter, mcMin: 0, mcMax: 100000, volMin: 0 })}>
                  Show every curve coin
                </button>
              ) : null
            }
          >
            {tab === 'trending'
              ? `No bonding-curve coins between ${kUsd(filter.mcMin)} and ${kUsd(filter.mcMax)} with that much volume right now.`
              : 'Check back in a minute.'}
          </Empty>
        )}

        {rows && rows.length > 0 && (
          <div
            className="dc-body"
            role="rowgroup"
            onPointerEnter={(e) => {
              if (e.pointerType !== 'mouse') return;
              frozen.current = shown.map((r) => r.mint);
              setHover(true);
            }}
            onPointerLeave={(e) => {
              if (e.pointerType !== 'mouse') return;
              frozen.current = null;
              setHover(false);
            }}
            onTouchStart={() => {
              clearTimeout(touchTimer.current);
              if (!hover) frozen.current = shown.map((r) => r.mint);
              setHover(true);
            }}
            onTouchEnd={() => {
              clearTimeout(touchTimer.current);
              touchTimer.current = setTimeout(() => {
                frozen.current = null;
                setHover(false);
              }, 4000);
            }}
          >
            {rows.map((r) => {
              const tx = r.txns?.[frame] || {};
              return (
                <div key={r.mint} className="dc-row" role="row" onClick={() => onOpenToken(r.mint)}>
                  <div className="dc-coin" role="cell">
                    <CoinAvatar row={r} size={46} />
                    <div className="dc-id">
                      <div className="dc-l1">
                        <a className="dc-name" href={`/?ca=${r.mint}`} onClick={open(r.mint)} title={r.name}>
                          {r.name}
                        </a>
                        <span className="dc-sym">{r.symbol}</span>
                        <CopyCA mint={r.mint} />
                      </div>
                      <div className="dc-l2">
                        <span className="dc-age">{age(r.createdAt, now)}</span>
                        {!r.curve && r.dex ? <span className="chip chip-sm">{dexLabel(r.dex)}</span> : null}
                        <Socials socials={r.socials} mint={r.mint} />
                      </div>
                    </div>
                  </div>
                  <div className="dc-chart" role="cell">
                    <Sparkline points={sparkPoints(r, now)} />
                  </div>
                  <div className="dc-num dc-mc" role="cell">
                    <b>{usd(r.mc)}</b>
                    <span className={tone(r.chg?.[frame])}>{pct(r.chg?.[frame])}</span>
                  </div>
                  <div className="dc-num hide-sm" role="cell">
                    {usd(r.liq)}
                  </div>
                  <div className="dc-num dc-vol" role="cell">
                    <b>{usd(r.vol?.[frame])}</b>
                    <span className="dc-mobile-tx muted">{count(txTotal(r, frame))} txns</span>
                  </div>
                  <div className="dc-num hide-sm" role="cell">
                    <b>{count(txTotal(r, frame))}</b>
                    <span>
                      <span className="up">{count(tx.b || 0)}</span>
                      <span className="muted"> / </span>
                      <span className="down">{count(tx.s || 0)}</span>
                    </span>
                  </div>
                  <div className="dc-info hide-md" role="cell">
                    <TokenStats row={r} />
                  </div>
                  <div className="dc-buy" role="cell">
                    <QuickBuyButton row={r} amount={qb} onBuy={(row) => onQuickBuy(row, qb)} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
