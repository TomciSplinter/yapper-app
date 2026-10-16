// Safety check for trade transactions before a built-in wallet signs them.
//
// Trade transactions are built by PumpPortal. A wallet app shows its own
// preview before you approve; built-in wallets sign instantly, so first we
// make sure the transaction can only do the trade that was asked for:
//   - this wallet pays and is the only signer
//   - the token program is only used to set up, wrap and close the wallet's
//     own accounts, and the system program can't reassign the wallet
//   - a program Yapper doesn't recognise (PumpPortal sometimes routes through
//     new pump.fun or router programs) is allowed only if it never gets the
//     wallet's signature, or if the simulated result is a fair trade: the coins
//     or SOL received must match the pool's own price within your slippage
//   - SOL only moves into the wallet's own accounts, apart from fees and tips
//     worth at most 1.5% of the trade
//   - the wallet's other coins can't shrink, and no token account changes
//     owner or gets a spender
//   - a simulation shows the trade can't take more SOL than asked plus fees,
//     a buy really lands the coin in this wallet, and a sell doesn't sell more
//     than the percentage asked for
//   - pump.fun buys can't carry a looser price limit than your slippage
// The simulation also catches trades that would fail, before anything is signed.
//
// What this can't judge is the price inside a DEX swap: a malicious builder
// could still route a trade through a bad pool. That risk is limited to the
// trade itself, never the rest of the wallet.

import { PublicKey } from '@solana/web3.js';
import { rpc, rpcBatch, b64ToBytes, bytesToB64, SOL_MINT, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from './chain';

const SYSTEM = '11111111111111111111111111111111';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM, TOKEN_2022_PROGRAM]);

const KNOWN_PROGRAMS = new Set([
  SYSTEM,
  COMPUTE_BUDGET,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // associated token accounts
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', // memo
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo', // memo v1
  PUMP, // pump.fun bonding curve
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // PumpSwap
  'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ', // pump.fun fees
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CPMM
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj', // Raydium LaunchLab (bonk.fun)
  'routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS', // Raydium AMM routing
  'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN', // Meteora dynamic bonding curve
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', // Meteora DAMM v2
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', // Meteora pools
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // Meteora DLMM
]);

// System program: create account (0, needs a second signer so never passes),
// transfer (2), create account with seed (3)
const SYSTEM_OK = new Set([0, 2, 3]);
// Token programs: initialize account (1, 16, 18), close account (9, only back
// to this wallet), sync native (17), and read-only helpers (21-24)
const TOKEN_OK = new Set([1, 9, 16, 17, 18, 21, 22, 23, 24]);
const PUMP_BUY = [102, 6, 61, 18, 1, 218, 235, 234];
const STAKE = 'Stake11111111111111111111111111111111111111';
const VOTE = 'Vote111111111111111111111111111111111111111';
// Fees between the pool price and what a trade gets: pump.fun ~1.25%,
// PumpPortal 0.5% (taken as SOL), plus rounding. Kept generous.
const FAIR_FLOOR = 0.93;

const LAMPORTS = 1e9;
const FEE_SHARE = 0.015; // PumpPortal takes 0.5%
const FEE_FLOOR = 0.002 * LAMPORTS;
const FIXED_MARGIN = 0.015 * LAMPORTS; // rent for new token accounts, base fee, rounding

const blocked = (reason) => new Error(`Blocked for your safety: ${reason}. Nothing was signed.`);
const unverified = () => new Error("Couldn't verify this trade, so it wasn't signed. Try again.");

