'use client';

// Wallet manager: create, import, switch, deposit, withdraw, export and
// remove built-in wallets, or connect a wallet app. Opened from the top bar,
// the trade panel, voice, and whenever a built-in wallet needs unlocking.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useWallets,
  openWalletModal,
  closeWalletModal,
  setupVault,
  unlock,
  lock,
  createWallet,
  importWallet,
  renameWallet,
  removeWallet,
  resetVault,
  exportPrivateKey,
  setActive,
  connectExternal,
  disconnectExternal,
  externalName,
  sendSol,
  loadBalances,
  rememberChoice,
  markBackedUp,
  addressKind,
  isAddress,
  isOnCurve,
  MIN_PASSWORD,
  UNLOCK_HOURS,
  FEE_LAMPORTS,
  RENT_MIN_LAMPORTS,
} from '../_lib/wallets';
import { getProvider, waitForConfirm } from '../_lib/chain';
import { short, sol as fmtSol, usd } from '../_lib/format';
import { Icon } from './Icons';

const WALLET_VIEWS = ['backup', 'deposit', 'withdraw', 'export', 'rename', 'remove'];

function errText(e) {
  const s = String(e?.message || e || 'Something went wrong. Try again.');
  if (/insufficient lamports|insufficient funds|prior credit/i.test(s)) return 'Not enough SOL for this transfer and its fee.';
  return s.length > 220 ? `${s.slice(0, 220)}…` : s;
}

// "1.25" -> 1250000000 lamports, without floating point drift
function toLamports(s) {
  const t = String(s || '').trim().replace(',', '.');
  if (!/^\d*\.?\d*$/.test(t) || t === '' || t === '.') return 0;
  const [i, f = ''] = t.split('.');
  return Number(i || '0') * 1e9 + Number(`${f}000000000`.slice(0, 9));
}

const fmtLamports = (l) => (l / 1e9).toFixed(9).replace(/\.?0+$/, '') || '0';
const initial = (name) => String(name || '?').trim().charAt(0).toUpperCase() || '?';

async function createAndBackup() {
  const { wallet, privateKey } = await createWallet();
  setActive({ type: 'local', id: wallet.id });
  openWalletModal('backup', { id: wallet.id, secret: privateKey });
}

// New wallet: set a password first, unlock, or create right away.
function startCreate(ws) {
  if (!ws.hasVault) return openWalletModal('setup', { next: 'create' });
  if (!ws.unlocked) return openWalletModal('unlock', { next: 'create' });
  return createAndBackup();
}

function startImport(ws) {
  if (!ws.hasVault) return openWalletModal('setup', { next: 'import' });
  if (!ws.unlocked) return openWalletModal('unlock', { next: 'import' });
  return openWalletModal('import');
}

function useCopy() {
  const [copied, setCopied] = useState(null);
  const copy = async (text, tag) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      setTimeout(() => setCopied((c) => (c === tag ? null : c)), 1500);
    } catch {}
  };
  return [copied, copy];
}

// last known balances, so switching views doesn't flash empty values
const balanceCache = {};

// SOL balances in lamports, refreshed while the view is open
function useBalances(pubkeys, everyMs = 15000) {
  const key = pubkeys.filter(Boolean).join(',');
  const [bal, setBal] = useState(() => {
    const out = {};
    for (const pk of key ? key.split(',') : []) if (pk in balanceCache) out[pk] = balanceCache[pk];
    return out;
  });
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const load = async () => {
      try {
        const b = await loadBalances(key.split(','));
        Object.assign(balanceCache, b);
        if (alive) setBal((prev) => ({ ...prev, ...b }));
      } catch {}
    };
    load();
    const t = setInterval(() => {
      if (!document.hidden) load();
    }, everyMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [key, everyMs]);
  return bal;
}

/* ---------- shared pieces ---------- */

function Head({ title, onBack, noClose, children }) {
  return (
    <div className="wmd-head">
      {onBack && (
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Back">
          <Icon name="chevronLeft" size={16} />
        </button>
      )}
      <h2 className="wmd-title" id="wmd-title">
        {title}
      </h2>
      <div className="wmd-head-tools">
        {children}
        {!noClose && (
          <button type="button" className="icon-btn" onClick={closeWalletModal} aria-label="Close">
            <Icon name="close" size={15} />
          </button>
        )}
      </div>
    </div>
  );
}

// lets password managers file the password under a name
function PwUser() {
  return <input className="sr-only" type="text" name="username" autoComplete="username" value="Yapper wallets" readOnly tabIndex={-1} aria-hidden="true" />;
}

