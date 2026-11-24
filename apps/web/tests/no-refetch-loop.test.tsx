// @vitest-environment jsdom
/**
 * A screen rendered WITHOUT an `apiOptions` prop — which is how the shell
 * renders Decisions and Books — must ask the server once, not forever.
 *
 * Both screens used to default the prop to an inline `{}`: a new object every
 * render, listed as a query dependency, so each answer triggered the next
 * request. Against the live stack that was thousands of `review.list` calls
 * while the screen sat open — on a metered connection, that is money.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const calls = vi.hoisted(() => ({ reviews: 0, exceptions: 0 }));

vi.mock('../src/data/api/review', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/data/api/review')>();
  return {
    ...real,
    fetchReviews: (...args: Parameters<typeof real.fetchReviews>) => {
      calls.reviews += 1;
      return real.fetchReviews(...args);
    },
  };
});

vi.mock('../src/data/api/ledger', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/data/api/ledger')>();
  return {
    ...real,
    fetchPostingExceptions: (...args: Parameters<typeof real.fetchPostingExceptions>) => {
      calls.exceptions += 1;
      return real.fetchPostingExceptions(...args);
    },
  };
});

import { Review } from '../src/features/review/Review';
import { Books } from '../src/features/books/Books';

afterEach(cleanup);

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300));

describe('a screen with no apiOptions asks once', () => {
  it('Decisions', async () => {
    calls.reviews = 0;
    render(<Review />);
    await settle();
    expect(calls.reviews).toBeGreaterThan(0);
    expect(calls.reviews).toBeLessThanOrEqual(2);
  });

  it('Books', async () => {
    calls.exceptions = 0;
    render(<Books />);
    await settle();
    expect(calls.exceptions).toBeGreaterThan(0);
    expect(calls.exceptions).toBeLessThanOrEqual(2);
  });
});
