// Server-side proxy to Helius so the API key never reaches the browser.
// Only the RPC methods the terminal needs are allowed, so nobody can burn
// your Helius credits on arbitrary calls through this endpoint.

const ALLOWED = new Set([
  'getBalance',
  'getLatestBlockhash',
  'getSignatureStatuses',
  'getTokenAccountsByOwner',
  'getParsedTokenAccountsByOwner',
  'getTokenAccountBalance',
  'getAccountInfo',
  'sendTransaction',
  'simulateTransaction',
]);

export const dynamic = 'force-dynamic';

export async function POST(req) {
  const key = process.env.HELIUS_API_KEY;
  if (!key) {
    return Response.json(
      { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'HELIUS_API_KEY is not set on the server' } },
      { status: 500 }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Bad JSON' } }, { status: 400 });
  }

  const calls = Array.isArray(body) ? body : [body];
  if (calls.length === 0 || calls.length > 10) {
    return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Bad batch size' } }, { status: 400 });
  }
  for (const c of calls) {
    if (!c || !ALLOWED.has(c.method)) {
      return Response.json(
        { jsonrpc: '2.0', id: c?.id ?? null, error: { code: -32601, message: `Method not allowed: ${c?.method}` } },
        { status: 403 }
      );
    }
  }

  const upstream = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { 'content-type': 'application/json' },
  });
}
