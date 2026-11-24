import { describe, expect, it } from 'vitest';
import {
  conflictSummary,
  conflictTitle,
  entityLabel,
  escalationLabel,
  relativeTo,
  softenCode,
} from '../src/features/review/labels';

const NOW = Date.parse('2026-11-23T12:00:00Z');

describe('review queue words', () => {
  it('names a known class in a sentence, and keeps a summary beside it', () => {
    expect(conflictTitle('RECEIPT_NUMBER_COLLISION')).toBe('Two sales share a receipt number');
    expect(conflictSummary('RECEIPT_NUMBER_COLLISION')).toMatch(/same number/);
  });

  it('falls back to the softened code for a class this client does not know', () => {
    expect(conflictTitle('SOMETHING_NEW_ON_THE_SERVER')).toBe('Something new on the server');
    expect(conflictSummary('SOMETHING_NEW_ON_THE_SERVER')).toBeNull();
    expect(softenCode('')).toBe('');
  });

  it('names entity tables without their schema prefix', () => {
    expect(entityLabel('app.sequence_block')).toBe('Receipt numbers');
    expect(entityLabel('app.cash_session')).toBe('Till session');
    expect(entityLabel('device')).toBe('Device');
    expect(entityLabel('app.some_new_table')).toBe('Some new table');
  });

  it('reads an escalation deadline relative to now, in both directions', () => {
    expect(relativeTo('2026-11-25T12:00:00Z', NOW)).toBe('in 2 days');
    expect(relativeTo('2026-11-23T07:00:00Z', NOW)).toBe('5 hours ago');
    expect(relativeTo('2026-11-23T12:00:20Z', NOW)).toBe('in 1 minute');
    expect(escalationLabel('2026-11-24T12:00:00Z', NOW)).toBe('Escalates in 1 day');
    expect(escalationLabel('2026-11-20T12:00:00Z', NOW)).toBe('Overdue by 3 days');
    expect(escalationLabel('not a date', NOW)).toBe('Escalates not a date');
  });
});
