/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CUSTOMER CREDIT, FROM THE CLIENT SIDE — and it is ONLINE-ONLY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO OFFLINE PATH HERE, AND WHY THAT IS THE SAFE ANSWER
 * ---------------------------------------------------------------------------
 * `app.customer_account` and `app.credit_entry` are in NO sync bucket. That is
 * not an oversight to route around; `infra/powersync/sync_rules.yaml` says it
 * in its own words — the permission tables §3.2.2 gates the credit book on did
 * not exist when the rules were written, and *"the fail-closed choice is no
 * bucket, not an ungated one. Credit reads stay online through the API until
 * then."*
 *
 * So a partitioned device genuinely does not know what a customer owes, and
 * the ONLY correct thing it can do is say so. There is no last-known balance
 * in this module, no cache, and no place to put one. A stale credit balance
 * shown confidently at a counter is how somebody extends credit that is not
 * there — it is worse than no balance, and it is worse in a way nobody
 * discovers until the month-end statement.
 *
 * This client remembers NOTHING about credit. It used to keep one thing — an
 * account IDENTIFIER, because no route mapped a customer to their account and
 * a person had to type a UUID at a counter. `credit.accountForCustomer` now
 * answers that, so there is no device note left to go stale or belong to the
 * wrong customer.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS TYPED, AND WHERE THE CONTRACT STOPS
 * ---------------------------------------------------------------------------
 * `credit.exposure`, `credit.ageing` and `credit.previewFacilityFee` are
 * QUERIES whose inputs are declared privately in `apps/api/src/routers/
 * credit.ts` — they are not device-uploadable ops, so they are not in
 * `packages/contracts/src/credit.ts`, which carries the two that are
 * (`openAccountInput`, `recordEntryInput`). Rather than restate their field
 * rules as free-hand regular expressions, every field below is checked with
 * the contract's own declaration of it — `zUuid`, `zBusinessDate`,
 * `mutationEnvelopeSchema` — before the request leaves the device.
 *
 * State the limit rather than let a reader assume it: that gives this client
 * the right FIELD RULES but not a shared declaration of the field NAMES, so a
 * rename on the server surfaces here as a runtime `refused`, not as a `tsc`
 * error. `stock.record_movement` is not in that position — it has a real
 * shared declaration and the movement builder is typed against it
 * (`data/mutations/adjustStock.ts`), which is the standard the credit QUERY
 * inputs should be held to once they move into the contracts package.
 *
 * Responses are mapped field by field; every money figure crosses as a decimal
 * string of minor units and becomes `bigint` here, exactly once, through
 * `asScaled` (ADR-0004). Nothing in this file assumes a minor-unit scale, and
 * nothing formats — that happens once, at the presentation boundary, through
 * `<Money>` against the tenant's CurrencySpec.
 */
import {
  accountForCustomerInput,
  mutationEnvelopeSchema,
  openAccountInput,
  setLimitInput,
  setStatusInput,
  zBusinessDate,
  zUuid,
  type MutationEnvelope,
  type OpenAccountInput,
  type SetLimitInput,
  type SetStatusInput,
} from '@erp/contracts';
import { add, sub, type MinorUnits } from '@erp/money';
import {
  apiMutate,
  apiQuery,
  asArray,
  asBoolean,
  asCount,
  asOptionalString,
  asRecord,
  asScaled,
  asString,
  headlineFor,
  type ApiCallOptions,
  type ApiFailure,
  type ApiResult,
} from './client';
import { guard } from './guard';

// ---------------------------------------------------------------------------
// Request shapes — the contract's own field declarations, not free-hand ones
// ---------------------------------------------------------------------------

/**
 * `apps/web` does not depend on `zod` — only `@erp/contracts` does, and it
 * exports the compiled schemas rather than the library. So the checks below
 * are assembled from the contract's exported FIELD declarations
 * (`zUuid`, `zBusinessDate`, `mutationEnvelopeSchema`) rather than from a
 * regular expression written on this side of the wire. "What an account
 * reference looks like" and "what a business date is" each have exactly one
 * definition in this repository, and it is not in this file.
 */
