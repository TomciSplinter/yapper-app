// How much of a coin a wallet holds, read straight from the chain.
//
// Two independent reads in one request, so one RPC quirk can't hide a coin:
//   1. every token account the wallet owns for this mint (raw, not parsed)
//   2. the wallet's associated token accounts under both token programs
//      (classic and Token-2022, which newer pump.fun coins use)
// Amounts come from the account bytes and decimals from the mint itself.

import { PublicKey } from '@solana/web3.js';
import { rpcBatchSettled, b64ToBytes, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from './chain';

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
  const cfg = { encoding: 'base64', commitment: 'confirmed' };
  const [byOwner, direct] = await rpcBatchSettled([
    ['getTokenAccountsByOwner', [wallet, { mint }, cfg]],
    ['getMultipleAccounts', [[mint, ...atas], cfg]],
  ]);
  if (!byOwner.ok && !direct.ok) throw new Error(byOwner.error || direct.error);

  const found = new Map(); // address -> raw
  if (byOwner.ok) {
    for (const it of byOwner.result?.value || []) {
      const t = readTokenAccount(it.account);
      if (t && t.mint === mint && t.owner === wallet) found.set(it.pubkey, t.raw);
    }
  }
  let decimals = null;
  if (direct.ok) {
    const [mintAcc, ...ataAccs] = direct.result?.value || [];
    decimals = readMintDecimals(mintAcc);
    ataAccs.forEach((a, i) => {
      const t = readTokenAccount(a);
      if (t && t.mint === mint && t.owner === wallet) found.set(atas[i], t.raw);
    });
  }
  if (decimals === null) decimals = 6; // pump.fun coins; only used if the mint read failed
  const raw = [...found.values()].reduce((s, v) => s + v, 0n);
  return { amount: toUi(raw, decimals), raw, decimals, accounts: [...found.keys()], atas };
}
