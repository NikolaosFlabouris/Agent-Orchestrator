import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

interface Meta {
  issue_id: number;
  branch_name: string;
  base_branch: string;
  max_runtime_minutes: number;
  attempt: number;
  role: 'develop' | 'review';
  pr_number: number | null;
  model: string;
  /** Audit snapshot of the harness id resolved at attempt-launch time. */
  harness_id: string;
  /** Audit snapshot of the agent profile id resolved at attempt-launch time. */
  agent_profile_id: string;
  install_commands: InstallCommand[];
  /** Empty string for SDK harnesses (this script reads `model` directly
   *  and runs the SDK call). Populated for CLI harnesses, which use
   *  harness-cli.sh instead. */
  agent_command: string;
}

interface InstallCommand {
  command: string;
  cwd: string;
}

interface Usage {
  num_turns?: number;
  input_tokens?: number;
  output_tokens?: number;
  tool_calls?: number;
}

interface Result {
  status: 'success' | 'failure' | 'timeout';
  exit_code: number;
  error_message: string | null;
  /** Per-run effort metrics, populated from the SDK's final `result`
   *  message when available. Optional and backward-compatible: when the
   *  SDK reports no usage the field is omitted and the orchestrator leaves
   *  the attempt's usage columns NULL. Raw counts only — no cost. */
  usage?: Usage;
}

/** The Claude Agent SDK streams messages; the final one has
 *  `type: 'result'` and carries `num_turns` plus a `usage` object with
 *  `input_tokens` / `output_tokens` (mirroring the Anthropic Messages API
 *  shape). Map that final message into our `Usage` shape, taking only the
 *  fields that are present as finite numbers. Returns undefined when the
 *  message isn't a usable result message — the caller then omits `usage`
 *  entirely so behaviour is unchanged from the no-usage harness.
 *
 *  Exported as a pure function so the mapping is unit-testable without
 *  driving a live SDK run. The token usage object can carry extra fields
 *  (cache_creation_input_tokens, etc.); only the prompt/completion totals
 *  are surfaced here. */
export function extractUsage(message: unknown): Usage | undefined {
  if (
    typeof message !== 'object' ||
    message === null ||
    (message as { type?: unknown }).type !== 'result'
  ) {
    return undefined;
  }
  const m = message as {
    num_turns?: unknown;
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  };
  const usage: Usage = {};
  if (typeof m.num_turns === 'number' && Number.isFinite(m.num_turns)) {
    usage.num_turns = m.num_turns;
  }
  const u = m.usage;
  if (u && typeof u === 'object') {
    if (typeof u.input_tokens === 'number' && Number.isFinite(u.input_tokens)) {
      usage.input_tokens = u.input_tokens;
    }
    if (
      typeof u.output_tokens === 'number' &&
      Number.isFinite(u.output_tokens)
    ) {
      usage.output_tokens = u.output_tokens;
    }
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

const meta: Meta = JSON.parse(readFileSync('/task/meta.json', 'utf-8'));
// prompt.md is the complete prompt — including review feedback on rework cycles.
// The orchestrator assembles the full prompt before the container starts.
const prompt = readFileSync('/task/prompt.md', 'utf-8');

// The orchestrator's harness layer is the source of truth for what
// model this run should target — it resolves `meta.model` from the
// agent profile and writes it into meta.json at launch. An empty/
// missing value here means the orchestrator produced a malformed
// launch context, not that we should silently fall back to a guess.
// Fail loudly so the bug surfaces immediately rather than running
// against an unintended model.
if (!meta.model || typeof meta.model !== 'string') {
  writeFileSync(
    '/output/result.json',
    JSON.stringify({
      status: 'failure',
      exit_code: 1,
      error_message:
        "meta.model missing or empty — orchestrator failed to resolve a model id at launch time. " +
        "Check the agent profile's model_pk and the provider/model rows.",
    })
  );
  process.exit(0);
}

// Run install steps sequentially under a single flock against the shared
// /cache mount. The lock prevents two containers on the same repo racing on
// the dependency cache. Each step runs in its declared cwd. The orchestrator
// pre-resolves typed install_steps into literal commands; the harness never
// sees free-text input from operators.
// The lock wait is sized for the slowest realistic cold-cache install holding
// the lock (10-15 minutes for multi-step npm ci + go mod download + tool
// provisioning) so queued siblings aren't failed for waiting their turn.
// Keep in sync with harness-cli.sh.
const INSTALL_LOCK_WAIT_SECONDS = 1800;
if (meta.install_commands && meta.install_commands.length > 0) {
  for (const step of meta.install_commands) {
    try {
      execSync(
        `flock -w ${INSTALL_LOCK_WAIT_SECONDS} /cache/.dep-install-lock sh -c ${JSON.stringify(step.command)}`,
        { cwd: step.cwd, stdio: 'inherit' }
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      writeFileSync(
        '/output/result.json',
        JSON.stringify({
          status: 'failure',
          exit_code: 1,
          error_message: `Install step failed (${step.command} in ${step.cwd}): ${msg}`,
        })
      );
      process.exit(0);
    }
  }
}

async function main() {
  const result: Result = {
    status: 'success',
    exit_code: 0,
    error_message: null,
  };
  const timeoutMs = meta.max_runtime_minutes * 60 * 1000;
  const timer = setTimeout(() => {
    result.status = 'timeout';
    result.exit_code = 124;
    result.error_message =
      'Agent exceeded timeout of ' + meta.max_runtime_minutes + ' minutes';
    writeFileSync('/output/result.json', JSON.stringify(result));
    process.exit(0);
  }, timeoutMs);

  try {
    // No allowedTools allowlist — agent containers are ephemeral, non-root,
    // and isolated on the agent-network bridge. The orchestrator's trust model
    // is "give the agent full capability inside its sandbox", not restrict-
    // list tools. bypassPermissions grants all tools including Write/MultiEdit/
    // TodoWrite/NotebookEdit/WebFetch/WebSearch.
    // No maxTurns cap. The orchestrator's wall-clock timeout
    // (`meta.max_runtime_minutes`, set by `agent_timeout_minutes`) is the
    // lifetime safety net; relying on a turn count too is double-counting
    // the same concern. The SDK applies its own internal default to keep
    // pathological loops bounded inside an attempt.
    for await (const message of query({
      prompt,
      options: {
        permissionMode: 'bypassPermissions',
        model: meta.model,
      },
    })) {
      writeFileSync('/output/progress.log', JSON.stringify(message) + '\n', {
        flag: 'a',
      });
      // The SDK emits a final `result` message with turn/token usage. Keep
      // the latest one we see; whatever survives the loop is the run's
      // authoritative usage summary.
      const u = extractUsage(message);
      if (u) result.usage = u;
    }
  } catch (error: unknown) {
    result.status = 'failure';
    result.exit_code = 1;
    result.error_message =
      error instanceof Error ? error.message : String(error);
  }

  clearTimeout(timer);

  // For review agents, verify review.json was produced
  if (meta.role === 'review') {
    try {
      const review = JSON.parse(readFileSync('/output/review.json', 'utf-8'));
      if (!review.verdict) throw new Error('No verdict');
    } catch {
      result.status = 'failure';
      result.error_message =
        result.error_message || 'Review agent did not produce a valid review.json';
    }
  }

  writeFileSync('/output/result.json', JSON.stringify(result));
}

main();
