import type { HarnessId } from '@orchestrator/shared';

// ---------------------------------------------------------------------------
// Harness smoke test: outcome classification, promotable rule, redaction and
// reporting. Pure functions — the decision is deterministic code over
// structural signals (result.json status, a runner-side check of the fix,
// tool-call events), never over the model's prose.
// ---------------------------------------------------------------------------

export type SmokeOutcome = 'pass' | 'fail' | 'skipped' | 'not_live_tested';

export interface Classification {
  outcome: SmokeOutcome;
  /** Machine-readable reason; null on pass. */
  reason: string | null;
  /** Raw (unredacted) detail — the caller redacts before reporting. */
  detail?: string;
}

/** Everything the runner observed about one live attempt. */
export interface LiveObservation {
  /** Preflight connectivity check to the provider endpoint. */
  reachable: boolean;
  /** The per-case timeout fired. */
  timedOut: boolean;
  /** The overall run deadline fired (or had passed before launch). */
  overallDeadlineHit: boolean;
  /** Local (free) endpoint — a timeout there is most often a cold model
   *  load, not an incompatibility. */
  localProvider: boolean;
  /** Contents of the harness's /output/result.json, if it wrote one. */
  result: { status?: unknown; error_message?: unknown } | null;
  /** progress.log contents (the agent CLI's event stream + harness markers). */
  log: string;
  /** Runner-side check that calc.add was fixed; null if it couldn't run. */
  fixVerified: boolean | null;
  /** Tool calls seen in the event stream; null when the harness's stream
   *  doesn't expose them. */
  toolCalls: number | null;
  /** Launch-side error (container create/start threw). */
  launchError?: string;
}

/** Usage- or rate-limit signals. `Provider usage limit detected` is the
 *  marker harness-cli.sh writes when it parks on a limit; the rest match
 *  an agent's own error text (Claude Code's result event, result.json's
 *  error_message). */
const USAGE_LIMIT_PATTERNS = [
  /Provider usage limit detected/,
  /usage limit/i,
  /session limit/i,
  /rate[ _-]?limit/i,
  /too many requests/i,
  /"api_error_status"\s*:\s*"?429\b/,
  /\bAPI 429\b/,
];

export function looksLikeUsageLimit(text: string): boolean {
  return USAGE_LIMIT_PATTERNS.some((re) => re.test(text));
}

/** Only the harness marker and Claude Code's structured result events are
 *  trusted while the container is still running — model prose could say
 *  "rate limit" in passing. */
export function logShowsUsageLimit(log: string): boolean {
  if (/Provider usage limit detected/.test(log)) return true;
  for (const ev of parseJsonLines(log)) {
    if (ev.type !== 'result' || ev.is_error !== true) continue;
    const status = String(ev.api_error_status ?? '');
    const text = typeof ev.result === 'string' ? ev.result : '';
    if (status === '429' || /usage limit|session limit|rate limit/i.test(text)) {
      return true;
    }
  }
  return false;
}

export function classifyLiveAttempt(o: LiveObservation): Classification {
  if (!o.reachable) {
    return { outcome: 'skipped', reason: 'provider_unreachable' };
  }
  if (o.launchError !== undefined) {
    return { outcome: 'fail', reason: 'launch_error', detail: o.launchError };
  }
  const resultError =
    typeof o.result?.error_message === 'string' ? o.result.error_message : '';
  if (logShowsUsageLimit(o.log) || (resultError && looksLikeUsageLimit(resultError))) {
    return { outcome: 'skipped', reason: 'usage_limit', detail: resultError || undefined };
  }
  if (o.overallDeadlineHit) {
    return { outcome: 'skipped', reason: 'overall_timeout' };
  }
  // harness-cli.sh's own deadline (result status `timeout`) is the same
  // condition as the runner's timer firing first.
  if (o.timedOut || o.result?.status === 'timeout') {
    return o.localProvider
      ? { outcome: 'skipped', reason: 'local_model_timeout' }
      : { outcome: 'fail', reason: 'timeout' };
  }
  if (!o.result) {
    return { outcome: 'fail', reason: 'no_result', detail: tail(o.log, 5) };
  }
  if (o.result.status !== 'success') {
    return {
      outcome: 'fail',
      reason: `result_${String(o.result.status ?? 'unknown')}`,
      detail: resultError || tail(o.log, 5),
    };
  }
  if (o.fixVerified !== true) {
    return {
      outcome: 'fail',
      reason: 'fix_not_verified',
      detail: o.fixVerified === null ? 'verification could not run' : tail(o.log, 5),
    };
  }
  if (o.toolCalls !== null && o.toolCalls < 1) {
    return { outcome: 'fail', reason: 'no_tool_calls' };
  }
  return { outcome: 'pass', reason: null };
}

