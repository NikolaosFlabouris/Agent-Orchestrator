import { describe, it, expect } from 'vitest';
import { normalizeTimestamp, durationSeconds } from '../../db.js';

/** The orchestrator stores timestamps in two shapes:
 *    - datetime('now')        → "YYYY-MM-DD HH:MM:SS"      (space, no zone)
 *    - new Date().toISOString() → "YYYY-MM-DDTHH:MM:SS.sssZ"
 *  Both are UTC. These tests pin the normalization + duration helpers across
 *  BOTH forms (and a mix of the two), which the SQL aggregation mirrors via
 *  normTsSql/julianday in db.ts. */

describe('normalizeTimestamp', () => {
  it('canonicalizes the space-separated datetime(\'now\') form to ISO UTC', () => {
    expect(normalizeTimestamp('2025-01-01 00:00:00')).toBe(
      '2025-01-01T00:00:00.000Z'
    );
  });

  it('passes the toISOString() form through unchanged', () => {
    expect(normalizeTimestamp('2025-01-01T00:00:00.000Z')).toBe(
      '2025-01-01T00:00:00.000Z'
    );
  });

  it('treats a zone-less value as UTC (not local time)', () => {
    // Both stored forms denote the same instant; normalization must agree.
    expect(normalizeTimestamp('2025-06-15 13:45:30')).toBe(
      normalizeTimestamp('2025-06-15T13:45:30.000Z')
    );
  });
});

describe('durationSeconds', () => {
  it('computes the duration for two space-separated timestamps', () => {
    expect(durationSeconds('2025-01-01 00:00:00', '2025-01-01 01:30:00')).toBe(
      5400
    );
  });

  it('computes the duration for two ISO-8601 timestamps', () => {
    expect(
      durationSeconds(
        '2025-01-01T00:00:00.000Z',
        '2025-01-01T00:00:05.000Z'
      )
    ).toBe(5);
  });

  it('computes a correct duration across the MIXED formats', () => {
    // start = datetime('now') shape, end = toISOString() shape.
    expect(
      durationSeconds('2025-01-01 00:00:00', '2025-01-01T00:01:00.000Z')
    ).toBe(60);
    // …and the reverse ordering.
    expect(
      durationSeconds('2025-01-01T00:00:00.000Z', '2025-01-01 00:02:00')
    ).toBe(120);
  });
});
