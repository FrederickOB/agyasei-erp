---
description: Compare ERP reporting output against the financial model's targets
---

Reconcile ERP reporting against the financial model using the `business-data-analyst` agent.

Canonical targets are in `docs/source-of-truth/financial-model-targets.md`. **The financial model
outranks the business plan prose** (`CLAUDE.md` §2.8) — the plan contradicts itself in at least
seven places, catalogued in `docs/open-questions.md` Q3.

Put actuals next to targets for each of:

| Metric | Target | Granularity required |
|---|---|---|
| Blended gross margin | 19.3% (FY1) → 24.5% (FY10) | Network; per-year curve |
| Inventory days | 45 (FY1) → 28 (FY10) | **Per outlet** (brief §7) |
| Distribution cost as % of revenue | 5.0% → 2.5% | **Per outlet and per region** (brief §7) |
| Days sales outstanding | Model assumes 15 days | Per contractor account and network |
| Revenue vs. ramp | 40% / 70% / 100% of steady state by year of operation | Per outlet |
| Contractor repeat-purchase rate | >60% by Year 5 | Network |

**If a target cannot be produced from ERP data, that is a gap — report it as one.**

Watch two known-shaky targets and report the real trajectory rather than assuming they hold:

- **DSO** — the model assumes 15 days while contractor terms are 30–60. If credit scales as
  intended, actual DSO lands well above 15 and the FY3 cash trough of GH₵(1,393,958) deepens.
  That trough is the plan's most important funding milestone (`open-questions.md` Q2).
- **Distribution cost** — the 5.0% → 2.5% decline assumed an owned fleet absorbing volume. With
  hauliers only (`ADR-0001`), the mechanism has changed but the target has not been restated
  (`open-questions.md` Q1).

Remember the fiscal year runs **1 August – 31 July**. FY1 is 1 Aug 2026 – 31 Jul 2027. Nothing
here aligns to calendar years.

Cite the source of every figure — file and section.
