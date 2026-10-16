'use client';

// Yapper's own candlestick chart, drawn in the site's colors.
// Candles come from GeckoTerminal's free OHLCV API (fetched by each viewer's
// browser, so the free rate limit applies per user, not to the whole site).
// If the data can't be loaded, it falls back to the DexScreener embed.

import { useEffect, useRef, useState } from 'react';

const GT = 'https://api.geckoterminal.com/api/v2/networks/solana';

const FRAMES = [
  { id: '1m', tf: 'minute', agg: 1 },
  { id: '5m', tf: 'minute', agg: 5 },
  { id: '15m', tf: 'minute', agg: 15 },
  { id: '1h', tf: 'hour', agg: 1 },
  { id: '4h', tf: 'hour', agg: 4 },
  { id: '1D', tf: 'day', agg: 1 },
];

const C = {
  text: '#6E8F84',
  grid: 'rgba(18, 51, 42, 0.55)',
  line: '#12332A',
  up: '#00F5A8',
  down: '#FF6B81',
  upVol: 'rgba(0, 245, 168, 0.28)',
  downVol: 'rgba(255, 107, 129, 0.28)',
};

function decimalsFor(v) {
  if (!v || v <= 0) return 2;
  if (v >= 1) return 4;
  return Math.min(12, Math.max(2, -Math.floor(Math.log10(v)) + 3));
}

