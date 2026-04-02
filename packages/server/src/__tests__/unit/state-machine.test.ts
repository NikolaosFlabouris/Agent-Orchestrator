import { describe, it, expect } from 'vitest';
import {
  STATUS_LABELS,
  OVERRIDE_LABELS,
  TERMINAL_STATUSES,
  statusToLabel,
  labelToStatus,
} from '@orchestrator/shared';

describe('statusToLabel', () => {
  it('converts DB status to Forgejo label', () => {
    expect(statusToLabel('queued')).toBe('status/queued');
    expect(statusToLabel('in-progress')).toBe('status/in-progress');
    expect(statusToLabel('merged')).toBe('status/merged');
  });
});

describe('labelToStatus', () => {
  it('extracts DB status from Forgejo label', () => {
    expect(labelToStatus('status/queued')).toBe('queued');
    expect(labelToStatus('status/in-progress')).toBe('in-progress');
    expect(labelToStatus('status/merged')).toBe('merged');
  });

  it('returns null for non-status labels', () => {
    expect(labelToStatus('human-merge')).toBeNull();
    expect(labelToStatus('repo/frontend')).toBeNull();
    expect(labelToStatus('bug')).toBeNull();
  });
});

describe('TERMINAL_STATUSES', () => {
  it('includes all terminal states', () => {
    expect(TERMINAL_STATUSES.has('merged')).toBe(true);
    expect(TERMINAL_STATUSES.has('failed')).toBe(true);
    expect(TERMINAL_STATUSES.has('cancelled')).toBe(true);
    expect(TERMINAL_STATUSES.has('reset')).toBe(true);
    expect(TERMINAL_STATUSES.has('awaiting-human-merge')).toBe(true);
    expect(TERMINAL_STATUSES.has('awaiting-human-review')).toBe(true);
    expect(TERMINAL_STATUSES.has('needs-human-review')).toBe(true);
  });

  it('excludes active states', () => {
    expect(TERMINAL_STATUSES.has('queued')).toBe(false);
    expect(TERMINAL_STATUSES.has('preparing')).toBe(false);
    expect(TERMINAL_STATUSES.has('in-progress')).toBe(false);
    expect(TERMINAL_STATUSES.has('in-review')).toBe(false);
    expect(TERMINAL_STATUSES.has('changes-needed')).toBe(false);
  });
});

describe('STATUS_LABELS', () => {
  it('has all expected status labels', () => {
    expect(STATUS_LABELS.QUEUED).toBe('status/queued');
    expect(STATUS_LABELS.PREPARING).toBe('status/preparing');
    expect(STATUS_LABELS.IN_PROGRESS).toBe('status/in-progress');
    expect(STATUS_LABELS.IN_REVIEW).toBe('status/in-review');
    expect(STATUS_LABELS.CHANGES_NEEDED).toBe('status/changes-needed');
    expect(STATUS_LABELS.MERGED).toBe('status/merged');
    expect(STATUS_LABELS.FAILED).toBe('status/failed');
    expect(STATUS_LABELS.CANCELLED).toBe('status/cancelled');
    expect(STATUS_LABELS.AWAITING_HUMAN_MERGE).toBe('status/awaiting-human-merge');
    expect(STATUS_LABELS.AWAITING_HUMAN_REVIEW).toBe('status/awaiting-human-review');
    expect(STATUS_LABELS.NEEDS_HUMAN_REVIEW).toBe('status/needs-human-review');
  });
});

describe('OVERRIDE_LABELS', () => {
  it('has human-merge and human-review', () => {
    expect(OVERRIDE_LABELS.HUMAN_MERGE).toBe('human-merge');
    expect(OVERRIDE_LABELS.HUMAN_REVIEW).toBe('human-review');
  });
});
