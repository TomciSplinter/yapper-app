'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import TopBar from './_components/TopBar';
import TokenHeader from './_components/TokenHeader';
import PriceChart from './_components/PriceChart';
import TradePanel from './_components/TradePanel';
import TokenFacts from './_components/TokenFacts';
import DataTabs from './_components/DataTabs';
import Discover from './_components/Discover';
import Pulse from './_components/Pulse';
import Positions from './_components/Positions';
import { OrdersSection } from './_components/Orders';
import StatusBar from './_components/StatusBar';
import Toasts from './_components/Toasts';
import VoiceDock from './_components/VoiceDock';
import WalletModal from './_components/WalletModal';
import { extractMint, getProvider, rpc } from './_lib/chain';
import {
  initWallets,
  useWallets,
  activePubkey,
  getState as walletState,
  openWalletModal,
  setActive,
  setExternal,
  externalName,
  disconnectExternal,
} from './_lib/wallets';
import { fetchPair, fetchSolPrice } from './_lib/markets';
import { executeTrade } from './_lib/trade';
import { loadHolding } from './_lib/holdings';
import { useFills } from './_lib/fills';
import { ownSummary } from './_lib/portfolio';
import { startOrderEngine, useOrders, isLive } from './_lib/orders';
import { createCallouts } from './_lib/callouts';
import { useHolders, useToasts } from './_lib/hooks';
import { usd, sol, age, dexLabel } from './_lib/format';

function readUrl() {
  const q = new URLSearchParams(window.location.search);
  const m = extractMint(q.get('ca'));
  if (m) return { view: 'token', mint: m };
  if (q.get('view') === 'positions') return { view: 'positions', mint: null };
  if (q.get('view') === 'pulse') return { view: 'pulse', mint: null };
  return { view: 'discover', mint: null };
}

