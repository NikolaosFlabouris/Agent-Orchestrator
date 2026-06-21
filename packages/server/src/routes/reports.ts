import type { FastifyInstance } from 'fastify';
import {
  getReportOverview,
  getReportTimeseries,
  getReportLeaderboard,
  getReportDurations,
  getReportFunnel,
  getReportReliability,
  getReportHeatmap,
  getReportProfileGauge,
  getReportTasks,
  getRepo,
} from '../db.js';
import { DEFAULT_REPORT_WINDOW_DAYS } from '../constants.js';
import { TASK_STATUSES } from '@orchestrator/shared';
import type {
  ReportFilter,
  LeaderboardGroupBy,
  DurationGroupBy,
  DurationMetric,
  HeatmapMetric,
  TaskStatus,
  ReportTasksSort,
  ReportTaskRow,
  ReportsTasksPage,
} from '@orchestrator/shared';
import type { ForgejoClient } from '../forgejo.js';
import { warmRepoSnapshots } from '../forgejo-snapshot.js';
import {
  enrichTaskWithDerivation,
  loadManagedContainerIds,
} from './tasks.js';

const VALID_SORTS: ReportTasksSort[] = [
  'created_desc',
  'created_asc',
  'completed_desc',
  'completed_asc',
];
const VALID_STATUSES = new Set<string>(TASK_STATUSES);

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

export function createReportsRoutes(forgejo: ForgejoClient) {
  return async function reportsRoutes(app: FastifyInstance): Promise<void> {
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

  // GET /api/reports/profile-gauge?repo=&model=&harness= — performance gauge
  // for one (repo, model, harness) combination, used inline on the Create Task
  // screen. Reuses the leaderboard aggregation narrowed to a single repo +
  // model/harness (no duplicated stats SQL). `repo`, `model`, and `harness`
  // are required — the gauge is always about a concrete combination — but the
  // common `from`/`to` window is optional and defaults like every other
  // endpoint. Auth is handled by the global hook, same as the rest.
  app.get('/api/reports/profile-gauge', async (request, reply) => {
    const query = request.query as Record<string, unknown>;

    const repoRaw = query.repo;
    const repoId =
      typeof repoRaw === 'string' ? parseInt(repoRaw, 10) : NaN;
    const model = typeof query.model === 'string' ? query.model.trim() : '';
    const harness = typeof query.harness === 'string' ? query.harness.trim() : '';

    if (!Number.isInteger(repoId) || model === '' || harness === '') {
      return reply
        .status(400)
        .send({ error: 'repo (integer), model, and harness are required' });
    }

    // Reuse the shared from/to parsing, but pin the cohort to the one repo.
    const filter = { ...parseFilter(query), repos: [repoId] };
    return getReportProfileGauge(filter, model, harness);
  });

  // GET /api/reports/heatmap?metric=created|merged — hour-of-day × day-of-week
  // activity heatmap.
  app.get('/api/reports/heatmap', async (request) => {
    const query = request.query as Record<string, unknown>;
    const filter = parseFilter(query);
    const metric: HeatmapMetric = query.metric === 'merged' ? 'merged' : 'created';
    return getReportHeatmap(filter, metric);
  });

  // GET /api/reports/tasks — paginated, filterable "All Tasks" browser over
  // the full task history. Beyond the common repos/from/to filter it accepts:
  //   - status: a single TaskStatus to narrow to (optional)
  //   - search: free-text match on issue number or title (optional)
  //   - sort:   created_desc (default) | created_asc | completed_desc | completed_asc
  //   - offset/limit: pagination (db clamps limit to a sane ceiling)
  //
  // Cost note (mirrors GET /api/tasks): the history is unbounded, so we
  // PAGINATE FIRST in SQL (getReportTasks) and only then resolve the
  // Forgejo-derived status for the returned page — warming the snapshot
  // cache one repo at a time so derivation never fans out to an N+1 of
  // Forgejo calls across the whole history.
  app.get('/api/reports/tasks', async (request) => {
    const query = request.query as Record<string, unknown>;
    const filter = parseFilter(query);

    const statusRaw =
      typeof query.status === 'string' ? query.status.trim() : '';
    const status: TaskStatus | undefined = VALID_STATUSES.has(statusRaw)
      ? (statusRaw as TaskStatus)
      : undefined;

    const search =
      typeof query.search === 'string' ? query.search.trim() : '';

    const sortRaw = typeof query.sort === 'string' ? query.sort : '';
    const sort: ReportTasksSort = VALID_SORTS.includes(sortRaw as ReportTasksSort)
      ? (sortRaw as ReportTasksSort)
      : 'created_desc';

    const offsetRaw =
      typeof query.offset === 'string' ? parseInt(query.offset, 10) : NaN;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0;

    const limitRaw =
      typeof query.limit === 'string' ? parseInt(query.limit, 10) : NaN;
    const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;

    const {
      total,
      offset: effectiveOffset,
      limit: effectiveLimit,
      tasks,
    } = getReportTasks(filter, {
      status,
      search,
      sort,
      offset,
      limit,
    });

    // Warm the Forgejo snapshot cache one repo at a time for the PAGE only,
    // then derive — exactly the pattern GET /api/tasks uses, but bounded to
    // a single page instead of the whole list.
    const managedIds = await loadManagedContainerIds(request.log);
    const tasksByRepo = new Map<number, typeof tasks>();
    for (const t of tasks) {
      const arr = tasksByRepo.get(t.repo_id);
      if (arr) arr.push(t);
      else tasksByRepo.set(t.repo_id, [t]);
    }
    await Promise.all(
      Array.from(tasksByRepo.entries()).map(async ([repoId, group]) => {
        const repo = getRepo(repoId);
        if (repo) await warmRepoSnapshots(repo, group, forgejo, request.log);
      })
    );

    const rows: ReportTaskRow[] = await Promise.all(
      tasks.map(async (t): Promise<ReportTaskRow> => {
        const enriched = await enrichTaskWithDerivation(t, forgejo, {
          managedIds,
        });
        return {
          id: t.id,
          issue_id: t.issue_id,
          issue_title: enriched.issue_title,
          repo: enriched.repo,
          pr_number: t.pr_number,
          status: enriched.status,
          runtime_status: t.status,
          attempts: t.attempts,
          max_attempts: t.max_attempts,
          model_id: t.model_id,
          harness_id: t.harness_id,
          started_at: t.started_at,
          completed_at: t.completed_at,
          created_at: t.created_at,
        };
      })
    );

    const page: ReportsTasksPage = {
      range: { from: filter.from, to: filter.to },
      repos: filter.repos,
      total,
      offset: effectiveOffset,
      limit: effectiveLimit,
      sort,
      tasks: rows,
    };
    return page;
  });
  };
}
