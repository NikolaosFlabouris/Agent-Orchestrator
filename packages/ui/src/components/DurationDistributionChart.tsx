import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import type { DurationDistribution } from '@orchestrator/shared';
import { formatDuration, formatNumber } from './reportFormat.js';

/** Percentile-bar distribution view for per-group durations. Grouped bars
 *  (p50 / p90 / p99) per model/harness make the tail visible — averages
 *  alone hide it. The tooltip carries the full five-number summary
 *  (min / p50 / p90 / p99 / max) plus the mean and sample count. Durations
 *  are SECONDS on the wire; the axis + tooltip render them human-readable. */
export function DurationDistributionChart({
  groups,
}: {
  groups: DurationDistribution[];
}) {
  // Recharts needs a flat row per category; carry the extra summary fields
  // along for the tooltip.
  const data = groups.map((g) => ({
    key: g.key,
    p50: g.p50_seconds,
    p90: g.p90_seconds,
    p99: g.p99_seconds,
    min: g.min_seconds,
    max: g.max_seconds,
    avg: g.avg_seconds,
    count: g.count,
  }));

  return (
    <ResponsiveContainer width="100%" height={Math.max(220, data.length * 64)}>
      <BarChart
        layout="vertical"
        data={data}
        margin={{ top: 8, right: 16, left: 8, bottom: 0 }}
      >
        <CartesianGrid stroke="#1f2937" horizontal={false} />
        <XAxis
          type="number"
          stroke="#6b7280"
          fontSize={11}
          tickLine={false}
          tickFormatter={(v) => formatDuration(v as number)}
        />
        <YAxis
          type="category"
          dataKey="key"
          stroke="#6b7280"
          fontSize={11}
          tickLine={false}
          width={140}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: '#111827',
            border: '1px solid #374151',
            borderRadius: '0.375rem',
            color: '#e5e7eb',
            fontSize: '0.75rem',
          }}
          cursor={{ fill: 'rgba(255,255,255,0.04)' }}
          content={<DistributionTooltip />}
        />
        <Legend wrapperStyle={{ fontSize: '0.75rem' }} />
        <Bar dataKey="p50" name="p50" fill="#60a5fa" radius={[0, 2, 2, 0]} />
        <Bar dataKey="p90" name="p90" fill="#a78bfa" radius={[0, 2, 2, 0]} />
        <Bar dataKey="p99" name="p99" fill="#fb923c" radius={[0, 2, 2, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

interface TooltipRow {
  payload: {
    key: string;
    min: number | null;
    p50: number | null;
    p90: number | null;
    p99: number | null;
    max: number | null;
    avg: number | null;
    count: number;
  };
}

function DistributionTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: TooltipRow[];
}) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload;
  const line = (label: string, v: number | null) => (
    <div className="flex justify-between gap-4">
      <span className="text-gray-400">{label}</span>
      <span className="tabular-nums text-gray-200">{formatDuration(v)}</span>
    </div>
  );
  return (
    <div className="rounded border border-gray-700 bg-gray-900 px-3 py-2 text-xs">
      <div className="mb-1 font-mono text-gray-200">{p.key}</div>
      {line('min', p.min)}
      {line('p50', p.p50)}
      {line('p90', p.p90)}
      {line('p99', p.p99)}
      {line('max', p.max)}
      {line('avg', p.avg)}
      <div className="mt-1 flex justify-between gap-4 border-t border-gray-800 pt-1">
        <span className="text-gray-400">samples</span>
        <span className="tabular-nums text-gray-200">{formatNumber(p.count)}</span>
      </div>
    </div>
  );
}
