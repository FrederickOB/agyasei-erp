/**
 * The dashboard — the office's home page.
 *
 * LAYOUT IS ROWS, NOT A 12-COLUMN AUTO-FLOW. Every row divides its width
 * among the tiles it actually has (`.dashboard-row`), so a session that
 * cannot see a tile leaves no hole and nothing hugs the left. The first
 * block is a 3:1 split — stats and the analytics hero on the left, the
 * decision queue on the right — and collapses to one column when the queue
 * is not offered.
 *
 *   TOP     Net revenue · Taken · Margin  |  Decisions
 *           Revenue analytics (by day)     |
 *   ROW     Week on week · By weekday · Average basket
 *   ROW     Locations (table) · Low stock
 *   ROW     Cash vs credit by location · Gross margin by location
 *   ROW     Distribution · Stock cover · Posting
 *
 * ONE QUERY PER REPORT, SHARED. Sales by day feeds four tiles; sales by
 * location feeds two; inventory days feeds three. Each is fetched once here
 * and every tile renders from the same answer, showing the same skeleton
 * and the same refusal. A report a session cannot see is never requested.
 *
 * Rules every tile keeps:
 *   · Tiles are gated by CAPABILITY, never by role name (CLAUDE.md §2.9).
 *   · `null` is UNAVAILABLE, never zero — the word, with the server's reason.
 *   · The SCOPE is on screen on every money tile.
 *   · No target from the tenant's financial model is typed in here.
 *   · Money is `bigint` and reaches the screen only through `<Money>`.
 */
import { Children, useMemo, type ReactNode } from 'react';
import { divRound } from '@erp/money';
import type { ApiCallOptions, ApiResult } from '../../data/api/client';
import { fetchLowStock } from '../../data/api/inventory';
import { fetchPostingExceptions } from '../../data/api/ledger';
import {
  fetchCashPosition,
  fetchDistributionCost,
  fetchInventoryDays,
  fetchSalesByDay,
  fetchSalesByLocation,
  type ReportScope,
} from '../../data/api/reports';
import { fetchReviews } from '../../data/api/review';
import { CAPABILITY, holdsCapability, type PermissionsState } from '../../data/api/session';
import { useApiQuery, type ApiQueryState } from '../../data/api/use-api-query';
import type { LocalDb } from '../../data/db';
import { readDeviceLocation } from '../../data/queries/session';
import { useLiveQuery } from '../../data/use-live-query';
import { businessDateFor } from '../../lib/business-date';
import { formatQtyScaled } from '../../lib/quantity';
import { formatDaysE4, formatPercentE4 } from '../../lib/ratio';
import { Money } from '../../money/Money';
import { Bars } from '../../ui/charts/Bars';
import { Columns } from '../../ui/charts/Columns';
import { DailyBars } from '../../ui/charts/DailyBars';
import { bpToPercent, maxOf, shareBp } from '../../ui/charts/scale';
import { SplitBars } from '../../ui/charts/SplitBars';
import { Icon } from '../../ui/Icon';
import { Unit } from '../../ui/Unit';
import { withheldSentence } from '../reports/withheld';
import { conflictTitle, entityLabel, escalationLabel } from '../review/labels';
import type { DestinationId } from '../shell/destinations';
import { FetchedAt, ServerPending, ServerUnavailable, type PendingShape } from '../shell/ServerAnswer';
import { averageBasket, byWeek, byWeekday, changeBp, formatChangeBp, shiftYmd, shortDay, topN } from './aggregate';

export interface DashboardProps {
  readonly db: LocalDb;
  readonly permissions: PermissionsState;
  readonly apiOptions?: ApiCallOptions | undefined;
  /** Open another office page — the "See all" links. */
  readonly onOpen?: ((id: DestinationId) => void) | undefined;
}

/** The location's last 28 trading days, not the tablet's calendar month. */
function recentRange(timeZone: string | null): { from: string; to: string } {
  const to = businessDateFor(new Date().toISOString(), timeZone);
  return { from: shiftYmd(to, -27), to };
}

/** `credit_limit` → `Credit limit`. A system identifier read aloud. */
function words(identifier: string): string {
  const t = identifier.replace(/[_-]+/g, ' ').trim();
  return t.length === 0 ? t : t[0]!.toUpperCase() + t.slice(1);
}

