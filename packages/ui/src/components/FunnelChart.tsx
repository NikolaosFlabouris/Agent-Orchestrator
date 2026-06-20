import type { FunnelStage } from '@orchestrator/shared';
import { formatNumber, formatPercent } from './reportFormat.js';

/** Lifecycle funnel: a vertical stack of centered bars whose width is
 *  proportional to each stage's count relative to the first ("created")
 *  stage. Each row shows the stage label, count, overall conversion from
 *  created, and the step-over-step conversion (drop-off) from the previous
 *  stage. Hand-rolled (no Recharts Funnel) so the drop-off annotations sit
 *  exactly where they read best. */
const STAGE_COLORS = ['#60a5fa', '#38bdf8', '#34d399', '#a78bfa', '#4ade80'];

export function FunnelChart({ stages }: { stages: FunnelStage[] }) {
  const first = stages[0]?.count ?? 0;

  return (
    <div className="space-y-2">
      {stages.map((s, i) => {
        const widthPct = first > 0 ? (s.count / first) * 100 : 0;
        return (
          <div key={s.stage} className="flex items-center gap-3">
            <div className="w-24 shrink-0 text-right text-xs text-gray-400">
              {s.label}
            </div>
            <div className="relative flex h-9 flex-1 items-center justify-center rounded bg-gray-950">
              <div
                className="absolute left-1/2 top-0 h-full -translate-x-1/2 rounded transition-all"
                style={{
                  width: `${Math.max(widthPct, 2)}%`,
                  backgroundColor: STAGE_COLORS[i % STAGE_COLORS.length],
                  opacity: 0.85,
                }}
              />
              <span className="relative z-10 text-sm font-semibold tabular-nums text-gray-900">
                {formatNumber(s.count)}
              </span>
            </div>
            <div className="w-32 shrink-0 text-xs tabular-nums text-gray-500">
              <span title="Conversion from created">
                {formatPercent(s.pct_of_created)}
              </span>
              {s.pct_of_previous != null && i > 0 && (
                <span
                  className="ml-2 text-gray-600"
                  title="Conversion from previous stage"
                >
                  ({formatPercent(s.pct_of_previous)} step)
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
