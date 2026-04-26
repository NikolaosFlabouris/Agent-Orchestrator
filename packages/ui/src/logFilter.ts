// Noise patterns for OpenCode stderr (--print-logs)
const OPENCODE_NOISE: RegExp[] = [
  /service=bus\s+type=message\.(part\.)?delta/,
  /service=bus\s+type=session\.(diff|status|updated)/,
  /service=file\.watcher/,
  /service=(plugin|format|lsp|ripgrep|db|config|json-migration)/,
  /\b(subscribing|unsubscribing)\b/,
];

function isOpenCodeNoise(line: string): boolean {
  return OPENCODE_NOISE.some((re) => re.test(line));
}

function truncate(s: string, max = 100): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}

function countLines(s: string): string {
  const n = s.split('\n').length;
  return `${n} line${n === 1 ? '' : 's'}`;
}

function compactToolInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read':
    case 'Write':
      return `${name}(${input.file_path ?? ''})`;
    case 'Glob':
      return `${name}(${input.pattern ?? input.file_path ?? ''})`;
    case 'Bash':
      return `${name}(${truncate(String(input.command ?? ''), 60)})`;
    case 'Edit':
      return `${name}(${input.file_path ?? ''}, ${countLines(String(input.new_string ?? ''))})`;
    case 'Grep':
      return `${name}(${input.pattern ?? ''})`;
    default: {
      const firstVal = Object.values(input)[0];
      if (typeof firstVal === 'string') return `${name}(${truncate(firstVal, 60)})`;
      return `${name}(${truncate(JSON.stringify(input), 60)})`;
    }
  }
}

type JsonObj = Record<string, unknown>;

function classifyPiLine(obj: JsonObj, raw: string): { show: boolean; content: string } {
  const type = obj.type as string | undefined;

  // Session header — first line pi emits
  if (type === 'session') {
    const cwd = String(obj.cwd ?? '');
    return { show: true, content: `[pi:session] cwd=${cwd}` };
  }

  if (type === 'agent_start') {
    return { show: true, content: '[pi] agent_start' };
  }

  if (type === 'agent_end') {
    const msgs = Array.isArray(obj.messages) ? obj.messages.length : '?';
    return { show: true, content: `[pi] agent_end messages=${msgs}` };
  }

  if (type === 'turn_start') {
    return { show: true, content: '[pi] turn_start' };
  }

  if (type === 'turn_end') {
    return { show: true, content: '[pi] turn_end' };
  }

  // message_start / message_update are streaming noise — hide them
  if (type === 'message_start' || type === 'message_update') {
    return { show: false, content: raw };
  }

  if (type === 'message_end') {
    const msg = obj.message as JsonObj | undefined;
    const role = String(msg?.role ?? 'unknown');
    return { show: true, content: `[pi] message_end role=${role}` };
  }

  if (type === 'tool_execution_start') {
    const toolName = String(obj.toolName ?? 'unknown');
    const args = (obj.args as JsonObj | undefined) ?? {};
    return { show: true, content: `[pi] tool_start: ${compactToolInput(toolName, args)}` };
  }

  // tool_execution_update is streaming — hide
  if (type === 'tool_execution_update') {
    return { show: false, content: raw };
  }

  if (type === 'tool_execution_end') {
    const toolName = String(obj.toolName ?? 'unknown');
    const bytes = JSON.stringify(obj.result ?? '').length;
    const errFlag = obj.isError ? ' [error]' : '';
    return { show: true, content: `[pi] tool_end: ${toolName}(bytes=${bytes})${errFlag}` };
  }

  if (type === 'compaction_start') {
    const reason = String(obj.reason ?? '');
    return { show: true, content: `[pi] compaction_start reason=${reason}` };
  }

  if (type === 'compaction_end') {
    const reason = String(obj.reason ?? '');
    const aborted = obj.aborted ? ' aborted' : '';
    return { show: true, content: `[pi] compaction_end reason=${reason}${aborted}` };
  }

  if (type === 'queue_update') {
    return { show: true, content: '[pi] queue_update' };
  }

  if (type === 'auto_retry_start') {
    const attempt = obj.attempt ?? '?';
    const max = obj.maxAttempts ?? '?';
    return { show: true, content: `[pi] auto_retry attempt=${attempt}/${max}` };
  }

  if (type === 'auto_retry_end') {
    const success = String(obj.success ?? '?');
    return { show: true, content: `[pi] auto_retry_end success=${success}` };
  }

  // Unknown pi type — fall through to show raw
  return { show: true, content: raw };
}