function PasswordField({ id, label, value, onChange, autoComplete = 'current-password', autoFocus }) {
  const [show, setShow] = useState(false);
  return (
    <div className="wmd-field">
      <label htmlFor={id}>{label}</label>
      <div className="wmd-input">
        <input
          id={id}
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={autoFocus}
        />
        <button type="button" className="icon-btn" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>
          <Icon name={show ? 'eyeOff' : 'eye'} size={15} />
        </button>
      </div>
    </div>
  );
}

function TextField({ id, label, value, onChange, placeholder, maxLength, autoFocus, mono }) {
  return (
    <div className="wmd-field">
      <label htmlFor={id}>{label}</label>
      <div className="wmd-input">
        <input
          id={id}
          className={mono ? 'mono' : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          maxLength={maxLength}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={autoFocus}
        />
      </div>
    </div>
  );
}

function Remember({ value, onChange }) {
  return (
    <label className="wmd-check">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span>Stay unlocked for {UNLOCK_HOURS} hours, even after closing Yapper</span>
    </label>
  );
}

function ErrorText({ error }) {
  return error ? (
    <p className="wmd-error" role="alert">
      {error}
    </p>
  ) : null;
}

function Submit({ busy, busyLabel, children, disabled, danger }) {
  return (
    <button type="submit" className={`btn ${danger ? 'btn-danger' : 'btn-primary'} btn-block`} disabled={busy || disabled}>
      {busy && <span className="spinner" aria-hidden="true" />}
      {busy ? busyLabel : children}
    </button>
  );
}

function Foot({ children }) {
  return (
    <p className="wmd-foot">
      <Icon name="shield" size={14} />
      <span>{children}</span>
    </p>
  );
}

function Balance({ lamports, solPrice }) {
  const s = lamports === undefined ? null : lamports / 1e9;
  return (
    <span className="wl-bal">
      <b>
        {s === null ? '—' : fmtSol(s)} <span>SOL</span>
      </b>
      {s !== null && solPrice ? <span>{usd(s * solPrice)}</span> : null}
    </span>
  );
}

/* ---------- views ---------- */

function StartView({ ws }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const app = getProvider();
  const appName = app ? externalName(app) : null;

  const run = (fn) => async () => {
    setError('');
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(/reject|denied|cancel/i.test(e?.message || '') ? 'The wallet app declined the connection.' : errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Head title="Set up a wallet" />
      <p className="wmd-lead">Trade straight from Yapper. Pick how you want to hold your SOL.</p>
      <div className="wmd-options">
        <button type="button" className="wmd-option primary" onClick={run(() => startCreate(ws))} disabled={busy} autoFocus>
          <span className="wmd-option-icon">
            <Icon name="bolt" size={18} />
          </span>
          <span className="wmd-option-text">
            <b>Create a Yapper wallet</b>
            <span>A new Solana wallet in this browser. Trades go through instantly, no popups.</span>
          </span>
        </button>
        <button type="button" className="wmd-option" onClick={run(() => startImport(ws))} disabled={busy}>
          <span className="wmd-option-icon">
            <Icon name="key" size={18} />
          </span>
          <span className="wmd-option-text">
            <b>Import a private key</b>
            <span>Use a wallet you already have, like your Phantom account.</span>
          </span>
        </button>
        <button
          type="button"
          className="wmd-option"
          onClick={run(async () => {
            if (await connectExternal()) closeWalletModal();
          })}
          disabled={busy}
        >
          <span className="wmd-option-icon">
            <Icon name="phone" size={18} />
          </span>
          <span className="wmd-option-text">
            <b>{appName ? `Connect ${appName}` : 'Connect a wallet app'}</b>
            <span>Phantom, Solflare or Backpack. You approve each trade in the app.</span>
          </span>
        </button>
      </div>
      <ErrorText error={error} />
      <Foot>Yapper wallets are encrypted with your password and stored only in this browser. Our servers never see your keys.</Foot>
    </>
  );
}

function HomeView({ ws, solPrice, toast }) {
  const [open, setOpen] = useState(() => (ws.active?.type === 'local' ? ws.active.id : ws.active?.type === 'external' ? 'ext' : null));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, copy] = useCopy();
  const bal = useBalances([...ws.wallets.map((w) => w.pubkey), ws.external]);
  const app = getProvider();
  const appName = ws.external ? ws.externalName || 'Wallet app' : app ? externalName(app) : null;
  const extActive = ws.active?.type === 'external' && !!ws.external;

  const run = (fn) => async () => {
    setError('');
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(/reject|denied|cancel/i.test(e?.message || '') ? 'The wallet app declined the connection.' : errText(e));
    } finally {
      setBusy(false);
    }
  };

  const use = (active, name) => {
    setActive(active);
    toast?.show({ kind: 'success', title: `Using ${name}`, autoClose: 2500 });
  };

  return (
    <>
      <Head title="Wallets">
        {ws.hasVault &&
          (ws.unlocked ? (
            <button type="button" className="btn btn-xs btn-ghost" onClick={lock} title="Lock your Yapper wallets on this device">
              <Icon name="lock" size={13} />
              Lock
            </button>
          ) : (
            <button type="button" className="btn btn-xs btn-ghost" onClick={() => openWalletModal('unlock', { next: 'home' })}>
              <Icon name="unlock" size={13} />
              Unlock
            </button>
          ))}
      </Head>

      <ul className="wl" aria-label="Your wallets">
        {ws.wallets.map((w) => {
          const isActive = ws.active?.type === 'local' && ws.active.id === w.id;
          const isOpen = open === w.id;
          return (
            <li key={w.id} className={`wl-item${isActive ? ' active' : ''}`}>
              <button type="button" className="wl-row" onClick={() => setOpen(isOpen ? null : w.id)} aria-expanded={isOpen}>
                <span className="wl-av" aria-hidden="true">
                  {initial(w.name)}
                </span>
                <span className="wl-main">
                  <span className="wl-name">
                    <span className="wl-name-text">{w.name}</span>
                    {isActive && <span className="chip chip-sm chip-on">Active</span>}
                    {!w.backedUp && <span className="chip chip-sm chip-warn">Not backed up</span>}
                  </span>
                  <span className="wl-sub mono">{short(w.pubkey, 4)}</span>
                </span>
                <Balance lamports={bal[w.pubkey]} solPrice={solPrice} />
              </button>
              {isOpen && (
                <div className="wl-actions">
                  {!isActive && (
                    <button type="button" className="btn btn-xs btn-primary" onClick={() => use({ type: 'local', id: w.id }, w.name)}>
                      Use this wallet
                    </button>
                  )}
                  <button type="button" className="btn btn-xs btn-ghost" onClick={() => openWalletModal('deposit', { id: w.id })}>
                    <Icon name="deposit" size={13} />
                    Deposit
                  </button>
                  <button type="button" className="btn btn-xs btn-ghost" onClick={() => openWalletModal('withdraw', { id: w.id })}>
                    <Icon name="withdraw" size={13} />
                    Withdraw
                  </button>
                  <button type="button" className="btn btn-xs btn-ghost" onClick={() => copy(w.pubkey, w.id)}>
                    <Icon name={copied === w.id ? 'check' : 'copy'} size={13} />
                    {copied === w.id ? 'Copied' : 'Copy address'}
                  </button>
                  <button
                    type="button"
                    className={`btn btn-xs btn-ghost${w.backedUp ? '' : ' wl-warn'}`}
                    onClick={() => openWalletModal('export', { id: w.id })}
                  >
                    <Icon name="key" size={13} />
                    {w.backedUp ? 'Export key' : 'Back up key'}
                  </button>
                  <button type="button" className="btn btn-xs btn-ghost" onClick={() => openWalletModal('rename', { id: w.id })}>
                    <Icon name="pencil" size={13} />
                    Rename
                  </button>
                  <button type="button" className="btn btn-xs btn-ghost wl-danger" onClick={() => openWalletModal('remove', { id: w.id })}>
                    <Icon name="trash" size={13} />
                    Remove
                  </button>
                </div>
              )}
            </li>
          );
        })}

        <li className={`wl-item${extActive ? ' active' : ''}`}>
          <button
            type="button"
            className="wl-row"
            onClick={ws.external ? () => setOpen(open === 'ext' ? null : 'ext') : run(async () => connectExternal())}
            aria-expanded={ws.external ? open === 'ext' : undefined}
            disabled={busy}
          >
            <span className="wl-av wl-av-app" aria-hidden="true">
              <Icon name="phone" size={15} />
            </span>
            <span className="wl-main">
              <span className="wl-name">
                <span className="wl-name-text">{appName || 'Wallet app'}</span>
                {extActive && <span className="chip chip-sm chip-on">Active</span>}
              </span>
              <span className={`wl-sub${ws.external ? ' mono' : ''}`}>{ws.external ? short(ws.external, 4) : 'Phantom, Solflare or Backpack'}</span>
            </span>
            {ws.external ? <Balance lamports={bal[ws.external]} solPrice={solPrice} /> : <span className="wl-connect">Connect</span>}
          </button>
          {ws.external && open === 'ext' && (
            <div className="wl-actions">
              {!extActive && (
                <button type="button" className="btn btn-xs btn-primary" onClick={() => use({ type: 'external' }, appName || 'your wallet app')}>
                  Use this wallet
                </button>
              )}
              <button type="button" className="btn btn-xs btn-ghost" onClick={() => copy(ws.external, 'ext')}>
                <Icon name={copied === 'ext' ? 'check' : 'copy'} size={13} />
                {copied === 'ext' ? 'Copied' : 'Copy address'}
              </button>
              <button type="button" className="btn btn-xs btn-ghost" onClick={() => disconnectExternal()}>
                <Icon name="logout" size={13} />
                Disconnect
              </button>
            </div>
          )}
        </li>
      </ul>

      <ErrorText error={error} />
      <div className="wmd-row2">
        <button type="button" className="btn btn-ghost" onClick={run(() => startCreate(ws))} disabled={busy}>
          <Icon name="plus" size={15} />
          New wallet
        </button>
        <button type="button" className="btn btn-ghost" onClick={run(() => startImport(ws))} disabled={busy}>
          <Icon name="key" size={15} />
          Import key
        </button>
      </div>
      <Foot>Keys are encrypted with your password and stored only in this browser. Keep a backup of each private key: if this browser's data is cleared, only your backups can restore them.</Foot>
    </>
  );
}

