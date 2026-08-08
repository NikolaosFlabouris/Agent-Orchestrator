import { describe, it, expect } from 'vitest';

// The Reports filter bar's only state now lives in the query string, so these
// two functions are the whole contract for "is this view bookmarkable". They
// have to survive URLs nobody generated: hand-edited dates, a `repos` list
// pasted with a stray comma, a truncated share link. Anything they can't read
// must degrade to the default view rather than reaching the API as nonsense.

const { parseReportParams, serializeReportParams, isReportDataStale } =
  await import('../views/Reports.js');

const FALLBACK = { from: '2026-03-01', to: '2026-05-30' };

function parse(query: string) {
  return parseReportParams(new URLSearchParams(query), FALLBACK);
}

describe('parseReportParams', () => {
  it('reads a full query string', () => {
    expect(parse('from=2026-01-01&to=2026-02-01&repos=1,3')).toEqual({
      from: '2026-01-01',
      to: '2026-02-01',
      repos: [1, 3],
    });
  });

  it('falls back to the default window when params are absent', () => {
    expect(parse('')).toEqual({ ...FALLBACK, repos: [] });
  });

  it('falls back per date, so one bad bound does not lose the other', () => {
    expect(parse('from=2026-01-01&to=lolwut')).toEqual({
      from: '2026-01-01',
      to: FALLBACK.to,
      repos: [],
    });
  });

  it('rejects dates that are not YYYY-MM-DD', () => {
    // `Date.parse` accepts all of these; the API does not read them the way
    // the operator would expect, so they must not survive parsing.
    for (const bad of ['2026', '2026-01', 'Jan 5 2026', '2026-01-01T12:00:00Z']) {
      expect(parse(`from=${encodeURIComponent(bad)}`).from).toBe(FALLBACK.from);
    }
  });

  it('rejects impossible calendar dates', () => {
    expect(parse('from=2026-13-45').from).toBe(FALLBACK.from);
  });

  it('drops non-numeric, zero, negative and exponent repo ids', () => {
    expect(parse('repos=1,abc,,3,0,-2,1e3,2.5').repos).toEqual([1, 3]);
  });

  it('treats an all-junk repo list as "all repos"', () => {
    expect(parse('repos=abc,,-1').repos).toEqual([]);
  });

  it('dedupes repeated repo ids', () => {
    expect(parse('repos=3,1,3').repos).toEqual([3, 1]);
  });
});

describe('serializeReportParams', () => {
  it('round-trips a filtered state', () => {
    const state = { from: '2026-01-01', to: '2026-02-01', repos: [1, 3] };
    const round = parseReportParams(serializeReportParams(state), FALLBACK);
    expect(round).toEqual(state);
  });

  it('round-trips the all-repos state', () => {
    const state = { from: '2026-01-01', to: '2026-02-01', repos: [] };
    const round = parseReportParams(serializeReportParams(state), FALLBACK);
    expect(round).toEqual(state);
  });

  it('writes the documented shape', () => {
    expect(
      serializeReportParams({
        from: '2026-01-01',
        to: '2026-02-01',
        repos: [1, 3],
      }).toString()
    ).toBe('from=2026-01-01&to=2026-02-01&repos=1%2C3');
  });

  it('omits repos entirely when all repos are selected', () => {
    const params = serializeReportParams({
      from: '2026-01-01',
      to: '2026-02-01',
      repos: [],
    });
    expect(params.has('repos')).toBe(false);
  });

  it('never writes a date its own parser would reject', () => {
    // A cleared `<input type="date">` reports '' — that must leave the URL
    // clean and let the default window take over, not park `from=` in it.
    const params = serializeReportParams({
      from: '',
      to: '2026-02-01',
      repos: [],
    });
    expect(params.has('from')).toBe(false);
    expect(parseReportParams(params, FALLBACK).from).toBe(FALLBACK.from);
  });
});

describe('isReportDataStale', () => {
  it('is false while the data on screen is under a minute old', () => {
    expect(isReportDataStale(1_000, 1_000 + 59_000)).toBe(false);
  });

  it('is true at and past the minute mark', () => {
    expect(isReportDataStale(1_000, 1_000 + 60_000)).toBe(true);
    expect(isReportDataStale(1_000, 1_000 + 600_000)).toBe(true);
  });

  it('treats "never fetched" as stale so a failed first load retries', () => {
    expect(isReportDataStale(0, Date.now())).toBe(true);
  });
});
