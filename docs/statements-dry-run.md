# One month of generated statements — the §2.8 dry run

**Purpose:** `CLAUDE.md` §2.8 makes it blocking that *"a qualified accountant reviews the chart of
accounts, the double-entry logic, and at least one full month of generated statements against
manual expectations"* before a tenant's ledger goes live.

That month does not have to be a month of **real** trading — it has to be a month of statements a
professional can check. Tenant #1 has not traded (`open-questions.md` Q21, answered 2026-08-25),
so the month is **generated**. Doing it now means the reviewer has something waiting on day one
instead of starting a month-long clock the day they are appointed. **This is the only item on the
go-live path that engineering could pull forward.**

## How the month was made — and why it is not seeded data

Every one of the 181 sales was rung through `POST /trpc/sales.createSale` against the running API:
server-priced from the tenant's own `RETAIL` list, taxed from the Ghana jurisdiction pack in force
on each business date, authorised by a real principal's real grants. **Nothing was inserted into
`app.sale` directly.** A generator that wrote rows itself would produce data no code path had ever
agreed to, and every statement built on it would prove nothing.

The settled sales were then swept into the ledger by the ordinary posting engine
(`pnpm dev:post-settled`), and the books reconciled against the operational system figure by
figure.

Reproduce end to end — the whole thing, from an empty database:

```bash
pnpm stack:reset && pnpm dev:api
pnpm --filter @erp/wire-conformance drill:demo-month
```

**It is deterministic** (seeded PRNG, seed `20260801`). Two clean rebuilds produced byte-identical
figures, because a manual expectation you cannot check twice is not a check.

## The month

| | |
|---|---|
| Period | 1–31 August 2026 (period 1 of FY27) |
| Outlets | OUT-01, OUT-02, OUT-03 |
| Sales applied | **181** — 146 cash, 35 credit |
| Sales refused | 10, all `PERMISSION_BOUND_EXCEEDED` on `sale.record.credit` — the manager's GH₵5,000 credit ceiling working. Recorded rather than hidden: a demo month with no refusals would misrepresent the product |
| Net revenue | 45,554,543 pesewas (GH₵455,545.43) |
| Output tax | 9,110,917 pesewas (GH₵91,109.17) |
| Customer payment | GH₵50,000 against the credit book on 21 August |

## The trial balance, as the system produced it

| Code | Account | Outlet | Amount (pesewas) |
|---|---|---|---:|
| 1000 | Till cash | OUT-01 | 12,296,645 |
| 1000 | Till cash | OUT-02 | 15,085,852 |
| 1000 | Till cash | OUT-03 | 21,015,059 |
| 1400 | Trade receivables | OUT-01 | 2,555,061 |
| 1400 | Trade receivables | OUT-02 | 1,926,689 |
| 1400 | Trade receivables | OUT-03 | 1,786,154 |
| 2200 | Output tax payable | OUT-01 | 2,475,285 |
| 2200 | Output tax payable | OUT-02 | 2,835,423 |
| 2200 | Output tax payable | OUT-03 | 3,800,209 |
| 4100 | Sales revenue | OUT-01 | 12,376,421 |
| 4100 | Sales revenue | OUT-02 | 14,177,118 |
| 4100 | Sales revenue | OUT-03 | 19,001,004 |

**Dr 54,665,460 / Cr 54,665,460 — balanced, and balanced at every outlet independently.**

## The four reconciliations the drill asserts

These are the checks that make the month worth reviewing rather than merely looking at. Each ties
the **books** to the **operational system**; if either side ever moves alone, the drill fails.

| Assertion | Result |
|---|---|
| Ledger revenue ≡ Σ(`sale.subtotal_net_minor`) | 45,554,543 = 45,554,543 |
| Ledger output tax ≡ Σ(`sale.tax_total_minor`) | 9,110,917 = 9,110,917 |
| Ledger till cash ≡ Σ(cash sale totals) | 48,397,556 = 48,397,556 |
| Ledger receivables ≡ Σ(credit sale totals) | 6,267,904 = 6,267,904 |

Plus: the trial balance sums to zero for the tenant **and for each outlet**; assets −
(liabilities + equity) equals the P&L result exactly (the identity that holds mid-year, when a
balance sheet correctly does *not* balance); and tenant B sees none of it on the same stack.

## What is deliberately WRONG with this month — please start here

1. **No cost of sales. At all.** No costing method exists, because that is your decision
   (`open-questions.md` Q16 — moving weighted average per (SKU, location) is the architecture's
   proposal). The engine posts sales with **no cost pair**, deliberately omitted rather than
   estimated. **Gross profit is not readable from these statements.** Deciding Q16 is what makes
   the next month's statements complete.
2. **No opening balances.** Q20, and now the small version of it: the outlet has never traded, so
   there are no debtors or creditors to bring across — opening stock plus a capital and bank
   position, as at a date you choose before 1 January 2027.
3. **The chart of accounts is our draft, not yours.** See `docs/draft-chart-of-accounts.md`. The
   account list, the numbering, the `report_line_key` presentation layout and the facility-fee
   treatment (Q4/Q18) are all yours to change; every one you change is the review working.
4. **Tax rates are unconfirmed.** No practitioner has attested to the Ghana rates
   (`open-questions.md` Q8), which is why no tenant can be activated
   (`TAX_RATES_UNCONFIRMED`). The tax figures above are arithmetically correct against rates
   nobody has yet confirmed are the right ones.

## What we would like from you

The §5.12 sign-off block in `docs/draft-chart-of-accounts.md` — name, professional body,
registration, date, commit hash — **or a list of what has to change first**. The second is the
more likely and the more useful.
