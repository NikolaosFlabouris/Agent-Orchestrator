import { looksLikeUsageLimit } from './smoke/outcome.js';

// ---------------------------------------------------------------------------
// Agent-attempt failure classifier (#208).
//
// Decides whether a failed agent attempt is worth retrying. Some failures are
// properties of the environment (agent image, credentials, model config) and
// fail identically on every relaunch — retrying them just burns the task's
// attempts in seconds. Those are `permanent`; everything else is `retryable`.
//
// The pattern list is deliberately narrow. A false positive stops a task that
// might have succeeded on retry; a false negative only costs today's
// behaviour (retry until max_attempts). Matching is over the error text alone,
// so it is independent of which harness produced it — harness-cli.sh records
// Claude Code result events as `[API <status>] <text>`, other harnesses
// record their own text.
// ---------------------------------------------------------------------------

export type PermanentFailureCategory = 'cli_outdated' | 'auth' | 'unknown_model';

export type FailureClassification =
  | { kind: 'retryable'; reason: string }
  | { kind: 'permanent'; category: PermanentFailureCategory; reason: string };

/** Exit code harness-cli.sh uses for an agent that hit its timeout. */
const TIMEOUT_EXIT_CODE = 124;

/** HTTP status shapes seen in recorded error messages: harness-cli.sh's
 *  `[API 401]` prefix, Claude Code's `API Error: 401`, and generic
 *  `HTTP 401` / `status: 401` / `"status":401` forms. */
const STATUS_PATTERNS = [
  /\[API (\d{3})\]/,
  /\bAPI Error:?\s*(\d{3})\b/i,
  /\bHTTP(?:\s+status)?(?:\s+code)?:?\s*(\d{3})\b/i,
  /"(?:api_error_)?status(?:_code)?"\s*:\s*"?(\d{3})\b/,
  /\bstatus(?:\s+code)?:?\s*(\d{3})\b/i,
];

function httpStatuses(text: string): Set<number> {
  const out = new Set<number>();
  for (const re of STATUS_PATTERNS) {
    const m = re.exec(text);
    if (m) out.add(Number(m[1]));
  }
  return out;
}

const CLI_OUTDATED_PATTERNS = [
  /does not support this model/i,
  /version \S+ or newer is required/i,
];

/** Only trusted alongside an HTTP 401/403. */
const AUTH_PATTERNS = [
  /\bauthentication_error\b/,
  /API key is invalid/i,
  /invalid x-api-key/i,
  /\bpermission_error\b/,
];

/** Unknown-model messages that are specific enough on their own. */
const UNKNOWN_MODEL_PATTERNS = [
  /model not found/i,
  /no router for requested model/i,
];

const HINTS: Record<PermanentFailureCategory, string> = {
  cli_outdated:
    'The agent CLI in the agent image is too old for the configured model. Update and rebuild the agent image (`docker compose up -d --build`)',
  auth:
    'The provider rejected the credentials. Check the provider credentials (API key / auth token) configured for this agent profile',
  unknown_model:
    'The provider does not recognise the configured model. Check the model id in the agent profile',
};

/** Operator-facing remediation hint for a permanent failure category. */
export function permanentFailureHint(category: PermanentFailureCategory): string {
  return HINTS[category];
}

/**
 * Classify a failed attempt from its recorded `error_message` and exit code.
 * Anything not positively recognised as permanent is `retryable`.
 */
export function classifyFailure(
  errorMessage: string | null | undefined,
  exitCode?: number | null
): FailureClassification {
  const text = (errorMessage ?? '').trim();
  if (!text) {
    return { kind: 'retryable', reason: 'no error message' };
  }
  if (exitCode === TIMEOUT_EXIT_CODE) {
    return { kind: 'retryable', reason: 'agent timed out' };
  }

  const statuses = httpStatuses(text);
  // Usage and rate limits are transient by definition — never permanent,
  // even if the text happens to also mention something below.
  if (statuses.has(429) || looksLikeUsageLimit(text)) {
    return { kind: 'retryable', reason: 'usage or rate limit' };
  }

  if (CLI_OUTDATED_PATTERNS.some((re) => re.test(text))) {
    return {
      kind: 'permanent',
      category: 'cli_outdated',
      reason: 'agent CLI too old for the configured model',
    };
  }

  if (
    (statuses.has(401) || statuses.has(403)) &&
    AUTH_PATTERNS.some((re) => re.test(text))
  ) {
    return {
      kind: 'permanent',
      category: 'auth',
      reason: 'provider authentication failed',
    };
  }

  if (
    UNKNOWN_MODEL_PATTERNS.some((re) => re.test(text)) ||
    (statuses.has(404) && /\bnot_found_error\b/.test(text) && /\bmodel\b/i.test(text))
  ) {
    return {
      kind: 'permanent',
      category: 'unknown_model',
      reason: 'provider does not recognise the configured model',
    };
  }

  return { kind: 'retryable', reason: 'unrecognised error' };
}
