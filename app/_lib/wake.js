// Hands-free: say "Yapper" and then the command ("Yapper, buy 0.1 SOL of
// this"), or "Yapper", a short pause, and the command. Uses the browser's
// built-in speech recognition (Chrome and Edge send the audio to their speech
// service). While a trade waits for confirmation, a plain "yes" or "no" works
// without the wake word.

// How speech services tend to write "Yapper". Anything else within two
// letters of it that starts with y or j counts too ("yapa", "japper").
const WAKE_WORDS = new Set(['yapper', 'yappers', 'yaper', 'yapa', 'yappa', 'yappah', 'japper', 'japer', 'jabber', 'yabber', 'yapr', 'yappr']);
const WAKE_PAIRS = new Set(['yapper', 'yaper', 'yapher', 'yapa', 'yeahper', 'yepper', 'yupper']);
// a plain yes or no, and nothing else (a longer sentence needs "Yapper" first)
const REPLY = /^\s*(?:yes|yeah|yep|yup|sure|ok(?:ay)?|confirm(?:ed)?|do it|send it|go(?: ahead)?|igen|mehet|no|nope|nem|cancel|stop|never ?mind)(?:\s+(?:please|now|thanks|thank you))?[\s.!?,]*$/i;
const AFTER_WAKE_MS = 7000;
const REPLY_MS = 15000;
const ANSWER_MS = 9000;

const low = (w) => w.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');

function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

const isWake = (w) => WAKE_WORDS.has(w) || (w.length >= 4 && w.length <= 7 && /^[yj]a/.test(w) && lev(w, 'yapper') <= 2);

// Where the command starts after the wake word, if one of the first three
// words is "Yapper" ("hey yapper, buy...", "yap per buy..."); -1 if none.
export function wakeAt(text) {
  const words = [...String(text || '').matchAll(/[\p{L}\p{N}'’]+/gu)];
  for (let i = 0; i < Math.min(3, words.length); i++) {
    const w = low(words[i][0]);
    if (isWake(w)) return words[i].index + words[i][0].length;
    const next = words[i + 1];
    if (next && WAKE_PAIRS.has(w + low(next[0]))) return next.index + next[0].length;
  }
  return -1;
}

export function wakeSupported() {
  return typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

// handlers: { onWake(), onCommand(text), onHeard(text, used), onState('listening' | 'paused' | 'off' | 'denied' | 'unsupported' | 'error') }
export function createWake({ lang = 'en-US', onWake, onCommand, onHeard, onState }) {
  const SR = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
  let rec = null;
  let on = false; // the user switched it on
  let paused = false; // the app is recording or speaking
  let running = false;
  let restartTimer = null;
  let fails = 0;
  let wakeUntil = 0; // heard "Yapper" alone: the next phrase is the command
  let replyUntil = 0; // a yes/no is expected
  let armed = false; // the wake word showed up while the sentence was still coming in
  let answerNext = false; // a question was asked: the answer needs no wake word
  let startFails = 0;

  const state = (s) => onState?.(s);
  const meaningful = (t) => t.replace(/[^\p{L}\p{N}]/gu, '').length >= 2;

  function handleFinal(text) {
    const t = String(text || '').trim();
    const wasArmed = armed;
    armed = false;
    if (!t) return;
    const at = wakeAt(t);
    if (at >= 0) {
      const after = t.slice(at).replace(/^[\s,.!?:;-]+/, '').trim();
      onHeard?.(t, true);
      if (meaningful(after)) {
        wakeUntil = 0;
        onCommand?.(after);
      } else {
        wakeUntil = Date.now() + AFTER_WAKE_MS;
        onWake?.();
      }
      return;
    }
    // heard "Yapper" a moment ago (alone, or before the final text changed it)
    if (Date.now() < wakeUntil || (wasArmed && meaningful(t))) {
      wakeUntil = 0;
      onHeard?.(t, true);
      onCommand?.(t);
      return;
    }
    if (Date.now() < replyUntil && REPLY.test(t)) {
      replyUntil = 0;
      onHeard?.(t, true);
      onCommand?.(t);
      return;
    }
    onHeard?.(t, false);
  }

  function build() {
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = lang;
    r.maxAlternatives = 1;
    r.onresult = (e) => {
      fails = 0;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = res[0]?.transcript || '';
        if (res.isFinal) handleFinal(text);
        else if (!armed && wakeAt(text) >= 0) {
          armed = true;
          onWake?.(); // show that it's listening before the sentence ends
        }
      }
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        on = false;
        state('denied');
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        fails++;
      }
    };
    r.onend = () => {
      running = false;
      if (!on || paused) return;
      // Chrome stops every so often; start again (slower after errors)
      clearTimeout(restartTimer);
      restartTimer = setTimeout(begin, fails ? Math.min(30000, 1000 * 2 ** Math.min(fails, 5)) : 250);
      if (fails >= 6) state('error');
    };
    return r;
  }

  function begin() {
    if (!on || paused || running || !SR) return;
    try {
      rec = rec || build();
      rec.start();
      running = true;
      startFails = 0;
      if (answerNext) {
        answerNext = false;
        wakeUntil = Date.now() + ANSWER_MS;
      }
      state('listening');
    } catch (e) {
      if (e?.name === 'InvalidStateError') {
        running = true; // already listening
        return;
      }
      running = false;
      // some browsers (Safari on iPhone) only start again after a tap
      if (++startFails >= 3) state('error');
    }
  }

  // a tap anywhere restarts listening if the browser stopped it
  const onTap = () => {
    if (on && !paused && !running) begin();
  };

  function halt() {
    clearTimeout(restartTimer);
    try {
      rec?.abort();
    } catch {}
    running = false;
  }

  return {
    start() {
      if (!SR) return state('unsupported');
      on = true;
      paused = false;
      fails = 0;
      document.addEventListener('pointerdown', onTap, true);
      begin();
    },
    stop() {
      on = false;
      document.removeEventListener('pointerdown', onTap, true);
      halt();
      state('off');
    },
    // while the app uses the microphone or speaks
    pause() {
      if (!on || paused) return;
      paused = true;
      // a waiting answer window starts over once listening resumes
      if (Date.now() < wakeUntil) answerNext = true;
      halt();
      state('paused');
    },
    resume() {
      if (!on || !paused) return;
      paused = false;
      begin();
    },
    expectReply(v) {
      replyUntil = v ? Date.now() + REPLY_MS : 0;
    },
    // the app asked something ("how much?"): the next phrase is the answer
    expectAnswer() {
      if (paused) answerNext = true;
      else wakeUntil = Date.now() + ANSWER_MS;
    },
  };
}
