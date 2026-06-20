import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  formatDuration,
  formatPercent,
  formatNumber,
  formatRework,
  relativeDelta,
} from '../components/reportFormat.js';
import {
  toDateInput,
  defaultRange,
  previousRange,
} from '../components/reportFilter.js';

describe('formatDuration', () => {
  it('renders the empty placeholder for null / non-finite', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(NaN)).toBe('—');
  });

  it('formats sub-minute values in seconds', () => {
    expect(formatDuration(42)).toBe('42s');
  });

  it('formats minutes / hours / days with a single decimal under 10', () => {
    expect(formatDuration(90)).toBe('1.5m');
    expect(formatDuration(3 * 3600)).toBe('3.0h');
    expect(formatDuration(36 * 3600)).toBe('1.5d');
  });

  it('drops the decimal at/above 10 units', () => {
    expect(formatDuration(12 * 60)).toBe('12m');
  });
});

describe('formatPercent / formatNumber / formatRework', () => {
  it('converts a 0..1 ratio to a percentage', () => {
    expect(formatPercent(0.5)).toBe('50%');
    expect(formatPercent(0.833, 1)).toBe('83.3%');
    expect(formatPercent(null)).toBe('—');
  });

  it('formats counts and rework factors', () => {
    expect(formatNumber(1234)).toBe((1234).toLocaleString());
    expect(formatNumber(null)).toBe('—');
    expect(formatRework(1.4)).toBe('1.4×');
    expect(formatRework(null)).toBe('—');
  });
});

describe('relativeDelta', () => {
  it('computes signed relative change', () => {
    expect(relativeDelta(12, 10)).toBeCloseTo(0.2);
    expect(relativeDelta(8, 10)).toBeCloseTo(-0.2);
  });

  it('returns null when it cannot be computed', () => {
    expect(relativeDelta(5, 0)).toBeNull(); // zero baseline
    expect(relativeDelta(null, 10)).toBeNull();
    expect(relativeDelta(10, null)).toBeNull();
  });
});

describe('reportFilter date helpers', () => {
  afterEach(() => vi.useRealTimers());

  it('formats a date as YYYY-MM-DD (UTC)', () => {
    expect(toDateInput(new Date('2026-06-20T15:00:00Z'))).toBe('2026-06-20');
  });

  it('defaultRange spans `days` back from today', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-20T12:00:00Z'));
    expect(defaultRange(30)).toEqual({ from: '2026-05-21', to: '2026-06-20' });
  });

  it('previousRange returns the equally-long preceding window', () => {
    const prev = previousRange('2026-06-01', '2026-06-11'); // 10-day span
    expect(prev).not.toBeNull();
    expect(prev!.to).toBe(new Date('2026-06-01').toISOString());
    expect(prev!.from).toBe(new Date('2026-05-22').toISOString());
  });

  it('previousRange rejects invalid / inverted bounds', () => {
    expect(previousRange('nope', '2026-06-11')).toBeNull();
    expect(previousRange('2026-06-11', '2026-06-01')).toBeNull();
  });
});
