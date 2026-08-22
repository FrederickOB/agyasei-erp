/**
 * The five roles that ship with the "construction-materials-gh" template.
 *
 * THIS FILE IS DATA, NOT LOGIC (ADR-0006; CLAUDE.md §2.9). It is applied once
 * at onboarding by applyTemplate(), producing ORDINARY EDITABLE ROWS in
 * app.role / app.role_permission. Afterwards the tenant owns them: rename
 * them, delete them, compose new ones. There is no live inheritance, no
 * "reset to template", and — the part that matters — NO PLATFORM CODE
 * ANYWHERE READS A ROLE NAME. A different distributor with a different org
 * chart seeds a different template, or edits these, and every check in the
 * system keeps working because every check asks about a PERMISSION CODE.
 *
 * ---------------------------------------------------------------------------
 * THE TWO HARD PROHIBITIONS, AS DATA
 * ---------------------------------------------------------------------------
 * The brief requires that counter staff genuinely cannot override a price and
 * genuinely cannot change a credit limit. Look at COUNTER_STAFF below: it
 * simply does not list `sale.override_price` or `credit.limit.change`. That
 * absence IS the enforcement. There is no `if (role === 'counter staff')`
 * anywhere, because "counter staff" is a string this tenant chose, and the
 * next tenant may quite legitimately let their counter staff discount — which
 * they express by adding a row, not by us shipping a patch.
 *
 * The prohibitions therefore survive the things that usually break this kind
 * of rule: renaming the role, cloning it, adding a sixth role, or a tenant in
 * another country with a completely different hierarchy.
 *
 * ---------------------------------------------------------------------------
 * BOUNDS
 * ---------------------------------------------------------------------------
 * "Credit sales up to a set limit" is a BOUND on `sale.record.credit`, not a
 * special-case column and not a separate permission per tier. Money in a
 * bound is a DECIMAL STRING in the currency's minor unit (ADR-0004) — a
 * JSON number is a float64 the moment it is parsed.
 *
 * The bound deliberately carries NO currency code: currency and minor-unit
 * scale are the jurisdiction pack's (CLAUDE.md §2.5), and duplicating them
 * into a role row would create a second place for them to be wrong.
 */
import type { Bound, PermissionCode } from '../permissions.js';

export interface TemplateRolePermission {
  code: PermissionCode;
  bound?: Bound;
}

export interface TemplateRole {
  /** Stable provenance key. Never read by business logic (01 §1.6). */
  ref: string;
  /** The tenant's word for the tenant's job. Editable. Never branched on. */
  name: string;
  description: string;
  /**
   * The one flag the platform reads — a capability statement, not a name.
   * An owner role holds the entire catalogue by construction, so it needs no
   * permission rows and cannot drift out of date when the platform adds a
   * capability (02 §2.4).
   */
  isOwner: boolean;
  permissions: readonly TemplateRolePermission[];
}

/** Counter and yard staff: sell, look stock up, receive a transfer. */
const COUNTER_STAFF: TemplateRole = {
  ref: 'counter_staff',
  name: 'Counter & yard staff',
  description:
    'Sells at the counter and in the yard, looks up stock and prices, receives inbound transfers. No price overrides, no credit limit changes.',
  isOwner: false,
  permissions: [
    { code: 'sale.record' },
    // Bound to zero: the capability exists so a manager can raise it for one
    // person without inventing a new role. Until then it authorises nothing.
    { code: 'sale.record.credit', bound: { max_order_value_minor: '0' } },
    { code: 'sale.receipt.reprint' },
    { code: 'sale.view' },
    { code: 'stock.view' },
    { code: 'stock.transfer.receive' },
    { code: 'catalogue.view' },
    { code: 'customer.view' },
    // DELIBERATELY ABSENT: sale.override_price, credit.limit.change.
  ],
};

