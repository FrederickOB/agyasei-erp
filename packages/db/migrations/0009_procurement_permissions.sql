-- ============================================================================
-- 0009_procurement_permissions.sql — the eight capabilities Phase 2 adds to
-- the GLOBAL permission catalogue.
--
-- Written in migration 0005's style and for 0005's reasons, which are worth
-- re-reading before adding a ninth: `platform.permission` is GLOBAL, has no
-- tenant_id, and a tenant composes codes but can never mint one. A
-- tenant-scoped catalogue would let a tenant invent `purchase.order.self_approve`,
-- grant it, watch it resolve, and hold a permission that guards nothing.
-- Adding a capability is a PLATFORM MIGRATION — this file — reviewed by a
-- human, exactly like adding the endpoint that checks it.
--
-- 0005 IS NEVER EDITED. It has been applied to running databases; a migration
-- is a historical fact, not a document.
--
-- The catalogue is mirrored in `packages/db/src/permissions.ts`
-- (PERMISSION_CODES). `catalogueDrift()` in that package's suite fails if the
-- two ever disagree — which is how a code that exists in one place and is
-- checked in the other gets caught, per §0 row 6 of docs/phase1-status.md
-- ("the permission string was asserted against itself").
--
-- ---------------------------------------------------------------------------
-- THE ONE CONTROL THIS FILE EXISTS FOR: APPROVING IS NOT RECEIVING
-- ---------------------------------------------------------------------------
-- `purchase.order.approve` and `goods.receive` are separate capabilities and
-- must stay separate. One person who can both authorise a purchase order and
-- sign for its goods can fabricate a receipt against an order they invented,
-- and the stock ledger will faithfully record inventory that never arrived
-- while accounts payable faithfully pays for it. Splitting the two is the
-- standard control against exactly that, and it costs a row.
--
-- The SCHEMA supports the control (migration 0008 refuses a receipt against
-- anything but an APPROVED or PARTIALLY_RECEIVED order, and refuses a PO
-- created at APPROVED). The CATALOGUE makes it grantable. The TEMPLATE
-- (packages/db/src/seed/roles.ts) puts the two in different roles, and — the
-- part that matters — none of that is a branch on a role name. A tenant whose
-- org chart genuinely puts both in one job composes them into one role and
-- the system works; the platform does not police a tenant's org chart, it
-- guarantees the capability is only ever reachable through a check.
--
-- ---------------------------------------------------------------------------
-- WHY `goods.receive` RATHER THAN REUSING `stock.receive`
-- ---------------------------------------------------------------------------
-- They guard different acts and the boundary matters, so a later router must
-- not pick whichever comes to hand:
--
--   `stock.receive` (0005)  — write a RECEIPT-kind movement DIRECTLY into the
--                             ledger: an opening balance, a correction, stock
--                             that arrived with no document. Guarded on
--                             `inventory.recordMovement`.
--   `goods.receive` (here)  — post a GOODS RECEIPT DOCUMENT, matched against
--                             a purchase order, which then appends the
--                             movements itself. Guarded on the receiving
--                             router.
--
-- The document path is the audited one; the direct path is the escape hatch.
-- A role may hold either, both, or neither.
--
-- Codes are NEUTRAL: no tenant #1 vocabulary appears in any of them, because
-- a code is platform surface and a tenant's supply chain is not.
-- ============================================================================

insert into platform.permission
  (code, domain, description, is_sensitive, requires_fresh_authorization, bound_schema)
values
  -- supplier -----------------------------------------------------------------
  ('supplier.view', 'supplier',
   'Read suppliers, their capabilities, and which of them can supply a product.',
   false, false, null),
  -- Sensitive: payment terms and the preferred source are commercial terms,
  -- and whoever can edit them can redirect spend.
  ('supplier.manage', 'supplier',
   'Create and edit suppliers, their capabilities, payment terms and product supply records.',
   true, false, null),

  -- purchase -----------------------------------------------------------------
  ('purchase.order.view', 'purchase',
   'Read purchase orders and what remains outstanding on them.', false, false, null),
  ('purchase.order.create', 'purchase',
   'Raise a purchase order and edit it while it is a draft.', false, false, null),
  -- Sensitive and bounded: approval is the commitment. The bound is an order
  -- value ceiling, expressed exactly like the one on sale.record.credit — money inside
  -- jsonb is a DECIMAL STRING, never a JSON number (ADR-0004).
  ('purchase.order.approve', 'purchase',
   'Approve a purchase order up to a bounded order value, committing the business to the spend.',
   true, false,
   '{"max_order_value_minor":"decimal string, minor units"}'::jsonb),

  -- goods --------------------------------------------------------------------
  -- Deliberately NOT the same capability as purchase.order.approve. See the
  -- header: one person holding both can fabricate a receipt against an order
  -- they invented.
  ('goods.receive', 'goods',
   'Post a goods receipt against a purchase order, recording what was invoiced and what entered the yard.',
   true, false, null),

  -- logistics ----------------------------------------------------------------
  ('logistics.delivery.view', 'logistics',
   'Read deliveries and their status — where a customer''s goods are.', false, false, null),
  ('logistics.dispatch.manage', 'logistics',
   'Plan a delivery with a haulier, dispatch it, and record its delivery status.',
   false, false, null)
on conflict (code) do nothing;
