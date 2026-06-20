import type { FastifyInstance } from 'fastify';
import {
  getReportOverview,
  getReportTimeseries,
  getReportLeaderboard,
  getReportDurations,
  getReportFunnel,
  getReportReliability,
  getReportHeatmap,
} from '../db.js';
import { DEFAULT_REPORT_WINDOW_DAYS } from '../constants.js';
import type {
  ReportFilter,
  LeaderboardGroupBy,
  DurationGroupBy,
  DurationMetric,
  HeatmapMetric,
} from '@orchestrator/shared';

/** Reports API (read-only aggregates).
 *
 *  These endpoints roll up the orchestrator's task/attempt/event history
 *  into KPI summaries, time series, and per-group leaderboards to inform
 *  model/harness/repo assignment. They live under `/api/*`, so the global
 *  auth hook in auth.ts guards them exactly like every other route module —
 *  no per-route auth is added here.
 *
 *  All aggregation runs in SQL (see db.ts getReport*); the handlers only
 *  parse the common filter and serialise typed JSON.
 */

const MS_PER_DAY = 86_400_000;

/** Parse the common `repos`/`from`/`to` filter shared by every endpoint.
 *  - `repos`: comma-separated repo ids; omitted/empty = all repos (null).
 *  - `from` (inclusive) / `to` (exclusive): ISO date bounds; defaults to
 *    the last DEFAULT_REPORT_WINDOW_DAYS up to now. Invalid values fall back
 *    to the defaults rather than erroring — the endpoints are a best-effort
 *    gauge, not a strict query API. */
function parseFilter(query: Record<string, unknown>): ReportFilter {
  const now = Date.now();

  const toRaw = typeof query.to === 'string' ? Date.parse(query.to) : NaN;
  const to = Number.isNaN(toRaw) ? now : toRaw;

  const fromRaw = typeof query.from === 'string' ? Date.parse(query.from) : NaN;
  const fromDefault = to - DEFAULT_REPORT_WINDOW_DAYS * MS_PER_DAY;
  let from = Number.isNaN(fromRaw) ? fromDefault : fromRaw;
  // Defensive: never let from exceed to (would yield an empty, confusing set).
  if (from > to) from = fromDefault;

  let repos: number[] | null = null;
  if (typeof query.repos === 'string' && query.repos.trim() !== '') {
    const ids = query.repos
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n));
    if (ids.length > 0) repos = ids;
  }

  return {
    repos,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
  };
}

export async function reportsRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/reports/overview — KPI roll-up.
  app.get('/api/reports/overview', async (request) => {
    const filter = parseFilter(request.query as Record<string, unknown>);
    return getReportOverview(filter);
  });

  // GET /api/reports/timeseries?bucket=day|week — created/merged per bucket.
  app.get('/api/reports/timeseries', async (request) => {
    const query = request.query as Record<string, unknown>;
    const filter = parseFilter(query);
    const bucket = query.bucket === 'week' ? 'week' : 'day';
    return getReportTimeseries(filter, bucket);
  });

  // GET /api/reports/leaderboard?groupBy=model|harness|repo — per-group stats.
  app.get('/api/reports/leaderboard', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const filter = parseFilter(query);
    const raw = query.groupBy;
    const allowed: LeaderboardGroupBy[] = ['model', 'harness', 'repo'];
    if (typeof raw !== 'string' || !allowed.includes(raw as LeaderboardGroupBy)) {
      return reply
        .status(400)
        .send({ error: 'groupBy must be one of: model, harness, repo' });
    }
    return getReportLeaderboard(filter, raw as LeaderboardGroupBy);
  });

  // GET /api/reports/durations?groupBy=model|harness&metric=implementation|review
  // — per-group p50/p90/p99 + min/max/avg duration distribution.
  app.get('/api/reports/durations', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const filter = parseFilter(query);

    const groupRaw = query.groupBy;
    const groups: DurationGroupBy[] = ['model', 'harness'];
    if (typeof groupRaw !== 'string' || !groups.includes(groupRaw as DurationGroupBy)) {
      return reply
        .status(400)
        .send({ error: 'groupBy must be one of: model, harness' });
    }

    const metricRaw = query.metric;
    const metrics: DurationMetric[] = ['implementation', 'review'];
    if (typeof metricRaw !== 'string' || !metrics.includes(metricRaw as DurationMetric)) {
      return reply
        .status(400)
        .send({ error: 'metric must be one of: implementation, review' });
    }

    return getReportDurations(
      filter,
      groupRaw as DurationGroupBy,
      metricRaw as DurationMetric
    );
  });

  // GET /api/reports/funnel — created→preparing→in-progress→in-review→merged
  // lifecycle funnel with counts and conversion percentages.
  app.get('/api/reports/funnel', async (request) => {
    const filter = parseFilter(request.query as Record<string, unknown>);
    return getReportFunnel(filter);
  });

  // GET /api/reports/reliability?bucket=day|week — operational-incidence
  // counts, time-series, and per-repo breakdown.
  app.get('/api/reports/reliability', async (request) => {
    const query = request.query as Record<string, unknown>;
    const filter = parseFilter(query);
    const bucket = query.bucket === 'week' ? 'week' : 'day';
    return getReportReliability(filter, bucket);
  });

  // GET /api/reports/heatmap?metric=created|merged — hour-of-day × day-of-week
  // activity heatmap.
  app.get('/api/reports/heatmap', async (request) => {
    const query = request.query as Record<string, unknown>;
    const filter = parseFilter(query);
    const metric: HeatmapMetric = query.metric === 'merged' ? 'merged' : 'created';
    return getReportHeatmap(filter, metric);
  });
}
