import { describe, it, expect } from 'vitest';
import { toCsv, toJson, type ReportExportData } from '../components/reportExport.js';
import type {
  ReportsOverview,
  ReportsLeaderboard,
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
      verdicts: { approved: 3, changes_needed: 1, unclear: 0 },
    },
  ],
};

const data: ReportExportData = {
  filter: { repos: [1], from: '2026-01-01', to: '2026-04-01' },
  overview,
  leaderboards: [modelBoard],
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
});
