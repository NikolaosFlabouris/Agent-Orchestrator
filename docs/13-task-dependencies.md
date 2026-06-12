# 13 — Task Dependencies: Implementation Plan

Status: **implemented** — revision 2 (see PR for the implementing change).

Revision 2 changes (by decision):
- **Closed-only completion**: a dependency is satisfied when its issue is
  **closed**. There is no merged-work verification (no PR scanning, no
  timeline lookups, no `closed-unverified` state).
- **Blocked is UI-only**: computed at read time from dependency records.
  It is never a `TaskStatus` value, never stored on the task row, and never
  synced to Forgejo as a label.
- **Unit tests only**: no e2e or integration-suite gates; each task ships
  with its own unit tests.
- Work split into six orchestrator-sized tasks (§5).

## Requirements served

1. Issue bodies declare dependencies on other issues (checklist syntax).
2. Dependencies can be added via the UI or MCP, written by one deterministic
   server-side formatter so the syntax is always canonical.
3. A deterministic dependency check runs on every scheduler tick before a
   queued task can launch.
4. A dependency is complete when its issue is closed.
5. Queued tasks blocked by dependencies are visibly **blocked** in the UI
   (badge + filter + task-page panel), while remaining `queued` everywhere
   else.
6. A dependency that does not exist leaves the task blocked, with the reason
   shown.
7. The task page lists every dependency with number, state, and repair hint.
8. Dependency edits made directly on Forgejo (add / remove / tick) are
   re-parsed and reflected in the orchestrator — webhook-driven, with a
   polling fallback that converges within one poll interval (60s).

---

## 1. Architecture decisions

| Decision | Choice | Rationale |
|---|---|---|
| Source of truth | The `## Dependencies` section of the Forgejo issue body | Preserves the human repair workflow (edit on Forgejo). The orchestrator DB holds a **synced projection**, never an independent truth. |
| Sync model | Re-derive from the freshest body at every evaluation; webhook `edited` + polling piggyback keep it fresh | One write path into `task_dependencies` (the evaluator). No two-way reconciliation. |
| Completion rule | Dep issue `state === 'closed'` ⇒ satisfied | Simple, matches Forgejo's own notion of done. PR references (shared numbering) need no special case — a closed PR satisfies too. |
| DB shortcut | A dep whose orchestrator task is `merged` is satisfied without an API call | Avoids the merge→issue-close race (closeIssue is async/best-effort) and makes the common case free. Stable: merges don't un-happen. |
| Reopen semantics | Satisfied-via-closed is **re-derived every pass**: reopening an untracked dep issue re-blocks queued dependents. Satisfied-via-merged-task never regresses. | "Complete = closed" should track the issue while the dependent is still queued. Once a task launches, deps no longer apply (gate covers `queued` only). |
| Blocked | Computed at API-read time (`blocked: boolean` + `dependencies[]` on task payloads); rendered only in the orchestrator UI | No `TaskStatus` change, no `status-derivation.ts` change, no stored state to go stale, no Forgejo label (eliminates label→webhook→tick feedback risk). |
| Manual override | A **checked** box (`- [x] #N`) = manually satisfied | Lets a human release a dependent while the dep is still open (or neutralise a bad reference) without deleting the line — auditable via Forgejo edit history. |
| Parser scope | Only the `## Dependencies` section | Kills accidental dependencies from acceptance-criteria checklists. No live issues rely on the old body-wide parse (confirmed), so no migration audit is needed. |
| Cross-repo deps | Out of scope | `#N` resolves in the task's own repo. `owner/repo#N` and URLs are ignored. UI picker offers same-repo issues only. |
| Failure handling | Fail closed, with one anti-flap rule: a transient fetch error keeps a previously-**satisfied** state; any other previous state becomes `error` (blocked, retried next pass) | A dep last seen closed shouldn't re-block on a network blip; an unknown dep should never unblock on one. |

## 2. Data model & contracts