/** "Northern Depot" → "ND" — a mark for a row, never a meaning. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter((w) => /^[A-Za-z0-9]/.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

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

/** Grouped money, the office's default. */
function M({ amount, symbol = true }: { readonly amount: bigint; readonly symbol?: boolean }): ReactNode {
  return <Money grouped amount={amount} withSymbol={symbol} />;
}

// ---------------------------------------------------------------------------
// The tile and the row
// ---------------------------------------------------------------------------

function Tile({
  title,
  what,
  state,
  onRetry,
  tinted = false,
  pill,
  link,
  pending = 'figures',
  children,
}: {
  /** What the skeleton looks like while the answer is on its way. */
  readonly pending?: PendingShape;
  readonly title: string;
  readonly what: string;
  readonly state: ApiQueryState<unknown>;
  readonly onRetry: () => void;
  readonly tinted?: boolean;
  readonly pill?: ReactNode;
  readonly link?: { readonly label: string; readonly onClick: () => void } | undefined;
  readonly children: ReactNode;
}): ReactNode {
  const id = `tile-${title.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <section className={tinted ? 'tile tile-tinted' : 'tile'} aria-labelledby={id}>
      <header className="tile-head">
        <h2 id={id}>{title}</h2>
        {state.status === 'ready' ? pill : null}
        {link === undefined ? null : (
          <button type="button" className="tile-link" onClick={link.onClick}>
            {link.label}
          </button>
        )}
      </header>
      {state.status === 'loading' ? <ServerPending shape={pending} what={what} slow={state.slow} rows={pending === 'figures' ? 1 : 3} /> : null}
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

/** A row of tiles that always fills its width, whatever is present. */
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
      Your {places} only
    </span>
  );
}

function Unavailable({ reason, children }: { readonly reason: string | null; readonly children?: ReactNode }): ReactNode {
  return (
    <div className="tile-unavailable" role="status">
      <b>Unavailable</b>
      {reason === null ? null : <span>{withheldSentence(reason)}</span>}
      {children}
    </div>
  );
}

function ChangePill({ bp }: { readonly bp: number | null }): ReactNode {
  if (bp === null) return null;
  return <span className={`tile-pill tabular ${bp > 0 ? 'tile-pill-ok' : bp < 0 ? 'tile-pill-bad' : ''}`}>{formatChangeBp(bp)}</span>;
}

function link(onOpen: DashboardProps['onOpen'], id: DestinationId, label: string) {
  return onOpen === undefined ? undefined : { label, onClick: () => onOpen(id) };
}

// ---------------------------------------------------------------------------
// The body — every query once, every tile from the same answer
// ---------------------------------------------------------------------------

function Body({
  from,
  to,
  apiOptions,
  permissions,
  onOpen,
}: {
  readonly from: string;
  readonly to: string;
  readonly apiOptions: ApiCallOptions;
  readonly permissions: PermissionsState;
  readonly onOpen: DashboardProps['onOpen'];
}): ReactNode {
  const sees = (code: string): boolean => holdsCapability(permissions, code);
  const canReport = sees(CAPABILITY.reportLocation);
  const canMargin = sees(CAPABILITY.reportMargin);
  const canStock = sees(CAPABILITY.stockView);
  const canDecide = sees(CAPABILITY.conflictReview);
  const canBooks = sees(CAPABILITY.glView);
  const deps = [from, to, apiOptions, canReport, canMargin, canStock, canDecide, canBooks];

  const byDay = useApiQuery(gated(canReport, () => fetchSalesByDay({ from, to }, apiOptions)), deps);
  const byLoc = useApiQuery(gated(canReport, () => fetchSalesByLocation({ from, to }, apiOptions)), deps);
  const cash = useApiQuery(gated(canReport, () => fetchCashPosition({ from, to }, apiOptions)), deps);
  const days = useApiQuery(gated(canMargin, () => fetchInventoryDays({ from, to }, apiOptions)), deps);
  const dist = useApiQuery(gated(canMargin, () => fetchDistributionCost({ from, to }, apiOptions)), deps);
  const low = useApiQuery(gated(canStock, () => fetchLowStock({ limit: 4 }, apiOptions)), deps);
  const reviews = useApiQuery(gated(canDecide, () => fetchReviews({}, apiOptions)), deps);
  const posting = useApiQuery(gated(canBooks, () => fetchPostingExceptions(apiOptions)), deps);

  if (!(canReport || canMargin || canStock || canDecide || canBooks)) {
    return (
      <p className="tile-sub" role="status">
        Nothing to show here yet — this session holds no reporting capability.
      </p>
    );
  }

  const series = byDay.state.status === 'ready' ? byDay.state.data.series : [];
  const weeks = byWeek(series);
  const weekdays = byWeekday(series);
  const daysInRange = byDay.state.status === 'ready' ? byDay.state.data.days : 1;
  const perDay =
    byDay.state.status === 'ready'
      ? divRound(byDay.state.data.total.netRevenueMinor, BigInt(Math.max(1, daysInRange)), 'half-up')
      : 0n;
  // Week on week compares FULL weeks: a Tuesday against last week is not a trend.
  const fullWeeks = weeks.filter((w) => w.complete);
  const lastFull = fullWeeks.length >= 1 ? fullWeeks[fullWeeks.length - 1] : undefined;
  const prevFull = fullWeeks.length >= 2 ? fullWeeks[fullWeeks.length - 2] : undefined;
  const partialWeek = weeks.length > 0 && !weeks[weeks.length - 1]!.complete ? weeks[weeks.length - 1] : undefined;
  const bestWeekday = weekdays.reduce((best, w) => (w.averageMinor > best.averageMinor ? w : best), weekdays[0]!);

  const decisions = canDecide ? (
    <Tile pending="cards"
      title="Decisions"
      what="Items needing a decision"
      state={reviews.state}
      onRetry={reviews.refresh}
      link={link(onOpen, 'review', 'See all')}
    >
      {reviews.state.status === 'ready' ? (
        <>
          <p className="tile-sub">
            <b className="tabular">{String(reviews.state.data.reviewCount)}</b>{' '}
            {reviews.state.data.reviewCount === 1 ? 'needs' : 'need'} a person
            {reviews.state.data.hiddenCount > 0 ? (
              <>
                {' '}
                · <b className="tabular">{String(reviews.state.data.hiddenCount)}</b> more outside what you may decide
              </>
            ) : null}
          </p>
          {reviews.state.data.reviews.length === 0 ? (
            <p className="tile-sub">Nothing is waiting on you.</p>
          ) : (
            <ul className="office-list">
              {reviews.state.data.reviews.slice(0, 6).map((r) => (
                <li className="office-row" key={r.reviewId}>
                  <span className={`office-dot ${r.severity <= 1 ? 'office-dot-bad' : r.severity === 2 ? 'office-dot-warn' : 'office-dot-info'}`}>
                    <Icon name="alert" size={16} />
                  </span>
                  <span className="office-row-text">
                    <b title={r.conflictClass}>{conflictTitle(r.conflictClass)}</b>
                    <small>
                      {entityLabel(r.entityTable)} · {escalationLabel(r.escalateAt, Date.now())}
                    </small>
                  </span>
                  <span className="tile-pill">{words(r.status)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </Tile>
  ) : null;

  const topLeft = canReport || canMargin;

  return (
    <>
      {topLeft ? (
        <div className="dashboard-top" data-side={canDecide ? '1' : '0'}>
          <div className="dashboard-left">
            <Row>
              {canReport ? (
                <Tile
                  title="Net revenue"
                  what="Net revenue"
                  state={byLoc.state}
                  onRetry={byLoc.refresh}
                  pill={
                    byLoc.state.status === 'ready' ? (
                      <span className="tile-pill tile-pill-info tabular">{String(byLoc.state.data.total.saleCount)} sales</span>
                    ) : null
                  }
                >
                  {byLoc.state.status === 'ready' ? (
                    <>
                      <p className="tile-figure money">
                        <M amount={byLoc.state.data.total.netRevenueMinor} />
                      </p>
                      <p className="tile-sub">
                        <M amount={divRound(byLoc.state.data.total.netRevenueMinor, BigInt(Math.max(1, byLoc.state.data.days)), 'half-up')} /> a
                        day · ex-tax, after <M amount={byLoc.state.data.total.discountMinor} /> discounts
                      </p>
                      <Scope scope={byLoc.state.data.scope} />
                    </>
                  ) : null}
                </Tile>
              ) : null}
              {canReport ? (
                <Tile
                  title="Taken"
                  what="Cash and credit"
                  state={cash.state}
                  onRetry={cash.refresh}
                  pill={
                    cash.state.status === 'ready' ? (
                      <span className="tile-pill tile-pill-info tabular">
                        {(shareBp(cash.state.data.total.immediateTenderMinor, cash.state.data.total.billedTotalMinor) / 100).toFixed(0)}%
                      </span>
                    ) : null
                  }
                >
                  {cash.state.status === 'ready' ? (
                    <>
                      <p className="tile-figure money">
                        <M amount={cash.state.data.total.immediateTenderMinor} />
                      </p>
                      <p className="tile-sub">
                        Paid at the counter · <M amount={cash.state.data.total.creditTenderMinor} /> went on credit
                      </p>
                      {cash.state.data.caveats.length > 0 ? (
                        <details className="tile-details">
                          <summary className="tile-sub">What this figure is not</summary>
                          <ul className="tile-caveats">
                            {cash.state.data.caveats.map((c) => (
                              <li key={c}>{c}</li>
                            ))}
                          </ul>
                        </details>
                      ) : null}
                    </>
                  ) : null}
                </Tile>
              ) : null}
              {canMargin ? (
                <Tile
                  title="Margin and cover"
                  what="Gross margin and inventory days"
                  state={days.state}
                  onRetry={days.refresh}
                  pill={
                    days.state.status === 'ready' && days.state.data.total.inventoryDaysE4 !== null ? (
                      <span className="tile-pill tabular">{formatDaysE4(days.state.data.total.inventoryDaysE4)} days cover</span>
                    ) : null
                  }
                >
                  {days.state.status === 'ready' ? (
                    days.state.data.total.grossMarginPctE4 === null ? (
                      <Unavailable reason={days.state.data.total.unavailable} />
                    ) : (
                      <>
                        <p className="tile-figure tabular">
                          {formatPercentE4(days.state.data.total.grossMarginPctE4)}
                          <span className="tile-figure-unit">% gross margin</span>
                        </p>
                        <p className="tile-note">{days.state.data.method}</p>
                      </>
                    )
                  ) : null}
                </Tile>
              ) : null}
            </Row>
            <Row>
              {canReport ? (
                <Tile pending="chart" title="Sales" what="Sales by day" state={byDay.state} onRetry={byDay.refresh} link={link(onOpen, 'reports', 'Open reports')}>
                  {byDay.state.status === 'ready' ? (
                    <div className="hero">
                      <div className="hero-side">
                        <ul className="hero-legend">
                          <li>
                            <i />
                            Net revenue per day
                          </li>
                          <li>
                            <i className="hero-legend-avg" />
                            7-day average
                          </li>
                          <li>
                            <i className="hero-legend-ref" />
                            Range average · <M amount={perDay} symbol={false} />
                          </li>
                          <li>
                            <i className="hero-legend-zero" />
                            Closed day
                          </li>
                        </ul>
                        <div className="hero-insight">
                          <b>
                            <M amount={byDay.state.data.total.netRevenueMinor} />
                          </b>{' '}
                          net over {String(byDay.state.data.days)} days, {shortDay(from)} – {shortDay(to)}. Best day{' '}
                          <b>
                            <M amount={maxOf(series.map((d) => d.netRevenueMinor))} />
                          </b>
                          .
                        </div>
                        <Scope scope={byDay.state.data.scope} />
                      </div>
                      <div>
                        <DailyBars
                          label={`Net revenue per day, ${from} to ${to}`}
                          points={series.map((d) => d.netRevenueMinor)}
                          labels={series.map((d) => shortDay(d.date))}
                          reference={perDay}
                          endLabel={series.length > 0 ? <M amount={series[series.length - 1]!.netRevenueMinor} symbol={false} /> : undefined}
                          format={(v) => <M amount={v} />}
                        />
                      </div>
                    </div>
                  ) : null}
                </Tile>
              ) : null}
            </Row>
          </div>
          {decisions}
        </div>
      ) : (
        <Row>{decisions}</Row>
      )}

      <Row>
        {canReport ? (
          <Tile pending="chart"
            title="Week on week"
            what="Revenue by week"
            state={byDay.state}
            onRetry={byDay.refresh}
            pill={
              lastFull !== undefined && prevFull !== undefined ? (
                <ChangePill bp={changeBp(lastFull.netRevenueMinor, prevFull.netRevenueMinor)} />
              ) : null
            }
          >
            {byDay.state.status === 'ready' ? (
              <>
                <p className="tile-sowhat">
                  {lastFull !== undefined && prevFull !== undefined ? (
                    <>
                      Week of {shortDay(lastFull.weekOf)}:{' '}
                      <b>
                        <M amount={lastFull.netRevenueMinor} />
                      </b>{' '}
                      against{' '}
                      <b>
                        <M amount={prevFull.netRevenueMinor} />
                      </b>{' '}
                      the week before
                      {partialWeek === undefined ? null : (
                        <>
                          ; this week so far ({String(partialWeek.days)} {partialWeek.days === 1 ? 'day' : 'days'}, *){' '}
                          <b>
                            <M amount={partialWeek.netRevenueMinor} />
                          </b>
                        </>
                      )}
                      .
                    </>
                  ) : (
                    'Fewer than two full weeks in range.'
                  )}
                </p>
                <Columns
                  label="Net revenue by week"
                  items={weeks.map((w) => ({
                    key: w.weekOf,
                    label: `${shortDay(w.weekOf)}${w.complete ? '' : '*'}`,
                    value: w.netRevenueMinor,
                    emphasis: lastFull !== undefined && w.weekOf === lastFull.weekOf,
                  }))}
                  format={(v) => <M amount={v} symbol={false} />}
                />
              </>
            ) : null}
          </Tile>
        ) : null}
        {canReport ? (
          <Tile pending="chart" title="By weekday" what="Revenue by weekday" state={byDay.state} onRetry={byDay.refresh}>
            {byDay.state.status === 'ready' ? (
              <>
                <p className="tile-sowhat">
                  <b>{bestWeekday.label}</b> carries the week at{' '}
                  <b>
                    <M amount={bestWeekday.averageMinor} />
                  </b>{' '}
                  a day on average.
                </p>
                <Columns
                  label="Average net revenue by weekday"
                  items={weekdays.map((w) => ({
                    key: w.label,
                    label: w.label,
                    value: w.averageMinor,
                    emphasis: w.label === bestWeekday.label,
                  }))}
                  format={(v) => <M amount={v} symbol={false} />}
                />
              </>
            ) : null}
          </Tile>
        ) : null}
        {canReport ? (
          <Tile pending="chart"
            title="Average basket"
            what="Average sale"
            state={byDay.state}
            onRetry={byDay.refresh}
            pill={
              byDay.state.status === 'ready' ? (
                <span className="tile-pill tabular">{String(byDay.state.data.total.saleCount)} sales</span>
              ) : null
            }
          >
            {byDay.state.status === 'ready'
              ? (() => {
                  const basket = averageBasket(byDay.state.data.total.netRevenueMinor, byDay.state.data.total.saleCount);
                  const last = series.length > 0 ? series[series.length - 1]! : undefined;
                  const lastBasket = last === undefined ? null : averageBasket(last.netRevenueMinor, last.saleCount);
                  return basket === null ? (
                    <p className="tile-sub">No sales in this range.</p>
                  ) : (
                    <>
                      <p className="tile-figure money">
                        <M amount={basket} />
                      </p>
                      <p className="tile-sub">net per sale · by day below, dashed line is the range average</p>
                      <DailyBars
                        label="Average basket by day"
                        points={series.map((d) => averageBasket(d.netRevenueMinor, d.saleCount))}
                        labels={series.map((d) => shortDay(d.date))}
                        tickEvery={Math.max(1, Math.ceil(series.length / 4))}
                        averageWindow={0}
                        reference={basket}
                        endLabel={lastBasket === null ? undefined : <M amount={lastBasket} symbol={false} />}
                        format={(v) => <M amount={v} />}
                        width={360}
                        height={120}
                      />
                    </>
                  );
                })()
              : null}
          </Tile>
        ) : null}
      </Row>

      <Row cols="2-1">
        {canReport ? (
          <Tile pending="table" title="Locations" what="Sales by location" state={byLoc.state} onRetry={byLoc.refresh} link={link(onOpen, 'reports', 'Reports')}>
            {byLoc.state.status === 'ready'
              ? (() => {
                  const ranked = [...byLoc.state.data.locations].sort((a, b) =>
                    a.netRevenueMinor === b.netRevenueMinor ? 0 : a.netRevenueMinor > b.netRevenueMinor ? -1 : 1,
                  );
                  const max = maxOf(ranked.map((l) => l.netRevenueMinor));
                  const total = byLoc.state.data.total;
                  return (
                    <>
                      <div className="office-table-scroll">
                        <table className="office-table">
                          <caption className="visually-hidden">
                            Net revenue by location, {from} to {to}
                          </caption>
                          <thead>
                            <tr>
                              <th scope="col">Location</th>
                              <th scope="col" className="numeric">
                                Sales
                              </th>
                              <th scope="col" style={{ width: '22%' }}>
                                Net revenue
                              </th>
                              <th scope="col" className="numeric">
                                Share
                              </th>
                              <th scope="col" className="numeric">
                                Net
                              </th>
                              <th scope="col" className="numeric">
                                Billed
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {ranked.map((l) => (
                              <tr key={l.locationId}>
                                <td>
                                  <span className="office-who">
                                    <span className="office-who-mark" aria-hidden="true">
                                      {initials(l.locationName)}
                                    </span>
                                    <span>
                                      <b>{l.locationName}</b>
                                      <small>{l.locationCode}</small>
                                    </span>
                                  </span>
                                </td>
                                <td className="numeric tabular">{String(l.saleCount)}</td>
                                <td>
                                  <span className="office-bar-track" aria-hidden="true">
                                    <span className="office-bar-fill" style={{ width: bpToPercent(shareBp(l.netRevenueMinor, max)) }} />
                                  </span>
                                </td>
                                <td className="numeric tabular">{(shareBp(l.netRevenueMinor, total.netRevenueMinor) / 100).toFixed(1)}%</td>
                                <td className="numeric">
                                  <M amount={l.netRevenueMinor} symbol={false} />
                                </td>
                                <td className="numeric">
                                  <M amount={l.totalMinor} symbol={false} />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            <tr>
                              <td>{byLoc.state.data.scope.network ? 'Whole organisation' : 'Your locations only'}</td>
                              <td className="numeric tabular">{String(total.saleCount)}</td>
                              <td />
                              <td className="numeric tabular">100%</td>
                              <td className="numeric">
                                <M amount={total.netRevenueMinor} symbol={false} />
                              </td>
                              <td className="numeric">
                                <M amount={total.totalMinor} symbol={false} />
                              </td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                      {ranked.length === 1 ? (
                        <p className="tile-sub">One location is trading. This becomes a ranked list as locations open.</p>
                      ) : null}
                    </>
                  );
                })()
              : null}
          </Tile>
        ) : null}
        {canStock ? (
          <Tile pending="cards"
            title="Low stock"
            what="The low-stock alert"
            state={low.state}
            onRetry={low.refresh}
            tinted
            link={link(onOpen, 'stock', 'Stock')}
            pill={
              low.state.status === 'ready' ? (
                <span className={`tile-pill tabular ${low.state.data.alertCount > 0 ? 'tile-pill-warn' : 'tile-pill-ok'}`}>
                  {String(low.state.data.alertCount)} {low.state.data.alertCount === 1 ? 'line' : 'lines'}
                </span>
              ) : null
            }
          >
            {low.state.status === 'ready' ? (
              low.state.data.alerts.length === 0 ? (
                <p className="tile-sub">Nothing is below its reorder point.</p>
              ) : (
                <div>
                  {low.state.data.alerts.map((a) => (
                    <div className="office-mini" key={a.reorderPointId}>
                      <span className="office-mini-ico office-dot-warn">
                        <Icon name="box" size={14} />
                      </span>
                      <span className="office-mini-text">
                        <b>{a.productName}</b>
                        <small>
                          {formatQtyScaled(a.qtyOnHand, a.qtyScale)} <Unit code={a.uomCode} /> on hand · reorder at{' '}
                          {formatQtyScaled(a.reorderPointQty, a.qtyScale)}
                        </small>
                      </span>
                      <span className={`tile-pill ${a.leadTimeDays === null ? '' : 'tile-pill-warn'} tabular`}>
                        {a.leadTimeDays === null ? 'no lead time' : `${String(a.leadTimeDays)} d lead`}
                      </span>
                    </div>
                  ))}
                </div>
              )
            ) : null}
          </Tile>
        ) : null}
      </Row>

      <Row>
        {canReport ? (
          <Tile
            title="Cash vs credit"
            what="Cash and credit by location"
            state={cash.state}
            onRetry={cash.refresh}
            pill={
              cash.state.status === 'ready' ? (
                <span className="tile-pill tabular">
                  {(shareBp(cash.state.data.total.creditTenderMinor, cash.state.data.total.billedTotalMinor) / 100).toFixed(0)}% on credit
                </span>
              ) : null
            }
          >
            {cash.state.status === 'ready'
              ? (() => {
                  const { top, otherMinor, otherCount } = topN(cash.state.data.locations, 8, (l) => l.billedTotalMinor);
                  return (
                    <>
                      <p className="tile-sowhat">
                        <b>
                          <M amount={cash.state.data.total.creditTenderMinor} />
                        </b>{' '}
                        of{' '}
                        <b>
                          <M amount={cash.state.data.total.billedTotalMinor} />
                        </b>{' '}
                        billed went on credit. Credit receipts (<M amount={cash.state.data.unattributed.creditReceiptsMinor} />) have no
                        till and are not shown by location.
                      </p>
                      <SplitBars
                        label="Cash and credit by location"
                        aName="Cash and mobile money"
                        bName="On credit"
                        rows={top.map((l) => ({
                          key: l.locationId,
                          label: (
                            <>
                              {l.locationName}
                              <small>{l.locationCode}</small>
                            </>
                          ),
                          a: l.immediateTenderMinor,
                          b: l.creditTenderMinor,
                        }))}
                        format={(v) => <M amount={v} symbol={false} />}
                        note={
                          otherCount > 0 ? (
                            <>
                              {String(otherCount)} more locations billed <M amount={otherMinor} /> between them.
                            </>
                          ) : undefined
                        }
                      />
                    </>
                  );
                })()
              : null}
          </Tile>
        ) : null}
        {canMargin ? (
          <Tile pending="table" title="Gross margin by location" what="Gross margin by location" state={days.state} onRetry={days.refresh}>
            {days.state.status === 'ready' ? (
              <>
                <p className="tile-sowhat">
                  {days.state.data.total.grossMarginPctE4 === null ? (
                    <>The network figure is withheld: {days.state.data.total.unavailable}.</>
                  ) : (
                    <>
                      Network <b>{formatPercentE4(days.state.data.total.grossMarginPctE4)}%</b>. The mark on each track is the network
                      figure.
                    </>
                  )}
                </p>
                <Bars
                  label="Gross margin by location"
                  rows={days.state.data.locations.map((l) => ({
                    key: l.locationId,
                    label: (
                      <>
                        {l.locationName}
                        <small>
                          {l.locationCode}
                          {l.productsMissingCostBasis > 0 ? ` · ${String(l.productsMissingCostBasis)} lines uncosted` : ''}
                        </small>
                      </>
                    ),
                    value: l.grossMarginPctE4,
                  }))}
                  format={(v) => `${formatPercentE4(v)}%`}
                  {...(days.state.data.total.grossMarginPctE4 === null ? {} : { mark: days.state.data.total.grossMarginPctE4 })}
                />
              </>
            ) : null}
          </Tile>
        ) : null}
      </Row>

      <Row>
        {canMargin ? (
          <Tile
            title="Distribution"
            what="Distribution cost as a share of revenue"
            state={dist.state}
            onRetry={dist.refresh}
            pill={
              dist.state.status === 'ready' ? (
                <span className="tile-pill tabular">{String(dist.state.data.total.deliveryCount)} deliveries</span>
              ) : null
            }
          >
            {dist.state.status === 'ready' ? (
              <>
                {dist.state.data.total.distributionCostPctE4 === null ? (
                  <Unavailable reason={dist.state.data.total.unavailable ?? dist.state.data.unavailableReason} />
                ) : (
                  <p className="tile-figure tabular">
                    {formatPercentE4(dist.state.data.total.distributionCostPctE4)}
                    <span className="tile-figure-unit">% of revenue</span>
                  </p>
                )}
                <p className="tile-sub">
                  {dist.state.data.total.deliveriesWithNoAgreedFreight > 0 ? (
                    <>
                      A floor — <b className="tabular">{String(dist.state.data.total.deliveriesWithNoAgreedFreight)}</b> deliveries have no
                      agreed freight.
                    </>
                  ) : (
                    'Agreed freight over net revenue.'
                  )}
                </p>
                {dist.state.data.locations.length > 1 ? (
                  <Bars
                    label="Distribution cost by location"
                    rows={dist.state.data.locations.map((l) => ({ key: l.locationId, label: l.locationName, value: l.distributionCostPctE4 }))}
                    format={(v) => `${formatPercentE4(v)}%`}
                  />
                ) : null}
              </>
            ) : null}
          </Tile>
        ) : null}
        {canMargin ? (
          <Tile title="Stock cover" what="Inventory days" state={days.state} onRetry={days.refresh}>
            {days.state.status === 'ready' ? (
              <>
                {days.state.data.total.inventoryDaysE4 === null ? (
                  <Unavailable reason={days.state.data.total.unavailable}>
                    <span>
                      {String(days.state.data.locations.reduce((n, l) => n + l.productsMissingCostBasis, 0))} lines have no landed cost, so
                      cover cannot be priced. Nothing here is a zero.
                    </span>
                  </Unavailable>
                ) : (
                  <p className="tile-figure tabular">
                    {formatDaysE4(days.state.data.total.inventoryDaysE4)}
                    <span className="tile-figure-unit">days of cover</span>
                  </p>
                )}
                {days.state.data.locations.length > 1 ? (
                  <Bars
                    label="Inventory days by location"
                    rows={days.state.data.locations.map((l) => ({ key: l.locationId, label: l.locationName, value: l.inventoryDaysE4 }))}
                    format={(v) => `${formatDaysE4(v)} d`}
                  />
                ) : null}
              </>
            ) : null}
          </Tile>
        ) : null}
        {canBooks ? (
          <Tile
            title="Posting"
            what="Posting exceptions"
            state={posting.state}
            onRetry={posting.refresh}
            link={link(onOpen, 'books', 'Books')}
            pill={
              posting.state.status === 'ready' ? (
                <span className={`tile-pill ${posting.state.data.openCount === 0 ? 'tile-pill-ok' : 'tile-pill-bad'}`}>
                  {posting.state.data.openCount === 0 ? 'clean' : 'attention'}
                </span>
              ) : null
            }
          >
            {posting.state.status === 'ready' ? (
              <>
                <p className="tile-figure tabular">
                  {String(posting.state.data.openCount)}
                  <span className="tile-figure-unit">open {posting.state.data.openCount === 1 ? 'exception' : 'exceptions'}</span>
                </p>
                <p className="tile-sub">
                  {posting.state.data.openCount === 0 ? 'The books posted clean.' : 'Documents the ledger could not post.'}
                </p>
              </>
            ) : null}
          </Tile>
        ) : null}
      </Row>
    </>
  );
}

// ---------------------------------------------------------------------------

export function Dashboard({ db, permissions, apiOptions, onOpen }: DashboardProps): ReactNode {
  const location = useLiveQuery(db, readDeviceLocation, []);
  const options = useMemo<ApiCallOptions>(() => apiOptions ?? {}, [apiOptions]);
  const timeZone = location === undefined ? null : (location?.timeZone ?? null);
  const range = useMemo(() => recentRange(timeZone), [timeZone]);

  if (location === undefined) {
    return (
      <div className="dashboard">
        <ServerPending shape="tiles" what="The dashboard" rows={4} />
      </div>
    );
  }
  return (
    <div className="dashboard">
      <Body from={range.from} to={range.to} apiOptions={options} permissions={permissions} onOpen={onOpen} />
    </div>
  );
}
