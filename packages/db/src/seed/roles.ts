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
 * THE RESIDENCY RULE — `credit.view` IS NOT A READ ANY MORE
 * ---------------------------------------------------------------------------
 * Migration 0013 gave `credit.view` a second meaning. It still authorises the
 * ONLINE read the server answers one account at a time and can refuse the next
 * second; it ALSO decides membership of `app.credit_sync_book_scope`, and
 * therefore whether a device downloads ~400 days of every credit customer's
 * balance, ageing and payment history — and KEEPS it, on hardware whose threat
 * model is physical possession.
 *
 * `02-security-and-access-control` §2.5: THE RIGHT TO SEE SOMETHING IS NOT THE
 * RIGHT TO HAVE IT ON YOUR DEVICE. `docs/credit-offline-plan.md` R1.b names the
 * consequence — "`credit.view` must never be in the counter-staff or
 * outlet-manager template role" — and §2's own template table gives `credit.read`
 * (this catalogue's `credit.view`) to Accounts and to nobody else.
 *
 * So in this template `credit.view` sits in ACCOUNTS only, plus the owner role,
 * which holds the whole catalogue by construction and is the audited escalation
 * path. A counter or outlet device asks the server; a back-office device holds
 * the book.
 *
 * WHAT AN OUTLET MANAGER GETS INSTEAD, and the honest gap: at the till the
 * question is never "what is this customer's balance", it is "what may I lend
 * this customer here, now" — which is `credit_allowance` / the
 * `location_credit_allowance` bucket, gated on `sale.record.credit` at that
 * location (R1.a), a strictly narrower disclosure with no limit, balance,
 * ageing or history in it. That table is deliberately unpopulated until
 * 06 §6.7's cap leases exist. Until it is, an outlet manager rings a credit
 * sale without a headroom figure in front of them and learns the answer from
 * the server's refusal, which names the bound. That is a usability cost, not a
 * correctness one — `sales.createSale` has always enforced the bound and the
 * account status server-side — and it is the right side to be wrong on while
 * the narrower read is built.
 *
 * NOTE FOR ANYONE EDITING THIS FILE: nothing in the database stops a tenant
 * granting `credit.view` to whatever role it likes, and nothing should — the
 * platform does not police a tenant's org chart (CLAUDE.md §2.9). What is
 * guarded is THIS FILE, by `rbac-template.test.ts`: re-adding the code to the
 * counter-staff or outlet-manager role turns that suite red and says why.
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
    // "Where is my cement?" is a counter question, so the counter can answer
    // it. Reading a delivery's status exposes no commercial terms — unlike
    // supplier.view, which carries payment terms and is deliberately absent.
    { code: 'logistics.delivery.view' },
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
    { code: 'report.view.location' },
    { code: 'admin.device.enrol' },
    // ...and REVOKE them, at their own outlet. A tablet that walks out of the
    // yard must be stoppable by the person standing in the yard, not only by
    // the founder — revocation speed is the security property (02 §2.7). The
    // grant is location-scoped like every other: a manager at Techiman cannot
    // revoke Wenchi's tablets. Widening a device's scope
    // (admin.device.scope.manage) stays with the owner role.
    { code: 'admin.device.revoke' },
    // Procurement, from the yard's side: raise the order for what their
    // outlet is running out of, sign for what the truck brings, and book a
    // haulier to take goods to a customer's site.
    { code: 'supplier.view' },
    { code: 'purchase.order.view' },
    { code: 'purchase.order.create' },
    { code: 'goods.receive' },
    { code: 'logistics.delivery.view' },
    { code: 'logistics.dispatch.manage' },
    // DELIBERATELY ABSENT: credit.view — see THE RESIDENCY RULE in the header.
    // The manager sells on credit up to the bound above; they do not hold the
    // book. Also absent: credit.limit.change (the brief), sale.override_price,
    // and — new with Phase 2 — purchase.order.approve. The person who raises
    // an order and signs for its goods must not also be the person who
    // authorises the spend; that separation is the standard control against a
    // fabricated receipt, and it is the reason approval sits a level up.
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
    // `goods.receive` is filtered OUT, and that is the whole segregation:
    // this role APPROVES purchase orders, so it must not also be able to sign
    // for the goods against one. Both halves in one pair of hands is how a
    // receipt gets fabricated against an order that was invented — the stock
    // ledger records inventory that never arrived and accounts payable pays
    // for it. The outlet manager at the receiving yard signs; this role does
    // not. A tenant whose org chart differs composes its own role; nothing on
    // the platform reads either role's name.
    ...OUTLET_MANAGER.permissions.filter(
      (p) => p.code !== 'sale.record.credit' && p.code !== 'goods.receive',
    ),
    { code: 'sale.record.credit', bound: { max_order_value_minor: '2000000' } }, // GH₵20,000
    { code: 'report.view.margin' },
    { code: 'sync.conflict.review' },
    // Bounded exactly like a credit sale is: approval is a commitment, and
    // the ceiling is a decimal STRING in minor units (ADR-0004).
    { code: 'purchase.order.approve', bound: { max_order_value_minor: '5000000' } }, // GH₵50,000
    // DELIBERATELY ABSENT: credit.view — inherited by the filter above, and
    // stated here so nobody re-adds it thinking the omission was an accident
    // of the spread. A regional manager carries a tablet across six regions;
    // that is a field device, not a back office, and the residency rule in the
    // header applies to it at least as strongly as to an outlet. Also absent:
    // credit.limit.change, sale.override_price, goods.receive.
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
    // The books. CLAUDE.md's role sketch puts "GL review" here and nowhere
    // else; the owner role reaches it through the owner expansion.
    { code: 'gl.view' },
    // Accounts owns the supplier master file, because payment terms are an
    // AP fact, and approves the spend — unbounded, unlike the regional
    // manager's ceiling.
    { code: 'supplier.view' },
    { code: 'supplier.manage' },
    { code: 'purchase.order.view' },
    { code: 'purchase.order.approve' },
    { code: 'logistics.delivery.view' },
    // DELIBERATELY ABSENT: sale.record, stock.adjust, sale.override_price,
    // and — the segregation again, from the other side — goods.receive and
    // purchase.order.create. Accounts approves and pays; it does not raise
    // the order and it does not sign for the goods.
  ],
};

export const TEMPLATE_ROLES: readonly TemplateRole[] = [
  COUNTER_STAFF,
  OUTLET_MANAGER,
  REGIONAL_MANAGER,
  HEAD_OF_OPERATIONS,
  ACCOUNTS,
];
