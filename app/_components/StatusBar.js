'use client';

import { useEffect, useState } from 'react';
import { getRpcHealth, onRpcHealth, rpc } from '../_lib/chain';

export default function StatusBar({ solPrice, onVoice }) {
  const [health, setHealth] = useState(() => getRpcHealth());

  useEffect(() => onRpcHealth(setHealth), []);

  // light ping so the connection indicator stays honest
  useEffect(() => {
    const ping = () => {
      if (!document.hidden) rpc('getLatestBlockhash', [{ commitment: 'processed' }]).catch(() => {});
    };
    ping();
    const t = setInterval(ping, 30000);
    return () => clearInterval(t);
  }, []);

  const state = !health.okAt && !health.errAt ? 'idle' : health.okAt > health.errAt ? 'ok' : 'down';

  return (
    <footer className="sb">
      <div className="sb-left">
        <span className="sb-conn">
          <span className={`sb-dot ${state}`} aria-hidden="true" />
          {state === 'ok' ? 'Live' : state === 'down' ? 'Offline' : 'Connecting'}
          {state === 'ok' && health.latency !== null && <span className="muted hide-sm">{health.latency} ms</span>}
        </span>
        <span className="sb-div" aria-hidden="true" />
        <span className="hide-sm">
          SOL <b>{solPrice ? `$${solPrice.toFixed(2)}` : '—'}</b>
        </span>
        <span className="sb-div hide-sm" aria-hidden="true" />
        <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer" title="Charts by TradingView">
          <span className="hide-sm">Charts by </span>TradingView
        </a>
      </div>

      <div className="sb-voice">
        <button type="button" className="orb" onClick={onVoice} aria-describedby="sb-voice-note">
          <img src="/orb.png" alt="" width="46" height="46" />
          <span className="sr-only">Voice trading</span>
        </button>
        <span className="sb-voice-note" id="sb-voice-note">
          Voice trading <span className="soon">Soon</span>
        </span>
      </div>

      <div className="sb-right">
        <span className="sb-sol-m">
          SOL <b>{solPrice ? `$${solPrice.toFixed(2)}` : '—'}</b>
        </span>
        <a className="hide-sm" href="https://x.com/YapperTrade" target="_blank" rel="noreferrer">
          @YapperTrade
        </a>
        <a className="hide-sm" href="https://yapper.trade" target="_blank" rel="noreferrer">
          yapper.trade
        </a>
      </div>
    </footer>
  );
}