### 2.1 Shared types (`packages/shared/src/types.ts`)

```ts
export type DependencyState =
  | 'satisfied'            // dep issue closed (or tracked task merged)
  | 'manually-satisfied'   // checked box override in issue body
  | 'open'                 // dep issue open
  | 'in-progress'          // dep issue open + orchestrator task actively running
  | 'failed'               // dep issue open + orchestrator task failed/cancelled/reset
  | 'missing'              // dep issue does not exist (404)         → blocks
  | 'error'                // fetch failure, no prior satisfied state → blocks
  | 'cycle';               // dependency cycle among queued tasks     → blocks

export const SATISFIED_DEP_STATES: ReadonlySet<DependencyState> =
  new Set(['satisfied', 'manually-satisfied']);

export interface TaskDependency {
  id: number;
  task_id: number;
  dep_issue_number: number;     // same-repo issue (or PR) number
  state: DependencyState;
  detail: string | null;        // evidence, e.g. "merged via task #12 / PR #52"
  checked: boolean;             // raw box state from last parse
  first_seen_at: string;
  last_evaluated_at: string | null;
}
```

`TaskStatus` is **not** modified. `in-progress` / `failed` are display
refinements (free from the DB lookup) so the panel can give precise repair
hints; for gating they are equivalent to `open`.

### 2.2 DB migration (v24 → v25, `db.ts`)

```sql
CREATE TABLE IF NOT EXISTS task_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  dep_issue_number INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  detail TEXT,
  checked INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_evaluated_at TEXT,
  UNIQUE(task_id, dep_issue_number)
);
CREATE INDEX IF NOT EXISTS idx_task_deps_reverse
  ON task_dependencies(dep_issue_number);
```

The reverse index serves "issue #N just closed — which queued tasks were
waiting on it?". Follow the existing inline-migration pattern (bump
`CURRENT_SCHEMA_VERSION`, idempotent DDL).

### 2.3 The `dependencies.ts` module (new, server)

Single owner of parse / format / evaluate. Nothing else touches the section
text or the `task_dependencies` table.

```ts
// Parsing — section-scoped, bullet-tolerant.
parseDependencySection(body: string): { issue: number; checked: boolean }[]
// Section: from /^#{2,3}\s*dependencies\s*$/im to the next heading of equal
// or higher level (or EOF). Items: /^\s*[-*+]\s*\[( |x|X)\]\s*#(\d+)\b/gm.
// Dedupe: same number listed checked AND unchecked → unchecked wins
// (fail closed). Anything else in the section is ignored.

// Formatting — canonical writer used by all intake paths.
formatDependencySection(deps: number[]): string
upsertDependencySection(body: string, add: number[]): string
// Creates the section if absent; unions with existing items; never
// duplicates; preserves existing checked flags.

// Evaluation — the only writer of task_dependencies rows.
evaluateTaskDependencies(task, parsedDeps, ctx): Promise<DepSummary>
// Ladder per dep (§3); upserts rows idempotently (writes + WS broadcast only
// on change); deletes rows for deps no longer in the body;
// returns { blocked: boolean, deps: TaskDependency[] }.

// Intake validation — used by MCP + UI create paths.
validateDependencies(repo, deps, forgejo): Promise<ValidationResult>
// Rejects: non-positive/non-integer, duplicates, self-reference,
// nonexistent issues (404), cycles among tracked queued tasks.
// Warns only: dep already closed (it is simply satisfied from the start).
```

## 3. The evaluation ladder

Per dependency, first match wins. Steps 1–3 are DB/text-only.

