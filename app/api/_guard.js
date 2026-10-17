// Shared protections for the routes that spend the OpenAI key.

// Requests made by this app's own pages. Browsers always say where a POST
// comes from, so another website can't use these routes through its
// visitors' browsers. (A script outside a browser can claim anything; the rate
// limit is what holds those back.)
export function sameOrigin(req) {
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
    return !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function clientIp(req) {
  return (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';
}

// At most `max` requests per key per window. Old keys are swept out as they
// expire (never all at once, which would reset everyone's limit).
export function makeLimiter(max, windowMs = 60000, maxKeys = 20000) {
  const hits = new Map(); // key -> timestamps, least recently used first
  let sweptAt = Date.now();
  return function limited(key) {
    const now = Date.now();
    if (now - sweptAt > windowMs) {
      sweptAt = now;
      for (const [k, list] of hits) if (!list.length || now - list[list.length - 1] >= windowMs) hits.delete(k);
    }
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    list.push(now);
    hits.delete(key);
    hits.set(key, list);
    while (hits.size > maxKeys) hits.delete(hits.keys().next().value);
    return list.length > max;
  };
}
