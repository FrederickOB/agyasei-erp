/**
 * The back-office administration reads and writes (apps/api/src/routers/
 * admin.ts). ONLINE ONLY, every one: users, roles and devices are
 * configuration, never trade, and a refusal offline is the honest answer.
 *
 * Inputs are the shared `@erp/contracts` schemas, proven before they leave the
 * device. No input carries a tenant — the server takes it from the session.
 */
import {
  assignRoleInput,
  createRoleInput,
  createUserInput,
  deleteRoleInput,
  endAssignmentInput,
  issueEnrolmentCodeInput,
  revokeDeviceInput,
  setDeviceScopeInput,
  setDeviceStatusInput,
  setUserStatusInput,
  updateRoleInput,
  type AssignRoleInput,
  type CreateRoleInput,
  type CreateUserInput,
  type DeleteRoleInput,
  type EndAssignmentInput,
  type IssueEnrolmentCodeInput,
  type RevokeDeviceInput,
  type SetDeviceScopeInput,
  type SetDeviceStatusInput,
  type SetUserStatusInput,
  type UpdateRoleInput,
} from '@erp/contracts';
import {
  apiMutate,
  apiQuery,
  asArray,
  asBoolean,
  asCount,
  asOptionalString,
  asRecord,
  asString,
  type ApiCallOptions,
  type ApiResult,
} from './client';
import { guard } from './guard';

export interface AdminLocation {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly parentId: string | null;
}

export interface AdminAssignment {
  readonly id: string;
  readonly roleId: string;
  readonly roleName: string;
  readonly isOwnerRole: boolean;
  readonly scopeLocationId: string;
  readonly scopeName: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly live: boolean;
}

export interface AdminUser {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly status: string;
  readonly linkedToIdentityProvider: boolean;
  readonly subjectRef: string | null;
  readonly openSessions: number;
  readonly assignments: readonly AdminAssignment[];
}

export interface AdminRole {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly isOwner: boolean;
  readonly liveAssignments: number;
  readonly permissions: readonly { readonly code: string; readonly bound: string | null }[];
}

export interface AdminPermission {
  readonly code: string;
  readonly domain: string;
  readonly description: string;
  readonly isSensitive: boolean;
  readonly offlineMode: string;
}

export interface AdminDevice {
  readonly id: string;
  readonly label: string;
  readonly formFactor: string;
  readonly status: string;
  readonly retiredReason: string | null;
  readonly lastSeenAt: string | null;
  readonly openSessions: number;
  readonly locations: readonly { readonly id: string; readonly name: string }[];
}

export interface IssuedCode {
  readonly codeId: string;
  readonly expiresAt: string;
  /** Null on a replay: the plaintext existed once and was not stored. */
  readonly code: string | null;
}

const mapLocations = (json: unknown): AdminLocation[] =>
  asArray(json, 'admin.locations').map((v, i) => {
    const r = asRecord(v, `admin.locations[${i}]`);
    return {
      id: asString(r['id'], 'id'),
      code: asString(r['code'], 'code'),
      name: asString(r['name'], 'name'),
      kind: asString(r['kind'], 'kind'),
      parentId: asOptionalString(r['parentId'], 'parentId'),
    };
  });

const mapUsers = (json: unknown): AdminUser[] =>
  asArray(json, 'admin.users.list').map((v, i) => {
    const r = asRecord(v, `users[${i}]`);
    return {
      id: asString(r['id'], 'id'),
      username: asString(r['username'], 'username'),
      displayName: asString(r['displayName'], 'displayName'),
      status: asString(r['status'], 'status'),
      linkedToIdentityProvider: asBoolean(r['linkedToIdentityProvider'], 'linked'),
      subjectRef: asOptionalString(r['subjectRef'], 'subjectRef'),
      openSessions: asCount(r['openSessions'], 'openSessions'),
      assignments: asArray(r['assignments'], 'assignments').map((a, j) => {
        const x = asRecord(a, `assignments[${j}]`);
        return {
          id: asString(x['id'], 'id'),
          roleId: asString(x['roleId'], 'roleId'),
          roleName: asString(x['roleName'], 'roleName'),
          isOwnerRole: asBoolean(x['isOwnerRole'], 'isOwnerRole'),
          scopeLocationId: asString(x['scopeLocationId'], 'scopeLocationId'),
          scopeName: asString(x['scopeName'], 'scopeName'),
          effectiveFrom: asString(x['effectiveFrom'], 'effectiveFrom'),
          effectiveTo: asOptionalString(x['effectiveTo'], 'effectiveTo'),
          live: asBoolean(x['live'], 'live'),
        };
      }),
    };
  });

const mapRoles = (json: unknown): AdminRole[] =>
  asArray(json, 'admin.roles.list').map((v, i) => {
    const r = asRecord(v, `roles[${i}]`);
    return {
      id: asString(r['id'], 'id'),
      name: asString(r['name'], 'name'),
      description: asString(r['description'], 'description'),
      isOwner: asBoolean(r['isOwner'], 'isOwner'),
      liveAssignments: asCount(r['liveAssignments'], 'liveAssignments'),
      permissions: asArray(r['permissions'], 'permissions').map((p, j) => {
        const x = asRecord(p, `permissions[${j}]`);
        return { code: asString(x['code'], 'code'), bound: asOptionalString(x['bound'], 'bound') };
      }),
    };
  });

