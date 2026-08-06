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
          <div
            key={s.stage}
            className="flex items-start gap-2 sm:items-center sm:gap-3"
          >
            {/* The label + annotation columns cost ~224px at `sm` and up,
                which would leave a ~100px bar track on a 375px screen: below
                `sm` the label column shrinks (eliding, full text in the
                tooltip) and the annotation moves under the bar. `leading-9`
                matches the bar's `h-9` so the label still reads as centred on
                it once the annotation makes the middle column taller;
                `sm:leading-4` restores what `text-xs` sets. */}
            <div
              className="w-20 shrink-0 truncate text-right text-xs leading-9 text-gray-400 sm:w-24 sm:leading-4"
              title={s.label}
            >
              {s.label}
            </div>
            <div className="min-w-0 flex-1">
              <div className="relative flex h-9 items-center justify-center rounded bg-gray-950">
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
              <StageConversion stage={s} index={i} className="mt-1 sm:hidden" />
            </div>
            <StageConversion
              stage={s}
              index={i}
              className="hidden w-32 shrink-0 sm:block"
            />
          </div>
        );
      })}
    </div>
  );
}

/** Conversion-from-created plus the step-over-step drop-off. Rendered twice
 *  per row — beside the bar from `sm` up, beneath it below — with only one
 *  copy visible at a time. */
function StageConversion({
  stage,
  index,
  className,
}: {
  stage: FunnelStage;
  index: number;
  className: string;
}) {
  return (
    <div className={`text-xs tabular-nums text-gray-500 ${className}`}>
      <span title="Conversion from created">
        {formatPercent(stage.pct_of_created)}
      </span>
      {stage.pct_of_previous != null && index > 0 && (
        <span className="ml-2 text-gray-600" title="Conversion from previous stage">
          ({formatPercent(stage.pct_of_previous)} step)
        </span>
      )}
    </div>
  );
}
