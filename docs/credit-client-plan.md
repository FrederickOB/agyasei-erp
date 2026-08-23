# Customer credit — what the server offers, what Phase 1 needs, and what may go offline

Assessment only. No application code. Everything below was established from the code and, where
marked **[live]**, driven over real HTTP against the deployed API at `:3001` with a browser
`Origin` on 2026-08-22.

---

## 1. Route inventory — `apps/api/src/routers/credit.ts`, all six

`at: 'tenant'` means `requireTenantWide`: the capability must be held at **every root node** of the
tenant's location tree. `at: 'any'` means at any one location in scope.

| # | Procedure | Q/M | Input | Guard | Device-uploadable |
|---|---|---|---|---|---|
| 1 | `openAccount` | **M** | `openAccountInput` (`@erp/contracts/credit`): envelope + (`customerId` XOR `newCustomer{code,name,phone?}`) + `termsDays` 0–365 + `feeRateBpPerMonth` 0–10000 + `creditLimitMinor` (non-negative decimal string) | `credit.account.manage` @tenant, **plus** `requireTenantWide('credit.limit.change')` when the limit ≠ 0 | **YES** — `credit.open_account`, dispatched `apps/api/src/sync.ts:74` |
| 2 | `recordEntry` | **M** | `recordEntryInput`: envelope + `accountId` + `kind` ∈ CHARGE/PAYMENT/ADJUSTMENT/WRITE_OFF (**FEE deliberately absent**) + signed `amountMinor` ≠ 0 + `businessDate` + `dueDate?` + `appliesToId?` | `credit.entry.record` @tenant | **YES** — `credit.record_entry`, `sync.ts:75` |
| 3 | `exposure` | Q | `{accountId}` | `credit.view` @any | n/a |
| 4 | `ageing` | Q | `{accountId, asOf}` | `credit.view` @any | n/a |
| 5 | `previewFacilityFee` | Q | `{accountId, asOf}` | `credit.view` @any | n/a |
| 6 | `accrueFacilityFee` | **M** | `{envelope, accountId, asOf}` — **declared locally, not in `@erp/contracts`** | `credit.fee.accrue` @tenant **+ the Q4 policy gate** (412 `FEE_POLICY_UNCONFIRMED`) | NO — absent from `DEVICE_OP_KINDS`, on purpose |

