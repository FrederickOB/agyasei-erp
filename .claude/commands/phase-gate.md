---
description: Run the phase-gate checklist before signing off a build phase
argument-hint: "[phase number, e.g. 1]"
---

Run a phase gate for **Phase $1** of the Agyasei ERP.

Use the `product-manager` agent to conduct this, with `qa-engineer` producing the test evidence.

The gate is not a formality. Per `CLAUDE.md` §3, a phase ends with a **working, demoable system**
— not "code complete", not "tests pass". Produce a written verdict covering:

1. **What was demonstrated** — for each acceptance criterion, what was actually shown, on what
   hardware, and by whom. For Phase 1 these are the four criteria in `CLAUDE.md` §3.
   Distinguish carefully between demonstrated and asserted. The brief is explicit that the
   two-device conflict case must be *demonstrated, not asserted* — apply that standard to all.

2. **Test coverage in the two mandatory categories** — money-touching code and sync/conflict
   logic (`CLAUDE.md` §2.6). Neither is done without tests. Name what is uncovered.

3. **Open questions** — which items in `docs/open-questions.md` moved, which are still blocking,
   and whether any `NEEDS-HUMAN` item is being worked around rather than resolved.

4. **Human review gates** — for Phase 3, has the accountant reviewed the chart of accounts, the
   double-entry logic and a full month of statements? This gate is blocking and cannot be waived
   by any agent.

5. **Deferred scope** — what moved to a later phase and why.

6. **Verdict** — is the next phase cleared to start? If not, name precisely what is missing.

Be honest about thin coverage. A gate passed on optimistic reporting is worse than one failed
plainly — this system becomes the company's books in Phase 3.
