'use client';

// Pulse: pump.fun coins moving through their life, in three columns.
//   New pairs      just launched, under 70% of the bonding curve
//   Final stretch  70% or more of the way to graduating
//   Migrated       graduated to PumpSwap
// New coins and migrations stream in live from PumpPortal and coins move
// between columns as they progress; numbers refresh from DexScreener. A column
// holds still while the pointer is over it, so a Buy click always hits the
// coin you see, and new arrivals wait behind a "new" button.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNow } from '../_lib/hooks';
import { usd, count, age, short } from '../_lib/format';
import { FINAL_STRETCH } from '../_lib/bonding';
import { loadLists, useLive, useTokenInfo, liveRow, usePumpFeed, rowFromCreate, coinMeta, useQuickBuy } from '../_lib/pump';
import { Icon } from './Icons';
import { CoinAvatar, Socials, CopyCA, TokenStats, QuickBuyButton, QuickBuyInput } from './CoinBits';

const COLS = [
  { id: 'new', title: 'New pairs', empty: 'Waiting for new coins.' },
  { id: 'final', title: 'Final stretch', empty: 'No coins are close to graduating right now.' },
  { id: 'migrated', title: 'Migrated', empty: 'No coins have graduated recently.' },
];
const NEW_WINDOW = 3 * 3600 * 1000;
const PER_COLUMN = 40;

const txTotal = (r) => (r.txns?.h24?.b || 0) + (r.txns?.h24?.s || 0);

// name or ticker; contract addresses from 4 characters, so short searches stay on names
function matches(r, q) {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return (
    (r.name || '').toLowerCase().includes(s) ||
    (r.symbol || '').toLowerCase().replace(/^\$/, '').includes(s.replace(/^\$/, '')) ||
    (s.length >= 4 && r.mint.toLowerCase().includes(s))
  );
}

function Card({ r, kind, now, qb, onOpen, onBuy }) {
  const b = r.txns?.h24?.b || 0;
  const s = r.txns?.h24?.s || 0;
  const buyShare = b + s ? (b / (b + s)) * 100 : 50;
  const when = kind === 'migrated' ? r.migratedAt || r.createdAt : r.createdAt;
  return (
    <article className="pl-card" onClick={() => onOpen(r.mint)}>
      <div className="pl-av">
        <CoinAvatar row={r} size={58} />
        <span className="pl-ca mono">{short(r.mint, 4)}</span>
      </div>
      <div className="pl-main">
        <div className="pl-l1">
          <a
            className="pl-name"
            href={`/?ca=${r.mint}`}
            title={r.name || r.mint}
            onClick={(e) => {
              e.stopPropagation();
              if (e.metaKey || e.ctrlKey || e.shiftKey) return;
              e.preventDefault();
              onOpen(r.mint);
            }}
          >
            {r.name || short(r.mint, 4)}
          </a>
          {r.symbol ? <span className="pl-sym">{r.symbol}</span> : null}
          <CopyCA mint={r.mint} />
        </div>
        <div className="pl-l2">
          <span className="pl-age">{age(when, now)}</span>
          <Socials socials={r.socials} mint={r.mint} />
        </div>
        <div className="pl-l3">
          <TokenStats row={r} compact />
          {r.devBuySol > 0 && !r.holders ? (
            <span className="stat" title="The creator's first buy">
              <Icon name="code" size={12} />
              {r.devBuySol >= 1 ? r.devBuySol.toFixed(1) : r.devBuySol.toFixed(2)} SOL
            </span>
          ) : null}
        </div>
      </div>
      <div className="pl-side">
        <div className="pl-nums">
          <span>
            <i>V</i> {usd(r.vol?.h24)}
          </span>
          <span>
            <i>MC</i> <b>{usd(r.mc)}</b>
          </span>
        </div>
        <div className="pl-tx" title={`${count(b)} buys and ${count(s)} sells in 24h`}>
          <span>
            <i>TX</i> {count(txTotal(r))}
          </span>
          <span className="pl-ratio" aria-hidden="true">
            <span style={{ width: `${buyShare}%` }} />
          </span>
        </div>
        <QuickBuyButton row={r} amount={qb} onBuy={onBuy} className="qb-sm" />
      </div>
    </article>
  );
}

