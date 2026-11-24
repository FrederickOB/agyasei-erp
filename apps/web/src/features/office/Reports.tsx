/**
 * Reports — the office's reporting page.
 *
 * What makes this a report rather than a table dump:
 *   · A PERIOD a person chooses (7 / 28 / 90 / 365 days, or any two dates)
 *     and, always, the SAME period immediately before it, so every headline
 *     carries "against the previous period" and never stands alone.
 *   · One question per card, answered by the right form: change over time
 *     (columns per day, per week, per weekday), ranking (bars), composition
 *     (split bars), and honest absence (Unavailable, never zero).
 *   · A CSV behind every table, formatted with the canonical money string —
 *     ungrouped, parseable — because the accountant opens it in a spreadsheet.
 *
 * Every figure keeps the platform's rules: `bigint` money, explicit rounding
 * (`divRound`, `shareBp`), scope on screen, capability-gated reads, and the
 * server's own caveats rendered rather than paraphrased.
 */
import { Children, useMemo, useState, type ReactNode } from 'react';
import { divRound, format as formatMoney } from '@erp/money';
import type { ApiCallOptions, ApiResult } from '../../data/api/client';
import { fetchHaulageSpend } from '../../data/api/logistics';
import {
  fetchCashPosition,
  fetchDistributionCost,
  fetchInventoryDays,
  fetchSalesByDay,
  fetchSalesByLocation,
  fetchStockOnHand,
  type ReportScope,
} from '../../data/api/reports';
import { CAPABILITY, holdsCapability, type PermissionsState } from '../../data/api/session';
import { useApiQuery, type ApiQueryState } from '../../data/api/use-api-query';
import type { LocalDb } from '../../data/db';
import { readDeviceLocation } from '../../data/queries/session';
import { useLiveQuery } from '../../data/use-live-query';
import { businessDateFor } from '../../lib/business-date';
import { formatQtyScaled } from '../../lib/quantity';
import { formatDaysE4, formatPercentE4 } from '../../lib/ratio';
import { useCurrencySpec } from '../../money/CurrencyContext';
import { Money } from '../../money/Money';
import { Bars } from '../../ui/charts/Bars';
import { Columns } from '../../ui/charts/Columns';
import { DailyBars } from '../../ui/charts/DailyBars';
import { maxOf, shareBp } from '../../ui/charts/scale';
import { SplitBars } from '../../ui/charts/SplitBars';
import { Icon } from '../../ui/Icon';
import { withheldSentence } from '../reports/withheld';
import { FetchedAt, ServerPending, ServerUnavailable } from '../shell/ServerAnswer';
import {
  averageBasket,
  byWeek,
  byWeekday,
  changeBp,
  downloadCsv,
  formatChangeBp,
  inclusiveDays,
  previousRange,
  shiftYmd,
  shortDay,
  toCsv,
  topN,
  type CsvCell,
} from './aggregate';

export interface OfficeReportsProps {
  readonly db: LocalDb;
  readonly permissions: PermissionsState;
  readonly apiOptions?: ApiCallOptions | undefined;
}

type Preset = '7' | '28' | '90' | '365' | 'custom';
const PRESETS: readonly { readonly id: Preset; readonly label: string }[] = [
  { id: '7', label: '7 days' },
  { id: '28', label: '28 days' },
  { id: '90', label: '90 days' },
  { id: '365', label: '365 days' },
  { id: 'custom', label: 'Custom' },
];

/**
 * A report this session may not see is never requested: the query is
 * replaced with a refusal, so the tile is simply not offered and no
 * FORBIDDEN round-trip is made.
 */
function gated<T>(enabled: boolean, run: () => Promise<ApiResult<T>>): () => Promise<ApiResult<T>> {
  return enabled
    ? run
    : () =>
        Promise.resolve({
          ok: false,
          failure: { kind: 'forbidden', message: 'Not part of what you can see.', detail: null, status: null },
        });
}

function M({ amount, symbol = true }: { readonly amount: bigint; readonly symbol?: boolean }): ReactNode {
  return <Money grouped amount={amount} withSymbol={symbol} />;
}