| # | Condition | State | Cost |
|---|---|---|---|
| 1 | Box checked (`- [x] #N`) | `manually-satisfied` | none |
| 2 | Dep issue tracked by an orchestrator task with status `merged` | `satisfied` ("merged via task #T / PR #P") — stable, never re-fetched | none |
| 3 | Cycle: dep's queued task depends (transitively, via tracked tasks) back on this task | `cycle` | none (DB walk) |
| 4 | Fetch issue (snapshot-cached). 404 → | `missing` | 1 GET |
| 5 | Fetch threw (non-404): previous state satisfied → keep `satisfied`; else → | `error` (fail closed, retried next pass) | — |
| 6 | Issue closed (issues API also returns PRs; a closed PR counts) | `satisfied` | — |
| 7 | Issue open: tracked task running → `in-progress`; tracked task `failed`/`cancelled`/`reset` → `failed`; otherwise → `open` | as listed | — |

Task is **eligible** iff every dep state ∈ `SATISFIED_DEP_STATES`. Anything
else blocks — deterministic and fail-closed.

## 4. Sync design

One evaluator, four triggers:

| Trigger | Latency | Mechanism |
|---|---|---|
| Scheduler tick (60s fallback + webhook-triggered ticks) | ≤60s worst case | Evaluation pass at the top of `tick()` for **every** queued task — independent of pool capacity (fixes the current gap where dep checks are skipped while the pool is saturated). Guarded by a pass-frequency floor (skip if last full pass <15s ago) so webhook bursts don't amplify into Forgejo fetch storms. |
| `issues` webhook, action `edited` (new handler case) | ~instant | Invalidate snapshot → evaluate that task → `triggerTick()` if it became eligible. Action name to be confirmed against the deployed Forgejo version in Task 4; the polling fallback covers a mismatch. |
| `issues` webhook, action `closed` (existing handler, new branch) | ~instant | Reverse-index lookup: evaluate queued dependents of the closed issue → `triggerTick()`. Covers both human closes and the orchestrator's own post-merge `closeIssue` (API actions emit webhooks). |
| Polling piggyback | ≤ poll interval | `detectExternalStateChanges` (`polling.ts`) already fetches every non-terminal task's issue; pass the body into the evaluator for queued tasks. Zero extra API calls. Covers lost webhooks. |

Defined sync semantics (all via re-derivation from the body):

- **Added** dep → new row; task may become blocked (UI-only).
- **Removed** dep → row hard-deleted.
- **Checked/unchecked** box → `manually-satisfied` ↔ re-derived state.
- Convergence: any Forgejo body edit is reflected within one poll interval
  even with zero webhooks delivered; typically sub-second via webhook.
- Timeline events `dependencies_blocked` / `dependencies_unblocked` are
  recorded on transitions (history only — not state; droppable if even that
  is unwanted).

## 5. Implementation sequence

Six tasks, each self-contained with unit tests, sized for a single
implementation agent. Sequence: T1 → T2 → T3 → T4; T5 and T6 are independent
of each other after T4.

### T1 — Types, migration, parser/formatter
`shared/types.ts`, `server/db.ts`, new `server/dependencies.ts` (parse /
format / upsert / validate only — no evaluator yet).
Row accessors: `getTaskDependencies`, `getDependentTaskIds`,
`upsertTaskDependency`, `deleteTaskDependency`.
**Unit tests**: parser (section location, termination, bullet variants,
checked flag, dedupe rules, outside-section ignored, cross-repo ignored,
heading-without-items, malformed numbers); formatter + upsert idempotency;
validation (self-ref, duplicates, 404, closed-dep warning).
**Acceptance**: module exports the contracts in §2.3; migration applies
cleanly on a v24 DB; no behaviour change anywhere else.

### T2 — Evaluation engine
`evaluateTaskDependencies` + ladder + cycle detection in `dependencies.ts`,
against a mocked Forgejo client and DB fixtures.
**Unit tests**: one per ladder row; reopen re-blocks (untracked) vs
merged-task stability; error anti-flap rule; row lifecycle
(add/remove/state-change only on change); PR-number dep (closed PR
satisfies); cycle pair + self-reference.
**Acceptance**: evaluator is pure with injected deps (client, db, clock) and
idempotent across repeated runs on unchanged input.

