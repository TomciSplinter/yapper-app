# Yapper terminal

Solana trading terminal at app.yapper.trade with voice trading: hold the orb (or Space), say a trade or a question, confirm.

## What's in it

- **Discover** (home): a coin table with mini charts, market cap and change, liquidity, volume, buys and sells, holder stats and a quick buy button per row.
  - **Trending**: pump.fun coins still on the bonding curve with trading right now, $5K to $40K market cap by default (adjustable), timeframes 5m, 1h, 6h, 24h.
  - **Top**: the most active pools on all of Solana.
- **Pulse**: pump.fun coins in three live columns, New pairs (under 70% of the bonding curve), Final stretch (70% or more) and Migrated (graduated to PumpSwap). New coins and migrations stream in as they happen and coins move between columns as they progress. A list holds still while your pointer is over it (or while you touch it), so a Buy click always hits the coin you see.
- **Quick buy**: one amount, set in Discover or Pulse, that every Buy button in the lists spends right away.
- **Coin view**: header stats, candlestick chart (market cap or price, 1m to 1D), live trades, top holders with pools and program accounts labelled, your positions, a buy/sell panel and coin info (buy/sell pressure, top 10 holders, volume, supply).
  - **Your trades on the chart**: green B and red S bubbles at the price each buy and sell filled, plus a dashed average entry line.
  - **Your position** under the trade button: SOL bought and sold, holding value, PnL (USD, %, SOL) and average entry as a market cap. Built from your trades on the chain, so it includes trades made in other apps and works on any device. Fees count toward cost; token-account rent doesn't.
