// The orb's settings and a small message bus, so orders, alerts, callouts
// and finished trades can make the orb speak from anywhere in the app.

import { useSyncExternalStore } from 'react';

/* ---------- settings ---------- */

const PREFS_KEY = 'yapper:voice-prefs:v1';
const MUTE_KEY = 'yapper:voice-muted';
export const DEFAULT_PREFS = {
  muted: false, // no spoken replies at all
  natural: true, // natural voice (OpenAI) instead of the browser's voice
  wake: false, // hands-free: say "Yapper"
  callouts: false, // speak up about your positions on its own
  speakTrades: true, // say what each finished trade did
};

let prefs = { ...DEFAULT_PREFS };
let prefsLoaded = false;
const prefListeners = new Set();

function loadPrefs() {
  if (prefsLoaded || typeof window === 'undefined') return;
  prefsLoaded = true;
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    prefs = { ...DEFAULT_PREFS, ...(saved && typeof saved === 'object' ? saved : {}) };
    // the older on/off switch for voice replies
    if (localStorage.getItem(MUTE_KEY) === '1' && saved?.muted === undefined) prefs.muted = true;
  } catch {}
  window.addEventListener('storage', (e) => {
    if (e.key !== PREFS_KEY) return;
    try {
      prefs = { ...DEFAULT_PREFS, ...JSON.parse(e.newValue || '{}') };
      prefListeners.forEach((fn) => fn());
    } catch {}
  });
}

export function getPrefs() {
  loadPrefs();
  return prefs;
}

export function setPrefs(patch) {
  loadPrefs();
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    localStorage.setItem(MUTE_KEY, prefs.muted ? '1' : '0');
  } catch {}
  prefListeners.forEach((fn) => fn());
}

function subscribePrefs(fn) {
  loadPrefs();
  prefListeners.add(fn);
  return () => prefListeners.delete(fn);
}

export function useVoicePrefs() {
  return useSyncExternalStore(subscribePrefs, getPrefs, () => DEFAULT_PREFS);
}

/* ---------- messages for the orb ---------- */

// { text, lang?, kind: 'order' | 'alert' | 'callout' | 'trade' | 'info', mint?, symbol?, toast? }
const listeners = new Set();
const backlog = []; // messages sent before the orb was on screen

export function announce(msg) {
  if (!msg?.text) return;
  const m = { kind: 'info', lang: 'en', at: Date.now(), ...msg };
  if (!listeners.size) {
    backlog.push(m);
    if (backlog.length > 10) backlog.shift();
    return;
  }
  listeners.forEach((fn) => fn(m));
}

export function onAnnounce(fn) {
  listeners.add(fn);
  while (backlog.length) fn(backlog.shift());
  return () => listeners.delete(fn);
}

/* ---------- app settings changed by voice ---------- */

// Trade panel and quick buy listen for this to pick up new values.
export const SETTINGS_EVENT = 'yapper:settings';

export function settingsChanged(detail) {
  try {
    window.dispatchEvent(new CustomEvent(SETTINGS_EVENT, { detail }));
  } catch {}
}
