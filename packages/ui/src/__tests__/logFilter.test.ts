import { describe, it, expect } from 'vitest';
import { classifyLogLine, filterLogLine } from '../logFilter.js';

// ---------------------------------------------------------------------------
// OpenCode noise suppression
// ---------------------------------------------------------------------------
describe('OpenCode noise suppression', () => {
  it('hides message.part.delta bus event', () => {
    const line =
      'INFO 2024-01-01T00:00:00Z +5ms service=bus type=message.part.delta publishing';
    expect(classifyLogLine(line).show).toBe(false);
  });

  it('hides message.delta bus event (no "part." prefix)', () => {
    const line = 'INFO ts=1 service=bus type=message.delta publishing';
    expect(classifyLogLine(line).show).toBe(false);
  });

  it('hides session.diff bus event', () => {
    const line = 'INFO service=bus type=session.diff publishing';
    expect(classifyLogLine(line).show).toBe(false);
  });

  it('hides session.status bus event', () => {
    const line = 'INFO service=bus type=session.status publishing';
    expect(classifyLogLine(line).show).toBe(false);
  });

  it('hides service=file.watcher lines', () => {
    const line = 'INFO service=file.watcher watching /repo';
    expect(classifyLogLine(line).show).toBe(false);
  });

  it('hides service=plugin lines', () => {
    const line = 'INFO service=plugin loading plugin foo';
    expect(classifyLogLine(line).show).toBe(false);
  });

  it('hides service=lsp lines', () => {
    const line = 'INFO service=lsp started';
    expect(classifyLogLine(line).show).toBe(false);
  });

  it('hides subscribing lines', () => {
    const line = 'INFO subscribing to channel foo';
    expect(classifyLogLine(line).show).toBe(false);
  });

  it('hides unsubscribing lines', () => {
    const line = 'INFO unsubscribing from channel foo';
    expect(classifyLogLine(line).show).toBe(false);
  });

  it('passes through unrecognised plain-text INFO lines', () => {
    const line = 'INFO service=session.prompt user sent a message';
    const result = classifyLogLine(line);
    expect(result.show).toBe(true);
    expect(result.content).toBe(line);
  });
});

// ---------------------------------------------------------------------------
// Claude Code stream-json compaction
// ---------------------------------------------------------------------------
describe('Claude Code stream-json compaction', () => {
  it('compacts system/init event', () => {
    const event = { type: 'system', model: 'claude-sonnet-4', cwd: '/repo' };
    const result = classifyLogLine(JSON.stringify(event));
    expect(result.show).toBe(true);
    expect(result.content).toBe('[system] init model=claude-sonnet-4 cwd=/repo');
  });

  it('compacts assistant tool_use Read to one-liner', () => {
    const event = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'Read',
            input: { file_path: '/repo/foo.ts' },
          },
        ],
      },
    };
    const result = classifyLogLine(JSON.stringify(event));
    expect(result.show).toBe(true);
    expect(result.content).toBe('[assistant] tool_use: Read(/repo/foo.ts)');
  });

  it('compacts assistant tool_use Bash to one-liner', () => {
    const event = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tu_2',
            name: 'Bash',
            input: { command: 'npm test' },
          },
        ],
      },
    };
    const result = classifyLogLine(JSON.stringify(event));
    expect(result.show).toBe(true);
    expect(result.content).toBe('[assistant] tool_use: Bash(npm test)');
  });

  it('compacts assistant tool_use Edit with line count', () => {
    const event = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tu_3',
            name: 'Edit',
            input: { file_path: '/repo/foo.ts', old_string: 'a', new_string: 'b\nc\nd' },
          },
        ],
      },
    };
    const result = classifyLogLine(JSON.stringify(event));
    expect(result.show).toBe(true);
    expect(result.content).toBe('[assistant] tool_use: Edit(/repo/foo.ts, 3 lines)');
  });

  it('compacts assistant text content', () => {
    const event = {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Hello, world!' }],
      },
    };
    const result = classifyLogLine(JSON.stringify(event));
    expect(result.show).toBe(true);
    expect(result.content).toBe('[assistant] text: Hello, world!');
  });

  it('compacts user tool_result with 10KB payload to bytes indicator', () => {
    const largeContent = 'x'.repeat(10_000);
    const event = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: largeContent,
          },
        ],
      },
    };
    const line = JSON.stringify(event);
    const result = classifyLogLine(line);
    expect(result.show).toBe(true);
    expect(result.content).toMatch(/^\[user\] tool_result\(bytes=\d+\)$/);
    expect(result.content.length).toBeLessThan(50);
  });

  it('compacts result event', () => {
    const event = {
      type: 'result',
      num_turns: 5,
      total_cost_usd: 0.0123,
      usage: { input_tokens: 1000, output_tokens: 500 },
    };
    const result = classifyLogLine(JSON.stringify(event));
    expect(result.show).toBe(true);
    expect(result.content).toBe('[result] turns=5 cost=$0.0123 input=1000 output=500');
  });
});

