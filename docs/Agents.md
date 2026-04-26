# Agent Tools

Agent tools are the LLM-powered programs that the orchestrator runs inside Docker containers to complete tasks. Each tool defines how the agent is invoked, what LLM it talks to, and what credentials it needs.

## Concepts

An **agent tool** is a named configuration with:

- **Type** — `cli` (command-line tool like OpenCode) or `sdk` (programmatic like Claude Agent SDK)
- **Command template** — the shell command that runs inside the container (CLI tools only). Use the `{{PROMPT_FILE}}` placeholder (replaced with the literal path `/task/prompt.md`) so the prompt content never reaches the shell as code and is immune to metacharacters in user-authored issue bodies.
- **Environment variables** — non-secret config passed to the container (provider, model, base URL)
- **Auth config** — which secret env var to inject from the orchestrator's `.env` file (e.g., `ANTHROPIC_API_KEY`)

## How tools are used

1. Each **repository** has a default agent tool assigned to it
2. Individual **tasks** can override the tool at creation time
3. When the scheduler launches a container, it resolves the tool, builds the environment from `env_vars` + credentials, and runs the command template with the task prompt substituted in

## Configuration

Tools are managed in the web UI under **Settings > Agent Tools**. You can also use the API:

```
GET    /api/tools          — list all tools
POST   /api/tools          — create a tool
PATCH  /api/tools/:id      — update a tool
```

## Examples

> **Verify the invocation before enabling a CLI tool.** OpenCode's flags and
> subcommands change between releases. Run `opencode --help` and
> `opencode run --help` inside the agent base image (`docker run --rm -it
> orchestrator-agent-base:latest opencode run --help`) and adjust
> `command_template` to match. The examples below use `opencode run` with the
> prompt piped in, which avoids shell-quoting issues.

### OpenCode with local Ollama

```json
{
  "id": "opencode-ollama",
  "display_name": "OpenCode (Ollama)",
  "type": "cli",
  "command_template": "opencode run \"$(cat {{PROMPT_FILE}})\"",
  "env_vars": {
    "OPENCODE_PROVIDER": "openai-compatible",
    "OPENCODE_MODEL": "devstral-small-2:latest",
    "OPENCODE_BASE_URL": "http://host.docker.internal:11434/v1"
  },
  "auth_type": "none",
  "auth_config": {}
}
```

### OpenCode with Anthropic API

```json
{
  "id": "opencode-anthropic",
  "display_name": "OpenCode (Anthropic)",
  "type": "cli",
  "command_template": "opencode run \"$(cat {{PROMPT_FILE}})\"",
  "env_vars": {
    "OPENCODE_PROVIDER": "anthropic",
    "OPENCODE_MODEL": "claude-sonnet-4-20250514"
  },
  "auth_type": "api-key",
  "auth_config": { "env_var": "ANTHROPIC_API_KEY" }
}
```

### pi with local Ollama

> **Verify the invocation before enabling pi.** pi's flags change between
> releases. Run `pi --help` inside the agent base image (`docker run --rm -it
> orchestrator-agent-base:latest pi --help`) and adjust `command_template` to
> match. The examples below target `@mariozechner/pi-coding-agent@0.68.x`.

pi does not expose Ollama through a CLI flag or a dedicated env var — custom
providers are configured via `~/.pi/agent/models.json` (see pi's own
`docs/models.md`). The `command_template` bootstraps that file inline before
invoking pi so the tool works out of the box; edit the `id` field to match a
model you've pulled on your Ollama server.

```json
{
  "id": "pi-ollama",
  "display_name": "pi (Local Ollama)",
  "type": "cli",
  "command_template": "mkdir -p ~/.pi/agent && printf '%s' '{\"providers\":{\"ollama\":{\"baseUrl\":\"http://host.docker.internal:11434/v1\",\"api\":\"openai-completions\",\"apiKey\":\"ollama\",\"compat\":{\"supportsDeveloperRole\":false,\"supportsReasoningEffort\":false},\"models\":[{\"id\":\"qwen2.5-coder:14b\"}]}}}' > ~/.pi/agent/models.json && pi -p --mode json --no-session --model ollama/qwen2.5-coder:14b @{{PROMPT_FILE}}",
  "env_vars": {},
  "auth_type": "none",
  "auth_config": {}
}
```

The `@{{PROMPT_FILE}}` syntax tells pi to include `/task/prompt.md` as the
initial user message (`pi @file "msg"`). `--mode json` yields a structured
event stream; `--no-session` skips session persistence for one-shot runs;
`-p` is the print / non-interactive flag.

### pi with Anthropic API

pi reads `ANTHROPIC_API_KEY` from the environment automatically — no config
file or env-var remapping is required.

```json
{
  "id": "pi-anthropic",
  "display_name": "pi (Anthropic API)",
  "type": "cli",
  "command_template": "pi -p --mode json --no-session --model anthropic/claude-sonnet-4-5 @{{PROMPT_FILE}}",
  "env_vars": {},
  "auth_type": "api-key",
  "auth_config": { "env_var": "ANTHROPIC_API_KEY" }
}
```

### Claude Code CLI

```json
{
  "id": "claude-code-cli",
  "display_name": "Claude Code CLI",
  "type": "cli",
  "command_template": "claude --print --dangerously-skip-permissions < {{PROMPT_FILE}}",
  "env_vars": {},
  "auth_type": "api-key",
  "auth_config": { "env_var": "ANTHROPIC_API_KEY" }
}
```

### Claude Agent SDK

```json
{
  "id": "claude-agent-sdk",
  "display_name": "Claude Agent SDK",
  "type": "sdk",
  "command_template": null,
  "env_vars": {},
  "auth_type": "api-key",
  "auth_config": { "env_var": "ANTHROPIC_API_KEY" }
}
```

## Multiple models

To use different models for different tasks, create separate tool entries (e.g., `opencode-devstral`, `opencode-qwen`). Assign the default per-repo, and override per-task when needed.

## Network access from containers

Agent containers run in Docker. To reach services on the host machine (e.g., Ollama), use `host.docker.internal` instead of `localhost` in the base URL.

## Credentials

Secret values (API keys) are never stored in the database. They live in the orchestrator's `.env` file and are injected into containers at launch time based on the tool's `auth_config.env_var` setting. The **Settings > Credentials** tab shows which env vars are configured.
