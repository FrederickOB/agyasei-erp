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
 * The one thing this client is allowed to remember about credit is an
 * IDENTIFIER (`data/session/credit-account-ref.ts`). Never a figure. An
 * identifier that has gone wrong fails loudly on the next read — the server
 * answers `NOT_FOUND` — whereas a figure that has gone stale reads exactly
 * like a fresh one.
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
  mutationEnvelopeSchema,
  zBusinessDate,
  zUuid,
  type MutationEnvelope,
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

/**
 * Is this text something the credit routes could address an account with?
 *
 * It says nothing about whether the account EXISTS — only the server knows
 * that, and it answers `NOT_FOUND` when it does not.
 */
export function isAccountRef(text: string): boolean {
  return zUuid.safeParse(text.trim()).success;
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
