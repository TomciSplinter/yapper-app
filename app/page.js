'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { VersionedTransaction } from '@solana/web3.js';
import PriceChart from './PriceChart';

/* ---------- helpers ---------- */

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BUY_PRESETS = [0.1, 0.25, 0.5, 1];
const SELL_PRESETS = [25, 50, 75, 100];

// Accepts a bare CA or a pump.fun / dexscreener / solscan URL and returns the CA.
function extractMint(input) {
  const s = (input || '').trim();
  if (B58.test(s)) return s;
  const parts = s.split(/[/?#&=]/).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) if (B58.test(parts[i])) return parts[i];
  return null;
}

async function rpc(method, params) {
  const r = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'RPC error');
  return j.result;
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function getProvider() {
  if (typeof window === 'undefined') return null;
  if (window.phantom?.solana?.isPhantom) return window.phantom.solana;
  if (window.solana?.isPhantom) return window.solana;
  if (window.solflare?.isSolflare) return window.solflare;
  if (window.backpack?.solana) return window.backpack.solana;
  return null;
}

function compact(n, prefix = '$') {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${prefix}${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${prefix}${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${prefix}${(n / 1e3).toFixed(1)}K`;
  return `${prefix}${n.toFixed(2)}`;
}

function price(n) {
  if (!n) return '—';
  const v = Number(n);
  if (v >= 1) return `$${v.toFixed(4)}`;
  // show small prices like $0.0000123 without scientific notation
  return `$${v.toPrecision(3)}`.replace(/e-(\d+)/, (_, e) => `e-${e}`);
}

function short(a) {
  return a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '';
}

/* ---------- page ---------- */

export default function Terminal() {
  const [wallet, setWallet] = useState(null); // base58 pubkey
  const [solBal, setSolBal] = useState(null);
  const [query, setQuery] = useState('');
  const [mint, setMint] = useState(null);
  const [pair, setPair] = useState(null); // DexScreener pair
  const [pairState, setPairState] = useState('idle'); // idle | loading | found | none
  const [tokenBal, setTokenBal] = useState(null);

  const [side, setSide] = useState('buy');
  const [buyAmt, setBuyAmt] = useState('0.1');
  const [sellPct, setSellPct] = useState(50);
  const [slippage, setSlippage] = useState('10');
  const [prioFee, setPrioFee] = useState('0.0005');

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null); // { kind, text, sig }
  const pairTimer = useRef(null);

  // name / ticker search
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const searchSeq = useRef(0);

  /* wallet */
  const connect = useCallback(async () => {
    const p = getProvider();
    if (!p) {
      // On mobile with no injected wallet, reopen this page inside Phantom's browser.
      if (/Android|iPhone|iPad/i.test(navigator.userAgent)) {
        const url = encodeURIComponent(window.location.href);
        window.location.href = `https://phantom.app/ul/browse/${url}?ref=${encodeURIComponent(window.location.origin)}`;
        return;
      }
      window.open('https://phantom.app/download', '_blank');
      return;
    }
    try {
      await p.connect();
      const pk = p.publicKey?.toString();
      if (pk) setWallet(pk);
    } catch (e) {
      setStatus({ kind: 'err', text: e?.message || 'Wallet connection was rejected' });
    }
  }, []);

  const disconnect = useCallback(async () => {
    try { await getProvider()?.disconnect(); } catch {}
    setWallet(null);
    setSolBal(null);
    setTokenBal(null);
  }, []);

  // reconnect silently if the user approved this site before
  useEffect(() => {
    const p = getProvider();
    if (!p?.connect) return;
    p.connect({ onlyIfTrusted: true })
      .then(() => { const pk = p.publicKey?.toString(); if (pk) setWallet(pk); })
      .catch(() => {});
    const onChange = (pk) => setWallet(pk ? pk.toString() : null);
    p.on?.('accountChanged', onChange);
    return () => p.removeListener?.('accountChanged', onChange);
  }, []);

  /* balances */
  const refreshBalances = useCallback(async () => {
    if (!wallet) return;
    try {
      const b = await rpc('getBalance', [wallet, { commitment: 'confirmed' }]);
      setSolBal(b.value / 1e9);
    } catch {}
    if (mint) {
      try {
        const r = await rpc('getParsedTokenAccountsByOwner', [wallet, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
        const total = (r.value || []).reduce(
          (s, a) => s + (Number(a.account.data.parsed.info.tokenAmount.uiAmount) || 0),
          0
        );
        setTokenBal(total);
      } catch {
        setTokenBal(null);
      }
    }
  }, [wallet, mint]);

  useEffect(() => {
    refreshBalances();
    if (!wallet) return;
    const t = setInterval(refreshBalances, 15000);
    return () => clearInterval(t);
  }, [refreshBalances, wallet]);

  /* token data from DexScreener */
  const loadPair = useCallback(async (m, quiet) => {
    if (!quiet) setPairState('loading');
    try {
      const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${m}`);
      const arr = await r.json();
      if (!Array.isArray(arr) || arr.length === 0) {
        if (!quiet) { setPair(null); setPairState('none'); }
        return;
      }
      const best = [...arr].sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
      setPair(best);
      setPairState('found');
    } catch {
      if (!quiet) { setPair(null); setPairState('none'); }
    }
  }, []);

  const openToken = useCallback((m) => {
    setMint(m);
    setPair(null);
    setTokenBal(null);
    setStatus(null);
    loadPair(m);
    const u = new URL(window.location.href);
    u.searchParams.set('ca', m);
    window.history.replaceState(null, '', u.toString());
  }, [loadPair]);

  // live refresh of price stats
  useEffect(() => {
    clearInterval(pairTimer.current);
    if (!mint) return;
    pairTimer.current = setInterval(() => loadPair(mint, true), 10000);
    return () => clearInterval(pairTimer.current);
  }, [mint, loadPair]);

  // open ?ca= from the URL on first load
  useEffect(() => {
    const ca = new URLSearchParams(window.location.search).get('ca');
    const m = extractMint(ca);
    if (m) { setQuery(m); openToken(m); }
  }, [openToken]);

  // search by name/ticker as you type (debounced); a CA or link skips search
  useEffect(() => {
    const q = query.trim();
    if (extractMint(q) || q.replace(/^\$/, '').length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    const seq = ++searchSeq.current;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const j = await r.json();
        if (seq !== searchSeq.current) return; // a newer search is running
        setResults(j.results || []);
        setActiveIdx(0);
      } catch {
        if (seq === searchSeq.current) setResults([]);
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  const pickResult = (r) => {
    setShowResults(false);
    setResults([]);
    setQuery('');
    openToken(r.mint);
  };

  const onSearch = (e) => {
    e.preventDefault();
    const m = extractMint(query);
    if (m) { setShowResults(false); openToken(m); return; }
    if (results.length) { pickResult(results[activeIdx] || results[0]); return; }
    if (query.trim().length >= 2) setShowResults(true);
  };

  const onSearchKey = (e) => {
    if (!showResults || !results.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Escape') setShowResults(false);
  };

  /* trading */
  const trade = async () => {
    if (!wallet) return connect();
    if (!mint) return;
    const p = getProvider();
    if (!p) return connect();

    const isBuy = side === 'buy';
    const amount = isBuy ? Number(buyAmt) : sellPct;
    if (isBuy && !(amount > 0)) { setStatus({ kind: 'err', text: 'Enter a SOL amount.' }); return; }
    if (isBuy && solBal !== null && amount > solBal) { setStatus({ kind: 'err', text: 'Not enough SOL in your wallet.' }); return; }
    if (!isBuy && !(tokenBal > 0)) { setStatus({ kind: 'err', text: 'You don’t hold this token.' }); return; }

    setBusy(true);
    setStatus({ kind: 'info', text: 'Building transaction…' });
    try {
      const r = await fetch('/api/trade', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          publicKey: wallet,
          mint,
          action: side,
          amount: isBuy ? amount : `${amount}%`,
          slippage: Number(slippage),
          priorityFee: Number(prioFee),
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.tx) throw new Error(j.error || 'Could not build the transaction');

      const tx = VersionedTransaction.deserialize(b64ToBytes(j.tx));
      setStatus({ kind: 'info', text: 'Approve it in your wallet…' });
      const signed = await p.signTransaction(tx);

      setStatus({ kind: 'info', text: 'Sending…' });
      const sig = await rpc('sendTransaction', [
        bytesToB64(signed.serialize()),
        { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 },
      ]);

      setStatus({ kind: 'info', text: 'Confirming…', sig });
      const ok = await waitForConfirm(sig);
      if (ok === true) {
        setStatus({ kind: 'ok', text: isBuy ? `Bought with ${amount} SOL.` : `Sold ${amount}%.`, sig });
      } else if (ok === false) {
        setStatus({ kind: 'err', text: 'Transaction failed on-chain (often slippage). Try again or raise slippage.', sig });
      } else {
        setStatus({ kind: 'info', text: 'Sent, still confirming. Check the explorer link.', sig });
      }
      refreshBalances();
      setTimeout(refreshBalances, 4000);
    } catch (e) {
      const msg = e?.message || String(e);
      setStatus({ kind: 'err', text: /reject|denied|cancel/i.test(msg) ? 'You cancelled the transaction.' : msg });
    } finally {
      setBusy(false);
    }
  };

  /* render */
  const name = pair?.baseToken?.name;
  const sym = pair?.baseToken?.symbol;
  const ch24 = pair?.priceChange?.h24;
  const ch1 = pair?.priceChange?.h1;
  const supply = pair?.marketCap && Number(pair?.priceUsd) > 0 ? pair.marketCap / Number(pair.priceUsd) : 0;

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="https://yapper.trade">
          <img src="/orb.png" alt="" />
          <span>Yapper</span>
        </a>
        <form className="search" onSubmit={onSearch} role="search">
          <label htmlFor="ca" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
            Token contract address
          </label>
          <div className="search-box">
            <input
              id="ca"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setShowResults(true); }}
              onFocus={() => setShowResults(true)}
              onBlur={() => setTimeout(() => setShowResults(false), 150)}
              onKeyDown={onSearchKey}
              placeholder="Search a coin by name or ticker, or paste a CA"
              autoComplete="off"
              spellCheck={false}
              role="combobox"
              aria-expanded={showResults && results.length > 0}
              aria-controls="search-results"
            />
            {showResults && query.trim().length >= 2 && !extractMint(query) && (
              <ul className="results" id="search-results" role="listbox">
                {results.map((r, i) => (
                  <li key={r.mint} role="option" aria-selected={i === activeIdx}>
                    <button
                      type="button"
                      className={`result ${i === activeIdx ? 'on' : ''}`}
                      onMouseDown={(e) => { e.preventDefault(); pickResult(r); }}
                      onMouseEnter={() => setActiveIdx(i)}
                    >
                      {r.imageUrl ? <img src={r.imageUrl} alt="" /> : <img src="/orb.png" alt="" />}
                      <span className="r-main">
                        <span className="r-name">{r.name}</span>
                        <span className="r-sub mono">${r.symbol} · {short(r.mint)}</span>
                      </span>
                      <span className="r-stats mono">
                        <span>{compact(r.marketCap)}</span>
                        <span className={r.change24h > 0 ? 'up' : r.change24h < 0 ? 'down' : ''}>
                          {r.change24h !== null && r.change24h !== undefined ? `${r.change24h > 0 ? '+' : ''}${r.change24h}%` : ''}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
                {!results.length && (
                  <li className="r-empty">{searching ? 'Searching…' : 'No Solana coins found.'}</li>
                )}
              </ul>
            )}
          </div>
          <button className="btn btn-mint" type="submit">Open</button>
        </form>
        {wallet ? (
          <button className="btn mono" onClick={disconnect} title="Disconnect">
            {solBal !== null ? `${solBal.toFixed(3)} SOL · ` : ''}{short(wallet)}
          </button>
        ) : (
          <button className="btn btn-mint" onClick={connect}>Connect wallet</button>
        )}
      </header>

      <main className="main">
        <section className="chart-col" aria-label="Chart">
          <div className="chart-frame">
            {mint ? (
              <PriceChart mint={mint} pairAddress={pair?.pairAddress} supply={supply} symbol={sym} />
            ) : (
              <div className="empty">
                <img src="/orb.png" alt="" />
                <span>Search a coin or paste a contract address to load a chart.</span>
              </div>
            )}
          </div>
          {status && (
            <div className={`status ${status.kind === 'ok' ? 'ok' : status.kind === 'err' ? 'err' : ''}`} role="status">
              {status.text}
              {status.sig && (
                <>
                  {' '}
                  <a href={`https://solscan.io/tx/${status.sig}`} target="_blank" rel="noreferrer">View on Solscan</a>
                </>
              )}
            </div>
          )}
        </section>

        <aside className="side-col">
          <div className="panel">
            <h2>Token</h2>
            {mint ? (
              <>
                <div className="token-head">
                  {pair?.info?.imageUrl ? <img src={pair.info.imageUrl} alt="" /> : <img src="/orb.png" alt="" />}
                  <div>
                    <div className="token-name">{name || 'Unknown token'}</div>
                    <div className="token-sym">{sym ? `$${sym}` : short(mint)}{pair?.dexId ? ` · ${pair.dexId}` : ''}</div>
                  </div>
                </div>
                <div className="stats">
                  <div className="stat"><div className="k">Price</div><div className="v">{price(pair?.priceUsd)}</div></div>
                  <div className="stat"><div className="k">Market cap</div><div className="v">{compact(pair?.marketCap ?? pair?.fdv)}</div></div>
                  <div className="stat"><div className="k">Liquidity</div><div className="v">{compact(pair?.liquidity?.usd)}</div></div>
                  <div className="stat"><div className="k">Vol 24h</div><div className="v">{compact(pair?.volume?.h24)}</div></div>
                  <div className="stat">
                    <div className="k">1h</div>
                    <div className={`v ${ch1 > 0 ? 'up' : ch1 < 0 ? 'down' : ''}`}>{ch1 !== undefined && ch1 !== null ? `${ch1 > 0 ? '+' : ''}${ch1}%` : '—'}</div>
                  </div>
                  <div className="stat">
                    <div className="k">24h</div>
                    <div className={`v ${ch24 > 0 ? 'up' : ch24 < 0 ? 'down' : ''}`}>{ch24 !== undefined && ch24 !== null ? `${ch24 > 0 ? '+' : ''}${ch24}%` : '—'}</div>
                  </div>
                </div>
                <div className="ca mono">CA {mint}</div>
              </>
            ) : (
              <div style={{ color: 'var(--muted)' }}>No token open.</div>
            )}
          </div>

          <div className="panel">
            <h2>Trade</h2>
            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={side === 'buy'} className={`tab ${side === 'buy' ? 'on' : ''}`} onClick={() => setSide('buy')}>Buy</button>
              <button role="tab" aria-selected={side === 'sell'} className={`tab sell ${side === 'sell' ? 'on' : ''}`} onClick={() => setSide('sell')}>Sell</button>
            </div>

            {side === 'buy' ? (
              <>
                <div className="presets">
                  {BUY_PRESETS.map((v) => (
                    <button key={v} className={`preset ${Number(buyAmt) === v ? 'on' : ''}`} onClick={() => setBuyAmt(String(v))}>{v}</button>
                  ))}
                </div>
                <label className="field">
                  <input inputMode="decimal" value={buyAmt} onChange={(e) => setBuyAmt(e.target.value.replace(',', '.'))} aria-label="Amount in SOL" />
                  <span>SOL</span>
                </label>
              </>
            ) : (
              <div className="presets">
                {SELL_PRESETS.map((v) => (
                  <button key={v} className={`preset ${sellPct === v ? 'on' : ''}`} onClick={() => setSellPct(v)}>{v}%</button>
                ))}
              </div>
            )}

            <div className="row">
              <div>
                <span className="label">Slippage %</span>
                <label className="field"><input inputMode="decimal" value={slippage} onChange={(e) => setSlippage(e.target.value)} aria-label="Slippage percent" /></label>
              </div>
              <div>
                <span className="label">Priority fee</span>
                <label className="field"><input inputMode="decimal" value={prioFee} onChange={(e) => setPrioFee(e.target.value)} aria-label="Priority fee in SOL" /><span>SOL</span></label>
              </div>
            </div>

            <button
              className={`btn go ${side === 'buy' ? 'btn-mint' : 'btn-sell'}`}
              onClick={trade}
              disabled={busy || (wallet && !mint)}
            >
              {busy ? 'Working…' : !wallet ? 'Connect wallet' : side === 'buy' ? `Buy ${buyAmt || 0} SOL` : `Sell ${sellPct}%`}
            </button>

            {wallet && mint && (
              <div className="hold">
                <span>You hold</span>
                <span className="mono">{tokenBal === null ? '…' : tokenBal.toLocaleString(undefined, { maximumFractionDigits: 2 })} {sym || ''}</span>
              </div>
            )}
          </div>
        </aside>
      </main>

      <div className="orb-dock">
        <button className="orb-btn" aria-label="Voice trading (coming soon)" title="Voice trading coming soon" disabled>
          <img src="/orb.png" alt="" />
        </button>
        <small>voice coming soon</small>
      </div>
    </div>
  );
}

// Polls the signature until confirmed. Returns true (success), false (failed) or null (timed out).
async function waitForConfirm(sig, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: false }]);
      const s = r?.value?.[0];
      if (s) {
        if (s.err) return false;
        if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') return true;
      }
    } catch {}
    await new Promise((res) => setTimeout(res, 1500));
  }
  return null;
}
