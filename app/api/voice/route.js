// Voice commands: audio (or typed text) in, a structured command out.
// 1. Speech to text with OpenAI transcription.
// 2. An OpenAI model turns the words plus what's on screen into a command
//    (buy, sell, open a coin, answer a question...). Trades are never executed
//    here: the browser always shows a confirm step first.

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const OPENAI = 'https://api.openai.com/v1';
const MAX_AUDIO = 4 * 1024 * 1024;

// light per-instance rate limit so nobody can burn the OpenAI key
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > 20;
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'coin', 'coin_is_current', 'amount_sol', 'amount_usd', 'percent', 'target', 'reply', 'lang'],
  properties: {
    action: { type: 'string', enum: ['buy', 'sell', 'open', 'ask', 'confirm', 'cancel', 'navigate', 'unknown'] },
    coin: { type: ['string', 'null'], description: 'Coin name, ticker or contract address as the user said it. Null when they mean the coin on screen.' },
    coin_is_current: { type: 'boolean', description: 'True when the user refers to the coin already open (this, it, current one) or names it.' },
    amount_sol: { type: ['number', 'null'] },
    amount_usd: { type: ['number', 'null'] },
    percent: { type: ['number', 'null'], description: 'For sells: percent of holdings, 1-100.' },
    target: { type: ['string', 'null'], enum: ['discover', 'pulse', 'positions', null] },
    reply: { type: 'string', description: 'Short reply to show and speak, at most 2 sentences.' },
    lang: { type: 'string', description: 'Two-letter ISO 639-1 code of the language the reply is written in, e.g. en, hu, es.' },
  },
};

const SYSTEM = `You are Yapper, the voice assistant inside a Solana memecoin trading terminal.
Turn what the user said into one command. The context JSON describes what is on screen right now.

Actions:
- buy: user wants to buy. Amounts are SOL unless they say dollars/usd/bucks (then amount_usd). "half a sol" = 0.5, "a tenth" = 0.1. "ape 1" = buy 1 SOL.
- sell: user wants to sell. "sell half" = percent 50, "sell all/everything/dump it" = 100, "sell a quarter" = 25. If no amount is given, leave percent null and ask how much in reply.
- open: user wants to see/look at/pull up a coin.
- ask: a question about the market, a coin, their position or balance. Answer in reply using ONLY numbers from the context. If the data is not there, say you don't have it. Do not invent numbers. No financial advice or predictions; you may describe what the data shows.
- confirm: user approves a pending trade (yes, confirm, do it, send it, go). Only when context.pending_trade is not null.
- cancel: user rejects a pending trade or says stop/never mind.
- navigate: go to "discover" (trending/home), "pulse" (new pairs, new coins, final stretch, about to graduate, migrated, pulse) or "positions" (portfolio/my coins/bags). Set target.
- unknown: anything else; reply with a short example of what they can say.

Coins: if the user says this/it/the coin, or names the coin that is on screen, set coin_is_current true and coin null. Otherwise put the coin as they said it in coin (fix obvious speech-to-text spelling of tickers, e.g. "bonk" -> "BONK", "wiff" -> "WIF").
For buy/sell, the reply restates the trade and asks to confirm, e.g. "Buy 0.5 SOL of BONK? Say yes or tap confirm."
Keep replies short, plain and spoken-friendly: round big numbers (38.6 million, not 38,560,000). Reply in the language the user spoke.`;

async function transcribe(key, audio, hint) {
  const models = [process.env.OPENAI_TRANSCRIBE_MODEL, 'gpt-4o-mini-transcribe', 'whisper-1'].filter(Boolean);
  const type = audio.type || 'audio/webm';
  const ext = /mp4|m4a|aac/.test(type) ? 'm4a' : /ogg/.test(type) ? 'ogg' : /wav/.test(type) ? 'wav' : /mpeg|mp3/.test(type) ? 'mp3' : 'webm';
  let lastErr = 'Transcription failed';
  for (const model of [...new Set(models)]) {
    const fd = new FormData();
    fd.append('file', audio, `voice.${ext}`);
    fd.append('model', model);
    fd.append('prompt', `Solana memecoin trading commands. Words like SOL, buy, sell, ape, dump, market cap, pump.fun, ticker.${hint ? ` Coin on screen: ${hint}.` : ''}`);
    const r = await fetch(`${OPENAI}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: fd });
    const j = await r.json().catch(() => ({}));
    if (r.ok && typeof j.text === 'string') return j.text.trim();
    lastErr = j?.error?.message || `Transcription error ${r.status}`;
    if (r.status === 401 || r.status === 429) break;
  }
  throw new Error(lastErr);
}

async function understand(key, transcript, context) {
  const models = [process.env.OPENAI_MODEL, 'gpt-4.1-mini', 'gpt-4o-mini', 'gpt-5-mini'].filter(Boolean);
  let lastErr = 'Could not understand the command';
  for (const model of [...new Set(models)]) {
    const r = await fetch(`${OPENAI}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: JSON.stringify({ said: transcript, context }) },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'yapper_command', strict: true, schema: SCHEMA } },
        max_completion_tokens: 1200,
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

function clean(cmd) {
  const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v > lo && v <= hi ? v : null);
  return {
    action: cmd?.action || 'unknown',
    coin: typeof cmd?.coin === 'string' && cmd.coin.trim() ? cmd.coin.trim().slice(0, 64) : null,
    coin_is_current: !!cmd?.coin_is_current,
    amount_sol: num(cmd?.amount_sol, 0, 1000),
    amount_usd: num(cmd?.amount_usd, 0, 1e7),
    percent: num(cmd?.percent, 0, 100),
    target: ['discover', 'pulse', 'positions'].includes(cmd?.target) ? cmd.target : null,
    reply: String(cmd?.reply || '').slice(0, 400),
    lang: /^[a-z]{2}$/.test(String(cmd?.lang || '').toLowerCase()) ? String(cmd.lang).toLowerCase() : 'en',
  };
}

export async function POST(req) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return Response.json({ error: 'Voice is not set up yet: OPENAI_API_KEY is missing on the server.' }, { status: 500 });

  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  if (limited(ip)) return Response.json({ error: 'Too many voice commands. Wait a moment and try again.' }, { status: 429 });

  let form;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: 'Bad request' }, { status: 400 });
  }

  let context = {};
  try {
    context = JSON.parse(String(form.get('context') || '{}'));
  } catch {}
  if (JSON.stringify(context).length > 12000) context = {};

  let transcript = String(form.get('text') || '').trim().slice(0, 300);
  const audio = form.get('audio');
  try {
    if (!transcript && audio && typeof audio === 'object') {
      if (audio.size > MAX_AUDIO) return Response.json({ error: 'That recording is too long. Keep it under 15 seconds.' }, { status: 413 });
      if (audio.size < 1200) return Response.json({ error: "I didn't catch that. Hold the orb a little longer while you talk." }, { status: 400 });
      transcript = await transcribe(key, audio, context?.coin?.symbol);
    }
    if (!transcript) return Response.json({ error: "I didn't catch that. Try again." }, { status: 400 });
    const command = clean(await understand(key, transcript, context));
    return Response.json({ transcript, command });
  } catch (e) {
    return Response.json({ error: String(e?.message || 'Voice failed').slice(0, 200), transcript }, { status: 502 });
  }
}
