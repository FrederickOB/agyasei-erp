-- ============================================================================
-- 0016 — POSTING ROLES, ACCOUNT MAPPINGS, AND THE POSTING EXCEPTION
--
-- Phase 3 Track A, second slice. Migration 0015 made a journal possible; this
-- makes it possible to say WHICH ACCOUNT a rule's line lands on, without
-- letting a tenant edit the rules themselves.
--
-- ── THE SPLIT THIS FILE EXISTS TO ENFORCE (05 §5.6.1, decision 8) ──────────
--   RULES are platform code, versioned by `posting_rule_version`. A cash sale
--   debits TILL_CASH and credits SALES_REVENUE and OUTPUT_TAX — always, for
--   every tenant, in every jurisdiction.
--   MAPPINGS are tenant configuration: which of the tenant's own accounts each
--   posting ROLE resolves to.
--
-- A tenant-editable rule engine is deliberately NOT built. It is the fastest
-- way to let a non-accountant produce a ledger that books revenue to a
-- liability, and the platform then owns the consequences.
--
-- ── STILL NO CONTENT ──────────────────────────────────────────────────────
-- Zero mapping rows. Zero accounts. The role CATALOGUE is seeded, and that is
-- deliberately not content: a catalogue row binds a role to an ACCOUNT TYPE
-- ('SALES_REVENUE must resolve to an INCOME account'), names no tenant's
-- account, carries no tenant_id, and is the very constraint that stops a
-- mapping doing something an accountant would have to unpick. It is the
-- guardrail, not the thing being guarded.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- platform.posting_role_catalog — PLATFORM. No tenant_id, deliberately.
--
-- 05 §5.6.1's own correction: the section rejected a tenant-editable rule
-- engine because it "is the fastest way to let a non-accountant book revenue
-- to a liability", and then specified a mapping table that permitted exactly
-- that — SALES_REVENUE -> 2100 Accounts payable. This table is what makes the
-- rejection real.
-- ----------------------------------------------------------------------------
create table platform.posting_role_catalog (
  posting_role          text        primary key,
  description           text        not null,
  required_account_type text        not null,
  required_control_kind text,
  -- null = always required. Otherwise the role is only required when that
  -- feature is enabled for the tenant: a tenant with no credit product must
  -- not be forced to map facility-fee accounts it will never use, which an
  -- unconditional completeness check did.
  required_when_feature text,
  created_at            timestamptz not null default transaction_timestamp(),
  constraint prc_type check (
    required_account_type in ('ASSET','LIABILITY','EQUITY','INCOME','EXPENSE')),
  constraint prc_control check (
    required_control_kind is null
    or required_control_kind in ('AR','AP','INVENTORY','BANK','MOMO','TILL'))
);

comment on table platform.posting_role_catalog is
  'Platform-owned. A role binds to an ACCOUNT TYPE, never to a tenant account — that is the mapping (05 §5.6.1).';


-- ----------------------------------------------------------------------------
-- app.gl_account_mapping — the tenant's half. STRUCTURE ONLY; no rows here.
--
-- Resolution is MOST-SPECIFIC-FIRST: product_category -> location -> tenant
-- default. That covers "revenue split by product category" and "a different
-- bank account per region" without a rule editor.
--
-- Two mechanical notes from §5.6.1, both of which the first draft got wrong:
--
--  1. `primary key (..., coalesce(scope_id, uuid_nil()))` IS NOT VALID
--     POSTGRES — a primary key takes columns, not expressions, and uuid_nil()
--     needs an extension. Hence the generated `scope_key` column.
--  2. The mapping is VERSIONED AND EFFECTIVE-DATED. `posting_rule_version`
--     answered "which rules ran in March"; the mapping is the other half of
--     that answer and had no history at all, so the auditor's question was
--     unanswerable. `journal_entry.mapping_set_version` stamps both halves.
-- ----------------------------------------------------------------------------
create table app.gl_account_mapping (
  tenant_id           uuid        not null references platform.tenant (id),
  id                  uuid        not null,
  posting_role        text        not null references platform.posting_role_catalog (posting_role),
  scope_kind          text        not null,
  scope_id            uuid,
  -- The nil uuid stands in for "no scope" so the uniqueness below is a plain
  -- column constraint rather than an expression index.
  scope_key           uuid        not null generated always as
                        (coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)) stored,
  account_id          uuid        not null,
  mapping_set_version int         not null check (mapping_set_version >= 1),
  effective_from      date        not null,
  effective_to        date,
  created_at          timestamptz not null default transaction_timestamp(),
  updated_at          timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, id),
  unique (tenant_id, posting_role, scope_kind, scope_key, effective_from),
  foreign key (tenant_id, account_id) references app.gl_account (tenant_id, id),
  constraint gam_scope check (scope_kind in ('tenant','location','product_category')),
  -- A tenant-scoped mapping has no scope_id; any other kind must have one.
  constraint gam_scope_id check ((scope_kind = 'tenant') = (scope_id is null)),
  constraint gam_effective check (effective_to is null or effective_to > effective_from)
);
select app.apply_tenant_rls('app.gl_account_mapping');