function tail(text: string, lines: number): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}

// ---------------------------------------------------------------------------
// Tool-call detection
// ---------------------------------------------------------------------------

function parseJsonLines(log: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of log.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const v = JSON.parse(t) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        out.push(v as Record<string, unknown>);
      }
    } catch {
      /* not an event line (e.g. --print-logs output) */
    }
  }
  return out;
}

/** Count tool calls in a harness's event stream. Returns null for a
 *  harness whose stream has no tool-call events we know how to read (the
 *  check is then skipped rather than failed).
 *    - claude-code (stream-json): assistant messages with `tool_use` blocks.
 *    - opencode (--format json): `{"type":"tool_use", ...}` events.
 *    - pi (--mode json): `tool_execution_start` events. */
export function countToolCalls(harnessId: HarnessId, log: string): number | null {
  const events = parseJsonLines(log);
  switch (harnessId) {
    case 'claude-code': {
      let n = 0;
      for (const ev of events) {
        if (ev.type !== 'assistant') continue;
        const content = (ev.message as { content?: unknown } | undefined)?.content;
        if (!Array.isArray(content)) continue;
        n += content.filter(
          (b) => (b as { type?: unknown } | null)?.type === 'tool_use'
        ).length;
      }
      return n;
    }
    case 'opencode':
      return events.filter((ev) => ev.type === 'tool_use').length;
    case 'pi':
      return events.filter((ev) => ev.type === 'tool_execution_start').length;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const REDACTED = '[REDACTED]';

/** Build a redactor that strips every known credential value plus common
 *  token shapes. Applied to everything that leaves the runner (stdout,
 *  stderr, the JSON report). */
export function makeRedactor(secrets: Iterable<string>): (text: string) => string {
  // Longest first so a secret that contains another is removed whole.
  const values = [...new Set([...secrets].filter((s) => s.length >= 4))].sort(
    (a, b) => b.length - a.length
  );
  return (text: string) => {
    let out = text;
    for (const v of values) out = out.split(v).join(REDACTED);
    return out
      .replace(/sk-ant-[A-Za-z0-9_-]+/g, REDACTED)
      .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED)
      .replace(/(Bearer\s+)[^\s"']+/gi, `$1${REDACTED}`);
  };
}

/** Short excerpt for the report: redacted and capped. */
export function excerpt(
  text: string | undefined,
  redact: (s: string) => string,
  max = 500
): string | null {
  if (!text) return null;
  const r = redact(text).trim();
  return r.length > max ? `…${r.slice(-max)}` : r;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface CaseResult {
  key: string;
  harness_id: HarnessId;
  profile_ids: string[];
  sources: Array<'profile' | 'builtin'>;
  provider_id: string;
  provider_kind: string | null;
  model_id: string;
  /** Cost rule verdict: may this case make a live call? */
  live_eligible: boolean;
  outcome: SmokeOutcome;
  reason: string | null;
  error_excerpt: string | null;
  /** Live attempts made (0 for static-only cases; 2 after a retry). */
  attempts: number;
  duration_ms: number;
}

export interface StaticCheckResult {
  harness_id: HarnessId;
  check: string;
  outcome: 'pass' | 'fail' | 'skipped';
  reason: string | null;
  error_excerpt: string | null;
}

export interface CliVersions {
  'claude-code': string | null;
  opencode: string | null;
  pi: string | null;
  'claude-agent-sdk': string | null;
}

export interface SmokeReport {
  image: string;
  started_at: string;
  finished_at: string;
  versions: CliVersions;
  promotable: boolean;
  /** Why `promotable` is false (empty when it is true). */
  promotable_blockers: string[];
  counts: Record<SmokeOutcome, number>;
  static_checks: StaticCheckResult[];
  cases: CaseResult[];
}

/** Promotable = no `fail` anywhere, and every harness that has a free
 *  route (at least one live-eligible case) has at least one passing live
 *  case. A skipped case never counts as a fail, but a harness whose free
 *  routes were ALL skipped hasn't been proven to work, so it blocks. */
export function computePromotable(
  cases: CaseResult[],
  staticChecks: StaticCheckResult[]
): { promotable: boolean; blockers: string[] } {
  const blockers: string[] = [];
  for (const c of cases) {
    if (c.outcome === 'fail') blockers.push(`case ${c.key} failed (${c.reason})`);
  }
  for (const s of staticChecks) {
    if (s.outcome === 'fail') {
      blockers.push(`static check ${s.harness_id}/${s.check} failed (${s.reason})`);
    }
  }
  const freeHarnesses = new Set(cases.filter((c) => c.live_eligible).map((c) => c.harness_id));
  for (const h of freeHarnesses) {
    const passed = cases.some(
      (c) => c.harness_id === h && c.live_eligible && c.outcome === 'pass'
    );
    if (!passed) blockers.push(`harness ${h} has a free route but no passing live case`);
  }
  return { promotable: blockers.length === 0, blockers };
}

export function hasFailures(report: Pick<SmokeReport, 'cases' | 'static_checks'>): boolean {
  return (
    report.cases.some((c) => c.outcome === 'fail') ||
    report.static_checks.some((s) => s.outcome === 'fail')
  );
}

export function countOutcomes(
  cases: CaseResult[],
  staticChecks: StaticCheckResult[]
): Record<SmokeOutcome, number> {
  const counts: Record<SmokeOutcome, number> = {
    pass: 0,
    fail: 0,
    skipped: 0,
    not_live_tested: 0,
  };
  for (const c of cases) counts[c.outcome]++;
  for (const s of staticChecks) counts[s.outcome]++;
  return counts;
}

/** Human-readable summary for stdout. */
export function formatSummary(report: SmokeReport): string {
  const lines: string[] = [];
  lines.push(`Harness smoke test — image ${report.image}`);
  lines.push('');
  lines.push('CLI versions:');
  for (const [k, v] of Object.entries(report.versions)) {
    lines.push(`  ${k.padEnd(17)} ${v ?? '(not found)'}`);
  }
  lines.push('');
  lines.push('Static checks:');
  for (const s of report.static_checks) {
    lines.push(
      `  ${s.outcome.toUpperCase().padEnd(8)} ${s.harness_id}/${s.check}` +
        (s.reason ? ` — ${s.reason}` : '')
    );
    if (s.outcome !== 'pass' && s.error_excerpt) lines.push(indent(s.error_excerpt));
  }
  lines.push('');
  lines.push('Cases:');
  for (const c of report.cases) {
    const who = c.profile_ids.length ? ` [${c.profile_ids.join(', ')}]` : ' [built-in]';
    lines.push(
      `  ${c.outcome.toUpperCase().padEnd(15)} ${c.key}${who}` +
        (c.reason ? ` — ${c.reason}` : '')
    );
    if (c.outcome === 'fail' && c.error_excerpt) lines.push(indent(c.error_excerpt));
  }
  lines.push('');
  const n = report.counts;
  lines.push(
    `Totals: ${n.pass} pass, ${n.fail} fail, ${n.skipped} skipped, ${n.not_live_tested} not live-tested`
  );
  lines.push(`Promotable: ${report.promotable ? 'yes' : 'no'}`);
  for (const b of report.promotable_blockers) lines.push(`  - ${b}`);
  return lines.join('\n');
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((l) => `      ${l}`)
    .join('\n');
}
