import { describe, it, expect } from 'vitest';
import { TASK_STATUSES } from '@orchestrator/shared';
import { STATUS_BADGE_COLORS, statusBadgeColor } from '../components/StatusBadge.js';

// The badge colour map used to exist three times (Dashboard, TaskDetail,
// Reports) and the copies had drifted apart. Now there is one, and these
// tests exist to keep it complete and stop the specific drift that was
// fixed from creeping back.

describe('statusBadgeColor', () => {
  it('has an explicit entry for every task status', () => {
    // Assert on the map's keys, not on the resolved colour: the fallback
    // happens to be the same gray several statuses use, which is exactly
    // why nobody noticed the Dashboard's copy was missing `queued` and
    // `reset` — they rendered correctly by accident.
    const missing = TASK_STATUSES.filter((s) => !(s in STATUS_BADGE_COLORS));
    expect(missing).toEqual([]);
  });

  it('gives every status a background and a text colour', () => {
    for (const status of TASK_STATUSES) {
      expect(statusBadgeColor(status)).toMatch(/^bg-\S+ text-\S+$/);
    }
  });

  it('keeps `queued` gray — yellow is reserved for `changes-needed`', () => {
    // Reports used to render queued in yellow, which read as "needs
    // attention" for a task that is simply waiting its turn.
    expect(statusBadgeColor('queued')).toBe('bg-gray-700 text-gray-300');
    expect(statusBadgeColor('changes-needed')).toBe('bg-yellow-900 text-yellow-300');
  });

  it('falls back to a legible badge for an unknown status', () => {
    // A status added server-side before the UI catches up still renders.
    expect(statusBadgeColor('brand-new-status')).toBe('bg-gray-700 text-gray-300');
  });
});
