// Built-in wallets.
//
// Keys are created or imported in the browser, encrypted with the user's
// password (PBKDF2-SHA256 with 600k rounds, then AES-256-GCM, each key bound
// to its address) and stored only in this browser's localStorage. They never
// reach any server.
//
// Unlocking derives a non-extractable AES key that stays in memory and is
// shared with other open Yapper tabs over a BroadcastChannel, so one unlock
// covers every tab until they're all closed or 12 hours pass. Only if the
// user ticks "stay unlocked" is that key also kept in IndexedDB, so it
// survives restarts for those 12 hours. A wallet's secret key is decrypted
// only for the moment it signs and then wiped (best effort: JavaScript can't
// guarantee every copy is gone). Exporting a key, sending SOL out and removing
// a wallet always ask for the password again.
//
// Wallet apps (Phantom, Solflare, Backpack) still work: the active wallet is
// either one of these built-in wallets or the connected wallet app.

import { useSyncExternalStore } from 'react';
import { Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js';
import { rpc, b64ToBytes, bytesToB64, getProvider } from './chain';

const VAULT_KEY = 'yapper:vault:v1';
const ACTIVE_KEY = 'yapper:active-wallet';
const REMEMBER_KEY = 'yapper:remember-unlock';
const LOCK_SIGNAL = 'yapper:vault-locked';
const UNLOCK_SIGNAL = 'yapper:vault-unlocked';
const CHECK_TEXT = 'yapper-vault-v1';
const ITERATIONS = 600000;
export const UNLOCK_HOURS = 12;
const UNLOCK_MS = UNLOCK_HOURS * 60 * 60 * 1000;
const UNLOCK_WAIT_MS = 2 * 60 * 1000;
export const MIN_PASSWORD = 8;
export const FEE_LAMPORTS = 5000;
export const RENT_MIN_LAMPORTS = 890880;
const enc = new TextEncoder();
const dec = new TextDecoder();

/* ---------- base58 ---------- */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function b58encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

export function b58decode(str) {
  let zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros++;
  const bytes = [];
  for (let i = zeros; i < str.length; i++) {
    const v = ALPHABET.indexOf(str[i]);
    if (v < 0) throw new Error('Invalid character');
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

export function isAddress(s) {
  try {
    return typeof s === 'string' && b58decode(s.trim()).length === 32;
  } catch {
    return false;
  }
}

// false for program-owned addresses (PDAs), where SOL can get stuck
export function isOnCurve(s) {
  try {
    return PublicKey.isOnCurve(new PublicKey(s.trim()).toBytes());
  } catch {
    return false;
  }
}

/* ---------- store ---------- */

const SERVER_STATE = {
  ready: false,
  hasVault: false,
  unlocked: false,
  unlockedUntil: 0,
  wallets: [],
  active: null, // { type: 'local', id } | { type: 'external' }
  external: null, // public key of the connected wallet app
  externalName: null,
  modal: null, // { view, ...details } while the wallet manager is open
};
let state = SERVER_STATE;
const listeners = new Set();

function set(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getState() {
  return state;
}

export function useWallets() {
  return useSyncExternalStore(subscribe, getState, () => SERVER_STATE);
}

// The public key of whatever wallet is active right now.
export function activePubkey(s = state) {
  if (s.active?.type === 'local') return s.wallets.find((w) => w.id === s.active.id)?.pubkey || null;
  if (s.active?.type === 'external') return s.external || null;
  return null;
}

export function activeWallet(s = state) {
  if (s.active?.type === 'local') {
    const w = s.wallets.find((x) => x.id === s.active.id);
    return w ? { type: 'local', id: w.id, name: w.name, pubkey: w.pubkey, backedUp: w.backedUp } : null;
  }
  if (s.active?.type === 'external' && s.external) return { type: 'external', name: s.externalName || 'Wallet app', pubkey: s.external };
  return null;
}

// Who signs for this address: 'local' (built-in), 'external' (wallet app) or null.
export function signerKind(pubkey, s = state) {
  const local = s.wallets.some((w) => w.pubkey === pubkey);
  const ext = !!pubkey && s.external === pubkey;
  if (local && ext) return s.active?.type === 'external' ? 'external' : 'local';
  return local ? 'local' : ext ? 'external' : null;
}

/* ---------- storage ---------- */

function rawVault() {
  try {
    return localStorage.getItem(VAULT_KEY);
  } catch {
    return null;
  }
}

function readVault() {
  const raw = rawVault();
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && v.v === 1 && v.kdf?.salt && v.check && Array.isArray(v.wallets) ? v : null;
  } catch {
    return null;
  }
}

function writeVault(v) {
  try {
    localStorage.setItem(VAULT_KEY, JSON.stringify(v));
  } catch {
    throw new Error('This browser blocked saving the wallet. Turn off private browsing and try again.');
  }
}

const publicInfo = (w) => ({ id: w.id, name: w.name, pubkey: w.pubkey, createdAt: w.createdAt, backedUp: w.backedUp !== false });

function readActive() {
  try {
    const a = JSON.parse(localStorage.getItem(ACTIVE_KEY) || 'null');
    if (a?.type === 'local' && typeof a.id === 'string') return { type: 'local', id: a.id };
    if (a?.type === 'external') return { type: 'external' };
  } catch {}
  return null;
}

function saveActive(active) {
  try {
    if (active) localStorage.setItem(ACTIVE_KEY, JSON.stringify(active));
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {}
}

function signal(key) {
  try {
    localStorage.setItem(key, String(Date.now()));
  } catch {}
}

function lastLockAt() {
  try {
    return Number(localStorage.getItem(LOCK_SIGNAL)) || 0;
  } catch {
    return 0;
  }
}

// "Stay unlocked for 12 hours" is opt-in.
export function rememberChoice() {
  try {
    return localStorage.getItem(REMEMBER_KEY) === '1';
  } catch {
    return false;
  }
}

function saveRememberChoice(on) {
  try {
    localStorage.setItem(REMEMBER_KEY, on ? '1' : '0');
  } catch {}
}

// Ask the browser not to clear our storage under pressure (Safari can
// otherwise drop it after a week without visits).
function keepStorage() {
  try {
    navigator.storage?.persist?.().catch(() => {});
  } catch {}
}

// A tiny IndexedDB store, used only for "stay unlocked".
let dbPromise = null;
function idb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open('yapper', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}
async function idbDo(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
const idbGet = (k) => idbDo('readonly', (s) => s.get(k)).catch(() => null);
const idbSet = (k, v) => idbDo('readwrite', (s) => s.put(v, k)).catch(() => null);
const idbDel = (k) => idbDo('readwrite', (s) => s.delete(k)).catch(() => null);

/* ---------- crypto ---------- */

function needCrypto() {
  if (!globalThis.crypto?.subtle) throw new Error('This browser cannot encrypt wallets here. Open Yapper over https in an up-to-date browser.');
}

async function deriveKey(password, saltB64, iterations) {
  needCrypto();
  const base = await crypto.subtle.importKey('raw', enc.encode(String(password).normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: b64ToBytes(saltB64), iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// each wallet's ciphertext is bound to its address
const walletAad = (pubkey) => enc.encode(`yapper-wallet:${pubkey}`);

async function encryptBytes(key, bytes, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const params = aad ? { name: 'AES-GCM', iv, additionalData: aad } : { name: 'AES-GCM', iv };
  const ct = new Uint8Array(await crypto.subtle.encrypt(params, key, bytes));
  return { iv: bytesToB64(iv), ct: bytesToB64(ct) };
}

async function decryptBytes(key, box, aad) {
  const iv = b64ToBytes(box.iv);
  const params = aad ? { name: 'AES-GCM', iv, additionalData: aad } : { name: 'AES-GCM', iv };
  return new Uint8Array(await crypto.subtle.decrypt(params, key, b64ToBytes(box.ct)));
}

async function keyOpensVault(key, v) {
  try {
    return dec.decode(await decryptBytes(key, v.check)) === CHECK_TEXT;
  } catch {
    return false;
  }
}

// Checks the password and returns the key it unlocks.
async function keyFromPassword(password, v = readVault()) {
  if (!v) throw new Error('There are no Yapper wallets on this device.');
  const key = await deriveKey(String(password || ''), v.kdf.salt, v.kdf.iterations);
  if (!(await keyOpensVault(key, v))) throw new Error('Wrong password. Try again.');
  return key;
}

/* ---------- lock and unlock ---------- */

let vaultKey = null;
let keySalt = null;
let unlockedAt = 0;
let lockTimer = 0;
let unlockWaiters = [];
let channel = null;

function setUnlocked(key, salt, until) {
  vaultKey = key;
  keySalt = salt;
  unlockedAt = Date.now();
  clearTimeout(lockTimer);
  lockTimer = setTimeout(expireHere, Math.max(1000, until - Date.now()));
  set({ unlocked: true, unlockedUntil: until });
  const waiters = unlockWaiters;
  unlockWaiters = [];
  waiters.forEach((w) => w.resolve());
}

// lock this tab only (another tab locked, or the vault changed)
function lockHere() {
  vaultKey = null;
  keySalt = null;
  clearTimeout(lockTimer);
  if (state.unlocked) set({ unlocked: false, unlockedUntil: 0 });
}

// this tab's unlock ran out; other tabs keep their own timers
async function expireHere() {
  lockHere();
  const s = await idbGet('session');
  if (s && !(s.expires > Date.now())) idbDel('session');
}

// Lock every tab now.
export function lock() {
  lockHere();
  idbDel('session');
  signal(LOCK_SIGNAL);
  try {
    channel?.postMessage({ type: 'lock' });
  } catch {}
}

// a lock from another tab that this one may have missed (sleep, back/forward cache)
function checkMissedLock() {
  if (vaultKey && lastLockAt() > unlockedAt) lockHere();
}

function shareKey() {
  if (!channel || !vaultKey) return;
  try {
    channel.postMessage({ type: 'key', key: vaultKey, salt: keySalt, until: state.unlockedUntil });
  } catch {}
}

async function acceptKey(key, salt, until) {
  const v = readVault();
  if (vaultKey || !v || !key || salt !== v.kdf.salt || !(until > Date.now())) return false;
  if (!(await keyOpensVault(key, v))) return false;
  setUnlocked(key, salt, until);
  return true;
}

function openChannel() {
  if (channel || typeof BroadcastChannel === 'undefined') return;
  try {
    channel = new BroadcastChannel('yapper-wallets');
  } catch {
    return;
  }
  channel.onmessage = (e) => {
    const m = e.data || {};
    if (m.type === 'need-key' && vaultKey && Date.now() < state.unlockedUntil) shareKey();
    else if (m.type === 'key') acceptKey(m.key, m.salt, m.until);
    else if (m.type === 'lock') lockHere();
  };
}

// Ask other open tabs for their unlock. Resolves true if this tab got it.
function askOtherTabs(ms = 250) {
  if (vaultKey) return Promise.resolve(true);
  if (!channel) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (ok) => {
      clearTimeout(timer);
      stop();
      resolve(ok);
    };
    const stop = subscribe(() => {
      if (vaultKey) done(true);
    });
    const timer = setTimeout(() => done(!!vaultKey), ms);
    try {
      channel.postMessage({ type: 'need-key' });
    } catch {
      done(false);
    }
  });
}

async function startSession(key, salt, remember) {
  const until = Date.now() + UNLOCK_MS;
  saveRememberChoice(remember);
  if (remember) await idbSet('session', { key, salt, expires: until });
  else await idbDel('session');
  setUnlocked(key, salt, until);
  shareKey();
  if (remember) signal(UNLOCK_SIGNAL);
}

// Picks up a "stay unlocked" session from IndexedDB.
async function loadSession() {
  const v = readVault();
  if (!v) return false;
  const s = await idbGet('session');
  if (!s) return false;
  if (s.key && s.salt === v.kdf.salt && s.expires > Date.now() && (await keyOpensVault(s.key, v))) {
    if (!vaultKey) setUnlocked(s.key, s.salt, s.expires);
    return true;
  }
  idbDel('session');
  return false;
}

export async function setupVault(password, remember) {
  if (readVault()) throw new Error('Wallets are already set up on this device. Unlock them instead.');
  if (String(password || '').length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters.`);
  // never overwrite data we couldn't read: set it aside instead
  const unreadable = rawVault();
  if (unreadable) {
    try {
      localStorage.setItem(`${VAULT_KEY}:unreadable:${Date.now()}`, unreadable);
    } catch {
      throw new Error('This browser has wallet data Yapper could not read, and no room to keep a copy. Nothing was changed.');
    }
  }
  const salt = bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
  const key = await deriveKey(password, salt, ITERATIONS);
  const check = await encryptBytes(key, enc.encode(CHECK_TEXT));
  writeVault({ v: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt }, check, wallets: [] });
  set({ hasVault: true });
  keepStorage();
  await startSession(key, salt, remember);
}

export async function unlock(password, remember) {
  const v = readVault();
  const key = await keyFromPassword(password, v);
  await startSession(key, v.kdf.salt, remember);
}

// Resolves once the wallets are unlocked, asking for the password if needed.
// A request nobody answers within two minutes is cancelled, so a forgotten
// prompt can't run an old trade later.
export async function ensureUnlocked() {
  checkMissedLock();
  if (vaultKey && Date.now() < state.unlockedUntil) return;
  if (vaultKey) lockHere();
  if (await loadSession()) return;
  if (await askOtherTabs()) return;
  if (!readVault()) throw new Error('There are no Yapper wallets on this device.');
  await new Promise((resolve, reject) => {
    const w = {
      resolve: () => {
        clearTimeout(w.timer);
        resolve();
      },
      reject: (e) => {
        clearTimeout(w.timer);
        reject(e);
      },
    };
    w.timer = setTimeout(() => {
      unlockWaiters = unlockWaiters.filter((x) => x !== w);
      reject(new Error('Unlock timed out, so the trade was cancelled'));
      if (!unlockWaiters.length && state.modal?.view === 'unlock' && state.modal.reason === 'sign') set({ modal: null });
    }, UNLOCK_WAIT_MS);
    unlockWaiters.push(w);
    set({ modal: { view: 'unlock', reason: 'sign' } });
  });
}

function cancelUnlockRequests() {
  const waiters = unlockWaiters;
  unlockWaiters = [];
  waiters.forEach((w) => w.reject(new Error('Unlock cancelled')));
}

/* ---------- start-up and other tabs ---------- */

let initStarted = false;

function syncFromStorage() {
  const v = readVault();
  const wallets = v ? v.wallets.map(publicInfo) : [];
  let active = readActive();
  if (active?.type === 'local' && !wallets.some((w) => w.id === active.id)) active = wallets[0] ? { type: 'local', id: wallets[0].id } : null;
  set({ hasVault: !!v, wallets, active });
  // the vault was reset or replaced in another tab
  if (vaultKey && (!v || v.kdf.salt !== keySalt)) lockHere();
}

export async function initWallets() {
  if (initStarted || typeof window === 'undefined') return;
  initStarted = true;
  syncFromStorage();
  set({ ready: true });
  openChannel();
  window.addEventListener('storage', (e) => {
    if (e.key === null || e.key === VAULT_KEY || e.key === ACTIVE_KEY) syncFromStorage();
    if (e.key === LOCK_SIGNAL) lockHere();
    if (e.key === UNLOCK_SIGNAL && !vaultKey) loadSession();
  });
  // coming back from sleep or the back/forward cache
  const recheck = () => {
    syncFromStorage();
    checkMissedLock();
    if (vaultKey && Date.now() >= state.unlockedUntil) expireHere();
  };
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) recheck();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) recheck();
  });
  if (readVault() && !(await loadSession())) await askOtherTabs();
}

/* ---------- wallets ---------- */

function newId() {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return 'w_' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function defaultName(wallets) {
  for (let n = wallets.length + 1; ; n++) {
    const name = `Wallet ${n}`;
    if (!wallets.some((w) => w.name === name)) return name;
  }
}

function cleanName(name) {
  return String(name || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32);
}

async function addSecret(name, secret, backedUp) {
  if (!readVault()) throw new Error('Create a password first.');
  const key = vaultKey;
  const salt = keySalt;
  if (!key) throw new Error('Unlock your wallets first.');
  const pubkey = Keypair.fromSecretKey(secret).publicKey.toBase58();
  if (readVault().wallets.some((w) => w.pubkey === pubkey)) throw new Error('This wallet is already in your list.');
  const box = await encryptBytes(key, secret, walletAad(pubkey));
  // read again after the await: another tab may have changed the vault meanwhile
  const v = readVault();
  if (!v || v.kdf.salt !== salt) throw new Error('Your wallets changed in another tab. Reload this page and try again.');
  if (v.wallets.some((w) => w.pubkey === pubkey)) throw new Error('This wallet is already in your list.');
  const w = { id: newId(), name: cleanName(name) || defaultName(v.wallets), pubkey, iv: box.iv, ct: box.ct, createdAt: Date.now(), backedUp };
  v.wallets.push(w);
  writeVault(v);
  keepStorage();
  set({ wallets: v.wallets.map(publicInfo) });
  return publicInfo(w);
}

// Returns the new wallet and its private key, shown once so it can be backed up.
export async function createWallet(name) {
  const secret = Uint8Array.from(Keypair.generate().secretKey);
  try {
    const wallet = await addSecret(name, secret, false);
    return { wallet, privateKey: b58encode(secret) };
  } finally {
    secret.fill(0);
  }
}

export function markBackedUp(id) {
  const v = readVault();
  const w = v?.wallets.find((x) => x.id === id);
  if (!w || w.backedUp !== false) return;
  w.backedUp = true;
  writeVault(v);
  set({ wallets: v.wallets.map(publicInfo) });
}

// Accepts a base58 private key (what Phantom, Solflare and Backpack export)
// or a JSON byte array (Solana CLI, 64 bytes or a 32-byte seed).
export function parsePrivateKey(input) {
  const s = String(input || '')
    .trim()
    .replace(/^["']|["']$/g, '');
  if (!s) throw new Error('Paste a private key.');
  if (s.split(/\s+/).length >= 12) {
    throw new Error('That looks like a recovery phrase. Paste the private key instead. In Phantom: Settings, your account, Show private key.');
  }
  const isArray = s.startsWith('[');
  let bytes;
  try {
    bytes = isArray ? Uint8Array.from(JSON.parse(s)) : b58decode(s);
  } catch {
    throw new Error("That isn't a valid Solana private key.");
  }
  if (bytes.length === 32) {
    // 32 base58 bytes is a wallet address, which anyone can see. Never treat it as a key.
    if (!isArray) throw new Error("That's a wallet address, not a private key. A private key is about twice as long.");
    const seed = bytes;
    bytes = Uint8Array.from(Keypair.fromSeed(seed).secretKey);
    seed.fill(0);
  }
  if (bytes.length !== 64) throw new Error("That isn't a valid Solana private key.");
  try {
    Keypair.fromSecretKey(bytes);
  } catch {
    throw new Error("That private key doesn't match a valid Solana wallet.");
  }
  return bytes;
}

export async function importWallet(name, input) {
  const secret = parsePrivateKey(input);
  try {
    return await addSecret(name, secret, true);
  } finally {
    secret.fill(0);
  }
}

export function renameWallet(id, name) {
  const v = readVault();
  const w = v?.wallets.find((x) => x.id === id);
  const n = cleanName(name);
  if (!w || !n) return;
  w.name = n;
  writeVault(v);
  set({ wallets: v.wallets.map(publicInfo) });
}

function fallbackActive(wallets) {
  if (wallets[0]) return { type: 'local', id: wallets[0].id };
  if (state.external) return { type: 'external' };
  return null;
}

export async function removeWallet(id, password) {
  await keyFromPassword(password);
  const v = readVault();
  if (!v) return;
  v.wallets = v.wallets.filter((w) => w.id !== id);
  writeVault(v);
  let active = state.active;
  if (active?.type === 'local' && active.id === id) active = fallbackActive(v.wallets);
  saveActive(active);
  set({ wallets: v.wallets.map(publicInfo), active });
}

// Forgot password: delete every built-in wallet on this device.
export function resetVault() {
  cancelUnlockRequests();
  lock();
  try {
    localStorage.removeItem(VAULT_KEY);
  } catch {}
  const active = state.active?.type === 'local' ? fallbackActive([]) : state.active;
  saveActive(active);
  set({ hasVault: false, wallets: [], active });
}

// Asks for the password again before revealing a key.
export async function exportPrivateKey(id, password) {
  const key = await keyFromPassword(password);
  const out = await withSecret(key, id, (kp, secret) => b58encode(secret));
  markBackedUp(id);
  return out;
}

export function setActive(active) {
  saveActive(active);
  set({ active });
}

export function openWalletModal(view = 'home', details = {}) {
  set({ modal: { view, ...details } });
}

export function closeWalletModal() {
  cancelUnlockRequests();
  set({ modal: null });
}

/* ---------- wallet apps ---------- */

export function externalName(p) {
  if (!p) return 'Wallet app';
  if (p.isPhantom) return 'Phantom';
  if (p.isSolflare) return 'Solflare';
  if (p.isBackpack || p === globalThis.backpack?.solana) return 'Backpack';
  return 'Wallet app';
}

export function setExternal(pubkey, name) {
  const patch = { external: pubkey || null, externalName: name || state.externalName || 'Wallet app' };
  // the wallet app went away: fall back to a Yapper wallet if there is one
  if (!pubkey && state.active?.type === 'external') {
    patch.active = state.wallets[0] ? { type: 'local', id: state.wallets[0].id } : null;
    saveActive(patch.active);
  }
  set(patch);
}

// Returns the address, or null when the page is reopening inside the wallet's browser.
export async function connectExternal() {
  const p = getProvider();
  if (!p) {
    if (/Android|iPhone|iPad/i.test(navigator.userAgent)) {
      const url = encodeURIComponent(window.location.href);
      window.location.href = `https://phantom.app/ul/browse/${url}?ref=${encodeURIComponent(window.location.origin)}`;
      return null;
    }
    window.open('https://phantom.app/download', '_blank', 'noopener');
    throw new Error('No wallet app found. Install Phantom, Solflare or Backpack, then reload this page.');
  }
  await p.connect();
  const pk = p.publicKey?.toString();
  if (!pk) throw new Error('The wallet app did not share an address.');
  setExternal(pk, externalName(p));
  setActive({ type: 'external' });
  return pk;
}

export async function disconnectExternal() {
  try {
    await getProvider()?.disconnect();
  } catch {}
  setExternal(null);
}

/* ---------- signing ---------- */

// Decrypts one wallet's key for the length of fn, then wipes our copy.
async function withSecret(key, id, fn) {
  if (!key) throw new Error('Unlock cancelled');
  const w = readVault()?.wallets.find((x) => x.id === id);
  if (!w) throw new Error('Wallet not found.');
  let secret;
  try {
    secret = await decryptBytes(key, w, walletAad(w.pubkey));
  } catch {
    throw new Error("Couldn't open this wallet. Reload the page and unlock again.");
  }
  try {
    const kp = Keypair.fromSecretKey(secret);
    if (kp.publicKey.toBase58() !== w.pubkey) throw new Error("This wallet's key doesn't match its address.");
    return await fn(kp, secret);
  } finally {
    secret.fill(0);
  }
}

// Signs with the wallet that owns this address: built-in wallets sign here,
// a wallet app shows its approval popup. Pass expectKind to refuse signing if
// the wallet behind the address changed since the transaction was checked.
export async function signAs(pubkey, tx, expectKind) {
  const kind = signerKind(pubkey);
  if (expectKind && kind !== expectKind) throw new Error('Your active wallet changed during the trade. Try again.');
  if (kind === 'local') {
    const w = state.wallets.find((x) => x.pubkey === pubkey);
    await ensureUnlocked();
    await withSecret(vaultKey, w.id, (kp) => {
      if (tx instanceof VersionedTransaction) tx.sign([kp]);
      else tx.sign(kp);
    });
    return tx;
  }
  if (kind === 'external') {
    const p = getProvider();
    if (!p) throw new Error('Your wallet app is not available. Reload the page and try again.');
    return p.signTransaction(tx);
  }
  throw new Error('That wallet is no longer connected.');
}

// Sends SOL out of a built-in wallet. Always asks for the password.
export async function sendSol(id, to, lamports, password) {
  const w = state.wallets.find((x) => x.id === id);
  if (!w) throw new Error('Wallet not found.');
  const dest = String(to || '').trim();
  if (!isAddress(dest)) throw new Error("That isn't a valid Solana address.");
  if (!(Number.isSafeInteger(lamports) && lamports > 0)) throw new Error('Enter an amount.');
  const key = await keyFromPassword(password);
  const from = new PublicKey(w.pubkey);
  const bh = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  if (!bh?.value?.blockhash) throw new Error('Could not reach Solana. Try again.');
  const tx = new Transaction();
  tx.feePayer = from;
  tx.recentBlockhash = bh.value.blockhash;
  tx.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(dest), lamports }));
  await withSecret(key, id, (kp) => tx.sign(kp));
  return rpc('sendTransaction', [bytesToB64(tx.serialize()), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
}

// Who owns an address, to stop SOL going to token or program accounts.
// Returns 'new' (never used), 'wallet' (a normal account) or 'other'.
export async function addressKind(addr) {
  const r = await rpc('getAccountInfo', [addr, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' }]);
  const a = r?.value;
  if (!a) return 'new';
  return a.owner === '11111111111111111111111111111111' && !a.executable ? 'wallet' : 'other';
}

// SOL balances (in lamports) for a list of addresses, in one request.
export async function loadBalances(pubkeys) {
  const list = [...new Set(pubkeys.filter(Boolean))];
  const out = {};
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    const r = await rpc('getMultipleAccounts', [chunk, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' }]);
    chunk.forEach((pk, j) => {
      out[pk] = Number(r?.value?.[j]?.lamports) || 0;
    });
  }
  return out;
}
