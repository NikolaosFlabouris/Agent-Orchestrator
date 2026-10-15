import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Task, Repo, NoChangeClaim } from '@orchestrator/shared';
import { validateNoChangeClaim } from '@orchestrator/shared';
import { updateTaskWithSync, recordTaskEvent } from '../state-sync.js';
import type { ForgejoClient } from '../forgejo.js';
import { getOutputDir } from '../workspace.js';
import type { FastifyBaseLogger } from 'fastify';

/** File a dev agent writes instead of committing when it concludes, with
 *  evidence, that the task needs no code change. */
export const NO_CHANGE_FILENAME = 'no-change.json';

/**
 * Outcome of looking for the agent's no-change claim:
 *  - `none`    : no file — the agent made no claim.
 *  - `invalid` : a file exists but is not a well-formed, evidenced claim.
 *  - `valid`   : a claim the orchestrator will put up for review.
 */
export type NoChangeClaimRead =
  | { kind: 'none' }
  | { kind: 'invalid'; detail: string }
  | { kind: 'valid'; claim: NoChangeClaim };

/**
 * Read and validate `/output/no-change.json` for the task's current attempt.
 * The file is cleared at the start of every dev attempt (see
 * `clearNoChangeFile`), so whatever is here was written by this attempt.
 */
export async function readNoChangeClaim(task: Task): Promise<NoChangeClaimRead> {
  const file = path.join(getOutputDir(task), NO_CHANGE_FILENAME);
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf-8');
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === 'ENOENT') return { kind: 'none' };
    return { kind: 'invalid', detail: `unreadable: ${String(err)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'invalid', detail: 'not valid JSON' };
  }
  const claim = validateNoChangeClaim(parsed, task.attempt);
  if (!claim) {
    return {
      kind: 'invalid',
      detail: 'needs a known category, a non-empty reason and at least one evidence entry',
    };
  }
  return { kind: 'valid', claim };
}

/** Remove a no-change.json left by an earlier attempt so it can never be
 *  read as this attempt's claim. Missing file is fine. */
export async function clearNoChangeFile(task: Task): Promise<void> {
  await fsp.rm(path.join(getOutputDir(task), NO_CHANGE_FILENAME), {
    force: true,
  });
}

const CATEGORY_LABELS: Record<NoChangeClaim['category'], string> = {
  already_fixed: 'already fixed',
  duplicate: 'duplicate',
  not_reproducible: 'not reproducible',
  obsolete: 'obsolete',
};

/** Human-readable category, e.g. `already_fixed` → `already fixed`. */
export function describeNoChangeCategory(category: NoChangeClaim['category']): string {
  return CATEGORY_LABELS[category] ?? category;
}

/** Markdown rendering of a claim (category, reason, evidence) for issue
 *  comments and the review prompt. */
export function formatNoChangeClaim(claim: NoChangeClaim): string {
  const evidence = claim.evidence.map((e) => `- ${e}`).join('\n');
  return (
    `**Category:** ${describeNoChangeCategory(claim.category)}\n\n` +
    `**Reason:** ${claim.reason}\n\n` +
    `**Evidence:**\n${evidence}`
  );
}

/**
 * Put a valid claim up for review: persist it on the task (the output dir is
 * archived before the review runs), record `no_change_claimed`, and post the
 * claim on the issue. The task's status is left alone — the caller routes it
 * to the configured reviewer next.
 */
export async function recordNoChangeClaim(
  task: Task,
  repo: Repo,
  claim: NoChangeClaim,
  forgejo: ForgejoClient,
  log: FastifyBaseLogger
): Promise<void> {
  updateTaskWithSync(task.id, { no_change_claim: JSON.stringify(claim) });
  recordTaskEvent(
    task.id,
    'no_change_claimed',
    `Agent reports no change needed (${claim.category}): ${claim.reason}`
  );
  try {
    await forgejo.commentOnIssue(
      repo,
      task.issue_id,
      `The dev agent concluded no code change is required (attempt ${task.attempt}). ` +
        `The claim will be reviewed before the task is closed.\n\n${formatNoChangeClaim(claim)}`
    );
  } catch { /* best effort */ }
  log.info(
    {
      event: 'no_change_claimed',
      task_id: task.id,
      category: claim.category,
    },
    'Dev agent claims no change is needed — routing claim to review'
  );
}
