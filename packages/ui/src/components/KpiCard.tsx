import type { ReactNode } from 'react';
import { relativeDelta } from './reportFormat.js';

/** Whether an increase in the metric is good, bad, or neither — drives the
 *  colour of the delta badge. Throughput/success rate are higher-good;
 *  durations and backlog are lower-good. */
export type DeltaPolarity = 'higher-good' | 'lower-good' | 'neutral';

export interface KpiCardProps {
  label: string;
  /** Raw current value; null renders the empty placeholder. */
  value: number | null;
  /** Formatter turning the raw value into its display string. */
  format: (n: number | null) => string;
  /** Equivalent value for the previous period. Omit to hide the delta. */
  previous?: number | null;
  polarity?: DeltaPolarity;
  /** Optional sparkline series, oldest → newest. Hidden when absent/flat. */
  sparkline?: number[];
  /** Small secondary line under the value (e.g. "3 blocked"). */
  sub?: ReactNode;
  /** Compact variant for the Dashboard KPI strip — tighter, no sparkline. */
  compact?: boolean;
}

/** Reusable KPI tile: big number, optional delta-vs-previous badge, and an
 *  optional hand-rolled SVG sparkline. Shared by the Reports page KPI row
 *  and the Dashboard KPI strip (and reused by later reporting tasks). */
export function KpiCard({
  label,
  value,
  format,
  previous,
  polarity = 'higher-good',
  sparkline,
  sub,
  compact = false,
}: KpiCardProps) {
  const delta = relativeDelta(value, previous);
  const showSpark = !compact && sparkline && sparkline.length > 1;

  return (
    <div
      className={`rounded-lg border border-gray-800 bg-gray-900 ${
        compact ? 'px-3 py-2' : 'p-4'
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs uppercase tracking-wide text-gray-500">
          {label}
        </span>
        {delta !== null && <DeltaBadge delta={delta} polarity={polarity} />}
      </div>
      <div
        className={`mt-1 font-semibold text-gray-100 ${
          compact ? 'text-xl' : 'text-2xl'
        }`}
      >
        {format(value)}
      </div>
      {sub && <div className="mt-0.5 text-xs text-gray-500">{sub}</div>}
      {showSpark && (
        <div className="mt-2">
          <Sparkline values={sparkline} polarity={polarity} />
        </div>
      )}
    </div>
  );
}

function DeltaBadge({
  delta,
  polarity,
}: {
  delta: number;
  polarity: DeltaPolarity;
}) {
  const rounded = Math.round(delta * 100);
  const arrow = rounded > 0 ? '▲' : rounded < 0 ? '▼' : '→';
  // Map the sign to good/bad given the metric's polarity, then to a colour.
  let tone = 'text-gray-400';
  if (rounded !== 0 && polarity !== 'neutral') {
    const isGood = polarity === 'higher-good' ? rounded > 0 : rounded < 0;
    tone = isGood ? 'text-green-400' : 'text-red-400';
  }
  return (
    <span
      className={`text-xs font-medium ${tone}`}
      title="Change vs the previous equivalent period"
    >
      {arrow} {Math.abs(rounded)}%
    </span>
  );
}

/** Minimal inline sparkline. Hand-rolled SVG (rather than Recharts) so the
 *  tiny KPI trends stay dependency-light and cheap to render in a strip. */
export function Sparkline({
  values,
  polarity = 'higher-good',
  width = 120,
  height = 28,
}: {
  values: number[];
  polarity?: DeltaPolarity;
  width?: number;
  height?: number;
}) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = width / (values.length - 1);
  // Leave a 2px vertical inset so the stroke isn't clipped at the edges.
  const pad = 2;
  const usable = height - pad * 2;
  const points = values
    .map((v, i) => {
      const x = i * stepX;
      const y = pad + (1 - (v - min) / span) * usable;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const last = values[values.length - 1];
  const first = values[0];
  const rising = last >= first;
  const good = polarity === 'neutral' ? null : polarity === 'higher-good' ? rising : !rising;
  const stroke =
    good === null ? '#60a5fa' : good ? '#4ade80' : '#f87171';

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="w-full"
      aria-hidden="true"
    >
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
