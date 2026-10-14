import { describe, it, expect, vi } from 'vitest';
import { replaceStatusLabel } from '../../status-label.js';

const repo = { id: 1, owner: 'nik', name: 'myrepo' } as any;

function makeForgejo(labels: string[] | Error) {
  return {
    getIssue:
      labels instanceof Error
        ? vi.fn().mockRejectedValue(labels)
        : vi.fn().mockResolvedValue({ labels: labels.map((name) => ({ name })) }),
    replaceLabelByNames: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe('replaceStatusLabel', () => {
  it('replaces the status label and keeps every other label', async () => {
    const forgejo = makeForgejo(['ci-failure', 'status/in-progress', 'human-review']);

    await replaceStatusLabel(forgejo, repo, 7, 'status/in-review');

    expect(forgejo.replaceLabelByNames).toHaveBeenCalledWith(repo, 7, [
      'status/in-review',
      'ci-failure',
      'human-review',
    ]);
  });

  it('writes only the status label when the issue fetch fails', async () => {
    const forgejo = makeForgejo(new Error('forge down'));

    await replaceStatusLabel(forgejo, repo, 7, 'status/cancelled');

    expect(forgejo.replaceLabelByNames).toHaveBeenCalledWith(repo, 7, [
      'status/cancelled',
    ]);
  });

  it('propagates errors from the label write', async () => {
    const forgejo = makeForgejo([]);
    forgejo.replaceLabelByNames.mockRejectedValue(new Error('label api down'));

    await expect(
      replaceStatusLabel(forgejo, repo, 7, 'status/queued')
    ).rejects.toThrow('label api down');
  });
});
