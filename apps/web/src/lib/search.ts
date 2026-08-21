/**
 * Tolerant product search (§8.7): substring match, case- and space-insensitive,
 * over the LOCAL catalogue. People at a counter type partial words, local
 * names and unit shorthand; tenant-editable `aliases` carry the local
 * vocabulary and are matched with the same normalisation as everything else.
 *
 * Normalisation is applied identically to the query and to the indexed fields,
 * so `2" x 3"`, `2 x 3` and `2x3` all collapse to the same token stream.
 *
 * (The full design is FTS5 with prefix indexes and a per-location sales-rank
 * blend, rebuilt in the SQLite worker. This pure function is the skeleton's
 * matcher and stays the single normalisation authority when FTS lands: the
 * same `normalizeForSearch` feeds the index build and the query.)
 */

export function normalizeForSearch(text: string): string {
  return text
    .toLowerCase()
    .replace(/["'`‘’“”]/g, '') // straight + curly quotes: inch/foot marks
    .replace(/×/g, 'x') // multiplication sign -> x
    .replace(/\bby\b/g, 'x') // "2 by 3" -> "2x3"
    .replace(/[\s\-_./,()]+/g, ''); // whitespace and separators are noise
}

export interface Searchable {
  readonly name: string;
  readonly code: string;
  readonly aliases: string | null;
  readonly category: string | null;
}

export function matchesSearch(query: string, item: Searchable): boolean {
  const q = normalizeForSearch(query);
  if (q.length === 0) return true;
  return (
    normalizeForSearch(item.name).includes(q) ||
    normalizeForSearch(item.code).includes(q) ||
    (item.aliases !== null && normalizeForSearch(item.aliases).includes(q)) ||
    (item.category !== null && normalizeForSearch(item.category).includes(q))
  );
}

/** Filter a loaded catalogue. Empty query returns everything (the quick grid). */
export function searchProducts<T extends Searchable>(items: readonly T[], query: string): T[] {
  return items.filter((p) => matchesSearch(query, p));
}
