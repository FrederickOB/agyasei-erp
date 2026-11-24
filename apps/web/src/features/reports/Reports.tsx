/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REPORTING — Phase 1 acceptance criterion 4
 * ═══════════════════════════════════════════════════════════════════════════
 * "HQ sees near-real-time (post-sync) stock and sales across every connected
 * location in one view."
 *
 * Four things about this screen are load-bearing and none of them is layout.
 *
 * 1. **WHOSE TOTAL IS IT.** The server resolves the locations a caller may
 *    report on from `app.effective_permission` on every request. Somebody
 *    holding the tenant-wide capability gets `scope.network === true` and a
 *    total that is the business's; an outlet manager gets `false` and a real
 *    total OF THEIR OWN OUTLETS. As figures they are indistinguishable, and
 *    mistaking the second for the first is a decision made on a number that
 *    is missing most of the company. Every panel therefore carries a scope
 *    chip, and the total row is worded differently in the two cases.
 *
 * 2. **EACH PANEL ASKS ITS OWN QUESTION.** Five independent server reads
 *    rather than one. A slow or refused cost report must not take the sales
 *    figures down with it, and a person who may see takings but not costs
 *    should see the takings.
 *
 * 3. **COST AND MARGIN ARE A NARROWER AUDIENCE.** They sit behind
 *    `report.view.margin`, so an outlet manager sees what they took and not
 *    what the goods cost. Where that capability is absent the figures are
 *    ABSENT — a stated absence, never a zero and never a blank cell.
 *
 * 4. **NOTHING HERE WORKS OFFLINE, AND IT SAYS SO.** These aggregates span
 *    locations this device does not hold; a partitioned tablet genuinely
 *    cannot compute them. Every panel renders `ServerUnavailable` rather than
 *    an empty table (`features/shell/ServerAnswer.tsx`).
 *
 * Money is `bigint` minor units and reaches the screen only through `<Money>`
 * against the tenant's CurrencySpec (ADR-0004, §8.9). Ratios are scaled
 * integers rounded once, explicitly, in `lib/ratio.ts`. There is no `Number`
 * arithmetic on any figure in this file.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { divRound } from '@erp/money';
import type { ApiCallOptions } from '../../data/api/client';
import { fetchHaulageSpend } from '../../data/api/logistics';
import type { LocalDb } from '../../data/db';
import {
  fetchCashPosition,
  fetchDistributionCost,
  fetchInventoryDays,
  fetchSalesByLocation,
  fetchStockOnHand,
  type DistributionCostLine,
  type ReportScope,
} from '../../data/api/reports';
import { CAPABILITY, holdsCapability, type PermissionsState } from '../../data/api/session';
import { useApiQuery, type ApiQueryState } from '../../data/api/use-api-query';
import { readDeviceLocation } from '../../data/queries/session';
import { useLiveQuery } from '../../data/use-live-query';
import { businessDateFor } from '../../lib/business-date';
import { formatQtyScaled } from '../../lib/quantity';
import { formatDaysE4, formatPercentE4 } from '../../lib/ratio';
import { Money } from '../../money/Money';
import { Icon } from '../../ui/Icon';
import { withheld } from './withheld';
import { Unit } from '../../ui/Unit';
import { FetchedAt, ServerPending, ServerUnavailable } from '../shell/ServerAnswer';