export type AccrueFeeInput = MutationEnvelope & {
  readonly accountId: string;
  readonly asOf: string;
};

function fieldIssues(
  schema: { safeParse: (v: unknown) => { success: boolean } },
  field: string,
  value: unknown,
  expected: string,
): string[] {
  return schema.safeParse(value).success ? [] : [`${field}: ${expected}`];
}

function accountIssues(accountId: string): string[] {
  return fieldIssues(zUuid, 'accountId', accountId, 'expected an account reference');
}

function asOfIssues(asOf: string): string[] {
  return fieldIssues(zBusinessDate, 'asOf', asOf, 'expected a calendar date, YYYY-MM-DD');
}

/**
 * A request this device refused to send.
 *
 * Returned as an ordinary `ApiFailure` so a screen handles it through the same
 * switch as every other "no" — there is no separate throw path for a caller to
 * forget about (`data/api/client.ts` makes the same argument for its own
 * `invalidRequest`).
 */
function invalidFailure(what: string, issues: readonly string[]): ApiFailure {
  return {
    kind: 'invalid-request',
    message: headlineFor('invalid-request'),
    detail: `${what}: ${issues.join('; ')}`,
    status: null,
  };
}

function refuse<T>(what: string, issues: readonly string[]): ApiResult<T> {
  return { ok: false, failure: invalidFailure(what, issues) };
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface CreditExposure {
  readonly accountId: string;
  /**
   * What the customer owes: Σ of every entry on the account, derived on every
   * read and never a stored counter (06 §6.2). An append-only log of signed
   * integers is commutative, which is why two outlets trading offline against
   * one account have no conflict case at all.
   */
  readonly exposureMinor: MinorUnits;
  readonly creditLimitMinor: MinorUnits;
  /** Limit − exposure. Can be NEGATIVE: an account already over its limit. */
  readonly availableMinor: MinorUnits;
  /** The account's own status word, from the tenant's row. Rendered as-is. */
  readonly status: string;
  /** The terms the NEXT charge ages against. A count of days, never money. */
  readonly termsDays: number;
  /**
   * The accepted head of the limit decision log (06 §6.6.1), or `null` for an
   * account opened before that log existed.
   *
   * THIS IS THE COMPARE-AND-SET, and it is why a limit change is safe to
   * offer at all. A change sends it back as `supersedesId`; a claim that no
   * longer matches is refused with the figure that won, so one person's risk
   * judgement is never silently replaced by another's (CLAUDE.md §2.2).
   */
  readonly limitVersionId: string | null;
}

export interface AgeingBucket {
  /** The server's label for the band, built from the tenant's own boundaries. */
  readonly label: string;
  readonly amountMinor: MinorUnits;
}

export interface AgedInvoice {
  readonly chargeId: string;
  readonly dueDate: string | null;
  readonly daysPastDue: number;
  readonly outstandingMinor: MinorUnits;
  readonly bucket: string;
}

export interface CreditAgeing {
  readonly accountId: string;
  readonly asOf: string;
  /**
   * `days_past_due`, always, and shown. An invoice ages against the terms
   * snapshotted when it was charged, so every bucket means the same thing for
   * a 30-day and a 60-day account (06 §6.3) — which is exactly the fact a
   * reader would otherwise assume wrongly.
   */
  readonly agedBy: string;
  readonly buckets: readonly AgeingBucket[];
  /** Unapplied payments. A separate line, never netted into the oldest bucket. */
  readonly onAccountCreditMinor: MinorUnits;
  /** Fee receivable, kept apart from trade receivable (06 §6.4.4). */
  readonly feeOutstandingMinor: MinorUnits;
  readonly invoices: readonly AgedInvoice[];
}

export interface FeeAccrualLine {
  readonly chargeId: string;
  readonly dueDate: string | null;
  readonly basisMinor: MinorUnits;
  readonly elapsedDays30: number;
  readonly cumulativeMinor: MinorUnits;
  readonly alreadyPostedMinor: MinorUnits;
  readonly deltaMinor: MinorUnits;
}

export interface FeePreview {
  readonly accountId: string;
  readonly asOf: string;
  /** TRUE while the tenant's fee policy is unconfirmed — nothing is chargeable. */
  readonly provisional: boolean;
  /** THE SERVER'S OWN LABEL. Rendered verbatim; never re-worded on the device. */
  readonly label: string;
  readonly accruals: readonly FeeAccrualLine[];
  readonly totalDeltaMinor: MinorUnits;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function mapExposure(json: unknown): CreditExposure {
  const row = asRecord(json, 'credit.exposure');
  return {
    accountId: asString(row['accountId'], 'accountId'),
    exposureMinor: asScaled(row['exposureMinor'], 'exposureMinor'),
    creditLimitMinor: asScaled(row['creditLimitMinor'], 'creditLimitMinor'),
    availableMinor: asScaled(row['availableMinor'], 'availableMinor'),
    status: asString(row['status'], 'status'),
    termsDays: asCount(row['termsDays'], 'termsDays'),
    limitVersionId: asOptionalString(row['limitVersionId'], 'limitVersionId'),
  };
}

function mapAgeing(json: unknown): CreditAgeing {
  const root = asRecord(json, 'credit.ageing');
  return {
    accountId: asString(root['accountId'], 'accountId'),
    asOf: asString(root['asOf'], 'asOf'),
    agedBy: asString(root['agedBy'], 'agedBy'),
    buckets: asArray(root['buckets'], 'buckets').map((entry, i) => {
      const what = `buckets[${String(i)}]`;
      const row = asRecord(entry, what);
      return {
        label: asString(row['label'], `${what}.label`),
        amountMinor: asScaled(row['amountMinor'], `${what}.amountMinor`),
      };
    }),
    onAccountCreditMinor: asScaled(root['onAccountCreditMinor'], 'onAccountCreditMinor'),
    feeOutstandingMinor: asScaled(root['feeOutstandingMinor'], 'feeOutstandingMinor'),
    invoices: asArray(root['invoices'], 'invoices').map((entry, i) => {
      const what = `invoices[${String(i)}]`;
      const row = asRecord(entry, what);
      return {
        chargeId: asString(row['chargeId'], `${what}.chargeId`),
        dueDate: asOptionalString(row['dueDate'], `${what}.dueDate`),
        daysPastDue: asCount(row['daysPastDue'], `${what}.daysPastDue`),
        outstandingMinor: asScaled(row['outstandingMinor'], `${what}.outstandingMinor`),
        bucket: asString(row['bucket'], `${what}.bucket`),
      };
    }),
  };
}

function mapFeePreview(json: unknown): FeePreview {
  const root = asRecord(json, 'credit.previewFacilityFee');
  return {
    accountId: asString(root['accountId'], 'accountId'),
    asOf: asString(root['asOf'], 'asOf'),
    provisional: asBoolean(root['provisional'], 'provisional'),
    label: asString(root['label'], 'label'),
    accruals: asArray(root['accruals'], 'accruals').map((entry, i) => {
      const what = `accruals[${String(i)}]`;
      const row = asRecord(entry, what);
      return {
        chargeId: asString(row['chargeId'], `${what}.chargeId`),
        dueDate: asOptionalString(row['dueDate'], `${what}.dueDate`),
        basisMinor: asScaled(row['basisMinor'], `${what}.basisMinor`),
        elapsedDays30: asCount(row['elapsedDays30'], `${what}.elapsedDays30`),
        cumulativeMinor: asScaled(row['cumulativeMinor'], `${what}.cumulativeMinor`),
        alreadyPostedMinor: asScaled(row['alreadyPostedMinor'], `${what}.alreadyPostedMinor`),
        deltaMinor: asScaled(row['deltaMinor'], `${what}.deltaMinor`),
      };
    }),
    totalDeltaMinor: asScaled(root['totalDeltaMinor'], 'totalDeltaMinor'),
  };
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export function fetchExposure(
  accountId: string,
  options: ApiCallOptions = {},
): Promise<ApiResult<CreditExposure>> {
  const issues = accountIssues(accountId);
  if (issues.length > 0) return Promise.resolve(refuse('credit.exposure', issues));
  return apiQuery('credit.exposure', { accountId }, mapExposure, options);
}

export function fetchAgeing(
  accountId: string,
  asOf: string,
  options: ApiCallOptions = {},
): Promise<ApiResult<CreditAgeing>> {
  const issues = [...accountIssues(accountId), ...asOfIssues(asOf)];
  if (issues.length > 0) return Promise.resolve(refuse('credit.ageing', issues));
  return apiQuery('credit.ageing', { accountId, asOf }, mapAgeing, options);
}

export function fetchFeePreview(
  accountId: string,
  asOf: string,
  options: ApiCallOptions = {},
): Promise<ApiResult<FeePreview>> {
  const issues = [...accountIssues(accountId), ...asOfIssues(asOf)];
  if (issues.length > 0) return Promise.resolve(refuse('credit.previewFacilityFee', issues));
  return apiQuery('credit.previewFacilityFee', { accountId, asOf }, mapFeePreview, options);
}

// ---------------------------------------------------------------------------
// The one position, assembled — and checked for internal agreement
// ---------------------------------------------------------------------------

/**
 * Whether the three answers describe the same account state.
 *
 * The balance and the ageing are TWO reads over the same append-only ledger,
 * taken a moment apart, and the identity between them is exact arithmetic
 * rather than an approximation:
 *
 *   exposure = Σ buckets − on-account credit + fee outstanding
 *
 * The buckets hold each unpaid charge's outstanding amount; unapplied payments
 * sit outside every bucket by design (06 §6.3) and reduce what is owed; fee
 * entries are kept apart from trade receivable (§6.4.4) and are part of the
 * balance. All of it in `bigint`; nothing here rounds, because there is
 * nothing to round.
 *
 * When it does not hold, the screen SAYS SO instead of showing a headline
 * total with a breakdown underneath it that does not add up. Two innocent
 * explanations exist — an entry landed between the two requests, or a charge
 * has been over-applied so it left the buckets — and neither is a reason to
 * render the pair as though they agree.
 */
export type PositionAgreement =
  | { readonly kind: 'agrees' }
  | {
      readonly kind: 'disagrees';
      readonly balanceMinor: MinorUnits;
      readonly compositionMinor: MinorUnits;
      readonly differenceMinor: MinorUnits;
    };

export function checkAgreement(
  exposure: CreditExposure,
  ageing: CreditAgeing,
): PositionAgreement {
  let buckets: MinorUnits = 0n;
  for (const b of ageing.buckets) buckets = add(buckets, b.amountMinor);
  const composition = add(sub(buckets, ageing.onAccountCreditMinor), ageing.feeOutstandingMinor);
  if (composition === exposure.exposureMinor) return { kind: 'agrees' };
  return {
    kind: 'disagrees',
    balanceMinor: exposure.exposureMinor,
    compositionMinor: composition,
    differenceMinor: sub(exposure.exposureMinor, composition),
  };
}

export interface CreditPosition {
  readonly exposure: CreditExposure;
  readonly ageing: CreditAgeing;
  /**
   * The fee, or the reason there is no fee figure. A refused fee read must not
   * take the balance down with it: what a customer owes is the answer the
   * counter needs, and the fee is a provisional number nobody may charge.
   */
  readonly fee: FeePreview | null;
  readonly feeFailure: ApiFailure | null;
  readonly agreement: PositionAgreement;
}

/**
 * One account's whole position, in three requests.
 *
 * The balance and the ageing are required — without either one there is no
 * honest picture, and the screen renders the reason instead. The fee is
 * optional in the same sense the reporting screen's cost panel is: its absence
 * is stated, never rendered as zero.
 */
export async function fetchCreditPosition(
  accountId: string,
  asOf: string,
  options: ApiCallOptions = {},
): Promise<ApiResult<CreditPosition>> {
  const [exposure, ageing, fee] = await Promise.all([
    fetchExposure(accountId, options),
    fetchAgeing(accountId, asOf, options),
    fetchFeePreview(accountId, asOf, options),
  ]);
  if (!exposure.ok) return exposure;
  if (!ageing.ok) return ageing;

  return {
    ok: true,
    data: {
      exposure: exposure.data,
      ageing: ageing.data,
      fee: fee.ok ? fee.data : null,
      feeFailure: fee.ok ? null : fee.failure,
      agreement: checkAgreement(exposure.data, ageing.data),
    },
    // The OLDEST of the three, not the newest: the position is only as fresh
    // as its stalest part, and rounding that up would be the same lie in
    // miniature as showing a cached balance.
    fetchedAtMs: Math.min(exposure.fetchedAtMs, ageing.fetchedAtMs),
  };
}

// ---------------------------------------------------------------------------
// Accrual — the human gate, not an error
// ---------------------------------------------------------------------------

/**
 * The server's own code for "a qualified human has not signed off the fee
 * policy yet". `apps/api/src/routers/credit.ts` raises it as a
 * `PRECONDITION_FAILED` (HTTP 412) with this token at the head of the message.
 *
 * Matching on it is not branching on tenant vocabulary: it is a PLATFORM error
 * code, in the same class as `UNKNOWN_KIND` on the upload path. What it must
 * never become is a retry: this refusal is correct, it is permanent until a
 * person acts, and a button that offered to try again would be inviting
 * somebody to hammer a decision that is not theirs (CLAUDE.md §2.8,
 * open-questions Q4).
 */
export const FEE_POLICY_UNCONFIRMED = 'FEE_POLICY_UNCONFIRMED';

export interface FeePosted {
  readonly accountId: string;
  readonly asOf: string;
  readonly postedCount: number;
  readonly totalPostedMinor: MinorUnits;
}

export type AccrueFeeOutcome =
  /** Posted. Only reachable once the policy has been confirmed. */
  | { readonly kind: 'posted'; readonly result: FeePosted }
  /**
   * The Q4 gate. NOT a failure of the request, the device or the person: the
   * five fee decisions are revenue-recognition calls a qualified human makes,
   * and until they are made the accrual refuses to post — loudly, never by
   * quietly skipping.
   */
  | { readonly kind: 'policy-unconfirmed'; readonly detail: string }
  /** Any other refusal, in the ordinary taxonomy. */
  | { readonly kind: 'refused'; readonly failure: ApiFailure };

function mapPosted(json: unknown): FeePosted {
  const root = asRecord(json, 'credit.accrueFacilityFee');
  const postings = asArray(root['postings'], 'postings');
  return {
    accountId: asString(root['accountId'], 'accountId'),
    asOf: asString(root['asOf'], 'asOf'),
    postedCount: postings.length,
    totalPostedMinor: asScaled(root['totalPostedMinor'], 'totalPostedMinor'),
  };
}

/**
 * Try to post the accrual.
 *
 * ONLINE ONLY and never queued. This is not trade the counter is holding: it
 * is a periodic posting made by the person who holds `credit.fee.accrue`,
 * against a policy the server has to check at the moment of posting. Queuing
 * it would mean a device could post a fee under a policy that was unconfirmed
 * when it was queued — which is the precise thing the gate exists to prevent.
 */
export async function accrueFacilityFee(
  input: AccrueFeeInput,
  options: ApiCallOptions = {},
): Promise<AccrueFeeOutcome> {
  // The envelope is proved against the contract's OWN strict schema; the two
  // route-local fields against the contract's own field declarations. A
  // malformed write is caught here rather than as a BAD_REQUEST somebody
  // discovers in a district town.
  const envelope = mutationEnvelopeSchema.safeParse({
    idempotencyKey: input.idempotencyKey,
    ...(input.claimedHlc === undefined ? {} : { claimedHlc: input.claimedHlc }),
    ...(input.clientWallAt === undefined ? {} : { clientWallAt: input.clientWallAt }),
  });
  const issues = [
    ...(envelope.success ? [] : ['envelope: the write envelope is not well formed']),
    ...accountIssues(input.accountId),
    ...asOfIssues(input.asOf),
  ];
  if (issues.length > 0) {
    return { kind: 'refused', failure: invalidFailure('credit.accrueFacilityFee', issues) };
  }

  const result = await apiMutate('credit.accrueFacilityFee', input, mapPosted, options);
  if (result.ok) return { kind: 'posted', result: result.data };

  const detail = result.failure.detail ?? '';
  if (result.failure.status === 412 || detail.includes(FEE_POLICY_UNCONFIRMED)) {
    return { kind: 'policy-unconfirmed', detail };
  }
  return { kind: 'refused', failure: result.failure };
}

// ---------------------------------------------------------------------------
// Which account belongs to this customer
// ---------------------------------------------------------------------------

export interface CreditAccountRef {
  readonly accountId: string;
  readonly customerId: string;
  /** The tenant's own status word. Rendered as-is; nothing branches on it. */
  readonly status: string;
}

/**
 * The server's token for "this customer buys for cash". It is a PLATFORM code,
 * in the same class as `FEE_POLICY_UNCONFIRMED`, and matching on it is not
 * branching on tenant vocabulary.
 */
export const NO_CREDIT_ACCOUNT = 'NO_CREDIT_ACCOUNT';

/**
 * Find the credit account for a customer.
 *
 * ONLINE, and the return type carries the distinction that costs money:
 *
 *   `ok: true,  data: <account>`  — the server answered, and there is one.
 *   `ok: true,  data: null`       — THE SERVER ANSWERED, AND THERE IS NONE.
 *   `ok: false`                   — this device could not ask.
 *
 * The middle case is the ONLY one in which a screen may offer to open an
 * account, and it is reachable only from a real answer. `app.customer_account`
 * is in no sync bucket, so a partitioned device genuinely does not know
 * whether a customer has one — and turning that silence into "none" would
 * invite a second account for somebody who already has one, which is a second
 * book for one customer and unrecoverable in the same sense a tenant leak is.
 */
export async function fetchAccountForCustomer(
  customerId: string,
  options: ApiCallOptions = {},
): Promise<ApiResult<CreditAccountRef | null>> {
  const bad = guard(accountForCustomerInput, 'credit.accountForCustomer', { customerId });
  if (bad !== null) return bad;

  const result = await apiQuery(
    'credit.accountForCustomer',
    { customerId },
    (json): CreditAccountRef => {
      const row = asRecord(json, 'credit.accountForCustomer');
      return {
        accountId: asString(row['accountId'], 'accountId'),
        customerId: asString(row['customerId'], 'customerId'),
        status: asString(row['status'], 'status'),
      };
    },
    options,
  );
  if (result.ok) return result;
  if (result.failure.status === 404 || (result.failure.detail ?? '').includes(NO_CREDIT_ACCOUNT)) {
    // An ANSWER of "none", not a failure — and it carries the moment it was
    // taken, like every other server answer on this screen.
    return { ok: true, data: null, fetchedAtMs: Date.now() };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Opening an account — ONLINE ONLY, and never queued
// ---------------------------------------------------------------------------

export interface OpenedAccount {
  readonly accountId: string;
  readonly customerId: string;
  readonly termsDays: number;
  readonly feeRateBpPerMonth: number; // lint-money-ignore: an integer bp RATE, not minor units
  readonly creditLimitMinor: MinorUnits;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * OPEN A CREDIT ACCOUNT. THIS IS NOT AN OUTBOX WRITE, AND MUST NOT BECOME ONE.
 * ═══════════════════════════════════════════════════════════════════════════
 * `credit.open_account` IS in `DEVICE_OP_KINDS`, so a device COULD queue it.
 * That is a capability, not a decision, and the decision is no. Three reasons,
 * each sufficient:
 *
 *  1. **It sets a credit limit**, and a limit is a risk judgement (06 §6.6).
 *     Whatever forbids an offline limit EDIT forbids an offline limit at
 *     birth — at creation there is no ancestor to fall back to (§6.6.3) and no
 *     review row to fork into.
 *  2. **`customer_account_customer_uq` is per tenant, not per device.** Two
 *     partitioned devices opening an account for the same customer each mint
 *     an id from their own key; the second is refused `409` at upload, and the
 *     person who typed the limit hears nothing until somebody reads the
 *     dead-letter.
 *  3. **Nothing at a counter needs this done this minute.** Vetting a credit
 *     customer is an Accounts-desk act and the desk is where the connection
 *     is. Refusing out loud costs a walk; queuing costs a wrong limit.
 *
 * Contrast `recordRepayment` (data/mutations/recordRepayment.ts), which IS
 * queued, and says at length why the same argument runs the other way there.
 */
export function openCreditAccount(
  input: OpenAccountInput,
  options: ApiCallOptions = {},
): Promise<ApiResult<OpenedAccount>> {
  const bad = guard(openAccountInput, 'credit.openAccount', input);
  if (bad !== null) return Promise.resolve(bad);
  return apiMutate(
    'credit.openAccount',
    input,
    (json): OpenedAccount => {
      const row = asRecord(json, 'credit.openAccount');
      return {
        accountId: asString(row['accountId'], 'accountId'),
        customerId: asString(row['customerId'], 'customerId'),
        termsDays: asCount(row['termsDays'], 'termsDays'),
        feeRateBpPerMonth: asCount(row['feeRateBpPerMonth'], 'feeRateBpPerMonth'),
        creditLimitMinor: asScaled(row['creditLimitMinor'], 'creditLimitMinor'),
      };
    },
    options,
  );
}

// ---------------------------------------------------------------------------
// Changing a limit — the compare-and-set, surfaced
// ---------------------------------------------------------------------------

/**
 * The server's token for "somebody else decided this limit while you were
 * deciding". A PLATFORM code, like `FEE_POLICY_UNCONFIRMED`.
 *
 * What it must never become is a silent retry. The whole point of the
 * compare-and-set (06 §6.6.1) is that the second author SEES the number that
 * won and decides again against it; re-sending the same figure under a fresh
 * claim would be last-write-wins with an extra step, which is precisely what
 * §3.6 rules out.
 */
export const LIMIT_VERSION_STALE = 'LIMIT_VERSION_STALE';

export interface LimitChanged {
  readonly accountId: string;
  readonly versionId: string;
  readonly supersedesId: string | null;
  readonly previousLimitMinor: MinorUnits;
  readonly creditLimitMinor: MinorUnits;
  readonly previousTermsDays: number;
  readonly termsDays: number;
  readonly feeRateBpPerMonth: number; // lint-money-ignore: an integer bp RATE, not minor units
  readonly effectiveFrom: string;
}

export type SetLimitOutcome =
  | { readonly kind: 'changed'; readonly result: LimitChanged }
  /** The CAS refused it. Nothing was changed; read the account again. */
  | { readonly kind: 'superseded'; readonly detail: string }
  | { readonly kind: 'refused'; readonly failure: ApiFailure };

/**
 * Change a credit limit (and the terms it ages against).
 *
 * ONLINE ONLY, and this is 06 §6.6.3(7) — *"severity-1 credit resolutions
 * require connectivity"* — applied at the point where a person could otherwise
 * be invited to do it offline. A queued limit edit is CLAUDE.md §2.2's
 * canonical hard case manufactured on purpose: a partitioned device cannot see
 * the version it is superseding, so it cannot state one, and a write with no
 * claim is last-write-wins wearing a contract.
 *
 * The fee rate is not sent. It is carried forward server-side, because the fee
 * preview and accrual read the account's CURRENT rate and a new one would
 * reprice history (06 §6.4).
 */
export async function setCreditLimit(
  input: SetLimitInput,
  options: ApiCallOptions = {},
): Promise<SetLimitOutcome> {
  const bad = guard(setLimitInput, 'credit.setLimit', input);
  if (bad !== null && !bad.ok) return { kind: 'refused', failure: bad.failure };

  const result = await apiMutate(
    'credit.setLimit',
    input,
    (json): LimitChanged => {
      const row = asRecord(json, 'credit.setLimit');
      return {
        accountId: asString(row['accountId'], 'accountId'),
        versionId: asString(row['versionId'], 'versionId'),
        supersedesId: asOptionalString(row['supersedesId'], 'supersedesId'),
        previousLimitMinor: asScaled(row['previousLimitMinor'], 'previousLimitMinor'),
        creditLimitMinor: asScaled(row['creditLimitMinor'], 'creditLimitMinor'),
        previousTermsDays: asCount(row['previousTermsDays'], 'previousTermsDays'),
        termsDays: asCount(row['termsDays'], 'termsDays'),
        feeRateBpPerMonth: asCount(row['feeRateBpPerMonth'], 'feeRateBpPerMonth'),
        effectiveFrom: asString(row['effectiveFrom'], 'effectiveFrom'),
      };
    },
    options,
  );
  if (result.ok) return { kind: 'changed', result: result.data };

  const detail = result.failure.detail ?? '';
  if (detail.includes(LIMIT_VERSION_STALE)) return { kind: 'superseded', detail };
  return { kind: 'refused', failure: result.failure };
}

// ---------------------------------------------------------------------------
// Cutting a customer off — the account lifecycle
// ---------------------------------------------------------------------------

/**
 * The server's token for "this account has moved since you looked at it".
 * A PLATFORM code, like `LIMIT_VERSION_STALE`.
 *
 * And, like that one, it must never become a silent retry. Somebody suspended
 * or reopened the account while this person was deciding; re-sending under a
 * fresh claim would apply a decision taken against a picture that no longer
 * exists. The person reads what the account says now and decides again.
 */
export const CREDIT_STATUS_STALE = 'CREDIT_STATUS_STALE';

/**
 * The server's token for "an account that still owes money is not closed".
 * The refusal names the alternative — suspend it — and the screen repeats it,
 * because a person who cannot close an account needs to know what they CAN do.
 */
export const CREDIT_STATUS_CLOSE_BLOCKED = 'CREDIT_STATUS_CLOSE_BLOCKED';

export interface StatusChanged {
  readonly accountId: string;
  /** False when the account was already in the status asked for. */
  readonly changed: boolean;
  readonly fromStatus: string;
  readonly status: string;
  /** The audit row this wrote, or null for a no-op. */
  readonly changeId: string | null;
  readonly exposureMinor: MinorUnits;
}

export type SetStatusOutcome =
  | { readonly kind: 'changed'; readonly result: StatusChanged }
  /** The account moved while this person was deciding. Nothing was changed. */
  | { readonly kind: 'stale'; readonly detail: string }
  /** Closing was refused because the account still owes money. */
  | { readonly kind: 'still-owing'; readonly detail: string }
  | { readonly kind: 'refused'; readonly failure: ApiFailure };

/**
 * Suspend a customer, put them back on, or close the account.
 *
 * ONLINE ONLY, and for a sharper reason than the limit form's. A suspension is
 * decided against the account's CURRENT position, and this device does not
 * hold that position — `app.credit_entry` is in no sync bucket, so there is no
 * balance here to decide against. Worse, a queued suspension would sit in an
 * ORDERED outbox behind the very credit sales it was meant to stop, arriving
 * after the damage it was written to prevent.
 *
 * So it goes over the API, it is refused out loud when the device cannot
 * reach the office, and NOTHING is queued. What this cannot do — reach a
 * tablet that is already dark — it does not pretend to do.
 */
export async function setCreditStatus(
  input: SetStatusInput,
  options: ApiCallOptions = {},
): Promise<SetStatusOutcome> {
  const bad = guard(setStatusInput, 'credit.setStatus', input);
  if (bad !== null && !bad.ok) return { kind: 'refused', failure: bad.failure };

  const result = await apiMutate(
    'credit.setStatus',
    input,
    (json): StatusChanged => {
      const row = asRecord(json, 'credit.setStatus');
      return {
        accountId: asString(row['accountId'], 'accountId'),
        changed: asBoolean(row['changed'], 'changed'),
        fromStatus: asString(row['fromStatus'], 'fromStatus'),
        status: asString(row['status'], 'status'),
        changeId: asOptionalString(row['changeId'], 'changeId'),
        exposureMinor: asScaled(row['exposureMinor'], 'exposureMinor'),
      };
    },
    options,
  );
  if (result.ok) return { kind: 'changed', result: result.data };

  const detail = result.failure.detail ?? '';
  if (detail.includes(CREDIT_STATUS_STALE)) return { kind: 'stale', detail };
  if (detail.includes(CREDIT_STATUS_CLOSE_BLOCKED)) return { kind: 'still-owing', detail };
  return { kind: 'refused', failure: result.failure };
}
