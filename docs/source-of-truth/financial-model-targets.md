# Financial Model — Canonical Targets

Extracted from `~/Documents/Agyasei/Agyasei_Jnr_Financial_Model.xlsx` (11 tabs).

**This file is canonical.** Where the business plan prose and this model disagree, the model
wins — see `../open-questions.md`, finding 3. All amounts are GH₵ (GHS) unless noted.
FY1 = 1 Aug 2026 – 31 Jul 2027; FY10 ends 31 Jul 2036.

---

## 1. Core assumptions

| Assumption | Value |
|---|---|
| Model start date | 1 August 2026 |
| Corporate tax rate | 25% |
| VAT rate | 15% — **marked "informational only, output-neutral" in the model** (see finding 5) |
| Wage inflation | 8% p.a. |
| Rent / admin cost escalation | 5% p.a. (mirrors the 5% rent-review cap) |
| Depreciation | 5-year straight-line |
| Loan | GH₵1,000,000 @ 7% p.a., 5-year equal-principal, no early prepayment |
| Receivables days | **15** — inconsistent with 30–60 day contractor terms (finding 2) |
| Payables days | 30 |
| Discount rate (valuation) | 20% |
| Terminal multiple | 5.0× FY10 EBITDA (IRR/NPV only — not in the P&L) |
| Minimum operating cash buffer | GH₵100,000; all surplus swept into inventory at year-end |

### Steady-state annual revenue by tier
| Tier | Steady state | Yr 1 (40%) | Yr 2 (70%) |
|---|---|---|---|
| Flagship | 6,600,000 | 2,640,000 | 4,620,000 |
| RDC | 3,300,000 | 1,320,000 | 2,310,000 |
| Micro-Outlet | 880,000 | 352,000 | 616,000 |

New-outlet revenue ramp: **40% / 70% / 100%** in years 1 / 2 / 3+ of that outlet's operation.

### Per-outlet cost baselines (year 1 of operation, escalating thereafter)
| Tier | Staff cost | Rent | Capex | Headcount |
|---|---|---|---|---|
| Flagship | 216,000 | 36,000 | 400,000 | 10 |
| RDC | 108,000 | 60,000 | 350,000 | 6 |
| Micro-Outlet | 43,200 | 24,000 | 60,000 | 3 |

---

## 2. Reporting targets the ERP must be able to measure

These are the numbers the business tracks actuals against. Every one of them must be
derivable from ERP data — if a report cannot produce it, that is a gap, not a nice-to-have.

### Blended gross margin % by fiscal year
| FY1 | FY2 | FY3 | FY4 | FY5 | FY6 | FY7 | FY8 | FY9 | FY10 |
|---|---|---|---|---|---|---|---|---|---|
| 19.325% | 20.763% | 21.913% | 22.775% | 23.350% | 23.753% | 24.040% | 24.270% | 24.385% | 24.500% |

### Inventory days (cover) — declining target
| FY1 | FY2 | FY3 | FY4 | FY5 | FY6 | FY7 | FY8 | FY9 | FY10 |
|---|---|---|---|---|---|---|---|---|---|
| 45 | 43 | 41 | 39 | 37 | 35 | 33 | 31 | 29 | 28 |

Brief §7 requires actual inventory days **per outlet** to be reportable against this curve.

### Distribution & logistics as % of revenue — declining target
| FY1 | FY2 | FY3 | FY4 | FY5 | FY6 | FY7 | FY8 | FY9 | FY10 |
|---|---|---|---|---|---|---|---|---|---|
| 5.0% | 4.6% | 4.2% | 3.8% | 3.5% | 3.2% | 3.0% | 2.8% | 2.6% | 2.5% |

Brief §7 requires this **per outlet and per region**. Note: the model attributes this decline
to an owned fleet absorbing volume. With hauliers only (ADR-0001), the mechanism has changed
but the target has not been restated — see finding 1.

