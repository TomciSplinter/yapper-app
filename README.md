# Yapper — terminal

Voice trading terminal for Solana. This is step 1: the bare terminal (wallet connect, token by CA, live chart, buy/sell). The voice layer comes next.

## How it works

- **Wallet**: Phantom / Solflare / Backpack, connected in the browser. Users sign every trade themselves; no private keys ever reach the server.
- **Chart + stats**: DexScreener (chart embed + `tokens/v1` API).
- **Trades**: PumpPortal Local Transaction API with `pool: "auto"`, which covers bonding-curve coins and migrated ones. Built server-side in `/api/trade`, signed in the wallet, sent through `/api/rpc`.
- **RPC**: Helius, proxied through `/api/rpc` so the key stays on the server. Only a short list of RPC methods is allowed.

## Environment variables (Vercel → Project → Settings → Environment Variables)

| Name | Needed for |
| --- | --- |
| `HELIUS_API_KEY` | balances, sending transactions |
| `OPENAI_API_KEY` | voice layer (next step) |

## Deploy

1. Vercel → Add New → Project → import this GitHub repo. Framework: Next.js (auto-detected).
2. Add the environment variables above, then Deploy.
3. Settings → Domains → add `app.yapper.trade`, and add the DNS record Vercel shows at your registrar.

Every push to `main` redeploys automatically.

## Local dev

```
npm install
cp .env.example .env.local   # fill in keys
npm run dev
```