// ---------------------------------------------------------------------------
// Error signal — always shown
// ---------------------------------------------------------------------------
describe('Error lines always visible', () => {
  it('always shows a line containing ERROR (OpenCode-style noise)', () => {
    const line =
      'INFO service=bus type=message.part.delta ERROR something went wrong';
    const result = classifyLogLine(line);
    expect(result.show).toBe(true);
    expect(result.content).toBe(line);
  });

  it('always shows a line containing "type":"error" JSON', () => {
    const line = '{"type":"error","message":"agent crashed"}';
    const result = classifyLogLine(line);
    expect(result.show).toBe(true);
  });

  it('always shows an error even if the JSON is otherwise compactable', () => {
    const event = {
      type: 'result',
      ERROR: true,
      num_turns: 1,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    const line = JSON.stringify(event);
    // Line contains "ERROR" as a key — rule 1 fires first
    const result = classifyLogLine(line);
    expect(result.show).toBe(true);
    expect(result.content).toBe(line);
  });
});

// ---------------------------------------------------------------------------
// Malformed JSON falls through to non-JSON path
// ---------------------------------------------------------------------------
describe('Malformed JSON handling', () => {
  it('treats a line starting with { but invalid JSON as non-JSON', () => {
    const line = '{not valid json} service=bus type=message.part.delta publishing';
    const result = classifyLogLine(line);
    // Falls through to non-JSON path → noise → hidden
    expect(result.show).toBe(false);
  });

  it('shows a malformed JSON line that is not noise', () => {
    const line = '{incomplete service=session.prompt some useful info';
    const result = classifyLogLine(line);
    expect(result.show).toBe(true);
    expect(result.content).toBe(line);
  });
});

// ---------------------------------------------------------------------------
// Unrecognised JSON type — shown as raw
// ---------------------------------------------------------------------------
describe('Unrecognised JSON type', () => {
  it('shows raw line for JSON with unknown type', () => {
    const line = '{"type":"unknown_event","data":"something important"}';
    const result = classifyLogLine(line);
    expect(result.show).toBe(true);
    expect(result.content).toBe(line);
  });
});

// ---------------------------------------------------------------------------
// Verbose mode — every line unchanged
// ---------------------------------------------------------------------------
describe('filterLogLine verbose mode', () => {
  it('shows OpenCode noise lines unchanged in verbose mode', () => {
    const line = 'INFO service=bus type=message.part.delta publishing';
    const result = filterLogLine(line, true);
    expect(result.show).toBe(true);
    expect(result.content).toBe(line);
  });

  it('shows Claude Code JSON lines as raw in verbose mode', () => {
    const event = { type: 'assistant', message: { content: [] } };
    const line = JSON.stringify(event);
    const result = filterLogLine(line, true);
    expect(result.show).toBe(true);
    expect(result.content).toBe(line);
  });

  it('terse mode still filters when verbose=false', () => {
    const line = 'INFO service=bus type=message.part.delta publishing';
    expect(filterLogLine(line, false).show).toBe(false);
  });
});
