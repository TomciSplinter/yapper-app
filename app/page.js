'use client';

import { useCallback, useEffect, useState } from 'react';
import TopBar from './_components/TopBar';
import TokenHeader from './_components/TokenHeader';
import PriceChart from './_components/PriceChart';
import TradePanel from './_components/TradePanel';
import TokenFacts from './_components/TokenFacts';
import DataTabs from './_components/DataTabs';
import Discover from './_components/Discover';
import Positions from './_components/Positions';
import StatusBar from './_components/StatusBar';
import Toasts from './_components/Toasts';
import { extractMint, getProvider, rpc } from './_lib/chain';
import { fetchPair, fetchSolPrice } from './_lib/markets';
import { useHolders, useToasts } from './_lib/hooks';
import { usd, sol } from './_lib/format';

function readUrl() {
  const q = new URLSearchParams(window.location.search);
  const m = extractMint(q.get('ca'));
  if (m) return { view: 'token', mint: m };
  if (q.get('view') === 'positions') return { view: 'positions', mint: null };
  return { view: 'discover', mint: null };
}

export default function App() {
  const [booted, setBooted] = useState(false);
  const [view, setView] = useState('discover'); // discover | positions | token
  const [mint, setMint] = useState(null);
  const [side, setSide] = useState('buy');

  const [pair, setPair] = useState(null);
  const [pairState, setPairState] = useState('idle'); // idle | loading | found | none

  const [wallet, setWallet] = useState(null);
  const [solBal, setSolBal] = useState(null);
  const [tokenBal, setTokenBal] = useState(null);
  const [balTick, setBalTick] = useState(0);
  const [solPrice, setSolPrice] = useState(null);

  const [toasts, toast] = useToasts();

  /* routing: ?ca=<mint> opens a coin, ?view=positions opens positions */
  useEffect(() => {
    const s = readUrl();
    setView(s.view);
    setMint(s.mint);
    setBooted(true);
    const onPop = () => {
      const p = readUrl();
      setView(p.view);
      setMint(p.mint);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = useCallback((nextView, nextMint = null) => {
    const url = nextView === 'token' && nextMint ? `/?ca=${nextMint}` : nextView === 'positions' ? '/?view=positions' : '/';
    if (window.location.pathname + window.location.search !== url) window.history.pushState(null, '', url);
    setView(nextView);
    setMint(nextView === 'token' ? nextMint : null);
    window.scrollTo(0, 0);
  }, []);

  const openToken = useCallback(
    (m, nextSide) => {
      setSide(nextSide === 'sell' ? 'sell' : 'buy');
      go('token', m);
    },
    [go]
  );

  /* coin stats from DexScreener, refreshed every 10s */
  useEffect(() => {
    if (view !== 'token' || !mint) {
      setPair(null);
      setPairState('idle');
      return;
    }
    let cancelled = false;
    let timer;
    setPair(null);
    setPairState('loading');
    async function load(first) {
      if (first || !document.hidden) {
        try {
          const p = await fetchPair(mint);
          if (cancelled) return;
          setPair(p);
          setPairState(p ? 'found' : 'none');
        } catch {
          if (!cancelled && first) setPairState('none');
        }
      }
      if (!cancelled) timer = setTimeout(() => load(false), 10000);
    }
    load(true);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [view, mint]);

  const pairReady = pairState === 'found' || pairState === 'none';
  const supply = pair?.marketCap && Number(pair?.priceUsd) > 0 ? pair.marketCap / Number(pair.priceUsd) : 0;
  const holders = useHolders(view === 'token' ? mint : null, pair?.pairAddress, pairReady);

  // tab title shows the coin and its market cap, like other terminals
  useEffect(() => {
    if (view === 'token' && pair?.baseToken?.symbol) {
      document.title = `${pair.baseToken.symbol} ${usd(pair.marketCap ?? pair.fdv)} | Yapper`;
    } else if (view === 'positions') {
      document.title = 'Positions | Yapper';
    } else {
      document.title = 'Yapper Terminal';
    }
  }, [view, pair]);

  /* SOL price for quotes and the status bar */
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const p = await fetchSolPrice();
        if (!cancelled && p) setSolPrice(p);
      } catch {}
    };
    load();
    const t = setInterval(() => {
      if (!document.hidden) load();
    }, 60000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  /* wallet */
  const connect = useCallback(async () => {
    const p = getProvider();
    if (!p) {
      // on a phone without an injected wallet, reopen this page inside Phantom
      if (/Android|iPhone|iPad/i.test(navigator.userAgent)) {
        const url = encodeURIComponent(window.location.href);
        window.location.href = `https://phantom.app/ul/browse/${url}?ref=${encodeURIComponent(window.location.origin)}`;
        return;
      }
      toast.show({
        kind: 'info',
        title: 'No Solana wallet found',
        detail: 'Install Phantom, Solflare or Backpack, then reload this page.',
        autoClose: 8000,
      });
      window.open('https://phantom.app/download', '_blank', 'noopener');
      return;
    }
    try {
      await p.connect();
      const pk = p.publicKey?.toString();
      if (pk) setWallet(pk);
    } catch (e) {
      toast.show({ kind: 'error', title: 'Wallet not connected', detail: e?.message || 'The request was rejected.', autoClose: 6000 });
    }
  }, [toast]);

  const disconnect = useCallback(async () => {
    try {
      await getProvider()?.disconnect();
    } catch {}
    setWallet(null);
  }, []);

  // reconnect silently if this site was approved before
  useEffect(() => {
    const p = getProvider();
    if (!p?.connect) return;
    p.connect({ onlyIfTrusted: true })
      .then(() => {
        const pk = p.publicKey?.toString();
        if (pk) setWallet(pk);
      })
      .catch(() => {});
    const onChange = (pk) => setWallet(pk ? pk.toString() : null);
    p.on?.('accountChanged', onChange);
    return () => p.removeListener?.('accountChanged', onChange);
  }, []);

  /* balances */
  useEffect(() => {
    if (!wallet) {
      setSolBal(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const b = await rpc('getBalance', [wallet, { commitment: 'confirmed' }]);
        if (!cancelled) setSolBal(b.value / 1e9);
      } catch {}
    };
    load();
    const t = setInterval(() => {
      if (!document.hidden) load();
    }, 15000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [wallet, balTick]);

  useEffect(() => {
    setTokenBal(null);
  }, [wallet, mint]);

  useEffect(() => {
    if (!wallet || !mint || view !== 'token') return;
    let cancelled = false;
    const load = async () => {
      try {
        const r = await rpc('getParsedTokenAccountsByOwner', [wallet, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
        const total = (r?.value || []).reduce((s, a) => {
          const t = a?.account?.data?.parsed?.info?.tokenAmount;
          return s + (Number(t?.uiAmountString ?? t?.uiAmount) || 0);
        }, 0);
        if (!cancelled) setTokenBal(total);
      } catch {}
    };
    load();
    const t = setInterval(() => {
      if (!document.hidden) load();
    }, 15000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [wallet, mint, view, balTick]);

  const onTraded = useCallback(() => {
    setBalTick((n) => n + 1);
    setTimeout(() => setBalTick((n) => n + 1), 5000);
  }, []);

  const onVoice = useCallback(() => {
    toast.show({
      kind: 'info',
      title: 'Voice trading is coming soon',
      detail: 'You will hold the orb and say trades like “buy half a SOL of this”.',
      autoClose: 6000,
    });
  }, [toast]);

  return (
    <div className="app">
      <TopBar
        view={view}
        onNavigate={(v) => go(v)}
        onOpenToken={openToken}
        wallet={wallet}
        solBal={solBal}
        onConnect={connect}
        onDisconnect={disconnect}
      />

      <main className="main">
        {booted && view === 'discover' && <Discover onOpenToken={openToken} />}

        {booted && view === 'positions' && (
          <section className="view" aria-labelledby="pv-title">
            <header className="view-head">
              <div>
                <h1 className="view-title" id="pv-title">
                  Your positions
                </h1>
                <p className="view-sub">
                  {wallet ? `${solBal === null ? '—' : sol(solBal)} SOL available` : 'Coins you hold, with live value'}
                </p>
              </div>
            </header>
            <div className="view-body">
              <Positions wallet={wallet} refreshKey={balTick} onOpenToken={openToken} onConnect={connect} />
            </div>
          </section>
        )}

        {booted && view === 'token' && mint && (
          <div className="tv">
            <TokenHeader mint={mint} pair={pair} pairState={pairState} />
            <div className="ws">
              <div className="ws-left">
                <div className="ws-chart">
                  {pairReady ? (
                    <PriceChart key={mint} mint={mint} pairAddress={pair?.pairAddress} supply={supply} symbol={pair?.baseToken?.symbol} />
                  ) : (
                    <div className="pc-note">Loading chart…</div>
                  )}
                </div>
                <DataTabs
                  mint={mint}
                  pair={pair}
                  pairReady={pairReady}
                  supply={supply}
                  wallet={wallet}
                  holders={holders}
                  positionsKey={balTick}
                  onOpenToken={openToken}
                  onConnect={connect}
                />
              </div>
              <aside className="ws-right" aria-label="Trade and coin info">
                <TradePanel
                  mint={mint}
                  pair={pair}
                  side={side}
                  onSideChange={setSide}
                  wallet={wallet}
                  solBal={solBal}
                  tokenBal={tokenBal}
                  solPrice={solPrice}
                  onConnect={connect}
                  onTraded={onTraded}
                  toast={toast}
                />
                <TokenFacts pair={pair} holders={holders} />
              </aside>
            </div>
          </div>
        )}
      </main>

      <StatusBar solPrice={solPrice} onVoice={onVoice} />
      <Toasts items={toasts} onDismiss={toast.dismiss} />
    </div>
  );
}
