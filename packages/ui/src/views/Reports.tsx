import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  Cell,
} from 'recharts';
import { api } from '../api.js';
import type { ReportQuery, RepoResponse } from '../api.js';
import type {
  ReportsOverview,
  ReportsTimeseries,
  ReportsLeaderboard,
  ReportsDurations,
  ReportsFunnel,
  ReportsReliability,
  ReportsHeatmap,
  DurationMetric,
  LeaderboardRow,
  TaskStatus,
} from '@orchestrator/shared';
import { AppHeader } from '../components/AppHeader.js';
import { KpiCard } from '../components/KpiCard.js';
import { ChartCard } from '../components/ChartCard.js';
import { DurationDistributionChart } from '../components/DurationDistributionChart.js';
import { FunnelChart } from '../components/FunnelChart.js';
import { ActivityHeatmap } from '../components/ActivityHeatmap.js';
import {
  formatDuration,
  formatPercent,
  formatNumber,
  formatRework,
  formatTokens,
  formatTurns,
  formatChurn,
} from '../components/reportFormat.js';
import { defaultRange, previousRange } from '../components/reportFilter.js';
import {
  downloadFile,
  toCsv,
  toJson,
  type ReportExportData,
} from '../components/reportExport.js';

/** Default window matches the backend's DEFAULT_REPORT_WINDOW_DAYS so the
 *  page opens on the same range the API would pick when given no bounds. */
const DEFAULT_WINDOW_DAYS = 90;

const COLORS = {
  created: '#60a5fa',
  merged: '#4ade80',
  grid: '#1f2937',
  axis: '#6b7280',
  approved: '#4ade80',
  changes: '#fbbf24',
  unclear: '#9ca3af',
};

const TOOLTIP_STYLE = {
  backgroundColor: '#111827',
  border: '1px solid #374151',
  borderRadius: '0.375rem',
  color: '#e5e7eb',
  fontSize: '0.75rem',
};

interface ReportBundle {
  overview: ReportsOverview;
  prevOverview: ReportsOverview | null;
  timeseries: ReportsTimeseries;
  modelBoard: ReportsLeaderboard;
  harnessBoard: ReportsLeaderboard;
  repoBoard: ReportsLeaderboard;
  durationsImpl: ReportsDurations;
  durationsReview: ReportsDurations;
  funnel: ReportsFunnel;
  reliability: ReportsReliability;
  heatmap: ReportsHeatmap;
}