// ---------------------------------------------------------------------------
// Business dates — the trading day, not the tablet's calendar
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** Shift a `YYYY-MM-DD` by whole days. Exact; no timezone enters here. */
function shiftYmd(ymd: string, days: number): string {
  const at = Date.parse(`${ymd}T00:00:00Z`);
  return new Date(at + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Why the default range is derived from the LOCATION's timezone rather than
 * the tablet's: the trading day is the location's, and a tablet that has
 * wandered onto the wrong zone must not silently report a different day than
 * the one the sales were filed under (`lib/business-date.ts`).
 */
function defaultRange(timeZone: string | null): { from: string; to: string } {
  const to = businessDateFor(new Date().toISOString(), timeZone);
  return { from: shiftYmd(to, -6), to };
}

// ---------------------------------------------------------------------------
// Scope — the distinction the whole screen turns on
// ---------------------------------------------------------------------------

function ScopeChip({ scope }: { readonly scope: ReportScope }): ReactNode {
  const places = `${String(scope.locationCount)} ${scope.locationCount === 1 ? 'location' : 'locations'}`;
  return scope.network ? (
    <span className="scope-chip scope-network">
      <Icon name="live" size={16} />
      Whole organisation · {places}
    </span>
  ) : (
    <span className="scope-chip scope-partial">
      <Icon name="pin" size={16} />
      Your {places} only — not the whole organisation
    </span>
  );
}

/** The words on a total row. Never just "Total". */
function totalLabel(scope: ReportScope): string {
  return scope.network ? 'Total, whole organisation' : 'Total of your locations only';
}

// ---------------------------------------------------------------------------
// One panel: the shape every report section shares
// ---------------------------------------------------------------------------

function Panel({
  title,
  what,
  state,
  onRetry,
  children,
}: {
  readonly title: string;
  readonly what: string;
  readonly state: ApiQueryState<unknown>;
  readonly onRetry: () => void;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section className="report-panel">
      <header className="report-panel-head">
        <h2>{title}</h2>
        {state.status === 'ready' ? <FetchedAt atMs={state.fetchedAtMs} /> : null}
      </header>
      {state.status === 'loading' ? <ServerPending shape="table" what={what} slow={state.slow} /> : null}
      {state.status === 'failed' ? (
        <ServerUnavailable what={what} failure={state.failure} onRetry={onRetry} />
      ) : null}
      {state.status === 'ready' ? children : null}
    </section>
  );
}

/**
 * A capability this session does not hold. The figures are ABSENT and said to
 * be absent — the alternative, a table of zeroes, is a set of numbers that
 * would be read, compared to a target and acted on.
 */
function NotYours({ title, what }: { readonly title: string; readonly what: string }): ReactNode {
  return (
    <section className="report-panel">
      <header className="report-panel-head">
        <h2>{title}</h2>
      </header>
      <div className="server-answer server-answer-calm" role="status">
        <Icon name="alert" size={28} />
        <div className="server-answer-body">
          <h3 className="server-answer-title">Not part of what you can see.</h3>
          <p className="server-answer-text">
            {what} is limited to a narrower group than the takings figures above. Nothing is shown
            here rather than a set of zeroes, which would read as figures.
          </p>
        </div>
      </div>
    </section>
  );
}

interface RangeProps {
  readonly from: string;
  readonly to: string;
  readonly apiOptions: ApiCallOptions;
}

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

function SalesPanel({ from, to, apiOptions }: RangeProps): ReactNode {
  const { state, refresh } = useApiQuery(
    () => fetchSalesByLocation({ from, to }, apiOptions),
    [from, to, apiOptions],
  );
  return (
    <Panel title="Sales" what="Sales by location" state={state} onRetry={refresh}>
      {state.status === 'ready' ? (
        <>
          <ScopeChip scope={state.data.scope} />
          <div className="report-table-scroll">
            <table className="report-table">
              <caption className="visually-hidden">
                Sales by location from {state.data.from} to {state.data.to}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Location</th>
                  <th scope="col" className="numeric">Sales</th>
                  <th scope="col" className="numeric">Net of tax</th>
                  <th scope="col" className="numeric">Tax</th>
                  <th scope="col" className="numeric">Billed</th>
                </tr>
              </thead>
              <tbody>
                {state.data.locations.map((l) => (
                  <tr key={l.locationId}>
                    <th scope="row">
                      <span className="report-loc-name">{l.locationName}</span>
                      <span className="report-loc-code tabular">{l.locationCode}</span>
                    </th>
                    <td className="numeric tabular">{String(l.saleCount)}</td>
                    <td className="numeric"><Money amount={l.netRevenueMinor} /></td>
                    <td className="numeric"><Money amount={l.taxTotalMinor} /></td>
                    <td className="numeric"><Money amount={l.totalMinor} /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">{totalLabel(state.data.scope)}</th>
                  <td className="numeric tabular">{String(state.data.total.saleCount)}</td>
                  <td className="numeric"><Money amount={state.data.total.netRevenueMinor} /></td>
                  <td className="numeric"><Money amount={state.data.total.taxTotalMinor} /></td>
                  <td className="numeric"><Money amount={state.data.total.totalMinor} /></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      ) : null}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Cash position
// ---------------------------------------------------------------------------

function CashPanel({ from, to, apiOptions }: RangeProps): ReactNode {
  const { state, refresh } = useApiQuery(
    () => fetchCashPosition({ from, to }, apiOptions),
    [from, to, apiOptions],
  );
  return (
    <Panel title="Cash position" what="The cash position" state={state} onRetry={refresh}>
      {state.status === 'ready' ? (
        <>
          <ScopeChip scope={state.data.scope} />
          <div className="report-table-scroll">
            <table className="report-table">
              <thead>
                <tr>
                  <th scope="col">Location</th>
                  <th scope="col" className="numeric">Settled at the counter</th>
                  <th scope="col" className="numeric">On account</th>
                  <th scope="col" className="numeric">Billed</th>
                </tr>
              </thead>
              <tbody>
                {state.data.locations.map((l) => (
                  <tr key={l.locationId}>
                    <th scope="row">
                      <span className="report-loc-name">{l.locationName}</span>
                      <span className="report-loc-code tabular">{l.locationCode}</span>
                    </th>
                    <td className="numeric"><Money amount={l.immediateTenderMinor} /></td>
                    <td className="numeric"><Money amount={l.creditTenderMinor} /></td>
                    <td className="numeric"><Money amount={l.billedTotalMinor} /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">{totalLabel(state.data.scope)}</th>
                  <td className="numeric"><Money amount={state.data.total.immediateTenderMinor} /></td>
                  <td className="numeric"><Money amount={state.data.total.creditTenderMinor} /></td>
                  <td className="numeric"><Money amount={state.data.total.billedTotalMinor} /></td>
                </tr>
              </tfoot>
            </table>
          </div>
          {/* By the tenant's OWN methods — the names are its rows, rendered,
              never compared. Mobile money shows as itself rather than folded
              into "the counter". */}
          {state.data.total.tenders.length > 0 ? (
            <div className="report-table-scroll">
              <table className="report-table" aria-label="By payment method">
                <thead>
                  <tr>
                    <th scope="col">Payment method</th>
                    <th scope="col" className="numeric">Sales</th>
                    <th scope="col" className="numeric">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {state.data.total.tenders.map((t) => (
                    <tr key={t.methodId}>
                      <th scope="row">
                        {t.name}
                        {t.isOnAccount ? <span className="report-loc-code"> on account</span> : null}
                      </th>
                      <td className="numeric tabular">{t.saleCount.toString()}</td>
                      <td className="numeric"><Money amount={t.amountMinor} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {/* The cash-up view (08 §8.2a): how many tills were counted, and
              whether the counts reconciled to the minor unit. */}
          <ul className="report-caveats" aria-label="Tills">
            {state.data.locations.map((l) => (
              <li key={`till-${l.locationId}`}>
                {l.locationName}: {l.tills.closed.toString()} of {l.tills.opened.toString()} tills closed,{' '}
                {l.tills.counted.toString()} counted
                {l.tills.offCount === 0n ? (
                  ', every count to the minor unit'
                ) : (
                  <>
                    , {l.tills.offCount.toString()} off by a net{' '}
                    <Money amount={l.tills.varianceMinor < 0n ? -l.tills.varianceMinor : l.tills.varianceMinor} />{' '}
                    {l.tills.varianceMinor < 0n ? 'short' : 'over'}
                  </>
                )}
                {l.tills.openedOffline > 0n ? ` · ${l.tills.openedOffline.toString()} opened offline` : ''}
              </li>
            ))}
          </ul>
          <p className="report-note">
            Payments received against accounts, across the whole organisation:{' '}
            <Money amount={state.data.unattributed.creditReceiptsMinor} />. {state.data.unattributed.reason}
          </p>
          {/* The server's own statements about what this figure is NOT are
              shown, not summarised: this is what the till BILLED, and calling
              it the drawer would be the confident wrong number again. */}
          <ul className="report-caveats">
            {state.data.caveats.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </>
      ) : null}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Stock on hand
// ---------------------------------------------------------------------------

/** §8.10: no unbounded list. The rest is a count, not a scroll to nowhere. */
const STOCK_ROW_CAP = 50;

function StockPanel({ apiOptions }: { readonly apiOptions: ApiCallOptions }): ReactNode {
  const { state, refresh } = useApiQuery(
    () => fetchStockOnHand({ onlyNonZero: true }, apiOptions),
    [apiOptions],
  );
  return (
    <Panel title="Stock on hand" what="Stock on hand" state={state} onRetry={refresh}>
      {state.status === 'ready' ? (
        <>
          <ScopeChip scope={state.data.scope} />
          <p className="report-note">
            Counted in each product’s stocking unit, derived from the movement ledger. Products
            with nothing on hand anywhere are left out of this list.
          </p>
          <div className="report-table-scroll">
            <table className="report-table">
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  <th scope="col" className="numeric">
                    {state.data.scope.network ? 'On hand, whole organisation' : 'On hand, your locations'}
                  </th>
                </tr>
              </thead>
              <tbody>
                {state.data.networkByProduct.slice(0, STOCK_ROW_CAP).map((p) => (
                  <tr key={p.productId}>
                    <th scope="row">
                      <span className="report-loc-name">{p.productName}</span>
                      <span className="report-loc-code tabular">{p.skuCode}</span>
                    </th>
                    <td className="numeric tabular">
                      {formatQtyScaled(p.qtyOnHand, p.qtyScale)} <Unit code={p.uomCode} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {state.data.networkByProduct.length > STOCK_ROW_CAP ? (
            <p className="report-note">
              Showing the first {String(STOCK_ROW_CAP)} of{' '}
              {String(state.data.networkByProduct.length)} products.
            </p>
          ) : null}
        </>
      ) : null}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Inventory days and margin — behind report.view.margin
// ---------------------------------------------------------------------------

/**
 * A withheld ratio, rendered as the absence it is with the server's reason.
 * `INCOMPLETE_COST_BASIS` means some product with movement here has never had
 * a costed receipt behind it; a ratio computed from the rest would understate
 * cost, inflating BOTH margin and inventory days, and both would look
 * reasonable next to the target.
 */
function InventoryDaysPanel({ from, to, apiOptions }: RangeProps): ReactNode {
  const { state, refresh } = useApiQuery(
    () => fetchInventoryDays({ from, to }, apiOptions),
    [from, to, apiOptions],
  );
  return (
    <Panel
      title="Stock cover and margin"
      what="Inventory days and margin"
      state={state}
      onRetry={refresh}
    >
      {state.status === 'ready' ? (
        <>
          <ScopeChip scope={state.data.scope} />
          <div className="report-table-scroll">
            <table className="report-table">
              <thead>
                <tr>
                  <th scope="col">Location</th>
                  <th scope="col" className="numeric">Days of cover</th>
                  <th scope="col" className="numeric">Gross margin</th>
                  <th scope="col" className="numeric">Stock at cost</th>
                  <th scope="col" className="numeric">Cost of sales</th>
                </tr>
              </thead>
              <tbody>
                {state.data.locations.map((l) => (
                  <tr key={l.locationId}>
                    <th scope="row">
                      <span className="report-loc-name">{l.locationName}</span>
                      <span className="report-loc-code tabular">{l.locationCode}</span>
                    </th>
                    <td className="numeric tabular">
                      {l.inventoryDaysE4 === null ? (
                        <span className="figure-withheld">{withheld(l.unavailable)}</span>
                      ) : (
                        formatDaysE4(l.inventoryDaysE4)
                      )}
                    </td>
                    <td className="numeric tabular">
                      {l.grossMarginPctE4 === null ? (
                        <span className="figure-withheld">{withheld(l.unavailable)}</span>
                      ) : (
                        `${formatPercentE4(l.grossMarginPctE4)}%`
                      )}
                    </td>
                    <td className="numeric">
                      {l.stockAtCostMinor === null ? (
                        <span className="figure-withheld">{withheld(l.unavailable)}</span>
                      ) : (
                        <Money amount={l.stockAtCostMinor} />
                      )}
                    </td>
                    <td className="numeric">
                      {l.cogsMinor === null ? (
                        <span className="figure-withheld">{withheld(l.unavailable)}</span>
                      ) : (
                        <Money amount={l.cogsMinor} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">{totalLabel(state.data.scope)}</th>
                  <td className="numeric tabular">
                    {state.data.total.inventoryDaysE4 === null ? (
                      <span className="figure-withheld">{withheld(state.data.total.unavailable)}</span>
                    ) : (
                      formatDaysE4(state.data.total.inventoryDaysE4)
                    )}
                  </td>
                  <td className="numeric tabular">
                    {state.data.total.grossMarginPctE4 === null ? (
                      <span className="figure-withheld">{withheld(state.data.total.unavailable)}</span>
                    ) : (
                      `${formatPercentE4(state.data.total.grossMarginPctE4)}%`
                    )}
                  </td>
                  <td className="numeric">
                    {state.data.total.stockAtCostMinor === null ? (
                      <span className="figure-withheld">{withheld(state.data.total.unavailable)}</span>
                    ) : (
                      <Money amount={state.data.total.stockAtCostMinor} />
                    )}
                  </td>
                  <td className="numeric">
                    {state.data.total.cogsMinor === null ? (
                      <span className="figure-withheld">{withheld(state.data.total.unavailable)}</span>
                    ) : (
                      <Money amount={state.data.total.cogsMinor} />
                    )}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="report-note">{state.data.method}</p>
        </>
      ) : null}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Distribution cost — behind report.view.margin
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE NUMBER ADR-0001 PROMISED IN EXCHANGE FOR GIVING UP THE FLEET
 * ═══════════════════════════════════════════════════════════════════════════
 * The plan and the financial model both assumed an owned fleet absorbing
 * volume, and attributed a 5.0% → 2.5% fall in distribution cost to it.
 * ADR-0001 removed the fleet. What was promised instead was that the ERP would
 * MEASURE distribution cost as a percentage of revenue, per location and per
 * grouping node, so the real trajectory is visible and somebody qualified can
 * judge it (`open-questions.md` Q1). This panel is where a person sees it.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO TARGET LINE ON THIS SCREEN
 * ---------------------------------------------------------------------------
 * Deliberate, and worth stating so nobody adds one. The 5.0% → 2.5% curve is a
 * figure in ONE tenant's financial model. It is not on the wire, no tenant
 * configuration carries it, and hard-coding it here would put tenant #1's
 * numbers into platform code — exactly what CLAUDE.md §2.9 and ADR-0006
 * forbid. When a target belongs to a tenant it will arrive as tenant data and
 * be rendered from that. Until then the screen shows what IS, and says so.
 *
 * ---------------------------------------------------------------------------
 * ZERO, ABSENT, AND UNDEFINED ARE THREE DIFFERENT THINGS
 * ---------------------------------------------------------------------------
 * · nothing moved      → the cost really is zero and the ratio really is 0.0%,
 *                        and the delivery count beside it says why.
 * · freight not agreed  → the sum is a FLOOR. The row is marked, because a
 *                        partial basis read as a complete one understates the
 *                        very trajectory this panel exists to expose.
 * · no revenue          → a percentage of nothing is undefined, not zero. The
 *                        COST is still shown: a warehouse has no till and
 *                        still pays hauliers, and dropping its spend is how a
 *                        network ratio ends up flattering itself.
 *
 * Every figure is a `bigint` — money through `<Money>`, the percentage through
 * `formatPercentE4`, which rounds once, in integer arithmetic (`lib/ratio.ts`).
 * Nothing on this screen does arithmetic on a displayed value.
 */

/** The percentage cell: a ratio, an absence with the server's reason, or both. */
function RatioCell({ line }: { readonly line: DistributionCostLine }): ReactNode {
  if (line.distributionCostPctE4 === null) {
    return <span className="figure-withheld">{withheld(line.unavailable)}</span>;
  }
  return (
    <>
      <span className="tabular">{formatPercentE4(line.distributionCostPctE4)}%</span>
      {line.deliveriesWithNoAgreedFreight > 0 ? (
        <span className="figure-withheld"> at least</span>
      ) : null}
    </>
  );
}

/** The cost cell. A zero is printed as a zero ONLY when it is a real zero. */
function CostCell({ line }: { readonly line: DistributionCostLine }): ReactNode {
  if (line.distributionCostMinor === null) {
    return <span className="figure-withheld">{withheld(line.unavailable)}</span>;
  }
  return <Money amount={line.distributionCostMinor} />;
}

/** How many loads the figure rests on — the zero-versus-gap tell. */
function DeliveriesCell({ line }: { readonly line: DistributionCostLine }): ReactNode {
  if (line.deliveryCount === 0) return <span className="figure-withheld">nothing moved</span>;
  return (
    <>
      <span className="tabular">{String(line.deliveryCount)}</span>
      {line.deliveriesWithNoAgreedFreight > 0 ? (
        <span className="figure-withheld">
          {' '}
          ({String(line.deliveriesWithNoAgreedFreight)} with no agreed freight)
        </span>
      ) : null}
    </>
  );
}

function DistributionPanel({ from, to, apiOptions }: RangeProps): ReactNode {
  const { state, refresh } = useApiQuery(
    () => fetchDistributionCost({ from, to }, apiOptions),
    [from, to, apiOptions],
  );
  return (
    <Panel
      title="Cost of moving the goods"
      what="Distribution cost against revenue"
      state={state}
      onRetry={refresh}
    >
      {state.status === 'ready' ? (
        <>
          <ScopeChip scope={state.data.scope} />

          {/* The headline: one ratio, for whatever this caller's scope is. */}
          <p className="report-note">
            <strong>
              {state.data.total.distributionCostPctE4 === null ? (
                <span className="figure-withheld">{withheld(state.data.total.unavailable)}</span>
              ) : (
                <span className="tabular">
                  {formatPercentE4(state.data.total.distributionCostPctE4)}% of revenue
                </span>
              )}
            </strong>{' '}
            went on moving goods between {state.data.from} and {state.data.to} —{' '}
            <CostCell line={state.data.total} /> against{' '}
            <Money amount={state.data.total.netRevenueMinor} /> taken, net of tax.
          </p>

          <div className="report-table-scroll">
            <table className="report-table">
              <thead>
                <tr>
                  <th scope="col">Location</th>
                  <th scope="col" className="numeric">Revenue, net of tax</th>
                  <th scope="col" className="numeric">Cost of moving goods</th>
                  <th scope="col" className="numeric">As % of revenue</th>
                  <th scope="col" className="numeric">Loads</th>
                </tr>
              </thead>
              <tbody>
                {state.data.locations.map((l) => (
                  <tr key={l.locationId}>
                    <th scope="row">
                      <span className="report-loc-name">{l.locationName}</span>
                      <span className="report-loc-code tabular">{l.locationCode}</span>
                    </th>
                    <td className="numeric"><Money amount={l.netRevenueMinor} /></td>
                    <td className="numeric"><CostCell line={l} /></td>
                    <td className="numeric"><RatioCell line={l} /></td>
                    <td className="numeric"><DeliveriesCell line={l} /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">{totalLabel(state.data.scope)}</th>
                  <td className="numeric"><Money amount={state.data.total.netRevenueMinor} /></td>
                  <td className="numeric"><CostCell line={state.data.total} /></td>
                  <td className="numeric"><RatioCell line={state.data.total} /></td>
                  <td className="numeric"><DeliveriesCell line={state.data.total} /></td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* PER REGION — or per whatever this tenant calls its grouping nodes.
              The platform sees a GROUP node and renders the tenant's own name
              for it; nothing here says "region" about a row (ADR-0006). */}
          {state.data.groups.length > 0 ? (
            <div className="report-table-scroll">
              <table className="report-table">
                <caption>
                  Groupings
                  {state.data.groupsNest
                    ? ' — these nest, so they do not add up to the total above'
                    : ''}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Grouping</th>
                    <th scope="col" className="numeric">Locations</th>
                    <th scope="col" className="numeric">Revenue, net of tax</th>
                    <th scope="col" className="numeric">Cost of moving goods</th>
                    <th scope="col" className="numeric">As % of revenue</th>
                    <th scope="col" className="numeric">Loads</th>
                  </tr>
                </thead>
                <tbody>
                  {state.data.groups.map((g) => (
                    <tr key={g.groupId}>
                      <th scope="row">
                        <span className="report-loc-name">{g.groupName}</span>
                        <span className="report-loc-code tabular">{g.groupCode}</span>
                      </th>
                      <td className="numeric tabular">{String(g.locationCount)}</td>
                      <td className="numeric"><Money amount={g.netRevenueMinor} /></td>
                      <td className="numeric"><CostCell line={g} /></td>
                      <td className="numeric"><RatioCell line={g} /></td>
                      <td className="numeric"><DeliveriesCell line={g} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {/* THE DATING WARNING. A delivery dated by a device clock is dated by
              something 03 §3.4.2 does not trust, and a ratio computed across a
              period boundary inherits it. Said only when it actually happened. */}
          {state.data.periodBasis.datedByDispatchClock +
            state.data.periodBasis.datedByRowCreated >
          0 ? (
            <p className="adjust-rejected" role="status">
              <Icon name="alert" size={18} />
              <span>
                {String(
                  state.data.periodBasis.datedByDispatchClock +
                    state.data.periodBasis.datedByRowCreated,
                )}{' '}
                of these deliveries carry no business date anybody asserted, so they were placed in
                this period by a clock rather than by a person. Figures that straddle the start or
                the end of the period inherit that.
              </span>
            </p>
          ) : null}

          <p className="report-note">{state.data.unavailableReason}</p>
          <p className="report-note">{state.data.method}</p>
        </>
      ) : null}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Haulage per carrier — the negotiating view, behind report.view.margin
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RATIO IS THE OUTCOME. THIS IS THE LEVER.
 * ═══════════════════════════════════════════════════════════════════════════
 * The panel above says what proportion of revenue went on moving goods.
 * ADR-0001 gave up the owned fleet on the argument that third-party rates
 * could be driven DOWN as volume grew — and a rate is driven down in one
 * conversation, with one haulier, holding what that haulier has actually been
 * agreed over a period and how many loads it was for. Without this split the
 * founder can watch the ratio move and has nothing to act on.
 *
 * It is also ordinary accounts-payable-by-supplier, which is exactly why a
 * carrier is a supplier here and never a truck (ADR-0001).
 *
 * ---------------------------------------------------------------------------
 * A FLOOR IS NOT A TOTAL, AND THE ROW SAYS WHICH IT IS
 * ---------------------------------------------------------------------------
 * A load dispatched with no agreed freight contributes nothing to the sum. So
 * a carrier's spend is a FLOOR whenever any of its loads went out with nothing
 * agreed, and the row says "at least" — because walking into a rate
 * negotiation with a figure that is quietly missing four loads is worse than
 * walking in with no figure at all.
 *
 * The share of spend is computed in integer arithmetic from the two `bigint`
 * sums, rounded ONCE, and nothing downstream computes with the rounded value.
 * It is not derived from anything already rendered.
 */
function carrierSharePctE4(spendMinor: bigint, totalMinor: bigint): bigint | null {
  if (totalMinor <= 0n) return null;
  return divRound(spendMinor * 1_000_000n, totalMinor, 'half-up');
}

function CarrierPanel({ from, to, apiOptions }: RangeProps): ReactNode {
  const input = useMemo(() => ({ from, to }), [from, to]);
  const { state, refresh } = useApiQuery(
    () => fetchHaulageSpend(input, apiOptions),
    [input, apiOptions],
  );
  return (
    <Panel
      title="What each haulier has been agreed"
      what="Haulage spend by carrier"
      state={state}
      onRetry={refresh}
    >
      {state.status === 'ready' ? (
        <>
          <ScopeChip scope={state.data.scope} />

          <p className="report-note">
            <strong>
              <Money amount={state.data.total.haulageSpendMinor} />
            </strong>{' '}
            agreed across {String(state.data.total.deliveryCount)} load
            {state.data.total.deliveryCount === 1 ? '' : 's'}
            {state.data.total.deliveriesWithNoAgreedFreight > 0 ? (
              <>
                {' '}
                — <span className="figure-withheld">at least</span>, because{' '}
                {String(state.data.total.deliveriesWithNoAgreedFreight)} of them went out with
                nothing agreed
              </>
            ) : null}
            .
          </p>

          {state.data.carriers.length === 0 ? (
            <div className="empty-state">
              <Icon name="download" size={40} />
              <span className="empty-title">No load was handed to anybody in this period</span>
              <p className="empty-body">
                Nothing moved through a haulier between these dates, so there is no rate to
                negotiate from yet.
              </p>
            </div>
          ) : (
            <div className="report-table-scroll">
              <table className="report-table">
                <caption>
                  Every haulier that carried a load in this period, most agreed first
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Haulier</th>
                    <th scope="col" className="numeric">Agreed</th>
                    <th scope="col" className="numeric">Share of the spend</th>
                    <th scope="col" className="numeric">Loads</th>
                  </tr>
                </thead>
                <tbody>
                  {state.data.carriers.map((c) => {
                    const share = carrierSharePctE4(
                      c.haulageSpendMinor,
                      state.data.total.haulageSpendMinor,
                    );
                    return (
                      <tr key={c.carrierSupplierId}>
                        <th scope="row">
                          <span className="report-loc-name">{c.carrierName}</span>
                        </th>
                        <td className="numeric">
                          <Money amount={c.haulageSpendMinor} />
                          {c.deliveriesWithNoAgreedFreight > 0 ? (
                            <span className="figure-withheld"> at least</span>
                          ) : null}
                        </td>
                        <td className="numeric">
                          {share === null ? (
                            <span className="figure-withheld">nothing agreed yet</span>
                          ) : (
                            <span className="tabular">{formatPercentE4(share)}%</span>
                          )}
                        </td>
                        <td className="numeric tabular">
                          {String(c.deliveryCount)}
                          {c.deliveriesWithNoAgreedFreight > 0 ? (
                            <span className="figure-withheld">
                              {' '}
                              ({String(c.deliveriesWithNoAgreedFreight)} with no agreed freight)
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">{totalLabel(state.data.scope)}</th>
                    <td className="numeric">
                      <Money amount={state.data.total.haulageSpendMinor} />
                    </td>
                    <td className="numeric" />
                    <td className="numeric tabular">
                      {String(state.data.total.deliveryCount)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {/* WHAT THE FIGURE IS, in the server's own words rather than a
              paraphrase that could drift from it. An agreed rate is not an
              invoice, and a rate conversation held against the wrong one is a
              conversation about the wrong number. */}
          <p className="report-note">{state.data.method}</p>
          <p className="report-note">{state.data.periodBasis.note}</p>
        </>
      ) : null}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export interface ReportsProps {
  readonly db: LocalDb;
  readonly permissions: PermissionsState;
  readonly apiOptions?: ApiCallOptions;
}

/**
 * The default period is the LOCATION's trading week, so the screen resolves
 * where it is standing BEFORE it asks anything.
 *
 * That ordering is not tidiness. Asking first and re-asking when the timezone
 * arrives would drop every panel back to skeletons a beat after it had
 * figures on it — and, worse, would briefly show a period the operator never
 * chose. One local read, then one server read per panel.
 */
/**
 * One question at a time. With every panel at once this screen was over
 * 12,000px on a tablet — each panel lists every location — and asked the
 * server six things on every visit over a metered connection. A section asks
 * only what it shows. "Everything" keeps the whole page for whoever wants to
 * read it end to end.
 */
type Section = 'sales' | 'cash' | 'stock' | 'margin' | 'haulage' | 'all';

const SECTIONS: readonly { readonly id: Section; readonly label: string }[] = [
  { id: 'sales', label: 'Sales' },
  { id: 'cash', label: 'Cash' },
  { id: 'stock', label: 'Stock' },
  { id: 'margin', label: 'Margin & cover' },
  { id: 'haulage', label: 'Moving goods' },
  { id: 'all', label: 'Everything' },
];

/** Stock on hand is "now", not a period: no date range beside it. */
const RANGED: ReadonlySet<Section> = new Set<Section>(['sales', 'cash', 'margin', 'haulage', 'all']);

export function Reports({ db, permissions, apiOptions }: ReportsProps): ReactNode {
  const location = useLiveQuery(db, readDeviceLocation, []);
  if (location === undefined) {
    // A local read, so this is a frame or two, not a spinner.
    return (
      <div className="reports-screen">
        <ServerPending shape="table" what="Reporting" rows={2} />
      </div>
    );
  }
  return (
    <ReportsFor
      timeZone={location?.timeZone ?? null}
      permissions={permissions}
      {...(apiOptions === undefined ? {} : { apiOptions })}
    />
  );
}

function ReportsFor({
  timeZone,
  permissions,
  apiOptions,
}: {
  readonly timeZone: string | null;
  readonly permissions: PermissionsState;
  readonly apiOptions?: ApiCallOptions;
}): ReactNode {
  const initial = useMemo(() => defaultRange(timeZone), [timeZone]);
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  // Derived until somebody changes it, and then theirs. The derived value is
  // the location's trading week, not the tablet's calendar week.
  const activeFrom = from ?? initial.from;
  const activeTo = to ?? initial.to;
  const options = useMemo<ApiCallOptions>(() => apiOptions ?? {}, [apiOptions]);
  const rangeValid = activeFrom <= activeTo;

  const canSeeMargin = holdsCapability(permissions, CAPABILITY.reportMargin);
  const [section, setSection] = useState<Section>('sales');
  const showing = (s: Section): boolean => section === s || section === 'all';
  const ranged = RANGED.has(section);

  return (
    <div className="reports-screen">
      <div className="chip-row report-sections" role="group" aria-label="Report section">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className="chip pressable"
            aria-pressed={section === s.id}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>

      {ranged ? (
        <form className="report-range" onSubmit={(e) => e.preventDefault()}>
          <label className="report-range-field">
            <span>From</span>
            <input
              type="date"
              value={activeFrom}
              max={activeTo}
              onChange={(e) => setFrom(e.currentTarget.value)}
            />
          </label>
          <label className="report-range-field">
            <span>To</span>
            <input
              type="date"
              value={activeTo}
              min={activeFrom}
              onChange={(e) => setTo(e.currentTarget.value)}
            />
          </label>
        </form>
      ) : null}

      {/* Refused on the device rather than sent: the shared contract rejects a
          reversed range instead of normalising it, because a silently swapped
          range is the right-looking figure for the wrong period. */}
      {!rangeValid && ranged ? (
        <p className="device-gate-error" role="alert">
          <Icon name="alert" size={20} />
          The first date is after the second, so there is no period to report on.
        </p>
      ) : (
        <>
          {showing('sales') ? <SalesPanel from={activeFrom} to={activeTo} apiOptions={options} /> : null}
          {showing('cash') ? <CashPanel from={activeFrom} to={activeTo} apiOptions={options} /> : null}
          {showing('stock') ? <StockPanel apiOptions={options} /> : null}
          {!showing('margin') ? null : canSeeMargin ? (
            <InventoryDaysPanel from={activeFrom} to={activeTo} apiOptions={options} />
          ) : (
            <NotYours title="Stock cover and margin" what="Cost and margin" />
          )}
          {!showing('haulage') ? null : canSeeMargin ? (
            <DistributionPanel from={activeFrom} to={activeTo} apiOptions={options} />
          ) : (
            <NotYours title="Distribution cost" what="What it costs to move goods" />
          )}
          {/* The ratio above is the outcome; this is the lever ADR-0001 traded
              the fleet for. Same capability, because it is the same money. */}
          {!showing('haulage') ? null : canSeeMargin ? (
            <CarrierPanel from={activeFrom} to={activeTo} apiOptions={options} />
          ) : (
            <NotYours
              title="What each haulier has been agreed"
              what="What each haulier is paid"
            />
          )}
        </>
      )}
    </div>
  );
}
