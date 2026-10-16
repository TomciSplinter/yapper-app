// Token search by name or ticker (e.g. "bonk", "$WIF", "fartcoin").
// Uses DexScreener search, keeps Solana only, merges pairs of the same token
// and ranks by how well the name/ticker matches, then by liquidity + volume.
// The voice layer calls this same endpoint later ("open bonk").

function norm(s) {
  return (s || '').toLowerCase().replace(/^\$/, '').replace(/[^a-z0-9]/g, '');
}

export async function GET(req) {
  const q = (new URL(req.url).searchParams.get('q') || '').trim().slice(0, 64);
  if (q.replace(/^\$/, '').length < 2) return Response.json({ results: [] });

  let pairs = [];
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q.replace(/^\$/, ''))}`, {
      next: { revalidate: 15 },
    });
    const j = await r.json();
    pairs = Array.isArray(j?.pairs) ? j.pairs : [];
  } catch {
    return Response.json({ results: [], error: 'Search is unavailable right now' }, { status: 502 });
  }

  const nq = norm(q);
  const byMint = new Map();

  for (const p of pairs) {
    if (p?.chainId !== 'solana' || !p.baseToken?.address) continue;
    const mint = p.baseToken.address;
    const liq = p.liquidity?.usd || 0;
    const vol = p.volume?.h24 || 0;
    const prev = byMint.get(mint);
    if (prev) {
      prev.liquidity += liq;
      prev.volume24h += vol;
      if (liq > prev._bestLiq) {
        prev._bestLiq = liq;
        prev.pairAddress = p.pairAddress;
        prev.dexId = p.dexId;
        prev.priceUsd = p.priceUsd;
        prev.change24h = p.priceChange?.h24 ?? null;
      }
      prev.marketCap = prev.marketCap ?? p.marketCap ?? p.fdv ?? null;
      prev.imageUrl = prev.imageUrl || p.info?.imageUrl || null;
      continue;
    }
    byMint.set(mint, {
      mint,
      name: p.baseToken.name,
      symbol: p.baseToken.symbol,
      imageUrl: p.info?.imageUrl || null,
      priceUsd: p.priceUsd || null,
      marketCap: p.marketCap ?? p.fdv ?? null,
      liquidity: liq,
      volume24h: vol,
      change24h: p.priceChange?.h24 ?? null,
      pairAddress: p.pairAddress,
      dexId: p.dexId,
      _bestLiq: liq,
    });
  }

  const results = [...byMint.values()]
    .map((t) => {
      const sym = norm(t.symbol);
      const name = norm(t.name);
      let match = 0;
      if (sym === nq) match = 4;
      else if (name === nq) match = 3;
      else if (sym.startsWith(nq) || name.startsWith(nq)) match = 2;
      else if (sym.includes(nq) || name.includes(nq)) match = 1;
      const weight = Math.log10(1 + t.liquidity) + 0.5 * Math.log10(1 + t.volume24h);
      return { ...t, _score: match * 10 + weight };
    })
    .filter((t) => t._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, 8)
    .map(({ _score, _bestLiq, ...t }) => t);

  return Response.json({ results });
}
