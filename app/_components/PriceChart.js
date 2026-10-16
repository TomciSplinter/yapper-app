'use client';

// Candlestick chart in Yapper's colors (TradingView Lightweight Charts).
// Candles come from GeckoTerminal; if they can't load, it falls back to the
// DexScreener embed so there is always a chart.

import { useEffect, useRef, useState } from 'react';
import { gt, withPool } from '../_lib/markets';
import { usd, price as fmtPrice, pct } from '../_lib/format';

const FRAMES = [
  { id: '1m', tf: 'minute', agg: 1 },
  { id: '5m', tf: 'minute', agg: 5 },
  { id: '15m', tf: 'minute', agg: 15 },
  { id: '1h', tf: 'hour', agg: 1 },
  { id: '4h', tf: 'hour', agg: 4 },
  { id: '1D', tf: 'day', agg: 1 },
];

const C = {
  text: '#74867F',
  grid: 'rgba(30, 42, 37, 0.5)',
  line: '#18211D',
  up: '#00F5A8',
  down: '#FF5C74',
  upVol: 'rgba(0, 245, 168, 0.22)',
  downVol: 'rgba(255, 92, 116, 0.22)',
  cross: 'rgba(230, 239, 235, 0.22)',
  label: '#1B2621',
};

function decimalsFor(v) {
  if (!v || v <= 0) return 2;
  if (v >= 1) return 4;
  return Math.min(12, Math.max(2, -Math.floor(Math.log10(v)) + 3));
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
  const lastBarRef = useRef(null);
  const hoverRef = useRef(false);

  const [frame, setFrame] = useState(FRAMES[0]);
  const [mode, setMode] = useState('mcap'); // 'mcap' | 'price'
  const [state, setState] = useState('loading'); // loading | ready | empty | fallback
  const [chartReady, setChartReady] = useState(false);
  const [sup, setSup] = useState(0);
  const [legend, setLegend] = useState(null);

  // lock the supply once per coin (turns price into market cap)
  useEffect(() => {
    if (!sup && supply > 0) setSup(supply);
  }, [supply, sup]);

  const useMcap = mode === 'mcap' && sup > 0;
  const mult = useMcap ? sup : 1;

  // create the chart once
  useEffect(() => {
    let disposed = false;
    (async () => {
      const { createChart, CrosshairMode } = await import('lightweight-charts');
      if (disposed || !box.current) return;
      const fontFamily = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';
      const chart = createChart(box.current, {
        autoSize: true,
        layout: {
          background: { type: 'solid', color: 'transparent' },
          textColor: C.text,
          fontFamily,
          fontSize: 11,
        },
        grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
        rightPriceScale: { borderColor: C.line, scaleMargins: { top: 0.14, bottom: 0.22 } },
        timeScale: { borderColor: C.line, timeVisible: true, secondsVisible: false, rightOffset: 6 },
        crosshair: {
          mode: CrosshairMode.Normal,
          vertLine: { color: C.cross, labelBackgroundColor: C.label },
          horzLine: { color: C.cross, labelBackgroundColor: C.label },
        },
      });
      const series = chart.addCandlestickSeries({
        upColor: C.up,
        downColor: C.down,
        wickUpColor: C.up,
        wickDownColor: C.down,
        borderVisible: false,
      });
      const vol = chart.addHistogramSeries({
        priceFormat: { type: 'volume' },
        priceScaleId: 'vol',
        lastValueVisible: false,
        priceLineVisible: false,
      });
      chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      chart.subscribeCrosshairMove((param) => {
        const d = param && param.time ? param.seriesData?.get(series) : null;
        hoverRef.current = !!(d && 'open' in d);
        setLegend(hoverRef.current ? d : lastBarRef.current);
      });
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

  // load candles when the coin, timeframe or mode changes, then keep them live
  useEffect(() => {
    if (!chartReady || !mint) return;
    let cancelled = false;
    let timer;
    const isCancelled = () => cancelled;
    const path = (pool, limit) => `/pools/${pool}/ohlcv/${frame.tf}?aggregate=${frame.agg}&limit=${limit}&currency=usd&token=base`;
    const volBar = (b) => ({ time: b.time, value: b.volume, color: b.close >= b.open ? C.upVol : C.downVol });

    async function load() {
      setState('loading');
      try {
        const j = await withPool(mint, pairAddress, (pool) => gt(path(pool, 300), isCancelled), isCancelled);
        if (cancelled) return;
        const bars = toBars(j?.data?.attributes?.ohlcv_list, mult);
        if (!bars.length) {
          seriesRef.current.setData([]);
          volRef.current.setData([]);
          lastBarRef.current = null;
          setLegend(null);
          setState('empty');
        } else {
          const d = decimalsFor(bars[bars.length - 1].close / mult);
          seriesRef.current.applyOptions({
            priceFormat: useMcap
              ? { type: 'custom', formatter: (v) => usd(v), minMove: 0.01 }
              : { type: 'custom', formatter: (v) => fmtPrice(v), minMove: Math.pow(10, -d) },
          });
          seriesRef.current.setData(bars);
          volRef.current.setData(bars.map(volBar));
          lastBarRef.current = bars[bars.length - 1];
          setLegend(lastBarRef.current);
          const ts = chartRef.current.timeScale();
          ts.fitContent();
          if (bars.length > 120) ts.setVisibleLogicalRange({ from: bars.length - 120, to: bars.length + 6 });
          setState('ready');
        }
        timer = setTimeout(refresh, 20000);
      } catch (e) {
        if (!cancelled && !e?.cancelled) setState('fallback');
      }
    }

    async function refresh() {
      if (!document.hidden) {
        try {
          const j = await withPool(mint, pairAddress, (pool) => gt(path(pool, 3), isCancelled), isCancelled);
          if (cancelled) return;
          for (const b of toBars(j?.data?.attributes?.ohlcv_list, mult)) {
            const last = lastBarRef.current;
            if (last && b.time < last.time) continue;
            seriesRef.current.update(b);
            volRef.current.update(volBar(b));
            lastBarRef.current = b;
          }
          if (!hoverRef.current) setLegend(lastBarRef.current);
          if (lastBarRef.current) setState('ready');
        } catch {}
      }
      if (!cancelled) timer = setTimeout(refresh, 20000);
    }

    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [chartReady, mint, pairAddress, frame, useMcap, mult]);

  const embed = pairAddress
    ? `https://dexscreener.com/solana/${pairAddress}?embed=1&loadChartSettings=0&trades=0&tabs=0&info=0&chartLeftToolbar=0&chartTheme=dark&theme=dark&chartStyle=1&chartType=usd&interval=1`
    : null;

  const fmtV = (v) => (useMcap ? usd(v) : fmtPrice(v));
  const dir = legend && legend.close >= legend.open ? 'up' : 'down';

  return (
    <div className="pc">
      <div className="pc-bar">
        <div className="seg" role="group" aria-label="Timeframe">
          {FRAMES.map((f) => (
            <button
              key={f.id}
              type="button"
              className={frame.id === f.id ? 'on' : undefined}
              aria-pressed={frame.id === f.id}
              onClick={() => setFrame(f)}
              disabled={state === 'fallback'}
            >
              {f.id}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Chart shows">
          <button
            type="button"
            className={useMcap ? 'on' : undefined}
            aria-pressed={useMcap}
            onClick={() => setMode('mcap')}
            disabled={!(sup > 0) || state === 'fallback'}
          >
            Market cap
          </button>
          <button
            type="button"
            className={!useMcap ? 'on' : undefined}
            aria-pressed={!useMcap}
            onClick={() => setMode('price')}
            disabled={state === 'fallback'}
          >
            Price
          </button>
        </div>
      </div>
      <div className="pc-area">
        <div
          ref={box}
          className="pc-canvas"
          style={{ visibility: state === 'fallback' ? 'hidden' : 'visible' }}
          role="img"
          aria-label={`${symbol || 'Coin'} ${useMcap ? 'market cap' : 'price'} chart, ${frame.id} candles`}
        />
        {legend && state === 'ready' && (
          <div className="pc-legend" aria-hidden="true">
            <span className="pc-sym">
              {symbol || 'Coin'} <span className="muted">{frame.id}</span>
            </span>
            <span>
              O <b className={dir}>{fmtV(legend.open)}</b>
            </span>
            <span>
              H <b className={dir}>{fmtV(legend.high)}</b>
            </span>
            <span>
              L <b className={dir}>{fmtV(legend.low)}</b>
            </span>
            <span>
              C <b className={dir}>{fmtV(legend.close)}</b>
            </span>
            <b className={dir}>{legend.open ? pct(((legend.close - legend.open) / legend.open) * 100) : ''}</b>
          </div>
        )}
        {state === 'loading' && <div className="pc-note">Loading chart…</div>}
        {state === 'empty' && <div className="pc-note">No trades in this timeframe yet. Try a longer one.</div>}
        {state === 'fallback' &&
          (embed ? (
            <iframe className="pc-embed" src={embed} title={`${symbol || 'Coin'} chart`} />
          ) : (
            <div className="pc-note">No chart for this coin yet. You can still trade it.</div>
          ))}
      </div>
    </div>
  );
}
