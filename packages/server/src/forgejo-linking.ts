/**
 * PR↔Issue linking invariant.
 *
 * The orchestrator relies on Forgejo's closing-keyword link (`Closes #N` in
 * the PR body) as the authoritative, machine-readable connection between a
 * pull request and the issue it resolves. This module is the single source
 * of truth for producing and preserving that link.
 *
 * Invariant: every PR created by the orchestrator contains `Closes #<issue_id>`
 * in its body, and every body-editing path runs through `ensureIssueLink` so
 * the link is never dropped.
 */

/** Match any Forgejo closing keyword followed by a `#<number>` reference. */
const CLOSING_KEYWORD_RE =
  /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;

export interface PullRequestBodyContext {
  issue_id: number;
  attempt?: number;
}

/**
 * Canonical body for a PR opened by the orchestrator.
 * Includes the closing-keyword link and a short provenance line.
 */
export function buildPullRequestBody(ctx: PullRequestBodyContext): string {
  const attemptLine =
    ctx.attempt && ctx.attempt > 1
      ? `\nAttempt: ${ctx.attempt}`
      : '';
  return `Automated PR for #${ctx.issue_id}${attemptLine}\n\nCloses #${ctx.issue_id}`;
}

/**
 * Return true iff `body` contains `Closes #issueId` (or any closing keyword
 * referencing that issue number) that Forgejo would recognise as a link.
 */
export function hasIssueLink(body: string | null | undefined, issueId: number): boolean {
  if (!body) return false;
  CLOSING_KEYWORD_RE.lastIndex = 0;
  for (const match of body.matchAll(CLOSING_KEYWORD_RE)) {
    if (Number(match[2]) === issueId) return true;
  }
  return false;
}

/**
 * Idempotently ensure the body contains a closing keyword pointing at
 * `issueId`. If present, returns the body unchanged; otherwise appends a
 * `Closes #<issueId>` line. Existing unrelated closing keywords are
 * preserved (e.g. a PR that also fixes another issue).
 */
export function ensureIssueLink(body: string | null | undefined, issueId: number): string {
  const base = body ?? '';
  if (hasIssueLink(base, issueId)) return base;
  const separator = base.length === 0 || base.endsWith('\n') ? '' : '\n\n';
  const trailing = base.endsWith('\n') ? '' : '';
  return `${base}${separator}${trailing}Closes #${issueId}`;
}

/**
 * Extract every issue number referenced by a closing keyword in the body.
 * Useful for walking PR → linked-issue without consulting the task DB
 * (e.g. reconciling orphaned PRs).
 */
export function extractLinkedIssues(body: string | null | undefined): number[] {
  if (!body) return [];
  CLOSING_KEYWORD_RE.lastIndex = 0;
  const seen = new Set<number>();
  for (const match of body.matchAll(CLOSING_KEYWORD_RE)) {
    seen.add(Number(match[2]));
  }
  return [...seen];
}
