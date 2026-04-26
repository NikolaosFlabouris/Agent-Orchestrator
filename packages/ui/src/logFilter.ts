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

  // Unrecognised type — show raw (unknown signal is still signal)
  return { show: true, content: raw };
}

// Module-level cache: same line content always produces the same result
const cache = new Map<string, { show: boolean; content: string }>();

function doClassify(line: string): { show: boolean; content: string } {
  // Rule 1: always show error signal
  if (line.includes('ERROR') || line.includes('"type":"error"')) {
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
