# Draft chart of accounts — a proposal for the reviewing accountant

**Status: DRAFT. UNREVIEWED. Not in any template.** This is the artifact the CLAUDE.md §2.8
review tears apart — prepared so that review happens against a running system rather than a blank
page. It is seeded ONLY into the development stack (`packages/db/src/seed/dev-ledger.ts`, the same
footing as dev prices); no tenant provisioned through the product acquires an account from it.
The reviewed version, whatever it becomes, ships as the template with your name on the commit.

## How to review it

The dev stack runs the whole loop: sales rung at a till post to this chart through fixed platform
rules, and the statements derive from the postings. `pnpm stack:reset && pnpm dev:api`, ring
sales, `pnpm dev:post-settled`, then read the Books screen or `ledger.trialBalance`. What you are
reviewing is therefore not just the account list below but **what the system does with it**.

## The accounts

| Code | Name | Type | Control | Posting roles it answers |
|---|---|---|---|---|
| 1000 | Till cash | ASSET | TILL | TILL_CASH |
| 1010 | Mobile money float | ASSET | MOMO | MOMO_WALLET |
| 1200 | Bank | ASSET | BANK | BANK |
| 1250 | Cash in transit | ASSET | — | CASH_IN_TRANSIT |
| 1300 | Inventory | ASSET | INVENTORY | INVENTORY |
| 1350 | Inventory in transit | ASSET | — | INVENTORY_IN_TRANSIT |
| 1400 | Trade receivables | ASSET | AR | AR_TRADE |
| 1450 | Facility fee receivable **[Q4]** | ASSET | AR | FACILITY_FEE_AR |
| 1500 | Input tax recoverable | ASSET | — | INPUT_TAX |
| 1600 | Accumulated depreciation (contra) | ASSET | — | ACCUM_DEPRECIATION |
| 1900 | Inter-location clearing | ASSET | — | INTERLOC_CLEARING |
| 2100 | Trade payables | LIABILITY | AP | AP_TRADE |
| 2150 | Goods received not invoiced | LIABILITY | — | GRNI |
| 2200 | Output tax payable | LIABILITY | — | OUTPUT_TAX |
| 2310–2350 | Payroll payables (employee tax / employee social / employer social / other / net pay) | LIABILITY | — | the five payroll payable roles |
| 2400 | Corporate tax payable | LIABILITY | — | TAX_PAYABLE |
| 2500 | Loan payable | LIABILITY | — | LOAN_PAYABLE |
| 3900 | Retained earnings | EQUITY | — | RETAINED_EARNINGS |
| 4100 | Sales revenue | INCOME | — | SALES_REVENUE |
| 4190 | Sales discounts (contra) | INCOME | — | SALES_DISCOUNT |
| 4195 | Sales returns (contra) | INCOME | — | SALES_RETURNS |
| 4200 | Facility fee income **[Q4/Q18]** | INCOME | — | FACILITY_FEE_INCOME |
| 5000 | Cost of goods sold | EXPENSE | — | COGS |
| 5100 | Purchase price variance | EXPENSE | — | PPV |
| 5200 | Stock adjustments | EXPENSE | — | STOCK_ADJ |
| 6100 | Bank and provider charges | EXPENSE | — | BANK_CHARGES |
| 6110 | Cash over/short | EXPENSE | — | CASH_OVER_SHORT |
| 6200 | Distribution cost — third-party haulage | EXPENSE | — | DISTRIBUTION_COST |
| 6300–6320 | Staff costs (gross / commission / employer social) | EXPENSE | — | the three staff cost roles |
| 6400 | Depreciation | EXPENSE | — | DEPRECIATION |
| 6500 | Interest expense | EXPENSE | — | INTEREST_EXPENSE |
| 6900 | Corporate tax expense | EXPENSE | — | TAX_EXPENSE |

Fiscal calendar in the draft: **1 August – 31 July** (tenant #1's year), twelve monthly periods.

## What we already know is wrong or missing — please start here

1. **No COGS posts (Q16).** No costing method exists, because that is your call (moving weighted
   average per (SKU, location) is the architecture's proposal, §5.6.2 #9). Until then the sweep
   posts sales with **no cost pair at all** — deliberately omitted, never estimated — so **gross
   profit is not readable from these books yet.** The statements say so rather than showing a
   fiction.
2. **The facility fee accounts are placeholders (Q4/Q18, G-3).** Whether the fee is income here
   or structured otherwise, and whether it is a taxable supply, are your decisions; the accrual
   refuses to post until the policy carries your confirmation regardless.
3. **No opening balances (Q20/Q21).** The pilot has existing stock, debtors and creditors; how
   they enter — and as of what cut-off date — depends on whether Techiman has been trading since
   1 August (Q21, unanswered). The GL_NO_PERIOD exception you will see on the dev stack for a
   2025-dated sale is this class, surfaced rather than swallowed.
4. **Rollup/presentation structure is absent.** The draft is flat; `report_line_key` carries the
   statement layout and is yours to shape.
5. **The §5.12 question list** (input-recoverability of NHIL/GETFund, shrinkage placement,
   corporate tax cadence, employer contribution in staff-cost baselines) is unanswered and waits
   for you.

## Sign-off (per architecture §5.12 — blank until the review has happened)

```
Reviewer name:          ______________________________
Professional body:      ______________________________  (e.g. ICAG)
Registration number:    ______________________________
Date of review:         ______________________________
Commit hash reviewed:   ______________________________
Scope: chart of accounts · account mappings · posting rules (version 1) ·
       one full month of generated statements checked against manual expectation
Notes / changes required:
```

**No agent may fill this in.** An empty block here is the gate holding, not a formality skipped.