function SetupView({ m }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [remember, setRemember] = useState(rememberChoice);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError('');
    if (pw.length < MIN_PASSWORD) return setError(`Use at least ${MIN_PASSWORD} characters.`);
    if (pw !== pw2) return setError("The passwords don't match.");
    setBusy(true);
    try {
      await setupVault(pw, remember);
      if (m.next === 'import') openWalletModal('import');
      else await createAndBackup();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  };

  return (
    <>
      <Head title="Create a password" onBack={() => openWalletModal('home')} />
      <p className="wmd-lead">It locks your Yapper wallets on this device. There is no way to reset it, so save it in your password manager.</p>
      <form className="wmd-form" onSubmit={submit}>
        <PwUser />
        <PasswordField id="wmd-pw" label="Password" value={pw} onChange={setPw} autoComplete="new-password" autoFocus />
        <PasswordField id="wmd-pw2" label="Repeat password" value={pw2} onChange={setPw2} autoComplete="new-password" />
        <Remember value={remember} onChange={setRemember} />
        <ErrorText error={error} />
        <Submit busy={busy} busyLabel="Encrypting…">
          {m.next === 'import' ? 'Continue' : 'Create wallet'}
        </Submit>
      </form>
    </>
  );
}

function UnlockView({ m }) {
  const [pw, setPw] = useState('');
  const [remember, setRemember] = useState(rememberChoice);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const signing = m.reason === 'sign';

  const submit = async (e) => {
    e.preventDefault();
    if (busy || !pw) return;
    setError('');
    setBusy(true);
    try {
      await unlock(pw, remember);
      setPw('');
      if (signing) return closeWalletModal();
      if (m.next === 'create') return await createAndBackup();
      if (m.next === 'import') return openWalletModal('import');
      openWalletModal('home');
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  };

  return (
    <>
      <Head title="Unlock wallets" onBack={signing ? null : () => openWalletModal('home')} />
      <p className="wmd-lead">{signing ? 'Enter your password to sign this trade.' : 'Enter your password to use your Yapper wallets.'}</p>
      <form className="wmd-form" onSubmit={submit}>
        <PwUser />
        <PasswordField id="wmd-unlock" label="Password" value={pw} onChange={setPw} autoFocus />
        <Remember value={remember} onChange={setRemember} />
        <ErrorText error={error} />
        <Submit busy={busy} busyLabel="Unlocking…" disabled={!pw}>
          Unlock
        </Submit>
      </form>
      <button type="button" className="wmd-link" onClick={() => openWalletModal('reset', { back: { reason: m.reason, next: m.next } })}>
        Forgot password?
      </button>
    </>
  );
}

function BackupView({ ws, m, holdOpen }) {
  const w = ws.wallets.find((x) => x.id === m.id);
  const [revealed, setRevealed] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, copy] = useCopy();

  // Escape and clicks outside don't close this screen
  useEffect(() => {
    holdOpen(true);
    return () => holdOpen(false);
  }, [holdOpen]);

  return (
    <>
      <Head title="Save your private key" noClose />
      <p className="wmd-lead">
        {w.name} is ready. This key is the only way to restore it if this browser's data is cleared. Keep it somewhere safe and never share it.
      </p>
      <div className={`wmd-secret${revealed ? '' : ' hidden'}`}>
        <code>{m.secret}</code>
        {!revealed && (
          <button type="button" className="wmd-reveal" onClick={() => setRevealed(true)} autoFocus>
            <Icon name="eye" size={15} />
            Show private key
          </button>
        )}
      </div>
      <button type="button" className="btn btn-ghost btn-block" onClick={() => copy(m.secret, 'key')}>
        <Icon name={copied ? 'check' : 'copy'} size={15} />
        {copied ? 'Copied' : 'Copy private key'}
      </button>
      <label className="wmd-check">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>I saved my private key somewhere safe</span>
      </label>
      <button
        type="button"
        className="btn btn-primary btn-block"
        disabled={!saved}
        onClick={() => {
          markBackedUp(w.id);
          openWalletModal('deposit', { id: w.id, fresh: true });
        }}
      >
        Continue
      </button>
    </>
  );
}