const PI_TYPES = new Set([
  'session', 'agent_start', 'agent_end', 'turn_start', 'turn_end',
  'message_start', 'message_update', 'message_end',
  'tool_execution_start', 'tool_execution_update', 'tool_execution_end',
  'compaction_start', 'compaction_end', 'queue_update',
  'auto_retry_start', 'auto_retry_end',
]);

function classifyJsonLine(obj: JsonObj, raw: string): { show: boolean; content: string } {
  const type = obj.type as string | undefined;

  if (type === 'system') {
    const model = String(obj.model ?? '');
    const cwd = String(obj.cwd ?? '');
    return { show: true, content: `[system] init model=${model} cwd=${cwd}` };
  }

  if (type === 'assistant') {
    const msg = obj.message as JsonObj | undefined;
    const content = (msg?.content ?? obj.content) as unknown[] | undefined;
    if (!Array.isArray(content)) return { show: true, content: raw };

    const parts: string[] = [];
    for (const item of content) {
      const c = item as JsonObj;
      if (c.type === 'text') {
        parts.push(`[assistant] text: ${truncate(String(c.text ?? ''), 100)}`);
      } else if (c.type === 'tool_use') {
        const toolName = String(c.name ?? 'unknown');
        const input = (c.input as JsonObj) ?? {};
        parts.push(`[assistant] tool_use: ${compactToolInput(toolName, input)}`);
      }
    }
    return { show: true, content: parts.join('\n') || '[assistant]' };
  }

  if (type === 'user') {
    const msg = obj.message as JsonObj | undefined;
    const content = (msg?.content ?? obj.content) as unknown[] | undefined;
    if (!Array.isArray(content)) return { show: true, content: raw };

    const parts: string[] = [];
    for (const item of content) {
      const c = item as JsonObj;
      if (c.type === 'tool_result') {
        const bytes = JSON.stringify(c.content ?? c).length;
        parts.push(`[user] tool_result(bytes=${bytes})`);
      }
    }
    if (parts.length === 0) return { show: true, content: raw };
    return { show: true, content: parts.join('\n') };
  }

  if (type === 'result') {
    const turns = obj.num_turns ?? '?';
    const cost =
      typeof obj.total_cost_usd === 'number'
        ? obj.total_cost_usd.toFixed(4)
        : typeof obj.costUsd === 'number'
          ? (obj.costUsd as number).toFixed(4)
          : '?';
    const usage = obj.usage as JsonObj | undefined;
    const input = usage?.input_tokens ?? '?';
    const output = usage?.output_tokens ?? '?';
    return { show: true, content: `[result] turns=${turns} cost=$${cost} input=${input} output=${output}` };
  }

  // Pi event types
  if (type !== undefined && PI_TYPES.has(type)) {
    return classifyPiLine(obj, raw);
  }

  // Unrecognised type — show raw (unknown signal is still signal)
  return { show: true, content: raw };
}

// Bounded module-level cache. Each unique line content always produces the same
// classification result. We cap at MAX_CACHE entries to avoid unbounded growth
// from long-running tasks with many structurally unique lines (e.g. OpenCode
// lines with per-line timestamps).
const MAX_CACHE = 1000;
const cache = new Map<string, { show: boolean; content: string }>();

function doClassify(line: string): { show: boolean; content: string } {
  // Rule 1: always show error signal
  if (line.includes('ERROR') || /"type"\s*:\s*"error"/.test(line)) {
    return { show: true, content: line };
  }

  // Rule 2: try JSON
  const trimmed = line.trim();
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as JsonObj;
      return classifyJsonLine(obj, line);
    } catch {
      // Not valid JSON — fall through
    }
  }

  // Rule 3: OpenCode noise suppression
  if (isOpenCodeNoise(line)) {
    return { show: false, content: line };
  }

  return { show: true, content: line };
}

/** Classify a single raw log line for terse display.
 *  Returns { show: false } for noise lines, or { show: true, content } where
 *  content may be a compacted representation of the original. */
export function classifyLogLine(line: string): { show: boolean; content: string } {
  const cached = cache.get(line);
  if (cached) return cached;
  const result = doClassify(line);
  if (cache.size >= MAX_CACHE) {
    // Evict oldest entry (Map preserves insertion order)
    cache.delete(cache.keys().next().value as string);
  }
  cache.set(line, result);
  return result;
}

/** Apply the terse filter, or pass through unchanged in verbose mode. */
export function filterLogLine(
  line: string,
  verbose: boolean,
): { show: boolean; content: string } {
  if (verbose) return { show: true, content: line };
  return classifyLogLine(line);
}