export function Reports() {
  const [repos, setRepos] = useState<RepoResponse[]>([]);
  const [selectedRepoIds, setSelectedRepoIds] = useState<number[]>([]);
  const initialRange = useMemo(() => defaultRange(DEFAULT_WINDOW_DAYS), []);
  const [from, setFrom] = useState(initialRange.from);
  const [to, setTo] = useState(initialRange.to);
  const [bucket, setBucket] = useState<'day' | 'week'>('day');
  const [boardGroup, setBoardGroup] = useState<'model' | 'harness'>('model');
  const [distGroup, setDistGroup] = useState<'model' | 'harness'>('model');
  const [distMetric, setDistMetric] = useState<DurationMetric>('implementation');
  const [heatmapMetric, setHeatmapMetric] = useState<'created' | 'merged'>(
    'created'
  );

  const [data, setData] = useState<ReportBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Repo list for the filter chips + per-row labels. Fetched once.
  useEffect(() => {
    api
      .getRepos()
      .then((res) => setRepos(res.repos))
      .catch(() => {});
  }, []);

  const repoKey = selectedRepoIds.join(',');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const filter: ReportQuery = {
      repos: selectedRepoIds.length > 0 ? selectedRepoIds : undefined,
      from,
      to,
    };
    const prev = previousRange(from, to);

    Promise.all([
      api.getReportOverview(filter),
      prev
        ? api.getReportOverview({ ...filter, from: prev.from, to: prev.to })
        : Promise.resolve(null),
      api.getReportTimeseries(filter, bucket),
      api.getReportLeaderboard('model', filter),
      api.getReportLeaderboard('harness', filter),
      api.getReportLeaderboard('repo', filter),
      // Fetch BOTH duration metrics at the current grouping so the
      // metric toggle is client-side; only the grouping toggle refetches.
      api.getReportDurations(distGroup, 'implementation', filter),
      api.getReportDurations(distGroup, 'review', filter),
      api.getReportFunnel(filter),
      api.getReportReliability(filter, bucket),
      api.getReportHeatmap(heatmapMetric, filter),
    ])
      .then(
        ([
          overview,
          prevOverview,
          timeseries,
          modelBoard,
          harnessBoard,
          repoBoard,
          durationsImpl,
          durationsReview,
          funnel,
          reliability,
          heatmap,
        ]) => {
          if (cancelled) return;
          setData({
            overview,
            prevOverview,
            timeseries,
            modelBoard,
            harnessBoard,
            repoBoard,
            durationsImpl,
            durationsReview,
            funnel,
            reliability,
            heatmap,
          });
          setLoading(false);
        }
      )
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to load reports');
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // repoKey stands in for the selectedRepoIds array identity.
  }, [from, to, repoKey, bucket, distGroup, heatmapMetric]);

  const toggleRepo = (id: number) => {
    setSelectedRepoIds((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]
    );
  };

  const handleExport = (kind: 'csv' | 'json') => {
    if (!data) return;
    const exportData: ReportExportData = {
      filter: { repos: selectedRepoIds.length ? selectedRepoIds : null, from, to },
      overview: data.overview,
      leaderboards: [data.modelBoard, data.harnessBoard, data.repoBoard],
      reliability: data.reliability,
      durations: [data.durationsImpl, data.durationsReview],
    };
    const stamp = `${from}_${to}`;
    if (kind === 'csv') {
      downloadFile(`reports_${stamp}.csv`, toCsv(exportData), 'text/csv');
    } else {
      downloadFile(
        `reports_${stamp}.json`,
        toJson(exportData),
        'application/json'
      );
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <AppHeader
        back={
          <Link to="/" className="text-blue-400 hover:text-blue-300 text-sm">
            &larr; Dashboard
          </Link>
        }
        title="Reports"
        meta={
          <p className="text-xs text-gray-500">
            A pragmatic gauge of model, harness, and repo performance.
          </p>
        }
      >
        <button
          onClick={() => handleExport('csv')}
          disabled={!data}
          className="rounded bg-gray-800 px-3 py-1 text-xs font-medium text-gray-200 hover:bg-gray-700 disabled:opacity-40"
        >
          Export CSV
        </button>
        <button
          onClick={() => handleExport('json')}
          disabled={!data}
          className="rounded bg-gray-800 px-3 py-1 text-xs font-medium text-gray-200 hover:bg-gray-700 disabled:opacity-40"
        >
          Export JSON
        </button>
        <Link to="/settings" className="text-blue-400 hover:text-blue-300 text-sm">
          Settings
        </Link>
      </AppHeader>

      <FilterBar
        repos={repos}
        selectedRepoIds={selectedRepoIds}
        onToggleRepo={toggleRepo}
        onClearRepos={() => setSelectedRepoIds([])}
        from={from}
        to={to}
        onFromChange={setFrom}
        onToChange={setTo}
      />

      <main className="mx-auto max-w-7xl px-6 py-6 space-y-6">
        {error && (
          <div className="rounded border border-red-900 bg-red-950 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {loading && !data ? (
          <p className="text-sm text-gray-500">Loading reports…</p>
        ) : data ? (
          <>
            <KpiRow overview={data.overview} prev={data.prevOverview} timeseries={data.timeseries} />

            <ThroughputChart
              timeseries={data.timeseries}
              bucket={bucket}
              onBucketChange={setBucket}
            />

            <div className="grid gap-6 lg:grid-cols-2">
              <StatusBreakdown overview={data.overview} />
              <VerdictBreakdown board={data.modelBoard} />
            </div>

            <LeaderboardSection
              board={boardGroup === 'model' ? data.modelBoard : data.harnessBoard}
              group={boardGroup}
              onGroupChange={setBoardGroup}
            />

            <DurationDistributionSection
              durations={
                distMetric === 'implementation'
                  ? data.durationsImpl
                  : data.durationsReview
              }
              group={distGroup}
              onGroupChange={setDistGroup}
              metric={distMetric}
              onMetricChange={setDistMetric}
            />

            <div className="grid gap-6 lg:grid-cols-2">
              <LifecycleFunnelSection funnel={data.funnel} />
              <ActivityHeatmapSection
                heatmap={data.heatmap}
                metric={heatmapMetric}
                onMetricChange={setHeatmapMetric}
              />
            </div>

            <ReliabilitySection
              reliability={data.reliability}
              bucket={bucket}
              repos={repos}
            />

            <RepoScorecard board={data.repoBoard} />
          </>
        ) : null}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

function FilterBar({
  repos,
  selectedRepoIds,
  onToggleRepo,
  onClearRepos,
  from,
  to,
  onFromChange,
  onToChange,
}: {
  repos: RepoResponse[];
  selectedRepoIds: number[];
  onToggleRepo: (id: number) => void;
  onClearRepos: () => void;
  from: string;
  to: string;
  onFromChange: (v: string) => void;
  onToChange: (v: string) => void;
}) {
  return (
    <div className="border-b border-gray-800 bg-gray-900/60 px-6 py-3">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-xs uppercase tracking-wide text-gray-500">From</span>
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => onFromChange(e.target.value)}
            className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-gray-200"
          />
          <span className="text-xs uppercase tracking-wide text-gray-500">To</span>
          <input
            type="date"
            value={to}
            min={from}
            onChange={(e) => onToChange(e.target.value)}
            className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-gray-200"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-gray-500">Repos</span>
          <button
            onClick={onClearRepos}
            className={`rounded px-2 py-1 text-xs font-medium ${
              selectedRepoIds.length === 0
                ? 'bg-blue-900 text-blue-200'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
            }`}
          >
            All
          </button>
          {repos.map((r) => {
            const active = selectedRepoIds.includes(r.id);
            return (
              <button
                key={r.id}
                onClick={() => onToggleRepo(r.id)}
                className={`rounded px-2 py-1 text-xs font-medium ${
                  active
                    ? 'bg-blue-900 text-blue-200'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                }`}
                title={`${r.owner}/${r.name}`}
              >
                {r.owner}/{r.name}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPI row
// ---------------------------------------------------------------------------

function KpiRow({
  overview,
  prev,
  timeseries,
}: {
  overview: ReportsOverview;
  prev: ReportsOverview | null;
  timeseries: ReportsTimeseries;
}) {
  const mergedSpark = timeseries.series.map((b) => b.tasks_merged);
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
      <KpiCard
        label="Tasks merged"
        value={overview.throughput.tasks_merged}
        previous={prev?.throughput.tasks_merged}
        format={formatNumber}
        polarity="higher-good"
        sparkline={mergedSpark}
      />
      <KpiCard
        label="Success rate"
        value={overview.success_rate}
        previous={prev?.success_rate ?? null}
        format={(v) => formatPercent(v)}
        polarity="higher-good"
      />
      <KpiCard
        label="Avg lead time"
        value={overview.lead_time.avg_seconds}
        previous={prev?.lead_time.avg_seconds ?? null}
        format={formatDuration}
        polarity="lower-good"
      />
      <KpiCard
        label="Avg impl time"
        value={overview.implementation_duration.avg_seconds}
        previous={prev?.implementation_duration.avg_seconds ?? null}
        format={formatDuration}
        polarity="lower-good"
      />
      <KpiCard
        label="Avg review time"
        value={overview.review_duration.avg_seconds}
        previous={prev?.review_duration.avg_seconds ?? null}
        format={formatDuration}
        polarity="lower-good"
      />
      <KpiCard
        label="Backlog"
        value={overview.backlog.queued}
        format={formatNumber}
        polarity="lower-good"
        sub={
          overview.backlog.blocked > 0
            ? `${overview.backlog.blocked} blocked · point-in-time`
            : 'point-in-time'
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Throughput time-series
// ---------------------------------------------------------------------------

function ThroughputChart({
  timeseries,
  bucket,
  onBucketChange,
}: {
  timeseries: ReportsTimeseries;
  bucket: 'day' | 'week';
  onBucketChange: (b: 'day' | 'week') => void;
}) {
  const empty =
    timeseries.series.length === 0 ||
    timeseries.series.every(
      (b) => b.tasks_created === 0 && b.tasks_merged === 0
    );

  return (
    <ChartCard
      title="Throughput — created vs merged"
      actions={
        <Toggle
          options={[
            { value: 'day', label: 'Day' },
            { value: 'week', label: 'Week' },
          ]}
          value={bucket}
          onChange={(v) => onBucketChange(v as 'day' | 'week')}
        />
      }
      empty={empty}
    >
      <ResponsiveContainer width="100%" height={260}>
        <AreaChart data={timeseries.series} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
          <defs>
            <linearGradient id="gCreated" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={COLORS.created} stopOpacity={0.4} />
              <stop offset="95%" stopColor={COLORS.created} stopOpacity={0} />
            </linearGradient>
            <linearGradient id="gMerged" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={COLORS.merged} stopOpacity={0.4} />
              <stop offset="95%" stopColor={COLORS.merged} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={COLORS.grid} vertical={false} />
          <XAxis dataKey="bucket" stroke={COLORS.axis} fontSize={11} tickLine={false} />
          <YAxis stroke={COLORS.axis} fontSize={11} tickLine={false} allowDecimals={false} />
          <Tooltip contentStyle={TOOLTIP_STYLE} />
          <Legend wrapperStyle={{ fontSize: '0.75rem' }} />
          <Area
            type="monotone"
            dataKey="tasks_created"
            name="Created"
            stroke={COLORS.created}
            fill="url(#gCreated)"
            strokeWidth={2}
          />
          <Area
            type="monotone"
            dataKey="tasks_merged"
            name="Merged"
            stroke={COLORS.merged}
            fill="url(#gMerged)"
            strokeWidth={2}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

// ---------------------------------------------------------------------------
// Status + verdict breakdowns
// ---------------------------------------------------------------------------

const STATUS_COLORS: Partial<Record<TaskStatus, string>> = {
  merged: '#4ade80',
  failed: '#f87171',
  cancelled: '#6b7280',
  queued: '#fbbf24',
  'in-progress': '#60a5fa',
  'in-review': '#a78bfa',
  'changes-needed': '#fb923c',
  preparing: '#9ca3af',
  'awaiting-human-merge': '#f59e0b',
  'awaiting-human-review': '#f59e0b',
  'needs-human-review': '#f59e0b',
  reset: '#6b7280',
};

function StatusBreakdown({ overview }: { overview: ReportsOverview }) {
  const rows = (Object.entries(overview.status_counts) as [TaskStatus, number][])
    .filter(([, count]) => count > 0)
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count);

  return (
    <ChartCard title="Status breakdown" empty={rows.length === 0}>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={rows} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid stroke={COLORS.grid} vertical={false} />
          <XAxis dataKey="status" stroke={COLORS.axis} fontSize={10} tickLine={false} interval={0} angle={-25} textAnchor="end" height={60} />
          <YAxis stroke={COLORS.axis} fontSize={11} tickLine={false} allowDecimals={false} />
          <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
          <Bar dataKey="count" name="Tasks" radius={[2, 2, 0, 0]}>
            {rows.map((r) => (
              <Cell key={r.status} fill={STATUS_COLORS[r.status] ?? '#6b7280'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

function VerdictBreakdown({ board }: { board: ReportsLeaderboard }) {
  const totals = board.rows.reduce(
    (acc, r) => {
      acc.approved += r.verdicts.approved;
      acc.changes_needed += r.verdicts.changes_needed;
      acc.unclear += r.verdicts.unclear;
      return acc;
    },
    { approved: 0, changes_needed: 0, unclear: 0 }
  );
  const rows = [
    { verdict: 'Approved', count: totals.approved, color: COLORS.approved },
    { verdict: 'Changes', count: totals.changes_needed, color: COLORS.changes },
    { verdict: 'Unclear', count: totals.unclear, color: COLORS.unclear },
  ];
  const empty = rows.every((r) => r.count === 0);

  return (
    <ChartCard title="Review verdicts" empty={empty}>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={rows} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid stroke={COLORS.grid} vertical={false} />
          <XAxis dataKey="verdict" stroke={COLORS.axis} fontSize={11} tickLine={false} />
          <YAxis stroke={COLORS.axis} fontSize={11} tickLine={false} allowDecimals={false} />
          <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
          <Bar dataKey="count" name="Reviews" radius={[2, 2, 0, 0]}>
            {rows.map((r) => (
              <Cell key={r.verdict} fill={r.color} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

// ---------------------------------------------------------------------------
// Leaderboard table (sortable)
// ---------------------------------------------------------------------------

type SortKey =
  | 'label'
  | 'task_count'
  | 'success_rate'
  | 'avg_implementation_seconds'
  | 'avg_review_seconds'
  | 'avg_rework'
  | 'avg_num_turns'
  | 'avg_total_tokens'
  | 'avg_total_churn';

interface ColumnDef {
  key: SortKey;
  label: string;
  numeric: boolean;
  render: (r: LeaderboardRow) => string;
}

const LEADERBOARD_COLUMNS: ColumnDef[] = [
  { key: 'label', label: 'Name', numeric: false, render: (r) => r.label },
  { key: 'task_count', label: 'Tasks', numeric: true, render: (r) => formatNumber(r.task_count) },
  { key: 'success_rate', label: 'Success', numeric: true, render: (r) => formatPercent(r.success_rate) },
  { key: 'avg_implementation_seconds', label: 'Avg impl', numeric: true, render: (r) => formatDuration(r.avg_implementation_seconds) },
  { key: 'avg_review_seconds', label: 'Avg review', numeric: true, render: (r) => formatDuration(r.avg_review_seconds) },
  { key: 'avg_rework', label: 'Rework', numeric: true, render: (r) => formatRework(r.avg_rework) },
  { key: 'avg_num_turns', label: 'Avg turns', numeric: true, render: (r) => formatTurns(r.avg_num_turns) },
  { key: 'avg_total_tokens', label: 'Avg tokens', numeric: true, render: (r) => formatTokens(r.avg_total_tokens) },
  {
    key: 'avg_total_churn',
    label: 'Avg churn',
    numeric: true,
    render: (r) =>
      r.avg_total_churn == null
        ? '—'
        : `${formatNumber(Math.round(r.avg_total_churn))} (+${formatChurn(r.avg_additions)}/-${formatChurn(r.avg_deletions)})`,
  },
];

function sortRows(
  rows: LeaderboardRow[],
  key: SortKey,
  dir: 'asc' | 'desc'
): LeaderboardRow[] {
  const factor = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key === 'label') return factor * a.label.localeCompare(b.label);
    const av = a[key] as number | null;
    const bv = b[key] as number | null;
    // Nulls always sort to the bottom regardless of direction.
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return factor * (av - bv);
  });
}

function LeaderboardSection({
  board,
  group,
  onGroupChange,
}: {
  board: ReportsLeaderboard;
  group: 'model' | 'harness';
  onGroupChange: (g: 'model' | 'harness') => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>('task_count');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const sorted = useMemo(
    () => sortRows(board.rows, sortKey, sortDir),
    [board.rows, sortKey, sortDir]
  );

  const onSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      // Strings default to A→Z, numbers to high→low.
      setSortDir(key === 'label' ? 'asc' : 'desc');
    }
  };

  return (
    <ChartCard
      title="Model & harness leaderboard"
      actions={
        <Toggle
          options={[
            { value: 'model', label: 'By model' },
            { value: 'harness', label: 'By harness' },
          ]}
          value={group}
          onChange={(v) => onGroupChange(v as 'model' | 'harness')}
        />
      }
      empty={board.rows.length === 0}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-left text-xs uppercase tracking-wide text-gray-500">
              {LEADERBOARD_COLUMNS.map((col) => (
                <th
                  key={col.key}
                  className={`cursor-pointer py-2 pr-4 font-medium select-none hover:text-gray-300 ${
                    col.numeric ? 'text-right' : ''
                  }`}
                  onClick={() => onSort(col.key)}
                >
                  {col.label}
                  {sortKey === col.key && (
                    <span className="ml-1">{sortDir === 'asc' ? '▲' : '▼'}</span>
                  )}
                </th>
              ))}
              <th className="py-2 pr-4 font-medium">Verdicts</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={row.key} className="border-b border-gray-800/50 last:border-0">
                {LEADERBOARD_COLUMNS.map((col) => (
                  <td
                    key={col.key}
                    className={`py-2 pr-4 ${
                      col.numeric ? 'text-right tabular-nums text-gray-300' : 'font-mono text-gray-200'
                    }`}
                  >
                    {col.render(row)}
                  </td>
                ))}
                <td className="py-2 pr-4">
                  <VerdictBar verdicts={row.verdicts} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartCard>
  );
}

function VerdictBar({
  verdicts,
}: {
  verdicts: LeaderboardRow['verdicts'];
}) {
  const total =
    verdicts.approved + verdicts.changes_needed + verdicts.unclear;
  if (total === 0) return <span className="text-xs text-gray-600">—</span>;
  const seg = (count: number, color: string, label: string) =>
    count > 0 ? (
      <div
        style={{ width: `${(count / total) * 100}%`, backgroundColor: color }}
        title={`${label}: ${count}`}
        className="h-full"
      />
    ) : null;
  return (
    <div
      className="flex h-3 w-28 overflow-hidden rounded bg-gray-800"
      title={`approved ${verdicts.approved} · changes ${verdicts.changes_needed} · unclear ${verdicts.unclear}`}
    >
      {seg(verdicts.approved, COLORS.approved, 'Approved')}
      {seg(verdicts.changes_needed, COLORS.changes, 'Changes needed')}
      {seg(verdicts.unclear, COLORS.unclear, 'Unclear')}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-repo scorecard
// ---------------------------------------------------------------------------

function RepoScorecard({ board }: { board: ReportsLeaderboard }) {
  return (
    <ChartCard title="Per-repo scorecard" empty={board.rows.length === 0}>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {board.rows.map((row) => (
          <div
            key={row.key}
            className="rounded-lg border border-gray-800 bg-gray-950 p-4"
          >
            <div className="mb-3 truncate font-mono text-sm text-gray-200" title={row.label}>
              {row.label}
            </div>
            <dl className="grid grid-cols-2 gap-y-2 text-sm">
              <ScoreStat label="Throughput" value={formatNumber(row.task_count)} />
              <ScoreStat label="Success" value={formatPercent(row.success_rate)} />
              <ScoreStat label="Avg impl" value={formatDuration(row.avg_implementation_seconds)} />
              <ScoreStat label="Avg review" value={formatDuration(row.avg_review_seconds)} />
            </dl>
          </div>
        ))}
      </div>
    </ChartCard>
  );
}

function ScoreStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="text-gray-200">{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Duration distribution (percentile bars)
// ---------------------------------------------------------------------------

function DurationDistributionSection({
  durations,
  group,
  onGroupChange,
  metric,
  onMetricChange,
}: {
  durations: ReportsDurations;
  group: 'model' | 'harness';
  onGroupChange: (g: 'model' | 'harness') => void;
  metric: DurationMetric;
  onMetricChange: (m: DurationMetric) => void;
}) {
  const empty = durations.groups.length === 0;
  return (
    <ChartCard
      title={`${metric === 'implementation' ? 'Implementation' : 'Review'} duration distribution`}
      actions={
        <>
          <Toggle
            options={[
              { value: 'implementation', label: 'Impl' },
              { value: 'review', label: 'Review' },
            ]}
            value={metric}
            onChange={(v) => onMetricChange(v as DurationMetric)}
          />
          <Toggle
            options={[
              { value: 'model', label: 'By model' },
              { value: 'harness', label: 'By harness' },
            ]}
            value={group}
            onChange={(v) => onGroupChange(v as 'model' | 'harness')}
          />
        </>
      }
      empty={empty}
      emptyLabel="No completed attempts in this range"
    >
      <DurationDistributionChart groups={durations.groups} />
    </ChartCard>
  );
}

// ---------------------------------------------------------------------------
// Lifecycle funnel
// ---------------------------------------------------------------------------

function LifecycleFunnelSection({ funnel }: { funnel: ReportsFunnel }) {
  const empty = (funnel.stages[0]?.count ?? 0) === 0;
  return (
    <ChartCard title="Lifecycle funnel" empty={empty}>
      <FunnelChart stages={funnel.stages} />
    </ChartCard>
  );
}

// ---------------------------------------------------------------------------
// Activity heatmap
// ---------------------------------------------------------------------------

function ActivityHeatmapSection({
  heatmap,
  metric,
  onMetricChange,
}: {
  heatmap: ReportsHeatmap;
  metric: 'created' | 'merged';
  onMetricChange: (m: 'created' | 'merged') => void;
}) {
  return (
    <ChartCard
      title="Activity heatmap — hour × day (UTC)"
      actions={
        <Toggle
          options={[
            { value: 'created', label: 'Created' },
            { value: 'merged', label: 'Merged' },
          ]}
          value={metric}
          onChange={(v) => onMetricChange(v as 'created' | 'merged')}
        />
      }
      empty={heatmap.cells.length === 0}
    >
      <ActivityHeatmap cells={heatmap.cells} max={heatmap.max} />
    </ChartCard>
  );
}

// ---------------------------------------------------------------------------
// Reliability / ops panel
// ---------------------------------------------------------------------------

const RELIABILITY_METRICS: Array<{
  key: keyof ReportsReliability['series'][number] & string;
  label: string;
  color: string;
}> = [
  { key: 'timeout_kills', label: 'Timeout kills', color: '#f87171' },
  { key: 'orphans_detected', label: 'Orphans detected', color: '#fbbf24' },
  { key: 'orphans_recovered', label: 'Orphans recovered', color: '#4ade80' },
  { key: 'orphans_exhausted', label: 'Recovery exhausted', color: '#fb923c' },
  { key: 'review_deferrals', label: 'Review deferrals', color: '#a78bfa' },
];

function ReliabilitySection({
  reliability,
  bucket,
  repos,
}: {
  reliability: ReportsReliability;
  bucket: 'day' | 'week';
  repos: RepoResponse[];
}) {
  const { counts, series, by_repo } = reliability;
  const tiles = [
    { label: 'Timeout kills', value: counts.timeout_kills },
    { label: 'Orphans detected', value: counts.orphans_detected },
    { label: 'Orphans recovered', value: counts.orphans_recovered },
    { label: 'Recovery exhausted', value: counts.orphans_exhausted },
    { label: 'Prep failures', value: counts.prep_failures },
    { label: 'Review deferrals', value: counts.review_deferrals },
  ];
  const totalIncidents =
    counts.timeout_kills +
    counts.orphans_detected +
    counts.orphans_recovered +
    counts.orphans_exhausted +
    counts.prep_failures +
    counts.review_deferrals;
  const seriesEmpty = series.every((b) =>
    RELIABILITY_METRICS.every((m) => (b[m.key] as number) === 0)
  );

  // Repo label lookup for the breakdown table (the endpoint already labels
  // rows, but fall back through the fetched repo list defensively).
  const repoLabel = (key: string, fallback: string): string => {
    const r = repos.find((x) => String(x.id) === key);
    return r ? `${r.owner}/${r.name}` : fallback;
  };

  return (
    <ChartCard
      title="Reliability & ops"
      empty={totalIncidents === 0}
      emptyLabel="No operational incidents in this range"
    >
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {tiles.map((t) => (
            <div
              key={t.label}
              className="rounded-lg border border-gray-800 bg-gray-950 px-3 py-2"
            >
              <div className="text-xs uppercase tracking-wide text-gray-500">
                {t.label}
              </div>
              <div className="mt-1 text-xl font-semibold tabular-nums text-gray-100">
                {formatNumber(t.value)}
              </div>
            </div>
          ))}
        </div>

        <div>
          <div className="mb-2 text-xs uppercase tracking-wide text-gray-500">
            Incidence over time ({bucket})
          </div>
          {seriesEmpty ? (
            <div className="flex h-32 items-center justify-center text-sm text-gray-600">
              No timestamped incidents in this range
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart
                data={series}
                margin={{ top: 8, right: 8, left: -16, bottom: 0 }}
              >
                <CartesianGrid stroke={COLORS.grid} vertical={false} />
                <XAxis
                  dataKey="bucket"
                  stroke={COLORS.axis}
                  fontSize={11}
                  tickLine={false}
                />
                <YAxis
                  stroke={COLORS.axis}
                  fontSize={11}
                  tickLine={false}
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                />
                <Legend wrapperStyle={{ fontSize: '0.75rem' }} />
                {RELIABILITY_METRICS.map((m) => (
                  <Bar
                    key={m.key}
                    dataKey={m.key}
                    name={m.label}
                    stackId="incidents"
                    fill={m.color}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {by_repo.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-left text-xs uppercase tracking-wide text-gray-500">
                  <th className="py-2 pr-4 font-medium">Repo</th>
                  <th className="py-2 pr-4 text-right font-medium">Timeout</th>
                  <th className="py-2 pr-4 text-right font-medium">Detected</th>
                  <th className="py-2 pr-4 text-right font-medium">Recovered</th>
                  <th className="py-2 pr-4 text-right font-medium">Exhausted</th>
                  <th className="py-2 pr-4 text-right font-medium">Prep fail</th>
                  <th className="py-2 pr-4 text-right font-medium">Deferred</th>
                </tr>
              </thead>
              <tbody>
                {by_repo.map((r) => (
                  <tr
                    key={r.key}
                    className="border-b border-gray-800/50 last:border-0"
                  >
                    <td className="py-2 pr-4 font-mono text-gray-200">
                      {repoLabel(r.key, r.label)}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums text-gray-300">
                      {formatNumber(r.timeout_kills)}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums text-gray-300">
                      {formatNumber(r.orphans_detected)}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums text-gray-300">
                      {formatNumber(r.orphans_recovered)}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums text-gray-300">
                      {formatNumber(r.orphans_exhausted)}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums text-gray-300">
                      {formatNumber(r.prep_failures)}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums text-gray-300">
                      {formatNumber(r.review_deferrals)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </ChartCard>
  );
}

// ---------------------------------------------------------------------------
// Shared toggle control
// ---------------------------------------------------------------------------

function Toggle({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex rounded-lg bg-gray-800 p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`rounded px-2.5 py-1 text-xs font-medium ${
            value === opt.value
              ? 'bg-gray-700 text-white'
              : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
