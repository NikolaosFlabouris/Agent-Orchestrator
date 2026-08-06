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
import { useMediaQuery, SMALL_SCREEN } from '../hooks/useMediaQuery.js';

/** Category-axis width. 140px fits a full `anthropic/claude-...` key, but on a
 *  375px card that is most of the plot area — phones get a narrower gutter and
 *  elided labels instead (the full key is still in the tooltip). */
const Y_AXIS_WIDTH = 140;
const Y_AXIS_WIDTH_SMALL = 90;
/** Roughly what fits in `Y_AXIS_WIDTH_SMALL` at the 11px tick font. */
const SMALL_LABEL_CHARS = 14;

function elideLabel(value: string): string {
  return value.length > SMALL_LABEL_CHARS
    ? `${value.slice(0, SMALL_LABEL_CHARS - 1)}…`
    : value;
}

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
  const small = useMediaQuery(SMALL_SCREEN);
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
        margin={
          small
            ? { top: 8, right: 8, left: 0, bottom: 0 }
            : { top: 8, right: 16, left: 8, bottom: 0 }
        }
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
          width={small ? Y_AXIS_WIDTH_SMALL : Y_AXIS_WIDTH}
          tickFormatter={
            small ? (v: string | number) => elideLabel(String(v)) : undefined
          }
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