const mapCatalogue = (json: unknown): AdminPermission[] =>
  asArray(json, 'admin.catalogue').map((v, i) => {
    const r = asRecord(v, `catalogue[${i}]`);
    return {
      code: asString(r['code'], 'code'),
      domain: asString(r['domain'], 'domain'),
      description: asString(r['description'], 'description'),
      isSensitive: asBoolean(r['isSensitive'], 'isSensitive'),
      offlineMode: asString(r['offlineMode'], 'offlineMode'),
    };
  });

const mapDevices = (json: unknown): AdminDevice[] =>
  asArray(json, 'admin.devices.list').map((v, i) => {
    const r = asRecord(v, `devices[${i}]`);
    return {
      id: asString(r['id'], 'id'),
      label: asString(r['label'], 'label'),
      formFactor: asString(r['formFactor'], 'formFactor'),
      status: asString(r['status'], 'status'),
      retiredReason: asOptionalString(r['retiredReason'], 'retiredReason'),
      lastSeenAt: asOptionalString(r['lastSeenAt'], 'lastSeenAt'),
      openSessions: asCount(r['openSessions'], 'openSessions'),
      locations: asArray(r['locations'], 'locations').map((l, j) => {
        const x = asRecord(l, `locations[${j}]`);
        return { id: asString(x['id'], 'id'), name: asString(x['name'], 'name') };
      }),
    };
  });

const mapIssued = (json: unknown): IssuedCode => {
  const r = asRecord(json, 'admin.devices.issueCode');
  return {
    codeId: asString(r['codeId'], 'codeId'),
    expiresAt: asString(r['expiresAt'], 'expiresAt'),
    code: asOptionalString(r['code'], 'code'),
  };
};

const ack = (json: unknown): true => {
  asRecord(json, 'admin ack');
  return true;
};

export const fetchAdminLocations = (o: ApiCallOptions = {}): Promise<ApiResult<AdminLocation[]>> =>
  apiQuery('admin.locations', undefined, mapLocations, o);
export const fetchAdminUsers = (o: ApiCallOptions = {}): Promise<ApiResult<AdminUser[]>> =>
  apiQuery('admin.users.list', undefined, mapUsers, o);
export const fetchAdminRoles = (o: ApiCallOptions = {}): Promise<ApiResult<AdminRole[]>> =>
  apiQuery('admin.roles.list', undefined, mapRoles, o);
export const fetchAdminCatalogue = (o: ApiCallOptions = {}): Promise<ApiResult<AdminPermission[]>> =>
  apiQuery('admin.catalogue', undefined, mapCatalogue, o);
export const fetchAdminDevices = (o: ApiCallOptions = {}): Promise<ApiResult<AdminDevice[]>> =>
  apiQuery('admin.devices.list', undefined, mapDevices, o);

function mutate<I>(schema: Parameters<typeof guard>[0], path: string, input: I, o: ApiCallOptions): Promise<ApiResult<true>> {
  const bad = guard(schema, path, input);
  if (bad !== null) return Promise.resolve(bad);
  return apiMutate(path, input, ack, o);
}

export const createUser = (i: CreateUserInput, o: ApiCallOptions = {}) => mutate(createUserInput, 'admin.users.create', i, o);
export const setUserStatus = (i: SetUserStatusInput, o: ApiCallOptions = {}) => mutate(setUserStatusInput, 'admin.users.setStatus', i, o);
export const assignRole = (i: AssignRoleInput, o: ApiCallOptions = {}) => mutate(assignRoleInput, 'admin.users.assignRole', i, o);
export const endAssignment = (i: EndAssignmentInput, o: ApiCallOptions = {}) => mutate(endAssignmentInput, 'admin.users.endAssignment', i, o);
export const createRole = (i: CreateRoleInput, o: ApiCallOptions = {}) => mutate(createRoleInput, 'admin.roles.create', i, o);
export const updateRole = (i: UpdateRoleInput, o: ApiCallOptions = {}) => mutate(updateRoleInput, 'admin.roles.update', i, o);
export const deleteRole = (i: DeleteRoleInput, o: ApiCallOptions = {}) => mutate(deleteRoleInput, 'admin.roles.delete', i, o);
export const revokeDevice = (i: RevokeDeviceInput, o: ApiCallOptions = {}) => mutate(revokeDeviceInput, 'admin.devices.revoke', i, o);
export const setDeviceStatus = (i: SetDeviceStatusInput, o: ApiCallOptions = {}) => mutate(setDeviceStatusInput, 'admin.devices.setStatus', i, o);
export const setDeviceScope = (i: SetDeviceScopeInput, o: ApiCallOptions = {}) => mutate(setDeviceScopeInput, 'admin.devices.setScope', i, o);

export function issueEnrolmentCode(i: IssueEnrolmentCodeInput, o: ApiCallOptions = {}): Promise<ApiResult<IssuedCode>> {
  const bad = guard(issueEnrolmentCodeInput, 'admin.devices.issueCode', i);
  if (bad !== null) return Promise.resolve(bad);
  return apiMutate('admin.devices.issueCode', i, mapIssued, o);
}