create index gl_account_mapping_resolve
  on app.gl_account_mapping (tenant_id, posting_role, scope_kind, scope_key, effective_from desc);


-- ── The trigger §5.6.1 asks for, and the reason it is not optional. ────────
--
-- Without it the mapping table permits SALES_REVENUE -> 2100 Accounts payable:
-- a ledger that balances perfectly, a P&L with no revenue in it, and a balance
-- sheet with a liability that grows every time somebody sells a bag of cement.
-- Nothing else in this schema would notice.
create function app.gl_mapping_type_matches_role() returns trigger
language plpgsql as $$
declare
  v_role    record;
  v_account record;
begin
  select required_account_type, required_control_kind into v_role
    from platform.posting_role_catalog where posting_role = new.posting_role;

  select account_type, control_account_kind, is_postable, is_active into v_account
    from app.gl_account
   where tenant_id = new.tenant_id and id = new.account_id;

  if not found then
    raise exception 'GL0030: mapping names account % which does not exist in this tenant', new.account_id
      using errcode = 'integrity_constraint_violation';
  end if;

  if v_account.account_type <> v_role.required_account_type then
    raise exception
      'GL0031: posting role % must map to a % account; % is a % account',
      new.posting_role, v_role.required_account_type, new.account_id, v_account.account_type
      using errcode = 'integrity_constraint_violation';
  end if;

  if v_role.required_control_kind is not null
     and v_account.control_account_kind is distinct from v_role.required_control_kind then
    raise exception
      'GL0032: posting role % requires a % control account; % is %',
      new.posting_role, v_role.required_control_kind, new.account_id,
      coalesce(v_account.control_account_kind, 'not a control account')
      using errcode = 'integrity_constraint_violation';
  end if;

  -- A rule that resolved to a rollup would fail later at the journal_line FK,
  -- which is a correct refusal at the worst possible moment — mid-posting,
  -- after trade. Refusing the MAPPING moves it to configuration time.
  if not v_account.is_postable then
    raise exception 'GL0033: posting role % may not map to a rollup account (%)',
      new.posting_role, new.account_id
      using errcode = 'integrity_constraint_violation';
  end if;

  return new;
end
$$;

create trigger gl_account_mapping_type_check
  before insert or update on app.gl_account_mapping
  for each row execute function app.gl_mapping_type_matches_role();
alter table app.gl_account_mapping enable always trigger gl_account_mapping_type_check;


