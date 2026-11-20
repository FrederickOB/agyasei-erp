/**
 * BACK-OFFICE ADMINISTRATION — people, devices, roles (02-security §2.4–§2.7).
 *
 * Laptop-first (ADR-0003 A1: every back-office screen is designed at laptop
 * width first) and usable on a tablet: single column below 900 px, 44 px
 * targets throughout. ONLINE ONLY — configuration, never trade.
 *
 * What these screens are NOT: a control. Every act is re-authorised by the
 * server against the database, including the escalation rule (you may hand
 * out only what you hold, where you hold it, no looser). A refusal is shown in
 * the server's own words, so "why could I not do that?" has an answer.
 *
 * No password, PIN or second factor is ever typed here: a person's credential
 * lives at the identity provider, and a user is LINKED to an IdP subject.
 * Role names are the tenant's words; nothing here branches on one.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { DEVICE_FORM_FACTORS, DEVICE_RETIRED_REASONS, type DeviceFormFactor, type DeviceRetiredReason } from '@erp/contracts';
import type { ApiCallOptions, ApiResult } from '../../data/api/client';
import {
  assignRole,
  createRole,
  createUser,
  deleteRole,
  endAssignment,
  fetchAdminCatalogue,
  fetchAdminDevices,
  fetchAdminLocations,
  fetchAdminRoles,
  fetchAdminUsers,
  issueEnrolmentCode,
  revokeDevice,
  setDeviceScope,
  setDeviceStatus,
  setUserStatus,
  updateRole,
  type AdminLocation,
  type IssuedCode,
} from '../../data/api/admin';
import { useApiQuery } from '../../data/api/use-api-query';
import { Icon } from '../../ui/Icon';

const key = (): string => crypto.randomUUID();

interface Props {
  readonly apiOptions?: ApiCallOptions | undefined;
}

function useAct(): {
  busy: boolean;
  error: string | null;
  run: (act: () => Promise<ApiResult<unknown>>, after?: () => void) => void;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return {
    busy,
    error,
    run(act, after) {
      setBusy(true);
      setError(null);
      void act()
        .then((r) => {
          if (r.ok) after?.();
          else setError(r.failure.detail ?? r.failure.message);
        })
        .finally(() => setBusy(false));
    },
  };
}

function Refusal({ error }: { readonly error: string | null }): ReactNode {
  return error === null ? null : (
    <p className="device-gate-error" role="alert">
      <Icon name="alert" size={20} />
      {error}
    </p>
  );
}

function LocationPicker({
  locations,
  value,
  onChange,
  allowNone,
  label,
}: {
  readonly locations: readonly AdminLocation[];
  readonly value: string | null;
  readonly onChange: (id: string | null) => void;
  readonly allowNone?: string;
  readonly label: string;
}): ReactNode {
  return (
    <label className="admin-field">
      <span>{label}</span>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}>
        {allowNone !== undefined ? <option value="">{allowNone}</option> : <option value="" disabled>Choose…</option>}
        {locations
          .filter((l) => l.kind !== 'TRANSIT')
          .map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} ({l.code})
            </option>
          ))}
      </select>
    </label>
  );
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export function PeopleAdmin({ apiOptions }: Props): ReactNode {
  const o = apiOptions ?? {};
  const users = useApiQuery(() => fetchAdminUsers(o), []);
  const roles = useApiQuery(() => fetchAdminRoles(o), []);
  const locations = useApiQuery(() => fetchAdminLocations(o), []);
  const act = useAct();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [subject, setSubject] = useState('');
  const [assignFor, setAssignFor] = useState<string | null>(null);
  const [roleId, setRoleId] = useState('');
  const [scope, setScope] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [until, setUntil] = useState('');

  const refresh = (): void => users.refresh();
  const roleList = roles.state.status === 'ready' ? roles.state.data : [];
  const locs = locations.state.status === 'ready' ? locations.state.data : [];

  return (
    <section className="admin-screen" aria-label="People">
      <header className="admin-head">
        <h1>People</h1>
        <p>Who may sign in, what they may do, and where. Credentials live at the identity provider — never here.</p>
      </header>

      <form
        className="admin-card admin-form"
        onSubmit={(e) => {
          e.preventDefault();
          act.run(
            () =>
              createUser(
                {
                  idempotencyKey: key(),
                  username: username.trim(),
                  displayName: displayName.trim(),
                  ...(subject.trim() ? { subjectRef: subject.trim() } : {}),
                },
                o,
              ),
            () => {
              setUsername('');
              setDisplayName('');
              setSubject('');
              refresh();
            },
          );
        }}
      >
        <h2>Add a person</h2>
        <label className="admin-field">
          <span>Username</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
        </label>
        <label className="admin-field">
          <span>Name</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label className="admin-field">
          <span>Sign-in identity (IdP subject)</span>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="optional — link later" />
        </label>
        <button type="submit" className="primary-action pressable" disabled={act.busy || username.trim().length < 2 || displayName.trim() === ''}>
          Add
        </button>
      </form>
      <Refusal error={act.error} />

      {users.state.status === 'failed' ? <Refusal error={users.state.failure.message} /> : null}
      {users.state.status === 'ready' ? (
        <ul className="admin-list">
          {users.state.data.map((u) => (
            <li key={u.id} className="admin-card">
              <div className="admin-row">
                <strong>{u.displayName}</strong>
                <span className="admin-meta">
                  {u.username} · {u.status.toLowerCase()} · {u.linkedToIdentityProvider ? 'linked to sign-in' : 'not linked'} ·{' '}
                  {u.openSessions} open session(s)
                </span>
              </div>
              <ul className="admin-assignments">
                {u.assignments.map((a) => (
                  <li key={a.id} className={a.live ? '' : 'ended'}>
                    {a.roleName} at {a.scopeName}
                    {a.effectiveTo ? ` until ${a.effectiveTo.slice(0, 16)}` : ''}
                    {a.live ? (
                      <button
                        type="button"
                        className="secondary-action pressable"
                        disabled={act.busy}
                        onClick={() => act.run(() => endAssignment({ idempotencyKey: key(), assignmentId: a.id }, o), refresh)}
                      >
                        End
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
              <div className="admin-actions">
                <button type="button" className="secondary-action pressable" onClick={() => setAssignFor(assignFor === u.id ? null : u.id)}>
                  Give a role
                </button>
                {u.status === 'ACTIVE' ? (
                  <>
                    <button
                      type="button"
                      className="secondary-action pressable"
                      disabled={act.busy}
                      onClick={() =>
                        act.run(
                          () => setUserStatus({ idempotencyKey: key(), userId: u.id, status: 'SUSPENDED', reason: 'suspended from the back office' }, o),
                          refresh,
                        )
                      }
                    >
                      Suspend
                    </button>
                    <button
                      type="button"
                      className="secondary-action pressable"
                      disabled={act.busy}
                      onClick={() =>
                        act.run(
                          () => setUserStatus({ idempotencyKey: key(), userId: u.id, status: 'DISABLED', reason: 'disabled from the back office' }, o),
                          refresh,
                        )
                      }
                    >
                      Disable
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="secondary-action pressable"
                    disabled={act.busy}
                    onClick={() =>
                      act.run(
                        () => setUserStatus({ idempotencyKey: key(), userId: u.id, status: 'ACTIVE', reason: 'reinstated from the back office' }, o),
                        refresh,
                      )
                    }
                  >
                    Reinstate
                  </button>
                )}
              </div>
              {assignFor === u.id ? (
                <form
                  className="admin-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!roleId || !scope) return;
                    act.run(
                      () =>
                        assignRole(
                          {
                            idempotencyKey: key(),
                            userId: u.id,
                            roleId,
                            scopeLocationId: scope,
                            ...(from ? { effectiveFrom: new Date(from).toISOString() } : {}),
                            ...(until ? { effectiveTo: new Date(until).toISOString() } : {}),
                          },
                          o,
                        ),
                      () => {
                        setAssignFor(null);
                        refresh();
                      },
                    );
                  }}
                >
                  <label className="admin-field">
                    <span>Role</span>
                    <select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
                      <option value="">Choose…</option>
                      {roleList.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <LocationPicker label="Where" locations={locs} value={scope} onChange={setScope} />
                  <label className="admin-field">
                    <span>From (optional — default now)</span>
                    <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
                  </label>
                  <label className="admin-field">
                    <span>Until (optional)</span>
                    <input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
                  </label>
                  <button type="submit" className="primary-action pressable" disabled={act.busy || !roleId || !scope}>
                    Give role
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export function DevicesAdmin({ apiOptions }: Props): ReactNode {
  const o = apiOptions ?? {};
  const devices = useApiQuery(() => fetchAdminDevices(o), []);
  const locations = useApiQuery(() => fetchAdminLocations(o), []);
  const act = useAct();
  const [label, setLabel] = useState('');
  const [formFactor, setFormFactor] = useState<DeviceFormFactor>('tablet');
  const [home, setHome] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedCode | null>(null);
  const [revoking, setRevoking] = useState<{ id: string; reason: DeviceRetiredReason } | null>(null);
  const locs = locations.state.status === 'ready' ? locations.state.data : [];

  return (
    <section className="admin-screen" aria-label="Devices">
      <header className="admin-head">
        <h1>Devices</h1>
        <p>Tablets, phones and laptops enrolled to this business. A device holds only what its location and its user both allow.</p>
      </header>

      <form
        className="admin-card admin-form"
        onSubmit={(e) => {
          e.preventDefault();
          setIssued(null);
          act.run(async () => {
            const r = await issueEnrolmentCode({ idempotencyKey: key(), label: label.trim(), formFactor, locationId: home }, o);
            if (r.ok) setIssued(r.data);
            return r;
          });
        }}
      >
        <h2>Enrol a device</h2>
        <label className="admin-field">
          <span>Name it</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Counter 2" />
        </label>
        <label className="admin-field">
          <span>Kind</span>
          <select value={formFactor} onChange={(e) => setFormFactor(e.target.value as DeviceFormFactor)}>
            {DEVICE_FORM_FACTORS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <LocationPicker
          label="Where it stands"
          locations={locs}
          value={home}
          onChange={setHome}
          allowNone="Nowhere — works online only, holds no data"
        />
        <button type="submit" className="primary-action pressable" disabled={act.busy || label.trim() === ''}>
          Issue a code
        </button>
        {issued !== null ? (
          <div className="enrol-issued" role="status">
            {issued.code !== null ? (
              <>
                <p className="enrol-code-display">{issued.code}</p>
                <p>
                  Type this on the device within 15 minutes ({new Date(issued.expiresAt).toLocaleTimeString()}). It works once.
                  It is not stored anywhere — if it is lost, issue another.
                </p>
              </>
            ) : (
              <p>This code was already issued and cannot be shown again. Issue a new one.</p>
            )}
          </div>
        ) : null}
      </form>
      <Refusal error={act.error} />

      {devices.state.status === 'failed' ? <Refusal error={devices.state.failure.message} /> : null}
      {devices.state.status === 'ready' ? (
        <ul className="admin-list">
          {devices.state.data.map((d) => (
            <li key={d.id} className={d.status === 'retired' ? 'admin-card retired' : 'admin-card'}>
              <div className="admin-row">
                <strong>{d.label}</strong>
                <span className="admin-meta">
                  {d.formFactor} · {d.status}
                  {d.retiredReason ? ` (${d.retiredReason})` : ''} ·{' '}
                  {d.locations.length > 0 ? d.locations.map((l) => l.name).join(', ') : 'no location — holds no data'} ·{' '}
                  {d.lastSeenAt ? `seen ${d.lastSeenAt.slice(0, 16)}` : 'not yet seen'}
                </span>
              </div>
              {d.status !== 'retired' ? (
                <div className="admin-actions">
                  <button
                    type="button"
                    className="secondary-action pressable"
                    disabled={act.busy}
                    onClick={() =>
                      act.run(
                        () => setDeviceStatus({ idempotencyKey: key(), deviceId: d.id, status: d.status === 'active' ? 'suspended' : 'active' }, o),
                        devices.refresh,
                      )
                    }
                  >
                    {d.status === 'active' ? 'Suspend' : 'Reinstate'}
                  </button>
                  <button type="button" className="secondary-action pressable danger" onClick={() => setRevoking({ id: d.id, reason: 'lost' })}>
                    Revoke…
                  </button>
                  <LocationPicker
                    label="Move to"
                    locations={locs}
                    value={d.locations[0]?.id ?? null}
                    allowNone="Nowhere — holds no data"
                    onChange={(id) =>
                      act.run(
                        () => setDeviceScope({ idempotencyKey: key(), deviceId: d.id, locationIds: id === null ? [] : [id] }, o),
                        devices.refresh,
                      )
                    }
                  />
                </div>
              ) : null}
              {revoking?.id === d.id ? (
                <div className="admin-form">
                  <label className="admin-field">
                    <span>Why</span>
                    <select value={revoking.reason} onChange={(e) => setRevoking({ id: d.id, reason: e.target.value as DeviceRetiredReason })}>
                      {DEVICE_RETIRED_REASONS.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="admin-meta">
                    {revoking.reason === 'stolen'
                      ? 'Stolen: the device is wiped the moment it reconnects. Anything it recorded that never reached the server is lost.'
                      : 'The device sends anything unsent for review, then wipes itself. Revocation is permanent — a found device is enrolled again.'}
                  </p>
                  <button
                    type="button"
                    className="primary-action pressable danger"
                    disabled={act.busy}
                    onClick={() =>
                      act.run(() => revokeDevice({ idempotencyKey: key(), deviceId: d.id, reason: revoking.reason }, o), () => {
                        setRevoking(null);
                        devices.refresh();
                      })
                    }
                  >
                    Revoke this device
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export function RolesAdmin({ apiOptions }: Props): ReactNode {
  const o = apiOptions ?? {};
  const roles = useApiQuery(() => fetchAdminRoles(o), []);
  const catalogue = useApiQuery(() => fetchAdminCatalogue(o), []);
  const act = useAct();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [name, setName] = useState('');
  const [codes, setCodes] = useState<Set<string>>(new Set());

  const byDomain = useMemo(() => {
    const out = new Map<string, { code: string; description: string; isSensitive: boolean; offlineMode: string }[]>();
    if (catalogue.state.status !== 'ready') return out;
    for (const p of catalogue.state.data) out.set(p.domain, [...(out.get(p.domain) ?? []), p]);
    return out;
  }, [catalogue.state]);

  const open = (id: string | 'new'): void => {
    setEditing(id);
    if (id === 'new') {
      setName('');
      setCodes(new Set());
    } else if (roles.state.status === 'ready') {
      const r = roles.state.data.find((x) => x.id === id);
      setName(r?.name ?? '');
      setCodes(new Set(r?.permissions.map((p) => p.code) ?? []));
    }
  };

  const existingBounds = (id: string): Map<string, Record<string, string | number | boolean> | null> => {
    const r = roles.state.status === 'ready' ? roles.state.data.find((x) => x.id === id) : undefined;
    return new Map((r?.permissions ?? []).map((p) => [p.code, p.bound === null ? null : (JSON.parse(p.bound) as Record<string, string | number | boolean>)] as const));
  };

  return (
    <section className="admin-screen" aria-label="Roles">
      <header className="admin-head">
        <h1>Roles</h1>
        <p>
          Your business's own roles, made from the platform's capabilities. You can only hand out what you hold yourself;
          the server checks every change.
        </p>
      </header>
      <button type="button" className="secondary-action pressable" onClick={() => open('new')}>
        New role
      </button>
      <Refusal error={act.error} />
      {roles.state.status === 'ready' ? (
        <ul className="admin-list">
          {roles.state.data.map((r) => (
            <li key={r.id} className="admin-card">
              <div className="admin-row">
                <strong>{r.name}</strong>
                <span className="admin-meta">
                  {r.isOwner ? 'holds every capability, by construction' : `${r.permissions.length} capabilities`} ·{' '}
                  {r.liveAssignments} assigned
                </span>
              </div>
              {!r.isOwner ? (
                <div className="admin-actions">
                  <button type="button" className="secondary-action pressable" onClick={() => open(r.id)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="secondary-action pressable danger"
                    disabled={act.busy || r.liveAssignments > 0}
                    title={r.liveAssignments > 0 ? 'End its assignments first' : undefined}
                    onClick={() => act.run(() => deleteRole({ idempotencyKey: key(), roleId: r.id }, o), roles.refresh)}
                  >
                    Delete
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {editing !== null ? (
        <form
          className="admin-card admin-form"
          onSubmit={(e) => {
            e.preventDefault();
            const bounds = editing === 'new' ? new Map() : existingBounds(editing);
            const permissions = [...codes].sort().map((code) => ({ code, bound: bounds.get(code) ?? null }));
            act.run(
              () =>
                editing === 'new'
                  ? createRole({ idempotencyKey: key(), name: name.trim(), permissions }, o)
                  : updateRole({ idempotencyKey: key(), roleId: editing, name: name.trim(), permissions }, o),
              () => {
                setEditing(null);
                roles.refresh();
              },
            );
          }}
        >
          <label className="admin-field">
            <span>Role name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          {[...byDomain.entries()].map(([domain, perms]) => (
            <fieldset key={domain} className="admin-perms">
              <legend>{domain}</legend>
              {perms.map((p) => (
                <label key={p.code} className="admin-perm">
                  <input
                    type="checkbox"
                    checked={codes.has(p.code)}
                    onChange={(e) => {
                      const next = new Set(codes);
                      if (e.target.checked) next.add(p.code);
                      else next.delete(p.code);
                      setCodes(next);
                    }}
                  />
                  <span>
                    <code>{p.code}</code> {p.description}
                    {p.isSensitive ? ' · sensitive' : ''}
                    {p.offlineMode === 'always' ? ' · works offline' : p.offlineMode === 'never' ? ' · online only' : ''}
                  </span>
                </label>
              ))}
            </fieldset>
          ))}
          <div className="admin-actions">
            <button type="submit" className="primary-action pressable" disabled={act.busy || name.trim() === ''}>
              Save role
            </button>
            <button type="button" className="secondary-action pressable" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
