/** Every failure in this package throws MoneyError. Nothing here ever returns NaN,
 * Infinity, or a silently-wrong value — a monetary computation either succeeds
 * exactly or throws. */
export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}
