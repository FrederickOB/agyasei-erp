/**
 * §8.7: search must tolerate how people actually type — partial words, local
 * names, case, spacing, inch marks. Aliases are tenant data and first-class.
 */
import { describe, expect, it } from 'vitest';
import { matchesSearch, normalizeForSearch, searchProducts } from '../src/lib/search';

const rebar = {
  name: 'Rebar 12mm x 12m length',
  code: 'REB-12-12M',
  aliases: 'half-inch rod,iron rod,rod,12mm',
  category: 'Steel',
};
const timber = {
  name: 'Timber 2" x 3" x 12ft',
  code: 'TIM-2X3-12',
  aliases: 'two by three',
  category: 'Timber',
};
const cementish = {
  name: 'Bagged binder 42.5N 50kg',
  code: 'BAG-425-50',
  aliases: null,
  category: 'Binders',
};

describe('normalizeForSearch', () => {
  it('is identical for the ways people write dimensioned things', () => {
    expect(normalizeForSearch('2" x 3"')).toBe(normalizeForSearch('2x3'));
    expect(normalizeForSearch('2 x 3')).toBe(normalizeForSearch('2x3'));
    expect(normalizeForSearch('2 by 3')).toBe(normalizeForSearch('2x3'));
    expect(normalizeForSearch('12 mm')).toBe(normalizeForSearch('12MM'));
  });
});

describe('matchesSearch', () => {
  it('matches the local name in an alias, not just the catalogue name', () => {
    expect(matchesSearch('half inch', rebar)).toBe(true);
    expect(matchesSearch('half-inch rod', rebar)).toBe(true);
    expect(matchesSearch('iron rod', rebar)).toBe(true);
  });

  it('is case-insensitive and space-insensitive', () => {
    expect(matchesSearch('HALF INCH', rebar)).toBe(true);
    expect(matchesSearch('  half   inch  ', rebar)).toBe(true);
    expect(matchesSearch('reb-12', rebar)).toBe(true);
    expect(matchesSearch('12 mm', rebar)).toBe(true);
  });

  it('finds dimensioned timber from any spelling of the size', () => {
    expect(matchesSearch('2x3', timber)).toBe(true);
    expect(matchesSearch('2 x 3', timber)).toBe(true);
    expect(matchesSearch('2 by 3', timber)).toBe(true);
  });

  it('substring-matches partial words and codes', () => {
    expect(matchesSearch('bind', cementish)).toBe(true);
    expect(matchesSearch('42.5', cementish)).toBe(true);
    expect(matchesSearch('bag-425', cementish)).toBe(true);
  });

  it('rejects what is genuinely absent', () => {
    expect(matchesSearch('paint', rebar)).toBe(false);
    expect(matchesSearch('zzz', timber)).toBe(false);
  });
});

describe('searchProducts', () => {
  const all = [rebar, timber, cementish];

  it('returns everything for an empty query (the quick grid)', () => {
    expect(searchProducts(all, '')).toHaveLength(3);
    expect(searchProducts(all, '   ')).toHaveLength(3);
  });

  it('filters to matches', () => {
    expect(searchProducts(all, 'rod')).toEqual([rebar]);
    expect(searchProducts(all, '12')).toEqual([rebar, timber]);
  });
});
