// Coin lists for Discover and Pulse. The lists are built in ../_lists.js
// from GeckoTerminal's free API; every upstream call is cached, so all
// visitors share the same few calls.

import { LISTS, buildLists } from '../_lists';

export async function GET(req) {
  const wanted = new Set(
    (new URL(req.url).searchParams.get('lists') || 'curve')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => LISTS.includes(s))
  );
  if (!wanted.size) return Response.json({ error: 'Unknown list' }, { status: 400 });

  const { lists, failed } = await buildLists(wanted);
  const empty = Object.values(lists).every((l) => !l.length);
  if (empty && failed) {
    return Response.json({ lists, error: 'Coin data is unavailable right now' }, { status: 502, headers: { 'cache-control': 'no-store' } });
  }
  return Response.json(
    { lists, partial: failed > 0, updatedAt: Date.now() },
    { headers: { 'cache-control': 'public, s-maxage=20, stale-while-revalidate=60' } }
  );
}
