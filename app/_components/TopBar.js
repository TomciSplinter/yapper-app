'use client';

import { useEffect, useRef, useState } from 'react';
import { extractMint } from '../_lib/chain';
import { usd, pct, tone, short, sol, dexLabel } from '../_lib/format';
import { useWallets, activeWallet, setActive, openWalletModal, lock } from '../_lib/wallets';
import { Icon, TokenImage } from './Icons';

export default function TopBar({ view, onNavigate, onOpenToken, wallet, solBal, onConnect, onDisconnect }) {
  const walletsReady = useWallets().ready;
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const seq = useRef(0);
  const inputRef = useRef(null);

  // "/" focuses search from anywhere on the page
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // search by name or ticker as you type; a contract address skips search
  useEffect(() => {
    const q = query.trim();
    if (extractMint(q) || q.replace(/^\$/, '').length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    const n = ++seq.current;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const j = await r.json();
        if (n !== seq.current) return;
        setResults(j.results || []);
        setActive(0);
      } catch {
        if (n === seq.current) setResults([]);
      } finally {
        if (n === seq.current) setSearching(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const reset = () => {
    setOpen(false);
    setQuery('');
    setResults([]);
    inputRef.current?.blur();
  };

  const pick = (r) => {
    reset();
    onOpenToken(r.mint);
  };

  const submit = (e) => {
    e.preventDefault();
    const m = extractMint(query);
    if (m) {
      reset();
      onOpenToken(m);
      return;
    }
    if (results.length) pick(results[active] || results[0]);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (!results.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    }
  };

  const q = query.trim();
  const showList = open && q.replace(/^\$/, '').length >= 2 && !extractMint(q);

  const nav = (v) => (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    onNavigate(v);
  };

  return (
    <header className="tb">
      <a className="tb-brand" href="/" onClick={nav('discover')}>
        <img src="/orb.png" alt="" width="24" height="24" />
        <span>Yapper</span>
      </a>

      <nav className="tb-nav" aria-label="Main">
        <a
          href="/"
          onClick={nav('discover')}
          className={view === 'discover' ? 'on' : undefined}
          aria-current={view === 'discover' ? 'page' : undefined}
        >
          Discover
        </a>
        <a
          href="/?view=positions"
          onClick={nav('positions')}
          className={view === 'positions' ? 'on' : undefined}
          aria-current={view === 'positions' ? 'page' : undefined}
        >
          Positions
        </a>
      </nav>

      <form className="tb-search" role="search" onSubmit={submit}>
        <label htmlFor="tb-q" className="sr-only">
          Search coins by name, ticker or contract address
        </label>
        <Icon name="search" size={15} className="tb-search-icon" />
        <input
          ref={inputRef}
          id="tb-q"
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
          placeholder="Search by name, ticker or contract address"
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls="tb-results"
          aria-activedescendant={showList && results.length ? `tb-opt-${active}` : undefined}
        />
        {!q && (
          <kbd className="tb-kbd" aria-hidden="true">
            /
          </kbd>
        )}
        {showList && (
          <ul className="sr" id="tb-results" role="listbox" aria-label="Search results">
            {results.map((r, i) => (
              <li key={r.mint} id={`tb-opt-${i}`} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  tabIndex={-1}
                  className={`sr-item${i === active ? ' on' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(r);
                  }}
                  onMouseEnter={() => setActive(i)}
                >
                  <TokenImage src={r.imageUrl} label={r.symbol} size={32} />
                  <span className="sr-main">
                    <span className="sr-name">{r.name}</span>
                    <span className="sr-meta">
                      <span className="sr-sym">{r.symbol}</span>
                      <span className="mono">{short(r.mint)}</span>
                      {r.dexId ? <span>{dexLabel(r.dexId)}</span> : null}
                    </span>
                  </span>
                  <span className="sr-stats">
                    <span>{usd(r.marketCap)}</span>
                    <span className={tone(r.change24h)}>{pct(r.change24h)}</span>
                  </span>
                </button>
              </li>
            ))}
            {!results.length && (
              <li className="sr-empty">{searching ? 'Searching…' : `No Solana coins match “${q}”.`}</li>
            )}
          </ul>
        )}
      </form>

      <div className="tb-wallet">
        {!walletsReady ? (
          <span className="wm-skel" aria-hidden="true" />
        ) : wallet ? (
          <WalletMenu wallet={wallet} solBal={solBal} onDisconnect={onDisconnect} />
        ) : (
          <button type="button" className="btn btn-primary" onClick={onConnect}>
            Connect wallet
          </button>
        )}
      </div>
    </header>
  );
}

function WalletMenu({ wallet, solBal, onDisconnect }) {
  const ws = useWallets();
  const info = activeWallet(ws);
  const local = info?.type === 'local';
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(wallet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const pick = (active) => {
    setActive(active);
    setOpen(false);
  };
  const manage = (view, details) => {
    setOpen(false);
    openWalletModal(view, details);
  };

  const isActive = (w) => ws.active?.type === 'local' && ws.active.id === w.id;

  return (
    <div className="wm" ref={ref}>
      <button
        type="button"
        className="wm-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Wallet ${info?.name || ''}, ${solBal === null ? 'balance loading' : `${sol(solBal)} SOL`}`}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="wallet" size={15} />
        <span className="wm-bal">
          {solBal === null ? '—' : sol(solBal)} <span className="muted">SOL</span>
        </span>
        <span className="wm-name">{info?.name || short(wallet)}</span>
        {local && !ws.unlocked && <Icon name="lock" size={12} className="wm-lock" />}
        <Icon name="chevronDown" size={14} />
      </button>
      {open && (
        <div className="wm-menu" role="menu">
          <div className="wm-label">Wallets</div>
          {ws.wallets.map((w) => (
            <button key={w.id} type="button" role="menuitemradio" aria-checked={isActive(w)} className="wm-pick" onClick={() => pick({ type: 'local', id: w.id })}>
              <span className="wm-pick-main">
                <span className="wm-pick-name">{w.name}</span>
                <span className="wm-pick-sub mono">{short(w.pubkey)}</span>
              </span>
              {isActive(w) && <Icon name="check" size={15} className="up" />}
            </button>
          ))}
          {ws.external && (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={ws.active?.type === 'external'}
              className="wm-pick"
              onClick={() => pick({ type: 'external' })}
            >
              <span className="wm-pick-main">
                <span className="wm-pick-name">{ws.externalName || 'Wallet app'}</span>
                <span className="wm-pick-sub mono">{short(ws.external)}</span>
              </span>
              {ws.active?.type === 'external' && <Icon name="check" size={15} className="up" />}
            </button>
          )}
          <div className="wm-sep" role="separator" />
          {local && !info.backedUp && (
            <button type="button" role="menuitem" className="wm-warn" onClick={() => manage('export', { id: info.id })}>
              <Icon name="alert" size={15} />
              Back up this wallet
            </button>
          )}
          <button type="button" role="menuitem" onClick={copy}>
            <Icon name={copied ? 'check' : 'copy'} size={15} />
            {copied ? 'Copied' : 'Copy address'}
          </button>
          {local && (
            <button type="button" role="menuitem" onClick={() => manage('deposit', { id: info.id })}>
              <Icon name="deposit" size={15} />
              Deposit
            </button>
          )}
          {local && (
            <button type="button" role="menuitem" onClick={() => manage('withdraw', { id: info.id })}>
              <Icon name="withdraw" size={15} />
              Withdraw
            </button>
          )}
          <a role="menuitem" href={`https://solscan.io/account/${wallet}`} target="_blank" rel="noreferrer">
            <Icon name="external" size={15} />
            View on Solscan
          </a>
          <div className="wm-sep" role="separator" />
          <button type="button" role="menuitem" onClick={() => manage('home')}>
            <Icon name="wallet" size={15} />
            Manage wallets
          </button>
          {ws.hasVault && ws.unlocked && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                lock();
              }}
            >
              <Icon name="lock" size={15} />
              Lock wallets
            </button>
          )}
          {info?.type === 'external' && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onDisconnect();
              }}
            >
              <Icon name="logout" size={15} />
              Disconnect {info.name}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