-- ----------------------------------------------------------------------------
-- app.posting_exception — the answer to "hard-fail at posting, then what?"
--
-- 05 §5.6.1 calls this "the largest hole the review found in this section", and
-- the scenario is worth restating because it decides the design:
--
--   Bawku trades offline for eight days. 300 sales arrive. Meanwhile an admin
--   retired an account, or a new product category was created with no COGS
--   mapping. The rule hard-fails. Then what?
--
--   * SYNCHRONOUS posting -> §3.3.4 dead-letters the mutation and THE SALE
--     NEVER LANDS AT ALL — not in stock, not in sales, not in the books —
--     while the customer holds the goods and a printed receipt. A direct
--     CLAUDE.md §2.2 violation on the GL's side of the boundary.
--   * ASYNCHRONOUS posting -> the document exists and no entry does, and
--     nothing detects it. The period closes clean with revenue missing.
--
-- RULING: acceptance and posting are separate, and a posting failure NEVER
-- rejects a settled document. Posting is asynchronous and the gap is made
-- VISIBLE rather than left implicit. This table is that visibility. It is a
-- close gate — zero unresolved exceptions dated in the period — and it feeds
-- the human review queue that migration 0006 built and Phase 3's predecessor
-- finally gave a reader.
-- ----------------------------------------------------------------------------
create table app.posting_exception (
  tenant_id       uuid        not null references platform.tenant (id),
  id              uuid        not null,
  source_kind     text        not null,
  source_id       uuid        not null,
  location_id     uuid        not null,
  document_date   date        not null,
  -- Which role could not be resolved, when that is the cause. NULL for
  -- failures that are not about a mapping.
  posting_role    text,
  error_code      text        not null,
  error_detail    text,
  severity        smallint    not null default 1 check (severity between 1 and 4),
  opened_at       timestamptz not null default transaction_timestamp(),
  resolved_at     timestamptz,
  resolved_by     uuid,
  resolution_note text,
  created_at      timestamptz not null default transaction_timestamp(),
  updated_at      timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, id),
  foreign key (tenant_id, location_id) references app.location (tenant_id, id),
  constraint pe_resolved check (
    (resolved_at is null) = (resolved_by is null)
    and (resolved_at is not null or resolution_note is null)),
  -- A resolution with no reason is a rubber stamp on a missing journal entry.
  constraint pe_resolution_reason check (resolved_at is null or resolution_note is not null)
);
select app.apply_tenant_rls('app.posting_exception');

-- ONE OPEN exception per document. A retry that fails the same way must
-- update the existing row rather than pile up a second, or the close gate
-- counts attempts instead of problems.
create unique index posting_exception_one_open
  on app.posting_exception (tenant_id, source_kind, source_id)
  where resolved_at is null;

create index posting_exception_by_period
  on app.posting_exception (tenant_id, document_date, resolved_at);


-- ============================================================================
-- THE ROLE CATALOGUE
--
-- Platform vocabulary. Every role a rule in 05 §5.6.2 emits, with the account
-- type it MUST resolve to. No tenant account is named anywhere below and no
-- row here carries a tenant_id — this is the constraint on configuration, not
-- configuration itself.
--
-- `required_when_feature` is null for roles every tenant needs. Where it is
-- set, the completeness check at onboarding only demands the role if that
-- feature is on, so a cash-only tenant is never asked to map AR.
-- ============================================================================
insert into platform.posting_role_catalog
  (posting_role, description, required_account_type, required_control_kind, required_when_feature)