function ImportView({ ws, toast }) {
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (busy || !key.trim()) return;
    setError('');
    setBusy(true);
    try {
      const w = await importWallet(name, key);
      setKey('');
      setActive({ type: 'local', id: w.id });
      toast?.show({ kind: 'success', title: `${w.name} imported`, detail: "It's now your active wallet.", autoClose: 4000 });
      openWalletModal('home');
    } catch (err) {
      if (/Unlock your wallets/.test(err?.message || '')) return openWalletModal('unlock', { next: 'import' });
      setError(errText(err));
      setBusy(false);
    }
  };

  return (
    <>
      <Head title="Import a private key" onBack={() => openWalletModal('home')} />
      <form className="wmd-form" onSubmit={submit}>
        <div className="wmd-field">
          <label htmlFor="wmd-key">Private key</label>
          <div className="wmd-input">
            <input
              id="wmd-key"
              className={show ? 'mono' : 'mono masked'}
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                setError('');
              }}
              placeholder="Paste your private key"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              data-1p-ignore=""
              data-lpignore="true"
              autoFocus
            />
            <button type="button" className="icon-btn" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide key' : 'Show key'} aria-pressed={show}>
              <Icon name={show ? 'eyeOff' : 'eye'} size={15} />
            </button>
          </div>
          <p className="wmd-hint">In Phantom: Settings, pick your account, then Show private key. Recovery phrases aren't supported.</p>
        </div>
        <TextField id="wmd-name" label="Name (optional)" value={name} onChange={setName} placeholder={`Wallet ${ws.wallets.length + 1}`} maxLength={32} />
        <ErrorText error={error} />
        <Submit busy={busy} busyLabel="Importing…" disabled={!key.trim()}>
          Import wallet
        </Submit>
      </form>
      <Foot>The key is encrypted on this device before it's saved, and never leaves this browser.</Foot>
    </>
  );
}