function Card({
  title,
  what,
  state,
  onRetry,
  pill,
  action,
  children,
}: {
  readonly title: string;
  readonly what: string;
  readonly state: ApiQueryState<unknown>;
  readonly onRetry: () => void;
  readonly pill?: ReactNode;
  readonly action?: { readonly label: string; readonly onClick: () => void } | undefined;
  readonly children: ReactNode;
}): ReactNode {
  const id = `report-${title.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <section className="tile" aria-labelledby={id}>
      <header className="tile-head">
        <h2 id={id}>{title}</h2>
        {state.status === 'ready' ? pill : null}
        {action === undefined || state.status !== 'ready' ? null : (
          <button type="button" className="tile-link" onClick={action.onClick}>
            {action.label}
          </button>
        )}
      </header>
      {state.status === 'loading' ? <ServerPending shape="chart" what={what} slow={state.slow} rows={3} /> : null}
      {state.status === 'failed' ? <ServerUnavailable what={what} failure={state.failure} onRetry={onRetry} /> : null}
      {state.status === 'ready' ? children : null}
      {state.status === 'ready' ? (
        <footer className="tile-foot">
          <FetchedAt atMs={state.fetchedAtMs} />
        </footer>
      ) : null}
    </section>
  );
}

function Row({ cols, children }: { readonly cols?: '2-1' | '1-2'; readonly children: ReactNode }): ReactNode {
  const items = Children.toArray(children);
  if (items.length === 0) return null;
  const asym = cols !== undefined && items.length === 2 ? cols : undefined;
  return (
    <div className="dashboard-row" data-count={String(items.length)} {...(asym === undefined ? {} : { 'data-cols': asym })}>
      {items}
    </div>
  );
}

function Scope({ scope }: { readonly scope: ReportScope }): ReactNode {
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

function ChangePill({ bp, title }: { readonly bp: number | null; readonly title?: string }): ReactNode {
  if (bp === null) return <span className="tile-pill">no comparison</span>;
  return (
    <span className={`tile-pill tabular ${bp > 0 ? 'tile-pill-ok' : bp < 0 ? 'tile-pill-bad' : ''}`} title={title}>
      {formatChangeBp(bp)}
    </span>
  );
}

/** A small headline stat with its change against the previous period. */
function Stat({
  label,
  value,
  current,
  previous,
  caption,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly current: bigint;
  readonly previous: bigint | null;
  readonly caption?: ReactNode;
}): ReactNode {
  return (
    <div className="report-stat">
      <span className="tile-k">{label}</span>
      <span className="report-stat-value tabular">{value}</span>
      <span className="report-stat-change">
        {previous === null ? <span className="tile-pill">no comparison</span> : <ChangePill bp={changeBp(current, previous)} title="against the previous period" />}
        {caption}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Body({
  from,
  to,
  apiOptions,
  permissions,
}: {
  readonly from: string;
  readonly to: string;
  readonly apiOptions: ApiCallOptions;
  readonly permissions: PermissionsState;
}): ReactNode {
  const spec = useCurrencySpec();
  const sees = (code: string): boolean => holdsCapability(permissions, code);
  const canReport = sees(CAPABILITY.reportLocation);
  const canMargin = sees(CAPABILITY.reportMargin);
  const canHaulage = sees(CAPABILITY.deliveryView);
  const prev = useMemo(() => previousRange(from, to), [from, to]);
  const deps = [from, to, apiOptions, canReport, canMargin, canHaulage];

  const byDay = useApiQuery(gated(canReport, () => fetchSalesByDay({ from, to }, apiOptions)), deps);
  const byDayPrev = useApiQuery(gated(canReport, () => fetchSalesByDay(prev, apiOptions)), deps);
  const byLoc = useApiQuery(gated(canReport, () => fetchSalesByLocation({ from, to }, apiOptions)), deps);
  const byLocPrev = useApiQuery(gated(canReport, () => fetchSalesByLocation(prev, apiOptions)), deps);
  const cash = useApiQuery(gated(canReport, () => fetchCashPosition({ from, to }, apiOptions)), deps);
  const stock = useApiQuery(gated(canReport, () => fetchStockOnHand({ onlyNonZero: true }, apiOptions)), deps);
  const days = useApiQuery(gated(canMargin, () => fetchInventoryDays({ from, to }, apiOptions)), deps);
  const dist = useApiQuery(gated(canMargin, () => fetchDistributionCost({ from, to }, apiOptions)), deps);
  const haul = useApiQuery(gated(canHaulage, () => fetchHaulageSpend({ from, to }, apiOptions)), deps);

  if (!canReport && !canMargin) {
    return (
      <p className="tile-sub" role="status">
        Reporting is not part of what this session can see.
      </p>
    );
  }

  const cur = byDay.state.status === 'ready' ? byDay.state.data : null;
  const before = byDayPrev.state.status === 'ready' ? byDayPrev.state.data : null;
  const series = cur?.series ?? [];
  const weeks = byWeek(series);
  const fullWeeks = weeks.filter((w) => w.complete);
  const lastFull = fullWeeks.length >= 1 ? fullWeeks[fullWeeks.length - 1] : undefined;
  const prevFull = fullWeeks.length >= 2 ? fullWeeks[fullWeeks.length - 2] : undefined;
  const weekdays = byWeekday(series);
  const prevPerDay = before === null ? undefined : divRound(before.total.netRevenueMinor, BigInt(Math.max(1, before.days)), 'half-up');
  const prevByLocation = new Map(byLocPrev.state.status === 'ready' ? byLocPrev.state.data.locations.map((l) => [l.locationId, l]) : []);
  const days_ = inclusiveDays(from, to);

  return (
    <>
      {cur !== null ? (
        <section className="tile" aria-label="Summary">
          <div className="report-stats">
            <Stat
              label="Net revenue"
              value={<M amount={cur.total.netRevenueMinor} />}
              current={cur.total.netRevenueMinor}
              previous={before?.total.netRevenueMinor ?? null}
              caption={<><M amount={divRound(cur.total.netRevenueMinor, BigInt(Math.max(1, days_)), 'half-up')} /> a day</>}
            />
            <Stat label="Billed, incl. tax" value={<M amount={cur.total.totalMinor} />} current={cur.total.totalMinor} previous={before?.total.totalMinor ?? null} />
            <Stat label="Tax" value={<M amount={cur.total.taxTotalMinor} />} current={cur.total.taxTotalMinor} previous={before?.total.taxTotalMinor ?? null} />
            <Stat label="Sales" value={String(cur.total.saleCount)} current={cur.total.saleCount} previous={before?.total.saleCount ?? null} />
            <Stat
              label="Average basket"
              value={averageBasket(cur.total.netRevenueMinor, cur.total.saleCount) === null ? '—' : <M amount={averageBasket(cur.total.netRevenueMinor, cur.total.saleCount)!} />}
              current={averageBasket(cur.total.netRevenueMinor, cur.total.saleCount) ?? 0n}
              previous={before === null ? null : averageBasket(before.total.netRevenueMinor, before.total.saleCount)}
            />
            <Stat
              label="Discounts"
              value={<M amount={cur.total.discountMinor} />}
              current={cur.total.discountMinor}
              previous={before?.total.discountMinor ?? null}
              caption={<>{(shareBp(cur.total.discountMinor, cur.total.subtotalNetMinor) / 100).toFixed(1)}% of subtotal</>}
            />
          </div>
          <p className="tile-sub">
            {shortDay(from)} – {shortDay(to)} ({String(days_)} days), each change against {shortDay(prev.from)} – {shortDay(prev.to)}. <Scope scope={cur.scope} />
          </p>
        </section>
      ) : null}

      <Row>
        {canReport ? (
          <Card title="Revenue by day" what="Sales by day" state={byDay.state} onRetry={byDay.refresh}>
            {cur !== null ? (
              <div className="hero">
                <div className="hero-side">
                  <ul className="hero-legend">
                    <li><i />Net revenue per day</li>
                    <li><i className="hero-legend-avg" />7-day average</li>
                    <li><i className="hero-legend-ref" />Previous period · {prevPerDay === undefined ? '—' : <M amount={prevPerDay} symbol={false} />} a day</li>
                    <li><i className="hero-legend-zero" />Closed day</li>
                  </ul>
                  <div className="hero-insight">
                    Best day <b><M amount={maxOf(series.map((d) => d.netRevenueMinor))} /></b>. {series.filter((d) => d.netRevenueMinor === 0n).length} closed days in the range.
                  </div>
                </div>
                <div>
                  <DailyBars
                    label={`Net revenue per day, ${from} to ${to}`}
                    points={series.map((d) => d.netRevenueMinor)}
                    labels={series.map((d) => shortDay(d.date))}
                    tickEvery={Math.max(1, Math.ceil(series.length / 8))}
                    {...(prevPerDay === undefined ? {} : { reference: prevPerDay })}
                    endLabel={series.length > 0 ? <M amount={series[series.length - 1]!.netRevenueMinor} symbol={false} /> : undefined}
                    format={(v) => <M amount={v} />}
                    width={1100}
                    height={230}
                  />
                </div>
              </div>
            ) : null}
          </Card>
        ) : null}
      </Row>

      <Row>
        {canReport ? (
          <Card
            title="Week on week"
            what="Revenue by week"
            state={byDay.state}
            onRetry={byDay.refresh}
            pill={lastFull !== undefined && prevFull !== undefined ? <ChangePill bp={changeBp(lastFull.netRevenueMinor, prevFull.netRevenueMinor)} /> : null}
          >
            {cur !== null ? (
              <>
                <p className="tile-sowhat">
                  {lastFull !== undefined && prevFull !== undefined ? (
                    <>
                      Last full week <b><M amount={lastFull.netRevenueMinor} /></b> against <b><M amount={prevFull.netRevenueMinor} /></b> before it. * marks a partial week.
                    </>
                  ) : (
                    'Fewer than two full weeks in range.'
                  )}
                </p>
                <Columns
                  label="Net revenue by week"
                  items={weeks.map((w) => ({ key: w.weekOf, label: `${shortDay(w.weekOf)}${w.complete ? '' : '*'}`, value: w.netRevenueMinor, emphasis: lastFull !== undefined && w.weekOf === lastFull.weekOf }))}
                  format={(v) => <M amount={v} symbol={false} />}
                  width={Math.max(360, weeks.length * 44)}
                />
              </>
            ) : null}
          </Card>
        ) : null}
        {canReport ? (
          <Card title="By weekday" what="Revenue by weekday" state={byDay.state} onRetry={byDay.refresh}>
            {cur !== null ? (
              (() => {
                const best = weekdays.reduce((b, w) => (w.averageMinor > b.averageMinor ? w : b), weekdays[0]!);
                return (
                  <>
                    <p className="tile-sowhat">
                      <b>{best.label}</b> averages <b><M amount={best.averageMinor} /></b>; averages count closed days.
                    </p>
                    <Columns
                      label="Average net revenue by weekday"
                      items={weekdays.map((w) => ({ key: w.label, label: w.label, value: w.averageMinor, emphasis: w.label === best.label }))}
                      format={(v) => <M amount={v} symbol={false} />}
                    />
                  </>
                );
              })()
            ) : null}
          </Card>
        ) : null}
        {canReport ? (
          <Card title="Sales per day" what="Sale count by day" state={byDay.state} onRetry={byDay.refresh}>
            {cur !== null ? (
              <>
                <p className="tile-sowhat">
                  <b>{String(cur.total.saleCount)}</b> sales, <b className="tabular">{String(divRound(cur.total.saleCount, BigInt(Math.max(1, cur.days)), 'half-up'))}</b> a day.
                </p>
                <DailyBars
                  label="Sales per day"
                  points={series.map((d) => d.saleCount)}
                  labels={series.map((d) => shortDay(d.date))}
                  tickEvery={Math.max(1, Math.ceil(series.length / 6))}
                  averageWindow={7}
                  endLabel={series.length > 0 ? String(series[series.length - 1]!.saleCount) : undefined}
                  format={(v) => `${v.toString()} ${v === 1n ? 'sale' : 'sales'}`}
                  width={360}
                  height={150}
                />
              </>
            ) : null}
          </Card>
        ) : null}
      </Row>

      <Row cols="2-1">
        {canReport ? (
          <Card
            title="Sales by location"
            what="Sales by location"
            state={byLoc.state}
            onRetry={byLoc.refresh}
            action={
              byLoc.state.status === 'ready'
                ? {
                    label: 'Download CSV',
                    onClick: () => {
                      if (byLoc.state.status !== 'ready') return;
                      const rows: CsvCell[][] = byLoc.state.data.locations.map((l) => [
                        l.locationCode,
                        l.locationName,
                        l.saleCount,
                        formatMoney(l.subtotalNetMinor, spec),
                        formatMoney(l.discountMinor, spec),
                        formatMoney(l.netRevenueMinor, spec),
                        formatMoney(l.taxTotalMinor, spec),
                        formatMoney(l.totalMinor, spec),
                        prevByLocation.get(l.locationId) === undefined ? null : formatMoney(prevByLocation.get(l.locationId)!.netRevenueMinor, spec),
                      ]);
                      downloadCsv(
                        `sales-by-location_${from}_${to}.csv`,
                        toCsv(['code', 'location', 'sales', 'subtotal', 'discount', 'net', 'tax', 'billed', `net_previous_${prev.from}_${prev.to}`], rows),
                      );
                    },
                  }
                : undefined
            }
          >
            {byLoc.state.status === 'ready' ? (
              (() => {
                const data = byLoc.state.data;
                const ranked = [...data.locations].sort((a, b) => (a.netRevenueMinor === b.netRevenueMinor ? 0 : a.netRevenueMinor > b.netRevenueMinor ? -1 : 1));
                return (
                  <>
                    <div className="office-table-scroll">
                      <table className="office-table">
                        <caption className="visually-hidden">Sales by location, {from} to {to}</caption>
                        <thead>
                          <tr>
                            <th scope="col">Location</th>
                            <th scope="col" className="numeric">Sales</th>
                            <th scope="col" className="numeric">Net</th>
                            <th scope="col" className="numeric">Share</th>
                            <th scope="col" className="numeric">vs previous</th>
                            <th scope="col" className="numeric">Avg basket</th>
                            <th scope="col" className="numeric">Tax</th>
                            <th scope="col" className="numeric">Billed</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ranked.map((l) => {
                            const p = prevByLocation.get(l.locationId);
                            const basket = averageBasket(l.netRevenueMinor, l.saleCount);
                            return (
                              <tr key={l.locationId}>
                                <td>
                                  <b>{l.locationName}</b> <small className="tile-sub">{l.locationCode}</small>
                                </td>
                                <td className="numeric tabular">{String(l.saleCount)}</td>
                                <td className="numeric"><M amount={l.netRevenueMinor} symbol={false} /></td>
                                <td className="numeric tabular">{(shareBp(l.netRevenueMinor, data.total.netRevenueMinor) / 100).toFixed(1)}%</td>
                                <td className="numeric">{p === undefined ? <span className="tile-pill">—</span> : <ChangePill bp={changeBp(l.netRevenueMinor, p.netRevenueMinor)} />}</td>
                                <td className="numeric">{basket === null ? '—' : <M amount={basket} symbol={false} />}</td>
                                <td className="numeric"><M amount={l.taxTotalMinor} symbol={false} /></td>
                                <td className="numeric"><M amount={l.totalMinor} symbol={false} /></td>
                              </tr>
                            );
                          })}
                        </tbody>
                        <tfoot>
                          <tr>
                            <td>{data.scope.network ? 'Whole organisation' : 'Your locations only'}</td>
                            <td className="numeric tabular">{String(data.total.saleCount)}</td>
                            <td className="numeric"><M amount={data.total.netRevenueMinor} symbol={false} /></td>
                            <td className="numeric tabular">100%</td>
                            <td className="numeric">{before === null ? '—' : <ChangePill bp={changeBp(data.total.netRevenueMinor, before.total.netRevenueMinor)} />}</td>
                            <td className="numeric">{averageBasket(data.total.netRevenueMinor, data.total.saleCount) === null ? '—' : <M amount={averageBasket(data.total.netRevenueMinor, data.total.saleCount)!} symbol={false} />}</td>
                            <td className="numeric"><M amount={data.total.taxTotalMinor} symbol={false} /></td>
                            <td className="numeric"><M amount={data.total.totalMinor} symbol={false} /></td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                    <Scope scope={data.scope} />
                  </>
                );
              })()
            ) : null}
          </Card>
        ) : null}
        {canReport ? (
          <Card title="Ranked" what="Sales by location" state={byLoc.state} onRetry={byLoc.refresh}>
            {byLoc.state.status === 'ready' ? (
              (() => {
                const { top, otherMinor, otherCount } = topN(byLoc.state.data.locations, 8, (l) => l.netRevenueMinor);
                const lead = top[0];
                return (
                  <>
                    <p className="tile-sowhat">
                      {lead === undefined ? 'No locations in scope.' : (
                        <>
                          <b>{lead.locationName}</b> takes <b>{(shareBp(lead.netRevenueMinor, byLoc.state.data.total.netRevenueMinor) / 100).toFixed(0)}%</b> of net revenue.
                        </>
                      )}
                    </p>
                    <Bars
                      label="Net revenue by location, ranked"
                      rows={[
                        ...top.map((l) => ({ key: l.locationId, label: l.locationName, value: l.netRevenueMinor })),
                        ...(otherCount > 0 ? [{ key: '__other', label: `${String(otherCount)} others`, value: otherMinor }] : []),
                      ]}
                      format={(v) => <M amount={v} symbol={false} />}
                    />
                  </>
                );
              })()
            ) : null}
          </Card>
        ) : null}
      </Row>

      <Row>
        {canReport ? (
          <Card
            title="Cash and credit"
            what="Cash position by location"
            state={cash.state}
            onRetry={cash.refresh}
            pill={cash.state.status === 'ready' ? <span className="tile-pill tabular">{(shareBp(cash.state.data.total.creditTenderMinor, cash.state.data.total.billedTotalMinor) / 100).toFixed(0)}% on credit</span> : null}
            action={
              cash.state.status === 'ready'
                ? {
                    label: 'Download CSV',
                    onClick: () => {
                      if (cash.state.status !== 'ready') return;
                      downloadCsv(
                        `cash-position_${from}_${to}.csv`,
                        toCsv(
                          ['code', 'location', 'immediate_sales', 'immediate', 'credit_sales', 'credit', 'billed'],
                          cash.state.data.locations.map((l) => [l.locationCode, l.locationName, l.immediateSaleCount, formatMoney(l.immediateTenderMinor, spec), l.creditSaleCount, formatMoney(l.creditTenderMinor, spec), formatMoney(l.billedTotalMinor, spec)]),
                        ),
                      );
                    },
                  }
                : undefined
            }
          >
            {cash.state.status === 'ready' ? (
              (() => {
                const data = cash.state.data;
                const { top, otherMinor, otherCount } = topN(data.locations, 10, (l) => l.billedTotalMinor);
                return (
                  <>
                    <p className="tile-sowhat">
                      <b><M amount={data.total.immediateTenderMinor} /></b> paid at the counter, <b><M amount={data.total.creditTenderMinor} /></b> on credit, of <b><M amount={data.total.billedTotalMinor} /></b> billed. Credit receipts in the period: <b><M amount={data.unattributed.creditReceiptsMinor} /></b> — {data.unattributed.reason}
                    </p>
                    <SplitBars
                      label="Cash and credit by location"
                      aName="Cash and mobile money"
                      bName="On credit"
                      rows={top.map((l) => ({ key: l.locationId, label: <>{l.locationName}<small>{l.locationCode}</small></>, a: l.immediateTenderMinor, b: l.creditTenderMinor }))}
                      format={(v) => <M amount={v} symbol={false} />}
                      note={otherCount > 0 ? <>{String(otherCount)} more locations billed <M amount={otherMinor} /> between them.</> : undefined}
                    />
                    {data.caveats.length > 0 ? (
                      <details className="tile-details">
                        <summary className="tile-sub">What this figure is not</summary>
                        <ul className="tile-caveats">{data.caveats.map((c) => <li key={c}>{c}</li>)}</ul>
                      </details>
                    ) : null}
                  </>
                );
              })()
            ) : null}
          </Card>
        ) : null}
      </Row>

      <Row>
        {canMargin ? (
          <Card
            title="Gross margin by location"
            what="Gross margin"
            state={days.state}
            onRetry={days.refresh}
            pill={days.state.status === 'ready' && days.state.data.total.grossMarginPctE4 !== null ? <span className="tile-pill tile-pill-info tabular">network {formatPercentE4(days.state.data.total.grossMarginPctE4)}%</span> : null}
          >
            {days.state.status === 'ready' ? (
              <>
                <Bars
                  label="Gross margin by location"
                  rows={days.state.data.locations.map((l) => ({
                    key: l.locationId,
                    label: <>{l.locationName}<small>{l.productsMissingCostBasis > 0 ? `${String(l.productsMissingCostBasis)} lines uncosted` : 'fully costed'}</small></>,
                    value: l.grossMarginPctE4,
                  }))}
                  format={(v) => `${formatPercentE4(v)}%`}
                  {...(days.state.data.total.grossMarginPctE4 === null ? {} : { mark: days.state.data.total.grossMarginPctE4 })}
                />
                <p className="tile-note">{days.state.data.method}</p>
              </>
            ) : null}
          </Card>
        ) : null}
        {canMargin ? (
          <Card
            title="Inventory days by location"
            what="Inventory days"
            state={days.state}
            onRetry={days.refresh}
            pill={days.state.status === 'ready' && days.state.data.total.inventoryDaysE4 !== null ? <span className="tile-pill tile-pill-info tabular">network {formatDaysE4(days.state.data.total.inventoryDaysE4)} d</span> : null}
          >
            {days.state.status === 'ready' ? (
              <>
                {days.state.data.total.inventoryDaysE4 === null ? (
                  <div className="tile-unavailable" role="status">
                    <b>Network figure unavailable</b>
                    <span>{withheldSentence(days.state.data.total.unavailable)}</span>
                  </div>
                ) : null}
                <Bars
                  label="Inventory days by location"
                  rows={days.state.data.locations.map((l) => ({ key: l.locationId, label: l.locationName, value: l.inventoryDaysE4 }))}
                  format={(v) => `${formatDaysE4(v)} d`}
                />
              </>
            ) : null}
          </Card>
        ) : null}
        {canMargin ? (
          <Card
            title="Distribution cost"
            what="Distribution cost as a share of revenue"
            state={dist.state}
            onRetry={dist.refresh}
            pill={dist.state.status === 'ready' && dist.state.data.total.distributionCostPctE4 !== null ? <span className="tile-pill tile-pill-info tabular">network {formatPercentE4(dist.state.data.total.distributionCostPctE4)}%</span> : null}
          >
            {dist.state.status === 'ready' ? (
              <>
                <p className="tile-sowhat">
                  {dist.state.data.total.distributionCostMinor === null ? 'No agreed freight in the period.' : (
                    <>
                      <b><M amount={dist.state.data.total.distributionCostMinor} /></b> agreed freight over <b>{String(dist.state.data.total.deliveryCount)}</b> deliveries
                      {dist.state.data.total.deliveriesWithNoAgreedFreight > 0 ? <> — a floor, {String(dist.state.data.total.deliveriesWithNoAgreedFreight)} have no agreed freight</> : null}.
                    </>
                  )}
                </p>
                <Bars
                  label="Distribution cost by location"
                  rows={dist.state.data.locations.map((l) => ({ key: l.locationId, label: l.locationName, value: l.distributionCostPctE4 }))}
                  format={(v) => `${formatPercentE4(v)}%`}
                />
                {dist.state.data.groups.length > 0 ? (
                  <>
                    <p className="tile-sub">By group{dist.state.data.groupsNest ? ' — groups nest, so these do not add up' : ''}:</p>
                    <Bars
                      label="Distribution cost by group"
                      ranked={false}
                      rows={dist.state.data.groups.map((g) => ({ key: g.groupId, label: <>{g.groupName}<small>{String(g.locationCount)} locations</small></>, value: g.distributionCostPctE4 }))}
                      format={(v) => `${formatPercentE4(v)}%`}
                    />
                  </>
                ) : null}
                <p className="tile-note">{dist.state.data.costBasis}</p>
              </>
            ) : null}
          </Card>
        ) : null}
      </Row>

      <Row>
        {canReport ? (
          <Card
            title="Stock on hand"
            what="Stock on hand"
            state={stock.state}
            onRetry={stock.refresh}
            action={
              stock.state.status === 'ready'
                ? {
                    label: 'Download CSV',
                    onClick: () => {
                      if (stock.state.status !== 'ready') return;
                      const rows: CsvCell[][] = [];
                      for (const loc of stock.state.data.locations) {
                        for (const line of loc.lines) rows.push([loc.locationCode, loc.locationName, line.skuCode, line.productName, formatQtyScaled(line.qtyOnHand, line.qtyScale), line.uomCode]);
                      }
                      downloadCsv(`stock-on-hand_${to}.csv`, toCsv(['code', 'location', 'sku', 'product', 'qty', 'unit'], rows));
                    },
                  }
                : undefined
            }
          >
            {stock.state.status === 'ready' ? (
              (() => {
                const byQty = [...stock.state.data.networkByProduct].sort((a, b) => (a.qtyOnHand === b.qtyOnHand ? 0 : a.qtyOnHand > b.qtyOnHand ? -1 : 1));
                const units = new Set(byQty.map((l) => l.uomCode));
                return (
                  <>
                    <p className="tile-sowhat">
                      <b>{String(stock.state.data.networkByProduct.length)}</b> products with stock across <b>{String(stock.state.data.locations.length)}</b> locations. Quantities are in each product's stocking unit
                      {units.size > 1 ? ' — units differ, so lengths only rank within a unit' : ''}.
                    </p>
                    <Bars
                      label="Stock on hand, largest quantities"
                      rows={byQty.slice(0, 12).map((l) => ({ key: l.productId, label: <>{l.productName}<small>{l.skuCode}</small></>, value: l.qtyOnHand }))}
                      format={(v) => {
                        const line = byQty.find((l) => l.qtyOnHand === v);
                        return line === undefined ? String(v) : `${formatQtyScaled(v, line.qtyScale)} ${line.uomCode}`;
                      }}
                      note={byQty.length > 12 ? `${String(byQty.length - 12)} more products in the CSV.` : undefined}
                    />
                    <Scope scope={stock.state.data.scope} />
                  </>
                );
              })()
            ) : null}
          </Card>
        ) : null}
        {canHaulage ? (
          <Card
            title="Haulage by carrier"
            what="Haulage spend"
            state={haul.state}
            onRetry={haul.refresh}
            pill={haul.state.status === 'ready' ? <span className="tile-pill tabular">{String(haul.state.data.total.deliveryCount)} loads</span> : null}
          >
            {haul.state.status === 'ready' ? (
              <>
                <p className="tile-sowhat">
                  <b><M amount={haul.state.data.total.haulageSpendMinor} /></b> agreed with {String(haul.state.data.carriers.length)} carriers. {haul.state.data.basis}
                </p>
                <Bars
                  label="Haulage spend by carrier"
                  rows={haul.state.data.carriers.map((c) => ({
                    key: c.carrierSupplierId,
                    label: <>{c.carrierName}<small>{String(c.deliveryCount)} loads{c.deliveriesWithNoAgreedFreight > 0 ? ` · ${String(c.deliveriesWithNoAgreedFreight)} without agreed freight` : ''}</small></>,
                    value: c.haulageSpendMinor,
                  }))}
                  format={(v) => <M amount={v} symbol={false} />}
                />
                <p className="tile-note">{haul.state.data.method}</p>
              </>
            ) : null}
          </Card>
        ) : null}
      </Row>
    </>
  );
}

// ---------------------------------------------------------------------------

export function OfficeReports({ db, permissions, apiOptions }: OfficeReportsProps): ReactNode {
  const location = useLiveQuery(db, readDeviceLocation, []);
  const options = useMemo<ApiCallOptions>(() => apiOptions ?? {}, [apiOptions]);
  const timeZone = location === undefined ? null : (location?.timeZone ?? null);
  const today = useMemo(() => businessDateFor(new Date().toISOString(), timeZone), [timeZone]);
  const [preset, setPreset] = useState<Preset>('28');
  const [customFrom, setCustomFrom] = useState<string>(shiftYmd(today, -27));
  const [customTo, setCustomTo] = useState<string>(today);

  const range = useMemo(() => {
    if (preset === 'custom') return { from: customFrom, to: customTo };
    return { from: shiftYmd(today, -(Number(preset) - 1)), to: today };
  }, [preset, customFrom, customTo, today]);
  const valid = range.from <= range.to && inclusiveDays(range.from, range.to) <= 400;

  if (location === undefined) {
    return (
      <div className="dashboard">
        <ServerPending shape="chart" what="Reporting" rows={3} />
      </div>
    );
  }

  return (
    <div className="dashboard reports">
      <header className="reports-head">
        <h1 className="reports-title">Reports</h1>
        <div className="reports-period" role="group" aria-label="Period">
          {PRESETS.map((p) => (
            <button key={p.id} type="button" className="office-tab pressable" aria-pressed={preset === p.id} onClick={() => setPreset(p.id)}>
              {p.label}
            </button>
          ))}
          {preset === 'custom' ? (
            <span className="reports-custom">
              <label>
                From <input type="date" value={customFrom} max={customTo} onChange={(e) => setCustomFrom(e.target.value)} />
              </label>
              <label>
                To <input type="date" value={customTo} min={customFrom} max={today} onChange={(e) => setCustomTo(e.target.value)} />
              </label>
            </span>
          ) : null}
        </div>
      </header>
      {valid ? (
        <Body from={range.from} to={range.to} apiOptions={options} permissions={permissions} />
      ) : (
        <p className="tile-sub" role="status">
          Choose a range that ends after it starts and covers at most 400 days.
        </p>
      )}
    </div>
  );
}
