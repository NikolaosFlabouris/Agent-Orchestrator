import { describe, it, expect } from 'vitest';
import { toCsv, toJson, type ReportExportData } from '../components/reportExport.js';
import type {
  ReportsOverview,
  ReportsLeaderboard,
  ReportsReliability,
  ReportsDurations,
} from '@orchestrator/shared';

const overview: ReportsOverview = {
  range: { from: '2026-01-01', to: '2026-04-01' },
  repos: [1],
  status_counts: {
    queued: 2,
    preparing: 0,
    'in-progress': 1,
    'in-review': 0,
    'changes-needed': 0,
    merged: 5,
    failed: 1,
    cancelled: 0,
    'awaiting-human-merge': 0,
    'awaiting-human-review': 0,
    'needs-human-review': 0,
    reset: 0,
  },
  total_tasks: 9,
  success_rate: 0.833,
  terminal_counts: { merged: 5, failed: 1, cancelled: 0 },
  throughput: { tasks_created: 9, tasks_merged: 5 },
  backlog: { queued: 2, blocked: 1 },
  implementation_duration: { count: 6, avg_seconds: 1200, p50_seconds: 1100, p90_seconds: 2000 },
  review_duration: { count: 6, avg_seconds: 300, p50_seconds: 280, p90_seconds: 600 },
  lead_time: { count: 5, avg_seconds: 4200, p50_seconds: 4000, p90_seconds: 8000 },
  rework: { avg: 1.4, task_count: 6 },
};

const modelBoard: ReportsLeaderboard = {
  range: { from: '2026-01-01', to: '2026-04-01' },
  group_by: 'model',
  rows: [
    {
      key: 'claude, opus',
      label: 'claude, opus',
      task_count: 4,
      success_rate: 0.75,
      terminal_counts: { merged: 3, failed: 1, cancelled: 0 },
      avg_implementation_seconds: 1000,
      avg_review_seconds: 200,
      avg_rework: 1.2,
      avg_num_turns: 6,
      avg_total_tokens: 900,
      total_input_tokens: 1200,
      total_output_tokens: 600,
      avg_changed_files: 4,
      avg_additions: 120,
      avg_deletions: 30,
      avg_total_churn: 150,
      verdicts: { approved: 3, changes_needed: 1, unclear: 0 },
    },
  ],
};

const reliability: ReportsReliability = {
  range: { from: '2026-01-01', to: '2026-04-01' },
  repos: [1],
  bucket: 'day',
  counts: {
    timeout_kills: 3,
    orphans_detected: 2,
    orphans_recovered: 2,
    orphans_exhausted: 0,
    review_deferrals: 1,
    prep_failures: 4,
  },
  series: [],
  by_repo: [],
};

const durationsImpl: ReportsDurations = {
  range: { from: '2026-01-01', to: '2026-04-01' },
  group_by: 'model',
  metric: 'implementation',
  groups: [
    {
      key: 'opus',
      label: 'opus',
      count: 4,
      min_seconds: 100,
      p50_seconds: 200,
      p90_seconds: 400,
      p99_seconds: 400,
      max_seconds: 400,
      avg_seconds: 250,
    },
  ],
};

const data: ReportExportData = {
  filter: { repos: [1], from: '2026-01-01', to: '2026-04-01' },
  overview,
  leaderboards: [modelBoard],
  reliability,
  durations: [durationsImpl],
};

describe('toJson', () => {
  it('round-trips the full filtered bundle', () => {
    const parsed = JSON.parse(toJson(data));
    expect(parsed.overview.throughput.tasks_merged).toBe(5);
    expect(parsed.leaderboards[0].rows[0].task_count).toBe(4);
    expect(parsed.filter.repos).toEqual([1]);
  });
});

describe('toCsv', () => {
  const csv = toCsv(data);

  it('includes the overview summary block', () => {
    expect(csv).toContain('Tasks merged,5');
    expect(csv).toContain('Success rate,0.833');
    expect(csv).toContain('Backlog queued,2');
  });

  it('includes a leaderboard table with a header and rows', () => {
    expect(csv).toContain('Leaderboard: model');
    expect(csv).toContain('group_by,key,label,task_count');
  });

  it('includes the PR churn columns in the leaderboard export', () => {
    expect(csv).toContain('avg_changed_files,avg_additions,avg_deletions,avg_total_churn');
    // The fixture row carries churn 4 files / +120 / -30 / 150 total.
    expect(csv).toContain(',4,120,30,150,');
  });

  it('escapes fields containing commas by quoting them', () => {
    // The label "claude, opus" contains a comma and must be quoted.
    expect(csv).toContain('"claude, opus"');
  });

  it('renders null metrics as empty cells, not the literal "null"', () => {
    const withNulls: ReportExportData = {
      ...data,
      overview: { ...overview, success_rate: null },
    };
    expect(toCsv(withNulls)).toContain('Success rate,\n');
  });

  it('includes the reliability incidence block when present', () => {
    expect(csv).toContain('Reliability metric,Count');
    expect(csv).toContain('Timeout kills,3');
    expect(csv).toContain('Prep failures,4');
  });

  it('includes the duration percentile tables when present', () => {
    expect(csv).toContain('Durations: implementation by model');
    expect(csv).toContain('metric,group_by,key,count,min_s,p50_s,p90_s,p99_s,max_s,avg_s');
    expect(csv).toContain('implementation,model,opus,4,100,200,400,400,400,250');
  });

  it('omits the advanced blocks when those fields are absent', () => {
    const minimal: ReportExportData = {
      filter: { repos: [1], from: '2026-01-01', to: '2026-04-01' },
      overview,
      leaderboards: [modelBoard],
    };
    const out = toCsv(minimal);
    expect(out).not.toContain('Reliability metric');
    expect(out).not.toContain('Durations:');
  });
});