export default function App() {
  const [booted, setBooted] = useState(false);
  const [view, setView] = useState('discover'); // discover | pulse | positions | token
  const [mint, setMint] = useState(null);
  const [side, setSide] = useState('buy');

  const [pair, setPair] = useState(null);
  const [pairState, setPairState] = useState('idle'); // idle | loading | found | none

  // the active wallet: a built-in Yapper wallet or a connected wallet app
  const wallets = useWallets();
  const wallet = activePubkey(wallets);
  const [solBal, setSolBal] = useState(null);
  const [tokenBal, setTokenBal] = useState(null);
  const [tokenBalErr, setTokenBalErr] = useState('');
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
    const url =
      nextView === 'token' && nextMint
        ? `/?ca=${nextMint}`
        : nextView === 'positions' || nextView === 'pulse'
        ? `/?view=${nextView}`
        : '/';
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
    } else if (view === 'pulse') {
      document.title = 'Pulse | Yapper';
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
  useEffect(() => {
    initWallets();
  }, []);

  const connect = useCallback(() => openWalletModal('home'), []);
  const disconnect = useCallback(() => disconnectExternal(), []);

  // reconnect a wallet app silently if this site was approved before
  useEffect(() => {
    const p = getProvider();
    if (!p?.connect) return;
    p.connect({ onlyIfTrusted: true })
      .then(() => {
        const pk = p.publicKey?.toString();
        if (!pk) return;
        setExternal(pk, externalName(p));
        if (!walletState().active) setActive({ type: 'external' });
      })
      .catch(() => {});
    const onChange = (pk) => setExternal(pk ? pk.toString() : null, externalName(p));
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
    setTokenBalErr('');
  }, [wallet, mint]);

  useEffect(() => {
    if (!wallet || !mint || view !== 'token') return;
    let cancelled = false;
    const load = async () => {
      try {
        const h = await loadHolding(wallet, mint);
        if (!cancelled) {
          setTokenBal(h.amount);
          setTokenBalErr('');
        }
      } catch (e) {
        console.warn('[yapper] balance read failed:', e?.message);
        if (!cancelled) setTokenBalErr(String(e?.message || 'unknown error'));
      }
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

  // your trades in this coin: avg entry, PnL and chart markers
  const fills = useFills(view === 'token' ? wallet : null, view === 'token' ? mint : null, balTick);
  const priceSolNow =
    pair?.quoteToken?.address === 'So11111111111111111111111111111111111111112' && Number(pair?.priceNative) > 0
      ? Number(pair.priceNative)
      : solPrice && Number(pair?.priceUsd) > 0
      ? Number(pair.priceUsd) / solPrice
      : null;
  // PnL over the coins you bought (coins sent to you have no entry)
  const { s: position, known: entryKnown } = ownSummary(fills, tokenBal, priceSolNow);

  const onTraded = useCallback(() => {
    setBalTick((n) => n + 1);
    setTimeout(() => setBalTick((n) => n + 1), 5000);
  }, []);

  // the Buy buttons in Discover and Pulse: spend the quick buy amount right away
  const quickBuy = useCallback(
    async (row, amount) => {
      if (!wallet) return connect();
      const amountSol = Number(amount);
      if (!(amountSol > 0)) {
        toast.show({ kind: 'error', title: 'Set a quick buy amount first', detail: 'Type how much SOL each Buy button spends.', autoClose: 5000 });
        return;
      }
      await executeTrade({ wallet, mint: row.mint, side: 'buy', amountSol, symbol: row.symbol || row.name, toast, onTraded });
    },
    [wallet, connect, toast, onTraded]
  );

  // what's on screen, for voice questions ("what's the market cap?")
  const ctxRef = useRef({});
  const priceUsd = Number(pair?.priceUsd) || null;
  ctxRef.current = {
    screen: view === 'token' ? 'coin' : view,
    coin:
      view === 'token' && mint
        ? {
            mint,
            name: pair?.baseToken?.name || null,
            symbol: pair?.baseToken?.symbol || null,
            image: pair?.info?.imageUrl || null,
            market_cap_usd: pair?.marketCap ?? pair?.fdv ?? null,
            price_usd: priceUsd,
            liquidity_usd: pair?.liquidity?.usd ?? null,
            volume_usd: pair?.volume || null,
            price_change_pct: pair?.priceChange || null,
            trades: pair?.txns || null,
            pool: pair ? dexLabel(pair.dexId) : null,
            on_bonding_curve: String(pair?.dexId || '').toLowerCase() === 'pumpfun',
            age: pair?.pairCreatedAt ? age(pair.pairCreatedAt) : null,
            top10_holders_pct: holders?.top10Pct ?? null,
            largest_holders: (holders?.rows || []).slice(0, 10).map((h) => ({
              pct: h.pct === null ? null : Math.round(h.pct * 100) / 100,
              type: h.kind || 'wallet',
            })),
          }
        : null,
    wallet: wallet
      ? {
          connected: true,
          sol_balance: solBal,
          holding_this_coin: view === 'token' ? tokenBal : null,
          holding_value_usd: view === 'token' && tokenBal && priceUsd ? tokenBal * priceUsd : null,
          position_in_this_coin:
            view === 'token' && position
              ? {
                  bought_sol: position.boughtSol,
                  sold_sol: position.soldSol,
                  avg_entry_market_cap_usd: entryKnown && solPrice && supply ? position.avgEntry * solPrice * supply : null,
                  entry_covers_holding: entryKnown,
                  pnl_sol: position.pnl,
                  pnl_usd: solPrice ? position.pnl * solPrice : null,
                  pnl_pct: position.pnlPct,
                }
              : null,
        }
      : { connected: false },
    sol_price_usd: solPrice,
  };
  const getContext = useCallback(() => ctxRef.current, []);

  // raw inputs the orb gathers more data from while you speak
  const inputsRef = useRef({});
  inputsRef.current = {
    wallet,
    mint: view === 'token' ? mint : null,
    pairAddress: pair?.pairAddress || null,
    supply,
    solPrice,
    holderOwners: (holders?.rows || [])
      .filter((h) => !h.kind)
      .slice(0, 10)
      .map((h) => h.owner)
      .filter(Boolean),
  };
  const getInputs = useCallback(() => inputsRef.current, []);

  // limit orders, alerts, take profit / stop loss and callouts run in one tab
  const engineRef = useRef({});
  engineRef.current = { toast, onTraded, solPrice, wallet };
  useEffect(() => {
    const callouts = createCallouts({ getWallet: () => engineRef.current.wallet, getSolPrice: () => engineRef.current.solPrice });
    return startOrderEngine({
      getToast: () => engineRef.current.toast,
      getOnTraded: () => engineRef.current.onTraded,
      getSolPrice: () => engineRef.current.solPrice,
      extraMints: callouts.mints,
      onQuotes: callouts.check,
      watchEvery: () => 10000,
    });
  }, []);
  const orders = useOrders();
  const coinOrders = view === 'token' && mint ? orders.filter((o) => isLive(o) && o.mint === mint && (o.type === 'alert' || o.wallet === wallet)) : [];

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
        {booted && view === 'discover' && <Discover onOpenToken={openToken} onQuickBuy={quickBuy} />}

        {booted && view === 'pulse' && <Pulse onOpenToken={openToken} onQuickBuy={quickBuy} solPrice={solPrice} />}

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
              <Positions wallet={wallet} refreshKey={balTick} onOpenToken={openToken} onConnect={connect} solPrice={solPrice} />
              <OrdersSection orders={orders.filter((o) => o.type === 'alert' || !wallet || o.wallet === wallet)} onOpenToken={openToken} />
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
                    <PriceChart
                      key={mint}
                      mint={mint}
                      pairAddress={pair?.pairAddress}
                      supply={supply}
                      symbol={pair?.baseToken?.symbol}
                      imageUrl={pair?.info?.imageUrl}
                      livePrice={pair?.priceUsd}
                      fills={fills}
                      avgEntryUsd={position && position.held > 0 && solPrice ? position.avgEntry * solPrice : null}
                      solPrice={solPrice}
                      orders={coinOrders}
                    />
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
                  tokenBalErr={tokenBalErr}
                  position={position}
                  supply={supply}
                  solPrice={solPrice}
                  onConnect={connect}
                  onTraded={onTraded}
                  toast={toast}
                  orders={coinOrders}
                />
                <TokenFacts pair={pair} holders={holders} />
              </aside>
            </div>
          </div>
        )}
      </main>

      <StatusBar
        solPrice={solPrice}
        voice={
          <VoiceDock
            getContext={getContext}
            getInputs={getInputs}
            onQuickBuy={quickBuy}
            openToken={openToken}
            navigate={(v) => go(v)}
            wallet={wallet}
            connect={connect}
            solBal={solBal}
            solPrice={solPrice}
            toast={toast}
            onTraded={onTraded}
          />
        }
      />
      <WalletModal toast={toast} solPrice={solPrice} onChanged={onTraded} />
      <Toasts items={toasts} onDismiss={toast.dismiss} />
    </div>
  );
}
