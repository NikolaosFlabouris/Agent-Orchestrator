import type { HeatmapCell } from '@orchestrator/shared';

/** Hour-of-day × day-of-week activity heatmap. The endpoint returns only the
 *  non-zero cells plus the max; this fills the full 7×24 grid and shades each
 *  cell by count/max. Times are UTC (matching the server's strftime). */
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function ActivityHeatmap({
  cells,
  max,
}: {
  cells: HeatmapCell[];
  max: number;
}) {
  // Index the sparse cells into a dense lookup keyed by dow*24+hour.
  const counts = new Map<number, number>();
  for (const c of cells) counts.set(c.dow * 24 + c.hour, c.count);

  const shade = (count: number): string => {
    if (count <= 0 || max <= 0) return '#111827';
    // Perceptual ramp from faint to bright blue.
    const t = count / max;
    const alpha = 0.12 + t * 0.88;
    return `rgba(96, 165, 250, ${alpha.toFixed(3)})`;
  };

  return (
    <div className="overflow-x-auto">
      <div className="inline-block">
        {/* Hour axis */}
        <div className="flex pl-10">
          {Array.from({ length: 24 }, (_, h) => (
            <div
              key={h}
              className="w-[14px] text-center text-[8px] text-gray-600"
            >
              {h % 6 === 0 ? h : ''}
            </div>
          ))}
        </div>
        {DAY_LABELS.map((day, dow) => (
          <div key={day} className="flex items-center">
            <div className="w-10 pr-1 text-right text-[10px] text-gray-500">
              {day}
            </div>
            {Array.from({ length: 24 }, (_, hour) => {
              const count = counts.get(dow * 24 + hour) ?? 0;
              return (
                <div
                  key={hour}
                  className="m-px h-[14px] w-[12px] rounded-[2px]"
                  style={{ backgroundColor: shade(count) }}
                  title={`${day} ${String(hour).padStart(2, '0')}:00 UTC — ${count}`}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