function DepositView({ ws, m, onChanged }) {
  const w = ws.wallets.find((x) => x.id === m.id);
  const [copied, copy] = useCopy();
  const bal = useBalances([w.pubkey], 5000);
  const lamports = bal[w.pubkey];
  const last = useRef(null);
  const [received, setReceived] = useState(0);

  // notice incoming SOL while this view is open
  useEffect(() => {
    if (lamports === undefined) return;
    if (last.current !== null && lamports > last.current) {
      const delta = lamports - last.current;
      setReceived((r) => r + delta);
      onChanged?.();
    }
    last.current = lamports;
  }, [lamports, onChanged]);

  return (
    <>
      <Head title={m.fresh ? 'Add SOL to start trading' : `Deposit to ${w.name}`} onBack={() => openWalletModal('home')} />
      <p className="wmd-lead">Send SOL to this address from any wallet or exchange. Use the Solana network.</p>
      <div className="wmd-addr mono">{w.pubkey}</div>
      <div className="wmd-row2">
        <button type="button" className="btn btn-primary" onClick={() => copy(w.pubkey, 'addr')} autoFocus>
          <Icon name={copied ? 'check' : 'copy'} size={15} />
          {copied ? 'Copied' : 'Copy address'}
        </button>
        <a className="btn btn-ghost" href={`https://solscan.io/account/${w.pubkey}`} target="_blank" rel="noreferrer">
          <Icon name="external" size={15} />
          Solscan
        </a>
      </div>
      <div className="wmd-meta">
        <span>Balance</span>
        <span>
          <b>{lamports === undefined ? '—' : fmtSol(lamports / 1e9)}</b> SOL
        </span>
      </div>
      {received > 0 ? (
        <p className="wmd-ok">
          <Icon name="check" size={15} />
          Received {fmtLamports(received)} SOL
        </p>
      ) : (
        <p className="wmd-wait">
          <span className="vp-dot slow" aria-hidden="true" />
          Watching for deposits. This updates by itself.
        </p>
      )}
      <button
        type="button"
        className="btn btn-ghost btn-block"
        onClick={() => {
          onChanged?.();
          closeWalletModal();
        }}
      >
        Done
      </button>
    </>
  );
}

