// Holder stats and socials for coin lists, from Jupiter's token API.
// Uses JUPITER_API_KEY when it's set (api.jup.ag); without one it tries
// Jupiter's free lite API, and the lists simply hide these numbers if that
// isn't available. Cached for a minute.

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function num(v) {
  const n = Number(v);
  return v !== null && v !== undefined && v !== '' && Number.isFinite(n) ? n : null;
}

function link(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null;
}

export async function GET(req) {
  const mints = [
    ...new Set(
      (new URL(req.url).searchParams.get('mints') || '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => B58.test(s))
    ),
  ]
    .sort()
    .slice(0, 100);
  if (!mints.length) return Response.json({ info: {} });

  const key = process.env.JUPITER_API_KEY;
  const base = key ? 'https://api.jup.ag' : 'https://lite-api.jup.ag';
  let list;
  try {
    const r = await fetch(`${base}/tokens/v2/search?query=${mints.join(',')}`, {
      headers: { accept: 'application/json', ...(key ? { 'x-api-key': key } : {}) },
      next: { revalidate: 60 },
    });
    if (!r.ok) throw new Error(`Jupiter ${r.status}`);
    list = await r.json();
  } catch {
    return Response.json({ info: {}, unavailable: true }, { headers: { 'cache-control': 'public, s-maxage=60' } });
  }

  const info = {};
  for (const t of Array.isArray(list) ? list : []) {
    if (!t?.id || !mints.includes(t.id)) continue;
    info[t.id] = {
      holders: num(t.holderCount),
      top10: num(t.audit?.topHoldersPercentage),
      dev: num(t.audit?.devBalancePercentage),
      twitter: link(t.twitter),
      telegram: link(t.telegram),
      website: link(t.website),
      icon: link(t.icon),
      launchpad: typeof t.launchpad === 'string' ? t.launchpad : null,
      graduated: !!t.graduatedPool,
    };
  }
  return Response.json({ info }, { headers: { 'cache-control': 'public, s-maxage=60, stale-while-revalidate=120' } });
}