/** Outlet manager / supervisor: the counter set, plus the local controls. */
const OUTLET_MANAGER: TemplateRole = {
  ref: 'outlet_manager',
  name: 'Outlet manager',
  description:
    'Runs one location: stock adjustments and counts, local reporting, customer records, discounts and credit sales within a limit.',
  isOwner: false,
  permissions: [
    { code: 'sale.record' },
    { code: 'sale.record.credit', bound: { max_order_value_minor: '500000' } }, // GH₵5,000
    { code: 'sale.discount.apply', bound: { max_bps: 300 } }, // 3%
    { code: 'sale.void' },
    { code: 'sale.view' },
    { code: 'sale.receipt.reprint' },
    { code: 'stock.view' },
    { code: 'stock.adjust' },
    { code: 'stock.transfer' },
    { code: 'stock.transfer.receive' },
    { code: 'stock.receive' },
    { code: 'stock.count.perform' },
    // Sets the low-stock threshold for their own location's SKUs. The person
    // who lives with the stock-out is the person who tunes the alert; a
    // tenant that wants that centralised removes this row.
    { code: 'stock.reorder.manage' },
    { code: 'catalogue.view' },
    { code: 'customer.view' },
    { code: 'customer.manage' },
    { code: 'credit.view' },
    { code: 'report.view.location' },
    { code: 'admin.device.enrol' },
    // DELIBERATELY ABSENT: credit.limit.change (the brief), sale.override_price.
  ],
};

/**
 * Regional manager — arrives around FY3 with the governance layer, but the
 * ROLE exists from day one. Note what makes it regional: NOTHING in this
 * list. It is the same kind of permission set, held at a REGION NODE instead
 * of a leaf, and the closure tree expands it over every location underneath.
 * Adding regional management in FY3 is two INSERTs, not a migration of the
 * authorization model on top of live books (02 §2.5).
 */
const REGIONAL_MANAGER: TemplateRole = {
  ref: 'regional_manager',
  name: 'Regional manager',
  description:
    'Runs a group of locations: everything an outlet manager does, at every location under their node, plus margin visibility and sync conflict review.',
  isOwner: false,
  permissions: [
    ...OUTLET_MANAGER.permissions.filter((p) => p.code !== 'sale.record.credit'),
    { code: 'sale.record.credit', bound: { max_order_value_minor: '2000000' } }, // GH₵20,000
    { code: 'report.view.margin' },
    { code: 'sync.conflict.review' },
    // DELIBERATELY ABSENT: credit.limit.change, sale.override_price.
  ],
};

/**
 * Head of operations / founder. The visible escalation path: holds every
 * capability the software has, including the two the brief restricts, and
 * every act is audited with the grant that authorised it. A system with no
 * such role has a back door instead.
 */
const HEAD_OF_OPERATIONS: TemplateRole = {
  ref: 'head_of_operations',
  name: 'Head of operations',
  description:
    'Full visibility and override across the network. Holds the entire permission catalogue by construction; every use is audited.',
  isOwner: true,
  permissions: [], // by construction — see app.effective_permission arm (b)
};

/**
 * Accounts. Note that Accounts DOES hold `credit.limit.change`: the brief
 * restricts counter staff, not the capability. Note also what it does not
 * hold — sale.record, stock.adjust — because segregation of duties is the
 * whole reason this is a separate role.
 */
const ACCOUNTS: TemplateRole = {
  ref: 'accounts',
  name: 'Accounts',
  description:
    'Customer credit, AP/AR, GL review and the payroll register. Reads the whole tenant; records nothing at the counter.',
  isOwner: false,
  permissions: [
    { code: 'catalogue.view' },
    { code: 'sale.view' },
    { code: 'customer.view' },
    { code: 'customer.manage' },
    { code: 'credit.view' },
    { code: 'credit.account.manage' },
    { code: 'credit.limit.change' },
    { code: 'credit.entry.record' },
    { code: 'credit.fee.accrue' },
    { code: 'credit.policy.manage' },
    { code: 'report.view.location' },
    { code: 'report.view.tenant' },
    { code: 'report.view.margin' },
    // Capture and export only. No statutory computation exists to permit
    // (CLAUDE.md §2.4) — the register goes out, the bureau's figures come
    // back into marked fields, and net pay is entered, never calculated.
    { code: 'payroll.register.export' },
    { code: 'payroll.register.import' },
    { code: 'sync.conflict.review' },
    // DELIBERATELY ABSENT: sale.record, stock.adjust, sale.override_price.
  ],
};

export const TEMPLATE_ROLES: readonly TemplateRole[] = [
  COUNTER_STAFF,
  OUTLET_MANAGER,
  REGIONAL_MANAGER,
  HEAD_OF_OPERATIONS,
  ACCOUNTS,
];
