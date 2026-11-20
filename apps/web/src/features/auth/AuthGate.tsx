/**
 * The device-path front door (02-security §2.7; 08 §8.1 gate 3).
 *
 *   not enrolled     → enter the one-time code from the back office
 *   nobody signed in → choose who you are and enter your PIN — or sign in
 *                      online through the identity provider (first time on
 *                      this tablet, or after too many wrong PINs)
 *   signed in online → choose a 6-digit PIN for this tablet
 *   unlocked         → the app, under a lease banner when not in full mode
 *   revoked          → the outbox drains to review, then the device wipes
 *
 * Locking never deletes anything (08 §8.1a): "the first thing a frustrated
 * staff member does with a stuck till is log out, and the day's sales must not
 * go with it." Every screen here works at 360 px, one-handed, on a tablet.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { AuthPhase, DeviceAuth } from '../../data/auth/device-auth';
import { AuthError } from '../../data/auth/device-auth';
import { describeRemaining } from '../../data/auth/lease';
import { PIN_LENGTH, isValidPin } from '../../data/auth/pin';
import { Icon } from '../../ui/Icon';
import { ALLOW_ALL, LeaseContext, gateFrom, type LeaseGate } from './lease-gate';

export const CALLBACK_PATH = '/auth/callback';

function messageOf(err: unknown): string {
  if (err instanceof AuthError) {
    switch (err.code) {
      case 'enrolment_code_unknown':
        return 'That code was not recognised. Check it with whoever issued it.';
      case 'enrolment_code_used':
        return 'That code has already been used. Ask for a new one.';
      case 'enrolment_code_expired':
        return 'That code has expired (codes last 15 minutes). Ask for a new one.';
      case 'enrolment_rate_limited':
        return 'Too many attempts from this device. Wait an hour, or ask for help.';
      case 'no_active_user':
        return 'That sign-in is not linked to anyone at this business. Ask your manager.';
      case 'device_revoked':
        return 'This device has been withdrawn from service.';
      default:
        return err.message;
    }
  }
  if (err instanceof TypeError) return 'The server could not be reached. Check the connection and try again.';
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// The PIN pad — big targets, thumb reach, no keyboard
// ---------------------------------------------------------------------------

export function PinPad({
  title,
  busy,
  error,
  onSubmit,
}: {
  readonly title: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onSubmit: (pin: string) => void;
}): ReactNode {
  const [pin, setPin] = useState('');
  const press = (d: string): void => {
    if (busy) return;
    const next = (pin + d).slice(0, PIN_LENGTH);
    setPin(next);
    if (next.length === PIN_LENGTH) {
      onSubmit(next);
      setPin('');
    }
  };
  return (
    <section className="pin-pad" aria-label={title}>
      <h2>{title}</h2>
      <p className="pin-dots" aria-live="polite" aria-label={`${pin.length} of ${PIN_LENGTH} digits`}>
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <span key={i} className={i < pin.length ? 'pin-dot filled' : 'pin-dot'} />
        ))}
      </p>
      {error !== null ? (
        <p className="device-gate-error" role="alert">
          <Icon name="alert" size={20} />
          {error}
        </p>
      ) : null}
      <div className="pin-keys">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button key={d} type="button" className="pin-key pressable" disabled={busy} onClick={() => press(d)}>
            {d}
          </button>
        ))}
        <button type="button" className="pin-key pressable" disabled={busy || pin.length === 0} onClick={() => setPin(pin.slice(0, -1))} aria-label="Delete digit">
          <Icon name="back" size={22} />
        </button>
        <button type="button" className="pin-key pressable" disabled={busy} onClick={() => press('0')}>
          0
        </button>
        <span />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

export function EnrolScreen({ auth }: { readonly auth: DeviceAuth }): ReactNode {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (): void => {
    setBusy(true);
    setError(null);
    auth
      .enrol(code.trim())
      .catch((err: unknown) => setError(messageOf(err)))
      .finally(() => setBusy(false));
  };
  return (
    <main className="device-gate">
      <span className="gate-crest">
        <Icon name="pin" size={28} />
      </span>
      <h1>Set up this device</h1>
      <p className="device-gate-message">
        Enter the one-time code from the back office. It is 8 letters and digits and lasts 15
        minutes. This device makes its own key; the key never leaves it.
      </p>
      <form
        className="enrol-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor="enrol-code">Enrolment code</label>
        <input
          id="enrol-code"
          className="enrol-code"
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          maxLength={9}
          placeholder="ABCD-1234"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
        />
        <button type="submit" className="primary-action pressable" disabled={busy || code.replace(/[-\s]/g, '').length !== 8}>
          {busy ? 'Setting up…' : 'Set up'}
        </button>
      </form>
      {error !== null ? (
        <p className="device-gate-error" role="alert">
          <Icon name="alert" size={20} />
          {error}
        </p>
      ) : null}
    </main>
  );
}

function SignInButton({ auth, label }: { readonly auth: DeviceAuth; readonly label: string }): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="secondary-action pressable"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          auth
            .beginSignIn(`${window.location.origin}${CALLBACK_PATH}`)
            .then((url) => window.location.assign(url))
            .catch((err: unknown) => {
              setError(messageOf(err));
              setBusy(false);
            });
        }}
      >
        <Icon name="live" size={20} />
        {busy ? 'Opening sign-in…' : label}
      </button>
      {error !== null ? (
        <p className="device-gate-error" role="alert">
          <Icon name="alert" size={20} />
          {error}
        </p>
      ) : null}
    </>
  );
}

export function LockScreen({
  auth,
  phase,
}: {
  readonly auth: DeviceAuth;
  readonly phase: Extract<AuthPhase, { kind: 'signed-out' }>;
}): ReactNode {
  const [chosen, setChosen] = useState<string | null>(phase.users.length === 1 ? phase.users[0]!.userId : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const user = phase.users.find((u) => u.userId === chosen) ?? null;
  return (
    <main className="device-gate">
      <span className="gate-crest">
        <Icon name="pin" size={28} />
      </span>
      <h1>{phase.device.label}</h1>
      {phase.users.length === 0 ? (
        <p className="device-gate-message">
          Nobody has signed in on this device yet. The first time, you need a connection.
        </p>
      ) : user === null ? (
        <>
          <h2>Who is at the counter?</h2>
          <ul className="device-gate-choices">
            {phase.users.map((u) => (
              <li key={u.userId}>
                <button type="button" className="device-gate-choice pressable" onClick={() => setChosen(u.userId)}>
                  <span className="device-gate-choice-name">{u.displayName}</span>
                  {u.sealed ? <span className="device-gate-choice-code">Sign in online to unlock</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : user.sealed ? (
        <p className="device-gate-message">
          Too many wrong PINs for {user.displayName}. Nothing has been deleted — sign in online to
          choose a new PIN.
        </p>
      ) : (
        <>
          <PinPad
            title={`${user.displayName} — enter your PIN`}
            busy={busy}
            error={error}
            onSubmit={(pin) => {
              setBusy(true);
              setError(null);
              auth
                .unlock(user.userId, pin)
                .then((r) => {
                  if (r === 'wrong_pin') setError('That PIN is not right.');
                  if (r === 'sealed') setError('Too many wrong PINs. Sign in online to unlock.');
                })
                .catch((err: unknown) => setError(messageOf(err)))
                .finally(() => setBusy(false));
            }}
          />
          {phase.users.length > 1 ? (
            <button type="button" className="secondary-action pressable" onClick={() => setChosen(null)}>
              Someone else
            </button>
          ) : null}
        </>
      )}
      <SignInButton auth={auth} label={phase.users.length === 0 ? 'Sign in' : 'Sign in online'} />
    </main>
  );
}

export function PinSetupScreen({ auth, displayName }: { readonly auth: DeviceAuth; readonly displayName: string }): ReactNode {
  const [first, setFirst] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <main className="device-gate">
      <h1>Welcome, {displayName}</h1>
      <p className="device-gate-message">
        Choose a {PIN_LENGTH}-digit PIN for this tablet. You will use it to unlock at shift change,
        with or without a connection. It never leaves this device.
      </p>
      <PinPad
        title={first === null ? 'Choose your PIN' : 'Enter it again'}
        busy={busy}
        error={error}
        onSubmit={(pin) => {
          if (!isValidPin(pin)) return;
          if (first === null) {
            setFirst(pin);
            setError(null);
            return;
          }
          if (pin !== first) {
            setFirst(null);
            setError('Those did not match. Start again.');
            return;
          }
          setBusy(true);
          auth
            .setPin(pin)
            .catch((err: unknown) => setError(messageOf(err)))
            .finally(() => setBusy(false));
        }}
      />
    </main>
  );
}

export function RevokedScreen({ phase }: { readonly phase: Extract<AuthPhase, { kind: 'revoked' }> }): ReactNode {
  return (
    <main className="device-gate">
      <span className="gate-crest">
        <Icon name="alert" size={28} />
      </span>
      <h1>This device has been withdrawn</h1>
      {phase.revoked.drain === 'refused' ? (
        <p className="device-gate-message">It is being cleared now.</p>
      ) : (
        <p className="device-gate-message">
          Anything recorded here that has not reached the server is being sent for review first — no
          sale is thrown away. Keep it connected. When everything has been sent, this device clears
          itself and can be set up again.
        </p>
      )}
    </main>
  );
}

export function LeaseBanner({ gate, onReconnect }: { readonly gate: LeaseGate; readonly onReconnect: () => void }): ReactNode {
  if (gate.mode === 'none' || gate.mode === 'full') return null;
  const text =
    gate.mode === 'restricted'
      ? `Offline too long: cash sales and lookups only${gate.secondsLeft !== null ? ` — ${describeRemaining(gate.secondsLeft)} left before read-only` : ''}.`
      : gate.reason === 'clock_moved_backwards'
        ? 'The device clock moved backwards. This till is read-only until it reconnects.'
        : 'Read-only: this till has been offline too long. Nothing has been lost — reconnect to continue.';
  return (
    <p className={gate.mode === 'sealed' ? 'lease-banner sealed' : 'lease-banner'} role="status">
      <Icon name="cloud-off" size={20} />
      <span>{text}</span>
      <button type="button" className="pressable" onClick={onReconnect}>
        Reconnect
      </button>
    </p>
  );
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export function AuthGate({
  auth,
  children,
}: {
  readonly auth: DeviceAuth;
  /** The app, keyed by the unlocked user so a switch remounts it cleanly. */
  readonly children: (userId: string) => ReactNode;
}): ReactNode {
  const [phase, setPhase] = useState<AuthPhase | null>(null);
  const [gate, setGate] = useState<LeaseGate>(ALLOW_ALL);
  const [callbackError, setCallbackError] = useState<string | null>(null);

  const reload = useCallback(() => {
    void auth.phase().then(setPhase);
    void auth.leaseVerdict().then(({ verdict, claims }) => setGate(gateFrom(verdict, claims)));
  }, [auth]);

  useEffect(() => {
    // Back from the identity provider: finish the sign-in, then tidy the URL.
    if (window.location.pathname === CALLBACK_PATH) {
      const here = window.location.href;
      window.history.replaceState(null, '', '/');
      auth.completeSignIn(here).catch((err: unknown) => setCallbackError(messageOf(err)));
    }
    reload();
    const off = auth.onChange(reload);
    // The lease decays with time, not with events: re-evaluate every 30 s.
    const timer = setInterval(reload, 30_000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [auth, reload]);

  if (phase === null) return null;
  switch (phase.kind) {
    case 'unenrolled':
      return <EnrolScreen auth={auth} />;
    case 'revoked':
      return <RevokedScreen phase={phase} />;
    case 'pin-setup':
      return <PinSetupScreen auth={auth} displayName={phase.pending.displayName} />;
    case 'signed-out':
      return (
        <>
          {callbackError !== null ? (
            <p className="device-gate-error" role="alert">
              <Icon name="alert" size={20} />
              {callbackError}
            </p>
          ) : null}
          <LockScreen auth={auth} phase={phase} />
        </>
      );
    case 'unlocked':
      return (
        <LeaseContext.Provider value={gate}>
          <LeaseBanner gate={gate} onReconnect={() => void auth.refresh().catch(() => undefined)} />
          <div className="session-bar">
            <span>{phase.session.displayName}</span>
            {/* The shift change: lock, and the next person unlocks with their
                own PIN. Nothing is deleted and the outbox keeps draining. */}
            <button type="button" className="pressable" onClick={() => auth.lock()}>
              Lock / switch
            </button>
          </div>
          {children(phase.session.userId)}
        </LeaseContext.Provider>
      );
  }
}
