'use client';

// Candlestick chart drawn in Yapper's own style (TradingView Lightweight Charts).
// History comes from GeckoTerminal; the latest DexScreener price (refreshed
// every 10s) is merged into the newest candle so the chart moves in real time.
// If a coin has no history yet, the chart builds live candles from now on.
// Second candles (1s to 30s) aren't offered by any history API, so they're
// built here from the coin's trades: the last few hundred from GeckoTerminal,
// then every new trade as it happens (PumpPortal's feed for pump.fun coins,
// plus a GeckoTerminal poll for everything else).

import { useCallback, useEffect, useRef, useState } from 'react';
import { gt, listPools, rememberPool, knownPool, withPool, parseTrades } from '../_lib/markets';
import { usd, price as fmtPrice, pct, amount as fmtAmount, sol as fmtSol } from '../_lib/format';
import { TokenImage } from './Icons';

const FRAMES = [
  { id: '1s', tf: 'second', sec: 1 },
  { id: '5s', tf: 'second', sec: 5 },
  { id: '15s', tf: 'second', sec: 15 },
  { id: '30s', tf: 'second', sec: 30 },
  { id: '1m', tf: 'minute', agg: 1, sec: 60 },
  { id: '5m', tf: 'minute', agg: 5, sec: 300 },
  { id: '15m', tf: 'minute', agg: 15, sec: 900 },
  { id: '1h', tf: 'hour', agg: 1, sec: 3600 },
  { id: '4h', tf: 'hour', agg: 4, sec: 14400 },
  { id: '1D', tf: 'day', agg: 1, sec: 86400 },
];

const C = {
  text: '#74867F',
  up: '#00F5A8',
  down: '#FF5C74',
  upVol: 'rgba(0, 245, 168, 0.18)',
  downVol: 'rgba(255, 92, 116, 0.18)',
  cross: 'rgba(230, 239, 235, 0.3)',
  label: '#1B2621',
};

function decimalsFor(v) {
  if (!v || v <= 0) return 2;
  if (v >= 1) return 4;
  return Math.min(12, Math.max(2, -Math.floor(Math.log10(v)) + 3));
}

// axis labels: 804.63K, 1.25M
function compact(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  return v.toFixed(2);
}

// ohlcv_list rows are [time, open, high, low, close, volume], newest first
function toBars(list, mult) {
  const seen = new Set();
  const bars = [];
  for (const row of [...(list || [])].reverse()) {
    const [t, o, h, l, c, v] = row.map(Number);
    if (!t || seen.has(t) || !(c > 0)) continue;
    seen.add(t);
    bars.push({ time: t, open: o * mult, high: h * mult, low: l * mult, close: c * mult, volume: v || 0 });
  }
  return bars;
}

// trades -> candles. ticks are { t: seconds, p: usd price, v: usd volume }.
// A candle opens at the previous close so a quiet stretch doesn't leave gaps.
const MAX_TICKS = 6000;
function tickBars(ticks, sec, mult) {
  const list = [...ticks.values()].sort((a, b) => a.t - b.t).slice(-MAX_TICKS);
  const bars = [];
  let bar = null;
  for (const k of list) {
    const time = Math.floor(k.t / sec) * sec;
    const v = k.p * mult;
    if (bar && bar.time === time) {
      bar.high = Math.max(bar.high, v);
      bar.low = Math.min(bar.low, v);
      bar.close = v;
      bar.volume += k.v || 0;
    } else {
      const open = bar ? bar.close : v;
      bar = { time, open, high: Math.max(open, v), low: Math.min(open, v), close: v, volume: k.v || 0 };
      bars.push(bar);
    }
  }
  return bars;
}

const FEED_URL = 'wss://pumpportal.fun/api/data';

const volBar = (b) => ({ time: b.time, value: b.volume || 0, color: b.close >= b.open ? C.upVol : C.downVol });
const candle = (b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close });

// nearest bar time to t (seconds), or null if there's no bar close by
function snapTime(times, t, sec) {
  if (!times.length) return null;
  const bucket = Math.floor(t / sec) * sec;
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < bucket) lo = mid + 1;
    else hi = mid;
  }
  let best = times[lo];
  if (lo > 0 && Math.abs(times[lo - 1] - bucket) < Math.abs(best - bucket)) best = times[lo - 1];
  return Math.abs(best - bucket) <= sec * 2 ? best : null;
}

const MAX_FILLS = 60;