values
  -- Sales (rules 1, 1b, 2, 3, 10)
  ('TILL_CASH',            'Physical cash held at a counter.',                    'ASSET',     'TILL',      null),
  ('MOMO_WALLET',          'Mobile-money float. A CASH account, not a payment method (05 §5.7.1).', 'ASSET', 'MOMO', 'MOBILE_MONEY'),
  ('SALES_REVENUE',        'Trade revenue, recognised gross of discount.',         'INCOME',    null,        null),
  ('SALES_DISCOUNT',       'Contra-income. Keeps gross sales recoverable from the books.', 'INCOME', null,   null),
  ('SALES_RETURNS',        'Contra-income for credit notes. Never negative revenue.', 'INCOME',  null,        null),
  ('OUTPUT_TAX',           'Tax collected on a sale. A LIABILITY, never revenue.', 'LIABILITY', null,        null),
  ('COGS',                 'Cost of goods sold, at moving weighted average.',      'EXPENSE',   null,        null),
  ('INVENTORY',            'Perpetual inventory at cost.',                         'ASSET',     'INVENTORY', null),
  -- Credit (rules 2, 4, 8, 8b)
  ('AR_TRADE',             'Trade receivables control.',                           'ASSET',     'AR',        'CREDIT_SALES'),
  ('FACILITY_FEE_AR',      'Facility fee receivable.',                             'ASSET',     'AR',        'FACILITY_FEE'),
  ('FACILITY_FEE_INCOME',  'Facility fee income. Tax treatment unset pending Q4.', 'INCOME',    null,        'FACILITY_FEE'),
  -- Purchasing (rules 5, 5b, 6c)
  ('GRNI',                 'Goods received not invoiced.',                         'LIABILITY', null,        null),
  ('AP_TRADE',             'Trade payables control.',                              'LIABILITY', 'AP',        null),
  ('INPUT_TAX',            'Recoverable tax on a purchase.',                       'ASSET',     null,        null),
  ('PPV',                  'Purchase price variance. A named variance, never a silent inventory adjustment.', 'EXPENSE', null, null),
  ('DISTRIBUTION_COST',    'Third-party haulage. Feeds the ADR-0001 metric.',      'EXPENSE',   null,        null),
  -- Movement between locations (rules 6, 6b, 4, 9b, 9c, 11a, 12)
  ('INTERLOC_CLEARING',    'Inter-location clearing. Sums to zero across the tenant.', 'ASSET',  null,        null),
  ('INVENTORY_IN_TRANSIT', 'Stock despatched and not yet confirmed received.',     'ASSET',     null,        null),
  -- Cash handling (rules 11, 11a, 11b, 12, 4b)
  ('CASH_IN_TRANSIT',      'Takings between the till and the bank. A real asset in a real place.', 'ASSET', null, null),
  ('BANK',                 'A bank account.',                                      'ASSET',     'BANK',      null),
  ('BANK_CHARGES',         'Provider and bank fees. An expense, never a discount.', 'EXPENSE',  null,        null),
  ('CASH_OVER_SHORT',      'Till count variance.',                                 'EXPENSE',   null,        null),
  -- Payroll (rule 9). CAPTURE ONLY — every credit is a bureau figure and
  -- nothing here computes a withholding (CLAUDE.md §2.4).
  ('STAFF_COST_GROSS',           'Gross pay expense.',                                    'EXPENSE',   null, 'PAYROLL'),
  ('STAFF_COST_COMMISSION',      'Commission expense.',                                   'EXPENSE',   null, 'PAYROLL'),
  ('STAFF_COST_EMPLOYER_SOCIAL', 'EMPLOYER social security — a company expense. Recording the bureau''s figure, never deriving it.', 'EXPENSE', null, 'PAYROLL'),
  ('EMPLOYEE_TAX_PAYABLE',       'Employee tax withheld, as returned by the bureau.',     'LIABILITY', null, 'PAYROLL'),
  ('EMPLOYEE_SOCIAL_PAYABLE',    'Employee social security withheld, as returned by the bureau.', 'LIABILITY', null, 'PAYROLL'),
  ('EMPLOYER_SOCIAL_PAYABLE',    'Employer social security owed, as returned by the bureau.', 'LIABILITY', null, 'PAYROLL'),
  ('OTHER_DEDUCTIONS_PAYABLE',   'Other deductions, as returned by the bureau.',          'LIABILITY', null, 'PAYROLL'),
  ('NET_PAY_PAYABLE',            'Net pay owed to employees. Entered, never calculated.', 'LIABILITY', null, 'PAYROLL'),
  -- Stock adjustments (rules 7, 7b). The REASON selects the account via a
  -- location/category-scoped mapping; the reason list is tenant data.
  ('STOCK_ADJ',            'Stock adjustment, by reason code.',                    'EXPENSE',   null,        null),
  -- Periodic and manual (rules 13, 14, 15, 16)
  ('DEPRECIATION',         'Depreciation expense. Management policy, not a capital allowance.', 'EXPENSE', null, 'FIXED_ASSETS'),
  ('ACCUM_DEPRECIATION',   'Accumulated depreciation.',                            'ASSET',     null,        'FIXED_ASSETS'),
  ('INTEREST_EXPENSE',     'Loan interest.',                                       'EXPENSE',   null,        'BORROWING'),
  ('LOAN_PAYABLE',         'Loan principal outstanding.',                          'LIABILITY', null,        'BORROWING'),
  ('TAX_EXPENSE',          'Corporate tax. A MANUAL journal from the accountant''s computation, never derived from a rate.', 'EXPENSE', null, null),
  ('TAX_PAYABLE',          'Corporate tax payable.',                               'LIABILITY', null,        null),
  ('RETAINED_EARNINGS',    'Retained earnings, per location, at year-end close.',   'EQUITY',    null,        null)
on conflict (posting_role) do nothing;


-- ============================================================================
-- WHAT IS STILL DELIBERATELY NOT HERE
--
--   * Not one `gl_account_mapping` row. A mapping names a tenant's own
--     account, which is exactly the content the §2.8 gate covers.
--   * Not one `gl_account` row.
--   * No posting-rule implementation binding any role to any account.
--   * Nothing in packages/db/src/seed/template.ts.
--
-- 0016 makes it possible to say which account a role means. It says nothing
-- about which account any role means for anybody.
-- ============================================================================