### T3 — Scheduler integration
`scheduler.ts`: evaluation pass (with 15s frequency floor) at the top of
`tick()`; `_fillSlotsInner` dep gate becomes a read of the persisted summary;
delete `checkDependenciesMet`/`parseDependencies` from `queue.ts` (tests move
to T1's suite). This is the riskiest slice — touch nothing else in the tick
flow (`fillSlotsInFlight` guard, pause semantics unchanged).
**Unit tests**: queued task with open dep never launches; launches next tick
after dep closes; saturated pool still evaluates; paused scheduler still
evaluates but never launches; frequency floor honoured.
**Acceptance**: behaviour identical to today for tasks with no `##
Dependencies` section.

### T4 — Forgejo sync triggers
`routes/webhooks.ts`: `edited` action handler; `closed` action gains the
reverse-index dependent evaluation. `polling.ts`: piggyback queued-task
bodies into the evaluator. Confirm the deployed Forgejo's `edited` action
name while implementing.
**Unit tests**: webhook handlers with synthetic payloads (edited add/remove/
tick; closed unblocks dependents); polling path feeds bodies without extra
fetches.
**Acceptance**: body edit on Forgejo converges sub-second with webhooks, ≤60s
without.

### T5 — API + UI surfacing
`routes/tasks.ts`: task detail returns `dependencies[]` + computed
`blocked`; list payload returns `blocked`; `POST
/api/tasks/:id/dependencies/recheck` runs the evaluator on demand.
`state-sync.ts`: broadcast on dep-record change.
UI: `TaskDetail.tsx` dependency panel (per dep: `#N` linked to Forgejo,
state chip, detail text, repair hint per state) + blocked badge;
`Dashboard.tsx` blocked badge + filter (task remains in the queued lane at
its queue position); `Help.tsx` syntax + states documentation.
Blocked is presentation-only: no `TaskStatus` change, no label sync, action
buttons remain those of `queued`.
**Unit tests**: payload shape; blocked computed correctly from fixtures.

### T6 — Intake
`mcp/server.ts`: `dependencies?: number[]` on `create_task` — validate via
`validateDependencies`, append canonical section server-side, document in the
tool description. `plugin/commands/create-task.md`: replace the "orchestrator
does not enforce ordering" paragraph with the real contract + syntax.
`CreateTask.tsx` + `routes/tasks.ts`: dependency multi-select (open issues
via the existing repo-issues endpoint) in both create-new and queue-existing
modes; for queue-existing the server edits the issue body via
`upsertDependencySection` (fetch immediately before write; last-writer-wins
accepted and logged). Prompt hygiene: strip the `## Dependencies` section
from bodies handed to dev/review agents.
**Unit tests**: MCP param validation paths; upsert-on-existing-section;
prompt stripping.
**Acceptance**: task created via MCP with `dependencies: [38]` yields a
canonical section and a queued task that launches only after #38 closes; the
agent prompt contains no dependency checklist.

## 6. Edge case matrix (defined outcomes)

| # | Case | Outcome | Repair (shown in panel) |
|---|---|---|---|
| 1 | Dep issue doesn't exist (404) | `missing`; blocked indefinitely | "Issue #N not found — fix or remove the reference, or tick the box" |
| 2 | Transient fetch error | previous state satisfied → stays satisfied; otherwise `error`, blocked, retried next pass | none (self-heals) |
| 3 | Dep issue closed (any reason — merged, won't-fix, manual) | `satisfied` | — |
| 4 | Dep tracked task `merged` but issue still open (best-effort close failed) | `satisfied` via DB shortcut; race-free | — |
| 5 | Dep issue reopened while dependent still queued | untracked: re-blocks on next evaluation. Tracked-merged: stays satisfied (merge happened) | — |
| 6 | Dep number is a PR | closed (merged or not) → `satisfied`; open → `open` | — |
| 7 | Self-reference | intake: rejected; via Forgejo edit: `cycle`, blocked | "Task depends on itself — remove or tick" |
| 8 | Cycle A→B→A (queued tasks) | both `cycle`, both blocked; intake rejects, evaluation detects | "Circular dependency with #M — break the cycle or tick one side" |
| 9 | Same dep listed checked **and** unchecked | unchecked wins (fail closed) | dedupe the lines |
| 10 | Box ticked on Forgejo | `manually-satisfied` next sync; unticking re-blocks | — |
| 11 | Checklist items outside the `## Dependencies` section | ignored (no live issues depend on the old body-wide parse) | — |
| 12 | `*`/`+` bullets, indentation inside the section | parsed (tolerant) | — |
| 13 | Cross-repo (`owner/repo#N`) or URL references | ignored by parser; documented unsupported | — |
| 14 | Dep's task `failed`/`cancelled`, issue open | `failed`, blocked | "Requeue task for #N (re-apply status/queued), close the issue, or tick" |
| 15 | Dep added to an issue whose task is already running (not `queued`) | records sync + display (warning chip); **no retroactive blocking** — gate covers `queued` only | cancel + requeue if ordering truly matters |
| 16 | All deps removed from body | rows deleted; unblocks next evaluation (instant via webhook, ≤60s otherwise) | — |
| 17 | Webhook lost / unconfigured | polling piggyback converges within one poll interval | — |
| 18 | Forgejo wholly unreachable | evaluation skipped; satisfied rows keep tasks eligible, everything else stays blocked; startup gate already pauses the scheduler if Forgejo is down | — |
| 19 | Body edited between evaluation and launch (same tick) | accepted ≤1-tick race — same class as the existing issue-closed launch race | — |
| 20 | Task soft-requeued via label after `failed` | dep rows kept; re-evaluated on next pass | — |
| 21 | Task reaches terminal state | rows kept for history (deleted only with the task row); evaluation stops (only `queued` evaluated) | — |
| 22 | Queue-existing intake adds deps to a body that already has a section | union merge, no duplicates, checked flags preserved | — |
| 23 | Concurrent human edit during intake's body write | last-writer-wins; server fetches immediately before writing and logs when the base differs | re-apply the lost edit |
| 24 | `## Dependencies` heading with no items | zero deps; not blocked | — |
| 25 | Duplicate dep lines (same state) | single row | — |
| 26 | Scheduler paused | evaluation still runs each tick (local writes + cached reads); launches stay paused | — |
| 27 | Webhook burst (bulk label ops → many ticks) | pass-frequency floor (15s) + snapshot TTL cap Forgejo reads | — |

## 7. Test plan (unit only)

Covered per task in §5. Cross-cutting fixtures: a fake Forgejo client
(programmable issue states, 404s, throwables) and an in-memory DB seeded via
the real migration. The existing e2e `it.todo` for dependency gating stays
as-is; no e2e or integration-suite work is in scope.

## 8. Rollout notes

- Net behaviour changes vs. today: section-scoped parsing (no live issues
  affected — confirmed), blocked visibility in the UI, sync of body edits,
  and the dep gate no longer being skipped while the pool is saturated.
  The completion rule (issue closed) is unchanged from current behaviour.
- No data backfill: records derive from bodies on the first evaluation pass.
- Migration is additive; downgrade-safe per the existing schema-version
  guard.

## 9. Accepted risks

| Risk | Disposition |
|---|---|
| Closed-without-work dep silently unblocks dependents (e.g. won't-fix close) | Accepted by design (closed = complete). The dependent's agent may build on absent work; the dep panel's `detail` shows what closed it, and review catches the rest. |
| `edited` webhook action name varies by Forgejo version | Verified during T4; polling fallback bounds the damage to ≤60s latency. |
| Issue-body read-modify-write race during intake | Accepted (last-writer-wins, logged); writes happen only on explicit user action. |
| Blocked is invisible outside the orchestrator UI | By decision (no Forgejo label). Forgejo users see only the unchecked checklist. |
