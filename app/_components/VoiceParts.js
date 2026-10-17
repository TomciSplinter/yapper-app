'use client';

// Pieces of the voice panel: the confirm cards, the coin cards a scan
// returns, and the orb's settings.

import { amount as fmtAmount, usd, pct, tone, age } from '../_lib/format';
import { Icon, TokenImage } from './Icons';

function Coin({ imageUrl, symbol, name, mint, marketCap }) {
  return (
    <div className="vp-coin">
      <TokenImage src={imageUrl} label={symbol} size={36} />
      <div className="vp-coin-text">
        <span className="vp-coin-name">
          {name || symbol} <span className="muted">{symbol}</span>
        </span>
        <span className="vp-coin-sub mono">
          {mint.slice(0, 4)}…{mint.slice(-4)}
          {marketCap ? <span className="muted"> MC {usd(marketCap)}</span> : null}
        </span>
      </div>
    </div>
  );
}

const legText = (leg) => {
  if (!leg) return null;
  if (leg.kind === 'multiple') return `${leg.value}x`;
  if (leg.kind === 'percent') return `${leg.value > 0 ? '+' : ''}${leg.value}%`;
  return `${usd(leg.value)} MC`;
};

const expiryText = (ms) => {
  if (!ms) return 'Until cancelled';
  const h = ms / 3600000;
  if (h < 1) return `${Math.round(ms / 60000)} min`;
  if (h < 48) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} days`;
};

export function PendingCard({ pending: p, onConfirm, onCancel }) {
  if (p.kind === 'cancel_orders') {
    return (
      <div className="vp-card">
        <ul className="vp-many vp-list">
          {p.items.map((it) => (
            <li key={it.id} className="vp-many-row two">
              <span className="vp-many-sym">{it.label}</span>
              <span className="muted">{it.text}</span>
            </li>
          ))}
        </ul>
        <div className="vp-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Keep {p.items.length > 1 ? 'them' : 'it'}
          </button>
          <button type="button" className="btn btn-sell" onClick={onConfirm}>
            Cancel {p.items.length > 1 ? `${p.items.length} orders` : 'order'}
          </button>
        </div>
      </div>
    );
  }

  if (p.kind === 'setting') {
    return (
      <div className="vp-card">
        <p className="vp-note">{p.text}. That changes every trade from now on.</p>
        <div className="vp-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={onConfirm}>
            Confirm
          </button>
        </div>
      </div>
    );
  }

  if (p.kind === 'sell_many') {
    const total = p.items.reduce((s, it) => s + (it.valueUsd || 0), 0);
    return (
      <div className="vp-card">
        <div className="vp-many">
          {p.items.map((it) => (
            <div key={it.mint} className="vp-many-row">
              <TokenImage src={it.imageUrl} label={it.symbol} size={22} />
              <span className="vp-many-sym">{it.symbol}</span>
              <span className="muted">{it.valueUsd !== null && it.valueUsd !== undefined ? usd(it.valueUsd) : '—'}</span>
              {it.fromEntryPct !== null && it.fromEntryPct !== undefined && <span className={tone(it.fromEntryPct)}>{pct(it.fromEntryPct)}</span>}
            </div>
          ))}
        </div>
        <dl className="vp-facts">
          <div>
            <dt>Sell</dt>
            <dd>{p.percent === 100 ? 'All' : `${p.percent}%`} of each</dd>
          </div>
          {p.rule && (
            <div>
              <dt>Coins</dt>
              <dd>{p.rule.replace(/^./, (c) => c.toUpperCase())}</dd>
            </div>
          )}
          <div>
            <dt>Worth now</dt>
            <dd>≈ {usd(total * (p.percent / 100))}</dd>
          </div>
        </dl>
        <div className="vp-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-sell" onClick={onConfirm}>
            Confirm sell {p.items.length}
          </button>
        </div>
      </div>
    );
  }

  if (p.kind === 'order') {
    const buy = p.side === 'buy';
    return (
      <div className="vp-card">
        <Coin {...p} marketCap={p.mcNow} />
        <dl className="vp-facts">
          <div>
            <dt>{p.label}</dt>
            <dd>{buy ? `${p.amountSol} SOL` : `${p.percent}%`}</dd>
          </div>
          <div>
            <dt>When MC {p.dir === 'below' ? 'falls to' : 'rises to'}</dt>
            <dd>{usd(p.targetMc)}</dd>
          </div>
          <div>
            <dt>Expires</dt>
            <dd>{expiryText(p.expiresInMs)}</dd>
          </div>
        </dl>
        {p.note && <p className="vp-note">{p.note}</p>}
        <div className="vp-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className={`btn ${buy ? 'btn-buy' : 'btn-sell'}`} onClick={onConfirm}>
            Place {p.label.toLowerCase()}
          </button>
        </div>
      </div>
    );
  }

  // a trade now, maybe with take profit / stop loss
  const buy = p.side === 'buy';
  return (
    <div className="vp-card">
      <Coin {...p} />
      <dl className="vp-facts">
        <div>
          <dt>{buy ? 'Spend' : 'Sell'}</dt>
          <dd>{buy ? `${p.amountSol} SOL` : `${p.percent}% of ${fmtAmount(p.holding)}`}</dd>
        </div>
        <div>
          <dt>You get</dt>
          <dd>{p.estimate ? `≈ ${p.estimate}` : '—'}</dd>
        </div>
        {p.tp && (
          <div>
            <dt>Take profit</dt>
            <dd className="up">{legText(p.tp)}</dd>
          </div>
        )}
        {p.sl && (
          <div>
            <dt>Stop loss</dt>
            <dd className="down">{legText(p.sl)}</dd>
          </div>
        )}
      </dl>
      <div className="vp-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={`btn ${buy ? 'btn-buy' : 'btn-sell'}`} onClick={onConfirm}>
          {buy ? 'Confirm buy' : 'Confirm sell'}
        </button>
      </div>
    </div>
  );
}

// coins a scan or answer named, with Open and a quick buy
export function CoinCards({ cards, onOpen, onBuy, quickAmount }) {
  if (!cards.length) return null;
  return (
    <ol className="vp-cards">
      {cards.map((c, i) => (
        <li key={c.mint} className="vp-cc">
          <span className="vp-cc-n">{i + 1}</span>
          <TokenImage src={c.image} label={c.symbol} size={28} />
          <button type="button" className="vp-cc-main" onClick={() => onOpen(c.mint)}>
            <span className="vp-cc-sym">{c.symbol || `${c.mint.slice(0, 4)}…`}</span>
            <span className="vp-cc-sub">
              {c.mc ? usd(c.mc) : '—'}
              {c.chg !== null && c.chg !== undefined && <span className={tone(c.chg)}> {pct(c.chg)}</span>}
              {c.createdAt ? <span className="muted"> · {age(c.createdAt)}</span> : null}
            </span>
          </button>
          {onBuy && (
            <button type="button" className="btn btn-buy btn-xs" onClick={() => onBuy(c)} aria-label={`Buy ${quickAmount} SOL of ${c.symbol || 'this coin'}`}>
              <Icon name="bolt" size={12} /> {quickAmount}
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}

function Toggle({ id, label, sub, checked, onChange, disabled }) {
  return (
    <label className={`vp-set${disabled ? ' off' : ''}`} htmlFor={id}>
      <span className="vp-set-text">
        <span className="vp-set-label">{label}</span>
        {sub && <span className="vp-set-sub">{sub}</span>}
      </span>
      <input id={id} type="checkbox" role="switch" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch" aria-hidden="true" />
    </label>
  );
}

export function VoiceSettings({ prefs, onChange, wakeState, wakeOk }) {
  const wakeSub = !wakeOk
    ? "This browser can't listen for a wake word. Chrome and Edge can."
    : wakeState === 'denied'
    ? 'Microphone access is blocked for this site.'
    : wakeState === 'error'
    ? "The browser's speech service isn't responding. Retrying."
    : 'Say "Yapper, buy 0.1 SOL of this". Your browser’s speech service listens while this is on.';
  return (
    <div className="vp-settings">
      <Toggle id="vs-replies" label="Spoken replies" sub="The orb answers out loud." checked={!prefs.muted} onChange={(v) => onChange({ muted: !v })} />
      <Toggle
        id="vs-natural"
        label="Natural voice"
        sub="A clearer voice. Off uses your browser's voice."
        checked={prefs.natural}
        disabled={prefs.muted}
        onChange={(v) => onChange({ natural: v })}
      />
      <Toggle id="vs-wake" label='Hands-free: "Yapper"' sub={wakeSub} checked={prefs.wake && wakeOk} disabled={!wakeOk} onChange={(v) => onChange({ wake: v })} />
      <Toggle
        id="vs-callouts"
        label="Callouts"
        sub="Speaks up when a coin you hold hits 2x, graduates, or gets a big sell."
        checked={prefs.callouts}
        onChange={(v) => onChange({ callouts: v })}
      />
      <Toggle
        id="vs-trades"
        label="Read out trades"
        sub="Says what each finished trade did."
        checked={prefs.speakTrades}
        disabled={prefs.muted}
        onChange={(v) => onChange({ speakTrades: v })}
      />
    </div>
  );
}
