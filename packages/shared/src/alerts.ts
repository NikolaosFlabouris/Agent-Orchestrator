/**
 * Orchestrator alerts — the actionable conditions `checkAlerts`
 * (`packages/server/src/alerts.ts`) recomputes from persisted state and
 * `GET /api/status/alerts` returns.
 *
 * Shared rather than duplicated per package because the shape is a wire
 * contract: the server produces it, the dashboard store holds it, and
 * `AlertBanner` renders it. Three hand-maintained copies of the same
 * interface is exactly how `id`/`task_id` would have gone missing on one
 * side of the boundary.
 */

/** One active alert condition.
 *
 *  `id` is a STABLE identity for the condition, not for the individual
 *  computation: the endpoint recomputes the whole active set on every poll,
 *  so the same still-live condition must come back under the same id or the
 *  client could never remember that the operator dismissed it. Task-specific
 *  classes key on the orchestrator task id (`stuck:12`); classes that
 *  aggregate over many tasks are a single constant (`git-prep-backoff`).
 *
 *  `task_id` is the orchestrator task id (NOT the Forgejo `issue_id`) when
 *  the alert is about one task, so the UI can link straight to
 *  `/tasks/:id`; null for the aggregate classes. Alert *messages* quote the
 *  issue number, which is what an operator recognises — the two numbering
 *  spaces are deliberately not interchangeable. */
export interface OrchestratorAlert {
  id: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  task_id: number | null;
}
