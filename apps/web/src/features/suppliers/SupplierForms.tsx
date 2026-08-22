/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WRITING A SUPPLIER, AND WRITING A SOURCE FOR A PRODUCT
 * ═══════════════════════════════════════════════════════════════════════════
 * "Suppliers" is the first item of the Phase 2 scope line, and until these two
 * forms existed a tenant could only get one by re-running the template seed.
 * `procurement.upsertSupplier` and `procurement.upsertSupplierProduct` were
 * guarded, tested and clientless.
 *
 * ---------------------------------------------------------------------------
 * NEITHER OF THESE IS QUEUED, AND THE SCREEN SAYS SO
 * ---------------------------------------------------------------------------
 * Both go over HTTP and are REFUSED, not queued, when the device is
 * partitioned — see the header over `upsertSupplier` in
 * `data/api/procurement.ts` for the three reasons. What matters here is that a
 * person who taps Save with no radio is told nothing was saved and nothing was
 * queued, in those words, rather than being left to assume it went.
 *
 * ---------------------------------------------------------------------------
 * THE CAPABILITY CHECKBOXES ARE THE TENANT'S OWN WORDS
 * ---------------------------------------------------------------------------
 * The list of capability types comes from `listSuppliers`, which returns the
 * tenant's own `code`/`name` rows alongside the platform `kind`. The label on
 * every checkbox is the TENANT's name for it. The only thing this file reads
 * from the platform half is `kind === HAULAGE`, and it reads it for one
 * purpose: to say out loud that ticking it is what makes a party eligible to
 * be handed a load (ADR-0001 — a carrier is a supplier, there is no vehicle).
 * No code here compares a tenant capability CODE to a literal (CLAUDE.md §2.9).
 *
 * ---------------------------------------------------------------------------
 * MONEY AND QUANTITY
 * ---------------------------------------------------------------------------
 * A quoted price is typed at the tenant's own currency precision, parsed by
 * `@erp/money`'s `parse` against the tenant's `CurrencySpec`, and carried to
 * the wire at the rate's ×10⁴ precision exactly — `minor * 10_000n`, no
 * rounding on the way in. It is a `bigint` from the moment it stops being
 * text. Lead time and payment terms are whole days, which are counts.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { MoneyError, parse } from '@erp/money';
import type { ApiCallOptions } from '../../data/api/client';
import {
  HAULAGE,
  upsertSupplier,
  upsertSupplierProduct,
  type Supplier,
  type SupplierCapability,
} from '../../data/api/procurement';
import type { LocalDb } from '../../data/db';
import {
  loadPurchaseUnits,
  type PurchasableProduct,
  type PurchaseUnit,
} from '../../data/queries/purchase-units';
import { uuidv7 } from '../../lib/uuidv7';
import { useCurrencySpec } from '../../money/CurrencyContext';
import { Icon } from '../../ui/Icon';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE ATTEMPT'S IDENTITY — THE KEY *AND* THE WALL CLOCK, MINTED TOGETHER
 * ═══════════════════════════════════════════════════════════════════════════
 * The server hashes the CANONICAL FORM OF THE WHOLE INPUT alongside the
 * idempotency key (`apps/api/src/canonical.ts`), and `clientWallAt` is part of
 * that input. A retry that keeps the key but stamps a fresh `clientWallAt` is
 * therefore "same key, different payload" — refused 409 IDEMPOTENCY_KEY_REUSE,
 * which is the server being right and the client being wrong.
 *
 * So the wall clock is minted ONCE, with the key, and both are held until the
 * save actually succeeds. That is also what the field means: when this DEVICE
 * made this write, not when this attempt happened to leave.
 *
 * Found by driving these forms against the deployed API rather than a mock —
 * a mocked transport does not compute the hash, so no unit test could have
 * caught it on its own.
 */
interface Attempt {
  readonly idempotencyKey: string;
  readonly clientWallAt: string;
}

function newAttempt(): Attempt {
  return { idempotencyKey: uuidv7(), clientWallAt: new Date().toISOString() };
}

