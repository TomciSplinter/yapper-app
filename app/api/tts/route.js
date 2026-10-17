// The orb's natural voice: text in, spoken audio (mp3) out, from OpenAI's
// text-to-speech. The browser falls back to its own voice if this fails.

export const dynamic = 'force-dynamic';
export const maxDuration = 20;

const OPENAI = 'https://api.openai.com/v1';
const MAX_TEXT = 500;

const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > 40;
}

const INSTRUCTIONS =
  'You are the voice of a crypto trading terminal. Speak clearly, calmly and a little briskly, like a sharp trading assistant. Read numbers naturally (14.2K as "fourteen point two K", 0.25 SOL as "zero point two five sol").';

export async function POST(req) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return Response.json({ error: 'Voice is not set up' }, { status: 500 });
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  if (limited(ip)) return Response.json({ error: 'Too many requests' }, { status: 429 });

  let body = {};
  try {
    body = await req.json();
  } catch {}
  const text = String(body?.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  if (!text) return Response.json({ error: 'Nothing to say' }, { status: 400 });

  const voice = process.env.OPENAI_TTS_VOICE || 'coral';
  const attempts = [
    { model: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts', voice, input: text, instructions: INSTRUCTIONS, response_format: 'mp3' },
    { model: 'tts-1', voice: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].includes(voice) ? voice : 'nova', input: text, response_format: 'mp3', speed: 1.05 },
  ];
  let lastStatus = 502;
  for (const payload of attempts) {
    const r = await fetch(`${OPENAI}/audio/speech`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => null);
    if (r?.ok) {
      return new Response(r.body, { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' } });
    }
    lastStatus = r?.status || 502;
    if (lastStatus === 401 || lastStatus === 429) break;
  }
  return Response.json({ error: 'Speech is unavailable right now' }, { status: lastStatus === 429 ? 429 : 502 });
}
