// @vitest-environment jsdom
/**
 * THE REVIEW SCREEN — the surface that finally works the queue.
 *
 * CLAUDE.md §2.2 requires that a conflict which cannot be resolved
 * automatically reaches a human and is never silently overwritten. Three
 * writers filled `app.conflict_review` from Phase 1 onward and nothing could
 * read it: no router, no client, no screen. Six rows sat `open` on the live
 * database, none ever claimed or resolved.
 *
 * What these tests hold, beyond "it renders":
 *
 *  1. FIGURES ARE PRINTED AS THEY ARRIVED. Money inside a proposal is a
 *     decimal string (ADR-0004). This screen is the one place a human reads a
 *     number off a screen and re-types it, so a float64 round-trip here would
 *     be a wrong figure with somebody's signature on it.
 *  2. IT NEVER CLAIMS TO HAVE FIXED THE RECORD. Resolving records a decision.
 *     The copy must say so — the server returns `entityRewritten: false`.
 *  3. WITHHELD ITEMS ARE COUNTED OUT LOUD. "Nothing is waiting on you" and
 *     "there are items nobody at your level may touch" are different
 *     sentences, and conflating them is how a queue stops being worked.
 *  4. A REFUSAL SAYS NOTHING WAS SAVED. Nothing here queues; the whole point
 *     of the row is that a partitioned device could not decide it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ApiCallOptions, ApiEndpoint, ApiFetch } from '../src/data/api/client';
import { Review } from '../src/features/review/Review';

const ENDPOINT: ApiEndpoint = { url: 'http://api.test', bearer: 'dev' };
const LOC = '018f3a1e-0000-7000-8000-00000000aaaa';
const REVIEW = '018f3a1e-0000-7000-8000-0000000000f1';

type Answer = { ok: true; json: unknown } | 'reject';

function router(answers: Readonly<Record<string, Answer>>, sent: string[] = []): ApiFetch {
  return (url, init) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace('/trpc/', '');
    sent.push(`${path}:${init.body ?? parsed.searchParams.get('input') ?? ''}`);
    const answer = answers[path];
    if (answer === undefined || answer === 'reject') return Promise.reject(new Error('no radio'));
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ result: { data: { json: answer.json } } }),
    });
  };
}

/** A real class-#14 row: a receipt block regressed after a device was wiped. */
function reviewRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reviewId: REVIEW,
    conflictClass: 'SEQUENCE_CONSUMED_UPTO_REGRESSION',
    severity: 1,
    entityTable: 'app.sequence_block',
    entityId: '018f3a1e-0000-7000-8000-0000000000b2',
    fieldPath: 'consumed_upto',
    ancestorValue: null,
    proposals: [
      { party: 'server', consumedUpto: '4312', blockStart: '4301' },
      { party: 'device', consumedUpto: null, blockStart: '4301' },
    ],
    pendingState: 'first_applied',
    pendingValue: { consumedUpto: '4312' },
    requiredPermission: 'sync.conflict.review',
    status: 'open',
    claimedBy: null,
    claimedAt: null,
    resolvedBy: null,
    resolvedAt: null,
    resolution: null,
    openedAt: '2026-08-21T09:14:02.113Z',
    escalateAt: '2026-08-22T09:14:02.113Z',
    escalationLevel: 0,
    locationIds: [LOC],
    ...over,
  };
}

function listOf(rows: readonly unknown[], hiddenCount = 0): unknown {
  return { reviewCount: rows.length, hiddenCount, reviews: rows };
}

function options(fetchFn: ApiFetch): ApiCallOptions {
  return { endpoint: ENDPOINT, fetchFn };
}

afterEach(cleanup);

