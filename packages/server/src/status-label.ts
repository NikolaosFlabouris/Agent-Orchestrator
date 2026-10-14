import type { Repo } from '@orchestrator/shared';
import type { ForgejoClient } from './forgejo.js';

/**
 * Swap the issue's `status/*` label for `statusLabel`, keeping every other
 * label (e.g. `human-merge`, `human-review`, `ci-failure`, user-authored tags).
 *
 * Forgejo's replaceLabel endpoint is a PUT that replaces the entire label set,
 * so the current labels must be read first or they are stripped on every
 * status change. Reading is best effort: if the issue fetch fails, only the
 * status label is written. Errors from the label write itself propagate so the
 * caller can decide how to report them.
 */
export async function replaceStatusLabel(
  forgejo: Pick<ForgejoClient, 'getIssue' | 'replaceLabelByNames'>,
  repo: Repo,
  issueNumber: number,
  statusLabel: string
): Promise<void> {
  let preserved: string[] = [];
  try {
    const issue = await forgejo.getIssue(repo, issueNumber);
    preserved = issue.labels
      .map((l) => l.name)
      .filter((name) => !name.startsWith('status/'));
  } catch {
    // Best effort — fall back to just setting the status label.
  }

  await forgejo.replaceLabelByNames(repo, issueNumber, [
    statusLabel,
    ...preserved,
  ]);
}
