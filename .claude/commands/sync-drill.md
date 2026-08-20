---
description: Run the offline and conflict acceptance scenarios end to end
---

Run the offline/sync drill for the Agyasei ERP using the `sync-test-engineer` agent.

These are the scenarios the brief requires be **demonstrated, not asserted**. Mocked sync proves
nothing — use real local databases, real network partitions and real reconnections.

**The four Phase 1 acceptance demonstrations** (`CLAUDE.md` §3):
1. A sale completes at the Techiman flagship with the device in airplane mode, and syncs
   correctly within **60 seconds** of reconnection. Report the measured time.
2. Two devices independently record stock movements against the same SKU while both offline, and
   reconcile correctly (or flag for review) on sync. Assert the converged state is *correct*, not
   merely that both devices agree.
3. A contractor's credit balance, ageing and facility fee are all visible and correct after a mix
   of cash and credit sales across multiple outlets.
4. HQ sees near-real-time (post-sync) stock and sales across every connected outlet in one view.

**The three prohibitions** — build a failing case for each and show it does not occur:
- **Never lost** — kill the app mid-write, reboot, exhaust storage, drop the link mid-sync.
- **Never silently double-counted** — retry an ambiguous write, sync a batch twice, reconnect
  mid-flight. Exactly one record must exist.
- **Never corrupt another outlet's data** — concurrent writes from several outlets against a
  shared contractor account, SKU, or inter-outlet transfer.

**Clock skew** — run with deliberately skewed device clocks: one hours ahead, one behind, one
jumping backwards mid-session. Ordering must hold via logical clocks, not wall time.

**Long offline period** — a device reconnecting after a week with a large backlog against a
server whose schema has moved on. It must converge, or fail loudly and refuse to write.

**The review queue** — confirm unresolvable conflicts arrive with both versions, both authors and
both logical timestamps. Also check the negative: conflicts that *should* auto-resolve are not
flooding the queue.

Report measurements, not impressions.
