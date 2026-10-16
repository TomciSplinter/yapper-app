# Yapper terminal

Solana trading terminal at app.yapper.trade. Voice trading is next.

## What's in it

- **Discover** (home): trending Solana coins, sortable by trending, volume, market cap, 1h gainers or newest.
- **Coin view**: header stats, candlestick chart (market cap or price, 1m to 1D), live trades, top holders with pools and program accounts labelled, your positions, a buy/sell panel and coin info (buy/sell pressure, top 10 holders, volume, supply).
- **Positions**: every coin in the connected wallet with live value.
- Search by name, ticker or contract address (press `/` anywhere).
- Toast notifications for each trade step, and a status bar with connection, SOL price and the voice orb.

## Where the data comes from

| Data | Source | Called from |
| --- | --- | --- |
| Coin stats, positions pricing, SOL price | DexScreener | browser |
| Candles and trades | GeckoTerminal (free tier, rate-limited per viewer) | browser |
| Trending | GeckoTerminal trending pools, DexScreener boosts as fallback | `/api/trending` (cached 60s) |
| Search | DexScreener | `/api/search` |
| Balances, holders, sending transactions | Helius RPC | `/api/rpc` (key stays on the server, method allowlist) |
| Trade transactions | PumpPortal Local Transaction API (`pool: auto`) | `/api/trade` |

Users sign every trade in their own wallet (Phantom, Solflare, Backpack). No private keys touch the server.

## Code layout

- `app/page.js`: routing (`?ca=<mint>`, `?view=positions`), wallet, balances, coin data
- `app/_components/`: UI pieces (TopBar, TokenHeader, PriceChart, TradePanel, TokenFacts, DataTabs, Trades, Holders, Positions, Discover, StatusBar, Toasts)
- `app/_lib/`: formatting, Solana helpers, market data clients, hooks
- `app/globals.css`: design tokens and all styles

## Environment variables (Vercel → Project → Settings → Environment Variables)

| Name | Needed for |
| --- | --- |
| `HELIUS_API_KEY` | balances, holders, sending transactions |
| `OPENAI_API_KEY` | voice layer (next step) |

## Deploy

Every push to `main` redeploys on Vercel automatically.

## Local dev

```
npm install
cp .env.example .env.local   # fill in keys
npm run dev
```
