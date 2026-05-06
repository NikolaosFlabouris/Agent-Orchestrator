/**
 * Seed the providers and agent_tools tables with the documented defaults.
 *
 * Run once after first `docker compose up -d`, or any time you want to reset
 * the default config. Existing rows with the same id are NOT overwritten —
 * configure-via-UI edits are preserved. Pass --force to upsert.
 *
 * Providers are seeded first because agent_tools.provider_id references
 * providers(id). Each tool is linked to a provider so concurrency pools
 * apply out of the box (Anthropic-API tools share one bucket, local-Ollama
 * tools share another).
 *
 * Usage:
 *   npm run seed:tools                  (inside orchestrator container or local node env)
 *   docker compose exec orchestrator node /app/scripts/seed-agent-tools.js --force
 *
 * The script writes to the same SQLite file the server reads from
 * (DATA_DIR / DB_PATH). Run after the server has started at least once so
 * the schema is initialized.
 */
import Database from 'better-sqlite3';
import path from 'node:path';

interface ProviderSeed {
  id: string;
  display_name: string;
  /** 0 = paused. Respected in addition to settings.max_concurrency. */
  concurrency_limit: number;
  notes: string | null;
}

interface ToolSeed {
  id: string;
  display_name: string;
  type: 'sdk' | 'cli';
  command_template: string | null;
  env_vars: Record<string, string> | Record<string, unknown>;
  auth_type: 'api-key' | 'none';
  auth_config: { env_var?: string; required?: boolean; optional?: boolean };
  /** Per-tool runtime cap (minutes). Null = fall through to repo/global. */
  timeout_minutes: number | null;
  /** Provider this tool pools against. Null = no pool (global ceiling only). */
  provider_id: string | null;
}

// Providers represent upstream resources with their own concurrency budgets:
// an API key's rate-limit bucket, a specific Ollama server, etc. Tools
// assigned to the same provider serialise against its concurrency_limit;
// tools on different providers run in parallel up to settings.max_concurrency.
const DEFAULT_PROVIDERS: ProviderSeed[] = [
  {
    id: 'anthropic-api',
    display_name: 'Anthropic API',
    concurrency_limit: 5,
    notes: null,
  },
  {
    id: 'ollama-local',
    display_name: 'Local Ollama',
    concurrency_limit: 1,
    notes: null,
  },
];

// Documented defaults — keep in sync with docs/04-agent-harness.md and docs/Agents.md.
// CLI tools use {{PROMPT_FILE}} so the prompt is read from a file by the tool,
// not interpolated into bash -c (see harness-cli.sh for the placeholder logic).
const DEFAULT_TOOLS: ToolSeed[] = [
  {
    id: 'claude-agent-sdk',
    display_name: 'Claude Agent SDK',
    type: 'sdk',
    command_template: null,
    env_vars: {},
    auth_type: 'api-key',
    auth_config: { env_var: 'ANTHROPIC_API_KEY', required: true },
    // Paid API — keep a sane budget cap.
    timeout_minutes: null,
    provider_id: 'anthropic-api',
  },
  {
    id: 'claude-code-cli',
    display_name: 'Claude Code CLI',
    type: 'cli',
    // Claude Code reads the prompt from stdin in --print (non-interactive) mode.
    // --output-format stream-json yields per-message JSON the harness uses for
    // token-usage extraction. --dangerously-skip-permissions bypasses approval
    // prompts (safe inside the ephemeral non-root container).
    command_template:
      'claude --print --dangerously-skip-permissions --output-format stream-json --max-turns 100 < {{PROMPT_FILE}}',
    env_vars: {},
    auth_type: 'api-key',
    auth_config: { env_var: 'ANTHROPIC_API_KEY', required: true },
    timeout_minutes: null,
    provider_id: 'anthropic-api',
  },
  {
    id: 'opencode-anthropic',
    display_name: 'OpenCode (Anthropic API)',
    type: 'cli',
    // OpenCode flags verified against opencode-ai@1.14.19:
    //   - positional message arg
    //   - --model provider/model
    //   - --format json (machine-readable event stream)
    //   - --dangerously-skip-permissions (no approval prompts in container)
    //   - --print-logs (logs to stderr, captured by harness)
    // Provider auth comes from `opencode auth login` or provider-specific env
    // vars. For Anthropic, ANTHROPIC_API_KEY is read automatically.
    command_template:
      'opencode run "$(cat {{PROMPT_FILE}})" --model anthropic/claude-sonnet-4-20250514 --format json --dangerously-skip-permissions --print-logs',
    env_vars: {},
    auth_type: 'api-key',
    auth_config: { env_var: 'ANTHROPIC_API_KEY', required: true },
    timeout_minutes: null,
    provider_id: 'anthropic-api',
  },
  {
    id: 'opencode-local',
    display_name: 'OpenCode (Local Ollama)',
    type: 'cli',
    // Edit --model to match a model installed on your Ollama server. Ollama
    // host can be configured via OLLAMA_HOST env var; defaults to host.docker.internal:11434.
    // env_vars here is the OpenCode config shape (written to /repo/opencode.json
    // by the orchestrator when it contains a top-level `provider` key).
    command_template:
      'opencode run "$(cat {{PROMPT_FILE}})" --model ollama/qwen2.5-coder:14b --format json --dangerously-skip-permissions --print-logs',
    env_vars: {
      $schema: 'https://opencode.ai/config.json',
      provider: {
        ollama: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Ollama',
          options: { baseURL: 'http://host.docker.internal:11434/v1' },
          models: { 'qwen2.5-coder:14b': { name: 'Qwen2.5 Coder 14B' } },
        },
      },
      permission: { '*': 'allow' },
    },
    auth_type: 'none',
    auth_config: { env_var: 'OPENCODE_API_KEY', optional: true },
    // Local/free — allow long-running tasks. Single generation on a large model
    // can take minutes, and a full task may need dozens of tool-call rounds.
    timeout_minutes: 2880, // 48 hours
    provider_id: 'ollama-local',
  },
  {
    id: 'pi-anthropic',
    display_name: 'pi (Anthropic API)',
    type: 'cli',
    // pi-coding-agent flags verified against @mariozechner/pi-coding-agent@0.68.0:
    //   - -p / --print         : non-interactive mode (process prompt and exit)
    //   - --model <provider>/<id> : e.g. anthropic/claude-sonnet-4-5
    //   - --mode json          : machine-readable JSON event stream (text|json|rpc)
    //   - --no-session         : don't persist a session (ephemeral, correct for
    //                            one-shot container runs with no writable home)
    // pi reads ANTHROPIC_API_KEY from the environment automatically — no config
    // file needed for the Anthropic provider.
    // The prompt is passed via `@{{PROMPT_FILE}}` which instructs pi to read the
    // file as the initial user message content (see `pi @file "msg"` syntax
    // in `pi --help`). This avoids shell-quoting and stays compatible with the
    // CLI harness's {{PROMPT_FILE}} substitution.
    command_template:
      'pi -p --mode json --no-session --model anthropic/claude-sonnet-4-5 @{{PROMPT_FILE}}',
    env_vars: {},
    auth_type: 'api-key',
    auth_config: { env_var: 'ANTHROPIC_API_KEY', required: true },
    // Paid API — fall through to repo/global default.
    timeout_minutes: null,
    provider_id: 'anthropic-api',
  },
  {
    id: 'pi-ollama',
    display_name: 'pi (Local Ollama)',
    type: 'cli',
    // pi does not have a dedicated OLLAMA_HOST env var or --base-url flag:
    // custom providers are configured via ~/.pi/agent/models.json (see pi docs
    // /docs/models.md inside the installed package). We bootstrap a minimal
    // models.json in the command template before invoking pi, so pi-ollama
    // works out of the box with no post-install UI tweaking. Edit the model
    // id to match what's pulled on your Ollama server. apiKey is a dummy
    // value — Ollama ignores it but pi's config schema requires the field.
    command_template:
      'mkdir -p ~/.pi/agent && printf \'%s\' \'{"providers":{"ollama":{"baseUrl":"http://host.docker.internal:11434/v1","api":"openai-completions","apiKey":"ollama","compat":{"supportsDeveloperRole":false,"supportsReasoningEffort":false},"models":[{"id":"qwen2.5-coder:14b"}]}}}\' > ~/.pi/agent/models.json && pi -p --mode json --no-session --model ollama/qwen2.5-coder:14b @{{PROMPT_FILE}}',
    env_vars: {},
    auth_type: 'none',
    auth_config: {},
    // Local/free — same long-running cap as opencode-local.
    timeout_minutes: 2880, // 48 hours
    provider_id: 'ollama-local',
  },
];

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