export default function Pulse({ onOpenToken, onQuickBuy, solPrice }) {
  const [seed, setSeed] = useState(null);
  const [error, setError] = useState('');
  const [arrivals, setArrivals] = useState([]);
  const [migrations, setMigrations] = useState([]);
  const [queries, setQueries] = useState({ new: '', final: '', migrated: '' });
  const [paused, setPaused] = useState(null);
  const [tab, setTab] = useState('new');
  const [qb, setQb] = useQuickBuy();
  const frozen = useRef({});
  const touchTimer = useRef(0);
  const solRef = useRef(solPrice);
  solRef.current = solPrice;
  const now = useNow(1000);

  // the three lists from our cached route, refreshed every 30s
  useEffect(() => {
    let cancelled = false;
    let timer;
    async function load(first) {
      if (first || !document.hidden) {
        try {
          const got = await loadLists(['new', 'final', 'migrated']);
          if (!cancelled) {
            setSeed(got);
            setError('');
          }
        } catch {
          if (!cancelled && first) {
            setSeed({});
            setError('Coin lists did not load. New coins will still stream in.');
          }
        }
      }
      if (!cancelled) timer = setTimeout(() => load(false), 30000);
    }
    load(true);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  // new coins and migrations as they happen
  const feed = usePumpFeed(true, {
    onCreate: (m) => {
      const row = rowFromCreate(m, solRef.current);
      setArrivals((prev) => (prev.some((x) => x.mint === row.mint) ? prev : [row, ...prev].slice(0, 80)));
      coinMeta(row.uri).then((meta) => {
        if (!meta) return;
        setArrivals((prev) =>
          prev.map((x) => (x.mint === row.mint ? { ...x, image: x.image || meta.image, socials: { ...meta.socials, ...x.socials } } : x))
        );
      });
    },
    onMigrate: (m) => {
      setMigrations((prev) => (prev.some((x) => x.mint === m.mint) ? prev : [{ mint: m.mint, migratedAt: Date.now() }, ...prev].slice(0, 40)));
    },
  });

  // every coin we know about, newest information last
  const known = useMemo(() => {
    const map = new Map();
    const put = (r, extra = {}) => {
      if (!r?.mint) return;
      const cur = map.get(r.mint);
      map.set(r.mint, cur ? { ...cur, ...r, ...extra, image: cur.image || r.image, name: cur.name || r.name } : { ...r, ...extra });
    };
    for (const r of seed?.final || []) put(r);
    for (const r of seed?.new || []) put(r);
    for (const r of arrivals) put(r);
    for (const r of seed?.migrated || []) put(r, { curve: false, migratedAt: r.createdAt, migrated: true, progress: null });
    // a live migration keeps what we already knew about the coin
    for (const m of migrations) {
      const cur = map.get(m.mint) || { mint: m.mint, name: null, symbol: '', image: null, vol: {}, txns: {}, chg: {}, mc: null, createdAt: m.migratedAt };
      map.set(m.mint, { ...cur, curve: false, migrated: true, migratedAt: m.migratedAt, dex: 'pumpswap', progress: null });
    }
    return map;
  }, [seed, arrivals, migrations]);

  const [liveMints, setLiveMints] = useState([]);
  const patches = useLive(liveMints, 10000);
  const info = useTokenInfo(liveMints);

  const columns = useMemo(() => {
    const out = { new: [], final: [], migrated: [] };
    for (const base of known.values()) {
      const p = patches.get(base.mint);
      const r = liveRow(base, p, info[base.mint]);
      if (base.migrated || p?.migrated || r.curve === false) {
        out.migrated.push({ ...r, curve: false, progress: null, migratedAt: base.migratedAt || p?.pairCreatedAt || r.createdAt });
      } else if (r.progress !== null && r.progress >= FINAL_STRETCH) {
        out.final.push(r);
      } else if (r.createdAt && now - r.createdAt < NEW_WINDOW) {
        out.new.push(r);
      }
    }
    out.new.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    out.final.sort((a, b) => (b.progress || 0) - (a.progress || 0));
    out.migrated.sort((a, b) => (b.migratedAt || 0) - (a.migratedAt || 0));
    for (const k of Object.keys(out)) out[k] = out[k].filter((r) => matches(r, queries[k])).slice(0, PER_COLUMN);
    return out;
    // `now` only matters for the 3h window and fresh migrations; a 1s tick is fine
  }, [known, patches, info, queries, now]);

  // keep every visible card live (DexScreener takes 30 per call)
  const liveKey = [...columns.new.slice(0, 30), ...columns.final.slice(0, 30), ...columns.migrated.slice(0, 30)].map((r) => r.mint).join(',');
  useEffect(() => {
    setLiveMints(liveKey ? liveKey.split(',') : []);
  }, [liveKey]);

  const hold = useCallback(
    (id) => {
      frozen.current[id] = columns[id].map((r) => r.mint);
      setPaused(id);
    },
    [columns]
  );
  const release = () => {
    clearTimeout(touchTimer.current);
    frozen.current = {};
    setPaused(null);
  };
  // mouse: hold while the pointer is over a column; touch: while touching and 4s after
  const listEvents = (id) => ({
    onPointerEnter: (e) => e.pointerType === 'mouse' && hold(id),
    onPointerLeave: (e) => e.pointerType === 'mouse' && release(),
    onTouchStart: () => {
      clearTimeout(touchTimer.current);
      if (paused !== id) hold(id);
    },
    onTouchEnd: () => {
      clearTimeout(touchTimer.current);
      touchTimer.current = setTimeout(release, 4000);
    },
  });

  const view = (id) => {
    const list = columns[id];
    if (paused !== id || !frozen.current[id]) return { rows: list, waiting: 0 };
    const byMint = new Map(list.map((r) => [r.mint, r]));
    const keep = frozen.current[id];
    const rows = keep.map((m) => byMint.get(m)).filter(Boolean);
    const waiting = list.filter((r) => !keep.includes(r.mint)).length;
    return { rows, waiting };
  };

  const statusText = feed === 'live' ? 'Live' : feed === 'retrying' ? 'Reconnecting' : 'Connecting';

  return (
    <section className="view pl" aria-labelledby="pl-title">
      <header className="pl-top">
        <div className="pl-heading">
          <h1 className="view-title" id="pl-title">
            Pulse
          </h1>
          <span className={`pl-feed ${feed}`} title="New coins and migrations stream in from PumpPortal">
            <span className="sb-dot" aria-hidden="true" />
            {statusText}
          </span>
        </div>
        <div className="seg pl-tabs" role="tablist" aria-label="Columns">
          {COLS.map((c) => (
            <button key={c.id} type="button" role="tab" aria-selected={tab === c.id} className={tab === c.id ? 'on' : undefined} onClick={() => setTab(c.id)}>
              {c.title}
            </button>
          ))}
        </div>
        <QuickBuyInput value={qb} onChange={setQb} />
      </header>
      {error && <p className="pl-error">{error}</p>}

      <div className="pl-cols">
        {COLS.map((c) => {
          const { rows, waiting } = view(c.id);
          const loading = seed === null && (c.id !== 'new' || !arrivals.length);
          return (
            <section key={c.id} className={`pl-col${tab === c.id ? ' on' : ''}`} aria-label={c.title}>
              <div className="pl-col-head">
                <h2>{c.title}</h2>
                <span className="pl-count">{columns[c.id].length}</span>
                <label className="pl-search">
                  <Icon name="search" size={13} />
                  <span className="sr-only">Search {c.title.toLowerCase()}</span>
                  <input
                    value={queries[c.id]}
                    onChange={(e) => setQueries((q) => ({ ...q, [c.id]: e.target.value }))}
                    placeholder="Search"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                {paused === c.id && (
                  <span className="pl-paused" title="The list holds still while your pointer is over it">
                    <Icon name="pause" size={12} />
                    Paused
                  </span>
                )}
              </div>
              {waiting > 0 && (
                <button type="button" className="pl-more" onClick={release}>
                  {waiting} new {waiting === 1 ? 'coin' : 'coins'}
                </button>
              )}
              <div className="pl-list" {...listEvents(c.id)}>
                {loading &&
                  Array.from({ length: 6 }, (_, i) => (
                    <div key={i} className="pl-card pl-skel" aria-hidden="true">
                      <span className="skel-bar" />
                      <span className="skel-bar" />
                    </div>
                  ))}
                {!loading && !rows.length && <p className="pl-empty">{queries[c.id] ? 'No coins match that search.' : c.empty}</p>}
                {rows.map((r) => (
                  <Card key={r.mint} r={r} kind={c.id} now={now} qb={qb} onOpen={onOpenToken} onBuy={(row) => onQuickBuy(row, qb)} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}