function WithdrawView({ ws, m, solPrice, onChanged, holdOpen }) {
  const w = ws.wallets.find((x) => x.id === m.id);
  const bal = useBalances([w.pubkey], 10000);
  const lamports = bal[w.pubkey];
  const [to, setTo] = useState('');
  const [amt, setAmt] = useState('');
  const [pw, setPw] = useState('');
  const [step, setStep] = useState('form'); // form | review | sending | done
  const [error, setError] = useState('');
  const [sig, setSig] = useState('');
  const [result, setResult] = useState(null);

  const dest = to.trim();
  const amount = toLamports(amt);
  const max = lamports === undefined ? 0 : Math.max(0, lamports - FEE_LAMPORTS);

  const [checking, setChecking] = useState(false);

  const review = async (e) => {
    e.preventDefault();
    if (checking) return;
    setError('');
    if (!isAddress(dest)) return setError('Enter a valid Solana address.');
    if (dest === w.pubkey) return setError("That's this wallet's own address.");
    if (!(amount > 0)) return setError('Enter an amount.');
    if (lamports === undefined) return setError('Still loading your balance. Try again in a moment.');
    if (amount > max) return setError(`Not enough SOL. You can send up to ${fmtLamports(max)} SOL.`);
    const left = lamports - amount - FEE_LAMPORTS;
    if (left > 0 && left < RENT_MIN_LAMPORTS) return setError(`Leave at least ${fmtLamports(RENT_MIN_LAMPORTS)} SOL in the wallet, or send the max.`);
    // people paste coin addresses here by mistake; SOL sent to those can't come back
    setChecking(true);
    try {
      const kind = await addressKind(dest);
      if (kind === 'other') return setError("That's a coin, token account or program address, not a wallet. SOL sent there can't be recovered.");
      if (kind === 'new' && amount < RENT_MIN_LAMPORTS) return setError(`This address has never been used, so send at least ${fmtLamports(RENT_MIN_LAMPORTS)} SOL.`);
      setStep('review');
    } catch {
      setError("Couldn't check that address. Try again.");
    } finally {
      setChecking(false);
    }
  };

  const send = async (e) => {
    e.preventDefault();
    if (!pw) return;
    setError('');
    setStep('sending');
    holdOpen(true);
    try {
      const s = await sendSol(w.id, dest, amount, pw);
      setSig(s);
      const ok = await waitForConfirm(s);
      onChanged?.();
      setResult(ok);
      setStep('done');
    } catch (err) {
      setError(errText(err));
      setStep('review');
    } finally {
      setPw('');
      holdOpen(false);
    }
  };

  if (step === 'sending') {
    return (
      <>
        <Head title={`Withdraw from ${w.name}`} noClose />
        <div className="wmd-status">
          <span className="spinner wmd-status-spin" aria-hidden="true" />
          <b>{sig ? 'Confirming on Solana…' : 'Sending…'}</b>
          <span className="muted">
            {fmtLamports(amount)} SOL to {short(dest, 4)}
          </span>
        </div>
      </>
    );
  }

  if (step === 'done') {
    return (
      <>
        <Head title={`Withdraw from ${w.name}`} />
        <div className="wmd-status" role="status">
          <span className={`wmd-status-icon${result === false ? ' err' : ''}`}>
            <Icon name={result === false ? 'alert' : 'check'} size={22} />
          </span>
          <b>{result === true ? 'Sent' : result === false ? 'The transfer failed' : 'Sent, still confirming'}</b>
          <span className="muted">
            {fmtLamports(amount)} SOL to {short(dest, 4)}
          </span>
          <a className="toast-link" href={`https://solscan.io/tx/${sig}`} target="_blank" rel="noreferrer">
            View on Solscan
          </a>
        </div>
        <button type="button" className="btn btn-primary btn-block" onClick={() => openWalletModal('home')} autoFocus>
          Done
        </button>
      </>
    );
  }

  if (step === 'review') {
    return (
      <>
        <Head title="Review withdrawal" onBack={() => setStep('form')} />
        <dl className="wmd-review">
          <div>
            <dt>Send</dt>
            <dd>
              {fmtLamports(amount)} SOL
              {solPrice ? <span className="muted"> {usd((amount / 1e9) * solPrice)}</span> : null}
            </dd>
          </div>
          <div>
            <dt>From</dt>
            <dd>{w.name}</dd>
          </div>
          <div>
            <dt>To</dt>
            <dd className="mono">{dest}</dd>
          </div>
          <div>
            <dt>Network fee</dt>
            <dd>{fmtLamports(FEE_LAMPORTS)} SOL</dd>
          </div>
        </dl>
        {!isOnCurve(dest) && (
          <div className="wmd-warn">
            <Icon name="alert" size={15} />
            <span>This address belongs to a program, not a regular wallet. SOL sent there can be lost. Double-check it.</span>
          </div>
        )}
        <form className="wmd-form" onSubmit={send}>
          <PwUser />
          <PasswordField id="wmd-send-pw" label="Password" value={pw} onChange={setPw} autoFocus />
          <ErrorText error={error} />
          <Submit busy={false} disabled={!pw}>
            Send {fmtLamports(amount)} SOL
          </Submit>
        </form>
      </>
    );
  }

  return (
    <>
      <Head title={`Withdraw from ${w.name}`} onBack={() => openWalletModal('home')} />
      <form className="wmd-form" onSubmit={review}>
        <TextField id="wmd-to" label="To address" value={to} onChange={setTo} placeholder="Solana address" autoFocus mono />
        <div className="wmd-field">
          <div className="wmd-label-row">
            <label htmlFor="wmd-amt">Amount</label>
            <span className="muted">
              Available <b className="wmd-avail">{lamports === undefined ? '—' : fmtSol(lamports / 1e9)}</b> SOL
            </span>
          </div>
          <div className="wmd-input">
            <input
              id="wmd-amt"
              inputMode="decimal"
              value={amt}
              onChange={(e) => setAmt(e.target.value.replace(',', '.').replace(/[^0-9.]/g, ''))}
              placeholder="0.0"
              autoComplete="off"
            />
            <span className="wmd-suffix">SOL</span>
            <button type="button" className="wmd-max" onClick={() => setAmt(fmtLamports(max))} disabled={!max}>
              Max
            </button>
          </div>
        </div>
        <ErrorText error={error} />
        <Submit busy={checking} busyLabel="Checking the address…">
          Review
        </Submit>
      </form>
    </>
  );
}

