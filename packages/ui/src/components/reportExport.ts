import type {
  ReportsOverview,
  ReportsLeaderboard,
  ReportFilter,
} from '@orchestrator/shared';

/** Bundle of already-fetched, already-filtered report data handed to the
 *  export buttons. No new request is made — the blob is built entirely from
 *  what the page is currently showing, so the export respects the active
 *  repo/date filters by construction. */
export interface ReportExportData {
  filter: ReportFilter;
  overview: ReportsOverview;
  leaderboards: ReportsLeaderboard[];
}

/** Trigger a client-side file download for an in-memory string. */
export function downloadFile(
  filename: string,
  content: string,
  mime: string
): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Pretty-printed JSON of the full filtered bundle (overview + every
 *  leaderboard grouping). */
export function toJson(data: ReportExportData): string {
  return JSON.stringify(data, null, 2);
}

function csvField(value: unknown): string {
  const s = value == null ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(cells: unknown[]): string {
  return cells.map(csvField).join(',');
}

/** A single CSV combining an overview summary block and one leaderboard
 *  table per grouping. Sections are separated by a blank line — ragged but
 *  perfectly readable in any spreadsheet, and keeps the whole filtered
 *  picture in one file. */
export function toCsv(data: ReportExportData): string {
  const { filter, overview, leaderboards } = data;
  const lines: string[] = [];

  lines.push(csvRow(['Report range', filter.from, filter.to]));
  lines.push(
    csvRow(['Repos', filter.repos ? filter.repos.join(' ') : 'all'])
  );
  lines.push('');

  // Overview KPI block (metric / value pairs).
  lines.push(csvRow(['Overview metric', 'Value']));
  lines.push(csvRow(['Total tasks', overview.total_tasks]));
  lines.push(csvRow(['Tasks created', overview.throughput.tasks_created]));
  lines.push(csvRow(['Tasks merged', overview.throughput.tasks_merged]));
  lines.push(csvRow(['Success rate', overview.success_rate ?? '']));
  lines.push(csvRow(['Avg lead time (s)', overview.lead_time.avg_seconds ?? '']));
  lines.push(
    csvRow(['Avg implementation (s)', overview.implementation_duration.avg_seconds ?? ''])
  );
  lines.push(csvRow(['Avg review (s)', overview.review_duration.avg_seconds ?? '']));
  lines.push(csvRow(['Avg rework', overview.rework.avg ?? '']));
  lines.push(csvRow(['Backlog queued', overview.backlog.queued]));
  lines.push(csvRow(['Backlog blocked', overview.backlog.blocked]));
  lines.push('');

  // One table per leaderboard grouping.
  const header = [
    'group_by',
    'key',
    'label',
    'task_count',
    'success_rate',
    'merged',
    'failed',
    'cancelled',
    'avg_implementation_s',
    'avg_review_s',
    'avg_rework',
    'avg_num_turns',
    'avg_total_tokens',
    'total_input_tokens',
    'total_output_tokens',
    'verdict_approved',
    'verdict_changes_needed',
    'verdict_unclear',
  ];
  for (const board of leaderboards) {
    lines.push(csvRow([`Leaderboard: ${board.group_by}`]));
    lines.push(csvRow(header));
    for (const r of board.rows) {
      lines.push(
        csvRow([
          board.group_by,
          r.key,
          r.label,
          r.task_count,
          r.success_rate ?? '',
          r.terminal_counts.merged,
          r.terminal_counts.failed,
          r.terminal_counts.cancelled,
          r.avg_implementation_seconds ?? '',
          r.avg_review_seconds ?? '',
          r.avg_rework ?? '',
          r.avg_num_turns ?? '',
          r.avg_total_tokens ?? '',
          r.total_input_tokens,
          r.total_output_tokens,
          r.verdicts.approved,
          r.verdicts.changes_needed,
          r.verdicts.unclear,
        ])
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}