- **Positions**: every coin in the connected wallet (both token programs, including coins DexScreener doesn't list yet) with live value and PnL.
- **Wallets**: create or import Yapper wallets that trade instantly with no popups, or connect Phantom, Solflare or Backpack. Switch, rename, deposit, withdraw, export and remove from the wallet menu.
- **Orders**: limit buys, take profit and stop loss (each a market cap target), and price alerts. Set them in the trade panel (Market / Limit, or TP / SL on the sell side, plus an optional take profit / stop loss on any market buy) or by voice. They show under the trade panel, as lines on the chart and on the Positions page. Take profit and stop loss placed together cancel each other; selling a whole position retires its sell orders. Orders run while Yapper is open in at least one tab (one tab runs them, so they never fire twice).
- Search by name, ticker or contract address (press `/` anywhere).
- Toast notifications for each trade step, and a status bar with connection, SOL price and the voice orb.

## The orb (voice)

Hold the orb or Space and talk, tap once to start and again to send, type in the panel, or turn on hands-free and say "Yapper, ...". Anything that spends or sells shows a confirm card and runs only after "yes" or a tap. It can:

- **Trade now**: "buy 0.5 of this", "sell half", "buy 0.5 with stop loss at minus 30 and take profit at 3x".
- **Orders and alerts**: "buy 0.2 if it dips to 8K", "sell half at 2x", "stop loss at minus 30", "tell me when this hits 50K", "cancel my orders on this".
- **Sell several**: "sell all my bags", "sell everything that's down more than 50%".
- **PnL**: "how am I doing on this", "what's my PnL today", "best trade this week" (from the wallet's trades read off the chain).
- **Scan**: "find me something on the curve under 20K with volume picking up", "what's hot in final stretch". Results show as cards with Open and quick buy; "open the second one" works.
- **Safety check**: "is this safe?" gives mint and freeze authority, risky Token-2022 extensions, top 10 and dev holdings, bonding progress, socials. Facts only.
- **What happened**: "why did it dump?" explains the move from the latest trades (biggest trades, buy vs sell volume).
- **Settings**: slippage, priority fee, quick buy amount, callouts, hands-free, voice. Also "copy the address" and "share this on X".
- **Follow-ups**: "actually make it 0.3", "do the same on the next one".

Voice settings (the sliders next to the orb): spoken replies, natural voice (OpenAI text-to-speech, falls back to the browser's voice), hands-free wake word (the browser's speech recognition; Chrome and Edge), callouts (speaks up when a coin you hold hits 2x/3x/5x/10x/20x your entry or falls to half, graduates, or gets a single sell of 2%+ of the supply) and reading out finished trades.

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
| Balances, holders, your trade history, simulating and sending transactions | Helius RPC | `/api/rpc` (key stays on the server, method allowlist) |
| Trade transactions | PumpPortal Local Transaction API (`pool: auto`) | `/api/trade` |
| Voice: speech to text, commands, natural voice | OpenAI | `/api/voice`, `/api/tts` |
| Prices for orders, alerts and callouts | DexScreener; the pump.fun curve on chain for coins it doesn't list yet | browser |

## Wallets and security

Private keys never touch the server, whichever wallet is used.

**Yapper wallets** (`app/_lib/wallets.js`) are created or imported in the browser:

- Keys are encrypted with the user's password (PBKDF2-SHA256, 600k rounds, then AES-256-GCM, each key bound to its address) and stored only in that browser's localStorage. There is no password reset: the private key backups are the recovery.
- Unlocking keeps a non-extractable key in memory, shared between open Yapper tabs, for up to 12 hours. "Stay unlocked" (on by default, can be unticked) also keeps it in IndexedDB so it survives restarts for those 12 hours.
- Exporting a key, withdrawing SOL and removing a wallet always ask for the password. New wallets show their key once and stay flagged "Not backed up" until the user confirms or exports it.
- Withdrawals refuse coin, token and program addresses, where SOL would be lost.

**Trade safety check** (`app/_lib/guard.js`): trade transactions come from PumpPortal and Yapper wallets sign without a popup, so every one is checked and simulated before signing:

- the wallet is the only signer and stays a plain wallet; the token program is only used to set up, wrap and close the wallet's own accounts
- a program Yapper doesn't recognise is allowed only if it never gets the wallet's signature, or if the simulated result is a fair trade at the pool's own price (bonding curve or pool reserves) within slippage
- SOL only leaves for the wallet's own accounts, apart from fees and tips worth at most 1.5% of the trade
- the wallet's other coins can't shrink, and no token account changes owner or gets a spender
- the simulation must show the trade costs no more than the amount plus slippage and fees, that a buy lands the coin in the wallet, and that a sell sells no more than the percentage asked for

Anything else is blocked with a "Blocked for your safety" message and nothing is signed. What it can't judge is the price inside a DEX swap, so a malicious builder could still route a trade through a bad pool; that risk is limited to the trade itself.

**Wallet apps** (Phantom, Solflare, Backpack) sign in their own popup, which shows the app's own preview.

The site sends `frame-ancestors 'none'` so no other page can embed the terminal and trick clicks.

## Code layout

- `app/page.js`: routing (`?ca=<mint>`, `?view=pulse`, `?view=positions`), active wallet, balances, coin data, quick buy
- `app/_components/`: UI pieces (TopBar, TokenHeader, PriceChart, TradePanel, Orders, TokenFacts, DataTabs, Trades, Holders, Positions, Discover, Pulse, CoinBits, StatusBar, Toasts, VoiceDock, VoiceParts, WalletModal)
- `app/_lib/`: formatting, Solana helpers, market data clients, hooks, `pump.js` (live list data: DexScreener refresh, PumpPortal stream, mini chart points), `bonding.js` (pump.fun curve math), `wallets.js` (encrypted wallet store and signing), `guard.js` (trade safety check), `trade.js` (one trade path for the panel, voice and orders)
  - `holdings.js` (balances read from the chain), `history.js` (the wallet's trades from the chain), `fills.js` (position, average entry, PnL), `portfolio.js` (PnL today / this week), `known.js` (coins and accounts remembered per wallet)
  - `orders.js` (orders store and the tab that runs them), `quotes.js` (live market caps), `callouts.js`
  - `voicebus.js` (orb settings and announcements), `voicecontext.js` (what the orb gathers while you speak), `speech.js` (natural and browser voice), `wake.js` (hands-free wake word)
- `app/api/voice/command.js`: the command format and the assistant's instructions
- `app/globals.css`: design tokens and all styles

## Environment variables (Vercel → Project → Settings → Environment Variables)

| Name | Needed for |
| --- | --- |
| `HELIUS_API_KEY` | balances, holders, sending transactions |
| `OPENAI_API_KEY` | voice commands (`/api/voice`) |
| `OPENAI_MODEL` (optional) | model that understands commands, default `gpt-4.1-mini` |
| `OPENAI_TRANSCRIBE_MODEL` (optional) | speech-to-text model, default `gpt-4o-mini-transcribe` |
| `OPENAI_TTS_VOICE` / `OPENAI_TTS_MODEL` (optional) | the orb's natural voice, default `coral` on `gpt-4o-mini-tts` |
| `JUPITER_API_KEY` (optional) | holder count, top 10 and dev share in the lists; without it the lists just hide those numbers |

## Deploy

Every push to `main` redeploys on Vercel automatically.

## Local dev

```
npm install
cp .env.example .env.local   # fill in keys
npm run dev
```