function ExportView({ ws, m }) {
  const w = ws.wallets.find((x) => x.id === m.id);
  const [pw, setPw] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, copy] = useCopy();

  const submit = async (e) => {
    e.preventDefault();
    if (busy || !pw) return;
    setError('');
    setBusy(true);
    try {
      setSecret(await exportPrivateKey(w.id, pw));
      setPw('');
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Head title={`Export ${w.name}`} onBack={() => openWalletModal('home')} />
      <div className="wmd-warn danger">
        <Icon name="alert" size={15} />
        <span>Anyone with this key controls this wallet and everything in it. Never share it. Nobody from Yapper will ever ask you for it.</span>
      </div>
      {secret ? (
        <>
          <div className="wmd-secret">
            <code>{secret}</code>
          </div>
          <div className="wmd-row2">
            <button type="button" className="btn btn-ghost" onClick={() => copy(secret, 'key')}>
              <Icon name={copied ? 'check' : 'copy'} size={15} />
              {copied ? 'Copied' : 'Copy key'}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => openWalletModal('home')} autoFocus>
              Done
            </button>
          </div>
        </>
      ) : (
        <form className="wmd-form" onSubmit={submit}>
          <PwUser />
          <PasswordField id="wmd-export-pw" label="Password" value={pw} onChange={setPw} autoFocus />
          <ErrorText error={error} />
          <Submit busy={busy} busyLabel="Checking…" disabled={!pw}>
            Show private key
          </Submit>
        </form>
      )}
    </>
  );
}

function RenameView({ ws, m }) {
  const w = ws.wallets.find((x) => x.id === m.id);
  const [name, setName] = useState(w.name);
  const submit = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    renameWallet(w.id, name);
    openWalletModal('home');
  };
  return (
    <>
      <Head title="Rename wallet" onBack={() => openWalletModal('home')} />
      <form className="wmd-form" onSubmit={submit}>
        <TextField id="wmd-rename" label="Name" value={name} onChange={setName} maxLength={32} autoFocus />
        <Submit busy={false} disabled={!name.trim()}>
          Save
        </Submit>
      </form>
    </>
  );
}

