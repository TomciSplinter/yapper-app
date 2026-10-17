// Voice commands: audio (or typed / hands-free text) in, one structured command out.
// 1. Speech to text with OpenAI transcription (skipped when text is sent).
// 2. An OpenAI model turns the words, what's on screen, the user's positions,
//    orders and the coin lists into a command (buy, sell, set an order, scan
//    for coins, answer a question...). Nothing is executed here: the browser
//    shows a confirm step before anything that spends or sells.

import { SCHEMA, SYSTEM, clean, scrubContext, wantsLists, plainText } from './command';
import { sameOrigin, clientIp, makeLimiter } from '../_guard';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const OPENAI = 'https://api.openai.com/v1';
const MAX_AUDIO = 4 * 1024 * 1024;
const MAX_CONTEXT = 60000;

// light per-instance rate limit so nobody can burn the OpenAI key
const limited = makeLimiter(30);

async function transcribe(key, audio, hint) {
  const models = [process.env.OPENAI_TRANSCRIBE_MODEL, 'gpt-4o-mini-transcribe', 'whisper-1'].filter(Boolean);
  const type = audio.type || 'audio/webm';
  const ext = /mp4|m4a|aac/.test(type) ? 'm4a' : /ogg/.test(type) ? 'ogg' : /wav/.test(type) ? 'wav' : /mpeg|mp3/.test(type) ? 'mp3' : 'webm';
  let lastErr = 'Transcription failed';
  for (const model of [...new Set(models)]) {
    const fd = new FormData();
    fd.append('file', audio, `voice.${ext}`);
    fd.append('model', model);
    fd.append(
      'prompt',
      `Solana memecoin trading commands. Words like SOL, buy, sell, ape, dump, market cap, take profit, stop loss, limit order, pump.fun, PumpSwap, ticker, Yapper.${hint ? ` Coin on screen: ${hint}.` : ''}`
    );
    const r = await fetch(`${OPENAI}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: fd });
    const j = await r.json().catch(() => ({}));
    if (r.ok && typeof j.text === 'string') return j.text.trim();
    lastErr = j?.error?.message || `Transcription error ${r.status}`;
    if (r.status === 401 || r.status === 429) break;
  }
  throw new Error(lastErr);
}

async function understand(key, transcript, context, history) {
  const models = [process.env.OPENAI_MODEL, 'gpt-4.1-mini', 'gpt-4o-mini'].filter(Boolean);
  let lastErr = 'Could not understand the command';
  for (const model of [...new Set(models)]) {
    const r = await fetch(`${OPENAI}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: JSON.stringify({ said: transcript, context, history }) },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'yapper_command', strict: true, schema: SCHEMA } },
        max_completion_tokens: 1500,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      try {
        return JSON.parse(j.choices?.[0]?.message?.content || '');
      } catch {
        lastErr = 'The assistant returned an unreadable answer';
        continue;
      }
    }
    lastErr = j?.error?.message || `Assistant error ${r.status}`;
    if (r.status === 401 || r.status === 429) break;
  }
  throw new Error(lastErr);
}

// keep the request small: drop the biggest optional parts first
function fit(context) {
  const size = (v) => JSON.stringify(v).length;
  if (size(context) <= MAX_CONTEXT) return context;
  const c = { ...context };
  for (const k of ['lists', 'portfolio', 'orders']) {
    if (size(c) <= MAX_CONTEXT) break;
    delete c[k];
  }
  if (c.coin && size(c) > MAX_CONTEXT) c.coin = { ...c.coin, recent_trades: undefined, largest_holders: undefined };
  return size(c) <= MAX_CONTEXT ? c : {};
}

function cleanHistory(h) {
  if (!Array.isArray(h)) return [];
  return h.slice(-6).map((t) => ({
    said: plainText(t?.said, 200),
    reply: plainText(t?.reply, 400),
    action: plainText(t?.action, 20),
    coin: t?.coin && typeof t.coin === 'object' ? { mint: plainText(t.coin.mint, 44), symbol: plainText(t.coin.symbol, 16) } : null,
    listed: Array.isArray(t?.listed)
      ? t.listed.slice(0, 10).map((x, i) => ({ n: i + 1, mint: plainText(x?.mint, 44), symbol: plainText(x?.symbol, 16) }))
      : [],
  }));
}

export async function POST(req) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return Response.json({ error: 'Voice is not set up yet: OPENAI_API_KEY is missing on the server.' }, { status: 500 });

  if (!sameOrigin(req)) return Response.json({ error: 'Forbidden' }, { status: 403 });
  if (limited(clientIp(req))) return Response.json({ error: 'Too many voice commands. Wait a moment and try again.' }, { status: 429 });

  let form;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: 'Bad request' }, { status: 400 });
  }

  let context = {};
  let history = [];
  try {
    context = JSON.parse(String(form.get('context') || '{}'));
  } catch {}
  try {
    history = cleanHistory(JSON.parse(String(form.get('history') || '[]')));
  } catch {}
  // names and tickers are set by whoever made the coin: short and plain only
  context = scrubContext(context && typeof context === 'object' && !Array.isArray(context) ? context : {});

  let transcript = String(form.get('text') || '').trim().slice(0, 300);
  const audio = form.get('audio');
  try {
    if (!transcript && audio && typeof audio === 'object') {
      if (audio.size > MAX_AUDIO) return Response.json({ error: 'That recording is too long. Keep it under 15 seconds.' }, { status: 413 });
      if (audio.size < 1200) return Response.json({ error: "I didn't catch that. Hold the orb a little longer while you talk." }, { status: 400 });
      transcript = await transcribe(key, audio, context?.coin?.symbol);
    }
    if (!transcript) return Response.json({ error: "I didn't catch that. Try again." }, { status: 400 });
    // coin lists (third-party names) only go to the assistant for a scan
    if (!wantsLists(transcript)) delete context.lists;
    const command = clean(await understand(key, transcript, fit(context), history));
    return Response.json({ transcript, command });
  } catch (e) {
    return Response.json({ error: String(e?.message || 'Voice failed').slice(0, 200), transcript }, { status: 502 });
  }
}
