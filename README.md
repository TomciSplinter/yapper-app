# Yapper terminal

Solana trading terminal at app.yapper.trade with voice trading: hold the orb (or Space), say a trade or a question, confirm.

## What's in it

- **Discover** (home): a coin table with mini charts, market cap and change, liquidity, volume, buys and sells, holder stats and a quick buy button per row.
  - **Trending**: pump.fun coins still on the bonding curve with trading right now, $5K to $40K market cap by default (adjustable), timeframes 5m, 1h, 6h, 24h.
  - **Top**: the most active pools on all of Solana.
- **Pulse**: pump.fun coins in three live columns, New pairs (under 70% of the bonding curve), Final stretch (70% or more) and Migrated (graduated to PumpSwap). New coins and migrations stream in as they happen and coins move between columns as they progress. A list holds still while your pointer is over it (or while you touch it), so a Buy click always hits the coin you see.
- **Quick buy**: one amount, set in Discover or Pulse, that every Buy button in the lists spends right away.
- **Coin view**: header stats, candlestick chart (market cap or price, 1m to 1D), live trades, top holders with pools and program accounts labelled, your positions, a buy/sell panel and coin info (buy/sell pressure, top 10 holders, volume, supply).
- **Positions**: every coin in the connected wallet with live value.
- **Wallets**: create or import Yapper wallets that trade instantly with no popups, or connect Phantom, Solflare or Backpack. Switch, rename, deposit, withdraw, export and remove from the wallet menu.
- Search by name, ticker or contract address (press `/` anywhere).
- Toast notifications for each trade step, and a status bar with connection, SOL price and the voice orb.

## Where the data comes from

| Data | Source | Called from |
| --- | --- | --- |
| Coin stats, positions pricing, SOL price | DexScreener | browser |
| Candles and trades | GeckoTerminal (free tier, rate-limited per viewer) | browser |
| Discover and Pulse lists | GeckoTerminal (pump.fun and PumpSwap pools, trending pools, new pools) | `/api/pump` (cached, shared by every visitor) |
| Live numbers on the lists | DexScreener, 30 coins per call, every 10 to 12s | browser |
| New coins and migrations | PumpPortal websocket (its free streams) | browser |
| Holders, top 10 and dev share (optional) | Jupiter token API | `/api/tokeninfo` (cached 60s) |
| Search | DexScreener | `/api/search` |
| Balances, holders, simulating and sending transactions | Helius RPC | `/api/rpc` (key stays on the server, method allowlist) |
| Trade transactions | PumpPortal Local Transaction API (`pool: auto`) | `/api/trade` |

## Wallets and security

Private keys never touch the server, whichever wallet is used.

**Yapper wallets** (`app/_lib/wallets.js`) are created or imported in the browser:

- Keys are encrypted with the user's password (PBKDF2-SHA256, 600k rounds, then AES-256-GCM, each key bound to its address) and stored only in that browser's localStorage. There is no password reset: the private key backups are the recovery.
- Unlocking keeps a non-extractable key in memory, shared between open Yapper tabs, for up to 12 hours. "Stay unlocked" (on by default, can be unticked) also keeps it in IndexedDB so it survives restarts for those 12 hours.
- Exporting a key, withdrawing SOL and removing a wallet always ask for the password. New wallets show their key once and stay flagged "Not backed up" until the user confirms or exports it.
- Withdrawals refuse coin, token and program addresses, where SOL would be lost.

**Trade safety check** (`app/_lib/guard.js`): trade transactions come from PumpPortal and Yapper wallets sign without a popup, so every one is checked and simulated before signing:

- the wallet is the only signer, and only known system, token and DEX programs are called
- SOL only leaves for the wallet's own accounts, apart from fees and tips worth at most 1.5% of the trade
- the wallet's other coins can't shrink, and no token account changes owner or gets a spender
- the simulation must show the trade costs no more than the amount plus slippage and fees, that a buy lands the coin in the wallet, and that a sell sells no more than the percentage asked for

Anything else is blocked with a "Blocked for your safety" message and nothing is signed. What it can't judge is the price inside a DEX swap, so a malicious builder could still route a trade through a bad pool; that risk is limited to the trade itself.

**Wallet apps** (Phantom, Solflare, Backpack) sign in their own popup, which shows the app's own preview.

The site sends `frame-ancestors 'none'` so no other page can embed the terminal and trick clicks.

## Code layout

- `app/page.js`: routing (`?ca=<mint>`, `?view=pulse`, `?view=positions`), active wallet, balances, coin data, quick buy
- `app/_components/`: UI pieces (TopBar, TokenHeader, PriceChart, TradePanel, TokenFacts, DataTabs, Trades, Holders, Positions, Discover, Pulse, CoinBits, StatusBar, Toasts, VoiceDock, WalletModal)
- `app/_lib/`: formatting, Solana helpers, market data clients, hooks, `pump.js` (live list data: DexScreener refresh, PumpPortal stream, mini chart points), `bonding.js` (pump.fun curve math), `wallets.js` (encrypted wallet store and signing), `guard.js` (trade safety check), `trade.js` (one trade path for the panel and voice)
- `app/globals.css`: design tokens and all styles

## Environment variables (Vercel → Project → Settings → Environment Variables)

| Name | Needed for |
| --- | --- |
| `HELIUS_API_KEY` | balances, holders, sending transactions |
| `OPENAI_API_KEY` | voice commands (`/api/voice`) |
| `OPENAI_MODEL` (optional) | model that understands commands, default `gpt-4.1-mini` |
| `OPENAI_TRANSCRIBE_MODEL` (optional) | speech-to-text model, default `gpt-4o-mini-transcribe` |
| `JUPITER_API_KEY` (optional) | holder count, top 10 and dev share in the lists; without it the lists just hide those numbers |

## Deploy

Every push to `main` redeploys on Vercel automatically.

## Local dev

```
npm install
cp .env.example .env.local   # fill in keys
npm run dev
```
