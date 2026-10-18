import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * Contract tests for harness-sdk.ts's usage accounting: `extractUsage` maps
 * one SDK `result` message, `addUsage` folds it into the run's total.
 *
 * Why these exist: one `query()` can emit several `result` messages (the
 * agent's first end of turn, then one per follow-up turn when a background
 * task reports back), each carrying only its own turns and tokens. The
 * harness kept only the last one, so task 627's rework (10 + 2 + 1 turns)
 * was stored as 1 turn and 95 output tokens.
 *
 * harness-sdk.ts reads /task/meta.json and starts the run at load time, and
 * imports an SDK the server package doesn't install, so it can't be imported
 * here. As harness-result-events.test.ts does for harness-cli.sh, the helpers
 * are extracted from the shipped script rather than duplicated, then
 * transpiled, so the assertions are about the shipped code.
 */

const HARNESS_PATH = path.resolve(
  __dirname,
  '../../../../..',
  'harness',
  'harness-sdk.ts'
);
const HARNESS_SRC = fs.readFileSync(HARNESS_PATH, 'utf-8');

/** Pull one top-level `export function name(...) { ... }` out of the script. */
function extractFunction(name: string): string {
  const match = HARNESS_SRC.match(
    new RegExp(`^export function ${name}\\([\\s\\S]*?^\\}$`, 'm')
  );
  if (!match) throw new Error(`${name}() not found in harness-sdk.ts`);
  return match[0];
}

interface Usage {
  num_turns?: number;
  input_tokens?: number;
  output_tokens?: number;
  tool_calls?: number;
}

const helpers = (() => {
  const source = [extractFunction('extractUsage'), extractFunction('addUsage')].join('\n');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports: Record<string, unknown> = {};
  new Function('exports', outputText)(exports);
  return exports as {
    extractUsage: (message: unknown) => Usage | undefined;
    addUsage: (total: Usage | undefined, next: Usage) => Usage;
  };
})();
const { extractUsage, addUsage } = helpers;

/** The run loop, as harness-sdk.ts writes it. */
function usageOf(messages: unknown[]): Usage | undefined {
  let usage: Usage | undefined;
  for (const message of messages) {
    const u = extractUsage(message);
    if (u) usage = addUsage(usage, u);
  }
  return usage;
}

/** The three `result` messages from task 627's second develop attempt
 *  (2026-10-18), trimmed to the fields that matter. The agent backgrounded
 *  `git push`, ended its turn, and the session ran two follow-up turns as
 *  the push reported back. */
const TASK_627_RESULTS = [
  {
    type: 'result',
    subtype: 'success',
    num_turns: 10,
    duration_ms: 266770,
    usage: { input_tokens: 20, cache_read_input_tokens: 287420, output_tokens: 2630 },
  },
  {
    type: 'result',
    subtype: 'success',
    num_turns: 2,
    duration_ms: 3844,
    usage: { input_tokens: 6, cache_read_input_tokens: 70926, output_tokens: 322 },
  },
  {
    type: 'result',
    subtype: 'success',
    num_turns: 1,
    duration_ms: 1450,
    usage: { input_tokens: 4, cache_read_input_tokens: 36294, output_tokens: 95 },
  },
];

describe('harness-sdk.ts usage accounting', () => {
  it('sums every result message in a session, not just the last', () => {
    const stream = [
      { type: 'system', subtype: 'init' },
      TASK_627_RESULTS[0],
      { type: 'system', subtype: 'task_notification' },
      { type: 'system', subtype: 'init' },
      TASK_627_RESULTS[1],
      { type: 'system', subtype: 'task_notification' },
      { type: 'system', subtype: 'init' },
      TASK_627_RESULTS[2],
    ];
    expect(usageOf(stream)).toEqual({
      num_turns: 13,
      input_tokens: 30,
      output_tokens: 3047,
    });
  });

  it('reports a single result message unchanged', () => {
    expect(usageOf([TASK_627_RESULTS[0]])).toEqual({
      num_turns: 10,
      input_tokens: 20,
      output_tokens: 2630,
    });
  });

  it('leaves usage undefined when no result message carries any', () => {
    expect(usageOf([])).toBeUndefined();
    expect(
      usageOf([
        { type: 'assistant', num_turns: 4, usage: { output_tokens: 9 } },
        { type: 'result', subtype: 'error_during_execution' },
      ])
    ).toBeUndefined();
  });

  it('sums each field over only the messages that report it', () => {
    expect(
      usageOf([
        { type: 'result', num_turns: 3 },
        { type: 'result', num_turns: 2, usage: { output_tokens: 40 } },
        { type: 'result', usage: { input_tokens: 7, output_tokens: 'n/a' } },
      ])
    ).toEqual({ num_turns: 5, input_tokens: 7, output_tokens: 40 });
  });

  it('does not mutate the running total', () => {
    const total: Usage = { num_turns: 1 };
    const sum = addUsage(total, { num_turns: 2, output_tokens: 5 });
    expect(sum).toEqual({ num_turns: 3, output_tokens: 5 });
    expect(total).toEqual({ num_turns: 1 });
  });
});
