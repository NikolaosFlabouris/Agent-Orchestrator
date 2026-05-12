import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatTimestamp } from '../components/Timeline.js';

// `formatTimestamp` compares the input timestamp against wallclock `now`,
// so we freeze time to make every assertion deterministic. We pick a fixed
// reference instant (UTC) and exercise each branch of the function:
//   (a) ISO 8601 with `Z`           → parsed as UTC, "X ago" matches elapsed
//   (b) Naive "YYYY-MM-DD HH:MM:SS" → normalized to UTC by formatTimestamp
//   (c) Very recent                 → "just now"
//   (d) Longer ago                  → "Xh ago" / locale string
describe('formatTimestamp', () => {
  // 2026-05-12 12:31:59.000 UTC
  const NOW_ISO = '2026-05-12T12:31:59.000Z';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('treats an ISO 8601 string with Z suffix as UTC', () => {
    // 30 seconds ago in UTC → "just now"
    expect(formatTimestamp('2026-05-12T12:31:29.000Z')).toBe('just now');
  });

  it('treats a naive "YYYY-MM-DD HH:MM:SS" string as UTC (legacy rows)', () => {
    // The naive string matches "now" → must NOT be off by the viewer's UTC
    // offset; should report "just now" regardless of where the test runs.
    expect(formatTimestamp('2026-05-12 12:31:59')).toBe('just now');
  });

  it('returns "just now" for an event under one minute old', () => {
    // 45 s before NOW
    const ts = new Date(Date.parse(NOW_ISO) - 45_000).toISOString();
    expect(formatTimestamp(ts)).toBe('just now');
  });

  it('returns "Xm ago" for an event under one hour old', () => {
    // 5 m before NOW
    const ts = new Date(Date.parse(NOW_ISO) - 5 * 60_000).toISOString();
    expect(formatTimestamp(ts)).toBe('5m ago');
  });

  it('returns "Xh ago" for an event under one day old', () => {
    // 9 h before NOW — the exact symptom reported in issue #72
    const ts = new Date(Date.parse(NOW_ISO) - 9 * 3600_000).toISOString();
    expect(formatTimestamp(ts)).toBe('9h ago');
  });

  it('falls back to a locale string for older events', () => {
    // 3 days before NOW
    const ts = new Date(Date.parse(NOW_ISO) - 3 * 86400_000).toISOString();
    const result = formatTimestamp(ts);
    expect(result).not.toMatch(/just now|ago$/);
    // The locale string is environment-dependent, but it must at least
    // mention the 2026 year — i.e. the function did parse the date, not
    // return a fallback marker.
    expect(result).toContain('2026');
  });

  it('does not double-shift an ISO string with an explicit offset', () => {
    // "12:31:59 +00:00" === NOW_ISO → "just now"
    expect(formatTimestamp('2026-05-12T12:31:59+00:00')).toBe('just now');
  });
});