**[live] Both mutations decode cleanly.** `openAccount` and `recordEntry` each returned
`{"result":{"data":{"json":{…}}}}` with **no `meta` key** — every value is a string, an int or a
`YYYY-MM-DD`. The row-16 hazard (`receiving.get`'s uncast `timestamptz`) is **not present** on
these two routes. Re-check any *new* route before believing it.

**[live] fixture left on the dev stack** — account `e14dc893-26ce-8ae2-b51d-cbe03ae9f8d7`
(customer `96be69f5-a1df-81e8-9fd9-2165dc4b0ccb`, limit 5,000,000, terms 30, 250bp), one CHARGE
120,000 due 2026-07-01 and one PAYMENT −40,000; `exposure` reads **80,000**. Useful as a probe
target; gone on the next `stack:reset`.

---

## 2. Requirement → route. Four rows are MISSING SERVER-SIDE.

CLAUDE.md §3: *"customer credit with limits, terms, ageing, and facility fee tracked explicitly"*.

| Requirement | Route that serves it | Status |
|---|---|---|
| Open a credit account | `credit.openAccount` | server ✅ · **no client** |
| Set a credit limit | `credit.openAccount` only | server ✅ · **no client** · **write-once** |
| **Change a credit limit** | — | **MISSING SERVER-SIDE** |
| **Change terms / fee rate** | — | **MISSING SERVER-SIDE** |
| **Suspend or close an account** | — | **MISSING SERVER-SIDE** |
| Charge on credit (sale) | `sales.createSale` tender `CREDIT` → writes the CHARGE (`sales.ts:643`) | server ✅ (D8 8a–8g) · **no client** |
| Record a repayment | `credit.recordEntry` kind `PAYMENT` | server ✅ · **no client** |
| Ageing by days past due | `credit.ageing` | server ✅ · client ✅ (`Credit.tsx`) |
| Facility fee visible | `credit.previewFacilityFee` | server ✅ · client ✅ (shadow, labelled) |
| Facility fee posted | `credit.accrueFacilityFee` | server ✅ · client ✅ · **can never post** (§5, G4) |
| **Find the account for a customer** | — | **MISSING SERVER-SIDE** |
| **Who owes what / DSO** | — | **MISSING SERVER-SIDE** |

Precisely, because these are the sentences that matter:

- **A credit limit can only be set at account creation and can never be changed.**
  `credit_limit_minor` is INSERTed at `credit.ts:270` and appears in no `UPDATE` anywhere in the
  repository. **[live]** Re-opening against the same customer with a higher limit is refused
  `409 CONFLICT: customer already has a credit account`. Terms and fee rate are the same column
  family and the same story.
- **There is no route to record a repayment from a screen** — the route exists, nothing calls it.
  `data/api/credit.ts` exports `fetchExposure`, `fetchAgeing`, `fetchFeePreview`,
  `fetchCreditPosition`, `checkAgreement`, `accrueFacilityFee`. Reads, plus the accrual. Nothing
  else.
- **No screen rings a credit sale either.** `checkout()` supports `tender: 'CREDIT'` +
  `customerId`; its **one** production caller, `features/counter/Counter.tsx:203`, passes neither,
  so `tender` defaults to `'CASH'`. The guarded server path is proven by a drill, not by the
  product. Correct the brief's premise on this point before planning around it.
- **`customer_account.status`** is checked by `sales.createSale` (`PRECONDITION_FAILED: credit
  account is ON_HOLD`) and set by nothing. Suspending a bad payer — the primary credit control —
  does not exist.

---

## 3. The permission model, as it really is

| Capability | Scope | Template roles holding it | Bound |
|---|---|---|---|
| `credit.view` | any | outlet manager, regional manager, accounts, head of ops | — |
| `credit.account.manage` | tenant root | accounts, head of ops | — |
| `credit.limit.change` | tenant root | accounts, head of ops | **none — unbounded** |
| `credit.entry.record` | tenant root | accounts, head of ops | — |
| `credit.fee.accrue` | tenant root | accounts, head of ops | — + policy gate |
| `credit.policy.manage` | — | accounts, head of ops | **guards no route** |
| `sale.record.credit` | the sale's location | counter `0`, manager `500000`, regional `2000000` | `max_order_value_minor` |

**Counter staff hold no credit capability at all.** **[live]** a counter token is refused
`credit.view` on `credit.exposure`; an outlet-manager token is **allowed** the same read and
**refused** `credit.entry.record`. The constitution's prohibition holds today and any UI must keep
it holding by reading `session.permissions` — resolved per request from the database — and never a
role name.

Two consequences the UI plan must carry, not work around:

1. **`at: 'tenant'` is strict.** An Accounts user granted at a leaf cannot open an account or
   record a repayment, whatever the role says. Dev principals are root-scoped
   (`infra/scripts/bootstrap.ts:275`); real onboarding must scope Accounts at the root or these
   screens refuse for everyone. Surface the refusal verbatim; do not soften it.
2. **`apps/web/src/data/api/session.ts` has only `creditView` and `creditFeeAccrue`.** Three more
   codes are needed (`credit.account.manage`, `credit.entry.record`, `credit.limit.change`).
   Hiding a control is a courtesy; the server re-checks at ingest.

---

## 4. The offline ruling

`app.customer_account` and `app.credit_entry` are in **no sync bucket and no sync rule**
(`infra/powersync/sync_rules.yaml:35-36`); only `tenant_customers` syncs, and it carries identity
only. So every credit **read** is online, and stays online. The three write questions get three
different answers, because they are three different risks.

### (a) Repayment — `recordEntry` kind `PAYMENT`: **OFFLINE, through the outbox.**

- **It is trade, not configuration.** The money is in the drawer whether or not the tower is up.
  Refusing it teaches staff to keep the receipt on paper, and paper never reaches the ledger —
  the argument `data/mutations/adjustStock.ts` already makes for a stock movement.
- **It cannot conflict.** `credit_entry` is append-only signed integers and exposure is `Σ`
  (§6.2). Two offline batches arriving in either order produce the same sum. Payments have no
  conflict case; there is nothing for a review queue to hold.
- **It only ever reduces exposure.** A late-arriving payment makes a customer look like they owe
  *more* than they do — recoverable, and the opposite direction of risk from a limit raise.
- **The device already uploads the other half offline.** A queued credit sale writes a CHARGE
  server-side on upload. Taking charges offline and refusing payments offline biases the ledger
  in exactly the wrong direction.
- **Honesty constraint, non-negotiable:** the device may show *the receipt it queued* with its
  outbox state — "recorded here, not yet sent" — and must **never** show a resulting balance,
  because it does not have one. Balance stays behind `ServerAnswer`.
- **Restrict the offline builder to `PAYMENT`.** `ADJUSTMENT` and `WRITE_OFF` are accounting
  judgements, not trade; the outbox is not where a write-off gets authorised. Online only.

### (b) Opening an account — `openAccount`: **ONLINE ONLY.**

- It **sets a credit limit**, and a limit is a risk decision (§6.6). The argument that forbids an
  offline limit edit forbids an offline limit at birth: at creation there is no ancestor to fall
  back to (§6.6.3) and no review row to fork into, because none of that is built.
- `customer_account_customer_uq` is per tenant, not per device. Two offline devices opening an
  account for the same customer each mint a deterministic id from their own key; the second is
  refused `409` at upload, and the person who typed the limit hears nothing until someone reads
  the dead-letter.
- Nothing at a counter needs an account opened this minute. Vetting a credit customer is an
  Accounts-desk act, and the desk is where the connection is.
- It is in `DEVICE_OP_KINDS` today. That is a *capability*, not a decision. Leave it unused by the
  client and write the reason into the module, or the next reader will assume it was an oversight.

### (c) Limit / terms / fee rate / status changes: **ONLINE ONLY — and no route exists.**

§6.6.3(7) rules it directly: *"Severity-1 credit resolutions require connectivity."* The whole
apparatus that would make an offline limit edit survivable — `credit_limit_version`, the ancestor
interim rule, the `conflict_review` fork — is **unimplemented**. Bolting an offline editor onto a
mutable `credit_limit_minor` column is last-write-wins with no detection: the second device's write
lands, the first person's judgement disappears, and nothing flags it. That is the exact failure
CLAUDE.md §2.2 names.

**The canonical hard case, answered plainly:** two locations editing the same customer's limit
while both offline **cannot occur in the product**, because no client will offer an offline limit
edit and no route exists to change a limit at all. That is a real answer, not an evasion — but it
is a stopgap that expires the moment G1 lands. Whoever writes `credit.setLimit` writes the §6.6
version log and review routing with it, in the same change.

### What this means for the client to be built

| Operation | Path | Offline behaviour |
|---|---|---|
| Record a repayment | outbox → `credit.record_entry` | queued; shows the queued receipt, never a balance |
| Open an account | tRPC `credit.openAccount` | refused out loud, nothing queued |
| Change a limit | — | route does not exist; the screen says so |
| Read exposure / ageing / fee | tRPC | already refuses honestly; no cache, no stale figure |

Adding `credit.record_entry` to `WIRE_KINDS` turns
`packages/wire-conformance/test/outbox-surface.test.ts:185` **red** until a real
`credit-client-to-api.test.ts` exists *and* the kind is added to `COVERED_BY_A_REAL_CLIENT_TEST`.
Write the test first. (That file's comment at `:178` claims `data/api/credit.ts` "reaches them over
HTTP" — it does not. Correct it in the same change.)

---

## 5. Server gaps — findings, not things to route around in the UI

**G1 · `credit.setLimit` (or `credit.updateAccount`) — MUST.** Mutation; `credit.account.manage`
**and** `credit.limit.change` @tenant; envelope + `accountId` + `newLimitMinor` + `effectiveFrom` +
a mandatory reason. Honest implementation is §6.6.1's append-only `credit_limit_version` with the
projection onto `customer_account`, not an `UPDATE`. Pair it with the DB backstop
`phase1-status` §6.3 already names (column `REVOKE` + trigger), which does not exist. **Without
G1, "limits" in CLAUDE.md §3 means a number set once and never changed, and Phase 1 is not done.**

**G2 · `credit.accountForCustomer` — MUST.** Query, `credit.view` @any, `{customerId}` → `{accountId,
status}` or `NOT_FOUND`. Every credit route is addressed by **account**; everything a device holds
is addressed by **customer**; no route bridges them and no bucket syncs `customer_account`. The
current client makes a human type a UUID and remembers it device-locally
(`apps/web/src/data/session/credit-account-ref.ts`, which says in its own header that this is a
platform gap it refuses to paper over). It leaks no money figure, so `at: 'any'` is safe.

**G3 · Account status transitions — SHOULD, Phase 1.** `credit.setStatus` (`ACTIVE`/`ON_HOLD`/
`CLOSED`), `credit.account.manage` @tenant. The enforcement half already exists in
`sales.createSale`; only the setter is missing.

**G4 · `credit.policy.get` / `credit.policy.confirm` — MUST, for the fee to be more than a preview.**
`credit.policy.manage` is in the catalogue and the roles and guards **no route**;
`apps/api/src/credit-policy.ts` is an **in-memory** store that starts UNCONFIRMED and resets on
every API restart. So `accrueFacilityFee` **can never post in the product**, and CLAUDE.md §3's
"facility fee tracked explicitly" reaches shadow mode and stops. Needs the effective-dated
`app.credit_policy` migration (`phase1-status` §6.5) plus the two routes; `confirm` records a named
human and a note (§2.8 gate).

**G5 · A receivables read — SHOULD, Phase 1.** Every credit read is one account at a time, by UUID.
Accounts cannot answer "who owes us what" or "who is 60+ days" without already knowing the id.
`reports.*` has no receivables procedure, and §6.9's DSO — the number that tests the model's 15-day
assumption against 30–60 day terms — is measured nowhere.

**G6 · Contract-package gap.** `accrueFacilityFee`'s input and **every credit response shape** are
declared only inside the router (`phase1-status` §6.18). The next client must import, not
hand-roll — that rule is what `packages/contracts` exists for.

**G7 · Do NOT build (stated so nobody starts).** `credit_allowance`, `credit_account_location_cap`,
`credit_refusal`, offline ceilings and per-location caps (§6.5, §6.7) exist in the design and in no
migration. They belong with a real offline credit-sale path. Half-building them to decorate a
counter is worse than the honest sentence the counter can say today: *this device cannot check
credit.*

---

## 6. How the next agent proves it, given this codebase's record

1. `packages/wire-conformance/test/credit-client-to-api.test.ts` — **there is none today.** It is
   the only harness that crosses the real superjson serializer with the real client mapper. An
   `apps/api/test/credit.test.ts` call is in-process and cannot see a `meta` envelope; an
   `apps/web` test fed hand-typed JSON cannot either. That is row 16, exactly.
2. Then `pnpm --filter @erp/wire-conformance drill:credit` against the live stack, from a browser
   origin, comparing the client's figures to Postgres.
3. Mutation-test the offline honesty: collapse "could not check" into a zero balance and confirm a
   test turns red (§0a).
4. Order of operations for the outbox kind: test file → `COVERED_BY_A_REAL_CLIENT_TEST` →
   `WIRE_KINDS`. Never widen the allow-list to make the suite green.