export default function PriceChart({ mint, pairAddress, supply, symbol, imageUrl, livePrice, fills = [], avgEntryUsd = null, solPrice = null, orders = [] }) {
  const box = useRef(null);
  const avatarRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const volRef = useRef(null);
  const lastBarRef = useRef(null);
  const athRef = useRef(null);
  const hoverRef = useRef(false);
  const stateRef = useRef('loading');
  const timesRef = useRef([]); // bar times on the chart, ascending
  const fillEls = useRef(new Map()); // sig -> bubble element
  const fillData = useRef({ fills: [], mult: 1, solPrice: null, sec: 60 });
  const entryLineRef = useRef(null);
  const orderLinesRef = useRef([]);
  const addTickRef = useRef(null); // set while second candles are showing
  const solPriceRef = useRef(solPrice);
  solPriceRef.current = solPrice;
  const lastFeedRef = useRef(0); // when the live trade feed last delivered

  const [frame, setFrame] = useState(() => FRAMES.find((f) => f.id === '1m'));
  const [mode, setMode] = useState('mcap'); // 'mcap' | 'price'
  const [state, setStateRaw] = useState('loading'); // loading | ready | live | empty | error
  const [chartReady, setChartReady] = useState(false);
  const [sup, setSup] = useState(0);
  const [legend, setLegend] = useState(null);
  const [liveBars, setLiveBars] = useState(0); // candles built from live prices (no history)

  const setState = useCallback((s) => {
    stateRef.current = s;
    setStateRaw(s);
  }, []);

  // lock the supply once per coin (turns price into market cap)
  useEffect(() => {
    if (!sup && supply > 0) setSup(supply);
  }, [supply, sup]);

  const useMcap = mode === 'mcap' && sup > 0;
  const mult = useMcap ? sup : 1;

  // your buys and sells as bubbles at the price they filled
  const placeFills = () => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    const { fills: list, mult: m, solPrice: sp, sec } = fillData.current;
    for (const f of list) {
      const el = fillEls.current.get(f.sig);
      if (!el) continue;
      const t = chart && series && sp ? snapTime(timesRef.current, Math.floor(f.time / 1000), sec) : null;
      const x = t === null ? null : chart.timeScale().timeToCoordinate(t);
      const y = x === null ? null : series.priceToCoordinate((Math.abs(f.sol) / Math.abs(f.tokens)) * sp * m);
      if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) {
        el.style.opacity = '0';
        continue;
      }
      el.style.opacity = '1';
      el.style.transform = `translate(${Math.round(x - 9)}px, ${Math.round(y - 9)}px)`;
    }
  };

  // keep the coin's avatar pinned to the highest candle on screen
  const placeAvatar = useCallback(() => {
    const el = avatarRef.current;
    const chart = chartRef.current;
    const series = seriesRef.current;
    const ath = athRef.current;
    placeFills();
    if (!el) return;
    if (!chart || !series || !ath) {
      el.style.opacity = '0';
      return;
    }
    const x = chart.timeScale().timeToCoordinate(ath.time);
    const y = series.priceToCoordinate(ath.high);
    if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y) || y < 14) {
      el.style.opacity = '0';
      return;
    }
    el.style.opacity = '1';
    el.style.transform = `translate(${Math.round(x - 13)}px, ${Math.round(y - 34)}px)`;
  }, []);

  const noteTime = (t) => {
    const ts = timesRef.current;
    if (!ts.length || t > ts[ts.length - 1]) ts.push(t);
  };

  const bumpAth = (b) => {
    if (!athRef.current || b.high > athRef.current.high) athRef.current = { time: b.time, high: b.high };
  };

  const applyFormat = useCallback(
    (sample) => {
      const d = decimalsFor(sample / mult);
      seriesRef.current?.applyOptions({
        priceFormat: useMcap
          ? { type: 'custom', formatter: (v) => compact(v), minMove: 0.01 }
          : { type: 'custom', formatter: (v) => fmtPrice(v).replace('$', ''), minMove: Math.pow(10, -d) },
      });
    },
    [mult, useMcap]
  );

  // create the chart once
  useEffect(() => {
    let disposed = false;
    (async () => {
      const { createChart, CrosshairMode, LineStyle } = await import('lightweight-charts');
      if (disposed || !box.current) return;
      const fontFamily = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';
      const chart = createChart(box.current, {
        autoSize: true,
        layout: {
          background: { type: 'solid', color: 'transparent' },
          textColor: C.text,
          fontFamily,
          fontSize: 11,
          attributionLogo: false,
        },
        grid: { vertLines: { visible: false }, horzLines: { visible: false } },
        rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.2, bottom: 0.2 } },
        timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 8, barSpacing: 7 },
        crosshair: {
          mode: CrosshairMode.Normal,
          vertLine: { color: C.cross, style: LineStyle.Dashed, labelBackgroundColor: C.label },
          horzLine: { color: C.cross, style: LineStyle.Dashed, labelBackgroundColor: C.label },
        },
      });
      const series = chart.addCandlestickSeries({
        upColor: C.up,
        downColor: C.down,
        wickUpColor: C.up,
        wickDownColor: C.down,
        borderVisible: false,
        priceLineStyle: LineStyle.Dotted,
        priceLineWidth: 1,
      });
      const vol = chart.addHistogramSeries({
        priceFormat: { type: 'volume' },
        priceScaleId: 'vol',
        lastValueVisible: false,
        priceLineVisible: false,
      });
      chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
      chart.subscribeCrosshairMove((param) => {
        const d = param && param.time ? param.seriesData?.get(series) : null;
        hoverRef.current = !!(d && 'open' in d);
        setLegend(hoverRef.current ? d : lastBarRef.current);
      });
      const ts = chart.timeScale();
      ts.subscribeVisibleLogicalRangeChange(() => requestAnimationFrame(placeAvatar));
      ts.subscribeSizeChange?.(() => requestAnimationFrame(placeAvatar));
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
  }, [placeAvatar]);

  // load history when the coin, timeframe or mode changes, then keep it fresh
  useEffect(() => {
    if (!chartReady || !mint) return;
    let cancelled = false;
    let timer;
    const isCancelled = () => cancelled;
    const ohlcv = async (pool) => {
      try {
        const j = await gt(`/pools/${pool}/ohlcv/${frame.tf}?aggregate=${frame.agg}&limit=300&currency=usd&token=base`, isCancelled);
        return j?.data?.attributes?.ohlcv_list || [];
      } catch (e) {
        if (e?.status === 404) return [];
        throw e;
      }
    };

    // Try the pool we know works, then DexScreener's pair, then the coin's
    // other pools. Some coins trade on a pool with no history (for example one
    // quoted in another token), while a sibling pool has full candles.
    const fetchBars = async () => {
      const known = knownPool(mint);
      if (known) {
        const list = await ohlcv(known);
        if (list.length) return { data: { attributes: { ohlcv_list: list } } };
      }
      const tried = new Set(known ? [known] : []);
      if (pairAddress && !tried.has(pairAddress)) {
        tried.add(pairAddress);
        const list = await ohlcv(pairAddress);
        if (list.length) {
          rememberPool(mint, pairAddress);
          return { data: { attributes: { ohlcv_list: list } } };
        }
      }
      let others = [];
      try {
        others = (await listPools(mint, isCancelled)).filter((p) => !tried.has(p)).slice(0, 3);
      } catch (e) {
        if (e?.cancelled) throw e;
      }
      for (const pool of others) {
        const list = await ohlcv(pool);
        if (list.length) {
          rememberPool(mint, pool);
          return { data: { attributes: { ohlcv_list: list } } };
        }
      }
      return { data: { attributes: { ohlcv_list: [] } } };
    };

    const setAll = (bars) => {
      applyFormat(bars[bars.length - 1].close);
      seriesRef.current.setData(bars.map(candle));
      volRef.current.setData(bars.map(volBar));
      lastBarRef.current = bars[bars.length - 1];
      timesRef.current = bars.map((b) => b.time);
      athRef.current = null;
      bars.forEach(bumpAth);
      const ts = chartRef.current.timeScale();
      ts.fitContent();
      if (bars.length > 120) ts.setVisibleLogicalRange({ from: bars.length - 120, to: bars.length + 8 });
      if (!hoverRef.current) setLegend(lastBarRef.current);
      requestAnimationFrame(placeAvatar);
    };

    seriesRef.current.setData([]);
    volRef.current.setData([]);
    lastBarRef.current = null;
    timesRef.current = [];
    athRef.current = null;
    setLiveBars(0);
    setLegend(null);
    requestAnimationFrame(placeAvatar);
    setState('loading');
    chartRef.current?.applyOptions({ timeScale: { secondsVisible: frame.tf === 'second' } });
    addTickRef.current = null;

    if (frame.tf === 'second') {
      const ticks = new Map(); // trade signature -> tick
      // newest trades go straight onto the chart; a late, older one redraws it
      const addTick = (id, tick) => {
        if (cancelled || ticks.has(id) || !(tick.p > 0) || !(tick.t > 0)) return false;
        ticks.set(id, tick);
        if (ticks.size > MAX_TICKS * 1.2) {
          const keep = [...ticks.entries()].sort((a, b) => a[1].t - b[1].t).slice(-MAX_TICKS);
          ticks.clear();
          keep.forEach(([k, v]) => ticks.set(k, v));
        }
        return true;
      };
      const redraw = (fresh) => {
        const bars = tickBars(ticks, frame.sec, mult);
        if (!bars.length) return false;
        if (fresh) setAll(bars);
        else {
          seriesRef.current.setData(bars.map(candle));
          volRef.current.setData(bars.map(volBar));
          lastBarRef.current = bars[bars.length - 1];
          timesRef.current = bars.map((b) => b.time);
          athRef.current = null;
          bars.forEach(bumpAth);
          if (!hoverRef.current) setLegend(lastBarRef.current);
          requestAnimationFrame(placeAvatar);
        }
        return true;
      };
      // one live trade: extend the newest candle, or redraw if it's out of order
      addTickRef.current = (id, tick) => {
        if (!addTick(id, tick)) return;
        const last = lastBarRef.current;
        const time = Math.floor(tick.t / frame.sec) * frame.sec;
        if (stateRef.current !== 'ready' || !last || time < last.time) {
          if (redraw(stateRef.current !== 'ready')) setState('ready');
          return;
        }
        const v = tick.p * mult;
        const bar =
          time === last.time
            ? { ...last, high: Math.max(last.high, v), low: Math.min(last.low, v), close: v, volume: last.volume + (tick.v || 0) }
            : { time, open: last.close, high: Math.max(last.close, v), low: Math.min(last.close, v), close: v, volume: tick.v || 0 };
        try {
          seriesRef.current.update(candle(bar));
          volRef.current.update(volBar(bar));
        } catch {
          redraw(false);
          return;
        }
        lastBarRef.current = bar;
        noteTime(bar.time);
        bumpAth(bar);
        if (!hoverRef.current) setLegend(bar);
        requestAnimationFrame(placeAvatar);
      };

      const poll = async () => {
        if (!document.hidden || stateRef.current === 'loading') {
          try {
            const j = await withPool(mint, pairAddress, (pool) => gt(`/pools/${pool}/trades`, isCancelled), isCancelled);
            if (cancelled) return;
            let added = false;
            for (const tr of parseTrades(j?.data, mint)) {
              if (addTick(tr.tx || tr.id, { t: tr.time / 1000, p: tr.priceUsd, v: tr.usd || 0 })) added = true;
            }
            const first = stateRef.current !== 'ready';
            if (added || first) {
              if (redraw(first)) setState('ready');
              else if (stateRef.current !== 'live') setState('empty');
            }
          } catch (e) {
            if (cancelled || e?.cancelled) return;
            if (stateRef.current === 'loading') setState('error');
          }
        }
        // the live feed carries pump.fun coins; the poll keeps everything else moving
        const feedOn = Date.now() - lastFeedRef.current < 30000;
        if (!cancelled) timer = setTimeout(poll, stateRef.current === 'error' ? 30000 : feedOn ? 20000 : 8000);
      };
      poll();
      return () => {
        cancelled = true;
        clearTimeout(timer);
        addTickRef.current = null;
      };
    }

    async function load() {
      try {
        const j = await fetchBars();
        if (cancelled) return;
        const bars = toBars(j?.data?.attributes?.ohlcv_list, mult);
        if (bars.length) {
          setAll(bars);
          setState('ready');
        } else if (stateRef.current !== 'live') {
          setState('empty');
        }
        timer = setTimeout(refresh, 20000);
      } catch (e) {
        if (cancelled || e?.cancelled) return;
        if (stateRef.current !== 'live') setState('error');
        timer = setTimeout(load, 30000);
      }
    }

    async function refresh() {
      if (!document.hidden) {
        try {
          const j = await fetchBars();
          if (cancelled) return;
          const bars = toBars(j?.data?.attributes?.ohlcv_list, mult);
          if (bars.length && stateRef.current !== 'ready') {
            setAll(bars);
            setState('ready');
          } else if (bars.length) {
            for (const b of bars) {
              const last = lastBarRef.current;
              if (last && b.time < last.time) continue;
              seriesRef.current.update(candle(b));
              volRef.current.update(volBar(b));
              lastBarRef.current = b;
              noteTime(b.time);
              bumpAth(b);
            }
            if (!hoverRef.current) setLegend(lastBarRef.current);
            requestAnimationFrame(placeAvatar);
          }
        } catch {}
      }
      if (!cancelled) timer = setTimeout(refresh, 20000);
    }

    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // applyFormat and placeAvatar only change with mult, which is already listed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartReady, mint, pairAddress, frame, mult]);

  // merge the latest price into the newest candle (or start a new one)
  useEffect(() => {
    const p = Number(livePrice);
    const series = seriesRef.current;
    if (!chartReady || !series || !(p > 0) || stateRef.current === 'loading') return;
    // second candles come from trades; the 10s price only starts a chart that has none
    if (frame.tf === 'second' && stateRef.current === 'ready') return;
    const v = p * mult;
    const bucket = Math.floor(Date.now() / 1000 / frame.sec) * frame.sec;
    const last = lastBarRef.current;
    let bar;
    if (!last) bar = { time: bucket, open: v, high: v, low: v, close: v, volume: 0 };
    else if (bucket > last.time) bar = { time: bucket, open: last.close, high: Math.max(last.close, v), low: Math.min(last.close, v), close: v, volume: 0 };
    else if (bucket === last.time) bar = { ...last, high: Math.max(last.high, v), low: Math.min(last.low, v), close: v };
    else return;
    if (!last) applyFormat(v);
    try {
      series.update(candle(bar));
    } catch {
      return;
    }
    lastBarRef.current = bar;
    noteTime(bar.time);
    bumpAth(bar);
    if (timesRef.current.length <= 3) setLiveBars(timesRef.current.length);
    if (stateRef.current === 'empty' || stateRef.current === 'error') setState('live');
    if (!hoverRef.current) setLegend(bar);
    requestAnimationFrame(placeAvatar);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [livePrice, chartReady, mult, frame, state]);

  // every trade on a pump.fun coin as it happens, for second candles
  const seconds = frame.tf === 'second';
  useEffect(() => {
    if (!seconds || !mint || typeof WebSocket === 'undefined') return;
    let ws = null;
    let stopped = false;
    let timer = 0;
    let attempt = 0;
    const open = () => {
      try {
        ws = new WebSocket(FEED_URL);
      } catch {
        return;
      }
      ws.onopen = () => {
        attempt = 0;
        ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
      };
      ws.onmessage = (e) => {
        let m;
        try {
          m = JSON.parse(e.data);
        } catch {
          return;
        }
        const sp = solPriceRef.current;
        const tokens = Number(m?.tokenAmount);
        const solAmt = Number(m?.solAmount);
        if (!m || m.mint !== mint || !m.signature || !(sp > 0) || !(tokens > 0) || !(solAmt > 0)) return;
        lastFeedRef.current = Date.now();
        // same measure GeckoTerminal uses: what the trade paid per token
        addTickRef.current?.(m.signature, { t: Date.now() / 1000, p: (solAmt / tokens) * sp, v: solAmt * sp });
      };
      ws.onclose = () => {
        if (stopped) return;
        attempt++;
        timer = setTimeout(open, Math.min(30000, 1500 * 2 ** Math.min(attempt, 5)));
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {}
      };
    };
    open();
    return () => {
      stopped = true;
      clearTimeout(timer);
      if (ws) {
        ws.onclose = null;
        try {
          ws.close();
        } catch {}
      }
    };
  }, [seconds, mint]);

  // your trades: bubbles follow the chart as it scrolls and rescales
  const shownFills = fills.filter((f) => (f.side === 'buy' || f.side === 'sell') && f.tokens && f.sol).slice(-MAX_FILLS);
  fillData.current = { fills: shownFills, mult, solPrice, sec: frame.sec };
  useEffect(() => {
    requestAnimationFrame(placeAvatar);
  });

  // your average entry as a line across the chart
  useEffect(() => {
    const series = seriesRef.current;
    if (!chartReady || !series) return;
    if (entryLineRef.current) {
      try {
        series.removePriceLine(entryLineRef.current);
      } catch {}
      entryLineRef.current = null;
    }
    const v = Number(avgEntryUsd) * mult;
    if (!(v > 0)) return;
    entryLineRef.current = series.createPriceLine({
      price: v,
      color: '#A3B4AD',
      lineWidth: 1,
      lineStyle: 2, // dashed
      // the value is in the position card; a box on the axis would sit on top of the live price
      axisLabelVisible: false,
      title: 'Avg entry',
    });
  }, [avgEntryUsd, mult, chartReady]);

  // open orders and alerts as lines at their trigger
  const orderKey = orders.map((o) => `${o.id}:${o.targetMc}:${o.status}`).join('|');
  useEffect(() => {
    const series = seriesRef.current;
    if (!chartReady || !series) return;
    for (const l of orderLinesRef.current) {
      try {
        series.removePriceLine(l);
      } catch {}
    }
    orderLinesRef.current = [];
    if (!(sup > 0)) return;
    for (const o of orders) {
      const v = useMcap ? o.targetMc : o.targetMc / sup;
      if (!(v > 0)) continue;
      const kind = o.type === 'alert' ? 'alert' : o.type === 'buy' ? 'buy' : o.dir === 'above' ? 'tp' : 'sl';
      const color = { alert: '#F5B74E', buy: '#00F5A8', tp: '#00F5A8', sl: '#FF5C74' }[kind];
      const title = { alert: 'Alert', buy: `Limit buy ${o.amountSol}`, tp: `TP ${o.percent}%`, sl: `SL ${o.percent}%` }[kind];
      orderLinesRef.current.push(
        series.createPriceLine({ price: v, color, lineWidth: 1, lineStyle: kind === 'alert' ? 1 : 2, axisLabelVisible: true, title })
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderKey, chartReady, useMcap, sup]);

  const fmtV = (v) => (useMcap ? usd(v) : fmtPrice(v));
  const dir = legend && legend.close >= legend.open ? 'up' : 'down';
  const showChart = state === 'ready' || state === 'live';

  return (
    <div className="pc">
      <div className="pc-bar">
        <div className="pills" role="group" aria-label="Timeframe">
          {FRAMES.map((f) => (
            <button key={f.id} type="button" className={frame.id === f.id ? 'on' : undefined} aria-pressed={frame.id === f.id} onClick={() => setFrame(f)}>
              {f.id}
            </button>
          ))}
        </div>
        <div className="pills" role="group" aria-label="Chart shows">
          <button type="button" className={useMcap ? 'on' : undefined} aria-pressed={useMcap} onClick={() => setMode('mcap')} disabled={!(sup > 0)}>
            Market cap
          </button>
          <button type="button" className={!useMcap ? 'on' : undefined} aria-pressed={!useMcap} onClick={() => setMode('price')}>
            Price
          </button>
        </div>
      </div>

      <div className="pc-area">
        <div ref={box} className="pc-canvas" role="img" aria-label={`${symbol || 'Coin'} ${useMcap ? 'market cap' : 'price'} chart, ${frame.id} candles`} />
        <div ref={avatarRef} className="pc-avatar" aria-hidden="true">
          <TokenImage src={imageUrl} label={symbol} size={24} />
        </div>
        {shownFills.map((f) => {
          const buy = f.side === 'buy';
          const when = new Date(f.time).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
          const label = `${buy ? 'Bought' : 'Sold'} ${fmtAmount(Math.abs(f.tokens))} ${symbol || ''} for ${fmtSol(Math.abs(f.sol))} SOL, ${when}`;
          return (
            <div
              key={f.sig}
              ref={(el) => {
                if (el) fillEls.current.set(f.sig, el);
                else fillEls.current.delete(f.sig);
              }}
              className={`pc-fill ${buy ? 'buy' : 'sell'}`}
              title={label}
              role="img"
              aria-label={label}
            >
              {buy ? 'B' : 'S'}
            </div>
          );
        })}

        {legend && showChart && (
          <div className="pc-legend" aria-hidden="true">
            <span className="pc-sym">
              {symbol || 'Coin'} <span className="muted">{useMcap ? 'Market cap' : 'Price'}</span>
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
            {state === 'live' && <span className="pc-live">Live from now</span>}
          </div>
        )}

        {state === 'live' && liveBars < 3 && (
          <div className="pc-hint" role="status">
            <span className="pc-hint-dot" aria-hidden="true" />
            Building the chart from live trades. Earlier history isn't available for this coin yet.
          </div>
        )}
        {state === 'loading' && <div className="pc-note">Loading chart…</div>}
        {state === 'empty' && <div className="pc-note">No trades in this timeframe yet. The chart starts with the next price update.</div>}
        {state === 'error' && <div className="pc-note">Chart data is busy right now. Retrying in 30 seconds.</div>}

      </div>
    </div>
  );
}