/** What a refusal reads as. Offline is calm and specific, never a stack trace. */
function refusalText(
  kind: string,
  detail: string | null,
  message: string,
  what: string,
): string {
  return kind === 'offline'
    ? `Not saved. ${what} is kept on the server and this device cannot reach it. Nothing was queued and nothing was changed.`
    : `Not saved. ${detail ?? message}`;
}

// ---------------------------------------------------------------------------
// A supplier
// ---------------------------------------------------------------------------

export interface SupplierFormProps {
  /** Absent to create; present to amend that supplier. */
  readonly supplier?: Supplier | undefined;
  /** The tenant's own capability taxonomy, from `listSuppliers`. */
  readonly capabilityTypes: readonly SupplierCapability[];
  readonly apiOptions: ApiCallOptions;
  readonly onSaved: (supplierId: string) => void;
  readonly onCancel: () => void;
}

export function SupplierForm({
  supplier,
  capabilityTypes,
  apiOptions,
  onSaved,
  onCancel,
}: SupplierFormProps): ReactNode {
  const amending = supplier !== undefined;
  const [code, setCode] = useState(supplier?.code ?? '');
  const [name, setName] = useState(supplier?.name ?? '');
  const [termsText, setTermsText] = useState(String(supplier?.paymentTermsDays ?? 0));
  const [contactName, setContactName] = useState(supplier?.contactName ?? '');
  const [contactPhone, setContactPhone] = useState(supplier?.contactPhone ?? '');
  const [contactEmail, setContactEmail] = useState(supplier?.contactEmail ?? '');
  const [addressText, setAddressText] = useState(supplier?.addressText ?? '');
  const [notes, setNotes] = useState(supplier?.notes ?? '');
  const [isActive, setIsActive] = useState(supplier?.isActive ?? true);
  const [held, setHeld] = useState<readonly string[]>(
    supplier?.capabilities.map((c) => c.capabilityTypeId) ?? [],
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Held across every retry of THIS save, so a double-tap is one supplier and
  // a retry is a REPLAY rather than a 409 — see `Attempt` above.
  const [attempt, setAttempt] = useState<Attempt>(newAttempt);

  const toggle = useCallback((id: string) => {
    setHeld((current) =>
      current.includes(id) ? current.filter((h) => h !== id) : [...current, id],
    );
  }, []);

  const submit = useCallback(() => {
    if (code.trim().length === 0 || name.trim().length === 0) {
      setProblem('A supplier needs a code and a name — the code is how everyone refers to them.');
      return;
    }
    const terms = Number(termsText);
    if (!Number.isInteger(terms) || terms < 0 || terms > 365) {
      setProblem('Payment terms are a whole number of days, from 0 (on delivery) to 365.');
      return;
    }
    setProblem(null);
    setSaving(true);
    const optional = (v: string): string | undefined =>
      v.trim().length === 0 ? undefined : v.trim();
    void upsertSupplier(
      {
        ...attempt,
        ...(supplier === undefined ? {} : { supplierId: supplier.supplierId }),
        code: code.trim(),
        name: name.trim(),
        paymentTermsDays: terms,
        ...(optional(contactName) === undefined ? {} : { contactName: contactName.trim() }),
        ...(optional(contactPhone) === undefined ? {} : { contactPhone: contactPhone.trim() }),
        ...(optional(contactEmail) === undefined ? {} : { contactEmail: contactEmail.trim() }),
        ...(optional(addressText) === undefined ? {} : { addressText: addressText.trim() }),
        ...(optional(notes) === undefined ? {} : { notes: notes.trim() }),
        isActive,
        // ALWAYS sent, because sending it REPLACES the set — and a form that
        // showed the ticks then left them alone would be lying about what it
        // just did. Unticking the last one is a real act, not an omission.
        capabilityTypeIds: [...held],
      },
      apiOptions,
    ).then((result) => {
      setSaving(false);
      if (result.ok) {
        setAttempt(newAttempt());
        onSaved(result.data.supplierId);
        return;
      }
      setProblem(
        refusalText(
          result.failure.kind,
          result.failure.detail,
          result.failure.message,
          'A supplier',
        ),
      );
    });
  }, [
    addressText,
    apiOptions,
    attempt,
    code,
    contactEmail,
    contactName,
    contactPhone,
    held,
    isActive,
    name,
    notes,
    onSaved,
    supplier,
    termsText,
  ]);

  return (
    <form
      className="threshold-form"
      aria-label={amending ? 'Amend supplier' : 'New supplier'}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="threshold-form-field">
        <span>Their code</span>
        <input
          type="text"
          autoComplete="off"
          value={code}
          aria-label="Supplier code"
          onChange={(e) => setCode(e.currentTarget.value)}
        />
      </label>
      <label className="threshold-form-field">
        <span>Their name</span>
        <input
          type="text"
          autoComplete="off"
          value={name}
          aria-label="Supplier name"
          onChange={(e) => setName(e.currentTarget.value)}
        />
      </label>
      <label className="threshold-form-field">
        <span>Days to pay (0 is on delivery)</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={365}
          value={termsText}
          aria-label="Payment terms in days"
          onChange={(e) => setTermsText(e.currentTarget.value)}
        />
      </label>

      <fieldset className="adjust-kinds">
        <legend>What they do for us</legend>
        {capabilityTypes.length === 0 ? (
          <p className="adjust-kind-note">
            This tenant has not set up any supplier capabilities yet, so there is nothing to tick.
          </p>
        ) : null}
        {capabilityTypes.map((c) => (
          <label key={c.capabilityTypeId} className="threshold-form-field">
            <input
              type="checkbox"
              checked={held.includes(c.capabilityTypeId)}
              aria-label={c.name}
              onChange={() => toggle(c.capabilityTypeId)}
            />
            {/* The TENANT's word for it. The platform `kind` is only read to
                say what ticking it makes possible. */}
            <span>
              {c.name}
              {c.kind === HAULAGE ? ' — they can be handed a load to carry' : ''}
            </span>
          </label>
        ))}
      </fieldset>

      <label className="threshold-form-field">
        <span>Who to ask for</span>
        <input
          type="text"
          autoComplete="off"
          value={contactName}
          aria-label="Contact name"
          onChange={(e) => setContactName(e.currentTarget.value)}
        />
      </label>
      <label className="threshold-form-field">
        <span>Phone</span>
        <input
          type="tel"
          autoComplete="off"
          value={contactPhone}
          aria-label="Contact phone"
          onChange={(e) => setContactPhone(e.currentTarget.value)}
        />
      </label>
      <label className="threshold-form-field">
        <span>Email</span>
        <input
          type="email"
          autoComplete="off"
          value={contactEmail}
          aria-label="Contact email"
          onChange={(e) => setContactEmail(e.currentTarget.value)}
        />
      </label>
      <label className="threshold-form-field">
        <span>Where they are</span>
        <input
          type="text"
          autoComplete="off"
          value={addressText}
          aria-label="Supplier address"
          onChange={(e) => setAddressText(e.currentTarget.value)}
        />
      </label>
      <label className="threshold-form-field">
        <span>Anything worth remembering</span>
        <input
          type="text"
          autoComplete="off"
          value={notes}
          aria-label="Supplier notes"
          onChange={(e) => setNotes(e.currentTarget.value)}
        />
      </label>

      {/* DEACTIVATION IS NOT A DELETE, and the words say why. */}
      <label className="threshold-form-field">
        <input
          type="checkbox"
          checked={isActive}
          aria-label="Still in use"
          onChange={(e) => setIsActive(e.currentTarget.checked)}
        />
        <span>
          Still in use. Untick to stop them appearing on new orders — every order and receipt
          already against them keeps their name.
        </span>
      </label>

      {problem === null ? null : (
        <p className="device-gate-error" role="alert">
          <Icon name="alert" size={20} />
          <span>{problem}</span>
        </p>
      )}

      <div className="order-actions">
        <button type="submit" className="primary-action pressable" disabled={saving}>
          <Icon name="check" size={20} />
          {saving ? 'Saving…' : amending ? 'Save the changes' : 'Add the supplier'}
        </button>
        <button type="button" className="secondary-action pressable" onClick={onCancel}>
          Leave it
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// A source: this supplier can supply this product, in this unit, at this price
// ---------------------------------------------------------------------------

export interface SourceFormProps {
  readonly db: LocalDb;
  /** Only suppliers still in use are offered — a retired one is not a source. */
  readonly suppliers: readonly Supplier[];
  readonly products: readonly PurchasableProduct[];
  /** Pre-selected when the form is opened from a product's own comparison. */
  readonly productId?: string | undefined;
  readonly apiOptions: ApiCallOptions;
  readonly onSaved: () => void;
  readonly onCancel: () => void;
}

export function SourceForm({
  db,
  suppliers,
  products,
  productId: initialProductId,
  apiOptions,
  onSaved,
  onCancel,
}: SourceFormProps): ReactNode {
  const spec = useCurrencySpec();
  const [supplierId, setSupplierId] = useState('');
  const [productId, setProductId] = useState(initialProductId ?? '');
  const [units, setUnits] = useState<readonly PurchaseUnit[]>([]);
  const [uomId, setUomId] = useState('');
  const [supplierSku, setSupplierSku] = useState('');
  const [leadText, setLeadText] = useState('');
  const [priceText, setPriceText] = useState('');
  const [isPreferred, setIsPreferred] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState<Attempt>(newAttempt);

  /**
   * THE UNITS COME FROM THIS DEVICE'S OWN SYNCED CATALOGUE, not the server.
   * `product_uom` is in the `tenant_reference` bucket, so a device genuinely
   * holds which units a product may be bought in — the same rows receiving
   * converts with. Offering a unit the product does not declare as buyable
   * would earn a `PRECONDITION_FAILED` the person could do nothing about.
   */
  useEffect(() => {
    let alive = true;
    if (productId === '') {
      setUnits([]);
      setUomId('');
      return;
    }
    void loadPurchaseUnits(db, productId).then((found) => {
      if (!alive) return;
      setUnits(found);
      setUomId(found[0]?.uomId ?? '');
    });
    return () => {
      alive = false;
    };
  }, [db, productId]);

  const unit = useMemo(
    () => units.find((u) => u.uomId === uomId) ?? null,
    [units, uomId],
  );

  const submit = useCallback(() => {
    if (supplierId === '' || productId === '') {
      setProblem('Say who supplies it and what they supply.');
      return;
    }
    if (unit === null) {
      setProblem('Say which unit they sell it in. Only units this product can be bought in appear.');
      return;
    }
    let lead: number | undefined;
    if (leadText.trim().length > 0) {
      const parsed = Number(leadText);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3650) {
        setProblem('Lead time is a whole number of days.');
        return;
      }
      lead = parsed;
    }
    // A quote is OMITTED when unknown, never zeroed: a zero reads as free and
    // would put an unpriced source at the top of the comparison.
    let priceE4: bigint | undefined;
    if (priceText.trim().length > 0) {
      let minor: bigint;
      try {
        minor = parse(priceText.trim(), spec);
      } catch (err) {
        setProblem(
          err instanceof MoneyError
            ? 'Enter the quoted price using digits, and a dot for any decimals.'
            : 'That is not a price.',
        );
        return;
      }
      if (minor < 0n) {
        setProblem('A price cannot be negative.');
        return;
      }
      priceE4 = minor * 10_000n;
    }
    setProblem(null);
    setSaving(true);
    void upsertSupplierProduct(
      {
        ...attempt,
        supplierId,
        productId,
        purchaseUomId: unit.uomId,
        ...(supplierSku.trim().length === 0 ? {} : { supplierSku: supplierSku.trim() }),
        ...(lead === undefined ? {} : { leadTimeDays: lead }),
        ...(priceE4 === undefined ? {} : { lastPriceE4: priceE4.toString() }),
        isPreferred,
        isActive: true,
      },
      apiOptions,
    ).then((result) => {
      setSaving(false);
      if (result.ok) {
        setAttempt(newAttempt());
        onSaved();
        return;
      }
      setProblem(
        refusalText(result.failure.kind, result.failure.detail, result.failure.message, 'A source'),
      );
    });
  }, [
    apiOptions,
    attempt,
    isPreferred,
    leadText,
    onSaved,
    priceText,
    productId,
    spec,
    supplierId,
    supplierSku,
    unit,
  ]);

  return (
    <form
      className="threshold-form"
      aria-label="New source"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="threshold-form-field">
        <span>Who supplies it</span>
        <select
          value={supplierId}
          aria-label="Supplier for this source"
          onChange={(e) => setSupplierId(e.currentTarget.value)}
        >
          <option value="">Choose a supplier…</option>
          {suppliers.map((s) => (
            <option key={s.supplierId} value={s.supplierId}>
              {s.name} · {s.code}
            </option>
          ))}
        </select>
      </label>

      <label className="threshold-form-field">
        <span>What they supply</span>
        <select
          value={productId}
          aria-label="Product for this source"
          onChange={(e) => setProductId(e.currentTarget.value)}
        >
          <option value="">Choose a product…</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.code}
            </option>
          ))}
        </select>
      </label>

      <label className="threshold-form-field">
        <span>The unit they sell it in</span>
        <select
          value={uomId}
          aria-label="Purchase unit"
          onChange={(e) => setUomId(e.currentTarget.value)}
        >
          {units.map((u) => (
            <option key={u.uomId} value={u.uomId}>
              {u.uomLabel}
            </option>
          ))}
        </select>
      </label>
      {productId !== '' && units.length === 0 ? (
        <p className="adjust-kind-note">
          This device holds no unit this product can be bought in, so a source cannot be recorded
          against it here.
        </p>
      ) : null}
      {unit === null ? null : (
        <p className="adjust-kind-note">
          One {unit.uomLabel} is{' '}
          <span className="tabular">
            {unit.factorDen === 1n
              ? unit.factorNum.toString()
              : `${unit.factorNum.toString()}/${unit.factorDen.toString()}`}
          </span>{' '}
          {unit.stockingUomCode} — which is the unit every quote is compared in.
        </p>
      )}

      <label className="threshold-form-field">
        <span>Their code for it</span>
        <input
          type="text"
          autoComplete="off"
          value={supplierSku}
          aria-label="Supplier's own code for this product"
          onChange={(e) => setSupplierSku(e.currentTarget.value)}
        />
      </label>
      <label className="threshold-form-field">
        <span>Lead time in days</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={3650}
          value={leadText}
          aria-label="Lead time in days"
          onChange={(e) => setLeadText(e.currentTarget.value)}
        />
      </label>
      <label className="threshold-form-field">
        <span>
          Last price per {unit === null ? 'purchase unit' : unit.uomLabel} (leave empty if unknown)
        </span>
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={priceText}
          aria-label="Quoted price per purchase unit"
          onChange={(e) => setPriceText(e.currentTarget.value)}
        />
      </label>
      <p className="adjust-kind-note">
        Leave the price empty rather than typing zero. A zero reads as free and would sit at the
        top of the comparison; an empty one is recorded as “nothing bought from them yet”.
      </p>

      <label className="threshold-form-field">
        <input
          type="checkbox"
          checked={isPreferred}
          aria-label="Buy from them by default"
          onChange={(e) => setIsPreferred(e.currentTarget.checked)}
        />
        <span>
          Buy from them by default. Only one source per product can be the default, so ticking this
          takes it off whoever holds it — ordering from anyone else still needs no extra permission.
        </span>
      </label>

      {problem === null ? null : (
        <p className="device-gate-error" role="alert">
          <Icon name="alert" size={20} />
          <span>{problem}</span>
        </p>
      )}

      <div className="order-actions">
        <button type="submit" className="primary-action pressable" disabled={saving}>
          <Icon name="check" size={20} />
          {saving ? 'Saving…' : 'Record the source'}
        </button>
        <button type="button" className="secondary-action pressable" onClick={onCancel}>
          Leave it
        </button>
      </div>
    </form>
  );
}