function compactUsd(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ohlcv_list rows are [time, open, high, low, close, volume], newest first
function toBars(list, mult) {
  const seen = new Set();
  const bars = [];
  for (const row of [...(list || [])].reverse()) {
    const [t, o, h, l, c, v] = row.map(Number);
    if (!t || seen.has(t) || !(c > 0)) continue;
    seen.add(t);
    bars.push({ time: t, open: o * mult, high: h * mult, low: l * mult, close: c * mult, volume: v });
  }
  return bars;
}

export default function PriceChart({ mint, pairAddress, supply, symbol }) {
  const box = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const volRef = useRef(null);
  const poolRef = useRef(null);
  const lastTimeRef = useRef(0);

  const [frame, setFrame] = useState(FRAMES[0]);
  const [mode, setMode] = useState('mcap'); // 'mcap' | 'price'
  const [state, setState] = useState('loading'); // loading | ready | empty | fallback
  const [chartReady, setChartReady] = useState(false);
  const [sup, setSup] = useState(0);

  // lock the token's supply once per token (used to turn price into market cap)
  useEffect(() => { setSup(0); }, [mint]);
  useEffect(() => { if (!sup && supply > 0) setSup(supply); }, [supply, sup]);

  const useMcap = mode === 'mcap' && sup > 0;
  const mult = useMcap ? sup : 1;

  // create the chart once
  useEffect(() => {
    let disposed = false;
    (async () => {
      const { createChart, CrosshairMode } = await import('lightweight-charts');
      if (disposed || !box.current) return;
      const chart = createChart(box.current, {
        autoSize: true,
        layout: {
          background: { type: 'solid', color: 'transparent' },
          textColor: C.text,
          fontFamily: 'var(--font-mono), ui-monospace, monospace',
          fontSize: 11,
        },
        grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
        rightPriceScale: { borderColor: C.line, scaleMargins: { top: 0.1, bottom: 0.22 } },
        timeScale: { borderColor: C.line, timeVisible: true, secondsVisible: false, rightOffset: 4 },
        crosshair: {
          mode: CrosshairMode.Normal,
          vertLine: { color: 'rgba(125,255,211,0.35)', labelBackgroundColor: '#0B2019' },
          horzLine: { color: 'rgba(125,255,211,0.35)', labelBackgroundColor: '#0B2019' },
        },
      });
      const series = chart.addCandlestickSeries({
        upColor: C.up,
        downColor: C.down,
        wickUpColor: C.up,
        wickDownColor: C.down,
        borderVisible: false,
      });
      const vol = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
      chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      chartRef.current = chart;
      seriesRef.current = series;
      volRef.current = vol;
      setChartReady(true);
    })();
    return () => {
      disposed = true;
      chartRef.current?.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volRef.current = null;
    };
  }, []);

  // work out which pool GeckoTerminal knows this token by (once per token)
  useEffect(() => {
    poolRef.current = null;
  }, [mint, pairAddress]);

  // load candles whenever token, timeframe or mode changes, then keep them live
  useEffect(() => {
    if (!chartReady || !mint) return;
    let cancelled = false;
    let timer;

    const fmt = useMcap
      ? { type: 'custom', formatter: (v) => compactUsd(v), minMove: 0.01 }
      : null;

    const ohlcvUrl = (pool, limit) =>
      `${GT}/pools/${pool}/ohlcv/${frame.tf}?aggregate=${frame.agg}&limit=${limit}&currency=usd&token=base`;

    async function findPool() {
      if (poolRef.current) return poolRef.current;
      if (pairAddress) {
        try {
          const j = await getJson(ohlcvUrl(pairAddress, 1));
          if (j?.data?.attributes?.ohlcv_list) {
            poolRef.current = pairAddress;
            return pairAddress;
          }
        } catch {}
      }
      const j = await getJson(`${GT}/tokens/${mint}/pools?page=1`);
      const pool = j?.data?.[0]?.attributes?.address;
      if (!pool) throw new Error('no pool');
      poolRef.current = pool;
      return pool;
    }

    async function load() {
      setState('loading');
      try {
        const pool = await findPool();
        const j = await getJson(ohlcvUrl(pool, 300));
        if (cancelled) return;
        const bars = toBars(j?.data?.attributes?.ohlcv_list, mult);
        if (!bars.length) { setState('empty'); seriesRef.current.setData([]); volRef.current.setData([]); return; }

        const last = bars[bars.length - 1].close;
        const d = decimalsFor(last / mult);
        seriesRef.current.applyOptions({
          priceFormat: fmt || { type: 'custom', formatter: (v) => `$${v.toFixed(d)}`, minMove: Math.pow(10, -d) },
        });
        seriesRef.current.setData(bars);
        volRef.current.setData(bars.map((b) => ({ time: b.time, value: b.volume, color: b.close >= b.open ? C.upVol : C.downVol })));
        lastTimeRef.current = bars[bars.length - 1].time;
        chartRef.current.timeScale().fitContent();
        if (bars.length > 120) chartRef.current.timeScale().setVisibleLogicalRange({ from: bars.length - 120, to: bars.length + 4 });
        setState('ready');
        timer = setTimeout(refresh, 20000);
      } catch {
        if (!cancelled) setState('fallback');
      }
    }

    async function refresh() {
      try {
        const j = await getJson(ohlcvUrl(poolRef.current, 3));
        if (cancelled) return;
        for (const b of toBars(j?.data?.attributes?.ohlcv_list, mult)) {
          if (b.time < lastTimeRef.current) continue;
          seriesRef.current.update(b);
          volRef.current.update({ time: b.time, value: b.volume, color: b.close >= b.open ? C.upVol : C.downVol });
          lastTimeRef.current = b.time;
        }
      } catch {}
      if (!cancelled) timer = setTimeout(refresh, 20000);
    }

    load();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [chartReady, mint, pairAddress, frame, useMcap, mult]);

  const embed = pairAddress
    ? `https://dexscreener.com/solana/${pairAddress}?embed=1&loadChartSettings=0&trades=0&tabs=0&info=0&chartLeftToolbar=0&chartTheme=dark&theme=dark&chartStyle=1&chartType=usd&interval=1`
    : null;

  return (
    <div className="pc">
      <div className="pc-bar">
        <div className="pc-group" role="group" aria-label="Timeframe">
          {FRAMES.map((f) => (
            <button key={f.id} type="button" className={`pc-btn ${frame.id === f.id ? 'on' : ''}`} onClick={() => setFrame(f)} disabled={state === 'fallback'}>
              {f.id}
            </button>
          ))}
        </div>
        <div className="pc-group" role="group" aria-label="Chart value">
          <button type="button" className={`pc-btn ${useMcap ? 'on' : ''}`} onClick={() => setMode('mcap')} disabled={!(sup > 0) || state === 'fallback'}>MCap</button>
          <button type="button" className={`pc-btn ${!useMcap ? 'on' : ''}`} onClick={() => setMode('price')} disabled={state === 'fallback'}>Price</button>
        </div>
      </div>
      <div className="pc-area">
        <div ref={box} className="pc-canvas" style={{ visibility: state === 'fallback' ? 'hidden' : 'visible' }} aria-label={`${symbol || 'Token'} chart`} role="img" />
        {state === 'loading' && <div className="pc-note">Loading chart…</div>}
        {state === 'empty' && <div className="pc-note">No trades in this timeframe yet.</div>}
        {state === 'fallback' && (embed
          ? <iframe className="pc-embed" src={embed} title={`${symbol || 'Token'} chart`} />
          : <div className="pc-note">Chart not available for this token yet. You can still trade it.</div>)}
      </div>
    </div>
  );
}
