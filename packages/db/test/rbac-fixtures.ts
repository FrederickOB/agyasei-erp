/**
 * Fixtures for the access-control suites. Everything runs through the
 * tenant's own RLS context, as app_user — the same path production takes.
 */
import { uuidv7 } from '../src/ids.js';
import type { Bound, PermissionCode } from '../src/permissions.js';
import type { Queryable } from '../src/testing/harness.js';
import { newWrite, nextHlc } from './util.js';

export interface LocationSpec {
  code: string;
  name?: string;
  kind?: 'OUTLET' | 'WAREHOUSE' | 'GROUP' | 'TRANSIT';
  parentId?: string | null;
}

export async function makeLocation(
  tx: Queryable,
  tenantId: string,
  spec: LocationSpec,
): Promise<string> {
  const id = uuidv7();
  const w = await newWrite(tx, tenantId, 'test.location');
  await tx.query(
    `insert into app.location
       (tenant_id, id, write_id, hlc, code, name, kind, parent_id, timezone)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'Africa/Accra')`,
    [
      tenantId,
      id,
      w,
      nextHlc(),
      spec.code,
      spec.name ?? spec.code,
      spec.kind ?? 'OUTLET',
      spec.parentId ?? null,
    ],
  );
  return id;
}

export async function makeUser(
  tx: Queryable,
  tenantId: string,
  username: string,
  status: 'ACTIVE' | 'SUSPENDED' | 'DISABLED' = 'ACTIVE',
): Promise<string> {
  const id = uuidv7();
  const w = await newWrite(tx, tenantId, 'test.user');
  await tx.query(
    `insert into app.user_account
       (tenant_id, id, write_id, hlc, username, display_name, status)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, id, w, nextHlc(), username, username, status],
  );
  return id;
}

export interface RoleSpec {
  name: string;
  isOwner?: boolean;
  permissions?: readonly { code: PermissionCode | string; bound?: Bound }[];
}

export async function makeRole(tx: Queryable, tenantId: string, spec: RoleSpec): Promise<string> {
  const id = uuidv7();
  const w = await newWrite(tx, tenantId, 'test.role');
  await tx.query(
    `insert into app.role (tenant_id, id, write_id, hlc, name, description, is_owner)
     values ($1, $2, $3, $4, $5, '', $6)`,
    [tenantId, id, w, nextHlc(), spec.name, spec.isOwner ?? false],
  );
  for (const perm of spec.permissions ?? []) {
    await tx.query(
      `insert into app.role_permission
         (tenant_id, id, write_id, hlc, role_id, permission_code, bound)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        tenantId,
        uuidv7(),
        w,
        nextHlc(),
        id,
        perm.code,
        perm.bound ? JSON.stringify(perm.bound) : null,
      ],
    );
  }
  return id;
}

export async function assignRole(
  tx: Queryable,
  tenantId: string,
  args: {
    userId: string;
    roleId: string;
    scopeLocationId: string;
    effectiveFrom?: string;
    effectiveTo?: string | null;
  },
): Promise<string> {
  const id = uuidv7();
  const w = await newWrite(tx, tenantId, 'test.assign');
  await tx.query(
    `insert into app.user_role_assignment
       (tenant_id, id, write_id, hlc, user_id, role_id, scope_location_id,
        effective_from, effective_to)
     values ($1, $2, $3, $4, $5, $6, $7,
             coalesce($8::timestamptz, transaction_timestamp()), $9::timestamptz)`,
    [
      tenantId,
      id,
      w,
      nextHlc(),
      args.userId,
      args.roleId,
      args.scopeLocationId,
      args.effectiveFrom ?? null,
      args.effectiveTo ?? null,
    ],
  );
  return id;
}