const u32 = (d, o) => (d.length >= o + 4 ? (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0 : 0);
const u64 = (d, o) => (d.length >= o + 8 ? u32(d, o) + u32(d, o + 4) * 4294967296 : 0);
const u64n = (d, o) => (d.length >= o + 8 ? BigInt(u32(d, o)) + (BigInt(u32(d, o + 4)) << 32n) : 0n);
const b58 = (bytes) => new PublicKey(bytes).toBase58();
const shortAddr = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// { mint, owner, amount (BigInt), delegate, closeAuthority } for an SPL token account, else null
function tokenAccount(a) {
  if (!a || !a.lamports || !TOKEN_PROGRAMS.has(a.owner)) return null;
  const d = b64ToBytes(a.data?.[0] || '');
  if (!(d.length === 165 || (d.length > 165 && d[165] === 2))) return null;
  return {
    mint: b58(d.slice(0, 32)),
    owner: b58(d.slice(32, 64)),
    amount: u64n(d, 64),
    delegate: u32(d, 72) ? b58(d.slice(76, 108)) : null,
    closeAuthority: u32(d, 129) ? b58(d.slice(133, 165)) : null,
  };
}

function simFailure(v) {
  const text = `${JSON.stringify(v.err)} ${(v.logs || []).join(' ')}`;
  if (/slippage|TooMuchSolRequired|TooLittleSolReceived|ExceededSlippage|"Custom":600[23]\b/i.test(text)) {
    return 'The price moved past your slippage limit. Raise slippage or try again.';
  }
  if (/insufficient lamports|insufficient funds|InsufficientFunds|prior credit|AccountNotFound/i.test(text)) {
    return 'Not enough SOL for this trade and its fees.';
  }
  if (/BondingCurveComplete|curve.{0,20}complete/i.test(text)) {
    return 'This coin just left the bonding curve. Try again in a few seconds.';
  }
  return "This trade would fail right now, so it wasn't sent. Try again.";
}

// side 'buy' spends amountSol; 'sell' sells `percent` of the coin. slippage in %, prioFee in SOL.
export async function checkTrade(tx, { wallet, mint, side, amountSol, percent, slippage, prioFee }) {
  const isBuy = side === 'buy';
  const slip = clamp(Number(slippage) || 10, 0.5, 50);
  const fee = clamp(Number.isFinite(Number(prioFee)) ? Number(prioFee) : 0.0005, 0, 0.01);
  const amount = Number(amountSol) || 0;
  const pct = clamp(Number(percent) || 0, 0, 100);

  const msg = tx.message;
  const keys = msg.staticAccountKeys.map((k) => k.toBase58());
  const h = msg.header;
  if (keys[0] !== wallet) throw blocked('it would be paid by a different wallet');
  if (h.numRequiredSignatures !== 1) throw blocked('it asks for more signatures than yours');

  // accounts from lookup tables come after the static ones: all writable, then all read-only
  const lookups = msg.addressTableLookups || [];
  const lookupWritable = [];
  const lookupReadonly = [];
  if (lookups.length) {
    const tables = await rpc('getMultipleAccounts', [lookups.map((l) => l.accountKey.toBase58()), { encoding: 'base64', commitment: 'confirmed' }]);
    lookups.forEach((l, i) => {
      const raw = tables?.value?.[i]?.data?.[0];
      if (!raw) throw unverified();
      const d = b64ToBytes(raw);
      const at = (j) => {
        const o = 56 + j * 32;
        if (o + 32 > d.length) throw unverified();
        return b58(d.slice(o, o + 32));
      };
      l.writableIndexes.forEach((j) => lookupWritable.push(at(j)));
      l.readonlyIndexes.forEach((j) => lookupReadonly.push(at(j)));
    });
  }
  const all = [...keys, ...lookupWritable, ...lookupReadonly];
  const nStatic = keys.length;
  const nSigned = h.numRequiredSignatures;
  const writable = all.filter((_, i) => {
    if (i >= nStatic) return i - nStatic < lookupWritable.length;
    if (i < nSigned) return i < nSigned - h.numReadonlySignedAccounts;
    return i - nSigned < nStatic - nSigned - h.numReadonlyUnsignedAccounts;
  });

  // what each instruction does
  let cuLimit = null;
  let cuPrice = 0;
  let nonBudget = 0;
  const outflows = []; // SOL the system program sends from this wallet: { to, lamports }
  const unknown = new Set(); // programs Yapper doesn't recognise
  let unknownSigns = false; // one of them gets this wallet as an account (and so its signature)
  const closedToWallet = new Set(); // token accounts this transaction closes back into the wallet
  for (const ix of msg.compiledInstructions) {
    if (ix.programIdIndex >= nStatic) throw blocked('it loads a program from a lookup table');
    const program = keys[ix.programIdIndex];
    const d = ix.data || new Uint8Array();
    const acct = (n) => all[ix.accountKeyIndexes[n]];
    if (!KNOWN_PROGRAMS.has(program)) {
      unknown.add(program);
      if (ix.accountKeyIndexes.some((k) => all[k] === wallet)) unknownSigns = true;
      nonBudget++;
      continue;
    }
    if (program === COMPUTE_BUDGET) {
      if (d[0] === 2) cuLimit = u32(d, 1);
      if (d[0] === 3) cuPrice = u64(d, 1);
      continue;
    }
    nonBudget++;
    if (program === SYSTEM) {
      const kind = u32(d, 0);
      if (!SYSTEM_OK.has(kind)) throw blocked('it tries to change how your wallet works');
      if (kind === 2) outflows.push({ to: acct(1), lamports: u64(d, 4) });
      if (kind === 0) outflows.push({ to: acct(1), lamports: u64(d, 4) });
      if (kind === 3) outflows.push({ to: acct(1), lamports: u64(d, 44 + u64(d, 36)) });
    }
    if (TOKEN_PROGRAMS.has(program)) {
      if (!TOKEN_OK.has(d[0])) throw blocked('it tries to move, burn or hand over coins in your wallet');
      if (d[0] === 9 && acct(1) !== wallet) throw blocked('it closes a token account and sends the SOL to someone else');
      if (d[0] === 9) closedToWallet.add(acct(0));
    }
    if (program === PUMP && isBuy && PUMP_BUY.every((x, i) => d[i] === x)) {
      const maxCost = u64(d, 16);
      if (maxCost > amount * (1 + slip / 100) * 1.05 * LAMPORTS + 1e6) throw blocked('its price limit is far looser than your slippage setting');
    }
  }

  // priority fee from the compute budget (micro-lamports per compute unit)
  const units = cuLimit ?? Math.min(1400000, 200000 * Math.max(1, nonBudget));
  const priority = (units * cuPrice) / 1e6;
  if (priority > Math.max(fee * 2, fee + 0.002) * LAMPORTS + 1) throw blocked('its priority fee is far above your setting');
  const networkFee = 5000 + priority;

  const maxSpend = (isBuy ? amount * (1 + slip / 100) * 1.05 * LAMPORTS : 0) + priority + FIXED_MARGIN;
  if (unknown.size) console.warn('[yapper] trade uses programs Yapper does not recognise:', [...unknown].join(', '));
  let curvePda = null;
  if (unknownSigns) {
    try {
      curvePda = PublicKey.findProgramAddressSync([new TextEncoder().encode('bonding-curve'), new PublicKey(mint).toBytes()], new PublicKey(PUMP))[0].toBase58();
    } catch {
      curvePda = null;
    }
  }
  const encoded = bytesToB64(tx.serialize());

  // Balances before and the simulated result, from the same moment on the node.
  // If another trade lands in between it can look like we spent more, so a
  // breach is checked once more before blocking.
  for (let attempt = 0; ; attempt++) {
    const [pre, sim, extra] = await rpcBatch([
      ['getMultipleAccounts', [writable, { encoding: 'base64', commitment: 'confirmed' }]],
      [
        'simulateTransaction',
        [
          encoded,
          {
            encoding: 'base64',
            commitment: 'confirmed',
            sigVerify: false,
            replaceRecentBlockhash: true,
            accounts: { encoding: 'base64', addresses: writable },
          },
        ],
      ],
      ...(curvePda ? [['getMultipleAccounts', [[curvePda], { encoding: 'base64', commitment: 'confirmed' }]]] : []),
    ]);
    const v = sim?.value;
    if (!v) throw unverified();
    if (v.err) throw new Error(simFailure(v));
    if (!Array.isArray(v.accounts) || v.accounts.length !== writable.length) throw unverified();
    const before = pre?.value?.[0]?.lamports;
    const after = v.accounts[0]?.lamports;
    if (writable[0] !== wallet || typeof before !== 'number' || typeof after !== 'number') throw unverified();
    // the wallet must stay a plain wallet
    const w = v.accounts[0];
    if (w.owner !== SYSTEM || (w.data?.[0] || '') !== '') throw blocked('it tries to change how your wallet works');
    if (unknown.size) {
      for (const a of pre?.value || []) {
        if (a && (a.owner === STAKE || a.owner === VOTE)) throw blocked('it touches a staking account');
      }
    }

    // the wallet's token accounts, before and after
    let coinBefore = 0n;
    let coinAfter = 0n;
    let wsolBefore = 0;
    let wsolAfter = 0;
    writable.forEach((addr, i) => {
      const a = tokenAccount(pre?.value?.[i]);
      const b = tokenAccount(v.accounts[i]);
      const mine = (a && a.owner === wallet) || (b && b.owner === wallet);
      if (!mine) return;
      if (a && b && (b.owner !== a.owner || b.delegate !== a.delegate || b.closeAuthority !== a.closeAuthority)) {
        throw blocked('it hands control of one of your token accounts to someone else');
      }
      if (!a && b && (b.delegate || b.closeAuthority)) throw blocked('it gives someone else control of a new token account');
      const m = (a || b).mint;
      const amtA = a && a.owner === wallet ? a.amount : 0n;
      const amtB = b && b.owner === wallet ? b.amount : 0n;
      if (m === mint) {
        coinBefore += amtA;
        coinAfter += amtB;
      } else if (m === SOL_MINT) {
        wsolBefore += Number(amtA);
        wsolAfter += Number(amtB);
      } else if (amtB < amtA) {
        throw blocked('it takes other coins out of your wallet');
      }
    });

    // SOL leaving for accounts that aren't this wallet's own
    const own = (addr) => {
      if (addr === wallet) return true;
      const i = writable.indexOf(addr);
      if (i < 0) return false;
      const p = v.accounts[i];
      // a temporary wrapped-SOL account this transaction closes back into the wallet
      if (!p || !p.lamports) return closedToWallet.has(addr);
      return tokenAccount(p)?.owner === wallet;
    };
    const external = outflows.reduce((s, o) => s + (own(o.to) ? 0 : o.lamports), 0);

    const gained = after + wsolAfter - (before + wsolBefore);
    if (isBuy) {
      if (coinAfter <= coinBefore) throw blocked("you wouldn't receive the coin you're buying");
    } else {
      const allowed = (coinBefore * BigInt(Math.round(pct * 100))) / 10000n + 1n;
      if (coinBefore - coinAfter > allowed) throw blocked(`it would sell more than ${pct}% of this coin`);
    }
    const tradeValue = isBuy ? amount * LAMPORTS : Math.max(0, gained + networkFee + external);
    if (external > tradeValue * FEE_SHARE + FEE_FLOOR) throw blocked(`it sends ${(external / LAMPORTS).toFixed(4)} SOL to an account that isn't yours`);

    // A program we don't recognise had this wallet's signature: only accept a
    // fair result, measured against the pool's own reserves before the trade.
    if (unknownSigns) {
      const res = reserves(writable, pre?.value, extra?.value?.[0], mint, wallet);
      if (!res) throw blocked(`it goes through a program Yapper doesn't know (${shortAddr([...unknown][0])}) and the price couldn't be checked`);
      const floor = (1 - slip / 100) * FAIR_FLOOR;
      if (isBuy) {
        const a = amount * LAMPORTS;
        const fair = (res.tokens * a) / (res.sol + a);
        if (Number(coinAfter - coinBefore) < fair * floor) throw blocked('you would get far fewer coins than the pool price gives');
      } else {
        const t = Number(coinBefore - coinAfter);
        const fair = (res.sol * t) / (res.tokens + t);
        if (gained + networkFee < fair * floor - FEE_FLOOR) throw blocked('you would get far less SOL than the pool price gives');
      }
    }

    const spent = -gained;
    if (spent <= maxSpend) return { spentLamports: spent };
    if (attempt >= 1) throw blocked(`it would take ${(spent / LAMPORTS).toFixed(4)} SOL, more than this trade allows`);
  }
}

// Pool reserves before the trade, in raw coin units and lamports.
// pump.fun bonding curve: read from the curve account. Otherwise (PumpSwap and
// other pools): the largest coin and wrapped-SOL token accounts the trade
// writes to that don't belong to this wallet.
function reserves(writable, preAccounts, curve, mint, wallet) {
  if (curve?.owner === PUMP && curve.data?.[0]) {
    const d = b64ToBytes(curve.data[0]);
    const vTokens = Number(u64n(d, 8));
    const vSol = Number(u64n(d, 16));
    const complete = d.length > 48 ? d[48] === 1 : false;
    if (!complete && vTokens > 0 && vSol > 0) return { tokens: vTokens, sol: vSol };
  }
  let tokens = 0;
  let sol = 0;
  (preAccounts || []).forEach((a) => {
    const t = tokenAccount(a);
    if (!t || t.owner === wallet) return;
    if (t.mint === mint) tokens = Math.max(tokens, Number(t.amount));
    else if (t.mint === SOL_MINT) sol = Math.max(sol, Number(t.amount));
  });
  return tokens > 0 && sol > 0 ? { tokens, sol } : null;
}
