// Builds an unsigned buy/sell transaction through PumpPortal's Local
// Transaction API. The user's wallet signs it in the browser — no private
// keys ever touch the server. pool "auto" covers bonding-curve coins and
// migrated ones (PumpSwap / Raydium).

export const dynamic = 'force-dynamic';

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function POST(req) {
  let b;
  try {
    b = await req.json();
  } catch {
    return Response.json({ error: 'Bad JSON' }, { status: 400 });
  }

  const { publicKey, mint, action } = b || {};
  if (!B58.test(publicKey || '') || !B58.test(mint || '')) {
    return Response.json({ error: 'Invalid wallet or token address' }, { status: 400 });
  }
  if (action !== 'buy' && action !== 'sell') {
    return Response.json({ error: 'Action must be buy or sell' }, { status: 400 });
  }

  let amount = b.amount;
  let denominatedInSol;
  if (action === 'buy') {
    amount = Number(amount);
    if (!(amount > 0) || amount > 100) {
      return Response.json({ error: 'Buy amount must be between 0 and 100 SOL' }, { status: 400 });
    }
    denominatedInSol = 'true';
  } else {
    // sells are a percentage of the wallet's tokens, e.g. "50%"
    const pct = Number(String(amount).replace('%', ''));
    if (!(pct > 0) || pct > 100) {
      return Response.json({ error: 'Sell percent must be between 1 and 100' }, { status: 400 });
    }
    amount = `${pct}%`;
    denominatedInSol = 'false';
  }

  const slippage = Math.min(Math.max(Number(b.slippage) || 10, 0.5), 50);
  const priorityFee = Math.min(Math.max(Number(b.priorityFee) || 0.0005, 0), 0.01);

  const upstream = await fetch('https://pumpportal.fun/api/trade-local', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      publicKey,
      action,
      mint,
      amount,
      denominatedInSol,
      slippage,
      priorityFee,
      pool: 'auto',
    }),
    cache: 'no-store',
  });

  if (upstream.status !== 200) {
    const msg = (await upstream.text()).slice(0, 300);
    return Response.json({ error: msg || `PumpPortal error ${upstream.status}` }, { status: 502 });
  }

  const bytes = Buffer.from(await upstream.arrayBuffer());
  return Response.json({ tx: bytes.toString('base64') });
}