function RemoveView({ ws, m, toast }) {
  const w = ws.wallets.find((x) => x.id === m.id);
  const bal = useBalances([w.pubkey]);
  const lamports = bal[w.pubkey];
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (busy || !pw) return;
    setError('');
    setBusy(true);
    try {
      await removeWallet(w.id, pw);
      toast?.show({ kind: 'info', title: `${w.name} removed from this browser`, autoClose: 4000 });
      openWalletModal('home');
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  };

  return (
    <>
      <Head title={`Remove ${w.name}`} onBack={() => openWalletModal('home')} />
      <div className="wmd-warn danger">
        <Icon name="alert" size={15} />
        <span>This deletes the wallet's key from this browser. If you haven't saved its private key, the SOL and coins in it are gone for good.</span>
      </div>
      <div className="wmd-meta">
        <span>Balance</span>
        <span>
          <b>{lamports === undefined ? '—' : fmtSol(lamports / 1e9)}</b> SOL
        </span>
      </div>
      <button type="button" className="wmd-link" onClick={() => openWalletModal('export', { id: w.id })}>
        Export the private key first
      </button>
      <form className="wmd-form" onSubmit={submit}>
        <PwUser />
        <PasswordField id="wmd-remove-pw" label="Password" value={pw} onChange={setPw} autoFocus />
        <ErrorText error={error} />
        <Submit busy={busy} busyLabel="Removing…" disabled={!pw} danger>
          Remove wallet
        </Submit>
      </form>
    </>
  );
}

function ResetView({ m, toast }) {
  const [ok, setOk] = useState(false);
  const back = () => openWalletModal('unlock', m.back || {});
  return (
    <>
      <Head title="Reset Yapper wallets" onBack={back} />
      <div className="wmd-warn danger">
        <Icon name="alert" size={15} />
        <span>
          Your password can't be recovered. Resetting deletes every Yapper wallet on this device. You can import them again with their private keys.
        </span>
      </div>
      <label className="wmd-check">
        <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />
        <span>I have the private keys for these wallets, or they're empty</span>
      </label>
      <button
        type="button"
        className="btn btn-danger btn-block"
        disabled={!ok}
        onClick={() => {
          resetVault();
          toast?.show({ kind: 'info', title: 'Yapper wallets deleted from this device', autoClose: 5000 });
          openWalletModal('home');
        }}
      >
        Delete wallets on this device
      </button>
    </>
  );
}

const VIEWS = {
  start: StartView,
  home: HomeView,
  setup: SetupView,
  unlock: UnlockView,
  backup: BackupView,
  import: ImportView,
  deposit: DepositView,
  withdraw: WithdrawView,
  export: ExportView,
  rename: RenameView,
  remove: RemoveView,
  reset: ResetView,
};

/* ---------- dialog ---------- */

function Dialog({ ws, toast, solPrice, onChanged }) {
  const m = ws.modal;
  const ref = useRef(null);
  const hold = useRef(false);
  const holdOpen = useCallback((on) => {
    hold.current = on;
  }, []);

  let view = VIEWS[m.view] ? m.view : 'home';
  if (WALLET_VIEWS.includes(view) && !ws.wallets.some((w) => w.id === m.id)) view = 'home';
  if (view === 'backup' && !m.secret) view = 'home';
  if (view === 'home' && !ws.wallets.length && !ws.external) view = 'start';
  const View = VIEWS[view];

  // keep the page still and give focus back when the dialog closes
  useEffect(() => {
    const prev = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e) => {
      if (e.key === 'Escape' && !hold.current) {
        e.preventDefault();
        closeWalletModal();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      try {
        if (prev && document.contains(prev)) prev.focus({ preventScroll: true });
      } catch {}
    };
  }, []);

  useEffect(() => {
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus({ preventScroll: true });
  }, [view]);

  // keep Tab inside the dialog
  const onKeyDown = (e) => {
    if (e.key !== 'Tab' || !ref.current) return;
    const items = [...ref.current.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]):not([tabindex="-1"])')].filter(
      (el) => el.getClientRects().length > 0
    );
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="wmd-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !hold.current) closeWalletModal();
      }}
    >
      <div className="wmd" role="dialog" aria-modal="true" aria-labelledby="wmd-title" tabIndex={-1} ref={ref} onKeyDown={onKeyDown}>
        <View
          key={`${view}:${m.id || ''}`}
          ws={ws}
          m={m}
          toast={toast}
          solPrice={solPrice}
          onChanged={onChanged}
          holdOpen={holdOpen}
        />
      </div>
    </div>
  );
}

export default function WalletModal({ toast, solPrice, onChanged }) {
  const ws = useWallets();
  if (!ws.modal) return null;
  return <Dialog ws={ws} toast={toast} solPrice={solPrice} onChanged={onChanged} />;
}
