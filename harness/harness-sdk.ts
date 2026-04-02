import { query } from '@anthropic-ai/agent-sdk';
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
  max_turns: number;
  pre_agent_script: string | null;
  agent_tool: string;
  agent_command: string;
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

// Run pre-agent script (dependency install) with file lock on shared cache volume.
// The lock prevents two containers on the same repo from running npm ci / pip install
// simultaneously against the shared dependency cache mount.
if (meta.pre_agent_script) {
  try {
    execSync(
      `flock -w 300 /cache/.dep-install-lock ${meta.pre_agent_script}`,
      { cwd: '/repo', stdio: 'inherit' }
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    writeFileSync(
      '/output/result.json',
      JSON.stringify({
        status: 'failure',
        exit_code: 1,
        error_message: 'Pre-agent script failed: ' + msg,
        usage: null,
      })
    );
    process.exit(0);
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
    for await (const message of query({
      prompt,
      options: {
        allowedTools: ['Read', 'Edit', 'Bash', 'Glob', 'Grep'],
        permissionMode: 'bypassPermissions',
        model: meta.model || 'sonnet',
        maxTurns: meta.max_turns || 100,
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