describe('the queue is readable at last', () => {
  it('shows a blocking item with its class, and says what the record holds now', async () => {
    render(
      <Review
        apiOptions={options(router({ 'review.list': { ok: true, json: listOf([reviewRow()]) } }))}
      />,
    );

    expect(await screen.findByText(/Blocking/)).toBeTruthy();
    // A title a person can act on, a line on what happened…
    expect(screen.getByText('Receipt numbering went backwards')).toBeTruthy();
    expect(screen.getByText(/fewer receipt numbers than it had already reported/)).toBeTruthy();
    // …and the codes still on screen, for a support call to quote.
    expect(screen.getByText(/Receipt numbers · /)).toBeTruthy();
    expect(screen.getByText(/SEQUENCE_CONSUMED_UPTO_REGRESSION · consumed_upto/)).toBeTruthy();
  });

  it('prints the figures EXACTLY as they arrived — never parsed (ADR-0004)', async () => {
    render(
      <Review
        apiOptions={options(router({ 'review.list': { ok: true, json: listOf([reviewRow()]) } }))}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Show the detail/ }));

    // The string "4312", not the number 4312. A screen that had parsed it
    // would still render "4312" here — so the assertion that matters is that
    // it appears inside a JSON string literal, quotes and all.
    const payloads = document.querySelectorAll('.review-payload-body');
    const text = [...payloads].map((p) => p.textContent ?? '').join('\n');
    expect(text).toContain('"consumedUpto": "4312"');
    expect(text).not.toContain('"consumedUpto": 4312');
  });

  it('says plainly that recording a decision does not change the record', async () => {
    render(
      <Review
        apiOptions={options(router({ 'review.list': { ok: true, json: listOf([reviewRow()]) } }))}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Show the detail/ }));
    // The sentence is deliberately split by an emphasised "not", so it is
    // read off the element rather than matched as one text node.
    const caveat = document.querySelector('.review-caveat');
    expect(caveat?.textContent ?? '').toMatch(/does not change the original record/i);
  });

  it('counts items it is not allowed to show, rather than reading as empty', async () => {
    render(
      <Review
        apiOptions={options(router({ 'review.list': { ok: true, json: listOf([], 3) } }))}
      />,
    );
    expect(await screen.findByText(/Nothing is waiting on you/)).toBeTruthy();
    expect(
      screen.getByText(/3 more items are waiting for someone with different access/),
    ).toBeTruthy();
  });

  it('an item already being worked says so', async () => {
    render(
      <Review
        apiOptions={options(
          router({
            'review.list': {
              ok: true,
              json: listOf([
                reviewRow({ status: 'claimed', claimedBy: 'u9', claimedAt: '2026-08-21T10:00:00.000Z' }),
              ]),
            },
          }),
        )}
      />,
    );
    expect(await screen.findByText(/Someone is already working on this/)).toBeTruthy();
  });
});

describe('recording a decision', () => {
  it('will not send without a reason, and sends the reason when given one', async () => {
    const sent: string[] = [];
    render(
      <Review
        apiOptions={options(
          router(
            {
              'review.list': { ok: true, json: listOf([reviewRow()]) },
              'review.resolve': {
                ok: true,
                json: {
                  reviewId: REVIEW,
                  status: 'resolved',
                  resolvedBy: 'u1',
                  choice: 'keep_pending',
                  entityRewritten: false,
                },
              },
            },
            sent,
          ),
        )}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Show the detail/ }));

    const record = screen.getByRole('button', { name: /Record this decision/ });
    expect((record as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Block burned and reissued; the gap is documented.' },
    });
    expect((record as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(record);
    await waitFor(() => {
      expect(sent.some((s) => s.startsWith('review.resolve:'))).toBe(true);
    });
    const body = sent.find((s) => s.startsWith('review.resolve:'))!;
    expect(body).toContain('Block burned and reissued');
    expect(body).toContain('keep_pending');
  });

  it('accepting one side requires naming which side', async () => {
    render(
      <Review
        apiOptions={options(router({ 'review.list': { ok: true, json: listOf([reviewRow()]) } }))}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Show the detail/ }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'the server is right' } });
    fireEvent.click(screen.getByRole('radio', { name: /Accept one version/ }));

    const record = screen.getByRole('button', { name: /Record this decision/ });
    expect((record as HTMLButtonElement).disabled).toBe(true);

    // The picker offers only parties that are actually on the row, so it
    // cannot offer a key the server would refuse.
    const select = screen.getByRole('combobox');
    expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'Choose…',
      'server',
      'device',
    ]);
    fireEvent.change(select, { target: { value: 'server' } });
    expect((record as HTMLButtonElement).disabled).toBe(false);
  });

  it('a refusal says NOTHING WAS SAVED — this screen never queues', async () => {
    render(
      <Review
        apiOptions={options(
          router({
            'review.list': { ok: true, json: listOf([reviewRow()]) },
            'review.resolve': 'reject',
          }),
        )}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Show the detail/ }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'opened in error' } });
    fireEvent.click(screen.getByRole('radio', { name: /Nothing to decide/ }));
    fireEvent.click(screen.getByRole('button', { name: /Record this decision/ }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').toMatch(/^Nothing was saved\./);
  });
});

describe('with the radio off', () => {
  it('refuses out loud rather than showing a queue it cannot stand behind', async () => {
    render(<Review apiOptions={options(router({}))} />);
    // The shared refusal panel, the same one every online-only screen uses.
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(screen.queryByText(/Nothing is waiting on you/)).toBeNull();
  });
});
