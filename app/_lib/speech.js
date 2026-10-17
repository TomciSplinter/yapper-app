// The orb's voice. The natural voice comes from /api/tts (OpenAI); if that
// fails, or it's switched off, the browser's own voice reads the text in the
// reply's language. Browsers only allow sound after the user has interacted
// with the page, so the first tap or key press unlocks audio.

let ctx = null;
let source = null;
let endCurrent = null; // resolves whatever is playing now
let audioEl = null;
let seq = 0;
let naturalFailures = 0;
let naturalOffUntil = 0;
let speaking = false;
const listeners = new Set();

function setSpeaking(v) {
  if (speaking === v) return;
  speaking = v;
  listeners.forEach((fn) => fn(v));
}

export function isSpeaking() {
  return speaking;
}

export function onSpeaking(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* ---------- unlocking audio ---------- */

let speechUnlocked = false;

export function unlockAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC && !ctx) ctx = new AC();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  } catch {}
  // iOS only lets a page use the browser voice after one was started from a tap
  try {
    if (!speechUnlocked && window.speechSynthesis) {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      window.speechSynthesis.speak(u);
      speechUnlocked = true;
    }
  } catch {}
}

let installed = false;
export function installAudioUnlock() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const once = () => unlockAudio();
  window.addEventListener('pointerdown', once, { capture: true, passive: true });
  window.addEventListener('keydown', once, { capture: true });
}

/* ---------- the browser's own voice ---------- */

const voiceCache = new Map();
let voicesListening = false;

// a voice in the reply's language; without one the browser uses the computer's
// language (a Hungarian voice reading English, for example)
export function pickVoice(lang = 'en') {
  try {
    const synth = window.speechSynthesis;
    const want = String(lang || 'en').toLowerCase().split(/[-_]/)[0];
    if (voiceCache.has(want)) return voiceCache.get(want);
    const all = synth.getVoices() || [];
    if (!all.length && !voicesListening) {
      voicesListening = true;
      synth.addEventListener?.('voiceschanged', () => voiceCache.clear());
    }
    const voices = all.filter((v) => String(v.lang || '').toLowerCase().split(/[-_]/)[0] === want);
    if (!voices.length) return null;
    const score = (v) => {
      const code = String(v.lang || '').replace('_', '-').toLowerCase();
      const name = v.name || '';
      let s = 0;
      if (code === 'en-us') s += 4;
      else if (code === 'en-gb') s += 3;
      if (/natural|neural|online|premium|enhanced/i.test(name)) s += 3;
      if (/google/i.test(name)) s += 2;
      if (/^(samantha|aria|jenny|guy|ava|allison)\b/i.test(name)) s += 1;
      return s;
    };
    const best = voices.slice().sort((a, b) => score(b) - score(a))[0];
    voiceCache.set(want, best);
    return best;
  } catch {
    return null;
  }
}

function systemSpeak(text, lang, token) {
  return new Promise((resolve) => {
    try {
      const synth = window.speechSynthesis;
      if (!synth || token !== seq) return resolve();
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const v = pickVoice(lang);
      if (v) {
        u.voice = v;
        u.lang = v.lang;
      } else {
        u.lang = lang === 'en' ? 'en-US' : lang;
      }
      u.rate = 1.05;
      const done = () => resolve();
      endCurrent = done;
      u.onend = done;
      u.onerror = done;
      // some browsers never fire onend; don't wait forever
      setTimeout(done, Math.min(30000, 2500 + text.length * 90));
      synth.speak(u);
    } catch {
      resolve();
    }
  });
}

/* ---------- the natural voice ---------- */

async function playBuffer(buf, token) {
  if (ctx && ctx.state === 'running') {
    const audio = await ctx.decodeAudioData(buf.slice(0));
    if (token !== seq) return;
    await new Promise((resolve) => {
      const s = ctx.createBufferSource();
      s.buffer = audio;
      s.connect(ctx.destination);
      s.onended = resolve;
      endCurrent = resolve;
      source = s;
      s.start();
    });
    return;
  }
  // audio isn't unlocked yet: an <audio> element may still be allowed
  const url = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }));
  try {
    audioEl = new Audio(url);
    await audioEl.play();
    if (token !== seq) return;
    await new Promise((resolve) => {
      endCurrent = resolve;
      audioEl.onended = resolve;
      audioEl.onerror = resolve;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Speak and resolve when done. A newer call (or stopSpeaking) cuts this one off.
export async function speak(text, { lang = 'en', natural = true } = {}) {
  const t = String(text || '').trim();
  if (!t || typeof window === 'undefined') return;
  stopSpeaking();
  const token = ++seq;
  setSpeaking(true);
  try {
    if (natural && Date.now() > naturalOffUntil) {
      try {
        const r = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: t, lang }),
        });
        if (!r.ok) throw new Error(`tts ${r.status}`);
        const buf = await r.arrayBuffer();
        if (token !== seq) return;
        await playBuffer(buf, token);
        naturalFailures = 0;
        return;
      } catch (e) {
        if (token !== seq) return;
        // two misses in a row: use the browser's voice for a few minutes
        // (a blocked autoplay isn't the voice's fault)
        if (e?.name !== 'NotAllowedError' && ++naturalFailures >= 2) naturalOffUntil = Date.now() + 5 * 60 * 1000;
      }
    }
    await systemSpeak(t, lang, token);
  } finally {
    if (token === seq) setSpeaking(false);
  }
}

export function stopSpeaking() {
  seq++;
  const end = endCurrent;
  endCurrent = null;
  end?.();
  try {
    source?.stop();
  } catch {}
  source = null;
  try {
    audioEl?.pause();
  } catch {}
  audioEl = null;
  try {
    window.speechSynthesis?.cancel();
  } catch {}
  setSpeaking(false);
}
