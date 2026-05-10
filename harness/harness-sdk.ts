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

interface Result {
  status: 'success' | 'failure' | 'timeout';
  exit_code: number;
  error_message: string | null;
  usage: { input_tokens: number; output_tokens: number; model: string } | null;
}

const meta: Meta = JSON.parse(readFileSync('/task/meta.json', 'utf-8'));
// prompt.md is the complete prompt — including review feedback on rework cycles.
// The orchestrator assembles the full prompt before the container starts.
const prompt = readFileSync('/task/prompt.md', 'utf-8');

// Run install steps sequentially under a single flock against the shared
// /cache mount. The lock prevents two containers on the same repo racing on
// the dependency cache. Each step runs in its declared cwd. The orchestrator
// pre-resolves typed install_steps into literal commands; the harness never
// sees free-text input from operators.
if (meta.install_commands && meta.install_commands.length > 0) {
  for (const step of meta.install_commands) {
    try {
      execSync(
        `flock -w 300 /cache/.dep-install-lock sh -c ${JSON.stringify(step.command)}`,
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
          usage: null,
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
    usage: null,
  };
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    model: meta.model || 'sonnet',
  };
  const timeoutMs = meta.max_runtime_minutes * 60 * 1000;
  const timer = setTimeout(() => {
    result.status = 'timeout';
    result.exit_code = 124;
    result.error_message =
      'Agent exceeded timeout of ' + meta.max_runtime_minutes + ' minutes';
    result.usage = usage;
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
        model: meta.model || 'sonnet',
      },
    })) {
      // Accumulate token usage from each message
      if ((message as any).usage) {
        usage.input_tokens += (message as any).usage.input_tokens || 0;
        usage.output_tokens += (message as any).usage.output_tokens || 0;
      }
      writeFileSync('/output/progress.log', JSON.stringify(message) + '\n', {
        flag: 'a',
      });
    }
  } catch (error: unknown) {
    result.status = 'failure';
    result.exit_code = 1;
    result.error_message =
      error instanceof Error ? error.message : String(error);
  }

  clearTimeout(timer);
  result.usage = usage;

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
