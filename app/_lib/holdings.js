// How much of a coin a wallet holds, read straight from the chain.
//
// Two independent reads in one request, so one RPC quirk can't hide a coin:
//   1. every token account the wallet owns for this mint (the RPC's index)
//   2. the accounts themselves, read by address: the wallet's associated
//      token accounts under both token programs (classic and Token-2022,
//      which newer pump.fun coins use) plus any account a Yapper trade put
//      this coin in
// Amounts come from the account bytes and decimals from the mint itself.

import { PublicKey } from '@solana/web3.js';
import { rpcBatchSettled, b64ToBytes, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from './chain';
import { knownAccounts } from './known';
import { scanWallet } from './history';

export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM, TOKEN_2022_PROGRAM]);

export function ataAddress(owner, mint, tokenProgram) {
  try {
    return PublicKey.findProgramAddressSync(
      [new PublicKey(owner).toBytes(), new PublicKey(tokenProgram).toBytes(), new PublicKey(mint).toBytes()],
      new PublicKey(ATA_PROGRAM)
    )[0].toBase58();
  } catch {
    return null;
  }
}

const u64 = (d, o) => {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]);
  return v;
};
const b58 = (d) => new PublicKey(d).toBase58();

// SPL token account (either program) -> { mint, owner, raw }
export function readTokenAccount(acc) {
  if (!acc || !TOKEN_PROGRAMS.has(acc.owner)) return null;
  const d = b64ToBytes(acc.data?.[0] || '');
  if (d.length < 165) return null;
  return { mint: b58(d.slice(0, 32)), owner: b58(d.slice(32, 64)), raw: u64(d, 64) };
}

// SPL mint -> decimals
export function readMintDecimals(acc) {
  if (!acc || !TOKEN_PROGRAMS.has(acc.owner)) return null;
  const d = b64ToBytes(acc.data?.[0] || '');
  return d.length >= 82 ? d[44] : null;
}

export function toUi(raw, decimals) {
  const div = 10n ** BigInt(decimals);
  return Number(raw / div) + Number(raw % div) / Number(div);
}

// -> { amount, raw, decimals, accounts: [address] }. Throws only if nothing could be read.
export async function loadHolding(wallet, mint) {
  const atas = [ataAddress(wallet, mint, TOKEN_PROGRAM), ataAddress(wallet, mint, TOKEN_2022_PROGRAM)].filter(Boolean);
  const direct = [...new Set([...atas, ...knownAccounts(wallet, mint)])];
  const cfg = { encoding: 'base64', commitment: 'confirmed' };
  const [byOwner, byAddress] = await rpcBatchSettled([
    ['getTokenAccountsByOwner', [wallet, { mint }, cfg]],
    ['getMultipleAccounts', [[mint, ...direct], cfg]],
  ]);
  if (!byOwner.ok) console.warn('[yapper] token account lookup failed:', byOwner.error);
  if (!byAddress.ok) console.warn('[yapper] token account read failed:', byAddress.error);
  if (!byOwner.ok && !byAddress.ok) throw new Error(byAddress.error || byOwner.error);

  const found = new Map(); // address -> raw
  if (byOwner.ok) {
    for (const it of byOwner.result?.value || []) {
      const t = readTokenAccount(it.account);
      if (t && t.mint === mint && t.owner === wallet) found.set(it.pubkey, t.raw);
    }
  }
  let decimals = null;
  if (byAddress.ok) {
    const [mintAcc, ...accs] = byAddress.result?.value || [];
    decimals = readMintDecimals(mintAcc);
    accs.forEach((a, i) => {
      const t = readTokenAccount(a);
      if (t && t.mint === mint && t.owner === wallet) found.set(direct[i], t.raw);
    });
  }
  // Nothing found: the coin may sit in an account the RPC's index doesn't
  // list. Check the wallet's recent transactions for where it went.
  if (!found.size) {
    await scanWallet(wallet).catch(() => []);
    const extra = knownAccounts(wallet, mint).filter((a) => !direct.includes(a));
    if (extra.length) {
      const r = await rpcBatchSettled([['getMultipleAccounts', [extra, cfg]]]).catch(() => [{ ok: false }]);
      if (r[0].ok) {
        (r[0].result?.value || []).forEach((a, i) => {
          const t = readTokenAccount(a);
          if (t && t.mint === mint && t.owner === wallet) found.set(extra[i], t.raw);
        });
      }
    }
  }
  if (decimals === null) decimals = 6; // pump.fun coins; only used if the mint read failed
  const raw = [...found.values()].reduce((s, v) => s + v, 0n);
  return { amount: toUi(raw, decimals), raw, decimals, accounts: [...found.keys()], atas };
}