### Other fixed opex ratios
Marketing & advertising 2.0% of revenue · Admin, utilities & insurance 3.0% of revenue.

---

## 3. P&L summary (GH₵)

| | FY1 | FY2 | FY3 | FY4 | FY5 |
|---|---|---|---|---|---|
| Revenue | 2,640,000 | 6,292,000 | 12,518,000 | 17,424,000 | 22,748,000 |
| Cost of goods sold | (2,129,820) | (4,985,624) | (9,774,993) | (13,455,684) | (17,436,342) |
| Gross profit | 510,180 | 1,306,377 | 2,743,007 | 3,968,316 | 5,311,658 |
| EBITDA | (5,820) | 197,865 | 646,912 | 1,154,311 | 1,703,914 |
| Depreciation | (140,000) | (222,000) | (374,000) | (422,000) | (516,000) |
| Interest | (70,000) | (56,000) | (42,000) | (28,000) | (14,000) |
| Tax | 0 | 0 | (57,728) | (176,078) | (293,479) |
| **Net profit** | **(215,820)** | **(80,136)** | **173,184** | **528,233** | **880,436** |
| Cumulative outlets | 1 | 3 | 6 | 10 | 13 |

| | FY6 | FY7 | FY8 | FY9 | FY10 |
|---|---|---|---|---|---|
| Revenue | 27,698,000 | 33,022,000 | 37,026,000 | 39,776,000 | 41,184,000 |
| EBITDA | 2,145,229 | 2,678,740 | 3,160,504 | 3,396,106 | 3,420,938 |
| **Net profit** | **1,247,421** | **1,638,555** | **2,095,878** | **2,290,579** | **2,370,703** |
| Cumulative outlets | 17 | 20 | 22 | 24 | 25 |

Cumulative net profit FY1–FY5: **1,285,897**. FY1–FY10: **10,929,034**.
**Net profit turns positive in FY3** (the plan prose says FY4 in §9.1 — the model wins).

---

## 4. Cash position — the bridge-financing requirement

| FY1 | FY2 | FY3 | FY4 | FY5 | FY6+ |
|---|---|---|---|---|---|
| 100,000 | (608,261) | **(1,393,958)** | (1,122,537) | (617,508) | 100,000 |

Trough is **FY3 at GH₵(1,393,958)**. A bridge facility sized to that trough is required by
Year 2. The Executive Summary's GH₵(1,501,082) / "≥GH₵1.5M" and the §10 risk table's
"~GH₵1,300,000 sized to the FY5 trough" are both stale — the model is canonical, and the
trough is FY3, not FY5.

## 5. Year-1 funding structure

| Component | Amount |
|---|---|
| Owner equity — initial capital | 500,000 |
| Owner equity — Techiman rent advance (24 mo × 3,000) | 72,000 |
| Owner equity — FY1 stock-width drip-feed (100,000/mo × 12) | 1,200,000 |
| Bank loan (7% p.a., 5-year equal-principal) | 1,000,000 |
| **Total** | **1,772,000** |

## 6. Returns

10-year equity IRR **42.1%** · NPV @ 20% **GH₵3,948,423** · ROI 616.8% · payback 6 years.

---

## 7. Scenario levers

The model has a single scenario switch (1 = Base, 2 = Best, 3 = Worst) driving ramp speed,
margin trajectory, distribution cost, wage inflation and rent escalation.

| Driver | Base | Best | Worst |
|---|---|---|---|
| Ramp yr 1 / yr 2 / yr 3+ | 40/70/100% | 55/85/100% | 30/55/90% |
| Wage inflation | 8% | 6% | 11% |
| Rent escalation | 5% | 4% | 7% |
| Gross margin FY10 | 24.5% | 26.0% | 21.0% |
| Distribution cost FY10 | 2.5% | 2.0% | 3.5% |

All figures elsewhere in this file are **Base case**.