function main(): void {
  const force = process.argv.includes('--force');
  const dataDir = process.env.DATA_DIR ?? process.cwd();
  const dbPath = process.env.DB_PATH ?? path.join(dataDir, 'orchestrator.db');

  console.log(`Opening database at ${dbPath}`);
  const db = new Database(dbPath);

  // Verify schema exists — server must have booted at least once.
  for (const required of ['providers', 'agent_tools']) {
    if (!tableExists(db, required)) {
      console.error(
        `${required} table not found. Start the orchestrator server at least once to initialize the schema, then re-run this script.`
      );
      process.exit(1);
    }
  }

  const verb = force ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE';

  // Providers must exist before tools so the FK on agent_tools.provider_id
  // resolves on insert.
  console.log('\nSeeding providers...');
  const providerStmt = db.prepare(
    `${verb} INTO providers (id, display_name, concurrency_limit, notes) VALUES (?, ?, ?, ?)`
  );
  let providersInserted = 0;
  let providersSkipped = 0;
  for (const provider of DEFAULT_PROVIDERS) {
    const info = providerStmt.run(
      provider.id,
      provider.display_name,
      provider.concurrency_limit,
      provider.notes
    );
    if (info.changes === 1) {
      providersInserted++;
      console.log(`  ${force ? 'upserted' : 'inserted'}: ${provider.id}`);
    } else {
      providersSkipped++;
      console.log(`  skipped (already present): ${provider.id}`);
    }
  }

  console.log('\nSeeding agent tools...');
  const toolStmt = db.prepare(
    `${verb} INTO agent_tools (id, display_name, type, command_template, env_vars, auth_type, auth_config, timeout_minutes, provider_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let toolsInserted = 0;
  let toolsSkipped = 0;
  for (const tool of DEFAULT_TOOLS) {
    const info = toolStmt.run(
      tool.id,
      tool.display_name,
      tool.type,
      tool.command_template,
      JSON.stringify(tool.env_vars),
      tool.auth_type,
      JSON.stringify(tool.auth_config),
      tool.timeout_minutes,
      tool.provider_id
    );
    if (info.changes === 1) {
      toolsInserted++;
      console.log(`  ${force ? 'upserted' : 'inserted'}: ${tool.id}`);
    } else {
      toolsSkipped++;
      console.log(`  skipped (already present): ${tool.id}`);
    }
  }

  const action = force ? 'upserted' : 'inserted';
  console.log(
    `\nDone. Providers: ${providersInserted} ${action}, ${providersSkipped} skipped. Tools: ${toolsInserted} ${action}, ${toolsSkipped} skipped.`
  );
  console.log(
    'Review and edit via the Settings > Providers and Settings > Agent Tools tabs in the web UI.'
  );

  db.close();
}

main();
