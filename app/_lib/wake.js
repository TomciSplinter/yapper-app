// Hands-free: say "Yapper" and then the command ("Yapper, buy 0.1 SOL of
// this"), or "Yapper", a short pause, and the command. Uses the browser's
// built-in speech recognition (Chrome and Edge send the audio to their speech
// service). While a trade waits for confirmation, a plain "yes" or "no" works
// without the wake word.

const WAKE = /\b(?:[yj]app?(?:er|ers|a|ah)|yap+ (?:her|er))\b[\s,.!?:;-]*/i;
// a plain yes or no, and nothing else (a longer sentence needs "Yapper" first)
const REPLY = /^\s*(?:yes|yeah|yep|yup|sure|ok(?:ay)?|confirm(?:ed)?|do it|send it|go(?: ahead)?|igen|mehet|no|nope|nem|cancel|stop|never ?mind)(?:\s+(?:please|now|thanks|thank you))?[\s.!?,]*$/i;
const AFTER_WAKE_MS = 7000;
const REPLY_MS = 15000;

export function wakeSupported() {
  return typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

// handlers: { onWake(), onCommand(text), onState('listening' | 'paused' | 'off' | 'denied' | 'unsupported' | 'error') }
export function createWake({ lang = 'en-US', onWake, onCommand, onState }) {
  const SR = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
  let rec = null;
  let on = false; // the user switched it on
  let paused = false; // the app is recording or speaking
  let running = false;
  let restartTimer = null;
  let fails = 0;
  let wakeUntil = 0; // heard "Yapper" alone: the next phrase is the command
  let replyUntil = 0; // a yes/no is expected
  let armed = false;

  const state = (s) => onState?.(s);

  function handleFinal(text) {
    const t = String(text || '').trim();
    if (!t) return;
    const m = t.match(WAKE);
    if (m) {
      const after = t.slice(m.index + m[0].length).trim();
      armed = false;
      if (after.replace(/[^\p{L}\p{N}]/gu, '').length >= 2) {
        wakeUntil = 0;
        onCommand?.(after);
      } else {
        wakeUntil = Date.now() + AFTER_WAKE_MS;
        onWake?.();
      }
      return;
    }
    if (Date.now() < wakeUntil) {
      wakeUntil = 0;
      onCommand?.(t);
      return;
    }
    if (Date.now() < replyUntil && REPLY.test(t)) {
      replyUntil = 0;
      onCommand?.(t);
    }
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
        else if (!armed && WAKE.test(text)) {
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
      state('listening');
    } catch {
      running = false;
    }
  }

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
      begin();
    },
    stop() {
      on = false;
      halt();
      state('off');
    },
    // while the app uses the microphone or speaks
    pause() {
      if (!on || paused) return;
      paused = true;
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
  };
}
