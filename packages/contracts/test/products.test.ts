/**
 * The product-list file contract, pure: headers matched by meaning, CSV as
 * spreadsheets actually write it, money left as exact TEXT, and every row's
 * shape problems named without a single lookup.
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalProductRows,
  classifyHeader,
  decimalCell,
  onSaleCell,
  parseCsv,
  parseProductCsv,
  productNameKey,
  productTemplateHeaders,
  toCsv,
} from '../src/index.js';

describe('parseCsv — RFC 4180 as spreadsheets write it', () => {
  it('keeps commas, doubled quotes and line breaks inside quoted fields', () => {
    expect(parseCsv('a,b,c\r\n"1,5","say ""hi""","two\nlines"\r\n')).toEqual([
      ['a', 'b', 'c'],
      ['1,5', 'say "hi"', 'two\nlines'],
    ]);
  });

  it('reads a semicolon file (a European-locale Excel save) and strips a BOM', () => {
    expect(parseCsv('﻿Name;Price\nCement;"1,5"\n')).toEqual([
      ['Name', 'Price'],
      ['Cement', '1,5'],
    ]);
  });

  it('round-trips through toCsv', () => {
    const rows = [['Name', 'Notes'], ['Paint, white', 'He said "4L"\nthen left'], [' padded ', '']];
    expect(parseCsv(toCsv(rows)).map((r) => r.map((f) => f))).toEqual([
      ['Name', 'Notes'],
      ['Paint, white', 'He said "4L"\nthen left'],
      ['padded', ''],
    ]);
  });
});

describe('headers are matched by meaning, prices by the list they name', () => {
  it('accepts the spellings people type', () => {
    expect(classifyHeader('Product name *')).toEqual({ column: 'name' });
    expect(classifyHeader('product_name')).toEqual({ column: 'name' });
    expect(classifyHeader('SKU')).toEqual({ column: 'code' });
    expect(classifyHeader('Cost price (per unit)')).toEqual({ column: 'cost' });
    expect(classifyHeader('Unit of measure')).toEqual({ column: 'unit' });
    expect(classifyHeader('Colour')).toBeNull();
  });

  it('a price column names a list — or none, meaning the first-priority list', () => {
    expect(classifyHeader('Price')).toEqual({ price: { header: 'Price', listKey: '' } });
    expect(classifyHeader('Price: Counter retail *')).toEqual({ price: { header: 'Price: Counter retail *', listKey: 'counter retail' } });
    expect(classifyHeader('Wholesale price')).toEqual({ price: { header: 'Wholesale price', listKey: 'wholesale' } });
    expect(classifyHeader('price_RETAIL')).toEqual({ price: { header: 'price_RETAIL', listKey: 'retail' } });
  });

  it('the template’s own headers all classify, and only its price columns are prices', () => {
    const headers = productTemplateHeaders(['Retail', 'Trade']);
    const kinds = headers.map((h) => classifyHeader(h));
    expect(kinds.every((k) => k !== null)).toBe(true);
    expect(kinds.filter((k) => k !== null && 'price' in k)).toHaveLength(2);
  });
});

describe('decimalCell — money stays text, exactly as typed', () => {
  it('accepts plain and thousands-grouped decimals; refuses everything else', () => {
    expect(decimalCell('1250.50')).toBe('1250.50');
    expect(decimalCell('1,250.50')).toBe('1250.50');
    expect(decimalCell(' 12 ')).toBe('12');
    // a float would round this; text does not
    expect(decimalCell('90071992547409.93')).toBe('90071992547409.93');
    for (const bad of ['-5', 'GH 10', '1.2.3', '12,50', '1e3', '']) expect(decimalCell(bad)).toBeNull();
  });
});

describe('parseProductCsv — every row’s shape, no lookups', () => {
  const head = 'Product name *,Category *,Unit *,Price,Cost price,Product code';

  it('refuses a file missing a required column or any price column, naming what is missing', () => {
    expect(parseProductCsv('Name,Price\nX,1').fileError).toMatch(/Missing: Category, Unit/);
    expect(parseProductCsv('Name,Category,Unit\nX,Y,bag').fileError).toMatch(/no selling price column/);
    expect(parseProductCsv('').fileError).toMatch(/empty/);
    expect(parseProductCsv(`${head}\n`).fileError).toMatch(/no products/);
  });

  it('names each row’s problems and keeps the line number a person sees', () => {
    const f = parseProductCsv(
      [
        head,
        'Cement 50kg,Cement,bag,"1,250.50",980,C-1',
        '',
        ',Cement,bag,10,,',
        'Sand,,ton,abc,,',
        'Gravel,Aggregates,ton,,,',
        'cement   50KG,Cement,bag,10,,',
        'Other,Cement,bag,10,,c-1',
      ].join('\n'),
    );
    expect(f.fileError).toBeNull();
    expect(f.rows.map((r) => [r.lineNo, r.issues])).toEqual([
      [2, []],
      [4, ['MISSING_NAME']],
      [5, ['MISSING_CATEGORY', 'BAD_PRICE']],
      [6, ['NO_PRICE']],
      [7, ['DUPLICATE_IN_FILE']],
      [8, ['DUPLICATE_IN_FILE']],
    ]);
    expect(f.rows[0]).toMatchObject({ name: 'Cement 50kg', costText: '980', code: 'C-1', prices: [{ column: 0, text: '1250.50' }] });
  });

  it('reports columns it does not use, rather than silently dropping them', () => {
    const f = parseProductCsv('Name,Category,Unit,Price,Colour,Weight\nX,Y,bag,1,red,2');
    expect(f.ignoredColumns).toEqual(['Colour', 'Weight']);
  });

  it('the content hash ignores row order and name spacing, not values', () => {
    const a = parseProductCsv(`${head}\nA,C,bag,1,,\nB,C,bag,2,,`);
    const b = parseProductCsv(`${head}\nB,C,bag,2,,\na,C,bag,1,,`);
    const c = parseProductCsv(`${head}\nA,C,bag,1,,\nB,C,bag,3,,`);
    expect(canonicalProductRows(a)).toBe(canonicalProductRows(b));
    expect(canonicalProductRows(a)).not.toBe(canonicalProductRows(c));
  });

  it('one name key for every spelling of the same product', () => {
    expect(productNameKey('  Cement   50KG ')).toBe(productNameKey('cement 50kg'));
  });
});

describe('the “On sale” column — load a product switched off', () => {
  it('reads yes / no as people and Excel write them; blank is yes; anything else is named', () => {
    for (const yes of ['', 'Yes', 'Y', 'TRUE', '1', 'on', ' active ']) expect(onSaleCell(yes), yes).toBe(true);
    for (const no of ['No', 'n', 'FALSE', '0', 'Off', 'inactive']) expect(onSaleCell(no), no).toBe(false);
    for (const bad of ['maybe', 'yes please', '2']) expect(onSaleCell(bad), bad).toBeNull();
  });

  it('is optional, sits in the template, and a bad value refuses only its own row', () => {
    expect(productTemplateHeaders(['Retail'])).toContain('On sale');
    expect(classifyHeader('On sale')).toEqual({ column: 'onSale' });
    expect(classifyHeader('For sale?')).toEqual({ column: 'onSale' });
    // Without the column every row is on sale.
    expect(parseProductCsv('Name,Category,Unit,Price\nX,Y,bag,1').rows[0]!.onSale).toBe(true);
    const f = parseProductCsv('Name,Category,Unit,Price,On sale\nA,C,bag,1,No\nB,C,bag,1,\nD,C,bag,1,perhaps');
    expect(f.rows.map((r) => [r.name, r.onSale, r.issues])).toEqual([
      ['A', false, []],
      ['B', true, []],
      ['D', true, ['BAD_ON_SALE']],
    ]);
  });

  it('the content hash sees the switch: the same row on and off is a different list', () => {
    const on = parseProductCsv('Name,Category,Unit,Price,On sale\nA,C,bag,1,Yes');
    const off = parseProductCsv('Name,Category,Unit,Price,On sale\nA,C,bag,1,No');
    expect(canonicalProductRows(on)).not.toBe(canonicalProductRows(off));
  });
});
