/**
 * Starter templates for the per-tool "Config file" field. Picking one in the
 * Settings → Agent Tools form pre-fills both `path` and `content` with a
 * known-good default; the operator edits the parts that vary (server URL,
 * model name) and saves.
 *
 * Templates are UI-only assistance — the server doesn't know about them.
 * Adding a new one is a 10-line PR: append an entry to TEMPLATES.
 *
 * Path is anchored at /repo inside the container. The orchestrator writes
 * from outside the container into the bind-mounted workspace, so paths
 * outside /repo (e.g. ~/.pi/agent/models.json) cannot be templated here —
 * tools needing that pattern continue to inline the write into
 * `command_template`.
 */

export interface ConfigFileTemplate {
  /** Stable id used as the dropdown option value. */
  id: string;
  /** Human-readable label shown in the dropdown. */
  label: string;
  /** Pre-filled `config_file_path` value. */
  path: string;
  /** Pre-filled `config_file_content` value (raw text). */
  content: string;
}

const opencodeOllama = {
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
};

const opencodeVllm = {
  $schema: 'https://opencode.ai/config.json',
  provider: {
    vllm: {
      npm: '@ai-sdk/openai-compatible',
      name: 'vLLM',
      options: { baseURL: 'http://host.docker.internal:8000/v1' },
      models: { 'your-model-id': { name: 'Your Model' } },
    },
  },
  permission: { '*': 'allow' },
};

const opencodeLmStudio = {
  $schema: 'https://opencode.ai/config.json',
  provider: {
    lmstudio: {
      npm: '@ai-sdk/openai-compatible',
      name: 'LM Studio',
      options: { baseURL: 'http://host.docker.internal:1234/v1' },
      models: { 'your-model-id': { name: 'Your Model' } },
    },
  },
  permission: { '*': 'allow' },
};

export const TEMPLATES: ConfigFileTemplate[] = [
  {
    id: 'blank',
    label: '(Blank)',
    path: '',
    content: '',
  },
  {
    id: 'opencode-ollama',
    label: 'OpenCode + Ollama',
    path: 'opencode.json',
    content: JSON.stringify(opencodeOllama, null, 2),
  },
  {
    id: 'opencode-vllm',
    label: 'OpenCode + vLLM',
    path: 'opencode.json',
    content: JSON.stringify(opencodeVllm, null, 2),
  },
  {
    id: 'opencode-lmstudio',
    label: 'OpenCode + LM Studio',
    path: 'opencode.json',
    content: JSON.stringify(opencodeLmStudio, null, 2),
  },
];
